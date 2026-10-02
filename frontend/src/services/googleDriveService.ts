import { invoke } from '@tauri-apps/api/core';

export interface GoogleDriveStatus {
  is_connected: boolean;
  email: string | null;
}

export interface UploadProgressPayload {
  meeting_id: string;
  progress: number;
  status: 'idle' | 'merging' | 'checking_drive' | 'uploading' | 'completed' | 'error' | 'not_connected';
  error?: string | null;
  video_url?: string | null;
  drive_file_id?: string | null;
}

export const googleDriveService = {
  async getStatus(): Promise<GoogleDriveStatus> {
    return invoke<GoogleDriveStatus>('api_google_drive_get_status');
  },

  async startAuth(): Promise<GoogleDriveStatus> {
    return invoke<GoogleDriveStatus>('api_google_drive_start_auth');
  },

  async disconnect(): Promise<void> {
    return invoke<void>('api_google_drive_disconnect');
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
};
