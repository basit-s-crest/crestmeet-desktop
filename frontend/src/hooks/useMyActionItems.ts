import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ActionItemEvidence, ActionItemsCount, ListActionItemsResponse, ResolvedActionItem } from '@/types';

export type ActionItemTab = 'open' | 'needs_review' | 'done';

export function useMyActionItems(projectId?: string) {
    const [tab, setTab] = useState<ActionItemTab>('open');
    const [searchQuery, setSearchQuery] = useState('');
    const [items, setItems] = useState<ResolvedActionItem[]>([]);
    const [counts, setCounts] = useState<ActionItemsCount>({ open: 0, needs_review: 0, done: 0 });
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const isFetchingRef = useRef(false);

    const fetchItems = useCallback(async () => {
        try {
            isFetchingRef.current = true;
            setIsLoading(true);
            const res = await invoke<ListActionItemsResponse>('api_list_my_action_items', {
                tab,
                projectId: projectId || null,
                search: searchQuery.trim() || null,
            });
            setItems(res.items);
            setCounts(res.counts);
            setError(null);
        } catch (err: any) {
            console.error('Failed to fetch action items:', err);
            setError(err?.toString() || 'Failed to fetch tasks');
        } finally {
            setIsLoading(false);
            isFetchingRef.current = false;
        }
    }, [tab, projectId, searchQuery]);

    useEffect(() => {
        fetchItems();
    }, [fetchItems]);

    // Real-time updates via Tauri event
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        listen('action-items-updated', () => {
            fetchItems();
        }).then((fn) => { unlisten = fn; });

        return () => {
            if (unlisten) unlisten();
        };
    }, [fetchItems]);

    // Optimistic status toggle (open <-> done)
    const toggleStatus = useCallback(async (item: ResolvedActionItem) => {
        const nextStatus = item.status === 'done' ? 'open' : 'done';
        const previousItems = [...items];

        // Optimistic update
        setItems((prev) =>
            prev.map((i) =>
                i.id === item.id ? { ...i, status: nextStatus, completed_at: nextStatus === 'done' ? new Date().toISOString() : null } : i
            )
        );

        try {
            await invoke('api_update_action_item', {
                id: item.id,
                patch: { status: nextStatus },
            });
        } catch (err) {
            console.error('Failed to toggle item status:', err);
            setItems(previousItems); // Rollback
            throw err;
        }
    }, [items]);

    const confirmItem = useCallback(async (id: string) => {
        const previousItems = [...items];
        setItems((prev) => prev.filter((i) => i.id !== id));
        try {
            await invoke('api_confirm_action_item', { id });
        } catch (err) {
            setItems(previousItems);
            throw err;
        }
    }, [items]);

    const rejectItem = useCallback(async (id: string) => {
        const previousItems = [...items];
        setItems((prev) => prev.filter((i) => i.id !== id));
        try {
            await invoke('api_reject_action_item', { id });
        } catch (err) {
            setItems(previousItems);
            throw err;
        }
    }, [items]);

    const claimItem = useCallback(async (id: string) => {
        const previousItems = [...items];
        setItems((prev) => prev.filter((i) => i.id !== id));
        try {
            await invoke('api_claim_action_item', { id });
        } catch (err) {
            setItems(previousItems);
            throw err;
        }
    }, [items]);

    const updateItem = useCallback(async (id: string, patch: { content?: string; due_date?: string; status?: 'open' | 'in_progress' | 'done' | 'dropped' }) => {
        try {
            await invoke('api_update_action_item', { id, patch });
            setItems((prev) =>
                prev.map((i) => {
                    if (i.id !== id) return i;
                    return {
                        ...i,
                        task: patch.content !== undefined ? patch.content : i.task,
                        due_date: patch.due_date !== undefined ? patch.due_date : i.due_date,
                        status: patch.status !== undefined ? patch.status : i.status,
                        user_edited: true,
                    };
                })
            );
        } catch (err) {
            console.error('Failed to update action item:', err);
            throw err;
        }
    }, []);

    const getEvidence = useCallback(async (id: string): Promise<ActionItemEvidence | null> => {
        try {
            return await invoke<ActionItemEvidence | null>('api_get_action_item_evidence', { id });
        } catch (err) {
            console.error('Failed to get item evidence:', err);
            return null;
        }
    }, []);

    return {
        tab,
        setTab,
        searchQuery,
        setSearchQuery,
        items,
        counts,
        isLoading,
        error,
        refetch: fetchItems,
        toggleStatus,
        confirmItem,
        rejectItem,
        claimItem,
        updateItem,
        getEvidence,
    };
}
