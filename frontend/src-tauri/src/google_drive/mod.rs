use log::{error as log_error, info as log_info, warn as log_warn};
use once_cell::sync::Lazy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_store::StoreExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex as TokioMutex;

use crate::database::repositories::meeting::MeetingsRepository;
use crate::state::AppState;
use uuid::Uuid;

const REDIRECT_URI: &str = "http://localhost:3000/api/calendar/auth/callback";
const SCOPES: &str = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email";
const STORE_FILENAME: &str = "google_drive.json";

/// Active background upload controls for pausing and resuming
#[derive(Clone)]
pub struct UploadJobControl {
    pub is_paused: Arc<AtomicBool>,
    pub is_cancelled: Arc<AtomicBool>,
}

static UPLOAD_JOBS: Lazy<TokioMutex<HashMap<String, UploadJobControl>>> =
    Lazy::new(|| TokioMutex::new(HashMap::new()));

fn get_env_var(key: &str) -> Option<String> {
    for path in &[".env", "../.env", "../../.env", "frontend/.env"] {
        if let Ok(content) = std::fs::read_to_string(path) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with('#') || trimmed.is_empty() {
                    continue;
                }
                if let Some((k, v)) = trimmed.split_once('=') {
                    if k.trim() == key {
                        let clean_val = v.trim().trim_matches('"').trim_matches('\'').to_string();
                        if !clean_val.is_empty() {
                            return Some(clean_val);
                        }
                    }
                }
            }
        }
    }
    if let Ok(val) = std::env::var(key) {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// Resolves Google Client ID with multi-organization support.
/// If email matches GOOGLE_ORG2_DOMAINS and GOOGLE_CLIENT_ID_ORG2 is set, uses Org 2 credentials.
/// Otherwise defaults to GOOGLE_CLIENT_ID (which supports both orgs when OAuth consent screen is External).
fn get_client_id(email_hint: Option<&str>) -> Result<String, String> {
    if let Some(email) = email_hint {
        if let Some(org2_domains) = get_env_var("GOOGLE_ORG2_DOMAINS") {
            let email_domain = email.split('@').nth(1).unwrap_or("").trim().to_lowercase();
            let matches_org2 = org2_domains
                .split(',')
                .any(|d| d.trim().to_lowercase() == email_domain);
            if matches_org2 {
                if let Some(cid2) = get_env_var("GOOGLE_CLIENT_ID_ORG2") {
                    if !cid2.trim().is_empty() {
                        return Ok(cid2);
                    }
                }
            }
        }
    }

    get_env_var("GOOGLE_CLIENT_ID")
        .or_else(|| option_env!("GOOGLE_CLIENT_ID").map(String::from))
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Google OAuth Client ID is not configured. Please set GOOGLE_CLIENT_ID in your environment or .env file.".to_string())
}

/// Resolves Google Client Secret with multi-organization support.
fn get_client_secret(email_hint: Option<&str>) -> Result<String, String> {
    if let Some(email) = email_hint {
        if let Some(org2_domains) = get_env_var("GOOGLE_ORG2_DOMAINS") {
            let email_domain = email.split('@').nth(1).unwrap_or("").trim().to_lowercase();
            let matches_org2 = org2_domains
                .split(',')
                .any(|d| d.trim().to_lowercase() == email_domain);
            if matches_org2 {
                if let Some(sec2) = get_env_var("GOOGLE_CLIENT_SECRET_ORG2") {
                    if !sec2.trim().is_empty() {
                        return Ok(sec2);
                    }
                }
            }
        }
    }

    get_env_var("GOOGLE_CLIENT_SECRET")
        .or_else(|| option_env!("GOOGLE_CLIENT_SECRET").map(String::from))
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Google OAuth Client Secret is not configured. Please set GOOGLE_CLIENT_SECRET in your environment or .env file.".to_string())
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct GoogleDriveTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<i64>,
    pub user_email: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GoogleDriveStatus {
    pub is_connected: bool,
    pub email: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UploadProgressPayload {
    pub meeting_id: String,
    pub progress: u32,
    pub status: String, // "idle", "merging", "checking_drive", "uploading", "paused", "completed", "error", "not_connected"
    pub error: Option<String>,
    pub video_url: Option<String>,
    pub drive_file_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenEndpointResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct UserInfoResponse {
    email: Option<String>,
}

fn current_timestamp_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn open_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn()
            .map_err(|e| format!("Failed to open browser: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {}", e))?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {}", e))?;
    }
    Ok(())
}

async fn resolve_user_context(
    state: &State<'_, AppState>,
    user_id_hint: Option<String>,
) -> (Option<String>, Option<String>) {
    let mut user_id_str = None;
    let mut email = None;

    if let Some(hint) = user_id_hint {
        let trimmed = hint.trim();
        if !trimmed.is_empty() {
            if trimmed.contains('@') {
                email = Some(trimmed.to_lowercase());
            } else {
                user_id_str = Some(trimmed.to_string());
            }
        }
    }

    if user_id_str.is_none() {
        if let Some(uid) = *state.current_user_id.read().await {
            user_id_str = Some(uid.to_string());
        }
    }

    if email.is_none() {
        if let Some(ref uid_str) = user_id_str {
            if let Ok(uid) = Uuid::parse_str(uid_str) {
                let pool = state.db_manager.pool();
                if let Ok(Some(row_email)) = sqlx::query_scalar::<_, String>(
                    "SELECT email FROM app_users WHERE id = $1"
                )
                .bind(uid)
                .fetch_optional(pool)
                .await
                {
                    email = Some(row_email.to_lowercase());
                }
            }
        }
    }

    (user_id_str, email)
}

fn load_tokens<R: Runtime>(
    app: &AppHandle<R>,
    user_id: Option<&str>,
    user_email: Option<&str>,
) -> Option<GoogleDriveTokens> {
    if user_id.is_none() && user_email.is_none() {
        return None;
    }

    let store = app.store(STORE_FILENAME).ok()?;

    // 1. Check by user ID key
    if let Some(uid) = user_id {
        let trimmed = uid.trim();
        if !trimmed.is_empty() {
            let key = format!("user:{}", trimmed.to_lowercase());
            if let Some(val) = store.get(&key) {
                if let Ok(tok) = serde_json::from_value::<GoogleDriveTokens>(val) {
                    return Some(tok);
                }
            }
        }
    }

    // 2. Check by email key
    if let Some(em) = user_email {
        let trimmed = em.trim();
        if !trimmed.is_empty() {
            let key = format!("account:{}", trimmed.to_lowercase());
            if let Some(val) = store.get(&key) {
                if let Ok(tok) = serde_json::from_value::<GoogleDriveTokens>(val) {
                    return Some(tok);
                }
            }
        }
    }

    // 3. Migration check: migrate old legacy "tokens" entry if authorized email matches user
    if let Some(val) = store.get("tokens") {
        if let Ok(legacy_tokens) = serde_json::from_value::<GoogleDriveTokens>(val) {
            let mut matches = false;
            if let Some(ref leg_email) = legacy_tokens.user_email {
                let leg_clean = leg_email.trim().to_lowercase();
                if let Some(em) = user_email {
                    if em.trim().to_lowercase() == leg_clean {
                        matches = true;
                    }
                }
            }
            if matches {
                let _ = store.delete("tokens");
                let _ = save_tokens(app, user_id, user_email, &legacy_tokens);
                return Some(legacy_tokens);
            }
        }
    }

    None
}

fn save_tokens<R: Runtime>(
    app: &AppHandle<R>,
    user_id: Option<&str>,
    user_email: Option<&str>,
    tokens: &GoogleDriveTokens,
) -> Result<(), String> {
    let store = app
        .store(STORE_FILENAME)
        .map_err(|e| format!("Failed to open store: {}", e))?;
    let val = serde_json::to_value(tokens).map_err(|e| format!("Failed to serialize tokens: {}", e))?;

    if let Some(uid) = user_id {
        let trimmed = uid.trim();
        if !trimmed.is_empty() {
            let key = format!("user:{}", trimmed.to_lowercase());
            store.set(key, val.clone());
        }
    }

    if let Some(em) = user_email {
        let trimmed = em.trim();
        if !trimmed.is_empty() {
            let key = format!("account:{}", trimmed.to_lowercase());
            store.set(key, val.clone());
        }
    }

    if let Some(ref g_email) = tokens.user_email {
        let trimmed = g_email.trim();
        if !trimmed.is_empty() {
            let key = format!("account:{}", trimmed.to_lowercase());
            store.set(key, val);
        }
    }

    // Remove legacy shared "tokens" key so it cannot leak across accounts
    let _ = store.delete("tokens");

    store
        .save()
        .map_err(|e| format!("Failed to save store to disk: {}", e))?;
    Ok(())
}

async fn get_valid_access_token<R: Runtime>(
    app: &AppHandle<R>,
    user_id: Option<&str>,
    user_email_hint: Option<&str>,
) -> Result<String, String> {
    let mut tokens = load_tokens(app, user_id, user_email_hint).ok_or_else(|| "Google Drive is not connected".to_string())?;
    let now = current_timestamp_secs();

    // If token has at least 60 seconds before expiration, reuse it
    if let Some(expires_at) = tokens.expires_at {
        if expires_at > now + 60 && !tokens.access_token.is_empty() {
            return Ok(tokens.access_token);
        }
    }

    let refresh_token = tokens
        .refresh_token
        .as_ref()
        .ok_or_else(|| "No refresh token available; please reconnect Google Drive".to_string())?;

    let effective_email = tokens.user_email.as_deref().or(user_email_hint);
    let client_id = get_client_id(effective_email)?;
    let client_secret = get_client_secret(effective_email)?;

    log_info!("Refreshing Google Drive access token...");
    let client = Client::new();
    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| format!("Failed to send refresh request: {}", e))?;

    if !resp.status().is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        return Err(format!("Failed to refresh token: {}", err_text));
    }

    let token_data: TokenEndpointResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse refresh token response: {}", e))?;

    tokens.access_token = token_data.access_token.clone();
    if let Some(new_refresh) = token_data.refresh_token {
        tokens.refresh_token = Some(new_refresh);
    }
    if let Some(exp) = token_data.expires_in {
        tokens.expires_at = Some(now + exp);
    }

    save_tokens(app, user_id, user_email_hint, &tokens)?;
    Ok(tokens.access_token)
}

