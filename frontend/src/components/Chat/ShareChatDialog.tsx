'use client';

import React, { useState, useEffect } from 'react';
import {
  Share2,
  Copy,
  Check,
  Globe,
  Users,
  ShieldAlert,
  Clock,
  Eye,
  Trash2,
  Loader2,
  ExternalLink,
  FileText,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';

export interface ChatShareRecord {
  id: string;
  sessionId: string;
  createdBy: string;
  visibility: 'members' | 'link';
  title: string;
  projectIds: string[];
  includeSources: boolean;
  snapshotUptoSeq: number;
  expiresAt?: string;
  revokedAt?: string;
  viewCount: number;
  lastViewedAt?: string;
  createdAt: string;
}

interface CreateShareResult {
  shareId: string;
  token: string;
  shareUrl: string;
  expiresAt?: string;
}

interface ShareChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string | null;
  sessionTitle?: string;
}

export function ShareChatDialog({
  open,
  onOpenChange,
  sessionId,
  sessionTitle,
}: ShareChatDialogProps) {
  const [visibility, setVisibility] = useState<'members' | 'link'>('members');
  const [includeSources, setIncludeSources] = useState(true);
  const [expiresDays, setExpiresDays] = useState<number | null>(30);
  const [isCreating, setIsCreating] = useState(false);
  const [createdResult, setCreatedResult] = useState<CreateShareResult | null>(null);
  const [hasCopied, setHasCopied] = useState(false);

  const [sharesList, setSharesList] = useState<ChatShareRecord[]>([]);
  const [isLoadingShares, setIsLoadingShares] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    if (open && sessionId) {
      loadShares(sessionId);
      setCreatedResult(null);
      setHasCopied(false);
    }
  }, [open, sessionId]);

  const loadShares = async (sid: string) => {
    setIsLoadingShares(true);
    try {
      const records = await invoke<ChatShareRecord[]>('api_chat_list_shares', {
        sessionId: sid,
      });
      setSharesList(records || []);
    } catch (err: any) {
      console.warn('Failed to load active shares:', err);
    } finally {
      setIsLoadingShares(false);
    }
  };

  const handleCreateShare = async () => {
    if (!sessionId) return;
    setIsCreating(true);
    try {
      const result = await invoke<CreateShareResult>('api_chat_create_share', {
        sessionId,
        visibility,
        includeSources,
        expiresDays,
      });

      setCreatedResult(result);
      await loadShares(sessionId);
      toast.success('Share snapshot created');
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message || 'Failed to create share link';
      toast.error(msg);
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopyLink = (url: string) => {
    navigator.clipboard.writeText(url);
    setHasCopied(true);
    toast.success('Share link copied to clipboard');
    setTimeout(() => setHasCopied(false), 2200);
  };

  const handleRevokeShare = async (shareId: string) => {
    if (!sessionId) return;
    setRevokingId(shareId);
    try {
      await invoke('api_chat_revoke_share', { shareId });
      toast.success('Share link revoked');
      setSharesList((prev) => prev.filter((s) => s.id !== shareId));
      if (createdResult?.shareId === shareId) {
        setCreatedResult(null);
      }
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message || 'Failed to revoke link';
      toast.error(msg);
    } finally {
      setRevokingId(null);
    }
  };

  const formatExpiry = (expiresAt?: string) => {
    if (!expiresAt) return 'Never expires';
    const date = new Date(expiresAt);
    return `Expires ${date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })}`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[540px] p-0 overflow-hidden bg-white dark:bg-zinc-900 border-slate-200 dark:border-zinc-800 rounded-2xl shadow-xl">
        <div className="p-6 border-b border-slate-100 dark:border-zinc-800/80">
          <DialogHeader>
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-100 dark:border-indigo-900/60 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shadow-2xs">
                <Share2 className="w-4 h-4" />
              </div>
              <div>
                <DialogTitle className="text-base font-semibold text-slate-900 dark:text-zinc-100">
                  Share Conversation Snapshot
                </DialogTitle>
                <DialogDescription className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5 truncate max-w-sm">
                  {sessionTitle || 'Current Chat'}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
        </div>

        <div className="p-6 space-y-5 max-h-[72vh] overflow-y-auto">
          {/* Share options */}
          <div className="space-y-4">
            {/* Visibility Selector */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-800 dark:text-zinc-200 uppercase tracking-wider">
                Audience Access
              </label>
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setVisibility('members')}
                  className={`p-3 rounded-xl border text-left flex flex-col gap-1 transition-all cursor-pointer ${
                    visibility === 'members'
                      ? 'border-indigo-600 bg-indigo-50/50 dark:bg-indigo-950/30 text-indigo-900 dark:text-indigo-200 ring-1 ring-indigo-600/30'
                      : 'border-slate-200 dark:border-zinc-800 hover:border-slate-300 dark:hover:border-zinc-700 bg-transparent text-slate-700 dark:text-zinc-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                    <span className="text-xs font-semibold">Project Members</span>
                  </div>
                  <span className="text-[11px] text-slate-500 dark:text-zinc-400">
                    Restricted to authenticated teammates
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setVisibility('link')}
                  className={`p-3 rounded-xl border text-left flex flex-col gap-1 transition-all cursor-pointer ${
                    visibility === 'link'
                      ? 'border-indigo-600 bg-indigo-50/50 dark:bg-indigo-950/30 text-indigo-900 dark:text-indigo-200 ring-1 ring-indigo-600/30'
                      : 'border-slate-200 dark:border-zinc-800 hover:border-slate-300 dark:hover:border-zinc-700 bg-transparent text-slate-700 dark:text-zinc-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Globe className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                    <span className="text-xs font-semibold">Anyone with Link</span>
                  </div>
                  <span className="text-[11px] text-slate-500 dark:text-zinc-400">
                    Read-only snapshot access
                  </span>
                </button>
              </div>
            </div>

            {/* Citations Switch */}
            <div className="flex items-center justify-between p-3.5 rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50/50 dark:bg-zinc-800/40">
              <div className="space-y-0.5">
                <div className="text-xs font-semibold text-slate-800 dark:text-zinc-200">
                  Include Meeting Citations
                </div>
                <div className="text-[11px] text-slate-500 dark:text-zinc-400">
                  Display quoted audio snippets and meeting timestamps in the share
                </div>
              </div>
              <Switch
                checked={includeSources}
                onCheckedChange={setIncludeSources}
              />
            </div>

            {/* Expiration Selector */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-800 dark:text-zinc-200">
                Link Expiration
              </label>
              <select
                value={expiresDays ?? 'never'}
                onChange={(e) => {
                  const val = e.target.value;
                  setExpiresDays(val === 'never' ? null : Number(val));
                }}
                className="w-full text-xs px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-slate-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 cursor-pointer"
              >
                <option value="7">7 days</option>
                <option value="30">30 days (Recommended)</option>
                <option value="90">90 days</option>
                <option value="never">Never expire</option>
              </select>
            </div>

            {/* Create Action Button */}
            <button
              onClick={handleCreateShare}
              disabled={isCreating || !sessionId}
              className="w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-medium text-xs flex items-center justify-center gap-2 shadow-xs transition-colors cursor-pointer"
            >
              {isCreating ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Freezing Snapshot...</span>
                </>
              ) : (
                <>
                  <Share2 className="w-3.5 h-3.5" />
                  <span>Generate Share Link</span>
                </>
              )}
            </button>
          </div>

          {/* Generated Link Display */}
          {createdResult && (
            <div className="p-4 rounded-xl border border-indigo-200 dark:border-indigo-900/60 bg-indigo-50/60 dark:bg-indigo-950/30 space-y-2.5 animate-in fade-in slide-in-from-top-1">
              <div className="flex items-center justify-between text-xs text-indigo-900 dark:text-indigo-200 font-semibold">
                <span>Snapshot Link Ready</span>
                <span className="text-[10px] text-indigo-600 dark:text-indigo-400 font-normal">
                  {formatExpiry(createdResult.expiresAt)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={createdResult.shareUrl}
                  className="flex-1 text-xs px-3 py-2 rounded-lg border border-indigo-200 dark:border-indigo-800 bg-white dark:bg-zinc-900 text-slate-800 dark:text-zinc-200 select-all font-mono"
                />
                <button
                  onClick={() => handleCopyLink(createdResult.shareUrl)}
                  className="p-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer shadow-2xs"
                  title="Copy link"
                >
                  {hasCopied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-300" />
                      <span className="text-[11px]">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span className="text-[11px]">Copy</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Existing Active Shares Table */}
          <div className="pt-2 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-800 dark:text-zinc-200 uppercase tracking-wider">
                Active Shared Links
              </span>
              {isLoadingShares && <Loader2 className="w-3 h-3 animate-spin text-slate-400" />}
            </div>

            {sharesList.length === 0 ? (
              <p className="text-[11px] text-slate-400 dark:text-zinc-500 italic py-2">
                No active share links for this conversation yet.
              </p>
            ) : (
              <div className="space-y-2">
                {sharesList.map((s) => {
                  const shareUrl = `https://crestmeet.app/share/${s.id}`;
                  return (
                    <div
                      key={s.id}
                      className="p-3 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${
                              s.visibility === 'link'
                                ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200/60'
                                : 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 border border-indigo-200/60'
                            }`}
                          >
                            {s.visibility === 'link' ? 'Anyone with Link' : 'Members Only'}
                          </span>
                          <span className="text-[11px] text-slate-500 dark:text-zinc-400 flex items-center gap-1">
                            <Eye className="w-3 h-3 text-slate-400" />
                            {s.viewCount} {s.viewCount === 1 ? 'view' : 'views'}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-zinc-400 flex items-center gap-1.5">
                          <Clock className="w-3 h-3 text-slate-400" />
                          <span>{formatExpiry(s.expiresAt)}</span>
                          {!s.includeSources && (
                            <span className="text-amber-600 dark:text-amber-400">
                              (sources omitted)
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          onClick={() => handleCopyLink(shareUrl)}
                          className="p-1.5 rounded-lg text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
                          title="Copy share link"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleRevokeShare(s.id)}
                          disabled={revokingId === s.id}
                          className="p-1.5 rounded-lg text-rose-500 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors disabled:opacity-50"
                          title="Revoke and disable this share link"
                        >
                          {revokingId === s.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
