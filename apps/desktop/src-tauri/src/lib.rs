//! The Rust shell is kept tiny on purpose: it opens the window and starts the
//! TypeScript engine helper. All app logic lives in TypeScript.

mod engine;
mod keys;
mod settings;

use engine::{helper_command, Canceller, EngineHelper, EngineStatus};
use keys::{KeyStatus, OsKeyring};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

/// Version shown in the app, read from Cargo.toml at build time.
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// The running helper, or why it isn't running.
struct Engine(Mutex<Result<EngineHelper, String>>);

/// The feature build running now, if any: one at a time, each in its own helper so the rest of
/// the app stays quick. Holds what's needed to stop it.
struct Build(Mutex<Option<(Canceller, u64)>>);

#[tauri::command]
fn version() -> String {
    app_version().to_string()
}

/// Async so a slow engine never freezes the window.
#[tauri::command]
async fn engine_status(state: tauri::State<'_, Engine>) -> Result<EngineStatus, String> {
    let mut guard = match state.0.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    Ok(match guard.as_mut() {
        Ok(helper) => helper.status(),
        Err(reason) => EngineStatus::Stopped { reason: reason.clone() },
    })
}

// Key commands. None of them returns the key itself.
#[tauri::command]
async fn key_status(provider: String) -> Result<KeyStatus, String> {
    keys::status(&OsKeyring, &provider)
}

#[tauri::command]
async fn key_save(provider: String, key: String) -> Result<KeyStatus, String> {
    keys::save(&OsKeyring, &provider, &key)
}

#[tauri::command]
async fn key_remove(provider: String) -> Result<KeyStatus, String> {
    keys::remove(&OsKeyring, &provider)
}

/// The engine's name for each provider in Settings.
fn engine_provider(provider: &str) -> Result<&'static str, String> {
    match provider {
        "anthropic" => Ok("claude"),
        "openai" => Ok("openai"),
        "deepseek" => Ok("deepseek"),
        other => Err(format!("unknown provider: {other}")),
    }
}

/// One request to the engine helper.
fn engine_call(state: &tauri::State<'_, Engine>, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut guard = match state.0.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let helper = guard.as_mut().map_err(|reason| format!("engine not running: {reason}"))?;
    helper.request_with(method, params)
}

/// settings.json in the app's own config folder (per user, per computer).
fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| format!("no settings folder: {e}"))?;
    Ok(dir.join("settings.json"))
}

/// The local spend file (cost of every model call), in the app's own data folder.
fn spend_path(app: &tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("no data folder: {e}"))?;
    Ok(dir.join("history.sqlite").to_string_lossy().into_owned())
}

/// Checks the new settings in the engine, then saves the checked copy.
#[tauri::command]
async fn settings_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, Engine>,
    settings: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let checked = engine_call(&state, "settings_check", serde_json::json!({ "settings": settings }))?;
    let path = settings_path(&app)?;
    // What was there before, for the undo history. A damaged old file counts as the defaults.
    let before = settings::read(&path).unwrap_or_else(|_| serde_json::json!({}));
    settings::write(&path, &checked)?;
    // The save has happened; a history that can't be written shouldn't undo it.
    let _ = engine_call(
        &state,
        "settings_saved",
        serde_json::json!({ "dbPath": spend_path(&app)?, "before": before, "after": checked }),
    );
    Ok(checked)
}

/// Every engine method the window may call through the one generic `engine` command; anything
/// else is refused. Only plain pass-throughs belong here. Nothing that touches keys, writes the
/// settings, spends money or runs a build (those keep their own commands), and nothing the phone
/// path uses on its own.
const ENGINE_METHODS: [&str; 34] = [
    "spend_summary",
    "gate_rules",
    "settings_check",
    "data_overview",
    "environment_check",
    "eval_run",
    "experiment_run",
    "update_check",
    "update_decide",
    "capability_centre",
    "project_tools",
    "project_tools_approve",
    "tool_rate",
    "tool_switch_on",
    "tool_trust",
    "data_sync",
    "history_list",
    "run_list",
    "workflow_compare",
    "deps_approve",
    "ask_list",
    "ask_decide",
    "work_list",
    "run_rate",
    "project_map",
    "interview_stages",
    "project_list",
    "interview_start",
    "interview_get",
    "interview_save",
    "interview_confirm",
    "code_folder_check",
    "code_folder_create",
    "run_revert",
];

