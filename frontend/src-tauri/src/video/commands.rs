use std::path::{Path, PathBuf};
use std::str::FromStr;
use tracing::{error as log_error, info as log_info, warn as log_warn};
use uuid::Uuid;
use crate::database::models::MediaRequestWithDetails;
use crate::database::repositories::media_request::MediaRequestsRepository;
use crate::state::AppState;
use tauri::State;

/// Saves raw video bytes to a meeting's folder on disk.
#[tauri::command]
pub async fn api_save_meeting_video(
    folder_path: String,
    video_data: Vec<u8>,
) -> Result<String, String> {
    if folder_path.trim().is_empty() {
        return Err("folder_path cannot be empty".to_string());
    }

    if video_data.is_empty() {
        return Err("video_data is empty".to_string());
    }

    let dir = PathBuf::from(&folder_path);
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        log_error!("Failed to create directory {}: {}", folder_path, e);
        return Err(format!("Failed to create directory: {}", e));
    }

    let video_file_path = dir.join("meeting_video.webm");
    log_info!(
        "💾 Saving meeting video ({} bytes) to {:?}",
        video_data.len(),
        video_file_path
    );

    match tokio::fs::write(&video_file_path, &video_data).await {
        Ok(_) => {
            let path_str = video_file_path.to_string_lossy().to_string();
            log_info!("✅ Successfully saved meeting video to {}", path_str);
            Ok(path_str)
        }
        Err(e) => {
            log_error!("Failed to write video file: {}", e);
            Err(format!("Failed to write video file: {}", e))
        }
    }
}

/// Checks if a video recording exists in the specified meeting folder.
#[tauri::command]
pub async fn api_check_meeting_video(folder_path: String) -> Result<Option<String>, String> {
    if folder_path.trim().is_empty() {
        return Ok(None);
    }

    let dir = PathBuf::from(&folder_path);
    
    // Check for merged video with audio first
    let merged_path = dir.join("meeting_video_merged.mp4");
    if merged_path.exists() {
        return Ok(Some(merged_path.to_string_lossy().to_string()));
    }

    let mp4_path = dir.join("meeting_video.mp4");
    if mp4_path.exists() {
        return Ok(Some(mp4_path.to_string_lossy().to_string()));
    }

    // Check for webm
    let webm_path = dir.join("meeting_video.webm");
    if webm_path.exists() {
        return Ok(Some(webm_path.to_string_lossy().to_string()));
    }

    // Also check for legacy or alt filenames
    let alt_webm = dir.join("recording.webm");
    if alt_webm.exists() {
        return Ok(Some(alt_webm.to_string_lossy().to_string()));
    }

    let alt_mp4 = dir.join("recording.mp4");
    if alt_mp4.exists() {
        return Ok(Some(alt_mp4.to_string_lossy().to_string()));
    }

    Ok(None)
}

