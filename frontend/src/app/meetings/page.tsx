'use client';

import React, { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Calendar,
  Clock,
  Search,
  Plus,
  Trash2,
  Pencil,
  FileText,
  Sparkles,
  ArrowRight,
  SlidersHorizontal,
  X
} from 'lucide-react';
import { useSidebar, CurrentMeeting } from '@/components/Sidebar/SidebarProvider';
import { useAuth } from '@/contexts/AuthContext';
import {
  formatMeetingDate,
  formatMeetingTime,
  getRelativeTime,
  cleanMeetingTitle
} from '@/lib/dateUtils';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { ConfirmationModal } from '@/components/ConfirmationModel/confirmation-modal';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { VisuallyHidden } from '@/components/ui/visually-hidden';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function MeetingsPage() {
  const router = useRouter();
  const { meetings, setMeetings, setCurrentMeeting } = useSidebar();
  const { user } = useAuth();

  const [searchQuery, setSearchQuery] = useState('');
  const [deleteModalState, setDeleteModalState] = useState<{ isOpen: boolean; meetingId: string | null }>({
    isOpen: false,
    meetingId: null
  });
  const [editModalState, setEditModalState] = useState<{
    isOpen: boolean;
    meetingId: string | null;
    currentTitle: string;
  }>({
    isOpen: false,
    meetingId: null,
    currentTitle: ''
  });
  const [editingTitle, setEditingTitle] = useState('');

  // Filter meetings by search query
  const filteredMeetings = useMemo(() => {
    if (!searchQuery.trim()) return meetings;
    const query = searchQuery.toLowerCase();
    return meetings.filter(m => {
      const titleMatch = m.title.toLowerCase().includes(query);
      const cleanedTitleMatch = cleanMeetingTitle(m.title, m.created_at).toLowerCase().includes(query);
      const dateMatch = m.created_at ? formatMeetingDate(m.created_at).toLowerCase().includes(query) : false;
      return titleMatch || cleanedTitleMatch || dateMatch;
    });
  }, [meetings, searchQuery]);

  // Meeting deletion
  const handleDeleteConfirm = async () => {
    const meetingId = deleteModalState.meetingId;
    if (!meetingId) return;

    try {
      await invoke('api_delete_meeting', { meetingId });
      setMeetings(meetings.filter(m => m.id !== meetingId));
      toast.success('Meeting deleted successfully');
    } catch (err: any) {
      console.error('Failed to delete meeting:', err);
      toast.error('Failed to delete meeting', {
        description: err?.toString() || 'Unknown error'
      });
    } finally {
      setDeleteModalState({ isOpen: false, meetingId: null });
    }
  };

  // Meeting title update
  const handleEditConfirm = async () => {
    const meetingId = editModalState.meetingId;
    const newTitle = editingTitle.trim();
    if (!meetingId || !newTitle) {
      toast.error('Title cannot be empty');
      return;
    }

    try {
      await invoke('api_save_meeting_title', {
        meetingId,
        title: newTitle
      });
      setMeetings(meetings.map(m => (m.id === meetingId ? { ...m, title: newTitle } : m)));
      toast.success('Meeting title updated');
      setEditModalState({ isOpen: false, meetingId: null, currentTitle: '' });
      setEditingTitle('');
    } catch (err: any) {
      console.error('Failed to update title:', err);
      toast.error('Failed to update title', {
        description: err?.toString() || 'Unknown error'
      });
    }
  };

  const navigateToMeeting = (meeting: CurrentMeeting) => {
    setCurrentMeeting(meeting);
    router.push(`/meeting-details?id=${meeting.id}`);
  };

  return (
    <div className="min-h-screen bg-slate-50/60 p-6 md:p-10 flex flex-col">
      {/* Top Header */}
      <div className="max-w-6xl mx-auto w-full mb-8">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
                Meeting Notes
              </h1>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200/60">
                {meetings.length} {meetings.length === 1 ? 'meeting' : 'meetings'}
              </span>
            </div>
            <p className="text-sm text-slate-500 mt-1">
              Browse all your recorded meetings, transcriptions, and generated AI summaries.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/')}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-xl shadow-sm hover:shadow transition-all"
            >
              <Plus className="w-4 h-4" />
              <span>New Call / Record</span>
            </button>
          </div>
        </div>

        {/* Search & Filter Bar */}
        <div className="mt-6 flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search meetings by title, keyword, or date..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-10 py-2.5 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all placeholder:text-slate-400 shadow-sm"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Meetings Grid / List */}
      <div className="max-w-6xl mx-auto w-full flex-1">
        {filteredMeetings.length === 0 ? (
          <div className="bg-white border border-slate-200/80 rounded-2xl p-12 text-center shadow-sm max-w-lg mx-auto my-12">
            <div className="w-14 h-14 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-indigo-100">
              <FileText className="w-7 h-7" />
            </div>
            <h3 className="text-lg font-semibold text-slate-900">
              {searchQuery ? 'No matching meetings found' : 'No meetings yet'}
            </h3>
            <p className="text-sm text-slate-500 mt-1.5 max-w-sm mx-auto">
              {searchQuery
                ? `No meetings match "${searchQuery}". Try clearing your search or using a different query.`
                : 'Start your first call recording to automatically transcribe speech and generate AI summaries.'}
            </p>
            {searchQuery ? (
              <button
                onClick={() => setSearchQuery('')}
                className="mt-5 px-4 py-2 text-sm font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors"
              >
                Clear Search
              </button>
            ) : (
              <button
                onClick={() => router.push('/')}
                className="mt-5 inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-sm transition-all"
              >
                <Plus className="w-4 h-4" />
                <span>Start Recording</span>
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
            {filteredMeetings.map((meeting) => {
              const displayTitle = cleanMeetingTitle(meeting.title, meeting.created_at);
              const formattedDate = meeting.created_at ? formatMeetingDate(meeting.created_at) : null;
              const formattedTime = meeting.created_at ? formatMeetingTime(meeting.created_at) : null;
              const relativeTag = meeting.created_at ? getRelativeTime(meeting.created_at) : null;

              return (
                <div
                  key={meeting.id}
                  onClick={() => navigateToMeeting(meeting)}
                  className="group relative bg-white border border-slate-200/90 hover:border-indigo-300 rounded-2xl p-5 shadow-sm hover:shadow-md transition-all duration-200 cursor-pointer flex flex-col justify-between"
                >
                  <div>
                    {/* Top row: relative badge + actions */}
                    <div className="flex items-center justify-between gap-2 mb-2.5">
                      {relativeTag ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-slate-100 text-slate-600 border border-slate-200/60">
                          {relativeTag}
                        </span>
                      ) : (
                        <span />
                      )}

                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingTitle(meeting.title);
                            setEditModalState({
                              isOpen: true,
                              meetingId: meeting.id,
                              currentTitle: meeting.title
                            });
                          }}
                          className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                          title="Edit Title"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteModalState({
                              isOpen: true,
                              meetingId: meeting.id
                            });
                          }}
                          className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                          title="Delete Meeting"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Title */}
                    <h3 className="text-base font-semibold text-slate-900 group-hover:text-indigo-600 transition-colors line-clamp-2 leading-snug">
                      {displayTitle}
                    </h3>
                  </div>

                  {/* Date, Time & Open Action */}
                  <div className="mt-5 pt-3.5 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
                    <div className="flex flex-col gap-0.5">
                      {formattedDate && (
                        <div className="flex items-center gap-1.5 text-slate-600 font-medium">
                          <Calendar className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                          <span>{formattedDate}</span>
                        </div>
                      )}
                      {formattedTime && (
                        <div className="flex items-center gap-1.5 text-slate-400">
                          <Clock className="w-3 h-3 text-slate-400 shrink-0" />
                          <span>{formattedTime}</span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-1 text-indigo-600 font-medium group-hover:translate-x-0.5 transition-transform">
                      <span>Notes</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={deleteModalState.isOpen}
        onCancel={() => setDeleteModalState({ isOpen: false, meetingId: null })}
        onConfirm={handleDeleteConfirm}
        text="Are you sure you want to delete this meeting? All transcripts and AI summaries associated with it will be permanently removed."
      />

      {/* Edit Title Modal */}
      <Dialog
        open={editModalState.isOpen}
        onOpenChange={(open) => !open && setEditModalState({ isOpen: false, meetingId: null, currentTitle: '' })}
      >
        <DialogContent className="sm:max-w-md">
          <VisuallyHidden>
            <DialogTitle>Edit Meeting Title</DialogTitle>
          </VisuallyHidden>
          <div className="p-4">
            <h3 className="text-lg font-semibold text-slate-900 mb-2">Edit Meeting Title</h3>
            <p className="text-xs text-slate-500 mb-4">
              Enter a new title for this meeting.
            </p>
            <Input
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              placeholder="e.g. Weekly Product Sync"
              className="w-full"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleEditConfirm();
                }
              }}
            />
          </div>
          <DialogFooter className="flex justify-end gap-2 px-4 pb-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditModalState({ isOpen: false, meetingId: null, currentTitle: '' })}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleEditConfirm}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              Save Title
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