fn engine_method(method: &str) -> Result<&'static str, String> {
    ENGINE_METHODS.iter().find(|m| **m == method).copied().ok_or_else(|| format!("not an engine method the window may call: {method}"))
}

/// The params for a generic engine call. The saved settings and the spend file are always added
/// here, replacing anything the window sent under those names, so the window can't pick them.
fn engine_params(params: serde_json::Value, saved: serde_json::Value, db_path: String) -> Result<serde_json::Value, String> {
    let mut map = match params {
        serde_json::Value::Object(map) => map,
        serde_json::Value::Null => serde_json::Map::new(),
        _ => return Err("params must be an object".into()),
    };
    map.insert("settings".into(), saved);
    map.insert("dbPath".into(), db_path.into());
    Ok(serde_json::Value::Object(map))
}

/// One allow-listed engine method with the saved settings. Async so a slow engine never freezes
/// the window.
#[tauri::command]
async fn engine(
    method: String,
    params: serde_json::Value,
    app: tauri::AppHandle,
    state: tauri::State<'_, Engine>,
) -> Result<serde_json::Value, String> {
    let method = engine_method(&method)?;
    let saved = settings::read(&settings_path(&app)?)?;
    engine_call(&state, method, engine_params(params, saved, spend_path(&app)?)?)
}

/// The password-store name for an engine provider ("claude" is stored as "anthropic").
fn key_name(engine: &str) -> Result<&'static str, String> {
    match engine {
        "claude" => Ok("anthropic"),
        "openai" => Ok("openai"),
        "deepseek" => Ok("deepseek"),
        other => Err(format!("unknown provider: {other}")),
    }
}

/// Calls a paid planning method: the saved provider's key goes from the password store straight to
/// the engine, with the spend file so the cost counts against the budget.
fn paid_project_call(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, Engine>,
    method: &str,
    mut params: serde_json::Map<String, serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let saved = settings::read(&settings_path(app)?)?;
    let provider = saved.get("provider").and_then(|p| p.as_str()).unwrap_or("claude").to_string();
    let key = keys::load(&OsKeyring, key_name(&provider)?)?;
    params.insert("settings".into(), saved);
    params.insert("provider".into(), provider.into());
    params.insert("apiKey".into(), key.into());
    params.insert("dbPath".into(), spend_path(app)?.into());
    engine_call(state, method, serde_json::Value::Object(params))
}

/// Claude's ideas for one stage of the plan interview. Costs money (the "plan" job), so the
/// screen says so before calling.
#[tauri::command]
async fn interview_suggest(
    slug: String,
    stage: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, Engine>,
) -> Result<serde_json::Value, String> {
    let mut params = serde_json::Map::new();
    params.insert("slug".into(), slug.into());
    params.insert("stage".into(), stage.into());
    paid_project_call(&app, &state, "interview_suggest", params)
}

/// Reviews a finished plan: one plan review, or three fresh-eyes reviewers for a big build.
#[tauri::command]
async fn interview_review(slug: String, app: tauri::AppHandle, state: tauri::State<'_, Engine>) -> Result<serde_json::Value, String> {
    let mut params = serde_json::Map::new();
    params.insert("slug".into(), slug.into());
    paid_project_call(&app, &state, "interview_review", params)
}

/// Builds one feature in its own copy of the code. Each step is sent to `on_step` as it happens.
/// Costs money (the "build" job, capped per run). Runs in its own helper, off the main thread.
#[tauri::command]
async fn build_feature(
    slug: String,
    feature: String,
    on_step: tauri::ipc::Channel<serde_json::Value>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_build(&handle, slug, feature, |event| {
            let _ = on_step.send(event);
        })
    })
    .await
    .map_err(|e| format!("the build stopped unexpectedly: {e}"))?
}