#[tauri::command]
pub async fn api_google_drive_get_status<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    user_id_hint: Option<String>,
) -> Result<GoogleDriveStatus, String> {
    let (user_id, user_email) = resolve_user_context(&state, user_id_hint).await;
    if let Some(tokens) = load_tokens(&app, user_id.as_deref(), user_email.as_deref()) {
        if !tokens.access_token.is_empty() {
            return Ok(GoogleDriveStatus {
                is_connected: true,
                email: tokens.user_email,
            });
        }
    }
    Ok(GoogleDriveStatus {
        is_connected: false,
        email: None,
    })
}

#[tauri::command]
pub async fn api_google_drive_disconnect<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    user_id_hint: Option<String>,
) -> Result<(), String> {
    let (user_id, user_email) = resolve_user_context(&state, user_id_hint).await;
    if let Ok(store) = app.store(STORE_FILENAME) {
        if let Some(ref uid) = user_id {
            let key = format!("user:{}", uid.trim().to_lowercase());
            let _ = store.delete(&key);
        }
        if let Some(ref em) = user_email {
            let key = format!("account:{}", em.trim().to_lowercase());
            let _ = store.delete(&key);
        }
        let _ = store.delete("tokens");
        let _ = store.save();
    }
    log_info!("Google Drive disconnected for user: {:?}", user_id);
    Ok(())
}

