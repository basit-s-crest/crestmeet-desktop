// src/parakeet_engine/model.rs
//
// Lightweight stub for Parakeet model - Local ONNX model inference is disabled in favor of Cloud STT (Deepgram).

use std::path::Path;

#[derive(Debug, Clone)]
pub struct TimestampedResult {
    pub text: String,
    pub timestamps: Vec<f32>,
    pub tokens: Vec<String>,
}

#[derive(thiserror::Error, Debug)]
pub enum ParakeetError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Local model disabled: {0}")]
    Disabled(String),
}

pub struct ParakeetModel;

impl ParakeetModel {
    pub fn new<P: AsRef<Path>>(_model_dir: P, _quantized: bool) -> Result<Self, ParakeetError> {
        Err(ParakeetError::Disabled(
            "Local Parakeet ONNX model is disabled. Please configure Deepgram in Settings -> Transcription.".to_string(),
        ))
    }

    pub fn transcribe_samples(
        &mut self,
        _samples: Vec<f32>,
    ) -> Result<TimestampedResult, ParakeetError> {
        Err(ParakeetError::Disabled(
            "Local Parakeet ONNX model is disabled. Please configure Deepgram in Settings -> Transcription.".to_string(),
        ))
    }
}
