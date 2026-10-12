'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import {
  Calendar,
  Clock,
  ExternalLink,
  Loader2,
  Users,
  Quote,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  X,
  CalendarPlus,
  Sparkles
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

interface GoogleCalendarStatus {
  is_connected: boolean;
  email?: string | null;
}

export interface RescheduleEventItem {
  id: string;
  title: string;
  date: string;
  start_time: string;
  end_time: string;
  description: string;
  attendees: string[];
  transcript_quote: string;
}

interface RescheduleExtractionResult {
  has_reschedule: boolean;
  events: RescheduleEventItem[];
}

interface CreateEventResponse {
  success: boolean;
  event_id: string;
  html_link: string;
}

interface ScheduleFollowUpCardProps {
  meetingId: string;
  meetingTitle?: string;
  hasTranscripts: boolean;
  hasSummary: boolean;
  summaryStatus?: string;
}

export function ScheduleFollowUpCard({
  meetingId,
  meetingTitle,
  hasTranscripts,
  hasSummary,
  summaryStatus,
}: ScheduleFollowUpCardProps) {
  const { user } = useAuth();
  // Calendar status
  const [calendarStatus, setCalendarStatus] = useState<GoogleCalendarStatus>({
    is_connected: false,
    email: null,
  });
  const [isConnecting, setIsConnecting] = useState(false);

  // Extraction state
  const [isExtracting, setIsExtracting] = useState(false);
  const [events, setEvents] = useState<RescheduleEventItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isDismissed, setIsDismissed] = useState(false);

  // Track created events per event ID
  const [createdEvents, setCreatedEvents] = useState<Record<string, CreateEventResponse>>({});
  const [isCreatingEvent, setIsCreatingEvent] = useState(false);

  // Has scanned ref to prevent duplicate automatic scans
  const scannedMeetingIdRef = useRef<string | null>(null);

  // Check Google Calendar connection status
  const checkStatus = useCallback(async () => {
    if (!user) {
      setCalendarStatus({ is_connected: false, email: null });
      return;
    }
    try {
      const status = await invoke<GoogleCalendarStatus>('api_google_calendar_get_status', {
        userIdHint: user.id,
      });
      setCalendarStatus(status);
    } catch (error) {
      console.warn('Failed to check Google Calendar status:', error);
    }
  }, [user]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus, user?.id]);

  // Connect Google Calendar via loopback flow (port 3000)
  const handleConnectCalendar = async () => {
    try {
      setIsConnecting(true);
      toast.info('Opening Google authorization in your browser...', {
        description: 'Please approve access. Return here once authorized.',
        duration: 10000,
      });

      const newStatus = await invoke<GoogleCalendarStatus>('api_google_calendar_start_auth', {
        userEmailHint: user?.email || null,
        userIdHint: user?.id || null,
      });
      setCalendarStatus(newStatus);
      toast.success('Google Calendar connected successfully!', {
        description: newStatus.email ? `Connected as ${newStatus.email}` : undefined,
      });
    } catch (error: any) {
      console.error('Google Calendar auth failed:', error);
      toast.error('Failed to connect Google Calendar', {
        description: error?.toString() || 'Please check that port 3000 is available and try again.',
      });
    } finally {
      setIsConnecting(false);
    }
  };

  // Perform background extraction
  const performExtraction = useCallback(async () => {
    if (!hasTranscripts || !meetingId) return;

    try {
      setIsExtracting(true);
      const result = await invoke<RescheduleExtractionResult>('api_extract_reschedule_info', {
        meetingId,
      });

      if (result.has_reschedule && result.events && result.events.length > 0) {
        setEvents(result.events);
        setCurrentIndex(0);
        setIsDismissed(false);
      } else {
        setEvents([]);
      }
    } catch (error) {
      console.warn('Silent reschedule extraction failed:', error);
      setEvents([]);
    } finally {
      setIsExtracting(false);
    }
  }, [hasTranscripts, meetingId]);

  // Auto-scan ONLY when summary is completed or when a completed summary exists on mount
  useEffect(() => {
    if (scannedMeetingIdRef.current === meetingId) return;

    // Trigger only when summary exists or when summary status is completed
    if (hasSummary || summaryStatus === 'completed') {
      scannedMeetingIdRef.current = meetingId;
      performExtraction();
    }
  }, [meetingId, hasSummary, summaryStatus, performExtraction]);

  // Current active event card
  const currentEvent = events[currentIndex] || null;

  // Update field of current event
  const updateCurrentEventField = (field: keyof RescheduleEventItem, value: any) => {
    if (!currentEvent) return;
    setEvents((prev) => {
      const copy = [...prev];
      copy[currentIndex] = { ...copy[currentIndex], [field]: value };
      return copy;
    });
  };

  // Create event on Google Calendar
  const handleCreateCurrentEvent = async () => {
    if (!currentEvent) return;

    if (!calendarStatus.is_connected) {
      await handleConnectCalendar();
      return;
    }

    if (!currentEvent.title.trim() || !currentEvent.date) {
      toast.error('Please enter a title and date for this meeting');
      return;
    }

    const startDateTime = `${currentEvent.date}T${currentEvent.start_time || '10:00'}:00`;
    const endDateTime = `${currentEvent.date}T${currentEvent.end_time || '10:30'}:00`;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

    try {
      setIsCreatingEvent(true);
      const response = await invoke<CreateEventResponse>('api_google_calendar_create_event', {
        payload: {
          title: currentEvent.title.trim(),
          description: currentEvent.description.trim() || null,
          start_date_time: startDateTime,
          end_date_time: endDateTime,
          time_zone: timeZone,
          attendees: currentEvent.attendees.length > 0 ? currentEvent.attendees : null,
        },
        userIdHint: user?.id || null,
      });

      setCreatedEvents((prev) => ({
        ...prev,
        [currentEvent.id]: response,
      }));

      toast.success('Added to Google Calendar!', {
        description: `Scheduled for ${currentEvent.date} at ${currentEvent.start_time}`,
      });

      // If there are more unadded events, smoothly advance to the next card
      if (currentIndex < events.length - 1) {
        setTimeout(() => {
          setCurrentIndex((idx) => Math.min(idx + 1, events.length - 1));
        }, 600);
      }
    } catch (error: any) {
      console.error('Failed to create calendar event:', error);
      toast.error('Failed to add to Google Calendar', {
        description: error?.toString() || 'Unknown error',
      });
    } finally {
      setIsCreatingEvent(false);
    }
  };

  const handleOpenCalendarLink = async (url: string) => {
    try {
      await invoke('open_external_url', { url });
    } catch (err) {
      window.open(url, '_blank');
    }
  };

  // Don't render anything if dismissed, or if not extracting and no events were detected
  if (isDismissed || (!isExtracting && events.length === 0)) {
    return null;
  }

  // If currently extracting in the background
  if (isExtracting) {
    return (
      <div className="my-4 bg-white/80 border border-slate-200/80 rounded-2xl p-4 flex items-center justify-between shadow-2xs">
        <div className="flex items-center gap-2.5 text-xs text-slate-600">
          <Loader2 className="w-4 h-4 animate-spin text-indigo-600 shrink-0" />
          <span>Scanning transcript for follow-up agreements...</span>
        </div>
      </div>
    );
  }

  const isCurrentEventCreated = currentEvent ? !!createdEvents[currentEvent.id] : false;
  const currentCreatedEventData = currentEvent ? createdEvents[currentEvent.id] : null;

  return (
    <div className="my-4 bg-white border border-slate-200/90 rounded-2xl shadow-xs overflow-hidden transition-all duration-200">
      {/* Flashcard Header Bar */}
      <div className="px-5 py-3.5 bg-slate-50/80 border-b border-slate-100 flex items-center justify-between gap-3">
        {/* Left: Icon & Flashcard Count */}
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-100/60 shrink-0">
            <Calendar className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold text-slate-900">
                Next Meeting Detected
              </h4>
              {events.length > 1 && (
                <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200/60">
                  {currentIndex + 1} of {events.length}
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-500">
              Detected from transcript discussion. Review and edit before adding to your calendar.
            </p>
          </div>
        </div>

        {/* Right: Carousel Navigation & Actions */}
        <div className="flex items-center gap-2">
          {/* Flashcard Navigation Buttons (only when multiple events detected) */}
          {events.length > 1 && (
            <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-xl p-0.5 shadow-2xs mr-1">
              <button
                type="button"
                onClick={() => setCurrentIndex((idx) => Math.max(idx - 1, 0))}
                disabled={currentIndex === 0}
                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent transition-colors cursor-pointer"
                title="Previous meeting"
                aria-label="Previous"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>

              {/* Dots indicator */}
              <div className="flex items-center gap-1 px-1.5">
                {events.map((ev, i) => (
                  <span
                    key={ev.id || i}
                    onClick={() => setCurrentIndex(i)}
                    className={`cursor-pointer rounded-full transition-all ${
                      i === currentIndex
                        ? 'w-3 h-1.5 bg-indigo-600'
                        : createdEvents[ev.id]
                        ? 'w-1.5 h-1.5 bg-emerald-500'
                        : 'w-1.5 h-1.5 bg-slate-300 hover:bg-slate-400'
                    }`}
                  />
                ))}
              </div>

              <button
                type="button"
                onClick={() => setCurrentIndex((idx) => Math.min(idx + 1, events.length - 1))}
                disabled={currentIndex === events.length - 1}
                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent transition-colors cursor-pointer"
                title="Next meeting"
                aria-label="Next"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Calendar Status Badge */}
          {calendarStatus.is_connected && (
            <div className="hidden sm:flex items-center gap-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200/60 px-2 py-1 rounded-lg text-xs font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <span className="max-w-[130px] truncate" title={calendarStatus.email || ''}>
                {calendarStatus.email || 'Connected'}
              </span>
            </div>
          )}

          {/* Dismiss button */}
          <button
            type="button"
            onClick={() => setIsDismissed(true)}
            className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
            title="Dismiss card"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Flashcard Content Form */}
      {currentEvent && (
        <div className="p-5 space-y-4">
          {/* Transcript Quote (Snippet from discussion) */}
          {currentEvent.transcript_quote && (
            <div className="p-3 bg-amber-50/70 border border-amber-200/70 rounded-xl flex items-start gap-2.5 text-xs text-amber-900">
              <Quote className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-amber-950">Agreed in transcript: </span>
                <span className="italic">"{currentEvent.transcript_quote}"</span>
              </div>
            </div>
          )}

          {/* Pre-filled Editable Form Grid */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3.5">
            {/* Event Title */}
            <div className="md:col-span-6 space-y-1">
              <label className="text-xs font-semibold text-slate-700">
                Meeting Title
              </label>
              <input
                type="text"
                value={currentEvent.title}
                onChange={(e) => updateCurrentEventField('title', e.target.value)}
                placeholder="e.g. Sprint Planning Sync"
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
              />
            </div>

            {/* Date */}
            <div className="md:col-span-6 space-y-1">
              <label className="text-xs font-semibold text-slate-700">
                Date
              </label>
              <input
                type="date"
                value={currentEvent.date}
                onChange={(e) => updateCurrentEventField('date', e.target.value)}
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 cursor-pointer"
              />
            </div>

            {/* Start Time */}
            <div className="md:col-span-3 space-y-1">
              <label className="text-xs font-semibold text-slate-700 flex items-center gap-1">
                <Clock className="w-3 h-3 text-slate-400" /> Start Time
              </label>
              <input
                type="time"
                value={currentEvent.start_time}
                onChange={(e) => updateCurrentEventField('start_time', e.target.value)}
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 cursor-pointer"
              />
            </div>

            {/* End Time */}
            <div className="md:col-span-3 space-y-1">
              <label className="text-xs font-semibold text-slate-700 flex items-center gap-1">
                <Clock className="w-3 h-3 text-slate-400" /> End Time
              </label>
              <input
                type="time"
                value={currentEvent.end_time}
                onChange={(e) => updateCurrentEventField('end_time', e.target.value)}
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 cursor-pointer"
              />
            </div>

            {/* Attendees */}
            <div className="md:col-span-6 space-y-1">
              <label className="text-xs font-semibold text-slate-700 flex items-center gap-1">
                <Users className="w-3 h-3 text-slate-400" /> Guests / Attendees (Emails)
              </label>
              <input
                type="text"
                value={currentEvent.attendees ? currentEvent.attendees.join(', ') : ''}
                onChange={(e) =>
                  updateCurrentEventField(
                    'attendees',
                    e.target.value.split(',').map((s) => s.trim())
                  )
                }
                placeholder="colleague@example.com, team@example.com"
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
              />
            </div>

            {/* Description */}
            <div className="md:col-span-12 space-y-1">
              <label className="text-xs font-semibold text-slate-700">
                Agenda & Notes
              </label>
              <textarea
                rows={2}
                value={currentEvent.description}
                onChange={(e) => updateCurrentEventField('description', e.target.value)}
                placeholder="Discussion points and topics for this next session..."
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 resize-y"
              />
            </div>
          </div>

          {/* Flashcard Action Footer */}
          <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-3 flex-wrap">
            {/* Left status if created */}
            {isCurrentEventCreated ? (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 text-xs text-emerald-700 font-semibold bg-emerald-50 px-3 py-1.5 rounded-xl border border-emerald-200/60">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span>Added to Google Calendar!</span>
                </div>
                {currentCreatedEventData?.html_link && (
                  <button
                    type="button"
                    onClick={() => handleOpenCalendarLink(currentCreatedEventData.html_link)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
                  >
                    <span>View on Calendar</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                Adjust any fields above and click to confirm and add to your calendar.
              </p>
            )}

            {/* Right button */}
            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={handleCreateCurrentEvent}
                disabled={isCreatingEvent || !currentEvent.title.trim() || !currentEvent.date}
                className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white rounded-xl text-xs font-semibold shadow-xs transition-all cursor-pointer disabled:opacity-50"
              >
                {isCreatingEvent ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Adding to Calendar...</span>
                  </>
                ) : isCurrentEventCreated ? (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Update on Google Calendar</span>
                  </>
                ) : !calendarStatus.is_connected ? (
                  <>
                    <CalendarPlus className="w-4 h-4" />
                    <span>Connect & Add to Google Calendar</span>
                  </>
                ) : (
                  <>
                    <CalendarPlus className="w-4 h-4" />
                    <span>Add to Google Calendar</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
