// src/database/repositories/speakers.rs

use crate::database::models::{MeetingSpeaker, Person};
use chrono::Utc;
use sqlx::{Connection, Error as SqlxError, PgPool};
use tracing::info;
use uuid::Uuid;

pub struct SpeakersRepository;

impl SpeakersRepository {
    /// Get or create a `people` record for a registered user
    pub async fn get_or_create_person_for_user(
        pool: &PgPool,
        user_id: Uuid,
        display_name: &str,
        email: Option<&str>,
    ) -> Result<Person, SqlxError> {
        let existing = sqlx::query_as::<_, Person>(
            "SELECT id, user_id, display_name, email, aliases, created_at, updated_at 
             FROM people 
             WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_optional(pool)
        .await?;

        if let Some(person) = existing {
            return Ok(person);
        }

        let new_person = sqlx::query_as::<_, Person>(
            "INSERT INTO people (user_id, display_name, email, aliases, created_at, updated_at)
             VALUES ($1, $2, $3, '{}', $4, $4)
             RETURNING id, user_id, display_name, email, aliases, created_at, updated_at",
        )
        .bind(user_id)
        .bind(display_name)
        .bind(email)
        .bind(Utc::now())
        .fetch_one(pool)
        .await?;

        Ok(new_person)
    }

    /// List all speaker clusters for a meeting
    pub async fn list_speakers_by_meeting(
        pool: &PgPool,
        meeting_id: &str,
    ) -> Result<Vec<MeetingSpeaker>, SqlxError> {
        let speakers = sqlx::query_as::<_, MeetingSpeaker>(
            "SELECT id, meeting_id, cluster_key, channel, person_id, display_name,
                    name_source, name_confidence, suggested_name, embedding, embedding_model,
                    created_at, updated_at
             FROM meeting_speakers
             WHERE meeting_id = $1
             ORDER BY channel ASC, cluster_key ASC",
        )
        .bind(meeting_id)
        .fetch_all(pool)
        .await?;

        Ok(speakers)
    }

    /// Rename a speaker cluster and optionally link it to a Person
    pub async fn rename_speaker(
        pool: &PgPool,
        speaker_id: Uuid,
        display_name: &str,
        person_id: Option<Uuid>,
    ) -> Result<MeetingSpeaker, SqlxError> {
        let updated = sqlx::query_as::<_, MeetingSpeaker>(
            "UPDATE meeting_speakers
             SET display_name = $1,
                 person_id = $2,
                 name_source = 'manual',
                 name_confidence = 1.0,
                 updated_at = $3
             WHERE id = $4
             RETURNING id, meeting_id, cluster_key, channel, person_id, display_name,
                       name_source, name_confidence, suggested_name, embedding, embedding_model,
                       created_at, updated_at",
        )
        .bind(display_name)
        .bind(person_id)
        .bind(Utc::now())
        .bind(speaker_id)
        .fetch_one(pool)
        .await?;

        info!("Speaker {} manually renamed to '{}'", speaker_id, display_name);
        Ok(updated)
    }

    /// Merge source speaker into target speaker across all transcripts & insights
    pub async fn merge_speakers(
        pool: &PgPool,
        target_speaker_id: Uuid,
        source_speaker_id: Uuid,
    ) -> Result<(), SqlxError> {
        let mut conn = pool.acquire().await?;
        let mut tx = conn.begin().await?;

        // 1. Reassign action items assignee & assigner
        sqlx::query(
            "UPDATE meeting_insights
             SET assignee_speaker_id = $1
             WHERE assignee_speaker_id = $2",
        )
        .bind(target_speaker_id)
        .bind(source_speaker_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "UPDATE meeting_insights
             SET assigner_speaker_id = $1
             WHERE assigner_speaker_id = $2",
        )
        .bind(target_speaker_id)
        .bind(source_speaker_id)
        .execute(&mut *tx)
        .await?;

        // 2. Reassign transcripts
        sqlx::query(
            "UPDATE transcripts
             SET speaker_id = $1
             WHERE speaker_id = $2",
        )
        .bind(target_speaker_id)
        .bind(source_speaker_id)
        .execute(&mut *tx)
        .await?;

        // 3. Delete the redundant source speaker cluster
        sqlx::query("DELETE FROM meeting_speakers WHERE id = $1")
            .bind(source_speaker_id)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        info!("Merged speaker {} into target {}", source_speaker_id, target_speaker_id);
        Ok(())
    }

    /// Automatically link the primary microphone cluster ('mic:S0') to the current user's Person record
    pub async fn auto_link_mic_speaker(
        pool: &PgPool,
        meeting_id: &str,
        user_id: Uuid,
        user_name: &str,
        user_email: Option<&str>,
    ) -> Result<Option<MeetingSpeaker>, SqlxError> {
        let person = Self::get_or_create_person_for_user(pool, user_id, user_name, user_email).await?;

        let updated = sqlx::query_as::<_, MeetingSpeaker>(
            "UPDATE meeting_speakers
             SET person_id = $1,
                 display_name = COALESCE(display_name, $2),
                 name_source = COALESCE(name_source, 'channel'),
                 name_confidence = COALESCE(name_confidence, 0.95),
                 updated_at = NOW()
             WHERE meeting_id = $3
               AND cluster_key = 'mic:S0'
               AND (name_source IS NULL OR name_source != 'manual')
             RETURNING id, meeting_id, cluster_key, channel, person_id, display_name,
                       name_source, name_confidence, suggested_name, embedding, embedding_model,
                       created_at, updated_at",
        )
        .bind(person.id)
        .bind(user_name)
        .bind(meeting_id)
        .fetch_optional(pool)
        .await?;

        Ok(updated)
    }

    /// Upsert a speaker cluster produced by the diarization pipeline
    /// Preserves manual renames and manually linked persons on conflict
    pub async fn upsert_speaker_cluster(
        pool: &PgPool,
        meeting_id: &str,
        cluster_key: &str,
        channel: &str,
        display_name: Option<&str>,
        embedding: Option<&[f32]>,
        embedding_model: Option<&str>,
    ) -> Result<MeetingSpeaker, SqlxError> {
        let speaker = sqlx::query_as::<_, MeetingSpeaker>(
            "INSERT INTO meeting_speakers (
                meeting_id, cluster_key, channel, display_name, name_source, name_confidence, embedding, embedding_model, created_at, updated_at
             )
             VALUES ($1, $2, $3, $4, 'diarization', 0.85, $5, $6, NOW(), NOW())
             ON CONFLICT (meeting_id, cluster_key) DO UPDATE
             SET embedding = COALESCE(EXCLUDED.embedding, meeting_speakers.embedding),
                 embedding_model = COALESCE(EXCLUDED.embedding_model, meeting_speakers.embedding_model),
                 display_name = CASE 
                     WHEN meeting_speakers.name_source = 'manual' THEN meeting_speakers.display_name
                     ELSE COALESCE(meeting_speakers.display_name, EXCLUDED.display_name)
                 END,
                 updated_at = NOW()
             RETURNING id, meeting_id, cluster_key, channel, person_id, display_name,
                       name_source, name_confidence, suggested_name, embedding, embedding_model,
                       created_at, updated_at",
        )
        .bind(meeting_id)
        .bind(cluster_key)
        .bind(channel)
        .bind(display_name)
        .bind(embedding)
        .bind(embedding_model)
        .fetch_one(pool)
        .await?;

        Ok(speaker)
    }

    /// Link a transcript segment to a resolved speaker cluster
    pub async fn update_transcript_speaker(
        pool: &PgPool,
        transcript_id: &str,
        speaker_id: Uuid,
        speaker_confidence: f32,
    ) -> Result<(), SqlxError> {
        sqlx::query(
            "UPDATE transcripts
             SET speaker_id = $1,
                 speaker_confidence = $2
             WHERE id = $3",
        )
        .bind(speaker_id)
        .bind(speaker_confidence)
        .bind(transcript_id)
        .execute(pool)
        .await?;

        Ok(())
    }
}