/// Merges meeting video (e.g. meeting_video.webm) and meeting audio (e.g. audio.mp4) using FFmpeg into a single file with audio.
/// If meeting only has audio (audio.mp4 / audio.wav), packages it into an MP4 with a dark slate backdrop so Google Drive and the in-app player stream it natively.
#[tauri::command]
pub async fn api_merge_meeting_video_and_audio(folder_path: String) -> Result<String, String> {
    if folder_path.trim().is_empty() {
        return Err("folder_path cannot be empty".to_string());
    }

    let dir = PathBuf::from(&folder_path);
    if !dir.exists() {
        return Err(format!("Meeting folder does not exist: {}", folder_path));
    }

    let output_path = dir.join("meeting_video_merged.mp4");
    let should_reuse = if output_path.exists() && output_path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        let out_mtime = output_path.metadata().and_then(|m| m.modified()).ok();
        let raw_mtime = dir.join("meeting_video.webm").metadata().and_then(|m| m.modified()).ok();
        match (out_mtime, raw_mtime) {
            (Some(out_t), Some(raw_t)) => out_t >= raw_t,
            _ => true,
        }
    } else {
        false
    };

    if should_reuse {
        return Ok(output_path.to_string_lossy().to_string());
    }

    // Locate video file if present
    let video_path = if dir.join("meeting_video.webm").exists() {
        Some(dir.join("meeting_video.webm"))
    } else if dir.join("recording.webm").exists() {
        Some(dir.join("recording.webm"))
    } else if dir.join("meeting_video.mp4").exists() {
        Some(dir.join("meeting_video.mp4"))
    } else {
        None
    };

    // Locate audio file if present
    let audio_path = if dir.join("audio.mp4").exists() {
        Some(dir.join("audio.mp4"))
    } else if dir.join("audio.wav").exists() {
        Some(dir.join("audio.wav"))
    } else if dir.join("audio.m4a").exists() {
        Some(dir.join("audio.m4a"))
    } else {
        None
    };

    let ffmpeg_path = crate::audio::ffmpeg::find_ffmpeg_path()
        .ok_or_else(|| "FFmpeg executable not found on system".to_string())?;

    if let (Some(v_path), Some(a_path)) = (&video_path, &audio_path) {
        log_info!(
            "🎬 Merging video ({:?}) and audio ({:?}) with high quality (CRF 20) -> {:?}",
            v_path,
            a_path,
            output_path
        );

        // Transcode meeting video (WebM) + audio into high quality, crisp MP4 (H.264 CRF 20 + AAC 192k)
        let mut command = std::process::Command::new(&ffmpeg_path);
        command.args(&[
            "-y",
            "-i", v_path.to_str().unwrap(),
            "-i", a_path.to_str().unwrap(),
            "-c:v", "libx264",
            "-preset", "faster",
            "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "192k",
            "-movflags", "+faststart",
            "-shortest",
            output_path.to_str().unwrap(),
        ]);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let result = command.output();
        let success = match result {
            Ok(output) if output.status.success() => true,
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                log_warn!("H.264 high-quality compression failed ({}), trying veryfast fallback...", stderr);
                false
            }
            Err(e) => {
                log_warn!("FFmpeg execution failed: {}", e);
                false
            }
        };

        if !success {
            // Fallback: veryfast transcoding with high quality CRF 22
            let mut fallback_cmd = std::process::Command::new(&ffmpeg_path);
            fallback_cmd.args(&[
                "-y",
                "-i", v_path.to_str().unwrap(),
                "-i", a_path.to_str().unwrap(),
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-crf", "22",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac",
                "-b:a", "192k",
                "-movflags", "+faststart",
                "-shortest",
                output_path.to_str().unwrap(),
            ]);

            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                fallback_cmd.creation_flags(CREATE_NO_WINDOW);
            }

            let fallback_output = fallback_cmd.output().map_err(|e| format!("FFmpeg fallback failed: {}", e))?;
            if !fallback_output.status.success() {
                let stderr = String::from_utf8_lossy(&fallback_output.stderr);
                log_error!("FFmpeg fallback merge failed: {}", stderr);
                return Err(format!("FFmpeg merge failed: {}", stderr));
            }
        }
    } else if video_path.is_none() {
        log_info!("Meeting in {:?} has no video recording (audio-only). Skipping merge.", dir);
        return Err("Meeting does not have a video recording; audio-only meetings are not merged into video.".to_string());
    } else if let (Some(v_path), None) = (&video_path, &audio_path) {
        log_info!("📹 Transcoding video-only meeting ({:?}) with CRF 20 -> {:?}", v_path, output_path);
        let mut command = std::process::Command::new(&ffmpeg_path);
        command.args(&[
            "-y",
            "-i", v_path.to_str().unwrap(),
            "-c:v", "libx264",
            "-preset", "faster",
            "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            output_path.to_str().unwrap(),
        ]);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let output = command.output().map_err(|e| format!("FFmpeg video-only transcoding failed: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("FFmpeg video transcoding failed: {}", stderr));
        }
    } else {
        return Err("No audio or video recording found in meeting folder".to_string());
    }

    log_info!("✅ Successfully prepared meeting video file: {:?}", output_path);
    Ok(output_path.to_string_lossy().to_string())
}

