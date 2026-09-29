// src/database/repositories/setting.rs

use crate::database::models::{Setting, TranscriptSetting};
use crate::summary::CustomOpenAIConfig;
use log::warn;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(serde::Deserialize, Debug)]
pub struct SaveModelConfigRequest {
    pub provider: String,
    pub model: String,
    #[serde(rename = "whisperModel")]
    pub whisper_model: String,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
    #[serde(rename = "ollamaEndpoint")]
    pub ollama_endpoint: Option<String>,
}

#[derive(serde::Deserialize, Debug)]
pub struct SaveTranscriptConfigRequest {
    pub provider: String,
    pub model: String,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
}

pub struct SettingsRepository;

impl SettingsRepository {
    async fn resolve_user_id(pool: &PgPool, user_id: Option<Uuid>) -> Option<Uuid> {
        if let Some(uid) = user_id {
            Some(uid)
        } else {
            // Fallback: look up the first user in auth.users if available
            sqlx::query_scalar::<_, Uuid>("SELECT id FROM auth.users ORDER BY created_at ASC LIMIT 1")
                .fetch_optional(pool)
                .await
                .unwrap_or(None)
        }
    }

    pub async fn get_model_config_for_user(
        pool: &PgPool,
        user_id: Option<Uuid>,
    ) -> std::result::Result<Option<Setting>, sqlx::Error> {
        if let Some(uid) = user_id {
            sqlx::query_as::<_, Setting>("SELECT * FROM settings WHERE user_id = $1 LIMIT 1")
                .bind(uid)
                .fetch_optional(pool)
                .await
        } else {
            sqlx::query_as::<_, Setting>("SELECT * FROM settings LIMIT 1")
                .fetch_optional(pool)
                .await
        }
    }

    pub async fn get_model_config(
        pool: &PgPool,
    ) -> std::result::Result<Option<Setting>, sqlx::Error> {
        Self::get_model_config_for_user(pool, None).await
    }

