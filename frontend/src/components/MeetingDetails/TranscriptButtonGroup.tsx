"use client";

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Copy, FolderOpen, Video } from 'lucide-react';
import Analytics from '@/lib/analytics';


interface TranscriptButtonGroupProps {
  transcriptCount: number;
  onCopyTranscript: () => void;
  onOpenMeetingFolder: () => Promise<void>;
  meetingId?: string;
  meetingFolderPath?: string | null;
  onRefetchTranscripts?: () => Promise<void>;
  canOpenFolder?: boolean;
  hasVideoRecording?: boolean;
  isVideoPlayerOpen?: boolean;
  onToggleVideoPlayer?: () => void;
}


export function TranscriptButtonGroup({
  transcriptCount,
  onCopyTranscript,
  onOpenMeetingFolder,
  canOpenFolder = true,
  hasVideoRecording = false,
  isVideoPlayerOpen = false,
  onToggleVideoPlayer,
}: TranscriptButtonGroupProps) {
  return (
    <div className="flex items-center justify-center w-full gap-2">
      <ButtonGroup>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            Analytics.trackButtonClick('copy_transcript', 'meeting_details');
            onCopyTranscript();
          }}
          disabled={transcriptCount === 0}
          title={transcriptCount === 0 ? 'No transcript available' : 'Copy Transcript'}
        >
          <Copy />
          <span className="hidden lg:inline">Copy</span>
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="xl:px-4"
          onClick={() => {
            Analytics.trackButtonClick('open_recording_folder', 'meeting_details');
            onOpenMeetingFolder();
          }}
          title="Open Recording Folder"
        >
          <FolderOpen className="xl:mr-2" size={18} />
          <span className="hidden lg:inline">Recording</span>
        </Button>

        {hasVideoRecording && (
          <Button
            size="sm"
            variant={isVideoPlayerOpen ? "secondary" : "outline"}
            className={`xl:px-4 transition-all cursor-pointer ${
              isVideoPlayerOpen
                ? "bg-blue-50 text-blue-700 border-blue-300 font-medium hover:bg-blue-100"
                : "text-gray-700 hover:text-blue-600 hover:bg-blue-50/50"
            }`}
            onClick={() => {
              Analytics.trackButtonClick('toggle_video_player', 'meeting_details');
              onToggleVideoPlayer?.();
            }}
            title={isVideoPlayerOpen ? "Hide Video Player" : "Watch Video Recording"}
          >
            <Video className="xl:mr-2" size={18} />
            <span className="hidden lg:inline">Video</span>
          </Button>
        )}
      </ButtonGroup>
    </div>
  );
}
