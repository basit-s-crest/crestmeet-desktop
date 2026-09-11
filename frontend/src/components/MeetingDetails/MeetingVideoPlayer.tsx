"use client";

import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Video, ChevronDown, ChevronUp } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface MeetingVideoPlayerProps {
  folderPath?: string | null;
}

export function MeetingVideoPlayer({ folderPath }: MeetingVideoPlayerProps) {
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState<boolean>(true);
  const [hasMergedAudio, setHasMergedAudio] = useState<boolean>(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Load video file and create blob URL
  useEffect(() => {
    let active = true;
    let createdUrl: string | null = null;

    const checkAndLoadVideo = async () => {
      if (!folderPath) {
        setVideoPath(null);
        setVideoUrl(null);
        return;
      }

      try {
        let foundPath = await invoke<string | null>("api_check_meeting_video", {
          folderPath,
        });

        if (!active) return;

        // If only webm exists, attempt merging with audio
        if (foundPath && foundPath.endsWith(".webm")) {
          try {
            console.log("🎬 Video is WebM only, checking if merge with audio is possible...");
            const mergedPath = await invoke<string>("api_merge_meeting_video_and_audio", {
              folderPath,
            });
            if (mergedPath && active) {
              console.log("✅ Successfully merged to MP4:", mergedPath);
              foundPath = mergedPath;
            }
          } catch (mergeErr) {
            console.warn("Could not merge audio with video (continuing with webm):", mergeErr);
          }
        }

        if (!active || !foundPath) {
          setVideoPath(null);
          setVideoUrl(null);
          return;
        }

        setVideoPath(foundPath);
        const isMp4 = foundPath.endsWith(".mp4");
        setHasMergedAudio(isMp4);

        // Load bytes directly into a Blob for 100% reliable local playback
        console.log(`🎥 Loading video bytes for ${foundPath}...`);
        const bytes = await invoke<number[]>("api_load_meeting_video_bytes", {
          filePath: foundPath,
        });

        if (!active) return;

        const mimeType = isMp4 ? "video/mp4" : "video/webm";
        const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
        createdUrl = URL.createObjectURL(blob);
        setVideoUrl(createdUrl);
      } catch (error) {
        console.warn("Could not check/load meeting video:", error);
        setVideoPath(null);
        setVideoUrl(null);
      }
    };

    checkAndLoadVideo();

    return () => {
      active = false;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [folderPath]);

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

  // If no video exists for this meeting, don't display anything
  if (!videoPath || !videoUrl) {
    return null;
  }

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