#[tauri::command]
pub async fn api_google_drive_start_auth<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    user_email_hint: Option<String>,
    user_id_hint: Option<String>,
) -> Result<GoogleDriveStatus, String> {
    let (resolved_uid, resolved_email) = resolve_user_context(&state, user_id_hint).await;
    let effective_email = user_email_hint.or(resolved_email);
    let client_id = get_client_id(effective_email.as_deref())?;
    let client_secret = get_client_secret(effective_email.as_deref())?;

    log_info!("Starting Google Drive OAuth flow on loopback port 3000...");

    let listener = TcpListener::bind("127.0.0.1:3000")
        .await
        .map_err(|e| format!("Port 3000 is currently occupied. Please ensure nothing is using port 3000: {}", e))?;

    let encoded_scopes: String = url::form_urlencoded::byte_serialize(SCOPES.as_bytes()).collect();
    let encoded_redirect: String = url::form_urlencoded::byte_serialize(REDIRECT_URI.as_bytes()).collect();
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent&state=drive",
        client_id, encoded_redirect, encoded_scopes
    );

    open_browser(&auth_url)?;

    let timeout_duration = Duration::from_secs(120);
    let code = match tokio::time::timeout(timeout_duration, async {
        loop {
            let (mut socket, _) = listener.accept().await.map_err(|e| format!("Listener error: {}", e))?;
            let mut buf = [0u8; 4096];
            let n = socket.read(&mut buf).await.map_err(|e| format!("Read error: {}", e))?;
            let request = String::from_utf8_lossy(&buf[..n]);

            if request.starts_with("GET /api/calendar/auth/callback") || request.starts_with("GET /api/drive/auth/callback") {
                let query = request.lines().next().unwrap_or_default();
                let code_param = query
                    .split_whitespace()
                    .nth(1)
                    .and_then(|path| path.split('?').nth(1))
                    .and_then(|qs| {
                        qs.split('&')
                            .find(|param| param.starts_with("code="))
                            .map(|p| p.trim_start_matches("code="))
                    });

                let html_body = r#"<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Google Drive Connected - CrestMeet</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f8fafc; }
        .card { background: white; padding: 40px; border-radius: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.06); text-align: center; max-width: 420px; border: 1px solid #e2e8f0; }
        .icon { width: 64px; height: 64px; background: #eff6ff; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 32px; color: #2563eb; }
        h2 { color: #0f172a; margin: 0 0 8px; font-size: 22px; font-weight: 700; }
        p { color: #64748b; font-size: 14px; line-height: 1.5; margin: 0 0 24px; }
        .badge { display: inline-block; background: #dbeafe; color: #1e40af; padding: 6px 14px; border-radius: 9999px; font-size: 12px; font-weight: 600; }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">☁️</div>
        <h2>Google Drive Connected!</h2>
        <p>Your Google Drive is successfully linked to CrestMeet. Meetings and recordings will automatically sync to your cloud drive.</p>
        <span class="badge">Safe to close this window</span>
    </div>
</body>
</html>"#;

                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    html_body.len(),
                    html_body
                );

                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.flush().await;

                if let Some(code) = code_param {
                    let decoded_code = url::form_urlencoded::parse(format!("c={}", code).as_bytes())
                        .find(|(k, _)| k == "c")
                        .map(|(_, v)| v.to_string())
                        .unwrap_or_else(|| code.to_string());
                    return Ok(decoded_code);
                } else {
                    return Err("No authorization code found in callback query".to_string());
                }
            } else {
                let not_found = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                let _ = socket.write_all(not_found.as_bytes()).await;
            }
        }
    })
    .await
    {
        Ok(res) => res?,
        Err(_) => return Err("Google Drive authorization timed out. Please try again.".to_string()),
    };

    log_info!("Received Drive authorization code. Exchanging for tokens...");
    let client = Client::new();
    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code.as_str()),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("redirect_uri", REDIRECT_URI),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| format!("Failed to request token: {}", e))?;

    if !resp.status().is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        return Err(format!("Failed to exchange code for tokens: {}", err_text));
    }

    let token_data: TokenEndpointResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    let now = current_timestamp_secs();

    let email_resp = client
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(&token_data.access_token)
        .send()
        .await;

    let user_email = match email_resp {
        Ok(r) if r.status().is_success() => r.json::<UserInfoResponse>().await.ok().and_then(|u| u.email),
        _ => None,
    };

    let tokens = GoogleDriveTokens {
        access_token: token_data.access_token,
        refresh_token: token_data.refresh_token,
        expires_at: token_data.expires_in.map(|exp| now + exp),
        user_email: user_email.clone(),
    };

    save_tokens(&app, resolved_uid.as_deref(), effective_email.as_deref(), &tokens)?;
    log_info!("Google Drive successfully connected for email: {:?}", user_email);

    Ok(GoogleDriveStatus {
        is_connected: true,
        email: user_email,
    })
}

