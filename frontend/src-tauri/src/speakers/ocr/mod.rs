// frontend/src-tauri/src/speakers/ocr/mod.rs

pub mod adapters;
pub mod engine;
pub mod frame_selector;
pub mod voting;

pub use adapters::AppAdapter;
pub use engine::OcrNamingEngine;
pub use frame_selector::{CandidateSpeechSegment, FrameSelector, SelectedFrameTarget};
pub use voting::{ClusterNamingDecision, OcrObservation, OcrVotingSystem};
