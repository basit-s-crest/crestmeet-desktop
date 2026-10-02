use log::{error as log_error, info as log_info, warn as log_warn};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_store::StoreExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::database::repositories::meeting::MeetingsRepository;
use crate::state::AppState;

const REDIRECT_URI: &str = "http://localhost:3000/api/calendar/auth/callback";
const SCOPES: &str = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email";
const STORE_FILENAME: &str = "google_drive.json";

fn get_env_var(key: &str) -> Option<String> {
    if let Ok(val) = std::env::var(key) {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
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
    None
}

fn get_client_id() -> Result<String, String> {
    get_env_var("GOOGLE_CLIENT_ID")
        .or_else(|| option_env!("GOOGLE_CLIENT_ID").map(String::from))
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Google OAuth Client ID is not configured. Please set GOOGLE_CLIENT_ID in your environment or .env file.".to_string())
}

fn get_client_secret() -> Result<String, String> {
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
    pub status: String, // "idle", "merging", "uploading", "completed", "error", "not_connected"
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

fn load_tokens<R: Runtime>(app: &AppHandle<R>) -> Option<GoogleDriveTokens> {
    let store = app.store(STORE_FILENAME).ok()?;
    let val = store.get("tokens")?;
    serde_json::from_value::<GoogleDriveTokens>(val).ok()
}

fn save_tokens<R: Runtime>(app: &AppHandle<R>, tokens: &GoogleDriveTokens) -> Result<(), String> {
    let store = app
        .store(STORE_FILENAME)
        .map_err(|e| format!("Failed to open store: {}", e))?;
    let val = serde_json::to_value(tokens).map_err(|e| format!("Failed to serialize tokens: {}", e))?;
    store.set("tokens", val);
    store
        .save()
        .map_err(|e| format!("Failed to save store to disk: {}", e))?;
    Ok(())
}

async fn get_valid_access_token<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    let mut tokens = load_tokens(app).ok_or_else(|| "Google Drive is not connected".to_string())?;
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

    let client_id = get_client_id()?;
    let client_secret = get_client_secret()?;

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

    save_tokens(app, &tokens)?;
    Ok(tokens.access_token)
}

#[tauri::command]
pub async fn api_google_drive_get_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<GoogleDriveStatus, String> {
    if let Some(tokens) = load_tokens(&app) {
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
) -> Result<(), String> {
    if let Ok(store) = app.store(STORE_FILENAME) {
        store.delete("tokens");
        let _ = store.save();
    }
    log_info!("Google Drive disconnected");
    Ok(())
}

#[tauri::command]
pub async fn api_google_drive_start_auth<R: Runtime>(
    app: AppHandle<R>,
) -> Result<GoogleDriveStatus, String> {
    let client_id = get_client_id()?;
    let client_secret = get_client_secret()?;

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

    save_tokens(&app, &tokens)?;
    log_info!("Google Drive successfully connected for email: {:?}", user_email);

    Ok(GoogleDriveStatus {
        is_connected: true,
        email: user_email,
    })
}

/// Uploads a local video file to Google Drive using resumable upload in 5MB chunks.
/// Sets reader permission so team members can stream via preview URL.
async fn upload_video_file_to_drive<F>(
    access_token: &str,
    file_path: &Path,
    meeting_id: &str,
    mut on_progress: F,
) -> Result<(String, String), String>
where
    F: FnMut(u32),
{
    let metadata = tokio::fs::metadata(file_path)
        .await
        .map_err(|e| format!("Failed to read video metadata: {}", e))?;
    let file_size = metadata.len();
    if file_size == 0 {
        return Err("Video file is empty (0 bytes)".to_string());
    }

    let client = Client::new();

    let init_resp = client
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable")
        .bearer_auth(access_token)
        .header("X-Upload-Content-Type", "video/mp4")
        .header("X-Upload-Content-Length", file_size.to_string())
        .json(&serde_json::json!({
            "name": format!("CrestMeet_Meeting_{}.mp4", meeting_id),
            "description": "Recorded with CrestMeet AI Meeting Assistant"
        }))
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
        on_progress(percent);

        if put_resp.status().is_success() {
            let resp_json: serde_json::Value = put_resp.json().await.unwrap_or_default();
            if let Some(id) = resp_json.get("id").and_then(|v| v.as_str()) {
                drive_file_id = Some(id.to_string());
            }
        }
    }

    let file_id = drive_file_id.ok_or_else(|| "Drive upload finished but no file ID was returned".to_string())?;

    // Set permission to anyone with link as reader
    let perm_resp = client
        .post(format!("https://www.googleapis.com/drive/v3/files/{}/permissions", file_id))
        .bearer_auth(access_token)
        .json(&serde_json::json!({
            "role": "reader",
            "type": "anyone"
        }))
        .send()
        .await;

    if let Err(e) = perm_resp {
        log_warn!("Could not set public reader permission on Drive file {}: {}", file_id, e);
    }

    let preview_url = format!("https://drive.google.com/file/d/{}/preview", file_id);
    log_info!("✅ Successfully uploaded to Google Drive: ID={}, URL={}", file_id, preview_url);

    Ok((file_id, preview_url))
}

/// Spawns background media processing (FFmpeg merge) and parallel Google Drive upload.
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
        let folder = PathBuf::from(&folder_path_clone);
        let merged_video_path = folder.join("meeting_video_merged.mp4");

        let video_target_path: PathBuf = if merged_video_path.exists() {
            merged_video_path
        } else {
            // Attempt FFmpeg merge
            match crate::video::commands::api_merge_meeting_video_and_audio(folder_path_clone.clone()).await {
                Ok(path_str) => PathBuf::from(path_str),
                Err(e) => {
                    log_warn!("Merge warning: {}. Checking for raw webm...", e);
                    let raw_webm = folder.join("meeting_video.webm");
                    if raw_webm.exists() {
                        raw_webm
                    } else {
                        log_error!("No video file found in folder {}", folder_path_clone);
                        emit_update(0, "error", Some("No video file found".to_string()), None, None);
                        let _ = MeetingsRepository::update_meeting_drive_info(&pool, &meeting_id_clone, None, None, "failed").await;
                        return;
                    }
                }
            }
        };

        emit_update(20, "checking_drive", None, None, None);

        // Step 2: Check Google Drive access
        let access_token = match get_valid_access_token(&app_handle).await {
            Ok(token) => token,
            Err(e) => {
                log_info!("Google Drive not connected or expired ({}). Keeping local video.", e);
                emit_update(0, "not_connected", Some(e), None, None);
                let _ = MeetingsRepository::update_meeting_drive_info(&pool, &meeting_id_clone, None, None, "local_only").await;
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
            move |pct| {
                let _ = app_handle_for_progress.emit(
                    "meeting-upload-progress",
                    UploadProgressPayload {
                        meeting_id: meeting_id_for_progress.clone(),
                        progress: pct,
                        status: "uploading".to_string(),
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