/// Reads the raw video bytes from disk so the frontend can create a local object URL.
#[tauri::command]
pub async fn api_load_meeting_video_bytes(file_path: String) -> Result<Vec<u8>, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("Video file does not exist: {}", file_path));
    }

    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(bytes),
        Err(e) => {
            log_error!("Failed to read video file {}: {}", file_path, e);
            Err(format!("Failed to read video file: {}", e))
        }
    }
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct VideoFileInfo {
    pub file_path: String,
    pub file_name: String,
    pub file_size: u64,
    pub chunk_size: u32,
    pub total_chunks: u32,
}

#[tauri::command]
pub async fn api_set_meeting_has_video(
    state: State<'_, AppState>,
    meeting_id: String,
    has_video: bool,
) -> Result<bool, String> {
    let pool = state.db_manager.pool();
    sqlx::query("UPDATE meetings SET has_video = $1 WHERE id = $2")
        .bind(has_video)
        .bind(&meeting_id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to update meeting has_video flag: {}", e))?;
    Ok(true)
}

#[tauri::command]
pub async fn api_update_meeting_folder_path(
    state: State<'_, AppState>,
    meeting_id: String,
    folder_path: String,
) -> Result<bool, String> {
    let pool = state.db_manager.pool();
    sqlx::query("UPDATE meetings SET folder_path = $1, has_video = true WHERE id = $2")
        .bind(&folder_path)
        .bind(&meeting_id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to update meeting folder_path: {}", e))?;
    Ok(true)
}

#[tauri::command]
pub async fn api_create_media_request(
    state: State<'_, AppState>,
    meeting_id: String,
    project_id: Option<String>,
    recorder_id: String,
    media_type: Option<String>,
) -> Result<MediaRequestWithDetails, String> {
    let current = *state.current_user_id.read().await;
    let requested_by = current.ok_or_else(|| "User not authenticated".to_string())?;

    let parsed_recorder_id = Uuid::from_str(&recorder_id)
        .map_err(|_| "Invalid recorder_id UUID".to_string())?;
    let parsed_project_id = project_id
        .as_deref()
        .and_then(|p| Uuid::from_str(p).ok());

    let pool = state.db_manager.pool();
    MediaRequestsRepository::create_or_get_pending_request(
        pool,
        &meeting_id,
        parsed_project_id,
        requested_by,
        parsed_recorder_id,
        media_type.as_deref().unwrap_or("video"),
    )
    .await
    .map_err(|e| format!("Failed to create media request: {}", e))
}

#[tauri::command]
pub async fn api_get_incoming_media_requests(
    state: State<'_, AppState>,
) -> Result<Vec<MediaRequestWithDetails>, String> {
    let current = *state.current_user_id.read().await;
    let recorder_id = match current {
        Some(uid) => uid,
        None => return Ok(Vec::new()),
    };

    let pool = state.db_manager.pool();
    MediaRequestsRepository::get_incoming_pending_requests(pool, recorder_id)
        .await
        .map_err(|e| format!("Failed to get incoming media requests: {}", e))
}

#[tauri::command]
pub async fn api_get_meeting_media_request(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<Option<MediaRequestWithDetails>, String> {
    let current = *state.current_user_id.read().await;
    let requested_by = match current {
        Some(uid) => uid,
        None => return Ok(None),
    };

    let pool = state.db_manager.pool();
    MediaRequestsRepository::get_request_for_meeting(pool, &meeting_id, requested_by)
        .await
        .map_err(|e| format!("Failed to get media request for meeting: {}", e))
}

#[tauri::command]
pub async fn api_update_media_request_status(
    state: State<'_, AppState>,
    request_id: String,
    status: String,
    progress: Option<i32>,
) -> Result<bool, String> {
    let parsed_id = Uuid::from_str(&request_id)
        .map_err(|_| "Invalid request_id UUID".to_string())?;
    let pool = state.db_manager.pool();

    MediaRequestsRepository::update_status(
        pool,
        parsed_id,
        &status,
        progress.unwrap_or(0),
    )
    .await
    .map_err(|e| format!("Failed to update media request status: {}", e))
}

/// Retrieves metadata and chunk layout for a meeting video file.
#[tauri::command]
pub async fn api_get_meeting_video_info(
    folder_path: String,
    chunk_size: Option<u32>,
) -> Result<Option<VideoFileInfo>, String> {
    let video_path_opt = api_check_meeting_video(folder_path).await?;
    let video_path_str = match video_path_opt {
        Some(p) => p,
        None => return Ok(None),
    };

    let path = Path::new(&video_path_str);
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("Failed to read video metadata: {}", e))?;

    let file_size = metadata.len();
    let effective_chunk_size = chunk_size.unwrap_or(64 * 1024); // default 64KB
    let total_chunks = ((file_size + effective_chunk_size as u64 - 1) / effective_chunk_size as u64) as u32;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("meeting_video.mp4")
        .to_string();

    Ok(Some(VideoFileInfo {
        file_path: video_path_str,
        file_name,
        file_size,
        chunk_size: effective_chunk_size,
        total_chunks,
    }))
}

/// Reads a specific slice (chunk) of a video file from disk.
#[tauri::command]
pub async fn api_read_video_chunk(
    file_path: String,
    chunk_index: u32,
    chunk_size: u32,
) -> Result<Vec<u8>, String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};

    let mut file = tokio::fs::File::open(&file_path)
        .await
        .map_err(|e| format!("Failed to open video file {}: {}", file_path, e))?;

    let offset = chunk_index as u64 * chunk_size as u64;
    file.seek(SeekFrom::Start(offset))
        .await
        .map_err(|e| format!("Failed to seek to offset {}: {}", offset, e))?;

    let mut buffer = vec![0u8; chunk_size as usize];
    let bytes_read = file
        .read(&mut buffer)
        .await
        .map_err(|e| format!("Failed to read chunk {}: {}", chunk_index, e))?;

    buffer.truncate(bytes_read);
    Ok(buffer)
}

