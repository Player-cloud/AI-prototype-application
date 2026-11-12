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

/// This month's spend against the budget.
#[tauri::command]
async fn spend_summary(app: tauri::AppHandle, state: tauri::State<'_, Engine>) -> Result<serde_json::Value, String> {
    let saved = settings::read(&settings_path(&app)?)?;
    let db = spend_path(&app)?;
    engine_call(&state, "spend_summary", serde_json::json!({ "settings": saved, "dbPath": db }))
}

/// The ask-first rules in plain words (the gatekeeper's, the app's guard, and joshua's own).
#[tauri::command]
async fn gate_rules(app: tauri::AppHandle, state: tauri::State<'_, Engine>) -> Result<serde_json::Value, String> {
    let saved = settings::read(&settings_path(&app)?)?;
    engine_call(&state, "gate_rules", serde_json::json!({ "settings": saved }))
}

/// Saved settings with defaults filled in by the engine.
#[tauri::command]
async fn settings_get(app: tauri::AppHandle, state: tauri::State<'_, Engine>) -> Result<serde_json::Value, String> {
    let raw = settings::read(&settings_path(&app)?)?;
    engine_call(&state, "settings_check", serde_json::json!({ "settings": raw }))
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

/// The engine methods the Projects screen may call. Anything else is refused.
const PROJECT_METHODS: [&str; 8] = ["interview_stages", "project_list", "interview_start", "interview_get", "interview_save", "interview_confirm", "code_folder_check", "code_folder_create"];

fn project_method(method: &str) -> Result<&str, String> {
    PROJECT_METHODS.iter().find(|m| **m == method).copied().ok_or_else(|| format!("not a project method: {method}"))
}

/// Projects and the plan interview. The saved settings (for the data folder) are added here.
#[tauri::command]
async fn project(
    method: String,
    params: serde_json::Value,
    app: tauri::AppHandle,
    state: tauri::State<'_, Engine>,
) -> Result<serde_json::Value, String> {
    let method = project_method(&method)?;
    let saved = settings::read(&settings_path(&app)?)?;
    let mut params = match params {
        serde_json::Value::Object(map) => map,
        serde_json::Value::Null => serde_json::Map::new(),
        _ => return Err("params must be an object".into()),
    };
    params.insert("settings".into(), saved);
    engine_call(&state, method, serde_json::Value::Object(params))
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

/// Saved feature builds for one project (or all), newest first.
#[tauri::command]
async fn run_list(slug: Option<String>, app: tauri::AppHandle, state: tauri::State<'_, Engine>) -> Result<serde_json::Value, String> {
    engine_call(&state, "run_list", serde_json::json!({ "dbPath": spend_path(&app)?, "slug": slug.unwrap_or_default() }))
}

/// CI-4: how each way of building has done in real builds on this computer.
#[tauri::command]
async fn workflow_compare(app: tauri::AppHandle, state: tauri::State<'_, Engine>) -> Result<serde_json::Value, String> {
    let saved = settings::read(&settings_path(&app)?)?;
    engine_call(&state, "workflow_compare", serde_json::json!({ "settings": saved, "dbPath": spend_path(&app)? }))
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

/// The "Needs you" panel: open work items, oldest first (step 10b).
#[tauri::command]
async fn work_list(app: tauri::AppHandle, state: tauri::State<'_, Engine>) -> Result<serde_json::Value, String> {
    engine_call(&state, "work_list", serde_json::json!({ "dbPath": spend_path(&app)? }))
}

/// joshua's 1–5 rating for a build. The app may then update its learned habits (step 9d).
#[tauri::command]
async fn run_rate(id: i64, rating: u8, app: tauri::AppHandle, state: tauri::State<'_, Engine>) -> Result<serde_json::Value, String> {
    let saved = settings::read(&settings_path(&app)?)?;
    engine_call(&state, "run_rate", serde_json::json!({ "settings": saved, "dbPath": spend_path(&app)?, "id": id, "rating": rating }))
}

/// The newest changes, for Settings → History.
#[tauri::command]
async fn history_list(app: tauri::AppHandle, state: tauri::State<'_, Engine>) -> Result<serde_json::Value, String> {
    engine_call(&state, "history_list", serde_json::json!({ "dbPath": spend_path(&app)? }))
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
    let summary = r.get("summary").and_then(|t| t.as_str()).unwrap_or("Undone.").to_string();
    Ok(serde_json::json!({ "kind": "settings", "id": id, "label": label, "summary": summary }))
}

/// The tools, habits and rules in the data folder chosen in Settings (read-only).
#[tauri::command]
async fn data_overview(app: tauri::AppHandle, state: tauri::State<'_, Engine>) -> Result<serde_json::Value, String> {
    let saved = settings::read(&settings_path(&app)?)?;
    engine_call(&state, "data_overview", serde_json::json!({ "settings": saved }))
}

/// CI-3: runs the free repeatable tests (all, or one capability's) and saves the results.
#[tauri::command]
async fn eval_run(capability: Option<String>, app: tauri::AppHandle, state: tauri::State<'_, Engine>) -> Result<serde_json::Value, String> {
    let saved = settings::read(&settings_path(&app)?)?;
    engine_call(&state, "eval_run", serde_json::json!({ "settings": saved, "capability": capability.unwrap_or_default() }))
}

/// CI-5: runs one tool's free test several times in a row and saves the experiment as a proposal.
#[tauri::command]
async fn experiment_run(capability: String, runs: Option<u32>, app: tauri::AppHandle, state: tauri::State<'_, Engine>) -> Result<serde_json::Value, String> {
    let saved = settings::read(&settings_path(&app)?)?;
    let mut params = serde_json::json!({ "settings": saved, "capability": capability });
    if let Some(n) = runs {
        params["runs"] = serde_json::json!(n);
    }
    engine_call(&state, "experiment_run", params)
}

/// CI-2: checks this computer (free) and saves the result in the data folder, then syncs.
#[tauri::command]
async fn environment_check(app: tauri::AppHandle, state: tauri::State<'_, Engine>) -> Result<serde_json::Value, String> {
    let saved = settings::read(&settings_path(&app)?)?;
    engine_call(&state, "environment_check", serde_json::json!({ "settings": saved }))
}

/// Saves a 1–5 rating for a tool in the data repo's ledger, then syncs it to GitHub.
#[tauri::command]
async fn tool_rate(
    tool: String,
    rating: u8,
    app: tauri::AppHandle,
    state: tauri::State<'_, Engine>,
) -> Result<serde_json::Value, String> {
    let saved = settings::read(&settings_path(&app)?)?;
    let db = spend_path(&app)?;
    engine_call(&state, "tool_rate", serde_json::json!({ "settings": saved, "tool": tool, "rating": rating, "dbPath": db }))
}

/// Switches a tool that failed 3 times in a row back on (it's retested on next use), then syncs.
#[tauri::command]
async fn tool_switch_on(tool: String, app: tauri::AppHandle, state: tauri::State<'_, Engine>) -> Result<serde_json::Value, String> {
    let saved = settings::read(&settings_path(&app)?)?;
    engine_call(&state, "tool_switch_on", serde_json::json!({ "settings": saved, "tool": tool }))
}

/// Commits data folder changes and syncs them with GitHub (never forces).
#[tauri::command]
async fn data_sync(app: tauri::AppHandle, state: tauri::State<'_, Engine>) -> Result<serde_json::Value, String> {
    let saved = settings::read(&settings_path(&app)?)?;
    engine_call(&state, "data_sync", serde_json::json!({ "settings": saved }))
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
        .invoke_handler(tauri::generate_handler![version, engine_status, key_status, key_save, key_remove, test_model, settings_get, settings_save, data_overview, environment_check, eval_run, experiment_run, spend_summary, tool_rate, tool_switch_on, data_sync, gate_rules, history_list, history_undo, project, interview_suggest, interview_review, build_feature, build_stop, run_list, workflow_compare, run_decide, run_rate, github_test, work_list, work_poll, phone_setup])
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
    fn only_project_methods_pass() {
        assert_eq!(project_method("interview_save"), Ok("interview_save"));
        assert_eq!(project_method("code_folder_check"), Ok("code_folder_check"));
        assert_eq!(project_method("code_folder_create"), Ok("code_folder_create"));
        assert!(project_method("tool_rate").is_err());
        assert!(project_method("tool_switch_on").is_err());
        assert!(project_method("ask").is_err());
    }

    #[test]
    fn version_matches_cargo() {
        assert_eq!(app_version(), "0.0.1");
    }
}
