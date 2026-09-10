use crate::state::AppState;
use log::{error, info, warn};
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
    let pool = state.db_manager.pool();

    // Try auth.users first
    let user_result: Result<Option<(Uuid, String)>, sqlx::Error> = sqlx::query_as(
        r#"
        SELECT id, email FROM auth.users
        WHERE LOWER(email) = LOWER($1) AND encrypted_password = crypt($2, encrypted_password)
        "#
    )
    .bind(&email)
    .bind(&password)
    .fetch_optional(pool)
    .await;

    match user_result {
        Ok(Some((user_id, user_email))) => {
            // Ensure synced in app_users
            let _ = sqlx::query(
                r#"
                INSERT INTO app_users (id, email, password_hash, created_at, updated_at)
                VALUES ($1, $2, crypt($3, gen_salt('bf', 10)), NOW(), NOW())
                ON CONFLICT (id) DO NOTHING
                "#
            )
            .bind(user_id)
            .bind(&user_email)
            .bind(&password)
            .execute(pool)
            .await;

            let mut current = state.current_user_id.write().await;
            *current = Some(user_id);
            info!("✅ Successfully logged in user from auth.users: {}", user_email);

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
            // Fallback: Check app_users table
            let app_user: Result<Option<(Uuid, String)>, sqlx::Error> = sqlx::query_as(
                r#"
                SELECT id, email FROM app_users
                WHERE LOWER(email) = LOWER($1) AND password_hash = crypt($2, password_hash)
                "#
            )
            .bind(&email)
            .bind(&password)
            .fetch_optional(pool)
            .await;

            match app_user {
                Ok(Some((user_id, user_email))) => {
                    let mut current = state.current_user_id.write().await;
                    *current = Some(user_id);
                    info!("✅ Successfully logged in user from app_users: {}", user_email);
                    Ok(AuthResponse {
                        success: true,
                        user: Some(AuthUser {
                            id: user_id.to_string(),
                            email: user_email,
                        }),
                        error: None,
                    })
                }
                _ => Ok(AuthResponse {
                    success: false,
                    user: None,
                    error: Some("Invalid email or password".to_string()),
                }),
            }
        }
        Err(e) => {
            error!("Database error during login: {}", e);
            // Also try fallback if auth.users had a permission error
            let app_user: Result<Option<(Uuid, String)>, sqlx::Error> = sqlx::query_as(
                r#"
                SELECT id, email FROM app_users
                WHERE LOWER(email) = LOWER($1) AND password_hash = crypt($2, password_hash)
                "#
            )
            .bind(&email)
            .bind(&password)
            .fetch_optional(pool)
            .await;

            match app_user {
                Ok(Some((user_id, user_email))) => {
                    let mut current = state.current_user_id.write().await;
                    *current = Some(user_id);
                    info!("✅ Successfully logged in user from app_users (after auth error): {}", user_email);
                    Ok(AuthResponse {
                        success: true,
                        user: Some(AuthUser {
                            id: user_id.to_string(),
                            email: user_email,
                        }),
                        error: None,
                    })
                }
                _ => Ok(AuthResponse {
                    success: false,
                    user: None,
                    error: Some(format!("Login error: {}", e)),
                }),
            }
        }
    }
}

#[tauri::command]
pub async fn auth_logout(state: State<'_, AppState>) -> Result<(), String> {
    let mut current = state.current_user_id.write().await;
    *current = None;
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
            let mut current = state.current_user_id.write().await;
            *current = Some(uid);
            info!("🔄 Restored user session from auth.users: {}", email);

            // Sync into app_users so subsequent lookups hit the primary table immediately
            let _ = sqlx::query(
                "INSERT INTO app_users (id, email, password_hash, created_at, updated_at) VALUES ($1, $2, 'synced', NOW(), NOW()) ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email"
            )
            .bind(uid)
            .bind(&email)
            .execute(pool)
            .await;

            Ok(Some(AuthUser {
                id: uid.to_string(),
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
