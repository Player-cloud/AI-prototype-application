//! The Rust shell is kept tiny on purpose: it opens the window and starts the
//! TypeScript engine helper. All app logic lives in TypeScript.

mod engine;
mod keys;

use engine::{helper_command, EngineHelper, EngineStatus};
use keys::{KeyStatus, OsKeyring};
use std::sync::Mutex;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let helper = EngineHelper::start(&helper_command(std::env::var("AIP_ENGINE").ok()));
    tauri::Builder::default()
        .manage(Engine(Mutex::new(helper)))
        .invoke_handler(tauri::generate_handler![version, engine_status, key_status, key_save, key_remove])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_matches_cargo() {
        assert_eq!(app_version(), "0.0.1");
    }
}