/// Finds or creates a dedicated "crestmeet" folder on the user's Google Drive.
/// Returns the Drive folder ID.
async fn get_or_create_crestmeet_folder(client: &Client, access_token: &str) -> Result<String, String> {
    // 1. Search for existing non-trashed folder named "crestmeet"
    let query = "name = 'crestmeet' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    let search_resp = client
        .get("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(access_token)
        .query(&[
            ("q", query),
            ("fields", "files(id, name)"),
            ("spaces", "drive"),
        ])
        .send()
        .await
        .map_err(|e| format!("Failed to search for 'crestmeet' folder: {}", e))?;

    if search_resp.status().is_success() {
        if let Ok(json_data) = search_resp.json::<serde_json::Value>().await {
            if let Some(files) = json_data.get("files").and_then(|f| f.as_array()) {
                if let Some(first_folder) = files.first() {
                    if let Some(folder_id) = first_folder.get("id").and_then(|id| id.as_str()) {
                        log_info!("📁 Found existing 'crestmeet' folder on Drive: {}", folder_id);
                        return Ok(folder_id.to_string());
                    }
                }
            }
        }
    }

    // 2. Not found or query empty: create the folder
    log_info!("📁 'crestmeet' folder not found on Google Drive. Creating it now...");
    let create_resp = client
        .post("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(access_token)
        .json(&serde_json::json!({
            "name": "crestmeet",
            "mimeType": "application/vnd.google-apps.folder",
            "description": "CrestMeet Meeting Recordings"
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to create 'crestmeet' folder: {}", e))?;

    if !create_resp.status().is_success() {
        let err_text = create_resp.text().await.unwrap_or_default();
        return Err(format!("Failed to create 'crestmeet' folder on Drive: {}", err_text));
    }

    let create_json: serde_json::Value = create_resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse created folder response: {}", e))?;

    let folder_id = create_json
        .get("id")
        .and_then(|id| id.as_str())
        .ok_or_else(|| "Google Drive did not return folder ID for created 'crestmeet' folder".to_string())?
        .to_string();

    log_info!("📁 Successfully created 'crestmeet' folder on Google Drive with ID: {}", folder_id);
    Ok(folder_id)
}

/// Uploads a local video file to Google Drive using resumable upload in 5MB chunks.
/// Supports pause and resume through `control`.
/// Places file inside dedicated "crestmeet" folder.
/// Sets reader permission so team members can stream via preview URL.
/// Sets read permission on a Google Drive file so team members can stream via preview URL.
/// First attempts to set "type": "anyone", "role": "reader" (public link sharing).
/// If Google Workspace organization policy blocks "anyone", falls back to "type": "domain".
pub async fn set_file_share_permissions(
    client: &Client,
    access_token: &str,
    file_id: &str,
    user_email_hint: Option<&str>,
) -> Result<String, String> {
    log_info!("🔑 Setting share permissions for Drive file {}...", file_id);

    // 1. First attempt: public reader ("anyone with the link")
    let anyone_resp = client
        .post(format!("https://www.googleapis.com/drive/v3/files/{}/permissions?supportsAllDrives=true", file_id))
        .bearer_auth(access_token)
        .json(&serde_json::json!({
            "role": "reader",
            "type": "anyone"
        }))
        .send()
        .await;

    match anyone_resp {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                log_info!("✅ Successfully set public reader permission (anyone) on Drive file {}", file_id);
                return Ok("anyone".to_string());
            }
            let err_body = resp.text().await.unwrap_or_default();
            log_warn!(
                "⚠️ Drive API returned status {} when setting 'anyone' permission for {}: {}",
                status, file_id, err_body
            );

            // If already exists, consider it success
            if err_body.contains("already exists") {
                return Ok("anyone".to_string());
            }

            // 2. Fallback: If blocked (e.g. 403 Google Workspace domain policy), try domain sharing
            if let Some(email) = user_email_hint {
                if let Some(domain) = email.split('@').nth(1) {
                    let d = domain.trim().to_lowercase();
                    if !d.is_empty() && d != "gmail.com" && d != "googlemail.com" {
                        log_info!("🔄 Falling back to domain reader permission for domain '{}' on file {}", d, file_id);
                        let domain_resp = client
                            .post(format!("https://www.googleapis.com/drive/v3/files/{}/permissions?supportsAllDrives=true", file_id))
                            .bearer_auth(access_token)
                            .json(&serde_json::json!({
                                "role": "reader",
                                "type": "domain",
                                "domain": d
                            }))
                            .send()
                            .await;

                        if let Ok(d_resp) = domain_resp {
                            let d_status = d_resp.status();
                            if d_status.is_success() {
                                log_info!("✅ Successfully set domain reader permission for domain '{}' on Drive file {}", d, file_id);
                                return Ok(format!("domain:{}", d));
                            }
                            let d_err = d_resp.text().await.unwrap_or_default();
                            if d_err.contains("already exists") {
                                return Ok(format!("domain:{}", d));
                            }
                            log_warn!("Domain permission also failed (status {}): {}", d_status, d_err);
                        }
                    }
                }
            }

            Err(format!("Drive API permission error (status {}): {}", status, err_body))
        }
        Err(e) => {
            log_warn!("Network error while setting permissions for Drive file {}: {}", file_id, e);
            Err(format!("Network error setting Drive permissions: {}", e))
        }
    }
}

/// Uploads a local video file to Google Drive using resumable upload in 5MB chunks.
/// Supports pause and resume through `control`.
/// Places file inside dedicated "crestmeet" folder.
/// Sets reader permission so team members can stream via preview URL.
async fn upload_video_file_to_drive<F>(
    access_token: &str,
    file_path: &Path,
    meeting_id: &str,
    control: UploadJobControl,
    user_email_hint: Option<&str>,
    mut on_progress: F,
) -> Result<(String, String), String>
where
    F: FnMut(u32, &str),
{
    let metadata = tokio::fs::metadata(file_path)
        .await
        .map_err(|e| format!("Failed to read video metadata: {}", e))?;
    let file_size = metadata.len();
    if file_size == 0 {
        return Err("Video file is empty (0 bytes)".to_string());
    }

    let client = Client::new();

    // Find or create the dedicated "crestmeet" folder
    let parent_folder_id = match get_or_create_crestmeet_folder(&client, access_token).await {
        Ok(id) => {
            log_info!("📁 Uploading meeting video to 'crestmeet' folder (ID: {})", id);
            Some(id)
        }
        Err(e) => {
            log_warn!("Could not get/create 'crestmeet' folder ({}), falling back to root Drive.", e);
            None
        }
    };

    let mut file_metadata = serde_json::json!({
        "name": format!("CrestMeet_Meeting_{}.mp4", meeting_id),
        "description": "Recorded with CrestMeet AI Meeting Assistant"
    });
    if let Some(ref fid) = parent_folder_id {
        file_metadata["parents"] = serde_json::json!([fid]);
    }

    let init_resp = client
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable")
        .bearer_auth(access_token)
        .header("X-Upload-Content-Type", "video/mp4")
        .header("X-Upload-Content-Length", file_size.to_string())
        .json(&file_metadata)
        .send()
        .await
        .map_err(|e| format!("Failed to initiate Google Drive upload session: {}", e))?;

    if !init_resp.status().is_success() {
        let err = init_resp.text().await.unwrap_or_default();
        return Err(format!("Drive API session error: {}", err));
    }

    let upload_url = init_resp
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "Google Drive did not return an upload location".to_string())?
        .to_string();

    let chunk_size: usize = 5 * 1024 * 1024; // 5 MB chunks (multiple of 256 KB)
    let mut file = tokio::fs::File::open(file_path)
        .await
        .map_err(|e| format!("Failed to open file: {}", e))?;
    let mut uploaded_bytes: u64 = 0;
    let mut buffer = vec![0u8; chunk_size];
    let mut drive_file_id: Option<String> = None;

    while uploaded_bytes < file_size {
        // Check if upload was cancelled
        if control.is_cancelled.load(Ordering::SeqCst) {
            return Err("Upload cancelled".to_string());
        }

        // Check if upload is paused
        if control.is_paused.load(Ordering::SeqCst) {
            log_info!("⏸️ Upload for meeting {} is paused at {} bytes", meeting_id, uploaded_bytes);
            let percent = ((uploaded_bytes as f64 / file_size as f64) * 70.0) as u32 + 25;
            on_progress(percent, "paused");

            while control.is_paused.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(400)).await;
                if control.is_cancelled.load(Ordering::SeqCst) {
                    return Err("Upload cancelled".to_string());
                }
            }
            log_info!("▶️ Upload for meeting {} resumed!", meeting_id);
            on_progress(percent, "uploading");
        }

        let to_read = std::cmp::min(chunk_size as u64, file_size - uploaded_bytes) as usize;
        file.read_exact(&mut buffer[..to_read])
            .await
            .map_err(|e| format!("Read chunk error: {}", e))?;

        let start = uploaded_bytes;
        let end = uploaded_bytes + to_read as u64 - 1;
        let content_range = format!("bytes {}-{}/{}", start, end, file_size);
        let chunk_data = buffer[..to_read].to_vec();

        let put_resp = client
            .put(&upload_url)
            .header("Content-Length", to_read.to_string())
            .header("Content-Range", content_range)
            .header("Content-Type", "video/mp4")
            .body(chunk_data)
            .send()
            .await
            .map_err(|e| format!("Failed to upload chunk: {}", e))?;

        uploaded_bytes += to_read as u64;
        let percent = ((uploaded_bytes as f64 / file_size as f64) * 70.0) as u32 + 25;
        on_progress(percent, "uploading");

        if put_resp.status().is_success() {
            let resp_json: serde_json::Value = put_resp.json().await.unwrap_or_default();
            if let Some(id) = resp_json.get("id").and_then(|v| v.as_str()) {
                drive_file_id = Some(id.to_string());
            }
        }
    }

    let file_id = drive_file_id.ok_or_else(|| "Drive upload finished but no file ID was returned".to_string())?;

    // Set permission to anyone with link as reader so other org users / team members can stream
    let share_res = set_file_share_permissions(&client, access_token, &file_id, user_email_hint).await;
    if let Err(e) = share_res {
        log_warn!("Could not set share permission on Drive file {}: {}", file_id, e);
    }

    let preview_url = format!("https://drive.google.com/file/d/{}/preview", file_id);
    log_info!("✅ Successfully uploaded to Google Drive: ID={}, URL={}", file_id, preview_url);

    Ok((file_id, preview_url))
}