    pub async fn save_model_config_for_user(
        pool: &PgPool,
        user_id: Option<Uuid>,
        provider: &str,
        model: &str,
        whisper_model: &str,
        ollama_endpoint: Option<&str>,
    ) -> std::result::Result<(), sqlx::Error> {
        let target_uid = match Self::resolve_user_id(pool, user_id).await {
            Some(uid) => uid,
            None => {
                warn!("No active user found to save model config; skipping initial write.");
                return Ok(());
            }
        };

        sqlx::query(
            r#"
            INSERT INTO settings (id, user_id, provider, model, "whisperModel", "ollamaEndpoint")
            VALUES ($1::text, $1, $2, $3, $4, $5)
            ON CONFLICT (user_id) DO UPDATE SET
                provider = EXCLUDED.provider,
                model = EXCLUDED.model,
                "whisperModel" = EXCLUDED."whisperModel",
                "ollamaEndpoint" = EXCLUDED."ollamaEndpoint"
            "#,
        )
        .bind(target_uid)
        .bind(provider)
        .bind(model)
        .bind(whisper_model)
        .bind(ollama_endpoint)
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn save_model_config(
        pool: &PgPool,
        provider: &str,
        model: &str,
        whisper_model: &str,
        ollama_endpoint: Option<&str>,
    ) -> std::result::Result<(), sqlx::Error> {
        Self::save_model_config_for_user(pool, None, provider, model, whisper_model, ollama_endpoint).await
    }

    pub async fn save_api_key_for_user(
        pool: &PgPool,
        user_id: Option<Uuid>,
        provider: &str,
        api_key: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        if provider == "custom-openai" {
            return Err(sqlx::Error::Protocol(
                "custom-openai provider should use save_custom_openai_config() instead of save_api_key()".into(),
            ));
        }

        let api_key_column = match provider {
            "openai" => "openaiApiKey",
            "claude" => "anthropicApiKey",
            "ollama" => "ollamaApiKey",
            "groq" => "groqApiKey",
            "openrouter" => "openRouterApiKey",
            "builtin-ai" => return Ok(()),
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        let target_uid = match Self::resolve_user_id(pool, user_id).await {
            Some(uid) => uid,
            None => {
                warn!("No active user found to save API key; skipping.");
                return Ok(());
            }
        };

        let query = format!(
            r#"
            INSERT INTO settings (id, user_id, provider, model, "whisperModel", "{}")
            VALUES ($1::text, $1, 'openai', 'gpt-4o-2024-11-20', 'large-v3', $2)
            ON CONFLICT (user_id) DO UPDATE SET
                "{}" = $2
            "#,
            api_key_column, api_key_column
        );
        sqlx::query(&query)
            .bind(target_uid)
            .bind(api_key)
            .execute(pool)
            .await?;

        Ok(())
    }

    pub async fn save_api_key(
        pool: &PgPool,
        provider: &str,
        api_key: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        Self::save_api_key_for_user(pool, None, provider, api_key).await
    }

    pub async fn get_api_key_for_user(
        pool: &PgPool,
        user_id: Option<Uuid>,
        provider: &str,
    ) -> std::result::Result<Option<String>, sqlx::Error> {
        if provider == "custom-openai" {
            return Ok(None);
        }

        let api_key_column = match provider {
            "openai" => "openaiApiKey",
            "claude" => "anthropicApiKey",
            "ollama" => "ollamaApiKey",
            "groq" => "groqApiKey",
            "openrouter" => "openRouterApiKey",
            "builtin-ai" => return Ok(None),
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        if let Some(uid) = user_id {
            let query = format!(
                "SELECT \"{}\" FROM settings WHERE user_id = $1 LIMIT 1",
                api_key_column
            );
            if let Ok(Some(key)) = sqlx::query_scalar::<_, Option<String>>(&query).bind(uid).fetch_optional(pool).await {
                if let Some(k) = key {
                    if !k.trim().is_empty() {
                        return Ok(Some(k));
                    }
                }
            }
        }

        // Keys are strictly isolated per user - never fall back to another user's row
        Ok(None)
    }

    pub async fn get_api_key(
        pool: &PgPool,
        provider: &str,
    ) -> std::result::Result<Option<String>, sqlx::Error> {
        Self::get_api_key_for_user(pool, None, provider).await
    }

    pub async fn get_transcript_config_for_user(
        pool: &PgPool,
        user_id: Option<Uuid>,
    ) -> std::result::Result<Option<TranscriptSetting>, sqlx::Error> {
        if let Some(uid) = user_id {
            sqlx::query_as::<_, TranscriptSetting>(
                "SELECT * FROM transcript_settings WHERE user_id = $1 LIMIT 1",
            )
            .bind(uid)
            .fetch_optional(pool)
            .await
        } else {
            sqlx::query_as::<_, TranscriptSetting>(
                "SELECT * FROM transcript_settings LIMIT 1",
            )
            .fetch_optional(pool)
            .await
        }
    }

    pub async fn get_transcript_config(
        pool: &PgPool,
    ) -> std::result::Result<Option<TranscriptSetting>, sqlx::Error> {
        Self::get_transcript_config_for_user(pool, None).await
    }

    pub async fn save_transcript_config_for_user(
        pool: &PgPool,
        user_id: Option<Uuid>,
        provider: &str,
        model: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        let target_uid = match Self::resolve_user_id(pool, user_id).await {
            Some(uid) => uid,
            None => {
                warn!("No active user found to save transcript config; skipping.");
                return Ok(());
            }
        };

        sqlx::query(
            r#"
            INSERT INTO transcript_settings (id, user_id, provider, model)
            VALUES ($1::text, $1, $2, $3)
            ON CONFLICT (user_id) DO UPDATE SET
                provider = EXCLUDED.provider,
                model = EXCLUDED.model
            "#,
        )
        .bind(target_uid)
        .bind(provider)
        .bind(model)
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn save_transcript_config(
        pool: &PgPool,
        provider: &str,
        model: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        Self::save_transcript_config_for_user(pool, None, provider, model).await
    }

    pub async fn save_transcript_api_key_for_user(
        pool: &PgPool,
        user_id: Option<Uuid>,
        provider: &str,
        api_key: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        let api_key_column = match provider {
            "localWhisper" => "whisperApiKey",
            "parakeet" => return Ok(()),
            "deepgram" => "deepgramApiKey",
            "elevenLabs" => "elevenLabsApiKey",
            "groq" => "groqApiKey",
            "openai" => "openaiApiKey",
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        let target_uid = match Self::resolve_user_id(pool, user_id).await {
            Some(uid) => uid,
            None => {
                warn!("No active user found to save transcript API key; skipping.");
                return Ok(());
            }
        };

        let query = format!(
            r#"
            INSERT INTO transcript_settings (id, user_id, provider, model, "{}")
            VALUES ($1::text, $1, 'deepgram', 'nova-2', $2)
            ON CONFLICT (user_id) DO UPDATE SET
                "{}" = $2
            "#,
            api_key_column, api_key_column
        );
        sqlx::query(&query)
            .bind(target_uid)
            .bind(api_key)
            .execute(pool)
            .await?;

        Ok(())
    }

    pub async fn save_transcript_api_key(
        pool: &PgPool,
        provider: &str,
        api_key: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        Self::save_transcript_api_key_for_user(pool, None, provider, api_key).await
    }

    pub async fn get_transcript_api_key_for_user(
        pool: &PgPool,
        user_id: Option<Uuid>,
        provider: &str,
    ) -> std::result::Result<Option<String>, sqlx::Error> {
        let api_key_column = match provider {
            "localWhisper" => "whisperApiKey",
            "parakeet" => return Ok(None),
            "deepgram" => "deepgramApiKey",
            "elevenLabs" => "elevenLabsApiKey",
            "groq" => "groqApiKey",
            "openai" => "openaiApiKey",
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        if let Some(uid) = user_id {
            let query = format!(
                "SELECT \"{}\" FROM transcript_settings WHERE user_id = $1 LIMIT 1",
                api_key_column
            );
            sqlx::query_scalar(&query).bind(uid).fetch_optional(pool).await
        } else {
            Ok(None)
        }
    }

    pub async fn get_transcript_api_key(
        pool: &PgPool,
        provider: &str,
    ) -> std::result::Result<Option<String>, sqlx::Error> {
        Self::get_transcript_api_key_for_user(pool, None, provider).await
    }

    pub async fn delete_api_key(
        pool: &PgPool,
        provider: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        if provider == "custom-openai" {
            sqlx::query("UPDATE settings SET \"customOpenAIConfig\" = NULL")
                .execute(pool)
                .await?;
            return Ok(());
        }

        let api_key_column = match provider {
            "openai" => "openaiApiKey",
            "ollama" => "ollamaApiKey",
            "groq" => "groqApiKey",
            "claude" => "anthropicApiKey",
            "openrouter" => "openRouterApiKey",
            "builtin-ai" => return Ok(()),
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        let query = format!("UPDATE settings SET \"{}\" = NULL", api_key_column);
        sqlx::query(&query).execute(pool).await?;

        Ok(())
    }

    pub async fn get_custom_openai_config(
        pool: &PgPool,
    ) -> std::result::Result<Option<CustomOpenAIConfig>, sqlx::Error> {
        use sqlx::Row;
        let row = sqlx::query("SELECT \"customOpenAIConfig\" FROM settings LIMIT 1")
            .fetch_optional(pool)
            .await?;

        if let Some(row) = row {
            let config_str: Option<String> = row.try_get("customOpenAIConfig")?;
            if let Some(config_str) = config_str {
                match serde_json::from_str::<CustomOpenAIConfig>(&config_str) {
                    Ok(config) => Ok(Some(config)),
                    Err(e) => {
                        log::error!("Failed to parse custom OpenAI config: {}", e);
                        Ok(None)
                    }
                }
            } else {
                Ok(None)
            }
        } else {
            Ok(None)
        }
    }

    pub async fn save_custom_openai_config(
        pool: &PgPool,
        config: &CustomOpenAIConfig,
    ) -> std::result::Result<(), sqlx::Error> {
        let config_str = serde_json::to_string(config).map_err(|e| {
            sqlx::Error::Protocol(format!("Failed to serialize custom OpenAI config: {}", e))
        })?;

        sqlx::query("UPDATE settings SET \"customOpenAIConfig\" = $1")
            .bind(config_str)
            .execute(pool)
            .await?;

        Ok(())
    }
}
