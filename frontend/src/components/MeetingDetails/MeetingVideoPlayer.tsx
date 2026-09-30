"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Video, ChevronDown, ChevronUp, DownloadCloud, Loader2, CheckCircle2, AlertCircle, Wifi } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { mediaTransferService, TransferProgress } from "@/services/mediaTransferService";
import { MediaRequest } from "@/types";

interface MeetingVideoPlayerProps {
  meetingId?: string;
  folderPath?: string | null;
  hasVideo?: boolean;
  recorderId?: string;
  recorderEmail?: string;
  projectId?: string;
}

export function MeetingVideoPlayer({
  meetingId,
  folderPath,
  hasVideo,
  recorderId,
  recorderEmail,
  projectId,
}: MeetingVideoPlayerProps) {
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState<boolean>(true);
  const [hasMergedAudio, setHasMergedAudio] = useState<boolean>(false);
  const [isCheckingVideo, setIsCheckingVideo] = useState<boolean>(true);

  // P2P Request state
  const [isRequesting, setIsRequesting] = useState<boolean>(false);
  const [activeRequest, setActiveRequest] = useState<MediaRequest | null>(null);
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const receiverCleanupRef = useRef<(() => void) | null>(null);

  // Check and load video file
  const checkAndLoadVideo = useCallback(async () => {
    if (!folderPath) {
      setVideoPath(null);
      setVideoUrl(null);
      setIsCheckingVideo(false);
      return;
    }

    setIsCheckingVideo(true);
    try {
      let foundPath = await invoke<string | null>("api_check_meeting_video", {
        folderPath,
      });

      // If only webm exists, attempt merging with audio
      if (foundPath && foundPath.endsWith(".webm")) {
        try {
          console.log("🎬 Video is WebM only, checking if merge with audio is possible...");
          const mergedPath = await invoke<string>("api_merge_meeting_video_and_audio", {
            folderPath,
          });
          if (mergedPath) {
            console.log("✅ Successfully merged to MP4:", mergedPath);
            foundPath = mergedPath;
          }
        } catch (mergeErr) {
          console.warn("Could not merge audio with video (continuing with webm):", mergeErr);
        }
      }

      if (!foundPath) {
        setVideoPath(null);
        setVideoUrl(null);
        setIsCheckingVideo(false);
        return;
      }

      setVideoPath(foundPath);
      const isMp4 = foundPath.endsWith(".mp4");
      setHasMergedAudio(isMp4);

      // Load bytes into Blob for local playback
      console.log(`🎥 Loading video bytes for ${foundPath}...`);
      const bytes = await invoke<number[]>("api_load_meeting_video_bytes", {
        filePath: foundPath,
      });

      const mimeType = isMp4 ? "video/mp4" : "video/webm";
      const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
      const createdUrl = URL.createObjectURL(blob);
      setVideoUrl(createdUrl);
    } catch (error) {
      console.warn("Could not check/load meeting video:", error);
      setVideoPath(null);
      setVideoUrl(null);
    } finally {
      setIsCheckingVideo(false);
    }
  }, [folderPath]);

  useEffect(() => {
    checkAndLoadVideo();
  }, [checkAndLoadVideo]);

  // Check if an existing media request is in progress for this meeting
  useEffect(() => {
    let isMounted = true;
    if (!meetingId || videoPath) return;

    const checkExistingRequest = async () => {
      try {
        const req = await mediaTransferService.getMeetingRequest(meetingId);
        if (isMounted && req) {
          setActiveRequest(req);

          // If request is pending or transferring, start receiver listener
          if (req.status === "pending" || req.status === "transferring") {
            startReceiving(req.id);
          }
        }
      } catch (err) {
        console.warn("Could not check existing media request:", err);
      }
    };

    checkExistingRequest();

    return () => {
      isMounted = false;
      if (receiverCleanupRef.current) {
        receiverCleanupRef.current();
      }
    };
  }, [meetingId, videoPath]);

  // Start listening as WebRTC receiver
  const startReceiving = async (reqId: string) => {
    if (!meetingId) return;
    setTransferError(null);

    if (receiverCleanupRef.current) {
      receiverCleanupRef.current();
    }

    const cleanup = await mediaTransferService.startReceiver(
      reqId,
      meetingId,
      (progress) => {
        setTransferProgress(progress);
      },
      async () => {
        console.log("🎉 Transfer completed! Reloading local video...");
        setTransferProgress(null);
        setActiveRequest(null);
        // Refresh local video check
        await checkAndLoadVideo();
      },
      (error) => {
        console.error("P2P transfer error:", error);
        setTransferError(error);
        setTransferProgress(null);
      }
    );

    receiverCleanupRef.current = cleanup;
  };

  // Trigger media request
  const handleRequestRecording = async () => {
    let targetRecorderId = recorderId;
    let targetProjectId = projectId;

    if (!targetRecorderId && meetingId) {
      try {
        const meta = await invoke<any>("api_get_meeting_metadata", { meetingId });
        if (meta?.user_id) {
          targetRecorderId = meta.user_id;
        }
        if (meta?.project_id && !targetProjectId) {
          targetProjectId = meta.project_id;
        }
      } catch (e) {
        console.warn("Could not fetch metadata for recording request:", e);
      }
    }

    if (!meetingId || !targetRecorderId) {
      alert("Cannot request recording: Meeting recorder information unavailable.");
      return;
    }

    setIsRequesting(true);
    setTransferError(null);

    try {
      const req = await mediaTransferService.createRequest(meetingId, targetRecorderId, targetProjectId);
      setActiveRequest(req);
      await startReceiving(req.id);
    } catch (err: any) {
      console.error("Failed to request recording:", err);
      setTransferError(err.message || "Failed to create media request");
    } finally {
      setIsRequesting(false);
    }
  };

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

  // 1. If video was never recorded for this meeting, collapse completely to give 100% room to transcript!
  if (!hasVideo && !videoPath) {
    return null;
  }

  // 2. If video exists locally, display the video player
  if (videoPath && videoUrl) {
    return (
      <TooltipProvider>
        <div className="mx-3 mt-2.5 mb-2 rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden max-w-[460px] w-[calc(100%-1.5rem)] mx-auto transition-all duration-200">
          {/* Header Bar */}
          <div
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-gray-50 transition-colors select-none"
          >
            <div className="flex items-center space-x-2">
              <div className="w-6 h-6 rounded-md bg-blue-50 flex items-center justify-center text-blue-600">
                <Video size={14} />
              </div>
              <h4 className="text-xs font-semibold text-gray-700">
                Meeting Video Recording
              </h4>
            </div>

            <div className="flex items-center space-x-1">
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
                  src={videoUrl}
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

  // 3. If video was recorded but is not on this machine, show the P2P Request Card
  return (
    <div className="mx-3 mt-2.5 mb-2 rounded-xl border border-blue-100 bg-gradient-to-b from-blue-50/60 to-white p-3 shadow-sm max-w-[460px] w-[calc(100%-1.5rem)] mx-auto transition-all duration-200">
      <div className="flex items-start justify-between">
        <div className="flex items-center space-x-2">
          <div className="w-7 h-7 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600 shrink-0">
            <Video size={15} />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-gray-800">
              Video Recording Available
            </h4>
            <p className="text-[11px] text-gray-500">
              Stored on {recorderEmail || "the recorder"}&apos;s device
            </p>
          </div>
        </div>

        <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700 border border-blue-200/60">
          <Wifi size={10} />
          <span>P2P Direct</span>
        </span>
      </div>

      {/* Transfer Progress / States */}
      <div className="mt-3">
        {transferError && (
          <div className="mb-2 p-2 rounded-lg bg-red-50 border border-red-200 text-[11px] text-red-700 flex items-center space-x-1.5">
            <AlertCircle size={14} className="shrink-0 text-red-500" />
            <span className="truncate">{transferError}</span>
          </div>
        )}

        {transferProgress ? (
          <div className="space-y-1.5 bg-white p-2.5 rounded-lg border border-gray-100 shadow-xs">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-medium text-gray-700 flex items-center space-x-1.5">
                <Loader2 size={12} className="animate-spin text-blue-600" />
                <span>Transferring video...</span>
              </span>
              <span className="font-mono text-blue-600 font-semibold">
                {transferProgress.progress}%
              </span>
            </div>

            <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-blue-600 h-1.5 rounded-full transition-all duration-150"
                style={{ width: `${transferProgress.progress}%` }}
              />
            </div>

            <div className="flex justify-between items-center text-[10px] text-gray-400 font-mono">
              <span>Chunk {transferProgress.currentChunk} of {transferProgress.totalChunks}</span>
              <span>{transferProgress.speedMBs} MB/s</span>
            </div>
          </div>
        ) : activeRequest?.status === "pending" ? (
          <div className="flex items-center justify-between bg-amber-50/80 border border-amber-200/80 rounded-lg p-2 text-xs text-amber-800">
            <div className="flex items-center space-x-2">
              <div className="w-2 h-2 rounded-full bg-amber-500 animate-ping" />
              <span className="text-[11px] font-medium">
                Waiting for {recorderEmail || "recorder"} to approve...
              </span>
            </div>
          </div>
        ) : (
          <button
            onClick={handleRequestRecording}
            disabled={isRequesting}
            className="w-full inline-flex items-center justify-center space-x-2 py-2 px-3 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 active:scale-[0.99] disabled:opacity-60 shadow-xs transition-all cursor-pointer"
          >
            {isRequesting ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                <span>Sending Request...</span>
              </>
            ) : (
              <>
                <DownloadCloud size={14} />
                <span>Request Meeting Recording</span>
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