/// Pauses an active Google Drive upload for a meeting.
#[tauri::command]
pub async fn api_google_drive_pause_upload<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<bool, String> {
    log_info!("⏸️ Pausing upload for meeting {}", meeting_id);
    let pool = state.db_manager.pool().clone();
    let mid = meeting_id.clone();

    let jobs = UPLOAD_JOBS.lock().await;
    if let Some(ctrl) = jobs.get(&meeting_id) {
        ctrl.is_paused.store(true, Ordering::SeqCst);
        let _ = MeetingsRepository::update_meeting_drive_info(&pool, &mid, None, None, "paused").await;
        let _ = app.emit(
            "meeting-upload-progress",
            UploadProgressPayload {
                meeting_id: meeting_id.clone(),
                progress: 0,
                status: "paused".to_string(),
                error: None,
                video_url: None,
                drive_file_id: None,
            },
        );
        Ok(true)
    } else {
        let _ = MeetingsRepository::update_meeting_drive_info(&pool, &mid, None, None, "paused").await;
        let _ = app.emit(
            "meeting-upload-progress",
            UploadProgressPayload {
                meeting_id: meeting_id.clone(),
                progress: 0,
                status: "paused".to_string(),
                error: None,
                video_url: None,
                drive_file_id: None,
            },
        );
        Ok(false)
    }
}

