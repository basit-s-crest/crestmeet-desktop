use crate::state::AppState;
use log::{error, info, warn};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuthUser {
    pub id: String,
    pub email: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthResponse {
    pub success: bool,
    pub user: Option<AuthUser>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EmailCheckResponse {
    pub exists: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OtpResponse {
    pub success: bool,
    pub message: String,
    pub error: Option<String>,
}



#[tauri::command]
pub async fn auth_signup(
    state: State<'_, AppState>,
    email: String,
    password: String,
) -> Result<AuthResponse, String> {
    let email = email.trim().to_lowercase();
    if email.is_empty() {
        return Ok(AuthResponse {
            success: false,
            user: None,
            error: Some("Email address is required".to_string()),
        });
    }

    if password.len() < 6 {
        return Ok(AuthResponse {
            success: false,
            user: None,
            error: Some("Password must be at least 6 characters".to_string()),
        });
    }

    let pool = state.db_manager.pool();

    // Check if user already exists in auth.users
    let existing: Result<Option<(Uuid,)>, sqlx::Error> =
        sqlx::query_as("SELECT id FROM auth.users WHERE LOWER(email) = LOWER($1)")
            .bind(&email)
            .fetch_optional(pool)
            .await;

    match existing {
        Ok(Some(_)) => {
            return Ok(AuthResponse {
                success: false,
                user: None,
                error: Some("An account with this email already exists".to_string()),
            });
        }
        Err(e) => {
            error!("Failed to check existing user: {}", e);
            return Ok(AuthResponse {
                success: false,
                user: None,
                error: Some(format!("Database error: {}", e)),
            });
        }
        Ok(None) => {}
    }

    // Insert user into Supabase auth.users directly
    let insert_result: Result<(Uuid, String), sqlx::Error> = sqlx::query_as(
        r#"
        INSERT INTO auth.users (
            instance_id,
            id,
            aud,
            role,
            email,
            encrypted_password,
            email_confirmed_at,
            raw_app_meta_data,
            raw_user_meta_data,
            created_at,
            updated_at
        )
        VALUES (
            '00000000-0000-0000-0000-000000000000',
            gen_random_uuid(),
            'authenticated',
            'authenticated',
            $1,
            crypt($2, gen_salt('bf', 10)),
            NOW(),
            '{"provider":"email","providers":["email"]}'::jsonb,
            '{}'::jsonb,
            NOW(),
            NOW()
        )
        RETURNING id, email
        "#
    )
    .bind(&email)
    .bind(&password)
    .fetch_one(pool)
    .await;

    match insert_result {
        Ok((user_id, user_email)) => {
            // Also register in auth.identities for full Supabase Dashboard compatibility
            let _ = sqlx::query(
                r#"
                INSERT INTO auth.identities (
                    id,
                    user_id,
                    identity_data,
                    provider,
                    last_sign_in_at,
                    created_at,
                    updated_at
                )
                VALUES (
                    $1::text,
                    $1,
                    json_build_object('sub', $1::text, 'email', $2)::jsonb,
                    'email',
                    NOW(),
                    NOW(),
                    NOW()
                )
                ON CONFLICT DO NOTHING
                "#
            )
            .bind(user_id)
            .bind(&user_email)
            .execute(pool)
            .await;

            // Also register in app_users table to satisfy foreign keys
            let _ = sqlx::query(
                r#"
                INSERT INTO app_users (id, email, password_hash, created_at, updated_at)
                VALUES ($1, $2, crypt($3, gen_salt('bf', 10)), NOW(), NOW())
                ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
                "#
            )
            .bind(user_id)
            .bind(&user_email)
            .bind(&password)
            .execute(pool)
            .await;

            let mut current = state.current_user_id.write().await;
            *current = Some(user_id);
            info!("✅ Successfully registered user in auth.users and app_users: {}", user_email);

            Ok(AuthResponse {
                success: true,
                user: Some(AuthUser {
                    id: user_id.to_string(),
                    email: user_email,
                }),
                error: None,
            })
        }
        Err(e) => {
            error!("Failed to register user in auth.users: {}", e);
            // Fallback: try inserting into app_users if auth.users is unavailable or restricted
            let fallback_result: Result<(Uuid, String), sqlx::Error> = sqlx::query_as(
                r#"
                INSERT INTO app_users (id, email, password_hash, created_at, updated_at)
                VALUES (gen_random_uuid(), $1, crypt($2, gen_salt('bf', 10)), NOW(), NOW())
                RETURNING id, email
                "#
            )
            .bind(&email)
            .bind(&password)
            .fetch_one(pool)
            .await;

            match fallback_result {
                Ok((user_id, user_email)) => {
                    let mut current = state.current_user_id.write().await;
                    *current = Some(user_id);
                    info!("✅ Successfully registered user in app_users: {}", user_email);
                    Ok(AuthResponse {
                        success: true,
                        user: Some(AuthUser {
                            id: user_id.to_string(),
                            email: user_email,
                        }),
                        error: None,
                    })
                }
                Err(fb_err) => {
                    error!("Fallback registration also failed: {}", fb_err);
                    Ok(AuthResponse {
                        success: false,
                        user: None,
                        error: Some(format!("Registration failed: {}", e)),
                    })
                }
            }
        }
    }
}

#[tauri::command]
pub async fn auth_login(
    state: State<'_, AppState>,
    email: String,
    password: String,
) -> Result<AuthResponse, String> {
    let email = email.trim().to_lowercase();
    if email.is_empty() {
        return Ok(AuthResponse {
            success: false,
            user: None,
            error: Some("Email address is required".to_string()),
        });
    }

    let pool = state.db_manager.pool();

    // Step 1: Look for user by email across app_users (primary) and auth.users
    let app_user: Option<(Uuid, String, String)> = sqlx::query_as(
        r#"
        SELECT id, email, password_hash
        FROM app_users
        WHERE LOWER(TRIM(email)) = $1
        LIMIT 1
        "#
    )
    .bind(&email)
    .fetch_optional(pool)
    .await
    .unwrap_or(None);

    let auth_user: Option<(Uuid, String, Option<String>)> = sqlx::query_as(
        r#"
        SELECT id, email, encrypted_password
        FROM auth.users
        WHERE LOWER(TRIM(email)) = $1
        LIMIT 1
        "#
    )
    .bind(&email)
    .fetch_optional(pool)
    .await
    .unwrap_or(None);

    // If account does NOT exist anywhere, return email-not-found error
    if app_user.is_none() && auth_user.is_none() {
        info!("Login attempt failed: No account found for email '{}'", email);
        return Ok(AuthResponse {
            success: false,
            user: None,
            error: Some("No account found with this email. Please check your email or create an account first.".to_string()),
        });
    }

    // Step 2: Validate password against available password hash
    let mut password_valid = false;

    if let Some((_, _, ref app_hash)) = app_user {
        if !app_hash.trim().is_empty() {
            password_valid = sqlx::query_scalar::<_, bool>("SELECT ($1 = crypt($2, $1))")
                .bind(app_hash)
                .bind(&password)
                .fetch_one(pool)
                .await
                .unwrap_or(false);
        }
    }

    if !password_valid {
        if let Some((_, _, Some(ref auth_hash))) = auth_user {
            if !auth_hash.trim().is_empty() {
                password_valid = sqlx::query_scalar::<_, bool>("SELECT ($1 = crypt($2, $1))")
                    .bind(auth_hash)
                    .bind(&password)
                    .fetch_one(pool)
                    .await
                    .unwrap_or(false);
            }
        }
    }

    if !password_valid {
        info!("Login attempt failed: Incorrect password for email '{}'", email);
        return Ok(AuthResponse {
            success: false,
            user: None,
            error: Some("Incorrect password. Please try again or reset your password.".to_string()),
        });
    }

    // Step 3: Password valid! Determine canonical user ID.
    // CRITICAL: We MUST prioritize app_users ID because project_members, projects, meetings,
    // and all foreign keys in the app point to app_users(id).
    let (user_id, user_email) = match (app_user, auth_user) {
        (Some((app_id, uemail, _)), _) => (app_id, uemail),
        (None, Some((auth_id, uemail, _))) => {
            // User exists only in auth.users; sync into app_users with the same ID
            let _ = sqlx::query(
                r#"
                INSERT INTO app_users (id, email, password_hash, created_at, updated_at)
                VALUES ($1, $2, crypt($3, gen_salt('bf', 10)), NOW(), NOW())
                ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email
                "#
            )
            .bind(auth_id)
            .bind(&uemail)
            .bind(&password)
            .execute(pool)
            .await;
            (auth_id, uemail)
        }
        (None, None) => unreachable!(),
    };

    // Reset active project ID in memory so a previously logged-in user's active project is never leaked
    {
        let mut active = state.active_project_id.write().await;
        *active = None;
    }

    let mut current = state.current_user_id.write().await;
    *current = Some(user_id);
    info!("✅ Successfully logged in user: {}", user_email);

    Ok(AuthResponse {
        success: true,
        user: Some(AuthUser {
            id: user_id.to_string(),
            email: user_email,
        }),
        error: None,
    })
}

#[tauri::command]
pub async fn auth_logout(state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut current = state.current_user_id.write().await;
        *current = None;
    }
    {
        let mut active = state.active_project_id.write().await;
        *active = None;
    }
    info!("🔓 User logged out");
    Ok(())
}

#[tauri::command]
pub async fn auth_restore_session(
    state: State<'_, AppState>,
    user_id: String,
) -> Result<Option<AuthUser>, String> {
    info!("🔄 auth_restore_session invoked for user_id: {}", user_id);
    let parsed_uuid = match Uuid::from_str(&user_id) {
        Ok(u) => u,
        Err(_) => {
            warn!("Failed to parse UUID for restore: {}", user_id);
            return Ok(None);
        }
    };

    let pool = state.db_manager.pool();

    // Check app_users table FIRST (primary table in public schema)
    let app_res: Result<Option<(Uuid, String)>, sqlx::Error> =
        sqlx::query_as("SELECT id, email FROM app_users WHERE id = $1")
            .bind(parsed_uuid)
            .fetch_optional(pool)
            .await;

    if let Ok(Some((uid, email))) = app_res {
        let mut current = state.current_user_id.write().await;
        *current = Some(uid);
        info!("🔄 Restored user session from app_users: {}", email);
        return Ok(Some(AuthUser {
            id: uid.to_string(),
            email,
        }));
    }

    // Fallback: check auth.users table
    let user_result: Result<Option<(Uuid, String)>, sqlx::Error> =
        sqlx::query_as("SELECT id, email FROM auth.users WHERE id = $1")
            .bind(parsed_uuid)
            .fetch_optional(pool)
            .await;

    match user_result {
        Ok(Some((uid, email))) => {
            // Check if app_users already has a record for this email
            let existing_app_id: Option<Uuid> = sqlx::query_scalar(
                "SELECT id FROM app_users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) LIMIT 1"
            )
            .bind(&email)
            .fetch_optional(pool)
            .await
            .unwrap_or(None);

            let canonical_id = if let Some(aid) = existing_app_id {
                aid
            } else {
                let _ = sqlx::query(
                    "INSERT INTO app_users (id, email, password_hash, created_at, updated_at) VALUES ($1, $2, 'synced', NOW(), NOW()) ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email"
                )
                .bind(uid)
                .bind(&email)
                .execute(pool)
                .await;
                uid
            };

            let mut current = state.current_user_id.write().await;
            *current = Some(canonical_id);
            info!("🔄 Restored user session for: {}", email);

            Ok(Some(AuthUser {
                id: canonical_id.to_string(),
                email,
            }))
        }
        _ => {
            info!("ℹ️ No active user found for session id: {}", user_id);
            Ok(None)
        }
    }
}

#[tauri::command]
pub async fn set_active_user(
    state: State<'_, AppState>,
    user_id: String,
) -> Result<(), String> {
    match Uuid::from_str(&user_id) {
        Ok(parsed_uuid) => {
            let mut current = state.current_user_id.write().await;
            *current = Some(parsed_uuid);
            info!("🔒 Active authenticated user set: {}", parsed_uuid);
            Ok(())
        }
        Err(e) => {
            warn!("Failed to parse user_id UUID '{}': {}", user_id, e);
            Err(format!("Invalid UUID format: {}", e))
        }
    }
}

#[tauri::command]
pub async fn clear_active_user(
    state: State<'_, AppState>,
) -> Result<(), String> {
    auth_logout(state).await
}

#[tauri::command]
pub async fn get_active_user(
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let current = state.current_user_id.read().await;
    Ok(current.map(|u| u.to_string()))
}

#[tauri::command]
pub async fn auth_check_email_exists(
    state: State<'_, AppState>,
    email: String,
) -> Result<EmailCheckResponse, String> {
    let email = email.trim().to_lowercase();
    if email.is_empty() {
        return Ok(EmailCheckResponse {
            exists: false,
            error: Some("Email address is required".to_string()),
        });
    }

    let pool = state.db_manager.pool();

    // 1. Check app_users table first
    let app_res: Result<Option<(Uuid,)>, sqlx::Error> =
        sqlx::query_as("SELECT id FROM app_users WHERE LOWER(email) = LOWER($1)")
            .bind(&email)
            .fetch_optional(pool)
            .await;

    if let Ok(Some(_)) = app_res {
        info!("🔍 auth_check_email_exists: found email in app_users: {}", email);
        return Ok(EmailCheckResponse {
            exists: true,
            error: None,
        });
    }

    // 2. Check auth.users table
    let auth_res: Result<Option<(Uuid,)>, sqlx::Error> =
        sqlx::query_as("SELECT id FROM auth.users WHERE LOWER(email) = LOWER($1)")
            .bind(&email)
            .fetch_optional(pool)
            .await;

    match auth_res {
        Ok(Some(_)) => {
            info!("🔍 auth_check_email_exists: found email in auth.users: {}", email);
            Ok(EmailCheckResponse {
                exists: true,
                error: None,
            })
        }
        Ok(None) => {
            info!("🔍 auth_check_email_exists: email not found: {}", email);
            Ok(EmailCheckResponse {
                exists: false,
                error: None,
            })
        }
        Err(e) => {
            // If app_users check also was None or errored, return error details
            error!("Database error checking email existence for {}: {}", email, e);
            // If app_res was Ok(None), we can safely say it's not in app_users;
            // but auth.users had an error, fallback to false
            Ok(EmailCheckResponse {
                exists: false,
                error: Some(format!("Database error checking email: {}", e)),
            })
        }
    }
}

#[tauri::command]
pub async fn auth_reset_password(
    state: State<'_, AppState>,
    email: String,
    new_password: String,
) -> Result<AuthResponse, String> {
    let email = email.trim().to_lowercase();
    if email.is_empty() {
        return Ok(AuthResponse {
            success: false,
            user: None,
            error: Some("Email address is required".to_string()),
        });
    }

    if new_password.len() < 6 {
        return Ok(AuthResponse {
            success: false,
            user: None,
            error: Some("Password must be at least 6 characters long".to_string()),
        });
    }

    let pool = state.db_manager.pool();

    // Verify user exists before attempting reset
    let check = auth_check_email_exists(state.clone(), email.clone()).await?;
    if !check.exists {
        return Ok(AuthResponse {
            success: false,
            user: None,
            error: Some("No account found with this email address".to_string()),
        });
    }

    // Update app_users table with newly crypt-hashed password
    let app_update: Result<Option<(Uuid, String)>, sqlx::Error> = sqlx::query_as(
        r#"
        UPDATE app_users
        SET password_hash = crypt($2, gen_salt('bf', 10)),
            updated_at = NOW()
        WHERE LOWER(email) = LOWER($1)
        RETURNING id, email
        "#
    )
    .bind(&email)
    .bind(&new_password)
    .fetch_optional(pool)
    .await;

    // Update auth.users table
    let auth_update = sqlx::query(
        r#"
        UPDATE auth.users
        SET encrypted_password = crypt($2, gen_salt('bf', 10)),
            updated_at = NOW()
        WHERE LOWER(email) = LOWER($1)
        "#
    )
    .bind(&email)
    .bind(&new_password)
    .execute(pool)
    .await;

    if let Err(e) = &auth_update {
        warn!("Note: updating auth.users password encountered: {}", e);
    }

    match app_update {
        Ok(Some((user_id, user_email))) => {
            info!("🔑 Password reset successfully in app_users for: {}", user_email);
            Ok(AuthResponse {
                success: true,
                user: Some(AuthUser {
                    id: user_id.to_string(),
                    email: user_email,
                }),
                error: None,
            })
        }
        Ok(None) => {
            // If app_users didn't have the record but auth.users succeeded, sync into app_users
            if auth_update.is_ok() {
                info!("🔑 Password reset in auth.users, ensuring synced into app_users for: {}", email);
                let _ = sqlx::query(
                    r#"
                    INSERT INTO app_users (id, email, password_hash, created_at, updated_at)
                    VALUES (gen_random_uuid(), $1, crypt($2, gen_salt('bf', 10)), NOW(), NOW())
                    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()
                    "#
                )
                .bind(&email)
                .bind(&new_password)
                .execute(pool)
                .await;

                Ok(AuthResponse {
                    success: true,
                    user: None,
                    error: None,
                })
            } else {
                Ok(AuthResponse {
                    success: false,
                    user: None,
                    error: Some("Unable to reset password for this email".to_string()),
                })
            }
        }
        Err(e) => {
            error!("Database error during password reset: {}", e);
            Ok(AuthResponse {
                success: false,
                user: None,
                error: Some(format!("Database error during reset: {}", e)),
            })
        }
    }
}

fn get_resend_api_key() -> Option<String> {
    // 1. Process environment variable
    if let Ok(k) = std::env::var("RESEND_API_KEY") {
        let trimmed = k.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }

    // 2. Read from .env files on disk (both relative to cwd and relative to src-tauri)
    let candidates = [
        std::path::PathBuf::from("frontend/.env"),
        std::path::PathBuf::from(".env"),
        std::path::PathBuf::from("../.env"),
        std::path::PathBuf::from("../frontend/.env"),
        std::path::PathBuf::from("../../frontend/.env"),
    ];

    for path in &candidates {
        if let Ok(contents) = std::fs::read_to_string(path) {
            for line in contents.lines() {
                let trimmed = line.trim();
                if let Some(rest) = trimmed.strip_prefix("RESEND_API_KEY=") {
                    let key = rest.trim().trim_matches('"').trim_matches('\'').to_string();
                    if !key.is_empty() {
                        return Some(key);
                    }
                }
            }
        }
    }

    None
}

fn get_resend_from_email() -> String {
    if let Ok(f) = std::env::var("RESEND_FROM_EMAIL") {
        let trimmed = f.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }

    let candidates = [
        std::path::PathBuf::from("frontend/.env"),
        std::path::PathBuf::from(".env"),
        std::path::PathBuf::from("../.env"),
        std::path::PathBuf::from("../frontend/.env"),
    ];

    for path in &candidates {
        if let Ok(contents) = std::fs::read_to_string(path) {
            for line in contents.lines() {
                let trimmed = line.trim();
                if let Some(rest) = trimmed.strip_prefix("RESEND_FROM_EMAIL=") {
                    let from = rest.trim().trim_matches('"').trim_matches('\'').to_string();
                    if !from.is_empty() {
                        return from;
                    }
                }
            }
        }
    }

    "CrestMeet <onboarding@resend.dev>".to_string()
}

async fn send_otp_email(email: &str, otp: &str) -> Result<(), String> {
    let api_key = match get_resend_api_key() {
        Some(k) => k,
        None => {
            let err = "RESEND_API_KEY not found in frontend/.env or environment".to_string();
            error!("❌ {}", err);
            return Err(err);
        }
    };

    let from_email = get_resend_from_email();
    info!("📧 [Password Reset OTP] Sending email to {} via Resend from {}", email, from_email);

    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "from": from_email,
        "to": [email],
        "subject": format!("Your CrestMeet Password Reset Code: {}", otp),
        "html": format!(
            "<div style='font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px; background-color: #ffffff;'>\
                <div style='margin-bottom: 20px; font-weight: bold; font-size: 18px; color: #111827;'>CrestMeet</div>\
                <h2 style='color: #111827; font-size: 20px; font-weight: 600; margin-bottom: 8px;'>Reset Your Password</h2>\
                <p style='color: #4b5563; font-size: 14px; line-height: 1.5;'>We received a request to reset the password for your CrestMeet account. Use the 6-digit verification code below:</p>\
                <div style='background-color: #f3f4f6; border-radius: 8px; padding: 16px; text-align: center; margin: 24px 0;'>\
                    <span style='font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #111827;'>{}</span>\
                </div>\
                <p style='color: #6b7280; font-size: 12px; line-height: 1.5;'>This verification code will expire in 10 minutes. If you did not request this password reset, please ignore this email.</p>\
            </div>",
            otp
        )
    });

    match client.post("https://api.resend.com/emails")
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            if status.is_success() {
                info!("✅ Password reset OTP email successfully sent via Resend to {}: {}", email, body);
                Ok(())
            } else {
                error!("❌ Resend API returned error (HTTP {}): {}", status, body);
                Err(format!("Resend email delivery failed: {}", body))
            }
        }
        Err(e) => {
            error!("❌ Network error calling Resend API: {}", e);
            Err(format!("Network error sending email: {}", e))
        }
    }
}

