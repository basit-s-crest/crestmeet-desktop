'use client';

import React from 'react';
import { useGoogleDriveUpload } from '@/contexts/GoogleDriveUploadContext';
import {
  Cloud,
  CloudUpload,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  X,
  RotateCcw,
  Sparkles,
} from 'lucide-react';

export function UploadProgressWidget() {
  const { activeUploads, connectDrive, retryUpload } = useGoogleDriveUpload();
  const uploadsList = Object.values(activeUploads);

  if (uploadsList.length === 0) {
    return null;
  }

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-auto select-none">
      {uploadsList.map((job) => {
        const isMerging = job.status === 'merging';
        const isUploading = job.status === 'uploading' || job.status === 'checking_drive';
        const isCompleted = job.status === 'completed';
        const isNotConnected = job.status === 'not_connected';
        const isError = job.status === 'error';

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
                  : isNotConnected
                  ? 'bg-gradient-to-r from-amber-500 to-orange-400'
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
                    : isNotConnected
                    ? 'bg-amber-50 text-amber-600'
                    : 'bg-blue-50 text-blue-600'
                }`}
              >
                {isCompleted ? (
                  <CheckCircle2 size={20} className="stroke-[2.5]" />
                ) : isError ? (
                  <AlertCircle size={20} />
                ) : isNotConnected ? (
                  <Cloud size={20} />
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
                      : isCompleted
                      ? 'Uploaded to Google Drive'
                      : isNotConnected
                      ? 'Connect Google Drive'
                      : 'Upload Failed'}
                  </h4>

                  {isUploading && (
                    <span className="text-[11px] font-mono font-semibold text-blue-600">
                      {job.progress}%
                    </span>
                  )}
                </div>

                <p className="mt-0.5 text-[11px] text-gray-500 leading-snug truncate">
                  {isMerging
                    ? 'Merging meeting video and audio tracks'
                    : isUploading
                    ? 'Streaming chunks to cloud storage...'
                    : isCompleted
                    ? 'Team members can now stream recording'
                    : isNotConnected
                    ? 'Sync recordings to cloud for project access'
                    : job.error || 'Failed to upload video'}
                </p>

                {/* Progress bar for active uploads */}
                {(isUploading || isMerging) && (
                  <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-blue-600 to-indigo-600 transition-all duration-300"
                      style={{ width: `${Math.max(5, job.progress)}%` }}
                    />
                  </div>
                )}

                {/* Actions */}
                {isNotConnected && (
                  <div className="mt-2.5 flex items-center gap-2">
                    <button
                      onClick={() => connectDrive()}
                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 active:scale-95 transition-all shadow-xs cursor-pointer"
                    >
                      <Sparkles size={12} />
                      <span>Connect Drive</span>
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
