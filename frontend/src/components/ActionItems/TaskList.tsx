'use client';

import React from 'react';
import { ResolvedActionItem } from '@/types';
import { TaskCard } from './TaskCard';
import { ReviewCard } from './ReviewCard';
import { CheckCircle2, Inbox, AlertCircle, Calendar } from 'lucide-react';

export interface TaskListProps {
    items: ResolvedActionItem[];
    tab: 'open' | 'needs_review' | 'done';
    onToggle: (item: ResolvedActionItem) => void;
    onSelect: (item: ResolvedActionItem) => void;
    onConfirm?: (item: ResolvedActionItem) => void;
    onReject?: (item: ResolvedActionItem) => void;
    onClaim?: (item: ResolvedActionItem) => void;
    onIdentifySpeaker?: (speakerId: string, meetingId: string) => void;
}

interface GroupedTasks {
    overdue: ResolvedActionItem[];
    today: ResolvedActionItem[];
    thisWeek: ResolvedActionItem[];
    later: ResolvedActionItem[];
    noDate: ResolvedActionItem[];
}

export const TaskList: React.FC<TaskListProps> = ({
    items,
    tab,
    onToggle,
    onSelect,
    onConfirm,
    onReject,
    onClaim,
    onIdentifySpeaker,
}) => {
    if (items.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
                <div className="p-4 rounded-full bg-muted/50 text-muted-foreground">
                    {tab === 'done' ? (
                        <CheckCircle2 className="w-8 h-8 text-emerald-500" />
                    ) : tab === 'needs_review' ? (
                        <AlertCircle className="w-8 h-8 text-amber-500" />
                    ) : (
                        <Inbox className="w-8 h-8 text-indigo-500" />
                    )}
                </div>
                <div className="space-y-1">
                    <h3 className="text-sm font-semibold text-foreground">
                        {tab === 'done'
                            ? 'No completed tasks yet'
                            : tab === 'needs_review'
                            ? 'All tasks reviewed!'
                            : 'No open tasks'}
                    </h3>
                    <p className="text-xs text-muted-foreground max-w-sm">
                        {tab === 'done'
                            ? 'Completed tasks from your meetings will be archived here.'
                            : tab === 'needs_review'
                            ? 'Any candidate tasks needing speaker clarification or assignment confirmation will appear here.'
                            : 'Tasks assigned to you in meetings will automatically show up here.'}
                    </p>
                </div>
            </div>
        );
    }

    if (tab === 'needs_review') {
        return (
            <div className="space-y-3">
                {items.map((item) => (
                    <ReviewCard
                        key={item.id}
                        item={item}
                        onConfirm={onConfirm || (() => {})}
                        onReject={onReject || (() => {})}
                        onClaim={onClaim || (() => {})}
                        onSelect={onSelect}
                        onIdentifySpeaker={onIdentifySpeaker}
                    />
                ))}
            </div>
        );
    }

    // Group items for 'open' and 'done' tabs
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    const weekLater = new Date(today);
    weekLater.setDate(weekLater.getDate() + 7);
    const weekLaterStr = weekLater.toISOString().split('T')[0];

    const grouped: GroupedTasks = {
        overdue: [],
        today: [],
        thisWeek: [],
        later: [],
        noDate: [],
    };

    items.forEach((item) => {
        if (!item.due_date) {
            grouped.noDate.push(item);
        } else if (item.status === 'open' && item.due_date < todayStr) {
            grouped.overdue.push(item);
        } else if (item.due_date === todayStr) {
            grouped.today.push(item);
        } else if (item.due_date <= weekLaterStr) {
            grouped.thisWeek.push(item);
        } else {
            grouped.later.push(item);
        }
    });

    const renderSection = (title: string, groupItems: ResolvedActionItem[], iconColor: string) => {
        if (groupItems.length === 0) return null;
        return (
            <div className="space-y-2">
                <div className="flex items-center gap-2 pt-2">
                    <span className={`w-2 h-2 rounded-full ${iconColor}`} />
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {title} ({groupItems.length})
                    </h4>
                </div>
                <div className="space-y-2.5">
                    {groupItems.map((item) => (
                        <TaskCard
                            key={item.id}
                            item={item}
                            onToggle={onToggle}
                            onSelect={onSelect}
                        />
                    ))}
                </div>
            </div>
        );
    };

    return (
        <div className="space-y-6">
            {renderSection('Overdue', grouped.overdue, 'bg-red-500')}
            {renderSection('Today', grouped.today, 'bg-amber-500')}
            {renderSection('This Week', grouped.thisWeek, 'bg-blue-500')}
            {renderSection('Later', grouped.later, 'bg-indigo-500')}
            {renderSection('No Due Date', grouped.noDate, 'bg-zinc-400')}
        </div>
    );
};
