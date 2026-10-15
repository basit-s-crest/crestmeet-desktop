'use client';

import React, { useState, useMemo } from 'react';
import {
  MessageSquare,
  Plus,
  Search,
  Pin,
  PinOff,
  Edit2,
  Trash2,
  Archive,
  MoreHorizontal,
  Check,
  X,
  Clock,
  Sparkles,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export interface ChatSessionRecord {
  id: string;
  userId: string;
  title: string;
  titleSource: string;
  scopeProjectIds?: string[];
  pinned: boolean;
  archivedAt?: string;
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
}

interface ChatHistorySidebarProps {
  sessions: ChatSessionRecord[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewChat: () => void;
  onRenameSession: (sessionId: string, newTitle: string) => Promise<void>;
  onPinSession: (sessionId: string, pinned: boolean) => Promise<void>;
  onArchiveSession: (sessionId: string, archive: boolean) => Promise<void>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  isLoading: boolean;
}

export function ChatHistorySidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewChat,
  onRenameSession,
  onPinSession,
  onArchiveSession,
  onDeleteSession,
  isLoading,
}: ChatHistorySidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  const handleStartRename = (session: ChatSessionRecord) => {
    setEditingId(session.id);
    setEditTitle(session.title);
  };

  const handleSaveRename = async (sessionId: string) => {
    if (editTitle.trim()) {
      await onRenameSession(sessionId, editTitle.trim());
    }
    setEditingId(null);
  };

  // Group sessions by date and pinned status
  const groupedSessions = useMemo(() => {
    const filtered = sessions.filter((s) =>
      s.title.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = todayStart - 86400000;
    const sevenDaysAgo = todayStart - 7 * 86400000;
    const thirtyDaysAgo = todayStart - 30 * 86400000;

    const pinned: ChatSessionRecord[] = [];
    const today: ChatSessionRecord[] = [];
    const yesterday: ChatSessionRecord[] = [];
    const prev7Days: ChatSessionRecord[] = [];
    const prev30Days: ChatSessionRecord[] = [];
    const older: ChatSessionRecord[] = [];

    for (const session of filtered) {
      // Never show 0-message empty sessions in history sidebar
      if (session.messageCount === 0) {
        continue;
      }

      if (session.pinned) {
        pinned.push(session);
        continue;
      }

      const sessionTime = new Date(session.lastMessageAt).getTime();
      if (sessionTime >= todayStart) {
        today.push(session);
      } else if (sessionTime >= yesterdayStart) {
        yesterday.push(session);
      } else if (sessionTime >= sevenDaysAgo) {
        prev7Days.push(session);
      } else if (sessionTime >= thirtyDaysAgo) {
        prev30Days.push(session);
      } else {
        older.push(session);
      }
    }

    return {
      Pinned: pinned,
      Today: today,
      Yesterday: yesterday,
      'Previous 7 Days': prev7Days,
      'Previous 30 Days': prev30Days,
      Older: older,
    };
  }, [sessions, searchQuery]);

  return (
    <aside className="w-64 flex-shrink-0 flex flex-col h-full bg-white dark:bg-zinc-900 border-r border-slate-200/90 dark:border-zinc-800 select-none">
      {/* Top Header Aligned with Main Chat Workspace Header (h-16) */}
      <div className="h-16 px-3 flex items-center border-b border-slate-200/90 dark:border-zinc-800">
        <Button
          onClick={onNewChat}
          className="w-full justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 active:scale-[0.99] text-white font-medium rounded-xl shadow-xs h-9 text-xs transition-all"
        >
          <Plus className="w-4 h-4" />
          <span>New Chat</span>
        </Button>
      </div>

      {/* Search Bar */}
      <div className="px-3 pt-3 pb-1">
        <div className="relative flex items-center">
          <Search className="w-3.5 h-3.5 absolute left-3 text-slate-400 dark:text-zinc-500 pointer-events-none" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search conversations..."
            className="pl-9 pr-3 h-8 text-xs bg-slate-50/70 dark:bg-zinc-800/50 border-slate-200/80 dark:border-zinc-700/70 rounded-xl focus-visible:ring-2 focus-visible:ring-indigo-500/20 focus-visible:border-indigo-500 text-slate-800 dark:text-zinc-200 placeholder:text-slate-400 dark:placeholder:text-zinc-500 shadow-none transition-all"
          />
        </div>
      </div>

      {/* Sessions List */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-4 scrollbar-thin scrollbar-thumb-slate-200 dark:scrollbar-thumb-zinc-800">
        {isLoading && sessions.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-xs text-slate-400 dark:text-zinc-500">
            <Clock className="w-4 h-4 animate-spin mr-2 text-indigo-500" />
            Loading chats...
          </div>
        ) : sessions.length === 0 ? (
          <div className="text-center py-10 px-4">
            <div className="w-9 h-9 rounded-2xl bg-indigo-50/60 dark:bg-indigo-950/40 border border-indigo-100 dark:border-indigo-900/40 flex items-center justify-center text-indigo-500 mx-auto mb-2">
              <MessageSquare className="w-4 h-4" />
            </div>
            <p className="text-xs font-semibold text-slate-700 dark:text-zinc-300">No chat history</p>
            <p className="text-[11px] text-slate-400 dark:text-zinc-500 mt-1 leading-normal">
              Ask anything about your meetings to start
            </p>
          </div>
        ) : (
          Object.entries(groupedSessions).map(([groupTitle, groupItems]) => {
            if (groupItems.length === 0) return null;

            return (
              <div key={groupTitle} className="space-y-1">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-zinc-500 px-2.5 py-1">
                  {groupTitle}
                </div>

                <div className="space-y-0.5">
                  {groupItems.map((session) => {
                    const isActive = activeSessionId === session.id;

                    return (
                      <div
                        key={session.id}
                        onClick={() => onSelectSession(session.id)}
                        className={`group relative flex items-center justify-between px-2.5 py-2 rounded-xl text-xs cursor-pointer transition-all duration-150 ${
                          isActive
                            ? 'bg-indigo-50/90 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 font-medium border border-indigo-200/70 dark:border-indigo-800/60 shadow-2xs'
                            : 'text-slate-600 dark:text-zinc-400 hover:bg-slate-100/70 dark:hover:bg-zinc-800/60 hover:text-slate-900 dark:hover:text-zinc-200 border border-transparent'
                        }`}
                      >
                        {editingId === session.id ? (
                          <div
                            className="flex items-center gap-1.5 w-full"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Input
                              value={editTitle}
                              onChange={(e) => setEditTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSaveRename(session.id);
                                if (e.key === 'Escape') setEditingId(null);
                              }}
                              autoFocus
                              className="h-6.5 text-xs bg-white dark:bg-zinc-950 border-indigo-500 text-slate-900 dark:text-zinc-100 px-2 rounded-lg"
                            />
                            <button
                              onClick={() => handleSaveRename(session.id)}
                              className="p-1 hover:text-green-600 text-slate-400 transition-colors"
                              title="Save"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="p-1 hover:text-red-500 text-slate-400 transition-colors"
                              title="Cancel"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center gap-2 truncate pr-1">
                              {session.pinned ? (
                                <Pin className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                              ) : (
                                <MessageSquare
                                  className={`w-3.5 h-3.5 flex-shrink-0 ${
                                    isActive
                                      ? 'text-indigo-600 dark:text-indigo-400'
                                      : 'text-slate-400 dark:text-zinc-500 group-hover:text-slate-600 dark:group-hover:text-zinc-300'
                                  }`}
                                />
                              )}
                              <span className="truncate">{session.title}</span>
                            </div>

                            {/* Dropdown Options Menu */}
                            <div
                              className={`opacity-0 group-hover:opacity-100 transition-opacity ${
                                isActive ? 'opacity-100' : ''
                              }`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <button
                                    className="p-1 rounded-md hover:bg-slate-200/60 dark:hover:bg-zinc-700/60 text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200 transition-colors"
                                    title="Options"
                                  >
                                    <MoreHorizontal className="w-3.5 h-3.5" />
                                  </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                  align="end"
                                  className="w-40 bg-white dark:bg-zinc-900 border-slate-200 dark:border-zinc-800 text-slate-700 dark:text-zinc-200 text-xs shadow-md rounded-xl p-1"
                                >
                                  <DropdownMenuItem
                                    onClick={() => handleStartRename(session)}
                                    className="gap-2 cursor-pointer focus:bg-slate-100 dark:focus:bg-zinc-800 rounded-lg py-1.5"
                                  >
                                    <Edit2 className="w-3.5 h-3.5 text-slate-400" />
                                    <span>Rename</span>
                                  </DropdownMenuItem>

                                  <DropdownMenuItem
                                    onClick={() => onPinSession(session.id, !session.pinned)}
                                    className="gap-2 cursor-pointer focus:bg-slate-100 dark:focus:bg-zinc-800 rounded-lg py-1.5"
                                  >
                                    {session.pinned ? (
                                      <>
                                        <PinOff className="w-3.5 h-3.5 text-slate-400" />
                                        <span>Unpin</span>
                                      </>
                                    ) : (
                                      <>
                                        <Pin className="w-3.5 h-3.5 text-slate-400" />
                                        <span>Pin</span>
                                      </>
                                    )}
                                  </DropdownMenuItem>

                                  <DropdownMenuItem
                                    onClick={() =>
                                      onArchiveSession(session.id, !session.archivedAt)
                                    }
                                    className="gap-2 cursor-pointer focus:bg-slate-100 dark:focus:bg-zinc-800 rounded-lg py-1.5"
                                  >
                                    <Archive className="w-3.5 h-3.5 text-slate-400" />
                                    <span>{session.archivedAt ? 'Unarchive' : 'Archive'}</span>
                                  </DropdownMenuItem>

                                  <DropdownMenuSeparator className="bg-slate-100 dark:bg-zinc-800 my-1" />

                                  <DropdownMenuItem
                                    onClick={() => onDeleteSession(session.id)}
                                    className="gap-2 text-red-600 hover:text-red-700 focus:bg-red-50 dark:focus:bg-red-950/40 rounded-lg cursor-pointer py-1.5"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                    <span>Delete</span>
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
