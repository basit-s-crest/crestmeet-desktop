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
  X,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useGoogleDriveUpload } from "@/contexts/GoogleDriveUploadContext";
import { useAuth } from "@/contexts/AuthContext";

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
  onClose?: () => void;
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
  onClose,
}: MeetingVideoPlayerProps) {
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [localBlobUrl, setLocalBlobUrl] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState<boolean>(true);
  const [isLargeSize, setIsLargeSize] = useState<boolean>(false);
  const [isCheckingVideo, setIsCheckingVideo] = useState<boolean>(true);

  const { user } = useAuth();
  const { activeUploads, driveStatus, connectDrive, retryUpload } = useGoogleDriveUpload();
  const currentUpload = meetingId ? activeUploads[meetingId] : undefined;

  const isRecorder = Boolean(
    recorderId
      ? user?.id && recorderId.toLowerCase() === user.id.toLowerCase()
      : recorderEmail
        ? user?.email && recorderEmail.toLowerCase() === user.email.toLowerCase()
        : true
  );

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
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                  >
                    {isExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{isExpanded ? "Collapse video player" : "Expand video player"}</p>
                </TooltipContent>
              </Tooltip>

              {onClose && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose();
                  }}
                  className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors cursor-pointer"
                  title="Close video player"
                >
                  <X size={14} />
                </button>
              )}
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

  // 3. CASE B: Video does NOT exist locally, but is stored on Google Drive (Cloud Stream / Direct Link)
  if (effectiveDriveFileId) {
    const embedUrl = `https://drive.google.com/file/d/${effectiveDriveFileId}/preview`;
    const openUrl = `https://drive.google.com/file/d/${effectiveDriveFileId}/view`;

    const handleOpenInDrive = async () => {
      try {
        await invoke('open_external_url', { url: openUrl });
      } catch {
        window.open(openUrl, '_blank');
      }
    };

    const isDriveConnectedOnDevice = Boolean(driveStatus?.is_connected);

    return (
      <TooltipProvider>
        <div className="mx-2 mt-1.5 mb-1.5 rounded-lg border border-blue-200/80 bg-white shadow-xs overflow-hidden max-w-[460px] w-[calc(100%-1rem)] mx-auto transition-all duration-200">
          {/* Header Bar */}
          <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-blue-100/60 bg-gray-50/70">
            <div className="flex items-center space-x-1.5 min-w-0">
              <div className="w-5 h-5 rounded-md bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
                <Video size={12} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <h4 className="text-[11px] font-semibold text-gray-800 truncate">
                    Recording
                  </h4>
                  <span className="inline-flex items-center space-x-0.5 px-1 py-0.5 rounded text-[9px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200/60 shrink-0">
                    <CheckCircle2 size={9} />
                    <span>Synced</span>
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center space-x-1 shrink-0 ml-2">
              {/* Compact Open in Drive button */}
              <button
                type="button"
                onClick={handleOpenInDrive}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 active:bg-blue-200 border border-blue-200/80 transition-colors cursor-pointer"
                title="Open video in Google Drive"
              >
                <ExternalLink size={10} />
                <span>Drive</span>
              </button>

              <button
                type="button"
                onClick={() => setIsLargeSize(!isLargeSize)}
                className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors cursor-pointer"
                title={isLargeSize ? "Switch to compact view" : "Switch to expanded view"}
              >
                {isLargeSize ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </button>

              <button
                type="button"
                onClick={() => setIsExpanded(!isExpanded)}
                className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors cursor-pointer"
                title={isExpanded ? "Collapse inline preview" : "Show inline preview"}
              >
                {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </button>

              {onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors cursor-pointer"
                  title="Close video player"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>

          <div className="p-2 bg-white space-y-1.5">
            {/* Helper badge when Drive is not connected on Device 2 */}
            {!isDriveConnectedOnDevice && (
              <div className="flex items-center justify-between gap-1.5 p-1.5 rounded-md bg-amber-50 border border-amber-200/80 text-[10px] text-amber-800">
                <div className="flex items-center gap-1 min-w-0">
                  <Sparkles size={11} className="text-amber-600 shrink-0" />
                  <span className="truncate">
                    Connect Drive on this device for full workspace access
                  </span>
                </div>
                <button
                  onClick={() => connectDrive()}
                  className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-amber-600 text-white hover:bg-amber-700 transition-all shrink-0 cursor-pointer"
                >
                  Connect
                </button>
              </div>
            )}

            {/* Collapsible Embedded Streaming Player */}
            {isExpanded && (
              <div>
                {/* 
                  When compact (default): iframe has internal height 288px scaled down with transform scale(0.78),
                  rendering inside a 225px container so Google Drive's top bar, video, seekbar, play/pause,
                  and fullscreen controls are all fully visible and never cut off by the frame.
                */}
                <div
                  className={`rounded-md overflow-hidden bg-black shadow-inner relative w-full transition-all duration-200 ${
                    isLargeSize ? 'h-[295px]' : 'h-[225px]'
                  }`}
                >
                  <iframe
                    src={embedUrl}
                    style={
                      isLargeSize
                        ? { width: '100%', height: '100%' }
                        : {
                            width: '128.2%',
                            height: '288px',
                            transform: 'scale(0.78)',
                            transformOrigin: 'top left',
                          }
                    }
                    className="border-0 block"
                    allow="autoplay; fullscreen"
                    allowFullScreen
                    title="Meeting Recording Cloud Stream"
                  />
                </div>
                <div className="mt-1 flex items-center justify-between text-[10px] text-gray-400 px-0.5">
                  <span className="flex items-center gap-1 truncate">
                    <Cloud size={10} className="text-blue-500 shrink-0" />
                    <span className="truncate">Cloud stream · Zero disk used</span>
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => setIsLargeSize(!isLargeSize)}
                      className="text-gray-500 hover:text-blue-600 hover:underline transition-colors cursor-pointer"
                      title={isLargeSize ? "Switch to compact view" : "Switch to expanded view"}
                    >
                      {isLargeSize ? "Compact" : "Enlarge"}
                    </button>
                    <span>·</span>
                    <button
                      type="button"
                      onClick={handleOpenInDrive}
                      className="inline-flex items-center gap-0.5 text-blue-600 hover:text-blue-700 hover:underline transition-colors cursor-pointer font-medium"
                    >
                      <span>Watch in Drive</span>
                      <ExternalLink size={9} />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </TooltipProvider>
    );
  }

  // 4. CASE C: Video was recorded, but upload to Drive is still in progress
  if (effectiveUploadStatus === "uploading" || effectiveUploadStatus === "merging" || effectiveUploadStatus === "checking_drive") {
    return (
      <div className="mx-2 mt-1.5 mb-1.5 rounded-lg border border-blue-100 bg-gradient-to-b from-blue-50/60 to-white p-2.5 shadow-xs max-w-[460px] w-[calc(100%-1rem)] mx-auto transition-all duration-200">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2 min-w-0">
            <div className="w-6 h-6 rounded-md bg-blue-100 flex items-center justify-center text-blue-600 shrink-0">
              <Loader2 size={13} className="animate-spin text-blue-600" />
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="text-xs font-semibold text-gray-800 truncate">
                {effectiveUploadStatus === "merging"
                  ? "Optimizing video recording..."
                  : "Syncing video to Google Drive..."}
              </h4>
              <p className="text-[10px] text-gray-500 truncate">
                {currentUpload?.progress ? `${currentUpload.progress}% uploaded` : "In background"}
              </p>
            </div>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors cursor-pointer shrink-0 ml-1"
              title="Close"
            >
              <X size={13} />
            </button>
          )}
        </div>

        {currentUpload?.progress !== undefined && (
          <div className="mt-2 w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
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
  const hasLocalVideo = Boolean(videoPath);

  return (
    <div className="mx-2 mt-1.5 mb-1.5 rounded-lg border border-gray-200 bg-gradient-to-b from-gray-50 to-white p-2.5 shadow-xs max-w-[460px] w-[calc(100%-1rem)] mx-auto transition-all duration-200">
      <div className="flex items-start justify-between">
        <div className="flex items-center space-x-2 min-w-0">
          <div className="w-6 h-6 rounded-md bg-gray-100 flex items-center justify-center text-gray-600 shrink-0">
            <Cloud size={13} />
          </div>
          <div className="min-w-0">
            <h4 className="text-xs font-semibold text-gray-800 truncate">
              Video Recording Available
            </h4>
            <p className="text-[10px] text-gray-500 truncate">
              {hasLocalVideo
                ? "Stored locally on this device"
                : `Stored locally on ${recorderEmail || "recorder's device"}`}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-1 shrink-0 ml-2">
          <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[9px] font-medium bg-amber-50 text-amber-700 border border-amber-200/60">
            <span>Not Synced</span>
          </span>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors cursor-pointer"
              title="Close"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="mt-2 pt-1.5 border-t border-gray-100">
        {isRecorder && hasLocalVideo && meetingId && folderPath ? (
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] text-gray-500">
              Sync this video to Google Drive so your teammates and other devices can stream it.
            </p>
            <button
              onClick={() => retryUpload(meetingId, folderPath)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold bg-blue-600 text-white hover:bg-blue-700 active:scale-95 transition-all shadow-xs cursor-pointer shrink-0"
            >
              <Sparkles size={11} />
              <span>Sync</span>
            </button>
          </div>
        ) : (
          <p className="text-[10px] text-gray-500">
            {isRecorder
              ? `This meeting was recorded on another device. Open CrestMeet on the recording device and click "Sync to Drive" to enable cloud playback here.`
              : `Pending upload by ${recorderEmail ? (recorderEmail.includes('@') ? recorderEmail.split('@')[0] : recorderEmail) : "the recorder"}. Only the recorder can upload this video to Google Drive.`}
          </p>
        )}
      </div>
    </div>
  );
}
