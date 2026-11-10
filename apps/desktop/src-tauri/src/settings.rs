//! Non-secret settings (provider, budget, £/$ rate, model choices, prices) in settings.json
//! in the app's own config folder. Keys are never written here. The engine checks the
//! contents; this file only reads and writes them safely.

use serde_json::Value;
use std::fs;
use std::path::Path;

/// Biggest settings file we accept. Real ones are a few hundred bytes.
const MAX_BYTES: u64 = 64 * 1024;

/// The saved settings, or `{}` when nothing is saved yet (the engine fills in defaults).
pub fn read(path: &Path) -> Result<Value, String> {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Object(Default::default())),
        Err(e) => return Err(format!("could not read settings: {e}")),
    };
    if meta.len() > MAX_BYTES {
        return Err("settings file is too big; save Settings again to replace it".into());
    }
    let text = fs::read_to_string(path).map_err(|e| format!("could not read settings: {e}"))?;
    let value: Value =
        serde_json::from_str(&text).map_err(|_| "settings file is damaged; save Settings again to replace it".to_string())?;
    if !value.is_object() {
        return Err("settings file is damaged; save Settings again to replace it".into());
    }
    Ok(value)
}

/// Writes the settings. A half-written file can't be left behind: write a temp file, then rename.
pub fn write(path: &Path, value: &Value) -> Result<(), String> {
    if !value.is_object() {
        return Err("settings must be an object".into());
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| format!("could not save settings: {e}"))?;
    if text.len() as u64 > MAX_BYTES {
        return Err("settings are too big to save".into());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("could not save settings: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("could not save settings: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("could not save settings: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aip-settings-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn missing_file_reads_as_empty() {
        let dir = temp_dir("missing");
        assert_eq!(read(&dir.join("settings.json")), Ok(json!({})));
    }

    #[test]
    fn writes_then_reads_back_and_makes_the_folder() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("nested").join("settings.json");
        let value = json!({ "provider": "deepseek", "gbpPerUsd": 0.8 });
        write(&path, &value).unwrap();
        assert_eq!(read(&path), Ok(value));
        assert!(!path.with_extension("json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn damaged_or_wrong_files_give_plain_errors() {
        let dir = temp_dir("damaged");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        fs::write(&path, "{not json").unwrap();
        assert!(read(&path).unwrap_err().contains("damaged"));
        fs::write(&path, "[1,2]").unwrap();
        assert!(read(&path).unwrap_err().contains("damaged"));
        fs::write(&path, vec![b' '; (MAX_BYTES + 1) as usize]).unwrap();
        assert!(read(&path).unwrap_err().contains("too big"));
        assert!(write(&path, &json!([1])).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
