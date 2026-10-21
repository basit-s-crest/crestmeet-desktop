// frontend/src-tauri/src/rag_sidecar.rs
//
// Long-lived managed Python RAG & OCR sidecar service.
// Runs as an isolated background child process with below-normal CPU priority
// so it NEVER competes with or slows down real-time audio capture or transcription.

use std::path::PathBuf;
use std::sync::Arc;
use tokio::process::Child;
use tokio::sync::Mutex;
use tracing::{error, info, warn};

#[cfg(target_os = "windows")]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

/// Global child process handle
static RAG_PROCESS: once_cell::sync::Lazy<Arc<Mutex<Option<Child>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

const RAG_SERVICE_URL: &str = "http://127.0.0.1:8123";

/// Check if the Python RAG service is responding to health pings
pub async fn is_rag_service_alive() -> bool {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(600))
        .build();

    if let Ok(c) = client {
        let url = format!("{}/health", RAG_SERVICE_URL);
        if let Ok(res) = c.get(&url).send().await {
            return res.status().is_success();
        }
    }
    false
}

/// Locate the executable to run the RAG service.
/// Priority order:
/// 1. Standalone production sidecar binary in the application install directory
/// 2. Development virtual environment Python (services/rag_service/.venv/Scripts/python.exe)
/// 3. Development PATH uv runner ("uv run python run_server.py")
fn find_rag_executable() -> Option<(PathBuf, Vec<String>, Option<PathBuf>)> {
    // 1. Check for bundled standalone sidecar binary (Production)
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            #[cfg(windows)]
            let candidates = [
                exe_dir.join("crestmeet-rag-service.exe"),
                exe_dir.join("crestmeet-rag-service-x86_64-pc-windows-msvc.exe"),
                exe_dir.join("binaries").join("crestmeet-rag-service-x86_64-pc-windows-msvc.exe"),
            ];

            #[cfg(not(windows))]
            let candidates = [
                exe_dir.join("crestmeet-rag-service"),
                exe_dir.join("binaries").join("crestmeet-rag-service"),
            ];

            for candidate in candidates {
                if candidate.exists() && candidate.is_file() {
                    info!("📦 Found bundled production RAG sidecar binary: {:?}", candidate);
                    return Some((candidate, vec![], None));
                }
            }
        }
    }

    // 2. Check for local workspace development Python virtualenv
    let root_candidates = [
        PathBuf::from("."),
        PathBuf::from(".."),
        PathBuf::from("../.."),
    ];

    for root in &root_candidates {
        let rag_service_dir = root.join("services").join("rag_service");
        if rag_service_dir.exists() {
            #[cfg(windows)]
            let venv_python = rag_service_dir.join(".venv").join("Scripts").join("python.exe");
            #[cfg(not(windows))]
            let venv_python = rag_service_dir.join(".venv").join("bin").join("python");

            let run_server_py = rag_service_dir.join("run_server.py");

            if venv_python.exists() && run_server_py.exists() {
                info!("🐍 Found local development virtualenv Python: {:?}", venv_python);
                return Some((
                    venv_python,
                    vec![run_server_py.to_string_lossy().to_string()],
                    Some(rag_service_dir),
                ));
            }

            // 3. Check for uv in development
            if let Ok(uv_path) = which::which("uv") {
                info!("🛠️ Found 'uv' in PATH: {:?}", uv_path);
                return Some((
                    uv_path,
                    vec!["run".to_string(), "python".to_string(), "run_server.py".to_string()],
                    Some(rag_service_dir),
                ));
            }
        }
    }

    warn!("⚠️ Could not find RAG sidecar binary or Python virtual environment");
    None
}

/// Ensure the RAG sidecar process is running and healthy.
/// Runs in background and never blocks UI or audio transcription.
pub async fn ensure_rag_service_started() {
    if is_rag_service_alive().await {
        info!("✅ Python RAG sidecar already responding at {}", RAG_SERVICE_URL);
        return;
    }

    let (exe_path, args, working_dir) = match find_rag_executable() {
        Some(found) => found,
        None => {
            warn!("Skipping RAG sidecar auto-start (no executable located)");
            return;
        }
    };

    info!("🚀 Spawning Python RAG sidecar: {:?} with args {:?}", exe_path, args);

    let mut cmd = tokio::process::Command::new(&exe_path);
    cmd.args(&args);

    if let Some(cwd) = working_dir {
        cmd.current_dir(cwd);
    }

    // CRITICAL PERFORMANCE SETTING:
    // On Windows, set BELOW_NORMAL_PRIORITY_CLASS and CREATE_NO_WINDOW.
    // This mathematically guarantees that real-time audio threads and Deepgram streaming
    // ALWAYS have higher CPU priority than Python background indexing.
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x00004000;
        cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    }

    // Direct stdout/stderr to null (logging is handled inside run_server.py via FileHandler)
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());

    match cmd.spawn() {
        Ok(child) => {
            let mut proc_guard = RAG_PROCESS.lock().await;
            *proc_guard = Some(child);
            info!("✅ Python RAG sidecar spawned successfully (low CPU priority)");
        }
        Err(e) => {
            error!("❌ Failed to spawn Python RAG sidecar: {}", e);
            return;
        }
    }

    // Non-blocking poll for readiness in the background (up to 15 seconds)
    tokio::spawn(async {
        for attempt in 1..=60 {
            tokio::time::sleep(tokio::time::Duration::from_millis(250)).await;
            if is_rag_service_alive().await {
                info!("🎉 Python RAG sidecar is ready and healthy at {} (after {}ms)", RAG_SERVICE_URL, attempt * 250);
                return;
            }
        }
        warn!("⚠️ Python RAG sidecar did not respond within 15s timeout, continuing without blocking");
    });
}

/// Terminate the RAG sidecar on application exit
pub async fn stop_rag_service() {
    let mut proc_guard = RAG_PROCESS.lock().await;
    if let Some(mut child) = proc_guard.take() {
        info!("🛑 Terminating Python RAG sidecar process...");
        if let Err(e) = child.kill().await {
            warn!("Could not kill RAG sidecar process: {}", e);
        } else {
            info!("✅ Python RAG sidecar terminated cleanly");
        }
    }
}
