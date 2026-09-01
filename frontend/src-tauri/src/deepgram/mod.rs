// src/deepgram/mod.rs

pub mod client;
pub mod provider;

pub use client::{DeepgramClient, DeepgramSegment};
pub use provider::DeepgramProvider;
