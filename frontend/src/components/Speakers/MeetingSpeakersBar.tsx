'use client';

import React, { useState } from 'react';
import { useMeetingSpeakers } from '@/hooks/useMeetingSpeakers';
import { SpeakerChip } from './SpeakerChip';
import { SpeakerRenameDialog } from './SpeakerRenameDialog';
import { MeetingSpeaker } from '@/types';
import { Users, Sparkles } from 'lucide-react';

export interface MeetingSpeakersBarProps {
    meetingId: string;
    className?: string;
}

export const MeetingSpeakersBar: React.FC<MeetingSpeakersBarProps> = ({
    meetingId,
    className = '',
}) => {
    const { speakers, people, isLoading, renameSpeaker, mergeSpeakers } = useMeetingSpeakers(meetingId);
    const [selectedSpeaker, setSelectedSpeaker] = useState<MeetingSpeaker | null>(null);
    const [isDialogOpen, setIsDialogOpen] = useState(false);

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

    return (
        <>
            <div className={`flex flex-wrap items-center gap-2 py-2 px-3 bg-muted/40 rounded-xl border border-border/60 ${className}`}>
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
