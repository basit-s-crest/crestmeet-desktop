'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import {
  googleDriveService,
  GoogleDriveStatus,
  UploadProgressPayload,
} from '@/services/googleDriveService';

interface GoogleDriveUploadContextType {
  driveStatus: GoogleDriveStatus | null;
  isLoadingStatus: boolean;
  activeUploads: Record<string, UploadProgressPayload>;
  connectDrive: () => Promise<boolean>;
  disconnectDrive: () => Promise<void>;
  refreshDriveStatus: () => Promise<void>;
  retryUpload: (meetingId: string, folderPath: string) => Promise<void>;
}

const GoogleDriveUploadContext = createContext<GoogleDriveUploadContextType | undefined>(undefined);

export function GoogleDriveUploadProvider({ children }: { children: React.ReactNode }) {
  const [driveStatus, setDriveStatus] = useState<GoogleDriveStatus | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState<boolean>(true);
  const [activeUploads, setActiveUploads] = useState<Record<string, UploadProgressPayload>>({});

  const refreshDriveStatus = useCallback(async () => {
    try {
      const status = await googleDriveService.getStatus();
      setDriveStatus(status);
    } catch (err) {
      console.warn('Could not get Google Drive status:', err);
    } finally {
      setIsLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    refreshDriveStatus();
  }, [refreshDriveStatus]);

  // Listen to background upload events from Tauri
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      try {
        unlisten = await listen<UploadProgressPayload>('meeting-upload-progress', (event) => {
          const payload = event.payload;
          console.log('📡 meeting-upload-progress received:', payload);

          setActiveUploads((prev) => ({
            ...prev,
            [payload.meeting_id]: payload,
          }));

          if (payload.status === 'completed') {
            toast.success('Recording synced to Google Drive!', {
              description: 'Team members can now stream the video in-app.',
            });
            // Auto dismiss after 7 seconds
            setTimeout(() => {
              setActiveUploads((prev) => {
                const next = { ...prev };
                delete next[payload.meeting_id];
                return next;
              });
            }, 7000);
          } else if (payload.status === 'error') {
            toast.error('Google Drive Upload Failed', {
              description: payload.error || 'Could not upload recording video.',
            });
          }
        });
      } catch (e) {
        console.error('Failed to listen to meeting-upload-progress:', e);
      }
    };

    setupListener();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const connectDrive = useCallback(async (): Promise<boolean> => {
    try {
      toast.info('Connecting to Google Drive...', {
        description: 'Please approve access in your browser window.',
      });
      const status = await googleDriveService.startAuth();
      setDriveStatus(status);
      if (status.is_connected) {
        toast.success('Google Drive Connected!', {
          description: status.email ? `Linked to ${status.email}` : undefined,
        });
        return true;
      }
      return false;
    } catch (err: any) {
      console.error('Google Drive auth failed:', err);
      toast.error('Connection Failed', {
        description: err.message || String(err),
      });
      return false;
    }
  }, []);

  const disconnectDrive = useCallback(async () => {
    try {
      await googleDriveService.disconnect();
      setDriveStatus({ is_connected: false, email: null });
      toast.info('Google Drive Disconnected');
    } catch (err) {
      console.error('Failed to disconnect Google Drive:', err);
    }
  }, []);

  const retryUpload = useCallback(async (meetingId: string, folderPath: string) => {
    try {
      await googleDriveService.retryUpload(meetingId, folderPath);
      toast.info('Upload queued to Google Drive');
    } catch (err: any) {
      toast.error('Could not start upload', {
        description: err.message || String(err),
      });
    }
  }, []);

  return (
    <GoogleDriveUploadContext.Provider
      value={{
        driveStatus,
        isLoadingStatus,
        activeUploads,
        connectDrive,
        disconnectDrive,
        refreshDriveStatus,
        retryUpload,
      }}
    >
      {children}
    </GoogleDriveUploadContext.Provider>
  );
}

export function useGoogleDriveUpload() {
  const context = useContext(GoogleDriveUploadContext);
  if (!context) {
    throw new Error('useGoogleDriveUpload must be used within a GoogleDriveUploadProvider');
  }
  return context;
}
