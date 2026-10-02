"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Video,
  ChevronDown,
  ChevronUp,
  Cloud,
  ExternalLink,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  RotateCcw,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useGoogleDriveUpload } from "@/contexts/GoogleDriveUploadContext";

interface MeetingVideoPlayerProps {
  meetingId?: string;
  folderPath?: string | null;
  hasVideo?: boolean;
  recorderId?: string;
  recorderEmail?: string;
  projectId?: string;
  driveFileId?: string | null;
  videoUrl?: string | null;
  uploadStatus?: string | null;
}

export function MeetingVideoPlayer({
  meetingId,
  folderPath,
  hasVideo,
  recorderId,
  recorderEmail,
  projectId,
  driveFileId,
  videoUrl,
  uploadStatus,
}: MeetingVideoPlayerProps) {
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [localBlobUrl, setLocalBlobUrl] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState<boolean>(true);
  const [isCheckingVideo, setIsCheckingVideo] = useState<boolean>(true);

  const { activeUploads, connectDrive, retryUpload } = useGoogleDriveUpload();
  const currentUpload = meetingId ? activeUploads[meetingId] : undefined;

  // Derive effective drive file id & status from props or live background upload
  const effectiveDriveFileId = currentUpload?.drive_file_id || driveFileId;
  const effectiveVideoUrl = currentUpload?.video_url || videoUrl;
  const effectiveUploadStatus = currentUpload?.status || uploadStatus;

  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Check and load local video file if present on this device
  const checkAndLoadVideo = useCallback(async () => {
    if (!folderPath) {
      setVideoPath(null);
      setLocalBlobUrl(null);
      setIsCheckingVideo(false);
      return;
    }

    setIsCheckingVideo(true);
    try {
      let foundPath = await invoke<string | null>("api_check_meeting_video", {
        folderPath,
      });

      if (!foundPath) {
        setVideoPath(null);
        setLocalBlobUrl(null);
        setIsCheckingVideo(false);
        return;
      }

      setVideoPath(foundPath);
      const isMp4 = foundPath.endsWith(".mp4");

      // Load bytes into Blob for immediate local playback
      const bytes = await invoke<number[]>("api_load_meeting_video_bytes", {
        filePath: foundPath,
      });

      const mimeType = isMp4 ? "video/mp4" : "video/webm";
      const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
      const createdUrl = URL.createObjectURL(blob);
      setLocalBlobUrl(createdUrl);
    } catch (error) {
      console.warn("Could not check/load local meeting video:", error);
      setVideoPath(null);
      setLocalBlobUrl(null);
    } finally {
      setIsCheckingVideo(false);
    }
  }, [folderPath]);

  useEffect(() => {
    checkAndLoadVideo();
  }, [checkAndLoadVideo]);

  // Listen for transcript timestamp seek events
  useEffect(() => {
    const handleSeek = (e: Event) => {
      const customEvent = e as CustomEvent<{ time: number }>;
      const targetTime = customEvent.detail?.time;
      if (typeof targetTime === "number" && videoRef.current) {
        console.log(`⏱️ Seeking video player to: ${targetTime}s`);
        setIsExpanded(true);
        videoRef.current.currentTime = Math.max(0, targetTime);
        videoRef.current.play().catch((err) => {
          console.warn("Autoplay after seek prevented by browser:", err);
        });
      }
    };

    window.addEventListener("crestmeet_seek_video", handleSeek);
    return () => {
      window.removeEventListener("crestmeet_seek_video", handleSeek);
    };
  }, []);

  // 1. If video was never recorded and no drive file exists, hide component completely
  if (!hasVideo && !videoPath && !effectiveDriveFileId) {
    return null;
  }

  // 2. CASE A: Video exists locally on this machine (Recorder view or downloaded file)
  if (videoPath && localBlobUrl) {
    return (
      <TooltipProvider>
        <div className="mx-3 mt-2.5 mb-2 rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden max-w-[460px] w-[calc(100%-1.5rem)] mx-auto transition-all duration-200">
          {/* Header Bar */}
          <div
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors select-none"
          >
            <div className="flex items-center space-x-2">
              <div className="w-6 h-6 rounded-md bg-blue-50 flex items-center justify-center text-blue-600">
                <Video size={14} />
              </div>
              <h4 className="text-xs font-semibold text-gray-700">
                Meeting Video Recording
              </h4>
            </div>

            <div className="flex items-center space-x-2">
              {/* Drive status badge */}
              {effectiveDriveFileId ? (
                <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200/60">
                  <Cloud size={10} />
                  <span>Synced</span>
                </span>
              ) : currentUpload?.status === "uploading" ? (
                <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700 border border-blue-200/60 animate-pulse">
                  <Loader2 size={10} className="animate-spin" />
                  <span>Syncing {currentUpload.progress}%</span>
                </span>
              ) : null}

              {effectiveDriveFileId && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <a
                      href={`https://drive.google.com/file/d/${effectiveDriveFileId}/view`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="p-1 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                    >
                      <ExternalLink size={13} />
                    </a>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Open video on Google Drive</p>
                  </TooltipContent>
                </Tooltip>
              )}

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                  >
                    {isExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{isExpanded ? "Collapse video player" : "Expand video player"}</p>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Video Player Box */}
          {isExpanded && (
            <div className="p-2 pt-0 bg-white">
              <div className="rounded-lg overflow-hidden bg-black flex items-center justify-center shadow-inner">
                <video
                  ref={videoRef}
                  src={localBlobUrl}
                  controls
                  playsInline
                  preload="auto"
                  className="w-full max-h-48 object-contain rounded-lg"
                />
              </div>
            </div>
          )}
        </div>
      </TooltipProvider>
    );
  }

  // 3. CASE B: Video does NOT exist locally, but is stored on Google Drive (In-App Cloud Streaming Player)
  if (effectiveDriveFileId) {
    const embedUrl = `https://drive.google.com/file/d/${effectiveDriveFileId}/preview`;
    const openUrl = `https://drive.google.com/file/d/${effectiveDriveFileId}/view`;

    return (
      <TooltipProvider>
        <div className="mx-3 mt-2.5 mb-2 rounded-xl border border-blue-200/80 bg-gradient-to-b from-blue-50/40 via-white to-white shadow-sm overflow-hidden max-w-[460px] w-[calc(100%-1.5rem)] mx-auto transition-all duration-200">
          {/* Header Bar */}
          <div
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-blue-50/50 transition-colors select-none"
          >
            <div className="flex items-center space-x-2">
              <div className="w-6 h-6 rounded-md bg-blue-100 text-blue-700 flex items-center justify-center">
                <Cloud size={14} />
              </div>
              <div>
                <h4 className="text-xs font-bold text-gray-800 flex items-center space-x-1.5">
                  <span>Google Drive Cloud Stream</span>
                </h4>
              </div>
            </div>

            <div className="flex items-center space-x-1.5">
              <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700 border border-blue-200/60">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                <span>Streaming</span>
              </span>

              <Tooltip>
                <TooltipTrigger asChild>
                  <a
                    href={openUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="p-1 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                  >
                    <ExternalLink size={13} />
                  </a>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Open video on Google Drive</p>
                </TooltipContent>
              </Tooltip>

              <button
                type="button"
                className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
              >
                {isExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </button>
            </div>
          </div>

          {/* Embedded Streaming Player */}
          {isExpanded && (
            <div className="p-2 pt-0 bg-white">
              <div className="rounded-lg overflow-hidden bg-black flex items-center justify-center shadow-inner relative aspect-video min-h-[200px]">
                <iframe
                  src={embedUrl}
                  className="w-full h-full border-0 rounded-lg"
                  allow="autoplay; fullscreen"
                  allowFullScreen
                  title="Meeting Recording Cloud Stream"
                />
              </div>
              <p className="mt-1.5 text-center text-[10px] text-gray-400">
                Streaming directly from Google Drive · Zero download required
              </p>
            </div>
          )}
        </div>
      </TooltipProvider>
    );
  }

  // 4. CASE C: Video was recorded, but upload to Drive is still in progress
  if (effectiveUploadStatus === "uploading" || effectiveUploadStatus === "merging" || effectiveUploadStatus === "checking_drive") {
    return (
      <div className="mx-3 mt-2.5 mb-2 rounded-xl border border-blue-100 bg-gradient-to-b from-blue-50/60 to-white p-3.5 shadow-sm max-w-[460px] w-[calc(100%-1.5rem)] mx-auto transition-all duration-200">
        <div className="flex items-center space-x-2.5">
          <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600 shrink-0">
            <Loader2 size={16} className="animate-spin text-blue-600" />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-xs font-semibold text-gray-800">
              {effectiveUploadStatus === "merging"
                ? "Optimizing video recording..."
                : "Syncing video to Google Drive..."}
            </h4>
            <p className="text-[11px] text-gray-500">
              {currentUpload?.progress ? `${currentUpload.progress}% uploaded` : "In background · Will stream automatically"}
            </p>
          </div>
        </div>

        {currentUpload?.progress !== undefined && (
          <div className="mt-3 w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-blue-600 h-1.5 rounded-full transition-all duration-300"
              style={{ width: `${Math.max(5, currentUpload.progress)}%` }}
            />
          </div>
        )}
      </div>
    );
  }

  // 5. CASE D: Video was recorded, but not synced to Drive (recorder not connected or error)
  const isRecorder = Boolean(folderPath);

  return (
    <div className="mx-3 mt-2.5 mb-2 rounded-xl border border-gray-200 bg-gradient-to-b from-gray-50 to-white p-3.5 shadow-sm max-w-[460px] w-[calc(100%-1.5rem)] mx-auto transition-all duration-200">
      <div className="flex items-start justify-between">
        <div className="flex items-center space-x-2.5">
          <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center text-gray-600 shrink-0">
            <Cloud size={16} />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-gray-800">
              Video Recording Available
            </h4>
            <p className="text-[11px] text-gray-500">
              Stored locally on {recorderEmail || "recorder's device"}
            </p>
          </div>
        </div>

        <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200/60">
          <span>Not Cloud Synced</span>
        </span>
      </div>

      <div className="mt-3 pt-2 border-t border-gray-100">
        {isRecorder && meetingId && folderPath ? (
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-gray-500">
              Sync this video to Google Drive so your teammates can stream it.
            </p>
            <button
              onClick={() => retryUpload(meetingId, folderPath)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 active:scale-95 transition-all shadow-xs cursor-pointer shrink-0"
            >
              <Sparkles size={12} />
              <span>Sync to Drive</span>
            </button>
          </div>
        ) : (
          <p className="text-[11px] text-gray-500">
            The meeting recorder ({recorderEmail || "host"}) can sync this video to Google Drive to enable in-app streaming.
          </p>
        )}
      </div>
    </div>
  );
}
