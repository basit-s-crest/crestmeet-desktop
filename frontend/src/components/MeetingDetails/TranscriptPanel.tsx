'use client';

import { Transcript, TranscriptSegmentData } from '@/types';
import { TranscriptView } from '@/components/TranscriptView';
import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { TranscriptButtonGroup } from './TranscriptButtonGroup';
import { MeetingVideoPlayer } from './MeetingVideoPlayer';
import { useMemo, useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAuth } from '@/contexts/AuthContext';

interface TranscriptPanelProps {
  transcripts: Transcript[];
  customPrompt: string;
  onPromptChange: (value: string) => void;
  onCopyTranscript: () => void;
  onOpenMeetingFolder: () => Promise<void>;
  isRecording: boolean;
  disableAutoScroll?: boolean;

  // Optional pagination props (when using virtualization)
  usePagination?: boolean;
  segments?: TranscriptSegmentData[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;

  // Retranscription props
  meetingId?: string;
  meetingFolderPath?: string | null;
  onRefetchTranscripts?: () => Promise<void>;

  // Video & Google Drive Streaming props
  hasVideo?: boolean;
  recorderId?: string;
  recorderEmail?: string;
  projectId?: string;
  driveFileId?: string | null;
  videoUrl?: string | null;
  uploadStatus?: string | null;

  // Resizable width in pixels
  width?: number;
}

export function TranscriptPanel({
  transcripts,
  customPrompt,
  onPromptChange,
  onCopyTranscript,
  onOpenMeetingFolder,
  isRecording,
  disableAutoScroll = false,
  usePagination = false,
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
  meetingId,
  meetingFolderPath,
  onRefetchTranscripts,
  hasVideo,
  recorderId,
  recorderEmail,
  projectId,
  driveFileId,
  videoUrl,
  uploadStatus,
  width,
}: TranscriptPanelProps) {
  // Convert transcripts to segments if pagination is not used but we want virtualization
  const convertedSegments = useMemo(() => {
    if (usePagination && segments) {
      return segments;
    }
    // Convert transcripts to segments for virtualization
    return transcripts.map(t => ({
      id: t.id,
      timestamp: t.audio_start_time ?? 0,
      endTime: t.audio_end_time,
      text: t.text,
      confidence: t.confidence,
    }));
  }, [transcripts, usePagination, segments]);

  const { user } = useAuth();
  const [isFolderLocal, setIsFolderLocal] = useState<boolean>(false);
  const [hasLocalVideo, setHasLocalVideo] = useState<boolean>(false);
  const [isVideoPlayerOpen, setIsVideoPlayerOpen] = useState<boolean>(false);

  // Check whether the recording folder physically exists on this device
  useEffect(() => {
    let isMounted = true;
    if (!meetingFolderPath) {
      setIsFolderLocal(false);
      setHasLocalVideo(false);
      return;
    }
    invoke<boolean>('api_check_folder_exists', { folderPath: meetingFolderPath })
      .then((exists) => {
        if (isMounted) setIsFolderLocal(Boolean(exists));
      })
      .catch(() => {
        if (isMounted) setIsFolderLocal(false);
      });

    invoke<string | null>('api_check_meeting_video', { folderPath: meetingFolderPath })
      .then((path) => {
        if (isMounted) setHasLocalVideo(Boolean(path));
      })
      .catch(() => {
        if (isMounted) setHasLocalVideo(false);
      });

    return () => {
      isMounted = false;
    };
  }, [meetingFolderPath]);

  // If a timestamp seek event fires from transcript, automatically reveal video player
  useEffect(() => {
    const handleSeek = () => {
      setIsVideoPlayerOpen(true);
    };
    window.addEventListener('crestmeet_seek_video', handleSeek);
    return () => {
      window.removeEventListener('crestmeet_seek_video', handleSeek);
    };
  }, []);

  // Meeting has a video if flagged in DB, stored in Drive, or present locally
  const hasVideoRecording = Boolean(
    hasVideo || driveFileId || videoUrl || uploadStatus || hasLocalVideo
  );

  // Only allow opening folder if this device actually has the folder and user recorded it
  const isRecorder = !recorderId || !user?.id || user.id === recorderId;
  const canOpenFolder = isRecorder && isFolderLocal;

  return (
    <div
      className={`hidden md:flex min-w-0 bg-white flex-col relative shrink-0 ${
        width ? '' : 'md:w-1/4 lg:w-1/3 border-r border-gray-200'
      }`}
      style={{ width: width ? `${width}px` : undefined }}
    >
      {/* Title area */}
      <div className="p-4 border-b border-gray-200">
        <TranscriptButtonGroup
          transcriptCount={usePagination ? (totalCount ?? convertedSegments.length) : (transcripts?.length || 0)}
          onCopyTranscript={onCopyTranscript}
          onOpenMeetingFolder={onOpenMeetingFolder}
          meetingId={meetingId}
          meetingFolderPath={meetingFolderPath}
          onRefetchTranscripts={onRefetchTranscripts}
          canOpenFolder={canOpenFolder}
          hasVideoRecording={hasVideoRecording}
          isVideoPlayerOpen={isVideoPlayerOpen}
          onToggleVideoPlayer={() => setIsVideoPlayerOpen((prev) => !prev)}
        />
      </div>

      {/* Meeting Screen Recording Video Player / Google Drive Streaming Player (revealed on button click) */}
      {isVideoPlayerOpen && hasVideoRecording && (
        <MeetingVideoPlayer
          meetingId={meetingId}
          folderPath={meetingFolderPath}
          hasVideo={hasVideo}
          recorderId={recorderId}
          recorderEmail={recorderEmail}
          projectId={projectId}
          driveFileId={driveFileId}
          videoUrl={videoUrl}
          uploadStatus={uploadStatus}
          onClose={() => setIsVideoPlayerOpen(false)}
        />
      )}

      {/* Transcript content - use virtualized view for better performance */}
      <div className="flex-1 overflow-hidden pb-4">
        <VirtualizedTranscriptView
          segments={convertedSegments}
          isRecording={isRecording}
          isPaused={false}
          isProcessing={false}
          isStopping={false}
          enableStreaming={false}
          showConfidence={true}
          disableAutoScroll={disableAutoScroll}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          totalCount={totalCount}
          loadedCount={loadedCount}
          onLoadMore={onLoadMore}
        />
      </div>

      {/* Custom prompt input at bottom of transcript section */}
      {!isRecording && convertedSegments.length > 0 && (
        <div className="p-1 border-t border-gray-200">
          <textarea
            placeholder="Add context for AI summary. For example people involved, meeting overview, objective etc..."
            className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 bg-white shadow-sm min-h-[80px] resize-y"
            value={customPrompt}
            onChange={(e) => onPromptChange(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
