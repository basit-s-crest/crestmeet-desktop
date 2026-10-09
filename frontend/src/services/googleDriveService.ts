import { invoke } from '@tauri-apps/api/core';

export interface GoogleDriveStatus {
  is_connected: boolean;
  email: string | null;
}

export interface UploadProgressPayload {
  meeting_id: string;
  progress: number;
  status:
    | 'idle'
    | 'merging'
    | 'checking_drive'
    | 'uploading'
    | 'paused'
    | 'completed'
    | 'error'
    | 'not_connected';
  error?: string | null;
  video_url?: string | null;
  drive_file_id?: string | null;
}

export const googleDriveService = {
  async getStatus(userIdHint?: string): Promise<GoogleDriveStatus> {
    return invoke<GoogleDriveStatus>('api_google_drive_get_status', {
      userIdHint: userIdHint || null,
    });
  },

  async startAuth(userEmailHint?: string, userIdHint?: string): Promise<GoogleDriveStatus> {
    return invoke<GoogleDriveStatus>('api_google_drive_start_auth', {
      userEmailHint: userEmailHint || null,
      userIdHint: userIdHint || null,
    });
  },

  async disconnect(userIdHint?: string): Promise<void> {
    return invoke<void>('api_google_drive_disconnect', {
      userIdHint: userIdHint || null,
    });
  },

  async pauseUpload(meetingId: string): Promise<boolean> {
    return invoke<boolean>('api_google_drive_pause_upload', {
      meetingId,
    });
  },

  async resumeUpload(meetingId: string, folderPath: string): Promise<boolean> {
    return invoke<boolean>('api_google_drive_resume_upload', {
      meetingId,
      folderPath,
    });
  },

  async startBackgroundMediaProcessingAndUpload(
    meetingId: string,
    folderPath: string
  ): Promise<string> {
    return invoke<string>('api_start_background_media_processing_and_upload', {
      meetingId,
      folderPath,
    });
  },

  async retryUpload(meetingId: string, folderPath: string): Promise<string> {
    return invoke<string>('api_retry_meeting_drive_upload', {
      meetingId,
      folderPath,
    });
  },

  async ensureSharePermission(driveFileId: string): Promise<string> {
    return invoke<string>('api_google_drive_ensure_share_permission', {
      driveFileId,
    });
  },

  async fetchAndCacheDriveVideo(
    meetingId: string,
    driveFileId: string
  ): Promise<string> {
    return invoke<string>('api_fetch_and_cache_drive_video', {
      meetingId,
      driveFileId,
    });
  },
};