/// Prepares the local folder for receiving a transferred meeting video.
#[tauri::command]
pub async fn api_prepare_p2p_receive_folder(
    meeting_id: String,
) -> Result<String, String> {
    let base_folder = crate::audio::recording_preferences::get_default_recordings_folder();
    let meeting_folder = base_folder.join(&meeting_id);

    tokio::fs::create_dir_all(&meeting_folder)
        .await
        .map_err(|e| format!("Failed to create local receive folder: {}", e))?;

    Ok(meeting_folder.to_string_lossy().to_string())
}

/// Writes a received chunk into the recipient's local meeting video file.
#[tauri::command]
pub async fn api_write_p2p_chunk(
    state: State<'_, AppState>,
    meeting_id: String,
    file_name: String,
    chunk_index: u32,
    chunk_size: u32,
    chunk_data: Vec<u8>,
    is_final: bool,
) -> Result<bool, String> {
    use tokio::io::{AsyncSeekExt, AsyncWriteExt, SeekFrom};

    let base_folder = crate::audio::recording_preferences::get_default_recordings_folder();
    let meeting_folder = base_folder.join(&meeting_id);

    tokio::fs::create_dir_all(&meeting_folder)
        .await
        .map_err(|e| format!("Failed to create local receive folder: {}", e))?;

    let target_file_path = meeting_folder.join(&file_name);

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&target_file_path)
        .await
        .map_err(|e| format!("Failed to open file for writing {:?}: {}", target_file_path, e))?;

    let offset = chunk_index as u64 * chunk_size as u64;
    file.seek(SeekFrom::Start(offset))
        .await
        .map_err(|e| format!("Failed to seek offset {}: {}", offset, e))?;

    file.write_all(&chunk_data)
        .await
        .map_err(|e| format!("Failed to write chunk {}: {}", chunk_index, e))?;

    file.flush()
        .await
        .map_err(|e| format!("Failed to flush chunk {}: {}", chunk_index, e))?;

    if is_final {
        let folder_str = meeting_folder.to_string_lossy().to_string();
        log_info!(
            "🎉 Completed P2P video transfer for meeting {} into {}",
            meeting_id,
            folder_str
        );

        let pool = state.db_manager.pool();
        let _ = sqlx::query("UPDATE meetings SET folder_path = $1, has_video = true WHERE id = $2")
            .bind(&folder_str)
            .bind(&meeting_id)
            .execute(pool)
            .await;
    }

    Ok(true)
}

