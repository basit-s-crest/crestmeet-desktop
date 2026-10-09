'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import {
  googleDriveService,
  GoogleDriveStatus,
  UploadProgressPayload,
} from '@/services/googleDriveService';

interface GoogleDriveUploadContextType {
  driveStatus: GoogleDriveStatus | null;
  isLoadingStatus: boolean;
  activeUploads: Record<string, UploadProgressPayload>;
  syncedMeetings: Record<string, { drive_file_id: string; video_url?: string }>;
  connectDrive: (emailHint?: string) => Promise<boolean>;
  disconnectDrive: () => Promise<void>;
  refreshDriveStatus: () => Promise<void>;
  retryUpload: (meetingId: string, folderPath: string) => Promise<void>;
  pauseUpload: (meetingId: string) => Promise<void>;
  resumeUpload: (meetingId: string, folderPath: string) => Promise<void>;
  dismissUpload: (meetingId: string) => void;
}

const GoogleDriveUploadContext = createContext<GoogleDriveUploadContextType | undefined>(undefined);

export function GoogleDriveUploadProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [driveStatus, setDriveStatus] = useState<GoogleDriveStatus | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState<boolean>(true);
  const [activeUploads, setActiveUploads] = useState<Record<string, UploadProgressPayload>>({});
  const [syncedMeetings, setSyncedMeetings] = useState<Record<string, { drive_file_id: string; video_url?: string }>>({});

  const refreshDriveStatus = useCallback(async () => {
    if (!user) {
      setDriveStatus({ is_connected: false, email: null });
      setIsLoadingStatus(false);
      return;
    }
    try {
      const status = await googleDriveService.getStatus(user.id);
      setDriveStatus(status);
      if (status.is_connected) {
        // Clear any stale 'not_connected' banner jobs when Drive is verified connected
        setActiveUploads((prev) => {
          let hasStale = false;
          for (const job of Object.values(prev)) {
            if (job.status === 'not_connected') {
              hasStale = true;
              break;
            }
          }
          if (!hasStale) return prev;
          const next = { ...prev };
          for (const [id, job] of Object.entries(next)) {
            if (job.status === 'not_connected') {
              delete next[id];
            }
          }
          return next;
        });
      }
    } catch (err) {
      console.warn('Could not get Google Drive status:', err);
    } finally {
      setIsLoadingStatus(false);
    }
  }, [user]);

  useEffect(() => {
    refreshDriveStatus();
  }, [refreshDriveStatus, user?.id]);

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
            if (payload.drive_file_id) {
              setSyncedMeetings((prev) => ({
                ...prev,
                [payload.meeting_id]: {
                  drive_file_id: payload.drive_file_id!,
                  video_url: payload.video_url || undefined,
                },
              }));
            }

            toast.success('Recording synced to Google Drive!', {
              description: 'Team members can now stream the video in-app.',
            });

            // Keep notification visible for 30s so user can preview or dismiss manually
            setTimeout(() => {
              setActiveUploads((prev) => {
                const next = { ...prev };
                delete next[payload.meeting_id];
                return next;
              });
            }, 30000);
          } else if (payload.status === 'paused') {
            toast.info('Google Drive upload paused', {
              description: 'You can resume the upload anytime.',
            });
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

  const connectDrive = useCallback(async (emailHint?: string): Promise<boolean> => {
    try {
      toast.info('Connecting to Google Drive...', {
        description: 'Please approve access in your browser window.',
      });
      const effectiveEmailHint = emailHint || user?.email;
      const status = await googleDriveService.startAuth(effectiveEmailHint, user?.id);
      setDriveStatus(status);
      if (status.is_connected) {
        toast.success('Google Drive Connected!', {
          description: status.email ? `Linked to ${status.email}` : undefined,
        });
        // Clear any lingering 'not_connected' badges now that connection succeeded
        setActiveUploads((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const [id, job] of Object.entries(next)) {
            if (job.status === 'not_connected') {
              delete next[id];
              changed = true;
            }
          }
          return changed ? next : prev;
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
  }, [user]);

  const disconnectDrive = useCallback(async () => {
    try {
      await googleDriveService.disconnect(user?.id);
      setDriveStatus({ is_connected: false, email: null });
      toast.info('Google Drive Disconnected');
    } catch (err) {
      console.error('Failed to disconnect Google Drive:', err);
    }
  }, [user?.id]);

  const dismissUpload = useCallback((meetingId: string) => {
    setActiveUploads((prev) => {
      const next = { ...prev };
      delete next[meetingId];
      return next;
    });
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

  const pauseUpload = useCallback(async (meetingId: string) => {
    try {
      await googleDriveService.pauseUpload(meetingId);
      setActiveUploads((prev) => {
        if (!prev[meetingId]) return prev;
        return {
          ...prev,
          [meetingId]: {
            ...prev[meetingId],
            status: 'paused',
          },
        };
      });
      toast.info('Upload paused');
    } catch (err: any) {
      toast.error('Could not pause upload', {
        description: err.message || String(err),
      });
    }
  }, []);

  const resumeUpload = useCallback(async (meetingId: string, folderPath: string) => {
    try {
      await googleDriveService.resumeUpload(meetingId, folderPath);
      setActiveUploads((prev) => {
        if (!prev[meetingId]) return prev;
        return {
          ...prev,
          [meetingId]: {
            ...prev[meetingId],
            status: 'uploading',
          },
        };
      });
      toast.info('Upload resumed');
    } catch (err: any) {
      toast.error('Could not resume upload', {
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
        pauseUpload,
        resumeUpload,
        dismissUpload,
        syncedMeetings,
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
