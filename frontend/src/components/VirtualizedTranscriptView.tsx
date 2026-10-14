'use client';

import { useCallback, useRef, useReducer, startTransition, useEffect, useState, memo, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useTranscriptStreaming } from "@/hooks/useTranscriptStreaming";
import { ConfidenceIndicator } from "./ConfidenceIndicator";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { RecordingStatusBar } from "./RecordingStatusBar";
import { motion, AnimatePresence } from "framer-motion";
import { TranscriptSegmentData } from "@/types";
import { listen } from "@tauri-apps/api/event";

export interface VirtualizedTranscriptViewProps {
    /** Transcript segments to display */
    segments: TranscriptSegmentData[];
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

// Memoized transcript segment component
const TranscriptSegment = memo(function TranscriptSegment({
    id,
    timestamp,
    text,
    confidence,
    isStreaming,
    showConfidence,
    isHighlighted = false,
    highlightTerms = [],
}: {
    id: string;
    timestamp: number;
    text: string;
    confidence?: number;
    isStreaming: boolean;
    showConfidence: boolean;
    isHighlighted?: boolean;
    highlightTerms?: string[];
}) {
    const displayText = cleanStopWords(text) || (text.trim() === '' ? '[Silence]' : text);

    return (
        <div
            id={`segment-${id}`}
            className={`mb-3 transition-all duration-500 rounded-xl p-2 ${
                isHighlighted
                    ? 'ring-2 ring-indigo-500 bg-indigo-50/90 dark:bg-indigo-950/60 shadow-md'
                    : ''
            }`}
        >
            {isHighlighted && (
                <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-600 animate-ping" />
                    <span>Cited Excerpt • {formatRecordingTime(timestamp)}</span>
                </div>
            )}
            <div className="flex items-start gap-2">
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                if (typeof window !== 'undefined' && typeof timestamp === 'number') {
                                    window.dispatchEvent(new CustomEvent('crestmeet_seek_video', { detail: { time: timestamp } }));
                                }
                            }}
                            className="text-xs text-gray-400 hover:text-blue-600 hover:bg-blue-50 px-1 py-0.5 rounded font-mono transition-colors mt-0.5 flex-shrink-0 min-w-[50px] text-left cursor-pointer group"
                        >
                            <span className="group-hover:underline">{formatRecordingTime(timestamp)}</span>
                        </button>
                    </TooltipTrigger>
                    <TooltipContent>
                        <div className="space-y-1">
                            <p className="text-xs">Click to jump video to this moment</p>
                            {confidence !== undefined && showConfidence && (
                                <ConfidenceIndicator confidence={confidence} showIndicator={showConfidence} />
                            )}
                        </div>
                    </TooltipContent>
                </Tooltip>
                <div className="flex-1">
                    {isStreaming ? (
                        <div className="bg-gray-100 border border-gray-200 rounded-lg px-3 py-2">
                            <p className="text-base text-gray-800 leading-relaxed">
                                {isHighlighted && highlightTerms.length > 0
                                    ? renderHighlightedText(displayText, highlightTerms)
                                    : displayText}
                            </p>
                        </div>
                    ) : (
                        <p className="text-base text-gray-800 leading-relaxed">
                            {isHighlighted && highlightTerms.length > 0
                                ? renderHighlightedText(displayText, highlightTerms)
                                : displayText}
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
});

export const VirtualizedTranscriptView: React.FC<VirtualizedTranscriptViewProps> = ({
    segments,
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

    // Setup virtualizer for efficient rendering of large lists
    const virtualizer = useVirtualizer({
        count: segments.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 60, // Estimated height per segment
        overscan: 10, // Render extra items above/below viewport
        onChange: () => {
            startTransition(() => {
                rerender();
            });
        },
    });

    // Custom hook for auto-scrolling (supports both virtualized and non-virtualized)
    useAutoScroll({
        scrollRef,
        segments,
        isRecording,
        isPaused,
        virtualizer,
        virtualizationThreshold: VIRTUALIZATION_THRESHOLD,
        disableAutoScroll,
    });

    // Streaming text effect hook (typewriter animation for new transcripts)
    const { streamingSegmentId, getDisplayText } = useTranscriptStreaming(
        segments,
        isRecording,
        enableStreaming
    );

    // Extract keywords from highlightQuery
    const highlightTerms = useMemo(() => {
        return extractKeywords(highlightQuery);
    }, [highlightQuery]);

    // Handle deep-link initial timestamp navigation & highlighting
    useEffect(() => {
        if (typeof initialTimestamp !== 'number' || segments.length === 0 || hasScrolledInitialRef.current) {
            return;
        }

        hasScrolledInitialRef.current = true;

        let targetIndex = -1;

        // 1. If we have search terms, search for the best matching utterance inside/around the chunk window
        if (highlightTerms.length > 0) {
            const windowStart = Math.max(0, initialTimestamp - 15);
            const windowEnd = (typeof initialEndTimestamp === 'number' && initialEndTimestamp > initialTimestamp)
                ? initialEndTimestamp + 20
                : initialTimestamp + 180;

            let bestScore = 0;
            let bestIndexInWindow = -1;

            segments.forEach((seg, idx) => {
                const t = seg.timestamp ?? 0;
                if (t >= windowStart && t <= windowEnd) {
                    const segTextLower = seg.text.toLowerCase();
                    let score = 0;

                    // Exact phrase match
                    if (highlightQuery && segTextLower.includes(highlightQuery.toLowerCase().trim())) {
                        score += 100;
                    }

                    // Keyword matches
                    for (const term of highlightTerms) {
                        if (segTextLower.includes(term)) {
                            score += term.length >= 4 ? 30 : 15;
                        }
                    }

                    if (score > bestScore) {
                        bestScore = score;
                        bestIndexInWindow = idx;
                    }
                }
            });

            if (bestIndexInWindow !== -1 && bestScore > 0) {
                targetIndex = bestIndexInWindow;
            } else {
                // If not found in chunk window, search all segments across the entire meeting
                let bestGlobalScore = 0;
                let bestGlobalIndex = -1;
                segments.forEach((seg, idx) => {
                    const segTextLower = seg.text.toLowerCase();
                    let score = 0;
                    if (highlightQuery && segTextLower.includes(highlightQuery.toLowerCase().trim())) {
                        score += 100;
                    }
                    for (const term of highlightTerms) {
                        if (segTextLower.includes(term)) {
                            score += term.length >= 4 ? 30 : 15;
                        }
                    }
                    if (score > bestGlobalScore) {
                        bestGlobalScore = score;
                        bestGlobalIndex = idx;
                    }
                });

                if (bestGlobalIndex !== -1 && bestGlobalScore > 0) {
                    targetIndex = bestGlobalIndex;
                }
            }
        }

        // 2. Fallback: closest segment to initialTimestamp
        if (targetIndex === -1) {
            targetIndex = segments.findIndex((seg) => {
                const start = seg.timestamp ?? 0;
                const end = seg.endTime ?? (start + 15);
                return initialTimestamp >= start && initialTimestamp <= end;
            });
        }

        if (targetIndex === -1) {
            targetIndex = segments.reduce((bestIdx, seg, idx) => {
                const diff = Math.abs((seg.timestamp ?? 0) - initialTimestamp);
                const bestDiff = Math.abs((segments[bestIdx].timestamp ?? 0) - initialTimestamp);
                return diff < bestDiff ? idx : bestIdx;
            }, 0);
        }

        const matchedSegment = segments[targetIndex];
        if (matchedSegment) {
            setHighlightedSegmentId(matchedSegment.id);

            // Seek video directly to the matched utterance timestamp!
            const seekTime = matchedSegment.timestamp ?? initialTimestamp;

            const timer = setTimeout(() => {
                if (segments.length >= VIRTUALIZATION_THRESHOLD && virtualizer) {
                    virtualizer.scrollToIndex(targetIndex, { align: 'center', behavior: 'smooth' });
                } else {
                    const el = document.getElementById(`segment-${matchedSegment.id}`);
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
    }, [initialTimestamp, initialEndTimestamp, highlightTerms, highlightQuery, segments, virtualizer]);

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
    const useVirtualization = segments.length >= VIRTUALIZATION_THRESHOLD;

    return (
        <div ref={scrollRef} className="flex flex-col h-full overflow-y-auto px-4 py-2">
            {/* Recording Status Bar - Sticky at top, always visible when recording */}
            <AnimatePresence>
                {isRecording && (
                    <div className="sticky top-0 z-10 bg-white pb-2">
                        <RecordingStatusBar isPaused={isPaused} />
                    </div>
                )}
            </AnimatePresence>

            {/* Content - add padding when recording to prevent overlap */}
            <div className={isRecording ? 'pt-2' : ''}>
            {segments.length === 0 ? (
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
                            <p className="text-sm font-medium text-gray-700">
                                {isPaused ? 'Recording paused' :
                                 sttStatus === 'connected' ? 'STT Live • Listening for speech...' :
                                 sttStatus === 'error' ? 'Speech-to-Text Connection Error' :
                                 'Connecting to STT stream...'}
                            </p>
                            <p className="text-xs mt-1 text-gray-400">
                                {isPaused ? 'Click resume to continue recording' :
                                 sttStatus === 'connected' ? 'Speak clearly — your transcription will appear live' :
                                 'Establishing audio stream connection...'}
                            </p>
                        </>
                    ) : (
                        <>
                            <p className="text-lg font-semibold">Welcome to CrestMeet!</p>
                            <p className="text-xs mt-1">Start recording to see live transcription</p>
                        </>
                    )}
                </motion.div>
            ) : useVirtualization ? (
                // Virtualized rendering for large lists
                <>
                    <div
                        style={{
                            height: virtualizer.getTotalSize(),
                            width: "100%",
                            position: "relative",
                        }}
                    >
                        {virtualizer.getVirtualItems().map((virtualRow) => {
                            const segment = segments[virtualRow.index];
                            const isStreaming = streamingSegmentId === segment.id;

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
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        confidence={segment.confidence}
                                        isStreaming={isStreaming}
                                        showConfidence={showConfidence}
                                        isHighlighted={highlightedSegmentId === segment.id}
                                        highlightTerms={highlightedSegmentId === segment.id ? highlightTerms : []}
                                    />
                                </div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger and loading indicator */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
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
                    {!isStopping && isRecording && !isPaused && !isProcessing && segments.length > 0 && (
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
                // Simple rendering for small lists (better animations)
                <>
                    <div className="space-y-1">
                        {segments.map((segment) => {
                            const isStreaming = streamingSegmentId === segment.id;

                            return (
                                <motion.div
                                    key={segment.id}
                                    initial={{ opacity: 0, y: 5 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.15 }}
                                >
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        confidence={segment.confidence}
                                        isStreaming={isStreaming}
                                        showConfidence={showConfidence}
                                        isHighlighted={highlightedSegmentId === segment.id}
                                        highlightTerms={highlightedSegmentId === segment.id ? highlightTerms : []}
                                    />
                                </motion.div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger (for small lists that grow) */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
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
                    {!isStopping && isRecording && !isPaused && !isProcessing && segments.length > 0 && (
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