/// Resumes a paused Google Drive upload for a meeting.
#[tauri::command]
pub async fn api_google_drive_resume_upload<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    meeting_id: String,
    folder_path: String,
) -> Result<bool, String> {
    log_info!("▶️ Resuming upload for meeting {}", meeting_id);
    {
        let jobs = UPLOAD_JOBS.lock().await;
        if let Some(ctrl) = jobs.get(&meeting_id) {
            if ctrl.is_paused.load(Ordering::SeqCst) {
                ctrl.is_paused.store(false, Ordering::SeqCst);
                return Ok(true);
            }
        }
    }

    // If job was not in memory waiting, trigger background upload task
    let _ = api_start_background_media_processing_and_upload(app, state, meeting_id, folder_path).await?;
    Ok(true)
}

async fn find_meeting_recording_folder(meeting_id: &str) -> Option<PathBuf> {
    let base_dir = crate::audio::recording_preferences::get_default_recordings_folder_path().await.ok()?;
    let base_path = PathBuf::from(base_dir);
    if !base_path.exists() {
        return None;
    }

    let read_dir = std::fs::read_dir(&base_path).ok()?;
    let clean_id = meeting_id.trim_start_matches("meeting-").trim();

    let mut candidate_folders = Vec::new();

    for entry in read_dir.flatten() {
        let p = entry.path();
        if p.is_dir() {
            // Check metadata.json inside
            let meta_path = p.join("metadata.json");
            if meta_path.exists() {
                if let Ok(content) = std::fs::read_to_string(&meta_path) {
                    if content.contains(meeting_id) || (!clean_id.is_empty() && content.contains(clean_id)) {
                        return Some(p);
                    }
                }
            }

            // Check if folder name contains UUID
            let fname = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !clean_id.is_empty() && fname.contains(clean_id) {
                return Some(p);
            }

            // Check if directory has media files
            if p.join("meeting_video_merged.mp4").exists()
                || p.join("meeting_video.webm").exists()
                || p.join("audio.mp4").exists()
            {
                if let Ok(metadata) = entry.metadata() {
                    if let Ok(modified) = metadata.modified() {
                        candidate_folders.push((modified, p));
                    }
                }
            }
        }
    }

    // Sort by most recently modified first
    candidate_folders.sort_by(|a, b| b.0.cmp(&a.0));
    if let Some((_, path)) = candidate_folders.first() {
        return Some(path.clone());
    }

    None
}

