'use client';

import React, { useState, useEffect } from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MeetingSpeaker, Person } from '@/types';
import { User, Users, Merge, Mic, Volume2, Sparkles, Check, AlertTriangle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

export interface SpeakerRenameDialogProps {
    isOpen: boolean;
    onClose: () => void;
    speaker: MeetingSpeaker | null;
    allSpeakers: MeetingSpeaker[];
    people: Person[];
    onRename: (speakerId: string, displayName: string, personId?: string) => Promise<any>;
    onMerge: (targetSpeakerId: string, sourceSpeakerId: string) => Promise<any>;
}

export const SpeakerRenameDialog: React.FC<SpeakerRenameDialogProps> = ({
    isOpen,
    onClose,
    speaker,
    allSpeakers,
    people,
    onRename,
    onMerge,
}) => {
    const [name, setName] = useState('');
    const [selectedPersonId, setSelectedPersonId] = useState<string | undefined>(undefined);
    const [targetMergeSpeakerId, setTargetMergeSpeakerId] = useState<string>('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [optInVoiceProfile, setOptInVoiceProfile] = useState(false);
    const [activeTab, setActiveTab] = useState<'rename' | 'merge'>('rename');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (speaker) {
            setName(speaker.display_name || speaker.suggested_name || '');
            setSelectedPersonId(speaker.person_id || undefined);
            setTargetMergeSpeakerId('');
            setOptInVoiceProfile(false);
            setError(null);
            setActiveTab('rename');
        }
    }, [speaker]);

    if (!speaker) return null;

    const otherSpeakers = allSpeakers.filter((s) => s.id !== speaker.id);

    const handleSelectPerson = (person: Person) => {
        setName(person.display_name);
        setSelectedPersonId(person.id);
    };

    const handleRenameSubmit = async (e?: React.FormEvent) => {
        if (e) e.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) {
            setError('Please enter a valid speaker name.');
            return;
        }

        try {
            setIsSubmitting(true);
            setError(null);
            await onRename(speaker.id, trimmed, selectedPersonId);

            if (optInVoiceProfile && selectedPersonId) {
                try {
                    await invoke('api_enroll_voice_profile', {
                        personId: selectedPersonId,
                        speakerId: speaker.id,
                    });
                } catch (enrollErr) {
                    console.warn('Voice profile opt-in enrollment failed:', enrollErr);
                }
            }

            onClose();
        } catch (err: any) {
            setError(err?.toString() || 'Failed to rename speaker.');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleMergeSubmit = async () => {
        if (!targetMergeSpeakerId) {
            setError('Please select a speaker to merge into.');
            return;
        }

        try {
            setIsSubmitting(true);
            setError(null);
            await onMerge(targetMergeSpeakerId, speaker.id);
            onClose();
        } catch (err: any) {
            setError(err?.toString() || 'Failed to merge speakers.');
        } finally {
            setIsSubmitting(false);
        }
    };

    const isMic = speaker.channel === 'mic';
    const clusterLabel = speaker.cluster_key;

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-[480px]">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
                        {isMic ? (
                            <span className="p-1.5 rounded-lg bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                                <Mic className="w-4 h-4" />
                            </span>
                        ) : (
                            <span className="p-1.5 rounded-lg bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                                <Volume2 className="w-4 h-4" />
                            </span>
                        )}
                        <span>Edit Speaker: {speaker.display_name || clusterLabel}</span>
                    </DialogTitle>
                    <DialogDescription className="text-xs text-muted-foreground">
                        Channel: <span className="font-mono font-medium">{speaker.channel}</span> ({clusterLabel})
                        {speaker.name_confidence && (
                            <span className="ml-2 font-mono">
                                • Confidence: {Math.round(speaker.name_confidence * 100)}%
                            </span>
                        )}
                    </DialogDescription>
                </DialogHeader>

                <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)} className="w-full mt-2">
                    <TabsList className="grid w-full grid-cols-2">
                        <TabsTrigger value="rename" className="flex items-center gap-1.5 text-xs">
                            <User className="w-3.5 h-3.5" />
                            <span>Rename Speaker</span>
                        </TabsTrigger>
                        <TabsTrigger value="merge" className="flex items-center gap-1.5 text-xs">
                            <Merge className="w-3.5 h-3.5" />
                            <span>Merge Cluster</span>
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="rename" className="space-y-4 pt-3">
                        <form onSubmit={handleRenameSubmit} className="space-y-4">
                            <div>
                                <label className="text-xs font-medium text-foreground block mb-1.5">
                                    Display Name
                                </label>
                                <Input
                                    value={name}
                                    onChange={(e) => {
                                        setName(e.target.value);
                                        // If user edits text manually, clear matched person ID unless it matches
                                        if (selectedPersonId) {
                                            const match = people.find((p) => p.id === selectedPersonId);
                                            if (match && match.display_name !== e.target.value) {
                                                setSelectedPersonId(undefined);
                                            }
                                        }
                                    }}
                                    placeholder="e.g. Alex, Maya Chen"
                                    autoFocus
                                    className="w-full"
                                />
                            </div>

                            {/* One-click OCR or Voice suggestion chip if present */}
                            {speaker.suggested_name && speaker.suggested_name !== name && (
                                <div className="p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/40 flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <Sparkles className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                                        <div className="text-xs text-amber-900 dark:text-amber-200">
                                            Suggested from screen OCR: <strong>{speaker.suggested_name}</strong>
                                        </div>
                                    </div>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        className="h-7 text-xs bg-white dark:bg-zinc-900 border-amber-300"
                                        onClick={() => setName(speaker.suggested_name!)}
                                    >
                                        Use Suggestion
                                    </Button>
                                </div>
                            )}

                            {/* Known Attendees / People Chips */}
                            {people.length > 0 && (
                                <div>
                                    <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">
                                        Known Attendees & Team Members
                                    </label>
                                    <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto p-1">
                                        {people.map((p) => {
                                            const isSelected = selectedPersonId === p.id || name.toLowerCase() === p.display_name.toLowerCase();
                                            return (
                                                <button
                                                    key={p.id}
                                                    type="button"
                                                    onClick={() => handleSelectPerson(p)}
                                                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all ${
                                                        isSelected
                                                            ? 'bg-blue-600 text-white shadow-sm'
                                                            : 'bg-muted hover:bg-muted/80 text-foreground border border-border'
                                                    }`}
                                                >
                                                    {isSelected && <Check className="w-3 h-3" />}
                                                    <span>{p.display_name}</span>
                                                    {p.email && (
                                                        <span className="text-[10px] opacity-75 hidden sm:inline">
                                                            ({p.email.split('@')[0]})
                                                        </span>
                                                    )}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* Opt-in Voice Profile Checkbox */}
                            {selectedPersonId && (
                                <div className="flex items-start gap-2 pt-1 pb-1 px-1">
                                    <input
                                        type="checkbox"
                                        id="opt-in-voice"
                                        checked={optInVoiceProfile}
                                        onChange={(e) => setOptInVoiceProfile(e.target.checked)}
                                        className="mt-0.5 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                                    />
                                    <label htmlFor="opt-in-voice" className="text-[11px] text-muted-foreground leading-snug cursor-pointer select-none">
                                        <span className="font-medium text-foreground">Save voice profile</span> for future meetings (opt-in biometric voice matching)
                                    </label>
                                </div>
                            )}

                            {error && (
                                <p className="text-xs text-red-600 dark:text-red-400 font-medium">{error}</p>
                            )}

                            <DialogFooter className="pt-2">
                                <Button type="button" variant="ghost" onClick={onClose} disabled={isSubmitting}>
                                    Cancel
                                </Button>
                                <Button type="submit" disabled={isSubmitting || !name.trim()}>
                                    {isSubmitting ? 'Saving...' : 'Save Name'}
                                </Button>
                            </DialogFooter>
                        </form>
                    </TabsContent>

                    <TabsContent value="merge" className="space-y-4 pt-3">
                        <div className="p-3 rounded-lg bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-800/40 text-xs text-orange-800 dark:text-orange-200 flex items-start gap-2">
                            <AlertTriangle className="w-4 h-4 text-orange-600 shrink-0 mt-0.5" />
                            <div>
                                Merging will reassign <strong>all transcript turns</strong> and <strong>action items</strong> from{' '}
                                <span className="font-semibold">{speaker.display_name || clusterLabel}</span> to the selected speaker, and remove this duplicate cluster.
                            </div>
                        </div>

                        {otherSpeakers.length === 0 ? (
                            <p className="text-xs text-muted-foreground py-4 text-center">
                                No other speakers in this meeting to merge with.
                            </p>
                        ) : (
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-foreground block">
                                    Select Target Speaker
                                </label>
                                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                                    {otherSpeakers.map((s) => {
                                        const isSelected = targetMergeSpeakerId === s.id;
                                        return (
                                            <div
                                                key={s.id}
                                                onClick={() => setTargetMergeSpeakerId(s.id)}
                                                className={`p-2.5 rounded-lg border cursor-pointer flex items-center justify-between text-xs transition-colors ${
                                                    isSelected
                                                        ? 'border-blue-600 bg-blue-50/70 dark:bg-blue-950/40'
                                                        : 'border-border hover:bg-muted/50'
                                                }`}
                                            >
                                                <div className="flex items-center gap-2">
                                                    <Users className="w-3.5 h-3.5 text-muted-foreground" />
                                                    <span className="font-medium text-foreground">
                                                        {s.display_name || s.cluster_key}
                                                    </span>
                                                    <span className="text-[10px] text-muted-foreground font-mono">
                                                        ({s.channel}:{s.cluster_key})
                                                    </span>
                                                </div>
                                                {isSelected && <Check className="w-4 h-4 text-blue-600" />}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {error && (
                            <p className="text-xs text-red-600 dark:text-red-400 font-medium">{error}</p>
                        )}

                        <DialogFooter className="pt-2">
                            <Button type="button" variant="ghost" onClick={onClose} disabled={isSubmitting}>
                                Cancel
                            </Button>
                            <Button
                                type="button"
                                variant="destructive"
                                onClick={handleMergeSubmit}
                                disabled={isSubmitting || !targetMergeSpeakerId}
                            >
                                {isSubmitting ? 'Merging...' : 'Confirm Merge'}
                            </Button>
                        </DialogFooter>
                    </TabsContent>
                </Tabs>
            </DialogContent>
        </Dialog>
    );
};
