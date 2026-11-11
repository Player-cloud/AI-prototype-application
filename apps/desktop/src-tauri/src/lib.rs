//! The Rust shell is kept tiny on purpose: it opens the window and starts the
//! TypeScript engine helper. All app logic lives in TypeScript.

mod engine;
mod keys;
mod settings;

use engine::{helper_command, EngineHelper, EngineStatus};
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let helper = EngineHelper::start(&helper_command(std::env::var("AIP_ENGINE").ok()));
    tauri::Builder::default()
        .manage(Engine(Mutex::new(helper)))
        .invoke_handler(tauri::generate_handler![version, engine_status, key_status, key_save, key_remove, test_model, settings_get, settings_save, data_overview, spend_summary, tool_rate, data_sync, gate_rules, history_list, history_undo])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_settings_providers_to_engine_names() {
        assert_eq!(engine_provider("anthropic"), Ok("claude"));
        assert_eq!(engine_provider("openai"), Ok("openai"));
        assert!(engine_provider("x").is_err());
    }

    #[test]
    fn version_matches_cargo() {
        assert_eq!(app_version(), "0.0.1");
    }
}
