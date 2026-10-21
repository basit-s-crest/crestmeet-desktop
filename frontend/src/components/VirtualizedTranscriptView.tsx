'use client';

import { useCallback, useRef, useReducer, startTransition, useEffect, useState, memo, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useTranscriptStreaming } from "@/hooks/useTranscriptStreaming";
import { ConfidenceIndicator } from "./ConfidenceIndicator";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { RecordingStatusBar } from "./RecordingStatusBar";
import { motion, AnimatePresence } from "framer-motion";
import { TranscriptSegmentData, MeetingSpeaker } from "@/types";
import { listen } from "@tauri-apps/api/event";
import { SpeakerChip } from "./Speakers/SpeakerChip";
import { User } from "lucide-react";

export interface VirtualizedTranscriptViewProps {
    /** Transcript segments to display */
    segments: TranscriptSegmentData[];
    /** Speaker lookup dictionary for instant name synchronization */
    speakersById?: Record<string, MeetingSpeaker>;
    /** Whether recording is in progress */
    isRecording?: boolean;
    /** Whether recording is paused */
    isPaused?: boolean;
    /** Whether processing/finalizing transcription */
    isProcessing?: boolean;
    /** Whether stopping */
    isStopping?: boolean;
    /** Enable streaming effect for latest segment */
    enableStreaming?: boolean;
    /** Show confidence indicators */
    showConfidence?: boolean;
    /** Completely disable auto-scroll behavior (for meeting details page) */
    disableAutoScroll?: boolean;

    // Pagination props (infinite scroll)
    hasMore?: boolean;
    isLoadingMore?: boolean;
    totalCount?: number;
    loadedCount?: number;
    onLoadMore?: () => void;

    /** Jump to initial citation timestamp */
    initialTimestamp?: number;
    initialEndTimestamp?: number;
    highlightQuery?: string;
}

// Threshold for enabling virtualization (below this, use simple rendering)
const VIRTUALIZATION_THRESHOLD = 10;

