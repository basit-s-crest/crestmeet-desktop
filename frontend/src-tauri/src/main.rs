#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::path::PathBuf;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

fn init_logging() -> Option<tracing_appender::non_blocking::WorkerGuard> {
    // Determine log directory (default: %APPDATA%/Meetily/logs or ~/.meetily/logs)
    let log_dir = dirs::data_dir()
        .map(|p| p.join("Meetily").join("logs"))
        .or_else(|| dirs::home_dir().map(|h| h.join(".meetily").join("logs")))
        .unwrap_or_else(|| PathBuf::from("./logs"));

    if let Err(e) = std::fs::create_dir_all(&log_dir) {
        eprintln!("Failed to create log directory {:?}: {}", log_dir, e);
    }

    // Erase old logs on each fresh run so the file only contains logs from the current session
    let log_file = log_dir.join("speaker_pipeline.log");
    let _ = std::fs::remove_file(&log_file);

    // Single fresh file appender: speaker_pipeline.log
    let file_appender = tracing_appender::rolling::never(&log_dir, "speaker_pipeline.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    // Bridge standard `log` crate macros (log::info, log::error) into tracing
    let _ = tracing_log::LogTracer::init();

    // Default filter: info for app, debug for diarization and speakers
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("info,crestmeet::diarization=debug,crestmeet::speakers=debug,app_lib::diarization=debug,app_lib::speakers=debug")
    });

    let stdout_layer = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stdout);

    let file_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(non_blocking);

    let subscriber = tracing_subscriber::registry()
        .with(env_filter)
        .with(stdout_layer)
        .with(file_layer);

    if let Err(e) = subscriber.try_init() {
        eprintln!("Failed to initialize tracing subscriber: {}", e);
        return None;
    }

    log::info!("============================================================");
    log::info!("🚀 CrestMeet Logging System Initialized");
    log::info!("📁 Speaker Pipeline Log Path: {:?}", log_dir);
    log::info!("============================================================");

    Some(guard)
}

fn main() {
    let _log_guard = init_logging();
    log::info!("Starting application...");
    app_lib::run();
}

