/**
 * Utility functions for formatting meeting dates, times, and titles cleanly.
 */

/**
 * Formats an ISO date string or Date into a human-readable date.
 * Example: "Thursday, Sep 10, 2026"
 */
export function formatMeetingDate(dateInput?: string | Date | null, fullDay: boolean = true): string {
  if (!dateInput) return '';
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (isNaN(date.getTime())) return '';

  return date.toLocaleDateString('en-US', {
    weekday: fullDay ? 'short' : undefined,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Formats an ISO date string or Date into a 12-hour time.
 * Example: "10:51 AM"
 */
export function formatMeetingTime(dateInput?: string | Date | null): string {
  if (!dateInput) return '';
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (isNaN(date.getTime())) return '';

  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Formats into a concise date and time for cards and list items.
 * Example: "Sep 10, 2026 • 10:51 AM"
 */
export function formatMeetingDateTime(dateInput?: string | Date | null): string {
  if (!dateInput) return '';
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (isNaN(date.getTime())) return '';

  const datePart = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const timePart = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  return `${datePart} • ${timePart}`;
}

/**
 * Returns a friendly relative time badge (e.g. "Today", "Yesterday", "3 days ago", or "Aug 20").
 */
export function getRelativeTime(dateInput?: string | Date | null): string {
  if (!dateInput) return '';
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (isNaN(date.getTime())) return '';

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);

  // Check if same calendar day
  const isToday = now.toDateString() === date.toDateString();
  if (isToday) return 'Today';

  // Check if yesterday
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (yesterday.toDateString() === date.toDateString()) return 'Yesterday';

  if (diffHours < 24 * 7) {
    const days = Math.floor(diffHours / 24);
    return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  }

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Checks if a title is a legacy auto-generated timestamp string (e.g. "Meeting 10_09_26_10_51_45")
 * and returns a cleaned, user-friendly display title.
 */
export function cleanMeetingTitle(rawTitle: string, createdAt?: string): string {
  if (!rawTitle) return 'Untitled Meeting';

  // Legacy format 1: "Meeting DD_MM_YY_HH_MM_SS"
  const legacyMatch1 = rawTitle.match(/^Meeting\s+(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})$/);
  if (legacyMatch1) {
    const [, day, month, year, hours, minutes] = legacyMatch1;
    const fullYear = `20${year}`;
    const date = new Date(Number(fullYear), Number(month) - 1, Number(day), Number(hours), Number(minutes));
    if (!isNaN(date.getTime())) {
      return `Meeting • ${formatMeetingDateTime(date)}`;
    }
    return `Meeting • ${month}/${day}/${fullYear}`;
  }

  // Legacy format 2: "Meeting YYYY-MM-DD_HH-MM-SS"
  const legacyMatch2 = rawTitle.match(/^Meeting\s+(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
  if (legacyMatch2) {
    const [, year, month, day, hours, minutes] = legacyMatch2;
    const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes));
    if (!isNaN(date.getTime())) {
      return `Meeting • ${formatMeetingDateTime(date)}`;
    }
  }

  // If the title is simply "Meeting" and we have createdAt
  if (rawTitle.trim().toLowerCase() === 'meeting' && createdAt) {
    return `Meeting • ${formatMeetingDateTime(createdAt)}`;
  }

  return rawTitle;
}
