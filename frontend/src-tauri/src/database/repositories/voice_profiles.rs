// frontend/src-tauri/src/database/repositories/voice_profiles.rs

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{Error as SqlxError, FromRow, PgPool};
use tracing::{info, warn};
use uuid::Uuid;

use crate::diarization::config::cosine_similarity;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct VoiceProfile {
    pub person_id: Uuid,
    pub model_id: String,
    pub embedding: Vec<f32>,
    pub n_samples: i32,
    pub is_opted_in: bool,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceMatchResult {
    pub person_id: Uuid,
    pub display_name: String,
    pub similarity: f32,
}

pub struct VoiceProfilesRepository;

impl VoiceProfilesRepository {
    /// Save or update a person's voice profile with a running average centroid
    pub async fn enroll_or_update_profile(
        pool: &PgPool,
        person_id: Uuid,
        model_id: &str,
        new_embedding: &[f32],
    ) -> Result<VoiceProfile, SqlxError> {
        let existing = sqlx::query_as::<_, VoiceProfile>(
            "SELECT person_id, model_id, embedding, n_samples, is_opted_in, updated_at
             FROM voice_profiles
             WHERE person_id = $1",
        )
        .bind(person_id)
        .fetch_optional(pool)
        .await?;

        if let Some(existing_profile) = existing {
            // Check if model matches; if not, replace
            let (updated_embedding, new_n) = if existing_profile.model_id == model_id {
                let n = existing_profile.n_samples as f32;
                let mut avg = Vec::with_capacity(new_embedding.len());
                for (old_val, new_val) in existing_profile.embedding.iter().zip(new_embedding.iter()) {
                    let combined = (old_val * n + new_val) / (n + 1.0);
                    avg.push(combined);
                }
                // L2 normalize
                let norm = avg.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
                for val in &mut avg {
                    *val /= norm;
                }
                (avg, existing_profile.n_samples + 1)
            } else {
                (new_embedding.to_vec(), 1)
            };

            let updated = sqlx::query_as::<_, VoiceProfile>(
                "UPDATE voice_profiles
                 SET model_id = $1,
                     embedding = $2,
                     n_samples = $3,
                     is_opted_in = TRUE,
                     updated_at = $4
                 WHERE person_id = $5
                 RETURNING person_id, model_id, embedding, n_samples, is_opted_in, updated_at",
            )
            .bind(model_id)
            .bind(&updated_embedding)
            .bind(new_n)
            .bind(Utc::now())
            .bind(person_id)
            .fetch_one(pool)
            .await?;

            info!("Updated voice profile for person {} (n_samples={})", person_id, new_n);
            Ok(updated)
        } else {
            let created = sqlx::query_as::<_, VoiceProfile>(
                "INSERT INTO voice_profiles (person_id, model_id, embedding, n_samples, is_opted_in, updated_at)
                 VALUES ($1, $2, $3, 1, TRUE, $4)
                 RETURNING person_id, model_id, embedding, n_samples, is_opted_in, updated_at",
            )
            .bind(person_id)
            .bind(model_id)
            .bind(new_embedding)
            .bind(Utc::now())
            .fetch_one(pool)
            .await?;

            info!("Created new voice profile for person {}", person_id);
            Ok(created)
        }
    }

    /// Match a cluster embedding against opted-in voice profiles
    pub async fn match_embedding(
        pool: &PgPool,
        cluster_embedding: &[f32],
        model_id: &str,
        candidate_person_ids: Option<&[Uuid]>,
        similarity_threshold: f32,
    ) -> Result<Option<VoiceMatchResult>, SqlxError> {
        let profiles = if let Some(candidates) = candidate_person_ids {
            sqlx::query_as::<_, VoiceProfile>(
                "SELECT person_id, model_id, embedding, n_samples, is_opted_in, updated_at
                 FROM voice_profiles
                 WHERE is_opted_in = TRUE 
                   AND model_id = $1
                   AND person_id = ANY($2)",
            )
            .bind(model_id)
            .bind(candidates)
            .fetch_all(pool)
            .await?
        } else {
            sqlx::query_as::<_, VoiceProfile>(
                "SELECT person_id, model_id, embedding, n_samples, is_opted_in, updated_at
                 FROM voice_profiles
                 WHERE is_opted_in = TRUE 
                   AND model_id = $1",
            )
            .bind(model_id)
            .fetch_all(pool)
            .await?
        };

        let mut best_match: Option<(Uuid, f32)> = None;

        for profile in profiles {
            let sim = cosine_similarity(cluster_embedding, &profile.embedding);
            if sim >= similarity_threshold {
                if let Some((_, best_sim)) = best_match {
                    if sim > best_sim {
                        best_match = Some((profile.person_id, sim));
                    }
                } else {
                    best_match = Some((profile.person_id, sim));
                }
            }
        }

        if let Some((person_id, sim)) = best_match {
            // Fetch person display name
            let name: Option<String> = sqlx::query_scalar!(
                "SELECT display_name FROM people WHERE id = $1",
                person_id
            )
            .fetch_optional(pool)
            .await?
            .flatten();

            if let Some(display_name) = name {
                return Ok(Some(VoiceMatchResult {
                    person_id,
                    display_name,
                    similarity: sim,
                }));
            }
        }

        Ok(None)
    }

    /// Delete a voice profile (delete-my-voice GDPR / biometric compliance)
    pub async fn delete_profile(pool: &PgPool, person_id: Uuid) -> Result<bool, SqlxError> {
        let result = sqlx::query("DELETE FROM voice_profiles WHERE person_id = $1")
            .bind(person_id)
            .execute(pool)
            .await?;

        info!("Deleted voice profile for person {}", person_id);
        Ok(result.rows_affected() > 0)
    }

    /// Get voice profile details
    pub async fn get_profile(pool: &PgPool, person_id: Uuid) -> Result<Option<VoiceProfile>, SqlxError> {
        sqlx::query_as::<_, VoiceProfile>(
            "SELECT person_id, model_id, embedding, n_samples, is_opted_in, updated_at
             FROM voice_profiles
             WHERE person_id = $1",
        )
        .bind(person_id)
        .fetch_optional(pool)
        .await
    }
}
