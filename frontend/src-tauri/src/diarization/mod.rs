// frontend/src-tauri/src/diarization/mod.rs

pub mod aligner;
pub mod commands;
pub mod config;
pub mod engine;
pub mod models;

pub use commands::{api_get_meeting_diarization_status, api_run_offline_diarization};
pub use config::DiarizationConfig;
pub use engine::DiarizationEngine;
pub use models::{DiarizationResult, DiarizationStatus, DiarizedSegment, SpeakerClusterSummary};