/// Spawns background media processing (FFmpeg H.264+AAC merge) and parallel Google Drive upload.
/// Does not block caller, emits progress events to frontend.
#[tauri::command]
pub async fn api_start_background_media_processing_and_upload<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    meeting_id: String,
    folder_path: String,
) -> Result<String, String> {
    let app_handle = app.clone();
    let pool = state.db_manager.pool().clone();
    let meeting_id_clone = meeting_id.clone();
    let folder_path_clone = folder_path.clone();

    // Check meeting metadata: must have video and must be owned by current user (if user is logged in)
    let current_user_id = *state.current_user_id.read().await;
    let mut effective_user_id = current_user_id;
    if let Ok(Some(meta)) = MeetingsRepository::get_meeting_metadata(&pool, &meeting_id).await {
        if !meta.has_video {
            log_info!("Meeting {} does not have video recording. Skipping Drive upload.", meeting_id);
            return Err("Meeting does not have a video recording; audio-only meetings are not uploaded to Drive.".to_string());
        }
        if let (Some(curr_uid), Some(rec_uid)) = (current_user_id, meta.user_id) {
            if curr_uid != rec_uid {
                log_warn!("User {} attempted to upload meeting {} recorded by user {}", curr_uid, meeting_id, rec_uid);
                return Err("Only the user who recorded this meeting can upload it.".to_string());
            }
        }
        if meta.user_id.is_some() {
            effective_user_id = meta.user_id;
        }
    }
    let effective_user_id_str = effective_user_id.map(|u| u.to_string());

    // Create job control and register
    let job_ctrl = UploadJobControl {
        is_paused: Arc::new(AtomicBool::new(false)),
        is_cancelled: Arc::new(AtomicBool::new(false)),
    };
    {
        let mut jobs = UPLOAD_JOBS.lock().await;
        jobs.insert(meeting_id_clone.clone(), job_ctrl.clone());
    }

    tokio::spawn(async move {
        log_info!(
            "🚀 Starting background media processing & Google Drive upload for meeting {}",
            meeting_id_clone
        );

        let emit_update = |progress: u32, status: &str, error: Option<String>, video_url: Option<String>, drive_file_id: Option<String>| {
            let payload = UploadProgressPayload {
                meeting_id: meeting_id_clone.clone(),
                progress,
                status: status.to_string(),
                error,
                video_url,
                drive_file_id,
            };
            let _ = app_handle.emit("meeting-upload-progress", payload);
        };

        // Step 1: Video and Audio merge if necessary
        emit_update(10, "merging", None, None, None);

        // Resolve recording folder: direct param -> DB metadata -> recordings dir scan
        let mut effective_folder: Option<PathBuf> = None;
        if !folder_path_clone.trim().is_empty() {
            let p = PathBuf::from(&folder_path_clone);
            if p.exists() {
                effective_folder = Some(p);
            }
        }

        if effective_folder.is_none() {
            if let Ok(Some(meta)) = MeetingsRepository::get_meeting_metadata(&pool, &meeting_id_clone).await {
                if let Some(ref db_path) = meta.folder_path {
                    if !db_path.trim().is_empty() {
                        let p = PathBuf::from(db_path);
                        if p.exists() {
                            effective_folder = Some(p);
                        }
                    }
                }
            }
        }

        if effective_folder.is_none() {
            effective_folder = find_meeting_recording_folder(&meeting_id_clone).await;
        }

        let folder = match effective_folder {
            Some(f) => f,
            None => {
                log_error!("Could not resolve recording folder for meeting {}", meeting_id_clone);
                emit_update(0, "error", Some("Meeting recording folder not found on disk".to_string()), None, None);
                let _ = MeetingsRepository::update_meeting_drive_info(&pool, &meeting_id_clone, None, None, "failed").await;
                let mut jobs = UPLOAD_JOBS.lock().await;
                jobs.remove(&meeting_id_clone);
                return;
            }
        };

        let folder_str = folder.to_string_lossy().to_string();
        let merged_video_path = folder.join("meeting_video_merged.mp4");

        let video_target_path: PathBuf = if merged_video_path.exists() && merged_video_path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
            merged_video_path
        } else {
            // Attempt FFmpeg merge
            match crate::video::commands::api_merge_meeting_video_and_audio(folder_str.clone()).await {
                Ok(path_str) => PathBuf::from(path_str),
                Err(e) => {
                    log_warn!("Merge warning: {}. Checking for raw video files...", e);
                    let raw_webm = folder.join("meeting_video.webm");
                    let raw_mp4 = folder.join("meeting_video.mp4");
                    let rec_webm = folder.join("recording.webm");
                    let rec_mp4 = folder.join("recording.mp4");

                    if raw_webm.exists() {
                        raw_webm
                    } else if raw_mp4.exists() {
                        raw_mp4
                    } else if rec_webm.exists() {
                        rec_webm
                    } else if rec_mp4.exists() {
                        rec_mp4
                    } else {
                        log_info!("No video file found in folder {}. Skipping Drive upload as meeting is audio-only.", folder_str);
                        emit_update(0, "not_video", Some("Meeting is audio-only".to_string()), None, None);
                        let _ = MeetingsRepository::update_meeting_drive_info(&pool, &meeting_id_clone, None, None, "none").await;
                        let mut jobs = UPLOAD_JOBS.lock().await;
                        jobs.remove(&meeting_id_clone);
                        return;
                    }
                }
            }
        };

        emit_update(20, "checking_drive", None, None, None);

        // Step 2: Check Google Drive access for effective user
        let user_tokens = load_tokens(&app_handle, effective_user_id_str.as_deref(), None);
        let user_email_hint = user_tokens.as_ref().and_then(|t| t.user_email.clone());
        let access_token = match get_valid_access_token(&app_handle, effective_user_id_str.as_deref(), user_email_hint.as_deref()).await {
            Ok(token) => token,
            Err(e) => {
                log_info!("Google Drive not connected or expired ({}). Keeping local video.", e);
                emit_update(0, "not_connected", Some(e), None, None);
                let _ = MeetingsRepository::update_meeting_drive_info(&pool, &meeting_id_clone, None, None, "local_only").await;
                let mut jobs = UPLOAD_JOBS.lock().await;
                jobs.remove(&meeting_id_clone);
                return;
            }
        };

        // Step 3: Upload to Google Drive in chunks
        emit_update(25, "uploading", None, None, None);
        let app_handle_for_progress = app_handle.clone();
        let meeting_id_for_progress = meeting_id_clone.clone();

        let upload_result = upload_video_file_to_drive(
            &access_token,
            &video_target_path,
            &meeting_id_clone,
            job_ctrl,
            user_email_hint.as_deref(),
            move |pct, status| {
                let _ = app_handle_for_progress.emit(
                    "meeting-upload-progress",
                    UploadProgressPayload {
                        meeting_id: meeting_id_for_progress.clone(),
                        progress: pct,
                        status: status.to_string(),
                        error: None,
                        video_url: None,
                        drive_file_id: None,
                    },
                );
            },
        )
        .await;

        match upload_result {
            Ok((file_id, preview_url)) => {
                log_info!("🎉 Drive upload succeeded for meeting {}", meeting_id_clone);
                let _ = MeetingsRepository::update_meeting_drive_info(
                    &pool,
                    &meeting_id_clone,
                    Some(&preview_url),
                    Some(&file_id),
                    "completed",
                )
                .await;

                emit_update(100, "completed", None, Some(preview_url), Some(file_id));
            }
            Err(err) => {
                if err == "Upload cancelled" {
                    log_info!("Upload cancelled for meeting {}", meeting_id_clone);
                } else {
                    log_error!("❌ Drive upload failed for meeting {}: {}", meeting_id_clone, err);
                    let _ = MeetingsRepository::update_meeting_drive_info(
                        &pool,
                        &meeting_id_clone,
                        None,
                        None,
                        "failed",
                    )
                    .await;
                    emit_update(0, "error", Some(err), None, None);
                }
            }
        }

        // Clean up from active jobs
        let mut jobs = UPLOAD_JOBS.lock().await;
        jobs.remove(&meeting_id_clone);
    });

    Ok("Background media processing started".to_string())
}

