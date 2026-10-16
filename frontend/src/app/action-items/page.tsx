'use client';

import React, { useState } from 'react';
import { useMyActionItems, ActionItemTab } from '@/hooks/useMyActionItems';
import {
    TaskList,
    TaskDrawer,
} from '@/components/ActionItems';
import { SpeakerRenameDialog } from '@/components/Speakers/SpeakerRenameDialog';
import {
    ResolvedActionItem,
    ActionItemEvidence,
    MeetingSpeaker,
    Person,
} from '@/types';
import {
    CheckSquare,
    Search,
    RefreshCw,
    AlertCircle,
    CheckCircle2,
    Clock,
    Sparkles,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';

export default function ActionItemsPage() {
    const {
        tab,
        setTab,
        searchQuery,
        setSearchQuery,
        items,
        counts,
        isLoading,
        error,
        refetch,
        toggleStatus,
        confirmItem,
        rejectItem,
        claimItem,
        updateItem,
        getEvidence,
    } = useMyActionItems();

    // Drawer state
    const [selectedItem, setSelectedItem] = useState<ResolvedActionItem | null>(null);
    const [evidence, setEvidence] = useState<ActionItemEvidence | null>(null);
    const [isLoadingEvidence, setIsLoadingEvidence] = useState(false);

    // Speaker rename dialog state
    const [speakerDialogOpen, setSpeakerDialogOpen] = useState(false);
    const [targetSpeaker, setTargetSpeaker] = useState<MeetingSpeaker | null>(null);
    const [meetingSpeakers, setMeetingSpeakers] = useState<MeetingSpeaker[]>([]);
    const [peopleList, setPeopleList] = useState<Person[]>([]);

    const handleSelectItem = async (item: ResolvedActionItem) => {
        setSelectedItem(item);
        setIsLoadingEvidence(true);
        try {
            const ev = await getEvidence(item.id);
            setEvidence(ev);
        } catch (err) {
            console.error('Failed to load evidence:', err);
        } finally {
            setIsLoadingEvidence(false);
        }
    };

    const handleIdentifySpeaker = async (speakerId: string, meetingId: string) => {
        try {
            const [speakers, people] = await Promise.all([
                invoke<MeetingSpeaker[]>('api_list_meeting_speakers', { meetingId }),
                invoke<Person[]>('api_list_people'),
            ]);
            setMeetingSpeakers(speakers);
            setPeopleList(people);
            const found = speakers.find((s) => s.id === speakerId) || null;
            if (found) {
                setTargetSpeaker(found);
                setSpeakerDialogOpen(true);
            } else {
                toast.error('Speaker record not found');
            }
        } catch (err) {
            console.error('Failed to prepare speaker dialog:', err);
            toast.error('Could not load speaker details');
        }
    };

    const handleSpeakerRename = async (speakerId: string, displayName: string, personId?: string) => {
        try {
            await invoke('api_rename_speaker', {
                speakerId,
                displayName,
                personId: personId || null,
            });
            toast.success(`Renamed speaker to ${displayName}`);
            setSpeakerDialogOpen(false);
            refetch();
        } catch (err: any) {
            toast.error(err?.toString() || 'Failed to rename speaker');
            throw err;
        }
    };

    const handleSpeakerMerge = async (targetSpeakerId: string, sourceSpeakerId: string) => {
        if (!targetSpeaker) return;
        try {
            await invoke('api_merge_speakers', {
                meetingId: targetSpeaker.meeting_id,
                targetSpeakerId,
                sourceSpeakerId,
            });
            toast.success('Speakers merged successfully');
            setSpeakerDialogOpen(false);
            refetch();
        } catch (err: any) {
            toast.error(err?.toString() || 'Failed to merge speakers');
            throw err;
        }
    };

    return (
        <div className="flex-1 flex flex-col h-screen overflow-hidden bg-background">
            {/* Top Header */}
            <div className="p-6 pb-4 border-b border-border bg-card/40 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div className="space-y-1">
                        <div className="flex items-center gap-2.5">
                            <div className="p-2 rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-400">
                                <CheckSquare className="w-5 h-5" />
                            </div>
                            <h1 className="text-xl font-bold tracking-tight text-foreground">
                                My Action Items
                            </h1>
                        </div>
                        <p className="text-xs text-muted-foreground pl-9">
                            Extracted automatically from meeting transcripts with late-bound speaker identities
                        </p>
                    </div>

                    <div className="flex items-center gap-2 pl-9 sm:pl-0">
                        {/* Refresh Button */}
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => refetch()}
                            disabled={isLoading}
                            className="h-9 gap-1.5 text-xs"
                        >
                            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                            <span className="hidden sm:inline">Refresh</span>
                        </Button>
                    </div>
                </div>

                {/* Search Bar + Tabs Bar */}
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-1">
                    {/* Navigation Tabs */}
                    <div className="flex items-center gap-1.5 p-1 rounded-xl bg-muted/60 border border-border/50">
                        <button
                            type="button"
                            onClick={() => setTab('open')}
                            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                                tab === 'open'
                                    ? 'bg-background text-foreground shadow-xs'
                                    : 'text-muted-foreground hover:text-foreground'
                            }`}
                        >
                            <Clock className="w-3.5 h-3.5" />
                            <span>Open</span>
                            <span
                                className={`px-1.5 py-0.2 rounded-full text-[10px] font-semibold ${
                                    tab === 'open'
                                        ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
                                        : 'bg-muted text-muted-foreground'
                                }`}
                            >
                                {counts.open}
                            </span>
                        </button>

                        <button
                            type="button"
                            onClick={() => setTab('needs_review')}
                            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                                tab === 'needs_review'
                                    ? 'bg-background text-foreground shadow-xs'
                                    : 'text-muted-foreground hover:text-foreground'
                            }`}
                        >
                            <AlertCircle className="w-3.5 h-3.5 text-amber-500" />
                            <span>Needs Review</span>
                            {counts.needs_review > 0 && (
                                <span className="px-1.5 py-0.2 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                                    {counts.needs_review}
                                </span>
                            )}
                        </button>

                        <button
                            type="button"
                            onClick={() => setTab('done')}
                            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                                tab === 'done'
                                    ? 'bg-background text-foreground shadow-xs'
                                    : 'text-muted-foreground hover:text-foreground'
                            }`}
                        >
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                            <span>Completed</span>
                            <span
                                className={`px-1.5 py-0.2 rounded-full text-[10px] font-semibold ${
                                    tab === 'done'
                                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                                        : 'bg-muted text-muted-foreground'
                                }`}
                            >
                                {counts.done}
                            </span>
                        </button>
                    </div>

                    {/* Search Input */}
                    <div className="relative sm:w-72">
                        <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search tasks, meetings, assigners..."
                            className="pl-8 h-9 text-xs"
                        />
                        {searchQuery && (
                            <button
                                type="button"
                                onClick={() => setSearchQuery('')}
                                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
                            >
                                ✕
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Main Content Area */}
            <div className="flex-1 overflow-y-auto p-6">
                <div className="max-w-4xl mx-auto space-y-4">
                    {error && (
                        <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 dark:bg-red-950/40 dark:border-red-800/40 dark:text-red-300 text-xs flex items-center justify-between">
                            <span>{error}</span>
                            <Button size="sm" variant="outline" onClick={() => refetch()} className="h-7 text-xs">
                                Retry
                            </Button>
                        </div>
                    )}

                    <TaskList
                        items={items}
                        tab={tab}
                        onToggle={toggleStatus}
                        onSelect={handleSelectItem}
                        onConfirm={async (item) => {
                            try {
                                await confirmItem(item.id);
                                toast.success('Confirmed action item');
                            } catch (err: any) {
                                toast.error('Failed to confirm item');
                            }
                        }}
                        onReject={async (item) => {
                            try {
                                await rejectItem(item.id);
                                toast.info('Removed from your tasks');
                            } catch (err: any) {
                                toast.error('Failed to reject item');
                            }
                        }}
                        onClaim={async (item) => {
                            try {
                                await claimItem(item.id);
                                toast.success('Claimed action item');
                            } catch (err: any) {
                                toast.error('Failed to claim item');
                            }
                        }}
                        onIdentifySpeaker={handleIdentifySpeaker}
                    />
                </div>
            </div>

            {/* Task Evidence & Detail Drawer */}
            <TaskDrawer
                isOpen={!!selectedItem}
                onClose={() => {
                    setSelectedItem(null);
                    setEvidence(null);
                }}
                item={selectedItem}
                evidence={evidence}
                isLoadingEvidence={isLoadingEvidence}
                onToggleStatus={toggleStatus}
                onUpdateItem={async (id, patch) => {
                    await updateItem(id, patch);
                    if (selectedItem && selectedItem.id === id) {
                        setSelectedItem({
                            ...selectedItem,
                            ...(patch.content ? { task: patch.content } : {}),
                            ...(patch.due_date !== undefined ? { due_date: patch.due_date } : {}),
                        });
                    }
                }}
                onIdentifySpeaker={handleIdentifySpeaker}
            />

            {/* Speaker Rename & Merge Dialog */}
            <SpeakerRenameDialog
                isOpen={speakerDialogOpen}
                onClose={() => {
                    setSpeakerDialogOpen(false);
                    setTargetSpeaker(null);
                }}
                speaker={targetSpeaker}
                allSpeakers={meetingSpeakers}
                people={peopleList}
                onRename={handleSpeakerRename}
                onMerge={handleSpeakerMerge}
            />
        </div>
    );
}