/// One build, start to finish, in its own helper (blocking). Only one runs at a time; Stop works
/// for builds started on the PC or from the phone.
fn run_build(app: &tauri::AppHandle, slug: String, feature: String, on_event: impl FnMut(serde_json::Value)) -> Result<serde_json::Value, String> {
    let saved = settings::read(&settings_path(app)?)?;
    let provider = saved.get("provider").and_then(|p| p.as_str()).unwrap_or("claude").to_string();
    let key = keys::load(&OsKeyring, key_name(&provider)?)?;
    let params = serde_json::json!({
        "slug": slug, "feature": feature, "settings": saved, "provider": provider, "apiKey": key, "dbPath": spend_path(app)?,
        "githubToken": github_token(),
    });
    let mut helper = EngineHelper::start(&helper_command(std::env::var("AIP_ENGINE").ok()))?;
    let build = app.state::<Build>();
    {
        let mut running = build.0.lock().unwrap_or_else(|p| p.into_inner());
        if running.is_some() {
            return Err("A build is already running. Stop it or wait for it to finish.".into());
        }
        *running = Some((helper.canceller(), helper.next_id()));
    }
    let result = helper.request_live("build_feature", params, on_event);
    *build.0.lock().unwrap_or_else(|p| p.into_inner()) = None;
    result
}

fn build_running(app: &tauri::AppHandle) -> bool {
    app.state::<Build>().0.lock().unwrap_or_else(|p| p.into_inner()).is_some()
}

/// The builds a phone poll asked for (already checked by the engine), as (project, feature).
fn phone_builds(poll: &serde_json::Value) -> Vec<(String, String)> {
    poll.get("builds")
        .and_then(|b| b.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|b| Some((b.get("slug")?.as_str()?.to_string(), b.get("feature")?.as_str()?.to_string())))
                .take(1)
                .collect()
        })
        .unwrap_or_default()
}

/// Stops the running build, if there is one.
#[tauri::command]
async fn build_stop(build: tauri::State<'_, Build>) -> Result<bool, String> {
    let running = build.0.lock().unwrap_or_else(|p| p.into_inner());
    match running.as_ref() {
        Some((stop, id)) => stop.cancel(*id).map(|_| true),
        None => Ok(false),
    }
}

/// Keep merges a build into joshua's own copy (never pushes); Undo removes the build's copy.
#[tauri::command]
async fn run_decide(id: i64, keep: bool, app: tauri::AppHandle, state: tauri::State<'_, Engine>) -> Result<serde_json::Value, String> {
    let saved = settings::read(&settings_path(&app)?)?;
    let method = if keep { "run_keep" } else { "run_undo" };
    engine_call(&state, method, serde_json::json!({ "settings": saved, "dbPath": spend_path(&app)?, "id": id, "githubToken": github_token() }))
}

/// The GitHub token for phone messages, when one is saved (step 10). Without one, nothing is posted.
fn github_token() -> Option<String> {
    keys::load(&OsKeyring, "github").ok()
}

/// How often the app reads replies from joshua's phone while it's open (step 10c).
const PHONE_POLL: std::time::Duration = std::time::Duration::from_secs(60);

/// One look at the phone replies. Nothing happens without a GitHub token or a settings file.
fn poll_phone(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    let Some(token) = github_token() else { return Ok(serde_json::json!({ "done": [], "changed": false })) };
    let saved = settings::read(&settings_path(app)?)?;
    let state = app.state::<Engine>();
    let poll = engine_call(&state, "work_poll", serde_json::json!({ "settings": saved, "dbPath": spend_path(app)?, "githubToken": token, "busy": build_running(app) }))?;
    // D: a build asked for from the phone starts here, in the background. Its result is posted as
    // the usual build issue, and shows on the Build screen when it next refreshes.
    for (slug, feature) in phone_builds(&poll) {
        let handle = app.clone();
        std::thread::spawn(move || {
            let _ = run_build(&handle, slug, feature, |_| {});
        });
    }
    Ok(poll)
}

