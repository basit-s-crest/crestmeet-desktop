// src/deepgram/client.rs
//
// Deepgram API client for audio transcription (both live chunk and batch whole-file).

use anyhow::{anyhow, Result};
use log::{debug, error, info};
use reqwest::Client;
use serde::Deserialize;
use std::path::Path;
use std::time::Duration;

const DEEPGRAM_API_URL: &str = "https://api.deepgram.com/v1/listen";

#[derive(Debug, Deserialize)]
pub struct DeepgramResponse {
    pub results: Option<DeepgramResults>,
}

#[derive(Debug, Deserialize)]
pub struct DeepgramResults {
    pub channels: Option<Vec<DeepgramChannel>>,
    pub utterances: Option<Vec<DeepgramUtterance>>,
}

#[derive(Debug, Deserialize)]
pub struct DeepgramChannel {
    pub alternatives: Option<Vec<DeepgramAlternative>>,
}

#[derive(Debug, Deserialize)]
pub struct DeepgramAlternative {
    pub transcript: Option<String>,
    pub confidence: Option<f32>,
    pub words: Option<Vec<DeepgramWord>>,
}

#[derive(Debug, Deserialize)]
pub struct DeepgramWord {
    pub word: Option<String>,
    pub start: Option<f64>,
    pub end: Option<f64>,
    pub confidence: Option<f32>,
    pub speaker: Option<usize>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct DeepgramUtterance {
    pub start: f64,
    pub end: f64,
    pub confidence: Option<f32>,
    pub transcript: String,
    pub speaker: Option<usize>,
}

/// Segment result for whole-meeting transcription
#[derive(Debug, Clone)]
pub struct DeepgramSegment {
    pub transcript: String,
    pub audio_start_time: f64,
    pub audio_end_time: f64,
    pub duration: f64,
    pub confidence: f32,
    pub speaker: Option<String>,
}

#[derive(Clone)]
pub struct DeepgramClient {
    api_key: String,
    model: String,
    client: Client,
}

impl DeepgramClient {
    pub fn new(api_key: String, model: Option<String>) -> Self {
        let model = model.unwrap_or_else(|| "nova-2".to_string());
        let client = Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_else(|_| Client::new());

        Self {
            api_key,
            model,
            client,
        }
    }

    pub fn model_name(&self) -> &str {
        &self.model
    }

    /// Transcribe a discrete speech audio chunk (16kHz mono f32)
    pub async fn transcribe_chunk(
        &self,
        samples: &[f32],
        language: Option<&str>,
    ) -> Result<(String, Option<f32>)> {
        if self.api_key.trim().is_empty() {
            return Err(anyhow!("Deepgram API key is not configured"));
        }

        if samples.is_empty() {
            return Ok((String::new(), None));
        }

        let wav_bytes = pcm_f32_to_wav(samples, 16000);

        let mut url = format!(
            "{}?model={}&smart_format=true&punctuate=true",
            DEEPGRAM_API_URL, self.model
        );

        if let Some(lang) = language {
            let trimmed = lang.trim();
            if !trimmed.is_empty() && trimmed != "auto" && trimmed != "auto-translate" {
                url.push_str(&format!("&language={}", trimmed));
            }
        }

        debug!("Sending audio chunk ({} bytes) to Deepgram", wav_bytes.len());

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Token {}", self.api_key.trim()))
            .header("Content-Type", "audio/wav")
            .body(wav_bytes)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            error!("Deepgram chunk transcription failed (HTTP {}): {}", status, error_text);
            return Err(anyhow!("Deepgram error (HTTP {}): {}", status, error_text));
        }

        let parsed: DeepgramResponse = response.json().await?;

        let (text, confidence) = if let Some(results) = parsed.results {
            if let Some(channels) = results.channels {
                if let Some(first_channel) = channels.first() {
                    if let Some(alts) = &first_channel.alternatives {
                        if let Some(alt) = alts.first() {
                            (
                                alt.transcript.clone().unwrap_or_default(),
                                alt.confidence,
                            )
                        } else {
                            (String::new(), None)
                        }
                    } else {
                        (String::new(), None)
                    }
                } else {
                    (String::new(), None)
                }
            } else {
                (String::new(), None)
            }
        } else {
            (String::new(), None)
        };

        Ok((text.trim().to_string(), confidence))
    }

    /// Transcribe a complete audio file in one shot with optional speaker diarization
    pub async fn transcribe_file(
        &self,
        file_path: &Path,
        language: Option<&str>,
        diarize: bool,
    ) -> Result<Vec<DeepgramSegment>> {
        if self.api_key.trim().is_empty() {
            return Err(anyhow!("Deepgram API key is not configured"));
        }

        if !file_path.exists() {
            return Err(anyhow!("Audio file not found: {}", file_path.display()));
        }

        let file_bytes = tokio::fs::read(file_path).await?;
        let content_type = match file_path.extension().and_then(|ext| ext.to_str()).map(|s| s.to_lowercase()).as_deref() {
            Some("wav") => "audio/wav",
            Some("mp3") => "audio/mpeg",
            Some("mp4") | Some("m4a") => "audio/mp4",
            Some("ogg") => "audio/ogg",
            Some("flac") => "audio/flac",
            _ => "application/octet-stream",
        };

        let mut url = format!(
            "{}?model={}&smart_format=true&punctuate=true&utterances=true",
            DEEPGRAM_API_URL, self.model
        );

        if diarize {
            url.push_str("&diarize=true");
        }

        if let Some(lang) = language {
            let trimmed = lang.trim();
            if !trimmed.is_empty() && trimmed != "auto" && trimmed != "auto-translate" {
                url.push_str(&format!("&language={}", trimmed));
            }
        }

        info!(
            "Sending full audio file ({:.2} MB, {}) to Deepgram at {}",
            file_bytes.len() as f64 / (1024.0 * 1024.0),
            content_type,
            url
        );

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Token {}", self.api_key.trim()))
            .header("Content-Type", content_type)
            .body(file_bytes)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            error!("Deepgram file transcription failed (HTTP {}): {}", status, error_text);
            return Err(anyhow!("Deepgram error (HTTP {}): {}", status, error_text));
        }

