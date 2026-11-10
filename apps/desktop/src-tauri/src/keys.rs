//! API keys. They are stored only in the system's password store and never
//! sent back to the screens: the screens can save, remove, or ask "is one saved?".

use serde::Serialize;

/// The model providers the app can hold a key for.
pub const PROVIDERS: [&str; 3] = ["anthropic", "openai", "deepseek"];

/// Name the keys are filed under in the password store.
pub const SERVICE: &str = "app.aiprototype.desktop";

pub trait SecretStore: Send + Sync {
    fn get(&self, provider: &str) -> Result<Option<String>, String>;
    fn set(&self, provider: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, provider: &str) -> Result<(), String>;
}

/// The real store, backed by the operating system.
pub struct OsKeyring;

impl OsKeyring {
    fn entry(provider: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, provider).map_err(|e| format!("password store unavailable: {e}"))
    }
}

impl SecretStore for OsKeyring {
    fn get(&self, provider: &str) -> Result<Option<String>, String> {
        match Self::entry(provider)?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("could not read the password store: {e}")),
        }
    }
    fn set(&self, provider: &str, secret: &str) -> Result<(), String> {
        Self::entry(provider)?
            .set_password(secret)
            .map_err(|e| format!("could not save to the password store: {e}"))
    }
    fn delete(&self, provider: &str) -> Result<(), String> {
        match Self::entry(provider)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("could not remove from the password store: {e}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct KeyStatus {
    pub provider: String,
    pub saved: bool,
}

fn check_provider(provider: &str) -> Result<(), String> {
    if PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err(format!("unknown provider: {provider}"))
    }
}

/// Basic shape checks so a typo or a pasted sentence is caught before saving.
/// The real test is the first call to the provider (step 4).
pub fn validate_key(provider: &str, key: &str) -> Result<(), String> {
    check_provider(provider)?;
    if key.is_empty() {
        return Err("the key is empty".into());
    }
    if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("the key has spaces or line breaks in it".into());
    }
    if !(20..=400).contains(&key.len()) {
        return Err("the key is not the right length".into());
    }
    let prefix = if provider == "anthropic" { "sk-ant-" } else { "sk-" };
    if !key.starts_with(prefix) {
        return Err(format!("this doesn't look like a {provider} key (it should start with {prefix})"));
    }
    Ok(())
}

pub fn status(store: &dyn SecretStore, provider: &str) -> Result<KeyStatus, String> {
    check_provider(provider)?;
    Ok(KeyStatus { provider: provider.into(), saved: store.get(provider)?.is_some() })
}

pub fn save(store: &dyn SecretStore, provider: &str, key: &str) -> Result<KeyStatus, String> {
    let key = key.trim();
    validate_key(provider, key)?;
    store.set(provider, key)?;
    status(store, provider)
}

/// Reads a saved key for the engine. Only Rust calls this; the screens never see the key.
pub fn load(store: &dyn SecretStore, provider: &str) -> Result<String, String> {
    check_provider(provider)?;
    store.get(provider)?.ok_or_else(|| format!("No {provider} key saved. Add it in Settings."))
}

pub fn remove(store: &dyn SecretStore, provider: &str) -> Result<KeyStatus, String> {
    check_provider(provider)?;
    store.delete(provider)?;
    status(store, provider)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct MemoryStore(Mutex<HashMap<String, String>>);

    impl SecretStore for MemoryStore {
        fn get(&self, p: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(p).cloned())
        }
        fn set(&self, p: &str, s: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(p.into(), s.into());
            Ok(())
        }
        fn delete(&self, p: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(p);
            Ok(())
        }
    }

    // Obviously fake test values, not real keys.
    const FAKE_ANTHROPIC: &str = "sk-ant-test-0000000000000000";
    const FAKE_OPENAI: &str = "sk-test-0000000000000000";

    #[test]
    fn save_status_remove_round_trip() {
        let store = MemoryStore::default();
        assert!(!status(&store, "anthropic").unwrap().saved);
        assert!(save(&store, "anthropic", FAKE_ANTHROPIC).unwrap().saved);
        assert_eq!(store.get("anthropic").unwrap().as_deref(), Some(FAKE_ANTHROPIC));
        assert!(!remove(&store, "anthropic").unwrap().saved);
        // Removing again is fine.
        assert!(!remove(&store, "anthropic").unwrap().saved);
    }

    #[test]
    fn load_returns_the_key_or_a_plain_error() {
        let store = MemoryStore::default();
        assert_eq!(load(&store, "anthropic").unwrap_err(), "No anthropic key saved. Add it in Settings.");
        save(&store, "anthropic", FAKE_ANTHROPIC).unwrap();
        assert_eq!(load(&store, "anthropic").unwrap(), FAKE_ANTHROPIC);
        assert!(load(&store, "nobody").is_err());
    }

    #[test]
    fn save_trims_pasted_whitespace() {
        let store = MemoryStore::default();
        save(&store, "openai", &format!("  {FAKE_OPENAI}\n")).unwrap();
        assert_eq!(store.get("openai").unwrap().as_deref(), Some(FAKE_OPENAI));
    }

    #[test]
    fn rejects_bad_keys_and_saves_nothing() {
        let store = MemoryStore::default();
        for (provider, key, msg) in [
            ("anthropic", "", "empty"),
            ("anthropic", "sk-ant-test 0000000000000000", "spaces"),
            ("anthropic", "sk-ant-short", "length"),
            ("anthropic", FAKE_OPENAI, "should start with sk-ant-"),
            ("openai", "pk-test-0000000000000000000", "should start with sk-"),
            ("nobody", FAKE_OPENAI, "unknown provider"),
        ] {
            let err = save(&store, provider, key).unwrap_err();
            assert!(err.contains(msg), "{provider}/{key}: {err}");
        }
        assert!(store.0.lock().unwrap().is_empty());
    }

    #[test]
    fn key_status_never_contains_the_key() {
        let store = MemoryStore::default();
        let s = save(&store, "anthropic", FAKE_ANTHROPIC).unwrap();
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains(FAKE_ANTHROPIC));
        assert_eq!(json, r#"{"provider":"anthropic","saved":true}"#);
    }
}
