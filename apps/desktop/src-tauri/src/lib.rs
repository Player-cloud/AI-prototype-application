//! The Rust shell is kept tiny on purpose: it opens the window and, in later
//! steps, starts the TypeScript engine helper. All app logic lives in TypeScript.

/// Version shown in the app, read from Cargo.toml at build time.
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[tauri::command]
fn version() -> String {
    app_version().to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![version])
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