#[tauri::command]
pub async fn auth_request_reset_otp(
    state: State<'_, AppState>,
    email: String,
) -> Result<OtpResponse, String> {
    let email = email.trim().to_lowercase();
    if email.is_empty() {
        return Ok(OtpResponse {
            success: false,
            message: String::new(),
            error: Some("Email address is required".to_string()),
        });
    }

    let pool = state.db_manager.pool();

    // Check if email exists in either app_users or auth.users
    let email_exists = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM (
            SELECT id FROM app_users WHERE LOWER(email) = LOWER($1)
            UNION ALL
            SELECT id FROM auth.users WHERE LOWER(email) = LOWER($1)
        ) t"
    )
    .bind(&email)
    .fetch_one(pool)
    .await
    .unwrap_or(0);

    if email_exists == 0 {
        return Ok(OtpResponse {
            success: false,
            message: String::new(),
            error: Some("Email not found in our records. Please sign up first.".to_string()),
        });
    }

    // Generate secure 6-digit OTP code
    let otp: String = format!("{:06}", rand::thread_rng().gen_range(100_000..=999_999));

    // Invalidate previous unused OTPs for this email
    let _ = sqlx::query(
        "UPDATE password_reset_otps SET used = true WHERE LOWER(email) = LOWER($1) AND used = false"
    )
    .bind(&email)
    .execute(pool)
    .await;

    // Store new OTP with 10-minute expiry
    let insert_res = sqlx::query(
        r#"
        INSERT INTO password_reset_otps (email, otp_code, expires_at, used, created_at)
        VALUES ($1, $2, NOW() + INTERVAL '10 minutes', false, NOW())
        "#
    )
    .bind(&email)
    .bind(&otp)
    .execute(pool)
    .await;

    if let Err(e) = insert_res {
        error!("Failed to store password reset OTP: {}", e);
        return Ok(OtpResponse {
            success: false,
            message: String::new(),
            error: Some(format!("Database error: {}", e)),
        });
    }

    // Dispatch email to the user's inbox
    if let Err(e) = send_otp_email(&email, &otp).await {
        return Ok(OtpResponse {
            success: false,
            message: String::new(),
            error: Some(format!("Failed to send email: {}", e)),
        });
    }

    Ok(OtpResponse {
        success: true,
        message: format!("A 6-digit verification code has been sent to {}", email),
        error: None,
    })
}