/// D: posts the "start builds from here" issue on the data repo (once).
#[tauri::command]
async fn phone_setup(app: tauri::AppHandle, state: tauri::State<'_, Engine>) -> Result<serde_json::Value, String> {
    let token = keys::load(&OsKeyring, "github")?;
    let saved = settings::read(&settings_path(&app)?)?;
    engine_call(&state, "phone_setup", serde_json::json!({ "settings": saved, "dbPath": spend_path(&app)?, "githubToken": token }))
}

/// Checks phone replies now (the Build screen also asks about once a minute while it's shown).
#[tauri::command]
async fn work_poll(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    poll_phone(&app)
}

/// One-click undo. Only puts a change back if nothing has changed since.
#[tauri::command]
async fn history_undo(id: i64, app: tauri::AppHandle, state: tauri::State<'_, Engine>) -> Result<serde_json::Value, String> {
    let path = settings_path(&app)?;
    let db = spend_path(&app)?;
    let current = settings::read(&path)?;
    let r = engine_call(&state, "undo", serde_json::json!({ "dbPath": db, "id": id, "settings": current }))?;
    if r.get("kind").and_then(|k| k.as_str()) != Some("settings") {
        return Ok(r);
    }
    let label = r.get("label").and_then(|l| l.as_str()).unwrap_or("change").to_string();
    let restored = r.get("settings").cloned().ok_or("engine gave no settings to restore")?;
    settings::write(&path, &restored)?;
    engine_call(
        &state,
        "settings_saved",
        serde_json::json!({ "dbPath": db, "before": current, "after": restored, "undoes": { "id": id, "label": label } }),
    )?;
    // CI-8: read the settings back from disk and check they really are the earlier ones.
    let saved = settings::read(&path)?;
    let check = engine_call(&state, "undo_check", serde_json::json!({ "dbPath": db, "id": id, "settings": saved }))?;
    let checked = check.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let check_text = check.get("text").and_then(|t| t.as_str()).unwrap_or("");
    let summary = format!("{} {}", r.get("summary").and_then(|t| t.as_str()).unwrap_or("Undone."), check_text).trim().to_string();
    Ok(serde_json::json!({ "kind": "settings", "id": id, "label": label, "summary": summary, "checked": checked }))
}

/// Tests a saved key: free for OpenAI and DeepSeek, one tiny question for Claude.
/// The key goes from the password store straight to the engine; the screens get only the summary.
#[tauri::command]
async fn test_model(
    provider: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, Engine>,
) -> Result<serde_json::Value, String> {
    let engine_name = engine_provider(&provider)?;
    let key = keys::load(&OsKeyring, &provider)?;
    // A damaged settings file shouldn't stop a key test; the defaults are used instead.
    let saved = settings_path(&app).and_then(|p| settings::read(&p)).unwrap_or_else(|_| serde_json::json!({}));
    let db = spend_path(&app)?;
    engine_call(
        &state,
        "check",
        serde_json::json!({ "provider": engine_name, "apiKey": key, "settings": saved, "dbPath": db }),
    )
}

