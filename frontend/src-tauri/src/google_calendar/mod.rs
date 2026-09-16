use log::info;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const REDIRECT_URI: &str = "http://localhost:3000/api/calendar/auth/callback";
const SCOPES: &str = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email";
const STORE_FILENAME: &str = "google_calendar.json";

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
pub struct GoogleCalendarTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<i64>,
    pub user_email: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GoogleCalendarStatus {
    pub is_connected: bool,
    pub email: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CalendarEventPayload {
    pub title: String,
    pub description: Option<String>,
    pub start_date_time: String,
    pub end_date_time: String,
    pub time_zone: Option<String>,
    pub attendees: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateEventResponse {
    pub success: bool,
    pub event_id: String,
    pub html_link: String,
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

/// Load tokens from the store
fn load_tokens<R: Runtime>(app: &AppHandle<R>) -> Option<GoogleCalendarTokens> {
    let store = app.store(STORE_FILENAME).ok()?;
    let val = store.get("tokens")?;
    serde_json::from_value::<GoogleCalendarTokens>(val).ok()
}

/// Save tokens to the store
fn save_tokens<R: Runtime>(app: &AppHandle<R>, tokens: &GoogleCalendarTokens) -> Result<(), String> {
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

/// Refresh the access token using refresh_token if expired or close to expiry
async fn get_valid_access_token<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    let mut tokens = load_tokens(app).ok_or_else(|| "Google Calendar is not connected".to_string())?;
    let now = current_timestamp_secs();

    // If token has at least 60 seconds before expiration, use it
    if let Some(expires_at) = tokens.expires_at {
        if expires_at > now + 60 && !tokens.access_token.is_empty() {
            return Ok(tokens.access_token);
        }
    }

    let refresh_token = tokens
        .refresh_token
        .as_ref()
        .ok_or_else(|| "No refresh token available; please reconnect Google Calendar".to_string())?;

    let client_id = get_client_id()?;
    let client_secret = get_client_secret()?;

    info!("Refreshing Google Calendar access token...");
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
pub async fn api_google_calendar_get_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<GoogleCalendarStatus, String> {
    if let Some(tokens) = load_tokens(&app) {
        if !tokens.access_token.is_empty() {
            return Ok(GoogleCalendarStatus {
                is_connected: true,
                email: tokens.user_email,
            });
        }
    }
    Ok(GoogleCalendarStatus {
        is_connected: false,
        email: None,
    })
}

#[tauri::command]
pub async fn api_google_calendar_disconnect<R: Runtime>(
    app: AppHandle<R>,
) -> Result<(), String> {
    if let Ok(store) = app.store(STORE_FILENAME) {
        store.delete("tokens");
        let _ = store.save();
    }
    info!("Google Calendar disconnected");
    Ok(())
}

#[tauri::command]
pub async fn api_google_calendar_start_auth<R: Runtime>(
    app: AppHandle<R>,
) -> Result<GoogleCalendarStatus, String> {
    let client_id = get_client_id()?;
    let client_secret = get_client_secret()?;

    info!("Starting Google Calendar OAuth flow on loopback port 3000...");

    // Bind to 127.0.0.1:3000 to catch http://localhost:3000/api/calendar/auth/callback
    let listener = TcpListener::bind("127.0.0.1:3000")
        .await
        .map_err(|e| format!("Port 3000 is currently occupied. Please ensure nothing is using port 3000: {}", e))?;

    let encoded_scopes: String = url::form_urlencoded::byte_serialize(SCOPES.as_bytes()).collect();
    let encoded_redirect: String = url::form_urlencoded::byte_serialize(REDIRECT_URI.as_bytes()).collect();
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent",
        client_id, encoded_redirect, encoded_scopes
    );

    // Open user's default browser to Google OAuth consent
    open_browser(&auth_url)?;

    // Wait for the redirect with a 2-minute timeout
    let timeout_duration = Duration::from_secs(120);
    let code = match tokio::time::timeout(timeout_duration, async {
        loop {
            let (mut socket, _) = listener.accept().await.map_err(|e| format!("Listener error: {}", e))?;
            let mut buf = [0u8; 4096];
            let n = socket.read(&mut buf).await.map_err(|e| format!("Read error: {}", e))?;
            let request = String::from_utf8_lossy(&buf[..n]);

            // Check if this is the callback request
            if request.starts_with("GET /api/calendar/auth/callback") {
                // Extract code from query string: ?code=...
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
    <title>Connected to CrestMeet</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f8fafc; }
        .card { background: white; padding: 40px; border-radius: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.06); text-align: center; max-width: 420px; border: 1px solid #e2e8f0; }
        .icon { width: 64px; height: 64px; background: #ecfdf5; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 32px; color: #10b981; }
        h2 { color: #0f172a; margin: 0 0 8px; font-size: 22px; font-weight: 700; }
        p { color: #64748b; font-size: 14px; line-height: 1.5; margin: 0 0 24px; }
        .badge { display: inline-block; background: #e0e7ff; color: #4338ca; padding: 6px 14px; border-radius: 9999px; font-size: 12px; font-weight: 600; }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">✓</div>
        <h2>Google Calendar Connected!</h2>
        <p>Your Google Calendar is successfully linked to CrestMeet. You can close this tab and return to the application.</p>
        <span class="badge">Safe to close</span>
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
                // Return 404 for other requests
                let not_found = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                let _ = socket.write_all(not_found.as_bytes()).await;
            }
        }
    })
    .await
    {
        Ok(res) => res?,
        Err(_) => return Err("Google Calendar authorization timed out. Please try again.".to_string()),
    };

    info!("Received authorization code. Exchanging for tokens...");
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

    // Fetch user email using access token
    let email_resp = client
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(&token_data.access_token)
        .send()
        .await;

    let user_email = match email_resp {
        Ok(r) if r.status().is_success() => r.json::<UserInfoResponse>().await.ok().and_then(|u| u.email),
        _ => None,
    };

    let tokens = GoogleCalendarTokens {
        access_token: token_data.access_token,
        refresh_token: token_data.refresh_token,
        expires_at: token_data.expires_in.map(|exp| now + exp),
        user_email: user_email.clone(),
    };

    save_tokens(&app, &tokens)?;
    info!("Google Calendar successfully connected for email: {:?}", user_email);

    Ok(GoogleCalendarStatus {
        is_connected: true,
        email: user_email,
    })
}

#[tauri::command]
pub async fn api_google_calendar_create_event<R: Runtime>(
    app: AppHandle<R>,
    payload: CalendarEventPayload,
) -> Result<CreateEventResponse, String> {
    let access_token = get_valid_access_token(&app).await?;
    let client = Client::new();

    let mut body = serde_json::json!({
        "summary": payload.title,
        "description": payload.description.unwrap_or_default(),
        "start": {
            "dateTime": payload.start_date_time,
            "timeZone": payload.time_zone.as_deref().unwrap_or("UTC")
        },
        "end": {
            "dateTime": payload.end_date_time,
            "timeZone": payload.time_zone.as_deref().unwrap_or("UTC")
        }
    });

    if let Some(attendees) = payload.attendees {
        if !attendees.is_empty() {
            let attendees_arr: Vec<serde_json::Value> = attendees
                .into_iter()
                .filter(|e| !e.trim().is_empty())
                .map(|email| serde_json::json!({ "email": email.trim() }))
                .collect();
            body["attendees"] = serde_json::Value::Array(attendees_arr);
        }
    }

    info!("Creating Google Calendar event: {}", payload.title);
    let resp = client
        .post("https://www.googleapis.com/calendar/v3/calendars/primary/events")
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error connecting to Google Calendar: {}", e))?;

    if !resp.status().is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        return Err(format!("Google Calendar API error: {}", err_text));
    }

    let event_json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Google Calendar event response: {}", e))?;

    let event_id = event_json["id"].as_str().unwrap_or_default().to_string();
    let html_link = event_json["htmlLink"].as_str().unwrap_or_default().to_string();

    info!("Created event {} successfully: {}", event_id, html_link);

    Ok(CreateEventResponse {
        success: true,
        event_id,
        html_link,
    })
}
