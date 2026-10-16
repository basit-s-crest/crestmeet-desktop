'use client';

import React from 'react';
import { Mic, Volume2, Edit2, Sparkles } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MeetingSpeaker } from '@/types';

export interface SpeakerChipProps {
    speaker?: MeetingSpeaker | null;
    speakerName?: string;
    clusterKey?: string;
    channel?: 'mic' | 'system';
    onClick?: () => void;
    compact?: boolean;
    showEditOnHover?: boolean;
}

export const SpeakerChip: React.FC<SpeakerChipProps> = ({
    speaker,
    speakerName,
    clusterKey,
    channel = 'system',
    onClick,
    compact = false,
    showEditOnHover = true,
}) => {
    const effectiveName = speaker?.display_name || speakerName || speaker?.suggested_name || speaker?.cluster_key || clusterKey || 'Speaker';
    const effectiveChannel = speaker?.channel || channel;
    const isMic = effectiveChannel === 'mic';
    const hasSuggestion = Boolean(speaker?.suggested_name && !speaker?.display_name);

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        if (onClick) onClick();
                    }}
                    className={`inline-flex items-center gap-1.5 rounded-full font-medium transition-all group cursor-pointer ${
                        compact ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs'
                    } ${
                        isMic
                            ? 'bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-300 dark:hover:bg-blue-900/50 border border-blue-200/60 dark:border-blue-800/40'
                            : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200/80 dark:bg-zinc-800/70 dark:text-zinc-300 dark:hover:bg-zinc-700 border border-zinc-200 dark:border-zinc-700'
                    }`}
                >
                    {isMic ? (
                        <Mic className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} text-blue-600 dark:text-blue-400`} />
                    ) : (
                        <Volume2 className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} text-zinc-500 dark:text-zinc-400`} />
                    )}

                    <span className="font-semibold tracking-tight truncate max-w-[140px]">
                        {effectiveName}
                    </span>

                    {hasSuggestion && (
                        <Sparkles className="w-2.5 h-2.5 text-amber-500 animate-pulse" />
                    )}

                    {showEditOnHover && (
                        <Edit2 className="w-2.5 h-2.5 opacity-0 group-hover:opacity-100 transition-opacity ml-0.5 text-muted-foreground" />
                    )}
                </button>
            </TooltipTrigger>
            <TooltipContent side="top">
                <div className="text-xs space-y-0.5">
                    <p className="font-semibold">{effectiveName}</p>
                    <p className="text-muted-foreground text-[10px]">
                        {isMic ? 'Microphone (Me / Local)' : 'System Audio (Remote Participant)'}
                    </p>
                    <p className="text-[10px] text-blue-500 dark:text-blue-400">Click to rename or merge</p>
                </div>
            </TooltipContent>
        </Tooltip>
    );
};