/// Tests the GitHub token for phone messages (step 10a). Free: it only reads the data repo's issues.
/// The token goes from the password store straight to the engine; the screens get only the summary.
#[tauri::command]
async fn github_test(app: tauri::AppHandle, state: tauri::State<'_, Engine>) -> Result<serde_json::Value, String> {
    let token = keys::load(&OsKeyring, "github")?;
    let saved = settings::read(&settings_path(&app)?)?;
    engine_call(&state, "github_check", serde_json::json!({ "token": token, "settings": saved }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let helper = EngineHelper::start(&helper_command(std::env::var("AIP_ENGINE").ok()));
    tauri::Builder::default()
        .manage(Engine(Mutex::new(helper)))
        .manage(Build(Mutex::new(None)))
        .setup(|app| {
            // Reads phone replies in the background, so keep/undo from the phone works with any screen open.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(PHONE_POLL);
                let _ = poll_phone(&handle);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![version, engine_status, engine, key_status, key_save, key_remove, test_model, settings_save, interview_suggest, interview_review, build_feature, build_stop, run_decide, history_undo, github_test, work_poll, phone_setup])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phone_builds_takes_one_checked_build_and_ignores_junk() {
        let poll = serde_json::json!({ "builds": [{ "slug": "club-hr", "feature": "F-02", "issue": 3 }, { "slug": "x", "feature": "F-01" }] });
        assert_eq!(phone_builds(&poll), vec![("club-hr".to_string(), "F-02".to_string())]);
        assert!(phone_builds(&serde_json::json!({ "done": [] })).is_empty());
        assert!(phone_builds(&serde_json::json!({ "builds": [{ "slug": 1 }] })).is_empty());
    }

    #[test]
    fn maps_settings_providers_to_engine_names() {
        assert_eq!(engine_provider("anthropic"), Ok("claude"));
        assert_eq!(engine_provider("openai"), Ok("openai"));
        assert!(engine_provider("x").is_err());
    }

    #[test]
    fn maps_engine_providers_to_key_names() {
        assert_eq!(key_name("claude"), Ok("anthropic"));
        assert_eq!(key_name("deepseek"), Ok("deepseek"));
        assert!(key_name("anthropic").is_err());
    }

    #[test]
    fn unknown_methods_are_refused() {
        assert!(engine_method("nope").is_err());
        assert!(engine_method("").is_err());
        assert!(engine_method("ask").is_err());
        assert_eq!(engine_method("tool_rate"), Ok("tool_rate"));
    }

    #[test]
    fn saved_settings_and_spend_file_replace_what_the_window_sent() {
        let sent = serde_json::json!({ "slug": "club-hr", "settings": { "dataFolder": "/etc" }, "dbPath": "/elsewhere.sqlite" });
        let out = engine_params(sent, serde_json::json!({ "dataFolder": "/mine" }), "/app/history.sqlite".into()).unwrap();
        assert_eq!(out, serde_json::json!({ "slug": "club-hr", "settings": { "dataFolder": "/mine" }, "dbPath": "/app/history.sqlite" }));
        let none = engine_params(serde_json::Value::Null, serde_json::json!({}), "/d".into()).unwrap();
        assert_eq!(none, serde_json::json!({ "settings": {}, "dbPath": "/d" }));
        assert!(engine_params(serde_json::json!([1]), serde_json::json!({}), "/d".into()).is_err());
    }

    #[test]
    fn every_old_pass_through_method_is_still_allowed() {
        let old = [
            "spend_summary", "gate_rules", "settings_check", "data_overview", "environment_check", "eval_run", "experiment_run",
            "update_check", "update_decide", "capability_centre", "project_tools", "project_tools_approve", "tool_rate",
            "tool_switch_on", "tool_trust", "data_sync", "history_list", "run_list", "workflow_compare", "deps_approve",
            "ask_list", "ask_decide", "work_list", "run_rate", "project_map", "interview_stages", "project_list",
            "interview_start", "interview_get", "interview_save", "interview_confirm", "code_folder_check", "code_folder_create",
        ];
        for m in old {
            assert_eq!(engine_method(m), Ok(m), "{m} was lost");
        }
        assert_eq!(old.len() + 1, ENGINE_METHODS.len(), "only run_revert was added since");
    }

    #[test]
    fn undo_a_kept_build_is_allowed_and_needs_no_token() {
        // It only runs git revert in joshua's own copy: no key, no money, no push.
        assert_eq!(engine_method("run_revert"), Ok("run_revert"));
    }

    #[test]
    fn keys_settings_writes_paid_and_phone_methods_are_not_generic() {
        let kept = [
            "ask", "check", "github_check", "build_feature", "interview_suggest", "interview_review", "run_keep", "run_undo",
            "settings_saved", "undo", "undo_check", "phone_setup", "work_poll", "gate_check",
        ];
        for m in kept {
            assert!(engine_method(m).is_err(), "{m} must not be generic");
        }
    }

    #[test]
    fn version_matches_cargo() {
        assert_eq!(app_version(), "0.0.1");
    }
}
