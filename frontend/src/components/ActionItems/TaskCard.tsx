'use client';

import React from 'react';
import { ResolvedActionItem } from '@/types';
import { Calendar, User, CheckCircle2, Circle, AlertCircle, Sparkles, ExternalLink } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import Link from 'next/link';

export interface TaskCardProps {
    item: ResolvedActionItem;
    onToggle: (item: ResolvedActionItem) => void;
    onSelect: (item: ResolvedActionItem) => void;
}

export const TaskCard: React.FC<TaskCardProps> = ({ item, onToggle, onSelect }) => {
    const isDone = item.status === 'done';

    // Due date categorization
    const todayStr = new Date().toISOString().split('T')[0];
    const isOverdue = !isDone && item.due_date && item.due_date < todayStr;
    const isToday = !isDone && item.due_date && item.due_date === todayStr;

    return (
        <div
            onClick={() => onSelect(item)}
            className={`group p-4 rounded-xl border transition-all duration-150 cursor-pointer bg-white dark:bg-zinc-900 ${
                isDone
                    ? 'border-border/50 opacity-70 bg-muted/20'
                    : isOverdue
                    ? 'border-red-200 dark:border-red-900/50 shadow-xs hover:border-red-300'
                    : 'border-border hover:border-indigo-300 dark:hover:border-indigo-800 shadow-xs hover:shadow-sm'
            }`}
        >
            <div className="flex items-start gap-3">
                {/* Checkbox */}
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onToggle(item);
                    }}
                    className="mt-0.5 text-zinc-400 hover:text-indigo-600 transition-colors shrink-0"
                >
                    {isDone ? (
                        <CheckCircle2 className="w-5 h-5 text-emerald-600 fill-emerald-100 dark:fill-emerald-950" />
                    ) : (
                        <Circle className="w-5 h-5 hover:scale-105 transition-transform" />
                    )}
                </button>

                {/* Content */}
                <div className="flex-1 min-w-0 space-y-2">
                    <p
                        className={`text-sm leading-relaxed text-foreground font-medium ${
                            isDone ? 'line-through text-muted-foreground' : ''
                        }`}
                    >
                        {item.task}
                    </p>

                    {/* Metadata Row */}
                    <div className="flex flex-wrap items-center gap-2 pt-0.5 text-xs text-muted-foreground">
                        {/* Due date chip */}
                        {item.due_date ? (
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <span
                                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-mono text-[11px] font-medium border ${
                                            isOverdue
                                                ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800'
                                                : isToday
                                                ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800'
                                                : 'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700'
                                        }`}
                                    >
                                        {isOverdue && <AlertCircle className="w-3 h-3 text-red-600" />}
                                        <Calendar className="w-3 h-3" />
                                        <span>{item.due_date}</span>
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent>
                                    <p>Due: {item.due_date} {item.due_phrase ? `("${item.due_phrase}")` : ''}</p>
                                </TooltipContent>
                            </Tooltip>
                        ) : (
                            <span className="text-zinc-400 text-[11px]">No due date</span>
                        )}

                        {/* Assigner */}
                        {item.assigner_label && (
                            <span className="inline-flex items-center gap-1 text-[11px]">
                                <User className="w-3 h-3 text-zinc-400" />
                                <span>from {item.assigner_label}</span>
                            </span>
                        )}

                        {/* Assignment Type badge */}
                        {item.assignment_type && (
                            <span
                                className={`text-[10px] uppercase font-semibold tracking-wider px-1.5 py-0.5 rounded ${
                                    item.assignment_type === 'volunteered'
                                        ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                                        : 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300'
                                }`}
                            >
                                {item.assignment_type}
                            </span>
                        )}

                        {/* Meeting Link */}
                        <Link
                            href={`/meetings?id=${item.meeting_id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-indigo-600 truncate max-w-[200px] ml-auto transition-colors"
                        >
                            <span className="truncate">{item.meeting_title}</span>
                            <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                        </Link>
                    </div>
                </div>
            </div>
        </div>
    );
};