// Helper function to format seconds as recording-relative time [MM:SS]
function formatRecordingTime(seconds: number | undefined): string {
    if (seconds === undefined) return '[--:--]';

    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;

    return `[${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
}

// Helper function to remove filler words and repetitions
function cleanStopWords(text: string): string {
    const stopWords = ['uh', 'um', 'er', 'ah', 'hmm', 'hm', 'eh', 'oh'];

    let cleanedText = text;
    stopWords.forEach(word => {
        const pattern = new RegExp(`\\b${word}\\b[,\\s]*`, 'gi');
        cleanedText = cleanedText.replace(pattern, ' ');
    });

    return cleanedText.replace(/\s+/g, ' ').trim();
}

// Helper function to extract search keywords from user query or citation snippet
function extractKeywords(query?: string): string[] {
    if (!query) return [];
    const stopWords = new Set([
        'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how',
        'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
        'do', 'does', 'did', 'a', 'an', 'the', 'and', 'but', 'if', 'or', 'because',
        'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with', 'about', 'against',
        'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
        'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under',
        'again', 'further', 'then', 'once', 'here', 'there', 'all', 'any', 'both',
        'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not',
        'only', 'own', 'same', 'so', 'than', 'too', 'very', 'can', 'will', 'just',
        'should', 'now', 'speaker', 'meeting', 'tell', 'said', 'discuss', 'discussed'
    ]);

    return query
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .map(w => w.trim())
        .filter(term => term.length >= 2 && !stopWords.has(term));
}

// Helper to highlight matching keywords inside utterance text
function renderHighlightedText(text: string, terms: string[]) {
    if (!terms.length) return text;
    const escaped = terms
        .filter(t => t.trim().length > 1)
        .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!escaped.length) return text;
    const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
    const parts = text.split(regex);
    return parts.map((part, i) => {
        if (regex.test(part)) {
            return (
                <mark
                    key={i}
                    className="bg-amber-300/90 dark:bg-amber-400/40 text-amber-950 dark:text-amber-100 font-semibold px-1 py-0.5 rounded shadow-2xs"
                >
                    {part}
                </mark>
            );
        }
        return part;
    });
}

export interface SpeakerTurn {
    id: string;
    speakerName: string;
    speakerChannel: 'mic' | 'system';
    speakerId?: string;
    timestamp: number;
    endTime?: number;
    text: string;
    segmentIds: string[];
    confidence?: number;
    isHighlighted?: boolean;
    isStreaming?: boolean;
}

// Group consecutive segments from the same speaker into conversational turn cards
export function groupSegmentsIntoTurns(
    segments: TranscriptSegmentData[],
    highlightedSegmentId: string | null,
    streamingSegmentId: string | null,
    getDisplayText: (seg: TranscriptSegmentData) => string,
    speakersById?: Record<string, MeetingSpeaker>
): SpeakerTurn[] {
    const turns: SpeakerTurn[] = [];
    if (!segments || segments.length === 0) return turns;

    let currentTurn: SpeakerTurn | null = null;

    for (const seg of segments) {
        const isMic = seg.speakerChannel === 'mic' ||
            (seg.speakerName?.toLowerCase().includes('you') || seg.speakerName?.toLowerCase().includes('mic'));

        // Look up speaker from registry if available for instantaneous synchronization
        const speakerIdKey = seg.speakerId?.trim() || undefined;
        const clusterKey = seg.clusterKey?.trim() || undefined;
        const resolvedSpeaker: MeetingSpeaker | undefined =
            (speakerIdKey ? speakersById?.[speakerIdKey] : undefined) ||
            (clusterKey ? speakersById?.[clusterKey] : undefined);
        const channel: 'mic' | 'system' = (resolvedSpeaker?.channel as 'mic' | 'system') || (isMic ? 'mic' : 'system');
        const defaultName = channel === 'mic'
            ? 'You'
            : seg.clusterKey && seg.clusterKey.startsWith('sys:S')
            ? `Speaker ${seg.clusterKey.replace('sys:S', '')}`
            : 'Speaker 1';
        const name = resolvedSpeaker?.display_name || seg.speakerName?.trim() || defaultName;

        const isSegHighlighted = Boolean(highlightedSegmentId && (highlightedSegmentId === seg.id || highlightedSegmentId === `seg_${seg.id}`));
        const isSegStreaming = Boolean(streamingSegmentId && streamingSegmentId === seg.id);
        const segRawText = getDisplayText(seg);
        const segText = cleanStopWords(segRawText).trim();

        const speechPause = currentTurn && seg.timestamp ? seg.timestamp - (currentTurn.endTime ?? currentTurn.timestamp) : 0;
        const isWithinTurnWindow = speechPause < 12.0;

        if (currentTurn && currentTurn.speakerName === name && currentTurn.speakerChannel === channel && isWithinTurnWindow) {
            currentTurn.segmentIds.push(seg.id);
            if (seg.endTime) {
                currentTurn.endTime = seg.endTime;
            }
            if (segText) {
                currentTurn.text = currentTurn.text ? `${currentTurn.text} ${segText}` : segText;
            }
            if (isSegHighlighted) {
                currentTurn.isHighlighted = true;
            }
            if (isSegStreaming) {
                currentTurn.isStreaming = true;
            }
        } else {
            currentTurn = {
                id: `turn-${seg.id}`,
                speakerName: name,
                speakerChannel: channel,
                speakerId: seg.speakerId || seg.clusterKey,
                timestamp: seg.timestamp ?? 0,
                endTime: seg.endTime,
                text: segText,
                segmentIds: [seg.id],
                confidence: seg.confidence,
                isHighlighted: isSegHighlighted,
                isStreaming: isSegStreaming,
            };
            turns.push(currentTurn);
        }
    }

    return turns;
}

// Memoized turn card component (Clean, minimal, professional industry-standard)
const SpeakerTurnCard = memo(function SpeakerTurnCard({
    turn,
    showConfidence,
    highlightTerms = [],
}: {
    turn: SpeakerTurn;
    isNextSameSpeaker?: boolean;
    showConfidence: boolean;
    highlightTerms?: string[];
}) {
    const isMic = turn.speakerChannel === 'mic';
    const displayText = turn.text.trim() === '' ? '[Silence]' : turn.text;

    return (
        <div id={`turn-${turn.id}`} className="mb-3">
            <div
                className={`transition-all duration-200 rounded-xl border bg-white dark:bg-zinc-900 shadow-2xs hover:shadow-xs ${
                    turn.isHighlighted
                        ? 'ring-2 ring-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/40 border-indigo-300 dark:border-indigo-800'
                        : isMic
                        ? 'border-gray-200/90 dark:border-zinc-800 border-l-[3.5px] border-l-blue-500'
                        : 'border-gray-200/90 dark:border-zinc-800 border-l-[3.5px] border-l-purple-500'
                }`}
            >
                {/* Cited Excerpt badge if cited */}
                {turn.isHighlighted && (
                    <div className="px-3.5 pt-2 pb-0 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-600 animate-ping" />
                        <span>Cited Excerpt • {formatRecordingTime(turn.timestamp)}</span>
                    </div>
                )}

                {/* Header: Speaker Avatar & Chip on left, [01:15] Seek Button on right */}
                <div className="flex items-center justify-between px-3.5 py-2 border-b border-gray-100 dark:border-zinc-800/70 bg-gray-50/40 dark:bg-zinc-900/40 rounded-t-xl">
                    <div className="flex items-center gap-2">
                        <div
                            className={`w-6 h-6 rounded-full flex items-center justify-center text-xs shrink-0 select-none shadow-2xs ${
                                isMic
                                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300 border border-blue-200/60 dark:border-blue-800/60'
                                    : 'bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300 border border-purple-200/60 dark:border-purple-800/60'
                            }`}
                        >
                            <User className="w-3.5 h-3.5" />
                        </div>

                        <SpeakerChip
                            speakerName={turn.speakerName}
                            channel={turn.speakerChannel}
                            clusterKey={turn.speakerId}
                            compact={true}
                            showEditOnHover={true}
                        />
                    </div>

                    <div className="flex items-center gap-1.5">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (typeof window !== 'undefined' && typeof turn.timestamp === 'number') {
                                            window.dispatchEvent(new CustomEvent('crestmeet_seek_video', { detail: { time: turn.timestamp } }));
                                        }
                                    }}
                                    className="text-xs text-gray-400 hover:text-blue-600 dark:text-zinc-500 dark:hover:text-blue-400 font-mono font-medium px-1.5 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer group"
                                >
                                    <span className="group-hover:underline">{formatRecordingTime(turn.timestamp)}</span>
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>
                                <div className="space-y-1">
                                    <p className="text-xs">Click to jump video to this moment</p>
                                    {turn.confidence !== undefined && showConfidence && (
                                        <ConfidenceIndicator confidence={turn.confidence} showIndicator={showConfidence} />
                                    )}
                                </div>
                            </TooltipContent>
                        </Tooltip>
                    </div>
                </div>

                {/* Body: Clean, unquoted transcript text */}
                <div className="px-3.5 py-3">
                    <p className={`text-[13.5px] leading-relaxed text-gray-800 dark:text-zinc-200 font-normal select-text ${
                        turn.isStreaming ? 'animate-pulse' : ''
                    }`}>
                        {turn.isHighlighted && highlightTerms.length > 0
                            ? renderHighlightedText(displayText, highlightTerms)
                            : displayText}
                    </p>
                </div>
            </div>
        </div>
    );
});

// Clean, minimal single-line segment for live streaming (Normal Old UI)
const LiveTranscriptSegment = memo(function LiveTranscriptSegment({
    segment,
    displayText,
    isStreaming,
    showConfidence,
}: {
    segment: TranscriptSegmentData;
    displayText: string;
    isStreaming: boolean;
    showConfidence: boolean;
}) {
    const textToShow = displayText || (segment.text?.trim() === '' ? '[Silence]' : segment.text);

    return (
        <div id={`segment-${segment.id}`} className="py-1 px-3 rounded-lg hover:bg-gray-50/80 dark:hover:bg-zinc-850/50 transition-colors">
            <div className="flex items-start gap-2.5">
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            type="button"
                            className="text-xs text-gray-400 dark:text-zinc-500 font-mono font-medium px-1.5 py-0.5 rounded flex-shrink-0 min-w-[50px] text-left cursor-default select-none mt-0.5"
                        >
                            {formatRecordingTime(segment.timestamp)}
                        </button>
                    </TooltipTrigger>
                    <TooltipContent>
                        <div className="space-y-1">
                            <p className="text-xs">Recording timestamp</p>
                            {segment.confidence !== undefined && showConfidence && (
                                <ConfidenceIndicator confidence={segment.confidence} showIndicator={showConfidence} />
                            )}
                        </div>
                    </TooltipContent>
                </Tooltip>

                <div className="flex-1 min-w-0">
                    {isStreaming ? (
                        <div className="inline-flex items-center gap-1.5 bg-gray-100/90 dark:bg-zinc-800/80 border border-gray-200/90 dark:border-zinc-700/80 rounded-lg px-3 py-1.5 shadow-2xs">
                            <span className="text-gray-900 dark:text-zinc-100 text-sm leading-relaxed font-sans">{textToShow}</span>
                            <span className="inline-block w-2 h-4 bg-blue-500 animate-pulse rounded-xs" />
                        </div>
                    ) : (
                        <p className="text-sm leading-relaxed text-gray-800 dark:text-zinc-200 font-normal select-text">
                            {textToShow}
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
});

export const VirtualizedTranscriptView: React.FC<VirtualizedTranscriptViewProps> = ({
    segments,
    speakersById,
    isRecording = false,
    isPaused = false,
    isProcessing = false,
    isStopping = false,
    enableStreaming = false,
    showConfidence = true,
    disableAutoScroll = false,
    hasMore = false,
    isLoadingMore = false,
    totalCount = 0,
    loadedCount = 0,
    onLoadMore,
    initialTimestamp,
    initialEndTimestamp,
    highlightQuery,
}) => {
    // Create scroll ref first - shared between virtualizer and auto-scroll hook
    const scrollRef = useRef<HTMLDivElement>(null);
    // Ref for infinite scroll trigger element
    const loadMoreTriggerRef = useRef<HTMLDivElement>(null);

    // Deep-link citation highlight tracking
    const [highlightedSegmentId, setHighlightedSegmentId] = useState<string | null>(null);
    const hasScrolledInitialRef = useRef(false);

    // STT channel status tracking
    const [sttStatus, setSttStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');

    useEffect(() => {
        if (!isRecording) {
            setSttStatus('idle');
            return;
        }
        let unlisten: (() => void) | undefined;
        listen<{ status: 'idle' | 'connecting' | 'connected' | 'error' }>('stt-status', (event) => {
            if (event.payload?.status) {
                setSttStatus(event.payload.status);
            }
        }).then(fn => { unlisten = fn; });

        return () => {
            if (unlisten) unlisten();
        };
    }, [isRecording]);

    // Force re-render without flushSync (avoids React warning)
    const [, rerender] = useReducer((x: number) => x + 1, 0);

    // Streaming text effect hook (typewriter animation for new transcripts)
    // Mode tracking: live streaming mode is active while recording OR while stopping/finalizing
    const isLiveStreamMode = isRecording || isStopping || isProcessing;

    // Streaming text effect hook (typewriter animation for new transcripts)
    const { streamingSegmentId, getDisplayText } = useTranscriptStreaming(
        segments,
        isLiveStreamMode,
        enableStreaming
    );

    // Extract keywords from highlightQuery
    const highlightTerms = useMemo(() => {
        return extractKeywords(highlightQuery);
    }, [highlightQuery]);

    // Group segments into turn cards (used for post-meeting view only)
    const turns = useMemo(() => {
        if (isLiveStreamMode) return [];
        return groupSegmentsIntoTurns(segments, highlightedSegmentId, streamingSegmentId, getDisplayText, speakersById);
    }, [isLiveStreamMode, segments, highlightedSegmentId, streamingSegmentId, getDisplayText, speakersById]);

    // Active item count based on mode (live stream vs post-meeting turns)
    const itemCount = isLiveStreamMode ? segments.length : turns.length;
    const hasItems = itemCount > 0;

    // Setup virtualizer for efficient rendering
    const virtualizer = useVirtualizer({
        count: itemCount,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => isLiveStreamMode ? 44 : 110,
        overscan: 6,
        onChange: () => {
            startTransition(() => {
                rerender();
            });
        },
    });

    // Custom hook for auto-scrolling
    useAutoScroll({
        scrollRef,
        segments: isLiveStreamMode ? segments : turns,
        isRecording: isLiveStreamMode,
        isPaused,
        virtualizer,
        virtualizationThreshold: VIRTUALIZATION_THRESHOLD,
        disableAutoScroll,
    });

    // Handle deep-link initial timestamp navigation & highlighting
    useEffect(() => {
        if (typeof initialTimestamp !== 'number' || turns.length === 0 || hasScrolledInitialRef.current) {
            return;
        }

        hasScrolledInitialRef.current = true;

        let targetIndex = -1;

        // 1. If we have search terms, search for the best matching turn inside/around the chunk window
        if (highlightTerms.length > 0) {
            let bestScore = 0;
            turns.forEach((turn, idx) => {
                const turnTextLower = turn.text.toLowerCase();
                let score = 0;

                // Exact phrase match
                if (highlightQuery && turnTextLower.includes(highlightQuery.toLowerCase().trim())) {
                    score += 100;
                }

                // Keyword matches
                for (const term of highlightTerms) {
                    if (turnTextLower.includes(term)) {
                        score += term.length >= 4 ? 30 : 15;
                    }
                }

                if (score > bestScore) {
                    bestScore = score;
                    targetIndex = idx;
                }
            });
        }

        // 2. Fallback: closest turn to initialTimestamp
        if (targetIndex === -1) {
            targetIndex = turns.findIndex((turn) => {
                const start = turn.timestamp ?? 0;
                const end = turn.endTime ?? (start + 15);
                return initialTimestamp >= start && initialTimestamp <= end;
            });
        }

        if (targetIndex === -1) {
            targetIndex = turns.reduce((bestIdx, turn, idx) => {
                const diff = Math.abs((turn.timestamp ?? 0) - initialTimestamp);
                const bestDiff = Math.abs((turns[bestIdx].timestamp ?? 0) - initialTimestamp);
                return diff < bestDiff ? idx : bestIdx;
            }, 0);
        }

        const matchedTurn = turns[targetIndex];
        if (matchedTurn) {
            setHighlightedSegmentId(matchedTurn.segmentIds[0] || null);

            // Seek video directly to the matched utterance timestamp!
            const seekTime = matchedTurn.timestamp ?? initialTimestamp;

            const timer = setTimeout(() => {
                if (turns.length >= VIRTUALIZATION_THRESHOLD && virtualizer) {
                    virtualizer.scrollToIndex(targetIndex, { align: 'center', behavior: 'smooth' });
                } else {
                    const el = document.getElementById(`turn-${matchedTurn.id}`);
                    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }

                if (typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('crestmeet_seek_video', { detail: { time: seekTime } }));
                }
            }, 200);

            // Clear pulse highlight after 6 seconds
            const clearTimer = setTimeout(() => {
                setHighlightedSegmentId(null);
            }, 6000);

            return () => {
                clearTimeout(timer);
                clearTimeout(clearTimer);
            };
        }
    }, [initialTimestamp, initialEndTimestamp, highlightTerms, highlightQuery, turns, virtualizer]);

    // Infinite scroll: IntersectionObserver to trigger loading more
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording || segments.length === 0) {
            return;
        }

        const triggerElement = loadMoreTriggerRef.current;
        if (!triggerElement) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
            },
            {
                root: null,
                rootMargin: '100px',
                threshold: 0,
            }
        );

        observer.observe(triggerElement);

        return () => observer.disconnect();
    }, [hasMore, isLoadingMore, onLoadMore, isRecording, segments.length]);

    // Scroll-based fallback for fast scrolling
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording) return;

        const scrollElement = scrollRef.current;
        if (!scrollElement) return;

        let ticking = false;

        const handleScroll = () => {
            if (ticking || isLoadingMore || !hasMore) return;

            ticking = true;
            requestAnimationFrame(() => {
                const { scrollTop, scrollHeight, clientHeight } = scrollElement;
                const scrollBottom = scrollHeight - scrollTop - clientHeight;

                // Trigger load when within 200px of bottom
                if (scrollBottom < 200 && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
                ticking = false;
            });
        };

        scrollElement.addEventListener('scroll', handleScroll, { passive: true });
        return () => scrollElement.removeEventListener('scroll', handleScroll);
    }, [onLoadMore, hasMore, isLoadingMore, isRecording]);

    // Use simple rendering for small lists, virtualization for large lists
    const useVirtualization = itemCount >= VIRTUALIZATION_THRESHOLD;

    return (
        <div ref={scrollRef} className="flex flex-col h-full overflow-y-auto px-4 py-2">
            {/* Recording Status Bar - Sticky at top, always visible when recording */}
            <AnimatePresence>
                {isRecording && (
                    <div className="sticky top-0 z-10 bg-white dark:bg-zinc-900 pb-2">
                        <RecordingStatusBar isPaused={isPaused} />
                    </div>
                )}
            </AnimatePresence>

            {/* Content area */}
            <div className={isRecording ? 'pt-2' : ''}>
            {!hasItems ? (
                // Empty state
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-center text-gray-500 mt-8"
                >
                    {isRecording ? (
                        <>
                            <div className="flex items-center justify-center mb-3">
                                <div className={`w-3 h-3 rounded-full ${
                                    isPaused ? 'bg-orange-500' :
                                    sttStatus === 'connected' ? 'bg-emerald-500 animate-pulse' :
                                    sttStatus === 'error' ? 'bg-red-500' :
                                    'bg-amber-400 animate-pulse'
                                }`}></div>
                            </div>
                            <p className="text-sm font-medium text-gray-700 dark:text-zinc-300">
                                {isPaused ? 'Recording paused' :
                                 sttStatus === 'connected' ? 'STT Live • Listening for speech...' :
                                 sttStatus === 'error' ? 'Speech-to-Text Connection Error' :
                                 'Connecting to STT stream...'}
                            </p>
                            <p className="text-xs mt-1 text-gray-400 dark:text-zinc-500">
                                {isPaused ? 'Click resume to continue recording' :
                                 sttStatus === 'connected' ? 'Speak clearly — your transcription will appear live' :
                                 'Establishing audio stream connection...'}
                            </p>
                        </>
                    ) : (
                        <>
                            <p className="text-lg font-semibold text-gray-800 dark:text-zinc-200">Welcome to CrestMeet!</p>
                            <p className="text-xs mt-1 text-gray-400 dark:text-zinc-500">Start recording to see live transcription</p>
                        </>
                    )}
                </motion.div>
            ) : useVirtualization ? (
                // Virtualized rendering
                <>
                    <div
                        style={{
                            height: virtualizer.getTotalSize(),
                            width: "100%",
                            position: "relative",
                        }}
                    >
                        {virtualizer.getVirtualItems().map((virtualRow) => {
                            if (isLiveStreamMode) {
                                const segment = segments[virtualRow.index];
                                if (!segment) return null;

                                return (
                                    <div
                                        key={segment.id}
                                        data-index={virtualRow.index}
                                        ref={virtualizer.measureElement}
                                        style={{
                                            position: "absolute",
                                            top: 0,
                                            left: 0,
                                            width: "100%",
                                            transform: `translateY(${virtualRow.start}px)`,
                                        }}
                                    >
                                        <LiveTranscriptSegment
                                            segment={segment}
                                            displayText={getDisplayText(segment)}
                                            isStreaming={streamingSegmentId === segment.id}
                                            showConfidence={showConfidence}
                                        />
                                    </div>
                                );
                            }

                            const turn = turns[virtualRow.index];
                            if (!turn) return null;

                            return (
                                <div
                                    key={turn.id}
                                    data-index={virtualRow.index}
                                    ref={virtualizer.measureElement}
                                    style={{
                                        position: "absolute",
                                        top: 0,
                                        left: 0,
                                        width: "100%",
                                        transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                >
                                    <SpeakerTurnCard
                                        turn={turn}
                                        isNextSameSpeaker={virtualRow.index === turns.length - 1}
                                        showConfidence={showConfidence}
                                        highlightTerms={highlightTerms}
                                    />
                                </div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger and loading indicator */}
                    {(hasMore || isLoadingMore) && !isLiveStreamMode && turns.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-gray-500">
                                    <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                                    <span className="text-sm">Loading more...</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-gray-400">
                                    Showing {loadedCount} of {totalCount} segments
                                </span>
                            ) : null}
                        </div>
                    )}

                    {/* Listening indicator when recording */}
                    {!isStopping && isRecording && !isPaused && !isProcessing && hasItems && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-2 mt-4 text-gray-500"
                        >
                            <div className={`w-2 h-2 rounded-full ${sttStatus === 'connected' ? 'bg-emerald-500' : 'bg-blue-500'} animate-pulse`}></div>
                            <span className="text-sm font-medium">{sttStatus === 'connected' ? 'STT Live • Listening...' : 'Listening...'}</span>
                        </motion.div>
                    )}
                </>
            ) : (
                // Simple rendering for small lists
                <>
                    {isLiveStreamMode ? (
                        <div className="space-y-0.5">
                            {segments.map((segment) => (
                                <LiveTranscriptSegment
                                    key={segment.id}
                                    segment={segment}
                                    displayText={getDisplayText(segment)}
                                    isStreaming={streamingSegmentId === segment.id}
                                    showConfidence={showConfidence}
                                />
                            ))}
                        </div>
                    ) : (
                        <div className="space-y-1">
                            {turns.map((turn, idx) => (
                                <motion.div
                                    key={turn.id}
                                    initial={{ opacity: 0, y: 5 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.15 }}
                                >
                                    <SpeakerTurnCard
                                        turn={turn}
                                        isNextSameSpeaker={idx === turns.length - 1}
                                        showConfidence={showConfidence}
                                        highlightTerms={highlightTerms}
                                    />
                                </motion.div>
                            ))}
                        </div>
                    )}

                    {/* Infinite scroll trigger (for small lists that grow) */}
                    {(hasMore || isLoadingMore) && !isLiveStreamMode && turns.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-gray-500">
                                    <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                                    <span className="text-sm">Loading more...</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-gray-400">
                                    Showing {loadedCount} of {totalCount} segments
                                </span>
                            ) : null}
                        </div>
                    )}

                    {/* Listening indicator when recording */}
                    {!isStopping && isRecording && !isPaused && !isProcessing && hasItems && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-2 mt-4 text-gray-500"
                        >
                            <div className={`w-2 h-2 rounded-full ${sttStatus === 'connected' ? 'bg-emerald-500' : 'bg-blue-500'} animate-pulse`}></div>
                            <span className="text-sm font-medium">{sttStatus === 'connected' ? 'STT Live • Listening...' : 'Listening...'}</span>
                        </motion.div>
                    )}
                </>
            )}
            </div>
        </div>
    );
};