        let parsed: DeepgramResponse = response.json().await?;

        let mut segments: Vec<DeepgramSegment> = Vec::new();

        if let Some(results) = parsed.results {
            // First priority: Utterances with speaker diarization
            if let Some(utterances) = results.utterances {
                if !utterances.is_empty() {
                    for u in utterances {
                        let text = u.transcript.trim().to_string();
                        if !text.is_empty() {
                            let duration = (u.end - u.start).max(0.1);
                            let speaker = u.speaker.map(|s| format!("Speaker {}", s));
                            segments.push(DeepgramSegment {
                                transcript: text,
                                audio_start_time: u.start,
                                audio_end_time: u.end,
                                duration,
                                confidence: u.confidence.unwrap_or(0.95),
                                speaker,
                            });
                        }
                    }
                }
            }

            // Fallback: If no utterances were returned, parse words or channels alternatives
            if segments.is_empty() {
                if let Some(channels) = results.channels {
                    if let Some(channel) = channels.first() {
                        if let Some(alts) = &channel.alternatives {
                            if let Some(alt) = alts.first() {
                                if let Some(words) = &alt.words {
                                    // Group words into sentence-like segments (~5-8 words or pause > 0.8s)
                                    let mut current_words = Vec::new();
                                    let mut seg_start: Option<f64> = None;
                                    let mut seg_speaker: Option<usize> = None;
                                    let mut last_end = 0.0;

                                    for w in words {
                                        let w_text = w.word.as_deref().unwrap_or("");
                                        let w_start = w.start.unwrap_or(last_end);
                                        let w_end = w.end.unwrap_or(w_start + 0.3);

                                        if seg_start.is_none() {
                                            seg_start = Some(w_start);
                                            seg_speaker = w.speaker;
                                        }

                                        let speaker_changed = w.speaker != seg_speaker && seg_speaker.is_some();
                                        let long_pause = (w_start - last_end) > 0.8;
                                        let enough_words = current_words.len() >= 15;

                                        if (speaker_changed || long_pause || enough_words) && !current_words.is_empty() {
                                            let text = current_words.join(" ");
                                            let start = seg_start.unwrap_or(0.0);
                                            let duration = (last_end - start).max(0.1);
                                            segments.push(DeepgramSegment {
                                                transcript: text,
                                                audio_start_time: start,
                                                audio_end_time: last_end,
                                                duration,
                                                confidence: alt.confidence.unwrap_or(0.95),
                                                speaker: seg_speaker.map(|s| format!("Speaker {}", s)),
                                            });
                                            current_words.clear();
                                            seg_start = Some(w_start);
                                            seg_speaker = w.speaker;
                                        }

                                        current_words.push(w_text.to_string());
                                        last_end = w_end;
                                    }

                                    if !current_words.is_empty() {
                                        let text = current_words.join(" ");
                                        let start = seg_start.unwrap_or(0.0);
                                        let duration = (last_end - start).max(0.1);
                                        segments.push(DeepgramSegment {
                                            transcript: text,
                                            audio_start_time: start,
                                            audio_end_time: last_end,
                                            duration,
                                            confidence: alt.confidence.unwrap_or(0.95),
                                            speaker: seg_speaker.map(|s| format!("Speaker {}", s)),
                                        });
                                    }
                                } else if let Some(transcript) = &alt.transcript {
                                    if !transcript.trim().is_empty() {
                                        segments.push(DeepgramSegment {
                                            transcript: transcript.trim().to_string(),
                                            audio_start_time: 0.0,
                                            audio_end_time: 1.0,
                                            duration: 1.0,
                                            confidence: alt.confidence.unwrap_or(0.95),
                                            speaker: None,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        info!("Deepgram file transcription produced {} segments", segments.len());
        Ok(segments)
    }
}

/// Convert 16kHz mono f32 samples to 16-bit linear PCM WAV bytes with a 44-byte RIFF header
pub fn pcm_f32_to_wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let mut pcm_s16: Vec<i16> = Vec::with_capacity(samples.len());
    for &s in samples {
        let clamped = s.clamp(-1.0, 1.0);
        pcm_s16.push((clamped * 32767.0) as i16);
    }
    let data_len = (pcm_s16.len() * 2) as u32;
    let file_len = 36 + data_len;
    let byte_rate = sample_rate * 2; // 1 channel * 2 bytes
    let block_align = 2u16;
    let bits_per_sample = 16u16;

    let mut header = Vec::with_capacity(44 + data_len as usize);
    header.extend_from_slice(b"RIFF");
    header.extend_from_slice(&file_len.to_le_bytes());
    header.extend_from_slice(b"WAVE");
    header.extend_from_slice(b"fmt ");
    header.extend_from_slice(&16u32.to_le_bytes());
    header.extend_from_slice(&1u16.to_le_bytes()); // PCM format
    header.extend_from_slice(&1u16.to_le_bytes()); // Mono channel
    header.extend_from_slice(&sample_rate.to_le_bytes());
    header.extend_from_slice(&byte_rate.to_le_bytes());
    header.extend_from_slice(&block_align.to_le_bytes());
    header.extend_from_slice(&bits_per_sample.to_le_bytes());
    header.extend_from_slice(b"data");
    header.extend_from_slice(&data_len.to_le_bytes());

    for v in pcm_s16 {
        header.extend_from_slice(&v.to_le_bytes());
    }
    header
}
