// src/deepgram/mod.rs

pub mod client;
pub mod live;
pub mod provider;

pub use client::{DeepgramClient, DeepgramSegment};
pub use live::{start_deepgram_live_session, LiveTranscriptUpdate};
pub use provider::DeepgramProvider;
