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
  AlertCircle,
  RotateCcw,
  X,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useGoogleDriveUpload } from "@/contexts/GoogleDriveUploadContext";
import { useAuth } from "@/contexts/AuthContext";
import { googleDriveService } from "@/services/googleDriveService";

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
  const [isCheckingVideo, setIsCheckingVideo] = useState<boolean>(true);
  const [isLoadingCloudVideo, setIsLoadingCloudVideo] = useState<boolean>(false);
  const [cloudVideoError, setCloudVideoError] = useState<string | null>(null);

  const { user } = useAuth();
  const { activeUploads } = useGoogleDriveUpload();
  const currentUpload = meetingId ? activeUploads[meetingId] : undefined;

  // Derive effective drive file id & status from props or live background upload
  const effectiveDriveFileId = currentUpload?.drive_file_id || driveFileId;
  const effectiveUploadStatus = currentUpload?.status || uploadStatus;

  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Check and load video:
  // 1. First checks local physical file on disk (if folderPath exists locally)
  // 2. If not local, automatically fetches and caches from Google Drive so it plays natively in HTML5 video player
  const checkAndLoadVideo = useCallback(async () => {
    setIsCheckingVideo(true);
    setCloudVideoError(null);

    // 1. Check local file on this machine
    if (folderPath) {
      try {
        const foundPath = await invoke<string | null>("api_check_meeting_video", {
          folderPath,
        });

        if (foundPath) {
          setVideoPath(foundPath);
          const isMp4 = foundPath.endsWith(".mp4");
          const bytes = await invoke<number[]>("api_load_meeting_video_bytes", {
            filePath: foundPath,
          });

          const mimeType = isMp4 ? "video/mp4" : "video/webm";
          const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
          const createdUrl = URL.createObjectURL(blob);
          setLocalBlobUrl(createdUrl);
          setIsCheckingVideo(false);
          return;
        }
      } catch (error) {
        console.warn("Could not check/load local meeting video:", error);
      }
    }

    // 2. If no local file on disk, but Google Drive file is available (Cloud Stream)
    if (effectiveDriveFileId) {
      setIsLoadingCloudVideo(true);
      try {
        const cachedPath = await googleDriveService.fetchAndCacheDriveVideo(
          meetingId || "unknown",
          effectiveDriveFileId
        );

        if (cachedPath) {
          setVideoPath(cachedPath);
          const bytes = await invoke<number[]>("api_load_meeting_video_bytes", {
            filePath: cachedPath,
          });

          const blob = new Blob([new Uint8Array(bytes)], { type: "video/mp4" });
          const createdUrl = URL.createObjectURL(blob);
          setLocalBlobUrl(createdUrl);
          setIsLoadingCloudVideo(false);
          setIsCheckingVideo(false);
          return;
        }
      } catch (err: any) {
        console.warn("Could not stream/cache Google Drive video:", err);
        setCloudVideoError(
          typeof err === "string" ? err : "Could not stream video from Google Drive"
        );
      } finally {
        setIsLoadingCloudVideo(false);
      }
    }

    setVideoPath(null);
    setLocalBlobUrl(null);
    setIsCheckingVideo(false);
  }, [folderPath, effectiveDriveFileId, meetingId]);

  useEffect(() => {
    checkAndLoadVideo();
  }, [checkAndLoadVideo]);

  // Clean up object URLs on unmount
  useEffect(() => {
    return () => {
      if (localBlobUrl) {
        URL.revokeObjectURL(localBlobUrl);
      }
    };
  }, [localBlobUrl]);

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

  // 2. Loading state when fetching cloud stream from Google Drive
  if (isLoadingCloudVideo) {
    return (
      <div className="mx-3 mt-2.5 mb-2 rounded-xl border border-blue-100 bg-gradient-to-b from-blue-50/60 to-white p-3 shadow-xs max-w-[460px] w-[calc(100%-1.5rem)] mx-auto transition-all duration-200">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="w-7 h-7 rounded-md bg-blue-100 flex items-center justify-center text-blue-600 shrink-0">
              <Loader2 size={15} className="animate-spin text-blue-600" />
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="text-xs font-semibold text-gray-800 truncate">
                Streaming video from Google Drive...
              </h4>
              <p className="text-[10px] text-gray-500 truncate">
                Preparing smooth high-definition playback
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
      </div>
    );
  }

  // 3. Error state if cloud streaming failed
  if (cloudVideoError) {
    const openUrl = effectiveDriveFileId
      ? `https://drive.google.com/file/d/${effectiveDriveFileId}/view`
      : null;

    return (
      <div className="mx-3 mt-2.5 mb-2 rounded-xl border border-amber-200 bg-amber-50/70 p-3 shadow-xs max-w-[460px] w-[calc(100%-1.5rem)] mx-auto transition-all duration-200">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start space-x-2.5 min-w-0">
            <AlertCircle size={15} className="text-amber-600 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <h4 className="text-xs font-semibold text-amber-900">
                Unable to stream cloud video
              </h4>
              <p className="text-[10px] text-amber-700 mt-0.5 line-clamp-2">
                {cloudVideoError}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => checkAndLoadVideo()}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[10px] font-semibold bg-amber-600 text-white hover:bg-amber-700 transition-all cursor-pointer"
                >
                  <RotateCcw size={10} />
                  <span>Retry</span>
                </button>
                {openUrl && (
                  <button
                    type="button"
                    onClick={() => {
                      invoke("open_external_url", { url: openUrl }).catch(() =>
                        window.open(openUrl, "_blank")
                      );
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[10px] font-semibold bg-white border border-amber-300 text-amber-800 hover:bg-amber-100 transition-all cursor-pointer"
                  >
                    <ExternalLink size={10} />
                    <span>Open in Drive</span>
                  </button>
                )}
              </div>
            </div>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors cursor-pointer shrink-0"
              title="Close"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>
    );
  }

  // 4. Video loaded (either local physical file or cached from Google Drive)
  if (videoPath && localBlobUrl) {
    const driveViewUrl = effectiveDriveFileId
      ? `https://drive.google.com/file/d/${effectiveDriveFileId}/view`
      : null;

    const handleOpenInDrive = async () => {
      if (!driveViewUrl) return;
      try {
        await invoke("open_external_url", { url: driveViewUrl });
      } catch {
        window.open(driveViewUrl, "_blank");
      }
    };

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

              {/* Open in Drive link */}
              {driveViewUrl && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpenInDrive();
                      }}
                      className="p-1 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors cursor-pointer"
                      title="Open video on Google Drive"
                    >
                      <ExternalLink size={13} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Open video on Google Drive</p>
                  </TooltipContent>
                </Tooltip>
              )}

              {/* Expand / Collapse */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsExpanded(!isExpanded);
                    }}
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

          {/* Native HTML5 Video Player Box */}
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

  // 5. Upload in progress state
  if (
    effectiveUploadStatus === "uploading" ||
    effectiveUploadStatus === "merging" ||
    effectiveUploadStatus === "checking_drive"
  ) {
    return (
      <div className="mx-3 mt-2.5 mb-2 rounded-xl border border-blue-100 bg-gradient-to-b from-blue-50/60 to-white p-2.5 shadow-xs max-w-[460px] w-[calc(100%-1.5rem)] mx-auto transition-all duration-200">
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
                {currentUpload?.progress
                  ? `${currentUpload.progress}% uploaded`
                  : "In background"}
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

  return null;
}
