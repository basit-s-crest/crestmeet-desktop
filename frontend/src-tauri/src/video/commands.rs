use std::path::{Path, PathBuf};
use tracing::{error as log_error, info as log_info, warn as log_warn};

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
#[tauri::command]
pub async fn api_merge_meeting_video_and_audio(folder_path: String) -> Result<String, String> {
    if folder_path.trim().is_empty() {
        return Err("folder_path cannot be empty".to_string());
    }

    let dir = PathBuf::from(&folder_path);
    if !dir.exists() {
        return Err(format!("Meeting folder does not exist: {}", folder_path));
    }

    // Locate video file
    let video_path = if dir.join("meeting_video.webm").exists() {
        dir.join("meeting_video.webm")
    } else if dir.join("recording.webm").exists() {
        dir.join("recording.webm")
    } else {
        return Err("No video file found to merge".to_string());
    };

    // Locate audio file
    let audio_path = if dir.join("audio.mp4").exists() {
        dir.join("audio.mp4")
    } else if dir.join("audio.wav").exists() {
        dir.join("audio.wav")
    } else if dir.join("audio.m4a").exists() {
        dir.join("audio.m4a")
    } else {
        return Err("No audio file found to merge with video".to_string());
    };

    let ffmpeg_path = crate::audio::ffmpeg::find_ffmpeg_path()
        .ok_or_else(|| "FFmpeg executable not found on system".to_string())?;

    let output_path = dir.join("meeting_video_merged.mp4");
    log_info!(
        "🎬 Merging video ({:?}) and audio ({:?}) -> {:?}",
        video_path,
        audio_path,
        output_path
    );

    // Try fast stream copy first
    let mut command = std::process::Command::new(&ffmpeg_path);
    command.args(&[
        "-y",
        "-i", video_path.to_str().unwrap(),
        "-i", audio_path.to_str().unwrap(),
        "-c:v", "copy",
        "-c:a", "aac",
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
            log_warn!("Stream copy merge failed, attempting fallback transcoding: {}", stderr);
            false
        }
        Err(e) => {
            log_warn!("FFmpeg execution failed: {}", e);
            false
        }
    };

    if !success {
        // Fallback: transcode video to H.264 ultrafast + AAC for universal compatibility
        let mut fallback_cmd = std::process::Command::new(&ffmpeg_path);
        fallback_cmd.args(&[
            "-y",
            "-i", video_path.to_str().unwrap(),
            "-i", audio_path.to_str().unwrap(),
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "23",
            "-c:a", "aac",
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

    log_info!("✅ Successfully merged meeting video with audio: {:?}", output_path);
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
