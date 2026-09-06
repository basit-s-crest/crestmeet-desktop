// src/deepgram/live.rs
//
// Persistent Deepgram live streaming WebSocket client.
// Connects to wss://api.deepgram.com/v1/listen and keeps connection open
// continuously with KeepAlive heartbeats during silence.

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;

use crate::audio::AudioChunk;

// Global sequence counter for streaming transcripts
static LIVE_SEQUENCE_COUNTER: AtomicU64 = AtomicU64::new(0);

// Global speech detected flag per live session
static LIVE_SPEECH_DETECTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LiveTranscriptUpdate {
    pub text: String,
    pub timestamp: String,
    pub source: String,
    pub sequence_id: u64,
    pub chunk_start_time: f64,
    pub is_partial: bool,
    pub confidence: f32,
    pub audio_start_time: f64,
    pub audio_end_time: f64,
    pub duration: f64,
}

/// Convert 16kHz mono f32 samples to 16-bit linear PCM little-endian bytes
pub fn pcm_f32_to_linear16(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for &sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        let sample_i16 = (clamped * 32767.0) as i16;
        bytes.extend_from_slice(&sample_i16.to_le_bytes());
    }
    bytes
}

fn format_current_timestamp() -> String {
    chrono::Local::now().format("%H:%M:%S").to_string()
}

