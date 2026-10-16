'use client';

import React, { useState, useEffect } from 'react';
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    ResolvedActionItem,
    ActionItemEvidence,
} from '@/types';
import {
    Calendar,
    Clock,
    User,
    Play,
    ExternalLink,
    CheckCircle2,
    Circle,
    Edit3,
    Check,
    MessageSquareQuote,
    HelpCircle,
    CalendarDays
} from 'lucide-react';
import Link from 'next/link';

export interface TaskDrawerProps {
    isOpen: boolean;
    onClose: () => void;
    item: ResolvedActionItem | null;
    evidence: ActionItemEvidence | null;
    isLoadingEvidence: boolean;
    onToggleStatus?: (item: ResolvedActionItem) => void;
    onUpdateItem?: (id: string, patch: { content?: string; due_date?: string; status?: 'open' | 'in_progress' | 'done' | 'dropped' }) => Promise<void>;
    onIdentifySpeaker?: (speakerId: string, meetingId: string) => void;
}

export const TaskDrawer: React.FC<TaskDrawerProps> = ({
    isOpen,
    onClose,
    item,
    evidence,
    isLoadingEvidence,
    onToggleStatus,
    onUpdateItem,
    onIdentifySpeaker,
}) => {
    const [isEditingTask, setIsEditingTask] = useState(false);
    const [editedTask, setEditedTask] = useState('');
    const [editedDueDate, setEditedDueDate] = useState('');

    useEffect(() => {
        if (item) {
            setEditedTask(item.task);
            setEditedDueDate(item.due_date || '');
            setIsEditingTask(false);
        }
    }, [item]);

    if (!item) return null;

    const isDone = item.status === 'done';

    const handleSaveTaskTitle = async () => {
        if (!onUpdateItem || !editedTask.trim()) return;
        try {
            await onUpdateItem(item.id, { content: editedTask.trim() });
            setIsEditingTask(false);
        } catch (err) {
            console.error('Failed to update task content:', err);
        }
    };

    const handleDueDateChange = async (newDate: string) => {
        setEditedDueDate(newDate);
        if (!onUpdateItem) return;
        try {
            await onUpdateItem(item.id, { due_date: newDate });
        } catch (err) {
            console.error('Failed to update due date:', err);
        }
    };

    const handleQuickDueDate = (daysOffset: number) => {
        const d = new Date();
        d.setDate(d.getDate() + daysOffset);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        handleDueDateChange(`${yyyy}-${mm}-${dd}`);
    };

    const formatTimestamp = (sec?: number | null) => {
        if (sec == null || isNaN(sec)) return '00:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };

    const handlePlayAudio = (seconds: number) => {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(
                new CustomEvent('crestmeet_seek_video', { detail: { time: seconds } })
            );
        }
    };

    return (
        <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <SheetContent side="right" className="sm:max-w-lg w-full flex flex-col p-0 overflow-hidden">
                {/* Header */}
                <div className="p-6 border-b border-border bg-muted/20">
                    <SheetHeader className="text-left space-y-1">
                        <div className="flex items-center justify-between pr-8">
                            <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                                Action Item Evidence
                            </span>
                            {item.assignment_type && (
                                <span className="text-[10px] uppercase font-semibold tracking-wider px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300">
                                    {item.assignment_type}
                                </span>
                            )}
                        </div>

                        {/* Editable Task Title */}
                        {isEditingTask ? (
                            <div className="flex items-center gap-2 pt-2">
                                <Input
                                    value={editedTask}
                                    onChange={(e) => setEditedTask(e.target.value)}
                                    className="text-base font-semibold"
                                    autoFocus
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleSaveTaskTitle();
                                        if (e.key === 'Escape') setIsEditingTask(false);
                                    }}
                                />
                                <Button size="sm" onClick={handleSaveTaskTitle} className="shrink-0 h-9">
                                    <Check className="w-4 h-4" />
                                </Button>
                            </div>
                        ) : (
                            <div className="flex items-start gap-2 pt-2 group">
                                <button
                                    type="button"
                                    onClick={() => onToggleStatus && onToggleStatus(item)}
                                    className="mt-1 shrink-0 text-zinc-400 hover:text-indigo-600 transition-colors"
                                >
                                    {isDone ? (
                                        <CheckCircle2 className="w-5 h-5 text-emerald-600 fill-emerald-100 dark:fill-emerald-950" />
                                    ) : (
                                        <Circle className="w-5 h-5" />
                                    )}
                                </button>
                                <SheetTitle
                                    className={`text-base font-semibold leading-relaxed cursor-pointer flex-1 ${
                                        isDone ? 'line-through text-muted-foreground' : 'text-foreground'
                                    }`}
                                    onClick={() => setIsEditingTask(true)}
                                >
                                    {item.task}
                                </SheetTitle>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setIsEditingTask(true)}
                                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1 h-7 w-7 shrink-0"
                                >
                                    <Edit3 className="w-3.5 h-3.5 text-muted-foreground" />
                                </Button>
                            </div>
                        )}

                        <SheetDescription className="pt-2">
                            <Link
                                href={`/meetings?id=${item.meeting_id}`}
                                className="inline-flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 font-medium transition-colors"
                            >
                                <span>{item.meeting_title}</span>
                                <ExternalLink className="w-3 h-3" />
                            </Link>
                        </SheetDescription>
                    </SheetHeader>
                </div>

                {/* Content body */}
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {/* Metadata & Assignment */}
                    <div className="space-y-3 p-4 rounded-xl border border-border bg-card/50 text-xs">
                        <div className="flex items-center justify-between pb-2 border-b border-border/50">
                            <span className="text-muted-foreground">Assigner:</span>
                            <span className="font-semibold text-foreground flex items-center gap-1">
                                <User className="w-3.5 h-3.5 text-zinc-400" />
                                {item.assigner_label || 'Unknown'}
                            </span>
                        </div>

                        <div className="flex items-center justify-between pb-2 border-b border-border/50">
                            <span className="text-muted-foreground">Assignee:</span>
                            <div className="flex items-center gap-2">
                                <span className="font-semibold text-foreground flex items-center gap-1">
                                    <User className="w-3.5 h-3.5 text-zinc-400" />
                                    {item.assignee_label || 'Unassigned'}
                                </span>
                                {item.speaker_unresolved && item.assignee_speaker_id && onIdentifySpeaker && (
                                    <button
                                        type="button"
                                        onClick={() => onIdentifySpeaker(item.assignee_speaker_id!, item.meeting_id)}
                                        className="inline-flex items-center gap-1 text-[11px] text-indigo-600 dark:text-indigo-400 underline font-medium"
                                    >
                                        <HelpCircle className="w-3 h-3" />
                                        Identify
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Due Date & Presets */}
                        <div className="space-y-2 pt-1">
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground flex items-center gap-1">
                                    <Calendar className="w-3.5 h-3.5" />
                                    <span>Due Date:</span>
                                </span>
                                <input
                                    type="date"
                                    value={editedDueDate}
                                    onChange={(e) => handleDueDateChange(e.target.value)}
                                    className="bg-background border border-input rounded-md px-2 py-1 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                />
                            </div>

                            {item.due_phrase && (
                                <p className="text-[11px] text-muted-foreground italic">
                                    Mentioned in speech: &ldquo;{item.due_phrase}&rdquo;
                                </p>
                            )}

                            {/* Quick Presets */}
                            <div className="flex items-center gap-1.5 pt-1">
                                <button
                                    type="button"
                                    onClick={() => handleQuickDueDate(0)}
                                    className="px-2 py-0.5 rounded text-[10px] bg-muted hover:bg-muted/80 text-foreground transition-colors"
                                >
                                    Today
                                </button>
                                <button
                                    type="button"
                                    onClick={() => handleQuickDueDate(1)}
                                    className="px-2 py-0.5 rounded text-[10px] bg-muted hover:bg-muted/80 text-foreground transition-colors"
                                >
                                    Tomorrow
                                </button>
                                <button
                                    type="button"
                                    onClick={() => handleQuickDueDate(7)}
                                    className="px-2 py-0.5 rounded text-[10px] bg-muted hover:bg-muted/80 text-foreground transition-colors"
                                >
                                    +1 Week
                                </button>
                                {editedDueDate && (
                                    <button
                                        type="button"
                                        onClick={() => handleDueDateChange('')}
                                        className="px-2 py-0.5 rounded text-[10px] text-red-500 hover:text-red-600 transition-colors ml-auto"
                                    >
                                        Clear
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Audio Evidence Section */}
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                                <MessageSquareQuote className="w-4 h-4 text-indigo-500" />
                                <span>Spoken Evidence ({evidence?.turns?.length || 0})</span>
                            </h4>
                            {item.start_seconds != null && (
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handlePlayAudio(item.start_seconds!)}
                                    className="h-7 text-xs gap-1.5 text-indigo-600 dark:text-indigo-400 border-indigo-200 dark:border-indigo-900"
                                >
                                    <Play className="w-3 h-3 fill-current" />
                                    <span>Play at {formatTimestamp(item.start_seconds)}</span>
                                </Button>
                            )}
                        </div>

                        {isLoadingEvidence ? (
                            <div className="py-8 text-center text-xs text-muted-foreground animate-pulse">
                                Loading transcript snippets...
                            </div>
                        ) : !evidence || evidence.turns.length === 0 ? (
                            <div className="p-4 rounded-xl border border-dashed border-border text-center text-xs text-muted-foreground">
                                No direct transcript turns recorded for this task.
                            </div>
                        ) : (
                            <div className="space-y-2.5">
                                {evidence.turns.map((turn) => (
                                    <div
                                        key={turn.id}
                                        className="p-3.5 rounded-xl border border-border bg-card hover:border-indigo-200 dark:hover:border-indigo-900/50 transition-all space-y-2"
                                    >
                                        <div className="flex items-center justify-between text-xs">
                                            <span className="font-semibold text-foreground flex items-center gap-1.5">
                                                <span className="w-2 h-2 rounded-full bg-indigo-500 inline-block" />
                                                {turn.speaker_name}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => handlePlayAudio(turn.timestamp)}
                                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono text-indigo-600 hover:text-indigo-700 bg-indigo-50 dark:bg-indigo-950/50 hover:bg-indigo-100 transition-colors"
                                            >
                                                <Play className="w-2.5 h-2.5 fill-current" />
                                                <span>{formatTimestamp(turn.timestamp)}</span>
                                            </button>
                                        </div>
                                        <p className="text-xs text-foreground/90 leading-relaxed font-sans bg-muted/30 p-2.5 rounded-lg border border-border/40 italic">
                                            &ldquo;{turn.text}&rdquo;
                                        </p>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </SheetContent>
        </Sheet>
    );
};
