'use client';

import React, { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { recordingService } from '@/services/recordingService';

/**
 * Recording state synchronized with backend
 * This context provides a single source of truth for recording state
 * that automatically syncs with the Rust backend, solving:
 * 1. Page refresh desync (backend recording but UI shows stopped)
 * 2. Pause state visibility across components
 * 3. Comprehensive state for future features (reconnection, etc.)
 */

// Recording lifecycle status enum
export enum RecordingStatus {
  IDLE = 'idle',                          // Not recording
  STARTING = 'starting',                  // Initiating recording
  RECORDING = 'recording',                // Active recording
  STOPPING = 'stopping',                  // Stop initiated, waiting for backend
  PROCESSING_TRANSCRIPTS = 'processing',  // Transcription completion wait
  SAVING = 'saving',                      // Saving to database
  COMPLETED = 'completed',                // Successfully saved
  ERROR = 'error'                         // Error occurred
}

interface RecordingState {
  isRecording: boolean;           // Is a recording session active
  isPaused: boolean;              // Is the recording paused
  isActive: boolean;              // Is actively recording (recording && !paused)
  recordingDuration: number | null;  // Total duration including pauses
  activeDuration: number | null;     // Active recording time (excluding pauses)

  // NEW: Lifecycle status
  status: RecordingStatus;
  statusMessage?: string;  // Optional message for current status
}

interface RecordingStateContextType extends RecordingState {
  // Setters for status & recording management
  setStatus: (status: RecordingStatus, message?: string) => void;
  setIsRecording: (isRecording: boolean) => void;

  // Computed helpers (derived from status)
  isStopping: boolean;
  isProcessing: boolean;
  isSaving: boolean;
}

const RecordingStateContext = createContext<RecordingStateContextType | null>(null);

export const useRecordingState = () => {
  const context = useContext(RecordingStateContext);
  if (!context) {
    throw new Error('useRecordingState must be used within a RecordingStateProvider');
  }
  return context;
};

export function RecordingStateProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<RecordingState>({
    isRecording: false,
    isPaused: false,
    isActive: false,
    recordingDuration: null,
    activeDuration: null,
    status: RecordingStatus.IDLE,
    statusMessage: undefined,
  });

  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * Stop polling backend state (called when recording stops)
   */
  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      console.log('[RecordingStateContext] Stopping state polling');
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  }, []);

  /**
   * Direct setter for isRecording
   */
  const setIsRecording = useCallback((isRecording: boolean) => {
    setState(prev => ({
      ...prev,
      isRecording,
      isActive: isRecording && !prev.isPaused,
      ...(!isRecording ? { isPaused: false, recordingDuration: null, activeDuration: null } : {})
    }));
    if (!isRecording) {
      stopPolling();
    }
  }, [stopPolling]);

  /**
   * Status setter with logging and automatic state cleanup
   */
  const setStatus = useCallback((status: RecordingStatus, message?: string) => {
    console.log(`[RecordingState] Status transition to: ${status}`, message || '');

    setState(prev => {
      const shouldClearRecording =
        status === RecordingStatus.IDLE ||
        status === RecordingStatus.ERROR ||
        status === RecordingStatus.COMPLETED;

      return {
        ...prev,
        status,
        statusMessage: message,
        isRecording: shouldClearRecording ? false : prev.isRecording,
        isPaused: shouldClearRecording ? false : prev.isPaused,
        isActive: shouldClearRecording ? false : prev.isActive,
        recordingDuration: shouldClearRecording ? null : prev.recordingDuration,
        activeDuration: shouldClearRecording ? null : prev.activeDuration,
      };
    });

    if (status === RecordingStatus.IDLE || status === RecordingStatus.ERROR || status === RecordingStatus.COMPLETED) {
      stopPolling();
    }
  }, [stopPolling]);

  /**
   * Sync recording state with backend
   * Called on mount and periodically while recording
   */
  const syncWithBackend = useCallback(async () => {
    try {
      const backendState = await recordingService.getRecordingState();

      setState(prev => {
        // RACE CONDITION GUARD:
        // If we are currently in the middle of stopping, processing transcripts,
        // saving to DB, or already idle, do NOT let a delayed/in-flight polling response
        // resurrect isRecording to true!
        if (
          prev.status === RecordingStatus.STOPPING ||
          prev.status === RecordingStatus.PROCESSING_TRANSCRIPTS ||
          prev.status === RecordingStatus.SAVING ||
          (!prev.isRecording && prev.status === RecordingStatus.IDLE)
        ) {
          return {
            ...prev,
            isPaused: backendState.is_paused,
          };
        }

        // If backend says not recording, automatically stop polling
        if (!backendState.is_recording && prev.isRecording) {
          stopPolling();
        }

        return {
          ...prev,
          isRecording: backendState.is_recording,
          isPaused: backendState.is_paused,
          isActive: backendState.is_active,
          recordingDuration: backendState.recording_duration,
          activeDuration: backendState.active_duration,
        };
      });

      console.log('[RecordingStateContext] Synced with backend:', backendState);
    } catch (error) {
      console.error('[RecordingStateContext] Failed to sync with backend:', error);
    }
  }, [stopPolling]);

  /**
   * Start polling backend state (called when recording starts)
   */
  const startPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
    }

    console.log('[RecordingStateContext] Starting state polling (500ms interval)');
    pollingIntervalRef.current = setInterval(syncWithBackend, 500);
  }, [syncWithBackend]);

  /**
   * Set up event listeners for backend state changes
   */
  useEffect(() => {
    console.log('[RecordingStateContext] Setting up event listeners');
    const unsubscribers: (() => void)[] = [];

    const setupListeners = async () => {
      try {
        // Recording started
        const unlistenStarted = await recordingService.onRecordingStarted(() => {
          console.log('[RecordingStateContext] Recording started event');
          setState(prev => ({
            ...prev,
            isRecording: true,
            isPaused: false,
            isActive: true,
            status: RecordingStatus.RECORDING,
          }));
          startPolling();
        });
        unsubscribers.push(unlistenStarted);

        // Recording stopped
        const unlistenStopped = await recordingService.onRecordingStopped((payload) => {
          console.log('[RecordingStateContext] Recording stopped event:', payload);
          stopPolling();
          setState(prev => {
            const newStatus = [
              RecordingStatus.STOPPING,
              RecordingStatus.PROCESSING_TRANSCRIPTS,
              RecordingStatus.SAVING
            ].includes(prev.status)
              ? prev.status
              : RecordingStatus.STOPPING;

            return {
              ...prev,
              status: newStatus,
              statusMessage: newStatus === RecordingStatus.STOPPING ? 'Stopping recording...' : prev.statusMessage,
              isRecording: false,
              isPaused: false,
              isActive: false,
              recordingDuration: null,
              activeDuration: null,
            };
          });
        });
        unsubscribers.push(unlistenStopped);

        // Recording paused
        const unlistenPaused = await recordingService.onRecordingPaused(() => {
          console.log('[RecordingStateContext] Recording paused event');
          setState(prev => ({
            ...prev,
            isPaused: true,
            isActive: false,
          }));
        });
        unsubscribers.push(unlistenPaused);

        // Recording resumed
        const unlistenResumed = await recordingService.onRecordingResumed(() => {
          console.log('[RecordingStateContext] Recording resumed event');
          setState(prev => ({
            ...prev,
            isPaused: false,
            isActive: true,
          }));
        });
        unsubscribers.push(unlistenResumed);

        console.log('[RecordingStateContext] Event listeners set up successfully');
      } catch (error) {
        console.error('[RecordingStateContext] Failed to set up event listeners:', error);
      }
    };

    setupListeners();

    return () => {
      console.log('[RecordingStateContext] Cleaning up event listeners');
      unsubscribers.forEach(unsub => unsub());
      stopPolling();
    };
  }, []);

  /**
   * Initial sync on mount - CRITICAL for fixing refresh desync bug
   * If backend is recording but UI state is false, this will correct it
   */
  useEffect(() => {
    console.log('[RecordingStateContext] Initial mount - syncing with backend');
    syncWithBackend();
  }, []);

  // Computed helpers from status and setters
  const contextValue = useMemo(() => ({
    ...state,
    setStatus,
    setIsRecording,
    isStopping: state.status === RecordingStatus.STOPPING,
    isProcessing: state.status === RecordingStatus.PROCESSING_TRANSCRIPTS,
    isSaving: state.status === RecordingStatus.SAVING,
  }), [state, setStatus, setIsRecording]);

  return (
    <RecordingStateContext.Provider value={contextValue}>
      {children}
    </RecordingStateContext.Provider>
  );
}
