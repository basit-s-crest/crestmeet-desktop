// src/local_credentials.rs
//
// Persistent local storage for user API keys (stored on the device, not in the shared cloud DB).
// Stored in the OS application data directory (%APPDATA%\com.crestmeet.ai\local_credentials.json on Windows).

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use log::{info, warn};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use uuid::Uuid;

static CREDENTIALS_MUTEX: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct LocalCredentialsStore {
    /// Default device-level fallback keys per provider (e.g. "groq" -> "gsk_...", "deepgram" -> "...")
    #[serde(default)]
    pub default_keys: HashMap<String, String>,

    /// User-scoped keys: user_id -> (provider -> api_key)
    #[serde(default)]
    pub user_keys: HashMap<String, HashMap<String, String>>,
}

fn get_credentials_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir.push("local_credentials.json");
    Ok(dir)
}

fn read_credentials<R: Runtime>(app: &AppHandle<R>) -> LocalCredentialsStore {
    let Ok(path) = get_credentials_path(app) else {
        return LocalCredentialsStore::default();
    };

    if !path.exists() {
        return LocalCredentialsStore::default();
    }

    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(e) => {
            warn!("Failed to read local credentials from {:?}: {}", path, e);
            LocalCredentialsStore::default()
        }
    }
}

fn write_credentials<R: Runtime>(app: &AppHandle<R>, store: &LocalCredentialsStore) -> Result<(), String> {
    let path = get_credentials_path(app)?;
    let json = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize credentials: {}", e))?;
    fs::write(&path, json)
        .map_err(|e| format!("Failed to write credentials to {:?}: {}", path, e))?;
    Ok(())
}

/// Save an API key locally on this machine for a specific user and provider
pub fn save_local_api_key<R: Runtime>(
    app: &AppHandle<R>,
    user_id: Option<Uuid>,
    provider: &str,
    api_key: &str,
) -> Result<(), String> {
    let _lock = CREDENTIALS_MUTEX.lock().unwrap();
    let mut store = read_credentials(app);
    let key = api_key.trim();

    if let Some(uid) = user_id {
        let user_entry = store.user_keys.entry(uid.to_string()).or_default();
        if key.is_empty() {
            user_entry.remove(provider);
        } else {
            user_entry.insert(provider.to_string(), key.to_string());
        }
    }

    // Also update default device-level key so active session always has fast access
    if key.is_empty() {
        store.default_keys.remove(provider);
    } else {
        store.default_keys.insert(provider.to_string(), key.to_string());
    }

    write_credentials(app, &store)?;
    info!("✅ Saved local API key for provider '{}' to device storage", provider);
    Ok(())
}

/// Retrieve an API key from this machine's local storage
pub fn get_local_api_key<R: Runtime>(
    app: &AppHandle<R>,
    user_id: Option<Uuid>,
    provider: &str,
) -> Option<String> {
    let _lock = CREDENTIALS_MUTEX.lock().unwrap();
    let store = read_credentials(app);

    // 1. Check user-scoped key if user_id is provided
    if let Some(uid) = user_id {
        if let Some(user_map) = store.user_keys.get(&uid.to_string()) {
            if let Some(k) = user_map.get(provider) {
                if !k.trim().is_empty() {
                    return Some(k.clone());
                }
            }
        }
    }

    // 2. Fall back to device-level key for this provider
    if let Some(k) = store.default_keys.get(provider) {
        if !k.trim().is_empty() {
            return Some(k.clone());
        }
    }

    None
}

/// Delete an API key from local device storage
pub fn delete_local_api_key<R: Runtime>(
    app: &AppHandle<R>,
    user_id: Option<Uuid>,
    provider: &str,
) -> Result<(), String> {
    let _lock = CREDENTIALS_MUTEX.lock().unwrap();
    let mut store = read_credentials(app);

    if let Some(uid) = user_id {
        if let Some(user_map) = store.user_keys.get_mut(&uid.to_string()) {
            user_map.remove(provider);
        }
    }
    store.default_keys.remove(provider);

    write_credentials(app, &store)?;
    info!("🗑️ Deleted local API key for provider '{}' from device storage", provider);
    Ok(())
}
