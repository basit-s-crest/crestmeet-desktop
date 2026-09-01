// src/deepgram/provider.rs
//
// Deepgram implementation of the unified TranscriptionProvider trait.

use crate::audio::transcription::provider::{TranscriptionError, TranscriptionProvider, TranscriptResult};
use super::client::DeepgramClient;
use async_trait::async_trait;
use log::{debug, error, info};

pub struct DeepgramProvider {
    client: DeepgramClient,
}

impl DeepgramProvider {
    pub fn new(api_key: String, model: Option<String>) -> Self {
        Self {
            client: DeepgramClient::new(api_key, model),
        }
    }

    pub fn client(&self) -> &DeepgramClient {
        &self.client
    }
}

#[async_trait]
impl TranscriptionProvider for DeepgramProvider {
    async fn transcribe(
        &self,
        audio: Vec<f32>,
        language: Option<String>,
    ) -> std::result::Result<TranscriptResult, TranscriptionError> {
        if audio.is_empty() {
            return Ok(TranscriptResult {
                text: String::new(),
                confidence: None,
                is_partial: false,
            });
        }

        match self
            .client
            .transcribe_chunk(&audio, language.as_deref())
            .await
        {
            Ok((text, confidence)) => {
                debug!("Deepgram transcribed speech chunk: '{}' ({:?})", text, confidence);
                Ok(TranscriptResult {
                    text,
                    confidence,
                    is_partial: false,
                })
            }
            Err(e) => {
                error!("Deepgram transcription error: {}", e);
                Err(TranscriptionError::EngineFailed(e.to_string()))
            }
        }
    }

    async fn is_model_loaded(&self) -> bool {
        // Deepgram is a cloud service - always considered ready if API key is provided
        true
    }

    async fn get_current_model(&self) -> Option<String> {
        Some(self.client.model_name().to_string())
    }

    fn provider_name(&self) -> &'static str {
        "Deepgram"
    }
}
