'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useProject } from '@/contexts/ProjectContext';
import { useGoogleDriveUpload } from '@/contexts/GoogleDriveUploadContext';
import { useAuth } from '@/contexts/AuthContext';
import { storageService, Meeting } from '@/services/storageService';
import {
  Inbox,
  Check,
  X,
  Loader2,
  Folder,
  Shield,
  RotateCcw,
  Sparkles,
  Bell,
  MailOpen,
  CloudUpload,
  CloudOff,
  AlertCircle,
  Play,
  CheckCircle2,
  Cloud,
} from 'lucide-react';
import { toast } from 'sonner';

interface UploadAlertItem {
  meetingId: string;
  meetingTitle: string;
  folderPath?: string;
  status: 'error' | 'not_connected' | 'paused' | 'pending' | 'uploading' | 'merging';
  error?: string | null;
  progress?: number;
  createdAt?: string;
}

export function InboxPopover() {
  const [isOpen, setIsOpen] = useState(false);
  const [mainTab, setMainTab] = useState<'uploads' | 'invitations'>('uploads');
  const [invTab, setInvTab] = useState<'pending' | 'history'>('pending');
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const { user } = useAuth();
  const {
    invitations,
    pendingInvitationsCount,
    isLoadingInvitations,
    refreshInvitations,
    respondToInvitation,
  } = useProject();

  const {
    activeUploads,
    driveStatus,
    connectDrive,
    retryUpload,
    resumeUpload,
  } = useGoogleDriveUpload();

  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [isLoadingMeetings, setIsLoadingMeetings] = useState(false);

  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Fetch recent meetings to identify any failed or pending uploads
  const fetchMeetings = useCallback(async () => {
    try {
      setIsLoadingMeetings(true);
      const data = await storageService.getMeetings();
      setMeetings(data || []);
    } catch (err) {
      console.warn('[InboxPopover] Could not fetch meetings for upload status:', err);
    } finally {
      setIsLoadingMeetings(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchMeetings();
    }
  }, [isOpen, fetchMeetings]);

  // Close on outside click or Escape
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleRespond = async (invitationId: string, accept: boolean) => {
    try {
      setRespondingId(invitationId);
      const success = await respondToInvitation(invitationId, accept);
      if (success) {
        toast.success(accept ? 'Invitation accepted!' : 'Invitation declined', {
          description: accept ? 'You are now a member of this project.' : undefined,
        });
      }
    } catch (err: any) {
      toast.error('Action failed', {
        description: err.message || 'Could not update invitation.',
      });
    } finally {
      setRespondingId(null);
    }
  };

  const handleRetryUpload = async (meetingId: string, folderPath?: string) => {
    try {
      setRetryingId(meetingId);
      await retryUpload(meetingId, folderPath || '');
      toast.info('Starting Google Drive upload...');
      await fetchMeetings();
    } catch (err: any) {
      toast.error('Could not start upload', {
        description: typeof err === 'string' ? err : err?.message || 'Upload failed to start',
      });
    } finally {
      setRetryingId(null);
    }
  };

  const handleConnectDrive = async () => {
    try {
      toast.info('Opening Google Drive connection...');
      await connectDrive(user?.email);
    } catch (err: any) {
      toast.error('Google Drive connection failed', {
        description: err?.message || 'Could not initiate connection.',
      });
    }
  };

  // Compile upload alert items for the current user
  const uploadAlerts: UploadAlertItem[] = [];
  const processedMeetingIds = new Set<string>();

  // 1. From active uploads (live in-memory jobs)
  Object.entries(activeUploads).forEach(([meetingId, job]) => {
    const meeting = meetings.find((m) => m.id === meetingId);
    processedMeetingIds.add(meetingId);

    const isMyMeeting = meeting
      ? !meeting.user_id ||
        (user?.id && meeting.user_id.toLowerCase() === user.id.toLowerCase()) ||
        (meeting.user_email && user?.email && meeting.user_email.toLowerCase() === user.email.toLowerCase())
      : true;

    if (!isMyMeeting) return;

    if (
      job.status === 'error' ||
      job.status === 'not_connected' ||
      job.status === 'paused' ||
      job.status === 'uploading' ||
      job.status === 'merging'
    ) {
      uploadAlerts.push({
        meetingId,
        meetingTitle: meeting?.title || 'Meeting Recording',
        folderPath: meeting?.folder_path ? meeting.folder_path : undefined,
        status: job.status as any,
        error: job.error ? job.error : undefined,
        progress: job.progress,
      });
    }
  });

  // 2. From persisted database meetings (failed or pending uploads on this device)
  meetings.forEach((m) => {
    if (processedMeetingIds.has(m.id)) return;
    if (!m.has_video) return;

    const isMyMeeting =
      !m.user_id ||
      (user?.id && m.user_id.toLowerCase() === user.id.toLowerCase()) ||
      (m.user_email && user?.email && m.user_email.toLowerCase() === user.email.toLowerCase());

    if (!isMyMeeting) return;

    if (m.upload_status === 'failed') {
      uploadAlerts.push({
        meetingId: m.id,
        meetingTitle: m.title,
        folderPath: m.folder_path ? m.folder_path : undefined,
        status: 'error',
        error: 'Automatic upload to Google Drive failed.',
        createdAt: m.created_at,
      });
    } else if (!m.drive_file_id && m.is_local_file_available && m.upload_status !== 'completed') {
      uploadAlerts.push({
        meetingId: m.id,
        meetingTitle: m.title,
        folderPath: m.folder_path ? m.folder_path : undefined,
        status: driveStatus && !driveStatus.is_connected ? 'not_connected' : 'pending',
        error: driveStatus && !driveStatus.is_connected ? 'Google Drive is not connected.' : 'Pending upload to Google Drive.',
        createdAt: m.created_at,
      });
    }
  });

  const failedUploadsCount = uploadAlerts.filter((u) => u.status === 'error' || u.status === 'not_connected').length;
  const pendingUploadsCount = uploadAlerts.filter((u) => u.status === 'pending').length;
  const totalUploadIssuesCount = failedUploadsCount + pendingUploadsCount;

  const pendingList = invitations.filter((inv) => inv.status === 'pending');
  const historyList = invitations.filter((inv) => inv.status !== 'pending');

  const totalBadgeCount = pendingInvitationsCount + failedUploadsCount;

  // Auto-select tab when opened if one category has issues
  const handleOpen = () => {
    if (!isOpen) {
      if (failedUploadsCount > 0) {
        setMainTab('uploads');
      } else if (pendingInvitationsCount > 0) {
        setMainTab('invitations');
      }
    }
    setIsOpen((prev) => !prev);
  };

  return (
    <div className="relative inline-block text-left">
      {/* Extension-style notification button */}
      <button
        ref={buttonRef}
        type="button"
        onClick={handleOpen}
        className={`relative flex items-center justify-center w-9 h-9 rounded-xl border transition-all duration-200 cursor-pointer shadow-xs ${
          isOpen
            ? 'bg-blue-50 border-blue-300 text-blue-600 shadow-sm ring-2 ring-blue-100'
            : failedUploadsCount > 0
            ? 'bg-rose-50/80 hover:bg-rose-100/80 border-rose-200 text-rose-600'
            : pendingInvitationsCount > 0
            ? 'bg-blue-50/80 hover:bg-blue-100/80 border-blue-200 text-blue-600'
            : 'bg-white/90 hover:bg-white border-gray-200/90 hover:border-gray-300 text-gray-600 hover:text-gray-900 backdrop-blur-sm'
        }`}
        title="Notifications & Upload Alerts"
        aria-label="Notifications"
      >
        <Bell
          size={17}
          className={
            failedUploadsCount > 0
              ? 'text-rose-600'
              : pendingInvitationsCount > 0
              ? 'text-blue-600'
              : 'text-gray-500'
          }
        />

        {/* Badge count */}
        {totalBadgeCount > 0 && (
          <span
            className={`absolute -top-1 -right-1 flex h-4 min-w-[16px] px-1 items-center justify-center rounded-full text-[10px] font-bold text-white shadow-xs animate-in zoom-in-75 ${
              failedUploadsCount > 0 ? 'bg-rose-600' : 'bg-blue-600'
            }`}
          >
            {totalBadgeCount}
          </span>
        )}
      </button>

      {/* Dropdown Notification Box */}
      {isOpen && (
        <div
          ref={popoverRef}
          className="absolute right-0 top-11 z-50 w-88 md:w-96 rounded-2xl border border-gray-200/90 bg-white shadow-2xl overflow-hidden animate-in fade-in-0 zoom-in-95 duration-150"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50/70">
            <div className="flex items-center space-x-2">
              <div
                className={`w-7 h-7 rounded-lg flex items-center justify-center font-semibold ${
                  failedUploadsCount > 0 ? 'bg-rose-100 text-rose-600' : 'bg-blue-100 text-blue-600'
                }`}
              >
                <Inbox size={15} />
              </div>
              <div>
                <h3 className="text-xs font-bold text-gray-800 flex items-center gap-1.5">
                  <span>Notifications</span>
                  {totalBadgeCount > 0 && (
                    <span
                      className={`px-1.5 py-0.2 rounded-full text-[10px] font-bold text-white ${
                        failedUploadsCount > 0 ? 'bg-rose-600' : 'bg-blue-600'
                      }`}
                    >
                      {totalBadgeCount}
                    </span>
                  )}
                </h3>
                <p className="text-[10px] text-gray-400">Team invites & video upload status</p>
              </div>
            </div>

            <div className="flex items-center space-x-1">
              <button
                type="button"
                onClick={() => {
                  refreshInvitations();
                  fetchMeetings();
                }}
                title="Refresh notifications"
                className="p-1 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors cursor-pointer"
              >
                <RotateCcw
                  size={13}
                  className={isLoadingInvitations || isLoadingMeetings ? 'animate-spin text-blue-600' : ''}
                />
              </button>

              <button
                type="button"
                onClick={() => setIsOpen(false)}
                title="Close"
                className="p-1 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {/* Main Tabs: Uploads vs Invitations */}
          <div className="flex border-b border-gray-100 px-3 pt-2 bg-white text-xs">
            <button
              onClick={() => setMainTab('uploads')}
              className={`pb-2 px-3 font-medium border-b-2 transition-all cursor-pointer flex items-center gap-1.5 ${
                mainTab === 'uploads'
                  ? 'border-blue-600 text-blue-600 font-semibold'
                  : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              <CloudUpload size={13} />
              <span>Uploads</span>
              {totalUploadIssuesCount > 0 && (
                <span
                  className={`px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
                    failedUploadsCount > 0 ? 'bg-rose-100 text-rose-700' : 'bg-blue-100 text-blue-700'
                  }`}
                >
                  {totalUploadIssuesCount}
                </span>
              )}
            </button>

            <button
              onClick={() => setMainTab('invitations')}
              className={`pb-2 px-3 font-medium border-b-2 transition-all cursor-pointer flex items-center gap-1.5 ${
                mainTab === 'invitations'
                  ? 'border-blue-600 text-blue-600 font-semibold'
                  : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              <MailOpen size={13} />
              <span>Invitations</span>
              {pendingInvitationsCount > 0 && (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-blue-100 text-blue-700">
                  {pendingInvitationsCount}
                </span>
              )}
            </button>
          </div>

          {/* Tab 1: Uploads List */}
          {mainTab === 'uploads' && (
            <div className="max-h-[360px] overflow-y-auto p-3 space-y-2.5">
              {/* If Google Drive is completely disconnected */}
              {driveStatus && !driveStatus.is_connected && (
                <div className="p-3 rounded-xl border border-amber-200 bg-amber-50/70 shadow-2xs">
                  <div className="flex items-start gap-2.5">
                    <CloudOff className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <h4 className="text-xs font-semibold text-amber-900">Google Drive Disconnected</h4>
                      <p className="text-[11px] text-amber-700 mt-0.5">
                        Connect Google Drive to auto-upload and sync meeting recordings with your team.
                      </p>
                      <button
                        type="button"
                        onClick={handleConnectDrive}
                        className="mt-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-600 text-white hover:bg-amber-700 transition-all shadow-2xs cursor-pointer"
                      >
                        <Cloud size={12} />
                        <span>Connect Google Drive</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Uploads list items */}
              {uploadAlerts.length === 0 ? (
                <div className="py-8 text-center px-4">
                  <div className="w-10 h-10 mx-auto rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mb-2">
                    <CheckCircle2 size={18} />
                  </div>
                  <p className="text-xs font-semibold text-gray-700">All uploads up to date</p>
                  <p className="text-[11px] text-gray-400 mt-0.5">
                    Meeting recordings with video will automatically sync to Google Drive.
                  </p>
                </div>
              ) : (
                uploadAlerts.map((item) => {
                  const isRetrying = retryingId === item.meetingId;
                  const isFailed = item.status === 'error';
                  const isUploading = item.status === 'uploading' || item.status === 'merging';
                  const isPaused = item.status === 'paused';

                  return (
                    <div
                      key={item.meetingId}
                      className={`p-3 rounded-xl border shadow-2xs transition-all ${
                        isFailed
                          ? 'border-rose-200/90 bg-rose-50/40 hover:bg-rose-50/70'
                          : isUploading
                          ? 'border-blue-200/90 bg-blue-50/40'
                          : isPaused
                          ? 'border-amber-200/90 bg-amber-50/40'
                          : 'border-gray-200/90 bg-white hover:bg-gray-50/50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            {isFailed ? (
                              <AlertCircle size={14} className="text-rose-600 shrink-0" />
                            ) : isUploading ? (
                              <Loader2 size={14} className="text-blue-600 animate-spin shrink-0" />
                            ) : (
                              <CloudUpload size={14} className="text-blue-600 shrink-0" />
                            )}
                            <h4 className="text-xs font-bold text-gray-900 truncate">
                              {item.meetingTitle}
                            </h4>
                          </div>

                          <p className="text-[11px] text-gray-600 mt-1 truncate">
                            {item.error ||
                              (isUploading
                                ? `Syncing to Drive (${item.progress ?? 0}%)`
                                : isPaused
                                ? 'Upload is paused'
                                : 'Pending upload to Google Drive')}
                          </p>
                        </div>

                        {/* Action badge / button */}
                        <div className="shrink-0">
                          {isFailed || item.status === 'pending' || item.status === 'not_connected' ? (
                            <button
                              type="button"
                              disabled={isRetrying}
                              onClick={() => handleRetryUpload(item.meetingId, item.folderPath)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 active:scale-95 disabled:opacity-60 transition-all shadow-2xs cursor-pointer"
                              title="Upload recording to Google Drive"
                            >
                              {isRetrying ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <CloudUpload size={12} />
                              )}
                              <span>{isFailed ? 'Retry' : 'Upload'}</span>
                            </button>
                          ) : isPaused ? (
                            <button
                              type="button"
                              onClick={() => resumeUpload(item.meetingId, item.folderPath || '')}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-600 text-white hover:bg-amber-700 active:scale-95 transition-all shadow-2xs cursor-pointer"
                            >
                              <Play size={11} className="fill-current" />
                              <span>Resume</span>
                            </button>
                          ) : isUploading ? (
                            <span className="text-[11px] font-mono font-semibold text-blue-600 bg-blue-100/80 px-2 py-0.5 rounded-md">
                              {item.progress ?? 0}%
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* Tab 2: Project Invitations */}
          {mainTab === 'invitations' && (
            <>
              {/* Sub-tabs for invitations */}
              <div className="flex border-b border-gray-100 px-3 pt-2 bg-gray-50/40 text-[11px]">
                <button
                  onClick={() => setInvTab('pending')}
                  className={`pb-1.5 px-2 font-medium border-b-2 transition-all cursor-pointer ${
                    invTab === 'pending'
                      ? 'border-blue-600 text-blue-600 font-semibold'
                      : 'border-transparent text-gray-500 hover:text-gray-800'
                  }`}
                >
                  Pending ({pendingList.length})
                </button>
                <button
                  onClick={() => setInvTab('history')}
                  className={`pb-1.5 px-2 font-medium border-b-2 transition-all cursor-pointer ${
                    invTab === 'history'
                      ? 'border-blue-600 text-blue-600 font-semibold'
                      : 'border-transparent text-gray-500 hover:text-gray-800'
                  }`}
                >
                  History ({historyList.length})
                </button>
              </div>

              <div className="max-h-[360px] overflow-y-auto p-3 space-y-2.5">
                {isLoadingInvitations && invitations.length === 0 ? (
                  <div className="py-8 flex flex-col items-center justify-center text-gray-400">
                    <Loader2 size={20} className="animate-spin text-blue-600 mb-2" />
                    <span className="text-xs">Loading invitations...</span>
                  </div>
                ) : invTab === 'pending' ? (
                  pendingList.length === 0 ? (
                    <div className="py-8 text-center px-4">
                      <div className="w-10 h-10 mx-auto rounded-full bg-blue-50 text-blue-500 flex items-center justify-center mb-2">
                        <MailOpen size={18} />
                      </div>
                      <p className="text-xs font-semibold text-gray-700">No pending invitations</p>
                      <p className="text-[11px] text-gray-400 mt-0.5">
                        When someone invites you to a project, it will appear right here.
                      </p>
                    </div>
                  ) : (
                    pendingList.map((inv) => {
                      const isResponding = respondingId === inv.id;
                      return (
                        <div
                          key={inv.id}
                          className="p-3 rounded-xl border border-gray-100 bg-white hover:border-blue-100 hover:bg-blue-50/20 shadow-2xs transition-all"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-start space-x-2.5 min-w-0">
                              <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0 mt-0.5">
                                <Folder size={15} />
                              </div>
                              <div className="min-w-0">
                                <h4 className="text-xs font-bold text-gray-900 truncate">
                                  {inv.project_name}
                                </h4>
                                <p className="text-[11px] text-gray-500 truncate">
                                  Invited by{' '}
                                  <span className="text-gray-700 font-medium">
                                    {inv.invited_by_email || 'Project Admin'}
                                  </span>
                                </p>
                              </div>
                            </div>

                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-700 uppercase tracking-wider shrink-0">
                              <Shield size={10} />
                              <span>{inv.role}</span>
                            </span>
                          </div>

                          {/* Action buttons */}
                          <div className="mt-3 flex items-center gap-2">
                            <button
                              type="button"
                              disabled={isResponding}
                              onClick={() => handleRespond(inv.id, true)}
                              className="flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 active:scale-98 disabled:opacity-60 transition-all shadow-xs cursor-pointer"
                            >
                              {isResponding ? (
                                <Loader2 size={13} className="animate-spin" />
                              ) : (
                                <>
                                  <Check size={13} className="stroke-[2.5]" />
                                  <span>Accept</span>
                                </>
                              )}
                            </button>

                            <button
                              type="button"
                              disabled={isResponding}
                              onClick={() => handleRespond(inv.id, false)}
                              className="inline-flex items-center justify-center gap-1 py-1.5 px-3 rounded-lg text-xs font-medium text-gray-600 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 active:scale-98 disabled:opacity-60 transition-all cursor-pointer"
                            >
                              <X size={13} />
                              <span>Decline</span>
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )
                ) : historyList.length === 0 ? (
                  <div className="py-8 text-center text-xs text-gray-400">
                    No past invitation history.
                  </div>
                ) : (
                  historyList.map((inv) => (
                    <div
                      key={inv.id}
                      className="p-2.5 rounded-xl border border-gray-100 bg-gray-50/50 flex items-center justify-between text-xs"
                    >
                      <div className="min-w-0 pr-2">
                        <p className="font-semibold text-gray-800 truncate">{inv.project_name}</p>
                        <p className="text-[10px] text-gray-400 truncate">
                          {inv.invited_by_email || 'Invited to collaborate'}
                        </p>
                      </div>

                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold capitalize shrink-0 ${
                          inv.status === 'accepted'
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60'
                            : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {inv.status}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
