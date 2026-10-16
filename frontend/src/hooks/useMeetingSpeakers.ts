import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { MeetingSpeaker, Person } from '@/types';

export function useMeetingSpeakers(meetingId?: string) {
    const [speakers, setSpeakers] = useState<MeetingSpeaker[]>([]);
    const [people, setPeople] = useState<Person[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchSpeakers = useCallback(async () => {
        if (!meetingId) return;
        try {
            setIsLoading(true);
            const data = await invoke<MeetingSpeaker[]>('api_list_meeting_speakers', { meetingId });
            setSpeakers(data);
            setError(null);
        } catch (err: any) {
            console.error('Failed to fetch meeting speakers:', err);
            setError(err?.toString() || 'Failed to fetch speakers');
        } finally {
            setIsLoading(false);
        }
    }, [meetingId]);

    const fetchPeople = useCallback(async () => {
        try {
            const data = await invoke<Person[]>('api_list_people');
            setPeople(data);
        } catch (err) {
            console.error('Failed to fetch people list:', err);
        }
    }, []);

    const renameSpeaker = useCallback(async (speakerId: string, displayName: string, personId?: string) => {
        try {
            const updated = await invoke<MeetingSpeaker>('api_rename_speaker', {
                speakerId,
                displayName,
                personId: personId || null,
            });
            setSpeakers(prev => prev.map(s => s.id === speakerId ? updated : s));
            return updated;
        } catch (err: any) {
            console.error('Failed to rename speaker:', err);
            throw err;
        }
    }, []);

    const mergeSpeakers = useCallback(async (targetSpeakerId: string, sourceSpeakerId: string) => {
        if (!meetingId) return;
        try {
            await invoke('api_merge_speakers', {
                meetingId,
                targetSpeakerId,
                sourceSpeakerId,
            });
            setSpeakers(prev => prev.filter(s => s.id !== sourceSpeakerId));
        } catch (err: any) {
            console.error('Failed to merge speakers:', err);
            throw err;
        }
    }, [meetingId]);

    const autoLinkMic = useCallback(async () => {
        if (!meetingId) return;
        try {
            const linked = await invoke<MeetingSpeaker | null>('api_auto_link_mic_speaker', { meetingId });
            if (linked) {
                setSpeakers(prev => prev.map(s => s.id === linked.id ? linked : s));
            }
        } catch (err) {
            console.error('Failed to auto link mic speaker:', err);
        }
    }, [meetingId]);

    useEffect(() => {
        fetchSpeakers();
        fetchPeople();
    }, [fetchSpeakers, fetchPeople]);

    useEffect(() => {
        if (!meetingId) return;

        let unlisten: (() => void) | undefined;
        listen<{ meeting_id: string }>('speakers-updated', (event) => {
            if (event.payload?.meeting_id === meetingId) {
                fetchSpeakers();
            }
        }).then(fn => { unlisten = fn; });

        return () => {
            if (unlisten) unlisten();
        };
    }, [meetingId, fetchSpeakers]);

    // Create a quick lookup map by speaker_id and by cluster_key
    const speakersById = speakers.reduce<Record<string, MeetingSpeaker>>((acc, s) => {
        acc[s.id] = s;
        return acc;
    }, {});

    return {
        speakers,
        speakersById,
        people,
        isLoading,
        error,
        fetchSpeakers,
        renameSpeaker,
        mergeSpeakers,
        autoLinkMic,
    };
}
