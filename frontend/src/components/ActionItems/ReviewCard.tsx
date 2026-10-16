'use client';

import React from 'react';
import { ResolvedActionItem } from '@/types';
import {
    Calendar,
    User,
    Check,
    X,
    Hand,
    HelpCircle,
    FileText,
    ExternalLink,
    AlertCircle,
    ArrowRight
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

export interface ReviewCardProps {
    item: ResolvedActionItem;
    onConfirm: (item: ResolvedActionItem) => void;
    onReject: (item: ResolvedActionItem) => void;
    onClaim: (item: ResolvedActionItem) => void;
    onSelect: (item: ResolvedActionItem) => void;
    onIdentifySpeaker?: (speakerId: string, meetingId: string) => void;
}

export const ReviewCard: React.FC<ReviewCardProps> = ({
    item,
    onConfirm,
    onReject,
    onClaim,
    onSelect,
    onIdentifySpeaker,
}) => {
    // Why it needs review
    const isUnresolvedSpeaker = item.speaker_unresolved;
    const isLowConfidence = item.confidence != null && item.confidence < 0.7;
    const isUnassigned = !item.assignee_label;

    return (
        <div className="p-4 rounded-xl border border-amber-200 dark:border-amber-900/40 bg-white dark:bg-zinc-900 shadow-xs hover:shadow-sm transition-all space-y-3">
            {/* Top row: Reason badge + meeting link */}
            <div className="flex items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-1.5 flex-wrap">
                    {isUnresolvedSpeaker && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                            <AlertCircle className="w-3 h-3" />
                            Unidentified speaker
                        </span>
                    )}
                    {isLowConfidence && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300">
                            Low confidence ({Math.round((item.confidence || 0) * 100)}%)
                        </span>
                    )}
                    {isUnassigned && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-300">
                            No assignee detected
                        </span>
                    )}
                    {item.assignment_type && (
                        <span className="text-[10px] uppercase font-semibold tracking-wider text-muted-foreground px-1.5 py-0.5 bg-muted rounded">
                            {item.assignment_type}
                        </span>
                    )}
                </div>

                <Link
                    href={`/meetings?id=${item.meeting_id}`}
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-indigo-600 truncate max-w-[180px] transition-colors"
                >
                    <span className="truncate">{item.meeting_title}</span>
                    <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                </Link>
            </div>

            {/* Task statement */}
            <p className="text-sm font-medium text-foreground leading-snug">
                {item.task}
            </p>

            {/* Assignment context row */}
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground py-1 border-y border-border/50">
                <div className="flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5 text-zinc-400" />
                    <span>From:</span>
                    <span className="font-semibold text-foreground">
                        {item.assigner_label || 'Unknown speaker'}
                    </span>
                </div>

                <ArrowRight className="w-3 h-3 text-zinc-400" />

                <div className="flex items-center gap-1.5">
                    <span>To:</span>
                    <span className="font-semibold text-foreground">
                        {item.assignee_label || 'Unassigned'}
                    </span>
                    {item.speaker_unresolved && item.assignee_speaker_id && onIdentifySpeaker && (
                        <button
                            type="button"
                            onClick={() => onIdentifySpeaker(item.assignee_speaker_id!, item.meeting_id)}
                            className="inline-flex items-center gap-1 text-[11px] text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 underline font-medium ml-1"
                        >
                            <HelpCircle className="w-3 h-3" />
                            Who is this?
                        </button>
                    )}
                </div>

                {item.due_date && (
                    <div className="flex items-center gap-1 ml-auto text-[11px]">
                        <Calendar className="w-3 h-3 text-zinc-400" />
                        <span>Due: {item.due_date} {item.due_phrase ? `("${item.due_phrase}")` : ''}</span>
                    </div>
                )}
            </div>

            {/* Action buttons */}
            <div className="flex items-center justify-between pt-1 gap-2 flex-wrap">
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onSelect(item)}
                    className="h-8 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
                >
                    <FileText className="w-3.5 h-3.5" />
                    <span>View Evidence</span>
                </Button>

                <div className="flex items-center gap-1.5 ml-auto">
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => onReject(item)}
                        className="h-8 text-xs gap-1 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                    >
                        <X className="w-3.5 h-3.5" />
                        <span>Not Mine</span>
                    </Button>

                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onClaim(item)}
                        className="h-8 text-xs gap-1 text-blue-600 border-blue-200 hover:bg-blue-50 dark:border-blue-900/50 dark:hover:bg-blue-950/30"
                    >
                        <Hand className="w-3.5 h-3.5" />
                        <span>Claim</span>
                    </Button>

                    <Button
                        type="button"
                        size="sm"
                        onClick={() => onConfirm(item)}
                        className="h-8 text-xs gap-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                    >
                        <Check className="w-3.5 h-3.5" />
                        <span>Confirm (Mine)</span>
                    </Button>
                </div>
            </div>
        </div>
    );
};