/// Allows manually retrying or triggering upload to Google Drive for an existing meeting.
#[tauri::command]
pub async fn api_retry_meeting_drive_upload<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    meeting_id: String,
    folder_path: String,
) -> Result<String, String> {
    api_start_background_media_processing_and_upload(app, state, meeting_id, folder_path).await
}

/// Explicitly ensures or fixes public/domain share permissions on an existing Google Drive file.
#[tauri::command]
pub async fn api_google_drive_ensure_share_permission<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    drive_file_id: String,
) -> Result<String, String> {
    log_info!("🔑 Ensuring share permissions for Drive file: {}", drive_file_id);
    let (user_id, user_email) = resolve_user_context(&state, None).await;
    let tokens = load_tokens(&app, user_id.as_deref(), user_email.as_deref()).ok_or_else(|| "Google Drive is not connected on this device. Please connect Google Drive first.".to_string())?;
    let access_token = get_valid_access_token(&app, user_id.as_deref(), tokens.user_email.as_deref()).await?;
    let client = Client::new();
    set_file_share_permissions(&client, &access_token, &drive_file_id, tokens.user_email.as_deref()).await
}

/// Fetches a Google Drive video file for a meeting, caching it locally so it can be streamed
/// reliably via native HTML5 video player instead of restricted webview iframes.
#[tauri::command]
pub async fn api_fetch_and_cache_drive_video<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    meeting_id: String,
    drive_file_id: String,
) -> Result<String, String> {
    log_info!("📥 Fetching cloud video for meeting {} (Drive ID: {})", meeting_id, drive_file_id);

    // 1. Determine local cache folder
    let base_dir = crate::audio::recording_preferences::get_default_recordings_folder_path()
        .await
        .map_err(|e| format!("Failed to get recordings directory: {}", e))?;
    let cache_dir = PathBuf::from(base_dir).join("cloud_cache");
    if !cache_dir.exists() {
        let _ = tokio::fs::create_dir_all(&cache_dir).await;
    }

    let cache_file = cache_dir.join(format!("drive_{}.mp4", drive_file_id));
    if cache_file.exists() && cache_file.metadata().map(|m| m.len() > 1024).unwrap_or(false) {
        log_info!("⚡ Using existing cached cloud video: {:?}", cache_file);
        return Ok(cache_file.to_string_lossy().to_string());
    }

    // 2. Build HTTP client with reasonable timeout
    let client = Client::builder()
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    // 3. Attempt download
    // Strategy A: If Google Drive is authenticated on this machine, use official Drive API
    let (user_id, user_email) = resolve_user_context(&state, None).await;
    let token_res = get_valid_access_token(&app, user_id.as_deref(), user_email.as_deref()).await;
    let mut resp = None;

    if let Ok(ref token) = token_res {
        log_info!("Attempting authenticated Drive download for file {}...", drive_file_id);
        let api_url = format!(
            "https://www.googleapis.com/drive/v3/files/{}?alt=media&supportsAllDrives=true",
            drive_file_id
        );
        if let Ok(r) = client.get(&api_url).bearer_auth(token).send().await {
            if r.status().is_success() {
                resp = Some(r);
            } else {
                log_warn!("Authenticated Drive download returned status: {}", r.status());
            }
        }
    }

    // Strategy B: If no token or Strategy A returned non-200, try public direct download URLs
    if resp.is_none() {
        log_info!("Attempting public direct download for Drive file {}...", drive_file_id);
        let public_urls = [
            format!("https://drive.usercontent.google.com/download?id={}&export=download&confirm=t", drive_file_id),
            format!("https://drive.google.com/uc?export=download&id={}&confirm=t", drive_file_id),
        ];

        for p_url in &public_urls {
            match client.get(p_url).send().await {
                Ok(r) if r.status().is_success() => {
                    let content_type = r.headers()
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_lowercase();
                    // Avoid saving an HTML virus/login page as an MP4
                    if !content_type.contains("text/html") {
                        resp = Some(r);
                        break;
                    } else {
                        log_warn!("Public URL returned HTML instead of video content: {}", p_url);
                    }
                }
                Ok(r) => {
                    log_warn!("Public URL {} returned status {}", p_url, r.status());
                }
                Err(e) => {
                    log_warn!("Failed request to {}: {}", p_url, e);
                }
            }
        }
    }

    let mut response = resp.ok_or_else(|| {
        "Unable to stream video from Google Drive. Please ensure the video link is accessible or open it directly in Google Drive.".to_string()
    })?;

    // 4. Stream response chunks directly to disk
    let temp_file = cache_dir.join(format!("drive_{}.tmp", drive_file_id));
    let mut file = tokio::fs::File::create(&temp_file)
        .await
        .map_err(|e| format!("Failed to create temporary video file: {}", e))?;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Error downloading video stream chunk: {}", e))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Error writing video chunk to disk: {}", e))?;
    }

    file.flush()
        .await
        .map_err(|e| format!("Failed to flush video file: {}", e))?;
    drop(file);

    // Verify written file is non-empty
    let meta = tokio::fs::metadata(&temp_file)
        .await
        .map_err(|e| format!("Failed to read downloaded file metadata: {}", e))?;
    if meta.len() < 1024 {
        let _ = tokio::fs::remove_file(&temp_file).await;
        return Err("Downloaded file is invalid or too small to be a video".to_string());
    }

    tokio::fs::rename(&temp_file, &cache_file)
        .await
        .map_err(|e| format!("Failed to move cached video file: {}", e))?;

    log_info!("✅ Successfully downloaded and cached cloud video: {:?}", cache_file);
    Ok(cache_file.to_string_lossy().to_string())
}