/// Start a persistent live streaming Deepgram WebSocket session
pub async fn start_deepgram_live_session<R: Runtime>(
    app: AppHandle<R>,
    api_key: String,
    model: String,
    language: Option<String>,
    mut chunk_receiver: mpsc::UnboundedReceiver<AudioChunk>,
) -> Result<()> {
    LIVE_SPEECH_DETECTED.store(false, Ordering::SeqCst);
    LIVE_SEQUENCE_COUNTER.store(0, Ordering::SeqCst);

    let trimmed_key = api_key.trim().to_string();
    if trimmed_key.is_empty() {
        let err_msg = "Deepgram API key is missing".to_string();
        error!("{}", err_msg);
        let _ = app.emit(
            "transcription-error",
            serde_json::json!({
                "error": err_msg,
                "userMessage": "Recording failed: Deepgram API key not found. Please enter it in Settings -> Transcription.",
                "actionable": true
            }),
        );
        return Err(anyhow!(err_msg));
    }

    let mut ws_url = format!(
        "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&model={}&smart_format=true&punctuate=true&endpointing=300",
        model
    );

    if let Some(ref lang) = language {
        let trimmed_lang = lang.trim();
        if !trimmed_lang.is_empty() && trimmed_lang != "auto" && trimmed_lang != "auto-translate" {
            ws_url.push_str(&format!("&language={}", trimmed_lang));
        }
    }

    info!("🔌 Connecting to Deepgram WebSocket: model={}", model);

    let mut request = ws_url.into_client_request()?;
    request.headers_mut().insert(
        "Authorization",
        format!("Token {}", trimmed_key).parse()?,
    );

    let (ws_stream, response) = match connect_async(request).await {
        Ok(res) => res,
        Err(e) => {
            error!("❌ Failed to connect to Deepgram WebSocket: {}", e);
            let _ = app.emit(
                "transcription-error",
                serde_json::json!({
                    "error": e.to_string(),
                    "userMessage": "Failed to connect to Deepgram live streaming service. Please check your network and API key.",
                    "actionable": true
                }),
            );
            return Err(anyhow!("Failed to connect to Deepgram WebSocket: {}", e));
        }
    };

    info!(
        "✅ Deepgram WebSocket connected successfully! (HTTP {})",
        response.status()
    );

    let (mut ws_write, mut ws_read) = ws_stream.split();

    // Internal channel between audio receiver and WebSocket writer
    let (audio_tx, mut audio_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let is_recording_active = Arc::new(AtomicBool::new(true));
    let is_recording_active_clone = is_recording_active.clone();

    // 1. Audio Reader Task: drains AudioChunk receiver from audio pipeline and queues PCM bytes
    let audio_feeder_handle = tokio::spawn(async move {
        info!("🎙️ Audio feeder task active, reading from audio pipeline");
        let mut total_chunks = 0u64;
        while let Some(chunk) = chunk_receiver.recv().await {
            if !chunk.data.is_empty() {
                total_chunks += 1;
                let pcm_bytes = pcm_f32_to_linear16(&chunk.data);
                if total_chunks % 10 == 1 {
                    info!("📤 Feeder forwarded chunk #{} ({} samples, {} bytes) to Deepgram", total_chunks, chunk.data.len(), pcm_bytes.len());
                }
                if audio_tx.send(pcm_bytes).is_err() {
                    break;
                }
            }
        }
        info!("Audio feeder finished: recording stopped, total chunks forwarded: {}", total_chunks);
        is_recording_active_clone.store(false, Ordering::SeqCst);
    });

    // 2. WebSocket Writer & Heartbeat Task:
    // Sends audio frames or KeepAlive heartbeats every 5 seconds during silence
    let writer_handle = tokio::spawn(async move {
        let mut heartbeat_interval = tokio::time::interval(Duration::from_secs(4));
        heartbeat_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        let mut last_send_time = tokio::time::Instant::now();

        loop {
            tokio::select! {
                audio_msg = audio_rx.recv() => {
                    match audio_msg {
                        Some(pcm_bytes) => {
                            if !pcm_bytes.is_empty() {
                                if let Err(e) = ws_write.send(Message::Binary(pcm_bytes)).await {
                                    warn!("Failed to send audio bytes to Deepgram WebSocket: {}", e);
                                    break;
                                }
                                last_send_time = tokio::time::Instant::now();
                            }
                        }
                        None => {
                            // Channel closed: send CloseStream to Deepgram and close cleanly
                            info!("Audio queue exhausted. Sending CloseStream to Deepgram...");
                            let close_msg = serde_json::json!({ "type": "CloseStream" }).to_string();
                            let _ = ws_write.send(Message::Text(close_msg)).await;
                            tokio::time::sleep(Duration::from_millis(800)).await;
                            let _ = ws_write.close().await;
                            break;
                        }
                    }
                }
                _ = heartbeat_interval.tick() => {
                    // If no audio was sent in the last 3.5 seconds, send KeepAlive to prevent timeout
                    if last_send_time.elapsed() >= Duration::from_secs(3) {
                        let keep_alive = serde_json::json!({ "type": "KeepAlive" }).to_string();
                        if let Err(e) = ws_write.send(Message::Text(keep_alive)).await {
                            warn!("Failed to send KeepAlive heartbeat to Deepgram: {}", e);
                            break;
                        }
                        info!("💓 Sent Deepgram KeepAlive heartbeat during silence");
                        last_send_time = tokio::time::Instant::now();
                    }
                }
            }
        }
        info!("Deepgram WebSocket writer task completed");
    });

    // 3. WebSocket Reader Task: reads transcripts from Deepgram and emits them to frontend
    let app_clone = app.clone();
    let reader_handle = tokio::spawn(async move {
        info!("👂 Deepgram WebSocket listener started");

        while let Some(msg_result) = ws_read.next().await {
            match msg_result {
                Ok(Message::Text(text)) => {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                        // In Deepgram v1, transcripts are under "channel.alternatives"
                        if let Some(channel) = val.get("channel") {
                            if let Some(alts) = channel.get("alternatives").and_then(|a| a.as_array()) {
                                if let Some(first_alt) = alts.first() {
                                    let transcript = first_alt
                                        .get("transcript")
                                        .and_then(|t| t.as_str())
                                        .unwrap_or("")
                                        .trim();

                                    let confidence = first_alt
                                        .get("confidence")
                                        .and_then(|c| c.as_f64())
                                        .map(|c| c as f32)
                                        .unwrap_or(0.85);

                                    let is_final = val.get("is_final").and_then(|b| b.as_bool()).unwrap_or(true);
                                    let speech_final = val.get("speech_final").and_then(|b| b.as_bool()).unwrap_or(false);

                                    // Only process and emit finalized utterances to prevent incremental duplicate chunk display
                                    if (is_final || speech_final) && !transcript.is_empty() {
                                        info!("🎙️ Deepgram live transcript (is_final={}, speech_final={}): \"{}\" (conf: {:.2})", is_final, speech_final, transcript, confidence);

                                        // Trigger speech detected event on first utterance
                                        if !LIVE_SPEECH_DETECTED.load(Ordering::SeqCst) {
                                            LIVE_SPEECH_DETECTED.store(true, Ordering::SeqCst);
                                            let _ = app_clone.emit("speech-detected", serde_json::json!({
                                                "timestamp": format_current_timestamp()
                                            }));
                                        }

                                        let start = val.get("start").and_then(|s| s.as_f64()).unwrap_or(0.0);
                                        let duration = val.get("duration").and_then(|d| d.as_f64()).unwrap_or(1.0);
                                        let sequence_id = LIVE_SEQUENCE_COUNTER.fetch_add(1, Ordering::SeqCst);

                                        let update = crate::audio::transcription::worker::TranscriptUpdate {
                                            text: transcript.to_string(),
                                            timestamp: format_current_timestamp(),
                                            source: "Audio".to_string(),
                                            sequence_id,
                                            chunk_start_time: start,
                                            is_partial: false,
                                            confidence,
                                            audio_start_time: start,
                                            audio_end_time: start + duration,
                                            duration,
                                        };

                                        if let Err(e) = app_clone.emit("transcript-update", &update) {
                                            error!("Failed to emit transcript-update: {}", e);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(Message::Close(frame)) => {
                    info!("Deepgram WebSocket server closed connection: {:?}", frame);
                    break;
                }
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {
                    // Standard WebSocket pings
                }
                Err(e) => {
                    warn!("Deepgram WebSocket read error: {}", e);
                    break;
                }
                _ => {}
            }
        }
        info!("Deepgram WebSocket listener finished");
    });

    // Await all tasks to finish cleanly
    let _ = audio_feeder_handle.await;
    let _ = writer_handle.await;
    let _ = reader_handle.await;

    info!("🏁 Deepgram live streaming session concluded cleanly");
    Ok(())
}
