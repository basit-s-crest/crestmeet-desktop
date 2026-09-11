"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";

const STORAGE_KEY = "crestmeet_video_recording_enabled";

// Global references to ensure singleton recording state across hooks and components
let globalMediaStream: MediaStream | null = null;
let globalMediaRecorder: MediaRecorder | null = null;
let globalRecordedChunks: Blob[] = [];
let globalIsRecordingVideo = false;

export function useScreenRecording() {
  const [isVideoEnabled, setIsVideoEnabled] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(STORAGE_KEY) === "true";
    }
    return false;
  });
  const [isCapturing, setIsCapturing] = useState<boolean>(false);

  // Synchronize preference from localStorage across all hook instances
  useEffect(() => {
    const syncState = () => {
      if (typeof window !== "undefined") {
        const stored = localStorage.getItem(STORAGE_KEY);
        setIsVideoEnabled(stored === "true");
      }
    };
    syncState();
    window.addEventListener("crestmeet_video_toggle", syncState);
    window.addEventListener("storage", syncState);
    return () => {
      window.removeEventListener("crestmeet_video_toggle", syncState);
      window.removeEventListener("storage", syncState);
    };
  }, []);

  // Update user preference and notify all listeners
  const setVideoEnabled = useCallback((enabled: boolean) => {
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, String(enabled));
      window.dispatchEvent(new Event("crestmeet_video_toggle"));
    }
    setIsVideoEnabled(enabled);
  }, []);

  // Toggle user preference
  const toggleVideoEnabled = useCallback(() => {
    const next = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) !== "true" : true;
    setVideoEnabled(next);
  }, [setVideoEnabled]);

  /**
   * Starts screen capture via WebRTC getDisplayMedia and initializes MediaRecorder.
   * Returns true if user selected a screen/window, false if user cancelled.
   */
  const startScreenCapture = useCallback(async (): Promise<boolean> => {
    if (globalIsRecordingVideo && globalMediaStream && globalMediaRecorder) {
      console.log("🎥 Screen recording is already active.");
      return true;
    }

    try {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
        console.warn("Screen recording is not supported in this browser/environment.");
        toast.error("Screen recording unsupported", {
          description: "navigator.mediaDevices.getDisplayMedia is not available in this environment.",
        });
        return false;
      }

      console.log("🎥 Requesting screen capture permissions...");
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 15, max: 30 },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false, // Audio is handled natively by Rust CPAL for higher quality & dual channels
      });

      // Detect supported mimeType
      let mimeType = "video/webm";
      if (typeof MediaRecorder !== "undefined") {
        if (MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")) {
          mimeType = "video/webm;codecs=vp9,opus";
        } else if (MediaRecorder.isTypeSupported("video/webm;codecs=vp9")) {
          mimeType = "video/webm;codecs=vp9";
        } else if (MediaRecorder.isTypeSupported("video/webm;codecs=vp8")) {
          mimeType = "video/webm;codecs=vp8";
        }
      }

      console.log(`🎥 Initializing MediaRecorder with mimeType: ${mimeType}`);
      const recorder = new MediaRecorder(stream, { mimeType });
      globalRecordedChunks = [];

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          globalRecordedChunks.push(event.data);
        }
      };

      // Handle user clicking "Stop Sharing" on the native OS banner
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => {
          console.log("🎥 User stopped screen sharing via OS banner.");
          if (globalMediaRecorder && globalMediaRecorder.state !== "inactive") {
            try {
              globalMediaRecorder.stop();
            } catch (e) {
              console.warn("Error stopping MediaRecorder on track end:", e);
            }
          }
          setIsCapturing(false);
          globalIsRecordingVideo = false;
        };
      }

      // Start recorder with 1-second timeslices
      recorder.start(1000);

      globalMediaStream = stream;
      globalMediaRecorder = recorder;
      globalIsRecordingVideo = true;
      setIsCapturing(true);

      console.log("✅ Screen capture and video recording started successfully.");
      toast.success("Screen recording started", {
        description: "Capturing selected screen/window for this meeting.",
      });
      return true;
    } catch (error: any) {
      // User pressed "Cancel" on the screen picker dialog
      if (error?.name === "NotAllowedError" || error?.message?.includes("Permission denied")) {
        console.log("ℹ️ User cancelled screen capture selection.");
        toast.info("Screen capture cancelled", {
          description: "Continuing meeting with audio recording only.",
        });
      } else {
        console.error("❌ Failed to start screen recording:", error);
        toast.error("Could not start screen recording", {
          description: `${error?.name || "Error"}: ${error?.message || String(error)}`,
        });
      }
      globalIsRecordingVideo = false;
      setIsCapturing(false);
      return false;
    }
  }, []);

  /**
   * Stops screen capture, releases all hardware tracks, and returns the merged video Blob.
   */
  const stopScreenCapture = useCallback(async (): Promise<Blob | null> => {
    console.log("🛑 Stopping screen capture...");

    if (!globalMediaRecorder && !globalMediaStream) {
      console.log("ℹ️ No active screen capture to stop.");
      return null;
    }

    return new Promise<Blob | null>((resolve) => {
      const recorder = globalMediaRecorder;
      const stream = globalMediaStream;

      const finalize = () => {
        // Stop all tracks to remove screen share indicators
        if (stream) {
          stream.getTracks().forEach((track) => {
            try {
              track.stop();
            } catch (e) {
              console.warn("Error stopping media track:", e);
            }
          });
        }

        globalMediaStream = null;
        globalMediaRecorder = null;
        globalIsRecordingVideo = false;
        setIsCapturing(false);

        if (globalRecordedChunks.length === 0) {
          console.warn("⚠️ No video chunks were recorded.");
          resolve(null);
          return;
        }

        const mimeType = recorder?.mimeType || "video/webm";
        const completeBlob = new Blob(globalRecordedChunks, { type: mimeType });
        console.log(`✅ Meeting video finalized: ${completeBlob.size} bytes (${mimeType})`);
        globalRecordedChunks = [];
        resolve(completeBlob);
      };

      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = () => {
          finalize();
        };
        try {
          recorder.stop();
        } catch (e) {
          console.warn("Error calling recorder.stop():", e);
          finalize();
        }
      } else {
        finalize();
      }
    });
  }, []);

  return {
    isVideoEnabled,
    setIsVideoEnabled: setVideoEnabled,
    setVideoEnabled,
    toggleVideoEnabled,
    isCapturing: isCapturing || globalIsRecordingVideo,
    startScreenCapture,
    stopScreenCapture,
  };
}
