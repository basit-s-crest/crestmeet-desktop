'use client';

import React, { useState } from 'react';
import { useMeetingSpeakers } from '@/hooks/useMeetingSpeakers';
import { SpeakerChip } from './SpeakerChip';
import { SpeakerRenameDialog } from './SpeakerRenameDialog';
import { MeetingSpeaker } from '@/types';
import { Users, Sparkles, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';

export interface MeetingSpeakersBarProps {
    meetingId: string;
    className?: string;
}

export const MeetingSpeakersBar: React.FC<MeetingSpeakersBarProps> = ({
    meetingId,
    className = '',
}) => {
    const { speakers, people, isLoading, renameSpeaker, mergeSpeakers, fetchSpeakers } = useMeetingSpeakers(meetingId);
    const [selectedSpeaker, setSelectedSpeaker] = useState<MeetingSpeaker | null>(null);
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [isScanningOcr, setIsScanningOcr] = useState(false);

    if (isLoading && speakers.length === 0) {
        return null;
    }

    if (speakers.length === 0) {
        return null;
    }

    const handleSpeakerClick = (speaker: MeetingSpeaker) => {
        setSelectedSpeaker(speaker);
        setIsDialogOpen(true);
    };

    const handleRunOcrScan = async () => {
        try {
            setIsScanningOcr(true);
            const count = await invoke<number>('api_run_screen_ocr_naming', { meetingId });
            if (count > 0) {
                toast.success(`Screen OCR updated ${count} speaker(s)`);
            } else {
                toast.info('No new speaker names identified from video frames');
            }
            fetchSpeakers();
        } catch (err: any) {
            console.error('OCR scan failed:', err);
            toast.error(err?.toString() || 'Failed to scan screen names');
        } finally {
            setIsScanningOcr(false);
        }
    };

    const hasUnresolved = speakers.some(
        (s) => s.channel !== 'mic' && s.name_source !== 'manual' && (!s.display_name || (s.name_confidence || 0) < 0.7)
    );

    return (
        <>
            <div className={`flex flex-wrap items-center justify-between gap-2 py-2 px-3 bg-muted/40 rounded-xl border border-border/60 ${className}`}>
                <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium mr-1">
                        <Users className="w-3.5 h-3.5 text-zinc-500" />
                        <span>Speakers ({speakers.length}):</span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                        {speakers.map((speaker) => (
                            <SpeakerChip
                                key={speaker.id}
                                speaker={speaker}
                                onClick={() => handleSpeakerClick(speaker)}
                            />
                        ))}
                    </div>
                </div>

                {hasUnresolved && (
                    <button
                        type="button"
                        onClick={handleRunOcrScan}
                        disabled={isScanningOcr}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-50 text-amber-800 hover:bg-amber-100 dark:bg-amber-950/60 dark:text-amber-300 dark:hover:bg-amber-950 transition-all border border-amber-200/60 dark:border-amber-900/50"
                    >
                        {isScanningOcr ? (
                            <Loader2 className="w-3 h-3 animate-spin text-amber-600" />
                        ) : (
                            <Sparkles className="w-3 h-3 text-amber-600 dark:text-amber-400" />
                        )}
                        <span>{isScanningOcr ? 'Scanning video...' : 'Scan Screen Names'}</span>
                    </button>
                )}
            </div>

            <SpeakerRenameDialog
                isOpen={isDialogOpen}
                onClose={() => {
                    setIsDialogOpen(false);
                    setSelectedSpeaker(null);
                }}
                speaker={selectedSpeaker}
                allSpeakers={speakers}
                people={people}
                onRename={renameSpeaker}
                onMerge={mergeSpeakers}
            />
        </>
    );
};
