'use client';

import React, { useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Calendar as CalendarIcon,
  Clock,
  Search,
  Plus,
  Trash2,
  Pencil,
  FileText,
  ArrowRight,
  Filter,
  X,
  CalendarRange,
  ArrowUpDown,
  RotateCcw,
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

type DatePreset = 'all' | 'today' | 'yesterday' | 'last7' | 'thisMonth' | 'custom';
type SortOrder = 'newest' | 'oldest' | 'titleAsc' | 'titleDesc';

// Helper to convert Date to YYYY-MM-DD string in local time
function getLocalDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export default function MeetingsPage() {
  const router = useRouter();
  const { meetings, setMeetings, setCurrentMeeting } = useSidebar();
  const { user } = useAuth();

  // Search & Filters state
  const [searchQuery, setSearchQuery] = useState('');
  const [activePreset, setActivePreset] = useState<DatePreset>('all');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');

  // Modals state
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

  // Date boundary calculations for presets
  const todayStr = useMemo(() => getLocalDateString(new Date()), []);
  const yesterdayStr = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return getLocalDateString(d);
  }, []);
  const sevenDaysAgoStr = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return getLocalDateString(d);
  }, []);
  const firstDayOfMonthStr = useMemo(() => {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}-01`;
  }, []);

  // Handle Preset Selection
  const handleSelectPreset = (preset: DatePreset) => {
    setActivePreset(preset);
    switch (preset) {
      case 'all':
        setStartDate('');
        setEndDate('');
        break;
      case 'today':
        setStartDate(todayStr);
        setEndDate(todayStr);
        break;
      case 'yesterday':
        setStartDate(yesterdayStr);
        setEndDate(yesterdayStr);
        break;
      case 'last7':
        setStartDate(sevenDaysAgoStr);
        setEndDate(todayStr);
        break;
      case 'thisMonth':
        setStartDate(firstDayOfMonthStr);
        setEndDate(todayStr);
        break;
      default:
        break;
    }
  };

  // Handle manual date input changes
  const handleStartDateChange = (newStart: string) => {
    setStartDate(newStart);
    // If To date is empty or was previously the same as the old start date, set To date to match new start
    const newEnd = (!endDate || endDate === startDate) ? newStart : endDate;
    setEndDate(newEnd);
    checkAndSetPreset(newStart, newEnd);
  };

  const handleEndDateChange = (newEnd: string) => {
    setEndDate(newEnd);
    checkAndSetPreset(startDate, newEnd);
  };

  // Check if manual dates match any known preset
  const checkAndSetPreset = useCallback((s: string, e: string) => {
    if (!s && !e) {
      setActivePreset('all');
    } else if (s === todayStr && e === todayStr) {
      setActivePreset('today');
    } else if (s === yesterdayStr && e === yesterdayStr) {
      setActivePreset('yesterday');
    } else if (s === sevenDaysAgoStr && e === todayStr) {
      setActivePreset('last7');
    } else if (s === firstDayOfMonthStr && e === todayStr) {
      setActivePreset('thisMonth');
    } else {
      setActivePreset('custom');
    }
  }, [todayStr, yesterdayStr, sevenDaysAgoStr, firstDayOfMonthStr]);

  const handleClearDates = () => {
    setStartDate('');
    setEndDate('');
    setActivePreset('all');
  };

  const hasActiveFilters = searchQuery.trim() !== '' || activePreset !== 'all' || startDate !== '' || endDate !== '';

  const handleResetFilters = () => {
    setSearchQuery('');
    handleClearDates();
  };

  // Filter and sort meetings
  const filteredAndSortedMeetings = useMemo(() => {
    let result = [...meetings];

    // 1. Text Search Filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      result = result.filter((m) => {
        const titleMatch = m.title.toLowerCase().includes(query);
        const cleanedTitleMatch = cleanMeetingTitle(m.title, m.created_at).toLowerCase().includes(query);
        const dateMatch = m.created_at ? formatMeetingDate(m.created_at).toLowerCase().includes(query) : false;
        return titleMatch || cleanedTitleMatch || dateMatch;
      });
    }

    // 2. Date Filtering (Unified Range & Single Date)
    if (startDate || endDate) {
      result = result.filter((m) => {
        if (!m.created_at) return false;
        const meetingDate = new Date(m.created_at);
        if (isNaN(meetingDate.getTime())) return false;
        const meetingDateStr = getLocalDateString(meetingDate);

        if (startDate && endDate) {
          const actualStart = startDate <= endDate ? startDate : endDate;
          const actualEnd = startDate <= endDate ? endDate : startDate;
          return meetingDateStr >= actualStart && meetingDateStr <= actualEnd;
        } else if (startDate) {
          return meetingDateStr >= startDate;
        } else if (endDate) {
          return meetingDateStr <= endDate;
        }
        return true;
      });
    }

    // 3. Sorting
    result.sort((a, b) => {
      const timeA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const timeB = b.created_at ? new Date(b.created_at).getTime() : 0;

      switch (sortOrder) {
        case 'newest':
          return timeB - timeA;
        case 'oldest':
          return timeA - timeB;
        case 'titleAsc': {
          const titleA = cleanMeetingTitle(a.title, a.created_at).toLowerCase();
          const titleB = cleanMeetingTitle(b.title, b.created_at).toLowerCase();
          return titleA.localeCompare(titleB);
        }
        case 'titleDesc': {
          const titleA = cleanMeetingTitle(a.title, a.created_at).toLowerCase();
          const titleB = cleanMeetingTitle(b.title, b.created_at).toLowerCase();
          return titleB.localeCompare(titleA);
        }
        default:
          return timeB - timeA;
      }
    });

    return result;
  }, [
    meetings,
    searchQuery,
    startDate,
    endDate,
    sortOrder
  ]);

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

  // Navigate to meeting details
  const navigateToMeeting = (meeting: CurrentMeeting) => {
    setCurrentMeeting(meeting);
    router.push(`/meeting-details?id=${meeting.id}`);
  };

  return (
    <div className="min-h-screen bg-slate-50/70 p-6 md:p-10 flex flex-col">
      {/* Top Header */}
      <div className="max-w-6xl mx-auto w-full mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
                Meeting Notes
              </h1>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200/60">
                {meetings.length} {meetings.length === 1 ? 'call' : 'calls'}
              </span>
            </div>
            <p className="text-sm text-slate-500 mt-1">
              Filter by date range, search transcripts, and select any meeting to inspect full details and summaries.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/')}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white text-sm font-medium rounded-xl shadow-xs transition-all"
            >
              <Plus className="w-4 h-4" />
              <span>New Call / Record</span>
            </button>
          </div>
        </div>

        {/* Filter Controls Card */}
        <div className="mt-6 bg-white border border-slate-200/90 rounded-2xl p-4 sm:p-5 shadow-xs space-y-4">
          {/* Top Line: Search & Sort */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            {/* Search Input */}
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search by title, keyword, or date..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-10 py-2.5 bg-slate-50/50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 focus:bg-white transition-all placeholder:text-slate-400"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-1 rounded-md cursor-pointer"
                  aria-label="Clear search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Sort Dropdown */}
            <div className="flex items-center gap-2 shrink-0">
              <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium text-slate-600">
                <ArrowUpDown className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-slate-500">Sort:</span>
                <select
                  value={sortOrder}
                  onChange={(e) => setSortOrder(e.target.value as SortOrder)}
                  className="bg-transparent border-none text-slate-800 font-semibold focus:outline-none cursor-pointer pr-1"
                >
                  <option value="newest">Newest First</option>
                  <option value="oldest">Oldest First</option>
                  <option value="titleAsc">Title (A-Z)</option>
                  <option value="titleDesc">Title (Z-A)</option>
                </select>
              </div>

              {/* Reset Filters button */}
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={handleResetFilters}
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200/60 rounded-xl text-xs font-medium transition-colors cursor-pointer"
                  title="Reset all filters"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reset Filters</span>
                </button>
              )}
            </div>
          </div>

          {/* Bottom Line: Date Presets on Left + Always-Visible Date Range Calendar on Right */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pt-3 border-t border-slate-100">
            {/* Quick Presets on Left */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-medium text-slate-500 mr-1 flex items-center gap-1">
                <Filter className="w-3 h-3 text-slate-400" /> Date:
              </span>

              {[
                { id: 'all', label: 'All Dates' },
                { id: 'today', label: 'Today' },
                { id: 'yesterday', label: 'Yesterday' },
                { id: 'last7', label: 'Last 7 Days' },
                { id: 'thisMonth', label: 'This Month' },
              ].map((tab) => {
                const isActive = activePreset === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => handleSelectPreset(tab.id as DatePreset)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                      isActive
                        ? 'bg-indigo-600 text-white shadow-xs'
                        : 'bg-slate-100/90 text-slate-600 hover:bg-slate-200/80 hover:text-slate-900'
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}

              {activePreset === 'custom' && (
                <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200/60">
                  Custom
                </span>
              )}
            </div>

            {/* Always Visible Date Range Calendar on Right */}
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200/90 rounded-xl px-3 py-1.5 shrink-0 shadow-2xs self-start md:self-auto">
              <CalendarRange className="w-4 h-4 text-indigo-600 shrink-0" />
              <div className="flex items-center gap-1.5 text-xs text-slate-600 font-medium">
                <span className="text-slate-400">From</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => handleStartDateChange(e.target.value)}
                  className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs text-slate-800 font-medium focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
                  title="Filter from this date (sets single date if To is the same)"
                />
                <span className="text-slate-400">To</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => handleEndDateChange(e.target.value)}
                  className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs text-slate-800 font-medium focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
                  title="Filter to this date"
                />
                {(startDate || endDate) && (
                  <button
                    type="button"
                    onClick={handleClearDates}
                    className="p-1 hover:bg-slate-200/80 rounded-md text-slate-400 hover:text-slate-700 transition-colors cursor-pointer ml-0.5"
                    title="Clear date filter"
                    aria-label="Clear dates"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Results count indicator */}
        <div className="flex items-center justify-between text-xs text-slate-500 mt-4 px-1">
          <span>
            Showing <strong className="text-slate-800 font-semibold">{filteredAndSortedMeetings.length}</strong> of {meetings.length} {meetings.length === 1 ? 'meeting' : 'meetings'}
          </span>
          {hasActiveFilters && (
            <span className="text-indigo-600 font-medium">
              Filtered view active
            </span>
          )}
        </div>
      </div>

      {/* Meetings List View */}
      <div className="max-w-6xl mx-auto w-full flex-1">
        {filteredAndSortedMeetings.length === 0 ? (
          <div className="bg-white border border-slate-200/80 rounded-2xl p-12 text-center shadow-xs max-w-lg mx-auto my-8">
            <div className="w-14 h-14 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-indigo-100">
              <FileText className="w-7 h-7" />
            </div>
            <h3 className="text-lg font-semibold text-slate-900">
              {hasActiveFilters ? 'No matching meetings found' : 'No meetings yet'}
            </h3>
            <p className="text-sm text-slate-500 mt-1.5 max-w-sm mx-auto leading-relaxed">
              {hasActiveFilters
                ? 'No meetings match your selected date range or search query. Try broadening your filter or clearing search.'
                : 'Start your first call recording to automatically transcribe speech and generate AI summaries.'}
            </p>
            {hasActiveFilters ? (
              <button
                onClick={handleResetFilters}
                className="mt-5 inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-xl transition-colors cursor-pointer"
              >
                <RotateCcw className="w-4 h-4" />
                <span>Clear Filters</span>
              </button>
            ) : (
              <button
                onClick={() => router.push('/')}
                className="mt-5 inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-xs transition-all cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Start Recording</span>
              </button>
            )}
          </div>
        ) : (
          /* List Container */
          <div className="bg-white border border-slate-200/90 rounded-2xl shadow-xs overflow-hidden">
            {/* List Header */}
            <div className="hidden md:grid grid-cols-12 gap-4 px-6 py-3 bg-slate-50/80 border-b border-slate-200/70 text-xs font-semibold text-slate-500 uppercase tracking-wider">
              <div className="col-span-6">Meeting Name</div>
              <div className="col-span-3">Date & Time</div>
              <div className="col-span-2">Recorded</div>
              <div className="col-span-1 text-right">Actions</div>
            </div>

            {/* List Items */}
            <div className="divide-y divide-slate-100">
              {filteredAndSortedMeetings.map((meeting) => {
                const displayTitle = cleanMeetingTitle(meeting.title, meeting.created_at);
                const formattedDate = meeting.created_at ? formatMeetingDate(meeting.created_at) : null;
                const formattedTime = meeting.created_at ? formatMeetingTime(meeting.created_at) : null;
                const relativeTag = meeting.created_at ? getRelativeTime(meeting.created_at) : null;

                return (
                  <div
                    key={meeting.id}
                    onClick={() => navigateToMeeting(meeting)}
                    className="group relative px-5 sm:px-6 py-4 hover:bg-indigo-50/40 transition-colors duration-150 cursor-pointer flex flex-col md:grid md:grid-cols-12 md:gap-4 md:items-center"
                  >
                    {/* Meeting Title & Icon */}
                    <div className="md:col-span-6 flex items-center gap-3.5 min-w-0">
                      <div className="w-9 h-9 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0 border border-indigo-100/60 group-hover:bg-indigo-600 group-hover:text-white transition-colors">
                        <FileText className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm sm:text-base font-semibold text-slate-900 group-hover:text-indigo-600 transition-colors truncate">
                          {displayTitle}
                        </h3>
                        <p className="text-xs text-slate-400 truncate mt-0.5 md:hidden">
                          {formattedDate} {formattedTime ? `• ${formattedTime}` : ''}
                        </p>
                      </div>
                    </div>

                    {/* Date & Time (Desktop) */}
                    <div className="hidden md:flex md:col-span-3 flex-col justify-center">
                      {formattedDate && (
                        <div className="flex items-center gap-1.5 text-xs text-slate-700 font-medium">
                          <CalendarIcon className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                          <span>{formattedDate}</span>
                        </div>
                      )}
                      {formattedTime && (
                        <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mt-0.5">
                          <Clock className="w-3 h-3 text-slate-400 shrink-0" />
                          <span>{formattedTime}</span>
                        </div>
                      )}
                    </div>

                    {/* Relative Tag Badge */}
                    <div className="hidden md:flex md:col-span-2 items-center">
                      {relativeTag && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200/60">
                          {relativeTag}
                        </span>
                      )}
                    </div>

                    {/* Actions & Open Arrow */}
                    <div className="md:col-span-1 flex items-center justify-end gap-1 mt-2.5 md:mt-0 pt-2 md:pt-0 border-t border-slate-100 md:border-none">
                      {/* Edit Button */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingTitle(meeting.title);
                          setEditModalState({
                            isOpen: true,
                            meetingId: meeting.id,
                            currentTitle: meeting.title,
                          });
                        }}
                        className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors cursor-pointer"
                        title="Edit Meeting Title"
                        aria-label="Edit title"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>

                      {/* Delete Button */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteModalState({
                            isOpen: true,
                            meetingId: meeting.id,
                          });
                        }}
                        className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                        title="Delete Meeting"
                        aria-label="Delete meeting"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>

                      {/* Open arrow icon */}
                      <div className="pl-1 text-slate-400 group-hover:text-indigo-600 group-hover:translate-x-0.5 transition-all">
                        <ArrowRight className="w-4 h-4" />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
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
              placeholder="e.g. Weekly Sync with Team"
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
