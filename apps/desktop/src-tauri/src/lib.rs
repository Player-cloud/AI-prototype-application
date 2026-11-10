//! The Rust shell is kept tiny on purpose: it opens the window and starts the
//! TypeScript engine helper. All app logic lives in TypeScript.

mod engine;

use engine::{helper_command, EngineHelper, EngineStatus};
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let helper = EngineHelper::start(&helper_command(std::env::var("AIP_ENGINE").ok()));
    tauri::Builder::default()
        .manage(Engine(Mutex::new(helper)))
        .invoke_handler(tauri::generate_handler![version, engine_status])
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
