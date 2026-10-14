'use client';

import React, { useState, useEffect } from 'react';
import {
  Share2,
  Copy,
  Check,
  Globe,
  Users,
  Clock,
  Loader2,
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
  const [visibility, setVisibility] = useState<'members' | 'link'>('link');
  const [includeSources, setIncludeSources] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [createdResult, setCreatedResult] = useState<CreateShareResult | null>(null);
  const [hasCopied, setHasCopied] = useState(false);

  useEffect(() => {
    if (open && sessionId) {
      setCreatedResult(null);
      setHasCopied(false);
    }
  }, [open, sessionId]);

  const handleCreateAndCopyShare = async () => {
    if (!sessionId) return;
    setIsCreating(true);
    try {
      const result = await invoke<CreateShareResult>('api_chat_create_share', {
        sessionId,
        visibility,
        includeSources,
        expiresDays: 30, // Fixed 30-day validity
      });

      setCreatedResult(result);

      // Automatically copy to clipboard
      await navigator.clipboard.writeText(result.shareUrl);
      setHasCopied(true);
      toast.success('Share link generated and copied to clipboard! (Valid for 30 days)');
      setTimeout(() => setHasCopied(false), 2500);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px] p-0 overflow-hidden bg-white dark:bg-zinc-900 border-slate-200 dark:border-zinc-800 rounded-2xl shadow-xl">
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

        <div className="p-6 space-y-4">
          {/* Audience Access */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-800 dark:text-zinc-200 uppercase tracking-wider">
              Audience Access
            </label>
            <div className="grid grid-cols-2 gap-2.5">
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
            </div>
          </div>

          {/* Citations Switch */}
          <div className="flex items-center justify-between p-3.5 rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50/50 dark:bg-zinc-800/40">
            <div className="space-y-0.5">
              <div className="text-xs font-semibold text-slate-800 dark:text-zinc-200">
                Include Meeting Citations
              </div>
              <div className="text-[11px] text-slate-500 dark:text-zinc-400">
                Display quoted audio snippets and timestamps in the share
              </div>
            </div>
            <Switch
              checked={includeSources}
              onCheckedChange={setIncludeSources}
            />
          </div>

          {/* Validity Note */}
          <div className="flex items-center gap-2 p-3 rounded-xl bg-slate-50 dark:bg-zinc-800/50 border border-slate-200/80 dark:border-zinc-800 text-xs text-slate-600 dark:text-zinc-400">
            <Clock className="w-4 h-4 text-indigo-500 shrink-0" />
            <span>Shared links automatically expire <strong>30 days</strong> after creation.</span>
          </div>

          {/* Create & Copy Action Button */}
          <button
            onClick={handleCreateAndCopyShare}
            disabled={isCreating || !sessionId}
            className="w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:scale-[0.99] disabled:opacity-60 text-white font-medium text-xs flex items-center justify-center gap-2 shadow-xs transition-all cursor-pointer"
          >
            {isCreating ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Freezing Snapshot & Copying...</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Generate & Copy Share Link</span>
              </>
            )}
          </button>

          {/* Generated Link Display */}
          {createdResult && (
            <div className="p-4 rounded-xl border border-indigo-200 dark:border-indigo-900/60 bg-indigo-50/60 dark:bg-indigo-950/30 space-y-2.5 animate-in fade-in slide-in-from-top-1">
              <div className="flex items-center justify-between text-xs text-indigo-900 dark:text-indigo-200 font-semibold">
                <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                  <Check className="w-3.5 h-3.5" />
                  Link Copied to Clipboard
                </span>
                <span className="text-[10px] text-indigo-600 dark:text-indigo-400 font-normal">
                  Valid for 30 days
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