#[tauri::command]
pub async fn auth_verify_and_reset_password(
    state: State<'_, AppState>,
    email: String,
    otp: String,
    new_password: String,
) -> Result<AuthResponse, String> {
    let email = email.trim().to_lowercase();
    let otp = otp.trim();

    if email.is_empty() {
        return Ok(AuthResponse {
            success: false,
            user: None,
            error: Some("Email address is required".to_string()),
        });
    }

    if otp.is_empty() {
        return Ok(AuthResponse {
            success: false,
            user: None,
            error: Some("Please enter the 6-digit verification code sent to your email".to_string()),
        });
    }

    if new_password.len() < 6 {
        return Ok(AuthResponse {
            success: false,
            user: None,
            error: Some("Password must be at least 6 characters long".to_string()),
        });
    }

    let pool = state.db_manager.pool();

    // Verify valid, unexpired, unused OTP
    let otp_record: Result<Option<(Uuid,)>, sqlx::Error> = sqlx::query_as(
        r#"
        SELECT id FROM password_reset_otps
        WHERE LOWER(email) = LOWER($1)
          AND otp_code = $2
          AND used = false
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
        "#
    )
    .bind(&email)
    .bind(otp)
    .fetch_optional(pool)
    .await;

    let otp_id = match otp_record {
        Ok(Some((id,))) => id,
        Ok(None) => {
            return Ok(AuthResponse {
                success: false,
                user: None,
                error: Some("Invalid or expired verification code. Please request a new one.".to_string()),
            });
        }
        Err(e) => {
            error!("Database error checking OTP: {}", e);
            return Ok(AuthResponse {
                success: false,
                user: None,
                error: Some(format!("Database error: {}", e)),
            });
        }
    };

    // Mark OTP as used immediately to prevent replay
    let _ = sqlx::query("UPDATE password_reset_otps SET used = true WHERE id = $1")
        .bind(otp_id)
        .execute(pool)
        .await;

    // Update app_users
    let app_update: Result<Option<(Uuid, String)>, sqlx::Error> = sqlx::query_as(
        r#"
        UPDATE app_users
        SET password_hash = crypt($2, gen_salt('bf', 10)),
            updated_at = NOW()
        WHERE LOWER(email) = LOWER($1)
        RETURNING id, email
        "#
    )
    .bind(&email)
    .bind(&new_password)
    .fetch_optional(pool)
    .await;

    // Update auth.users
    let auth_update = sqlx::query(
        r#"
        UPDATE auth.users
        SET encrypted_password = crypt($2, gen_salt('bf', 10)),
            updated_at = NOW()
        WHERE LOWER(email) = LOWER($1)
        "#
    )
    .bind(&email)
    .bind(&new_password)
    .execute(pool)
    .await;

    if let Err(e) = &auth_update {
        warn!("Note: updating auth.users password encountered: {}", e);
    }

    match app_update {
        Ok(Some((user_id, user_email))) => {
            info!("🔑 Password reset successfully via OTP for: {}", user_email);
            Ok(AuthResponse {
                success: true,
                user: Some(AuthUser {
                    id: user_id.to_string(),
                    email: user_email,
                }),
                error: None,
            })
        }
        Ok(None) => {
            if auth_update.is_ok() {
                info!("🔑 Password reset in auth.users via OTP, ensuring synced into app_users for: {}", email);
                let _ = sqlx::query(
                    r#"
                    INSERT INTO app_users (id, email, password_hash, created_at, updated_at)
                    VALUES (gen_random_uuid(), $1, crypt($2, gen_salt('bf', 10)), NOW(), NOW())
                    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()
                    "#
                )
                .bind(&email)
                .bind(&new_password)
                .execute(pool)
                .await;

                Ok(AuthResponse {
                    success: true,
                    user: None,
                    error: None,
                })
            } else {
                Ok(AuthResponse {
                    success: false,
                    user: None,
                    error: Some("Unable to update password for this account".to_string()),
                })
            }
        }
        Err(e) => {
            error!("Database error updating password: {}", e);
            Ok(AuthResponse {
                success: false,
                user: None,
                error: Some(format!("Database error during reset: {}", e)),
            })
        }
    }
}


