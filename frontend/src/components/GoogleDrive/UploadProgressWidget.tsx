'use client';

import React from 'react';
import { useGoogleDriveUpload } from '@/contexts/GoogleDriveUploadContext';
import {
  Cloud,
  CloudUpload,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Sparkles,
  Pause,
  Play,
  RotateCcw,
  X,
} from 'lucide-react';

export function UploadProgressWidget() {
  const {
    activeUploads,
    driveStatus,
    connectDrive,
    pauseUpload,
    resumeUpload,
    retryUpload,
    dismissUpload,
  } = useGoogleDriveUpload();
  const uploadsList = Object.values(activeUploads);

  if (uploadsList.length === 0) {
    return null;
  }

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-auto select-none">
      {uploadsList.map((job) => {
        const isMerging = job.status === 'merging';
        const isUploading = job.status === 'uploading' || job.status === 'checking_drive';
        const isPaused = job.status === 'paused';
        const isCompleted = job.status === 'completed';
        const isNotConnected = job.status === 'not_connected';
        const isError = job.status === 'error';
        const isDriveLinked = Boolean(driveStatus?.is_connected);

        return (
          <div
            key={job.meeting_id}
            className="group relative overflow-hidden rounded-2xl border border-gray-200/80 bg-white/95 p-4 shadow-xl backdrop-blur-md transition-all duration-300 hover:shadow-2xl"
          >
            {/* Top Accent Gradient Bar */}
            <div
              className={`absolute top-0 left-0 right-0 h-1 ${
                isCompleted
                  ? 'bg-gradient-to-r from-emerald-500 to-teal-400'
                  : isError
                  ? 'bg-gradient-to-r from-rose-500 to-red-400'
                  : isPaused
                  ? 'bg-gradient-to-r from-amber-400 to-orange-400'
                  : isNotConnected
                  ? isDriveLinked
                    ? 'bg-gradient-to-r from-blue-500 to-indigo-500'
                    : 'bg-gradient-to-r from-amber-500 to-orange-400'
                  : 'bg-gradient-to-r from-blue-600 via-indigo-500 to-purple-500 animate-pulse'
              }`}
            />

            <div className="flex items-start gap-3">
              {/* Icon Box */}
              <div
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 group-hover:scale-105 ${
                  isCompleted
                    ? 'bg-emerald-50 text-emerald-600'
                    : isError
                    ? 'bg-rose-50 text-rose-600'
                    : isPaused
                    ? 'bg-amber-50 text-amber-600'
                    : isNotConnected
                    ? isDriveLinked
                      ? 'bg-blue-50 text-blue-600'
                      : 'bg-amber-50 text-amber-600'
                    : 'bg-blue-50 text-blue-600'
                }`}
              >
                {isCompleted ? (
                  <CheckCircle2 size={20} className="stroke-[2.5]" />
                ) : isError ? (
                  <AlertCircle size={20} />
                ) : isPaused ? (
                  <Pause size={20} className="stroke-[2.5]" />
                ) : isNotConnected ? (
                  isDriveLinked ? <CloudUpload size={20} /> : <Cloud size={20} />
                ) : (
                  <CloudUpload size={20} className="animate-bounce" />
                )}
              </div>

              {/* Text & Progress Details */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-gray-900 truncate">
                    {isMerging
                      ? 'Optimizing Video...'
                      : isUploading
                      ? 'Uploading to Google Drive'
                      : isPaused
                      ? 'Upload Paused'
                      : isCompleted
                      ? 'Uploaded to Google Drive'
                      : isNotConnected
                      ? isDriveLinked
                        ? 'Ready to Sync'
                        : 'Connect Google Drive'
                      : 'Upload Failed'}
                  </h4>

                  <div className="flex items-center gap-1.5">
                    {isUploading && (
                      <span className="text-[11px] font-mono font-semibold text-blue-600">
                        {job.progress}%
                      </span>
                    )}

                    {/* Pause Button */}
                    {isUploading && (
                      <button
                        onClick={() => pauseUpload(job.meeting_id)}
                        className="p-1 rounded-md text-gray-400 hover:text-amber-600 hover:bg-amber-50 transition-colors cursor-pointer"
                        title="Pause Upload"
                      >
                        <Pause size={12} />
                      </button>
                    )}

                    {/* Resume Button */}
                    {isPaused && (
                      <button
                        onClick={() => resumeUpload(job.meeting_id, '')}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-amber-500 text-white hover:bg-amber-600 active:scale-95 transition-all shadow-xs cursor-pointer"
                        title="Resume Upload"
                      >
                        <Play size={10} fill="currentColor" />
                        <span>Resume</span>
                      </button>
                    )}

                    {/* Dismiss Button (always available when not uploading or merging) */}
                    {(!isUploading && !isMerging) && (
                      <button
                        onClick={() => dismissUpload(job.meeting_id)}
                        className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors cursor-pointer"
                        title="Dismiss notification"
                      >
                        <X size={13} />
                      </button>
                    )}
                  </div>
                </div>

                <p className="mt-0.5 text-[11px] text-gray-500 leading-snug truncate">
                  {isMerging
                    ? 'Transcoding H.264 & syncing audio tracks'
                    : isUploading
                    ? 'Streaming chunks to cloud storage...'
                    : isPaused
                    ? 'Upload halted · Click resume to continue'
                    : isCompleted
                    ? 'Team members can now stream recording'
                    : isNotConnected
                    ? isDriveLinked
                      ? 'Drive connected. Click below to start sync.'
                      : 'Sync recordings to cloud for project access'
                    : job.error || 'Failed to upload video'}
                </p>

                {/* Progress bar for active uploads */}
                {(isUploading || isMerging || isPaused) && (
                  <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        isPaused
                          ? 'bg-amber-400'
                          : 'bg-gradient-to-r from-blue-600 to-indigo-600'
                      }`}
                      style={{ width: `${Math.max(5, job.progress)}%` }}
                    />
                  </div>
                )}

                {/* Actions */}
                {isNotConnected && (
                  <div className="mt-2.5 flex items-center gap-2">
                    {isDriveLinked ? (
                      <button
                        onClick={() => retryUpload(job.meeting_id, '')}
                        className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 active:scale-95 transition-all shadow-xs cursor-pointer"
                      >
                        <CloudUpload size={12} />
                        <span>Upload to Drive</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => connectDrive()}
                        className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 active:scale-95 transition-all shadow-xs cursor-pointer"
                      >
                        <Sparkles size={12} />
                        <span>Connect Drive</span>
                      </button>
                    )}
                  </div>
                )}

                {isError && (
                  <div className="mt-2.5 flex items-center gap-2">
                    <button
                      onClick={() => retryUpload(job.meeting_id, '')}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200 active:scale-95 transition-all cursor-pointer"
                    >
                      <RotateCcw size={12} />
                      <span>Retry Upload</span>
                    </button>
                    <button
                      onClick={() => dismissUpload(job.meeting_id)}
                      className="px-2 py-1 rounded-lg text-xs font-medium text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-all cursor-pointer"
                    >
                      Dismiss
                    </button>
                  </div>
                )}

                {isCompleted && job.video_url && (
                  <div className="mt-2 flex items-center gap-2">
                    <a
                      href={job.video_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 hover:text-emerald-800 hover:underline"
                    >
                      <span>Preview in Drive</span>
                      <ExternalLink size={11} />
                    </a>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
