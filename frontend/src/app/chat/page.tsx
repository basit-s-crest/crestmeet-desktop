'use client';

import React, { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  MessageSquareText,
  Sparkles,
  Send,
  Trash2,
  Calendar,
  ExternalLink,
  Bot,
  User as UserIcon,
  RotateCcw,
  Layers,
  ArrowUpRight,
  HelpCircle,
  Loader2,
  Copy,
  Check,
  PanelLeftClose,
  PanelLeft,
  Target,
  CheckCircle2,
  Clock,
  Compass,
  ChevronDown,
  Briefcase,
  Share2,
  Download,
  FileText,
  Printer,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { invoke, Channel } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useProject } from '@/contexts/ProjectContext';
import {
  ChatHistorySidebar,
  ChatSessionRecord,
} from '@/components/Chat/ChatHistorySidebar';
import { ShareChatDialog } from '@/components/Chat/ShareChatDialog';

interface MeetingCitation {
  label?: string;
  meetingId: string;
  meetingTitle: string;
  date: string;
  snippet?: string;
  startSeconds?: number;
  endSeconds?: number;
  speaker?: string;
  projectName?: string;
  chunkId?: string;
}

function formatCitationTime(seconds?: number): string | null {
  if (typeof seconds !== 'number') return null;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function renderFormattedText(content: React.ReactNode): React.ReactNode {
  return React.Children.map(content, (child) => {
    if (typeof child === 'string') {
      if (/<br\s*\/?>/i.test(child)) {
        const parts = child.split(/<br\s*\/?>/gi);
        return parts.map((part, i) => (
          <React.Fragment key={i}>
            {i > 0 && <br />}
            {part}
          </React.Fragment>
        ));
      }
      return child;
    }
    if (React.isValidElement(child) && (child.props as any)?.children) {
      return React.cloneElement(child, {
        ...(child.props as any),
        children: renderFormattedText((child.props as any).children),
      });
    }
    return child;
  });
}

interface RecentMeetingInfo {
  id: string;
  title: string;
  date: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: MeetingCitation[];
  relevancyScore?: number;
  relevancyLabel?: string;
  isFallback?: boolean;
  recentMeetings?: RecentMeetingInfo[];
  createdAt?: string;
}

interface ChatApiResponse {
  answer: string;
  citations: MeetingCitation[];
  relevancyScore: number;
  relevancyLabel: string;
  isFallback: boolean;
  recentMeetings?: RecentMeetingInfo[];
}

type ChatStreamEvent =
  | { type: 'start'; session_id: string; message_id: string }
  | { type: 'sources'; citations: MeetingCitation[] }
  | { type: 'token'; token: string }
  | {
      type: 'done';
      answer: string;
      citations: MeetingCitation[];
      relevancy_score: number;
      relevancy_label: string;
      is_fallback: boolean;
    }
  | { type: 'error'; error: string };

const SUGGESTED_PROMPTS = [
  {
    title: 'Pending Action Items',
    description: 'Find all assigned tasks, owners, and deliverables across meetings',
    query: 'What are all pending action items and who is responsible for each?',
    icon: Target,
    iconColor: 'text-rose-500 bg-rose-50 dark:bg-rose-950/40 border-rose-100 dark:border-rose-900/40',
  },
  {
    title: 'Recent Key Decisions',
    description: 'Recap all major conclusions, agreements, and strategic decisions',
    query: 'Summarize the key decisions made across all meetings recently',
    icon: CheckCircle2,
    iconColor: 'text-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-100 dark:border-emerald-900/40',
  },
  {
    title: 'Project Deadlines & Timelines',
    description: 'Review discussed milestones, release dates, and scheduled targets',
    query: 'What deadlines and milestones were discussed in our meetings?',
    icon: Clock,
    iconColor: 'text-amber-500 bg-amber-50 dark:bg-amber-950/40 border-amber-100 dark:border-amber-900/40',
  },
  {
    title: 'Cross-Meeting Overview',
    description: 'Panoramic synthesis of themes, blockers, and weekly progress',
    query: 'Give me an overview of all discussions and progress from recent meetings',
    icon: Compass,
    iconColor: 'text-indigo-500 bg-indigo-50 dark:bg-indigo-950/40 border-indigo-100 dark:border-indigo-900/40',
  },
];

function ChatPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlSessionId = searchParams.get('session_id');

  const { meetings, setCurrentMeeting } = useSidebar();
  const { activeProject, projects, switchProject } = useProject();

  const [sessions, setSessions] = useState<ChatSessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isSessionsLoading, setIsSessionsLoading] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputQuery, setInputQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [isShareOpen, setIsShareOpen] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const loadedSessionRef = useRef<string | null>(null);

  const loadChatHistory = async (sessionId: string) => {
    setIsHistoryLoading(true);
    try {
      const history = await invoke<ChatMessage[]>('api_chat_get_history', {
        chatSessionId: sessionId,
      });
      setMessages(Array.isArray(history) ? history : []);
    } catch (err) {
      console.warn('Could not load chat history:', err);
      setMessages([]);
    } finally {
      setIsHistoryLoading(false);
    }
  };

  const handleNewChat = async () => {
    try {
      const scopeIds = activeProject ? [activeProject.id] : undefined;
      const newSession = await invoke<ChatSessionRecord>('api_chat_create_session', {
        scopeProjectIds: scopeIds,
        title: 'New Conversation',
      });

      setSessions((prev) => [newSession, ...prev]);
      loadedSessionRef.current = newSession.id;
      setActiveSessionId(newSession.id);
      setMessages([]);
      router.replace('/chat');
    } catch (err: any) {
      const fallbackId = `session-${Date.now()}`;
      loadedSessionRef.current = fallbackId;
      setActiveSessionId(fallbackId);
      setMessages([]);
      router.replace('/chat');
    }
  };

  const loadSessions = async (targetSessionId?: string | null) => {
    setIsSessionsLoading(true);
    try {
      const list = await invoke<ChatSessionRecord[]>('api_chat_list_sessions', {
        includeArchived: false,
      });
      setSessions(list);

      if (targetSessionId) {
        // Return to specific session requested in URL (e.g. Back from Meeting Details)
        loadedSessionRef.current = targetSessionId;
        setActiveSessionId(targetSessionId);
        loadChatHistory(targetSessionId);
      } else {
        // New chat requested: start with clean slate
        // If the top session is already empty and unused, reuse it
        if (list.length > 0 && list[0].messageCount === 0) {
          loadedSessionRef.current = list[0].id;
          setActiveSessionId(list[0].id);
          setMessages([]);
        } else {
          await handleNewChat();
        }
      }
    } catch (err) {
      console.warn('Could not load sessions:', err);
    } finally {
      setIsSessionsLoading(false);
    }
  };

  // Load chat sessions on mount
  useEffect(() => {
    loadSessions(urlSessionId);
  }, []);

  // When urlSessionId changes (e.g. navigating back from citation)
  useEffect(() => {
    if (urlSessionId && urlSessionId !== loadedSessionRef.current) {
      loadedSessionRef.current = urlSessionId;
      setActiveSessionId(urlSessionId);
      loadChatHistory(urlSessionId);
    }
  }, [urlSessionId]);

  // Listen for sidebar new chat button event
  useEffect(() => {
    const handleNewChatEvent = () => {
      handleNewChat();
    };
    window.addEventListener('crestmeet_new_chat', handleNewChatEvent);
    return () => {
      window.removeEventListener('crestmeet_new_chat', handleNewChatEvent);
    };
  }, [activeProject]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const handleSelectSession = (sessionId: string) => {
    if (activeSessionId === sessionId) return;
    loadedSessionRef.current = sessionId;
    setActiveSessionId(sessionId);
    loadChatHistory(sessionId);
    router.replace(`/chat?session_id=${encodeURIComponent(sessionId)}`);
  };

  const handleRenameSession = async (sessionId: string, newTitle: string) => {
    try {
      await invoke('api_chat_rename_session', { sessionId, title: newTitle });
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, title: newTitle } : s))
      );
      toast.success('Conversation renamed');
    } catch (err: any) {
      toast.error('Failed to rename: ' + (err?.message || err));
    }
  };

  const handlePinSession = async (sessionId: string, pinned: boolean) => {
    try {
      await invoke('api_chat_pin_session', { sessionId, pinned });
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, pinned } : s))
      );
      toast.success(pinned ? 'Conversation pinned' : 'Conversation unpinned');
    } catch (err: any) {
      toast.error('Failed to pin: ' + (err?.message || err));
    }
  };

  const handleArchiveSession = async (sessionId: string, archive: boolean) => {
    try {
      await invoke('api_chat_archive_session', { sessionId, archive });
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (activeSessionId === sessionId) {
        const remaining = sessions.filter((s) => s.id !== sessionId);
        if (remaining.length > 0) {
          handleSelectSession(remaining[0].id);
        } else {
          handleNewChat();
        }
      }
      toast.success(archive ? 'Conversation archived' : 'Conversation unarchived');
    } catch (err: any) {
      toast.error('Failed to archive: ' + (err?.message || err));
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    try {
      await invoke('api_chat_delete_session', { sessionId });
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (activeSessionId === sessionId) {
        const remaining = sessions.filter((s) => s.id !== sessionId);
        if (remaining.length > 0) {
          handleSelectSession(remaining[0].id);
        } else {
          handleNewChat();
        }
      }
      toast.success('Conversation deleted');
    } catch (err: any) {
      toast.error('Failed to delete: ' + (err?.message || err));
    }
  };

  const handleClearHistory = async () => {
    if (!activeSessionId) return;
    try {
      await invoke('api_chat_clear_history', { chatSessionId: activeSessionId });
      setMessages([]);
      toast.success('Conversation cleared');
    } catch (err: any) {
      toast.error('Failed to clear conversation: ' + (err?.message || err));
    }
  };

  const handleSendMessage = async (textToSend?: string) => {
    const query = (textToSend || inputQuery).trim();
    if (!query || isLoading || !activeSessionId) return;

    const userMessage: ChatMessage = {
      id: `usr-${Date.now()}`,
      role: 'user',
      content: query,
      createdAt: new Date().toISOString(),
    };

    const astMsgId = `ast-${Date.now()}`;
    const initialAssistantMessage: ChatMessage = {
      id: astMsgId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage, initialAssistantMessage]);
    setInputQuery('');
    setIsLoading(true);

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    try {
      const channel = new Channel<ChatStreamEvent>();
      let accumulatedContent = '';

      channel.onmessage = (event) => {
        if (event.type === 'sources') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === astMsgId ? { ...m, citations: event.citations } : m
            )
          );
        } else if (event.type === 'token') {
          accumulatedContent += event.token;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === astMsgId ? { ...m, content: accumulatedContent } : m
            )
          );
        } else if (event.type === 'done') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === astMsgId
                ? {
                    ...m,
                    content: event.answer || accumulatedContent,
                    citations: event.citations,
                    relevancyScore: event.relevancy_score,
                    relevancyLabel: event.relevancy_label,
                    isFallback: event.is_fallback,
                  }
                : m
            )
          );
          setIsLoading(false);
        } else if (event.type === 'error') {
          toast.error(event.error);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === astMsgId
                ? {
                    ...m,
                    content: `⚠️ **Error**: ${event.error}\n\n*Please ensure your Groq API key is configured in Settings -> AI Model.*`,
                  }
                : m
            )
          );
          setIsLoading(false);
        }
      };

      await invoke('api_chat_send_message_stream', {
        query,
        chatSessionId: activeSessionId,
        onEvent: channel,
      });

      // Auto-rename from first question if session is still 'New Conversation'
      const activeSession = sessions.find((s) => s.id === activeSessionId);
      if (activeSession && activeSession.title === 'New Conversation') {
        const autoTitle = query.slice(0, 32) + (query.length > 32 ? '...' : '');
        handleRenameSession(activeSessionId, autoTitle);
      }
    } catch (streamErr: any) {
      console.warn('Streaming invocation fallback to non-streaming:', streamErr);
      try {
        const response = await invoke<ChatApiResponse>('api_chat_send_message', {
          query,
          chatSessionId: activeSessionId,
        });

        setMessages((prev) =>
          prev.map((m) =>
            m.id === astMsgId
              ? {
                  ...m,
                  content: response.answer,
                  citations: response.citations,
                  relevancyScore: response.relevancyScore,
                  relevancyLabel: response.relevancyLabel,
                  isFallback: response.isFallback,
                  recentMeetings: response.recentMeetings,
                }
              : m
          )
        );
      } catch (err: any) {
        const errorMessage = typeof err === 'string' ? err : err?.message || 'Failed to query meetings';
        toast.error(errorMessage);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === astMsgId
              ? {
                  ...m,
                  content: `⚠️ **Error**: ${errorMessage}\n\n*Please ensure your Groq API key is configured in Settings -> AI Model.*`,
                }
              : m
          )
        );
      } finally {
        setIsLoading(false);
      }
    }
  };

  const handleCopyMessage = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedMsgId(id);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopiedMsgId(null), 2000);
  };

  const navigateToMeeting = (
    meetingId: string,
    startSeconds?: number,
    endSeconds?: number,
    snippet?: string,
    queryText?: string
  ) => {
    const targetMeeting = meetings.find((m) => m.id === meetingId);
    if (targetMeeting) {
      setCurrentMeeting(targetMeeting);
    }
    const timeParam = typeof startSeconds === 'number' ? `&t=${Math.floor(startSeconds)}` : '';
    const endParam = typeof endSeconds === 'number' ? `&end=${Math.floor(endSeconds)}` : '';
    const sessionParam = activeSessionId
      ? `&from=chat&session_id=${encodeURIComponent(activeSessionId)}`
      : '&from=chat';

    // Prioritize user query keywords or snippet excerpt
    const rawSearch = (queryText || snippet || '').trim();
    const queryParam = rawSearch ? `&q=${encodeURIComponent(rawSearch.slice(0, 150))}` : '';

    router.push(`/meeting-details?id=${meetingId}${timeParam}${endParam}${queryParam}${sessionParam}`);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputQuery(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
  };

  const handleExportMarkdown = () => {
    if (messages.length === 0) {
      toast.error('No messages to export');
      return;
    }

    const title = currentSessionRecord?.title || 'Meeting AI Conversation';
    const dateStr = new Date().toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const scopeName = activeProject?.name || 'All Meetings';

    let md = `# ${title}\n\n`;
    md += `**Date:** ${dateStr}  \n`;
    md += `**Scope:** ${scopeName}  \n`;
    md += `**Generated by:** CrestMeet AI Assistant\n\n`;
    md += `---\n\n`;

    messages.forEach((msg) => {
      const roleHeader = msg.role === 'user' ? '🧑 **User**' : '🤖 **CrestMeet AI**';
      md += `### ${roleHeader}\n\n`;
      md += `${msg.content.trim()}\n\n`;

      if (msg.citations && msg.citations.length > 0) {
        md += `**Sources & Citations:**\n`;
        msg.citations.forEach((c, cIdx) => {
          const timeStr = formatCitationTime(c.startSeconds);
          const speakerStr = c.speaker ? ` (${c.speaker})` : '';
          const timeBadge = timeStr ? ` [${timeStr}]` : '';
          md += `- **[S${cIdx + 1}]** *${c.meetingTitle}* — ${c.date}${speakerStr}${timeBadge}\n`;
          if (c.snippet) {
            md += `  > "${c.snippet.trim()}"\n`;
          }
        });
        md += `\n`;
      }

      md += `---\n\n`;
    });

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeFilename = title.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    a.download = `${safeFilename}_${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast.success('Conversation exported to Markdown');
  };

  const handleExportPdf = () => {
    if (messages.length === 0) {
      toast.error('No messages to export');
      return;
    }
    window.print();
  };

  const currentSessionRecord = sessions.find((s) => s.id === activeSessionId);

  return (
    <div className="-ml-8 flex h-screen w-[calc(100%+2rem)] bg-slate-50/60 dark:bg-zinc-950 overflow-hidden print:m-0 print:w-full print:h-auto print:bg-white print:overflow-visible">
      {/* History Sidebar docked flush against app navigation */}
      {isSidebarOpen && (
        <div className="print:hidden h-full flex shrink-0">
          <ChatHistorySidebar
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelectSession={handleSelectSession}
            onNewChat={handleNewChat}
            onRenameSession={handleRenameSession}
            onPinSession={handlePinSession}
            onArchiveSession={handleArchiveSession}
            onDeleteSession={handleDeleteSession}
            isLoading={isSessionsLoading}
          />
        </div>
      )}

      {/* Main Conversation Workspace */}
      <div className="flex-1 flex flex-col h-full overflow-hidden bg-slate-50/50 dark:bg-zinc-950 print:bg-white print:overflow-visible print:h-auto">
        {/* Top Header Bar */}
        <header className="h-16 flex-shrink-0 bg-white dark:bg-zinc-900 border-b border-slate-200/90 dark:border-zinc-800 px-5 flex items-center justify-between shadow-2xs print:border-b-2 print:border-slate-800 print:py-3 print:h-auto">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className="p-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200 transition-colors border border-slate-200/70 dark:border-zinc-700/70"
              title={isSidebarOpen ? 'Hide History Panel' : 'Show History Panel'}
            >
              {isSidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeft className="w-4 h-4" />}
            </button>

            <div className="w-8 h-8 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-100 dark:border-indigo-900/60 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shadow-2xs">
              <Sparkles className="w-4 h-4" />
            </div>

            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-semibold text-slate-900 dark:text-zinc-100 tracking-tight">
                  {currentSessionRecord?.title || 'AI Meeting Assistant'}
                </h1>

                {/* Interactive Project Scope Selector */}
                {projects.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        className="flex items-center gap-1 text-[11px] font-medium px-2.5 py-0.5 rounded-full bg-indigo-50/90 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200/80 dark:border-indigo-800/60 hover:bg-indigo-100/80 transition-colors cursor-pointer"
                        title="Click to switch active project scope"
                      >
                        <Briefcase className="w-3 h-3 text-indigo-500" />
                        <span>Scope: {activeProject?.name || 'All Meetings'}</span>
                        <ChevronDown className="w-3 h-3 text-indigo-400 ml-0.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      className="w-48 bg-white dark:bg-zinc-900 border-slate-200 dark:border-zinc-800 text-xs shadow-md rounded-xl p-1"
                    >
                      <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        Select Project Scope
                      </div>
                      {projects
                        .filter((p) => !p.is_archived)
                        .map((proj) => (
                          <DropdownMenuItem
                            key={proj.id}
                            onClick={() => switchProject(proj.id)}
                            className={`gap-2 cursor-pointer rounded-lg py-1.5 ${
                              activeProject?.id === proj.id
                                ? 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 font-medium'
                                : 'text-slate-700 dark:text-zinc-300'
                            }`}
                          >
                            <span className="truncate">{proj.name}</span>
                            {activeProject?.id === proj.id && (
                              <Check className="w-3.5 h-3.5 ml-auto text-indigo-600" />
                            )}
                          </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>

              <p className="text-[11px] text-slate-500 dark:text-zinc-400 flex items-center gap-1.5 mt-0.5">
                <Layers className="w-3.5 h-3.5 text-slate-400 dark:text-zinc-500" />
                <span>
                  Searching across{' '}
                  <strong className="text-slate-700 dark:text-zinc-300 font-medium">
                    {meetings.length} meeting{meetings.length === 1 ? '' : 's'}
                  </strong>
                </span>
              </p>
            </div>
          </div>

          {/* Top Right Controls */}
          <div className="flex items-center gap-2 print:hidden">
            {messages.length > 0 && (
              <>
                <button
                  onClick={() => setIsShareOpen(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-xl transition-colors border border-slate-200 dark:border-zinc-800 cursor-pointer"
                  title="Share snapshot link of conversation"
                >
                  <Share2 className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                  <span>Share</span>
                </button>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-xl transition-colors border border-slate-200 dark:border-zinc-800 cursor-pointer"
                      title="Export conversation"
                    >
                      <Download className="w-3.5 h-3.5 text-slate-500 dark:text-zinc-400" />
                      <span>Export</span>
                      <ChevronDown className="w-3 h-3 text-slate-400" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="w-48 bg-white dark:bg-zinc-900 border-slate-200 dark:border-zinc-800 text-xs rounded-xl shadow-md p-1"
                  >
                    <DropdownMenuItem
                      onClick={handleExportMarkdown}
                      className="gap-2 cursor-pointer py-1.5 text-slate-700 dark:text-zinc-300"
                    >
                      <FileText className="w-3.5 h-3.5 text-indigo-500" />
                      <span>Export Markdown (.md)</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={handleExportPdf}
                      className="gap-2 cursor-pointer py-1.5 text-slate-700 dark:text-zinc-300"
                    >
                      <Printer className="w-3.5 h-3.5 text-emerald-500" />
                      <span>Export PDF (Print)</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <button
                  onClick={handleClearHistory}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-xl transition-colors border border-slate-200 dark:border-zinc-800 cursor-pointer"
                  title="Clear messages in this conversation"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear</span>
                </button>
              </>
            )}
          </div>
        </header>

        {/* Conversation Message Canvas */}
        <main className="flex-1 overflow-y-auto px-4 lg:px-8 py-6 print:overflow-visible print:h-auto print:p-0">
          {isHistoryLoading ? (
            <div className="flex flex-col items-center justify-center h-72 text-slate-400 dark:text-zinc-500 gap-3">
              <Loader2 className="w-6 h-6 animate-spin text-indigo-600" />
              <p className="text-xs font-medium text-slate-500 dark:text-zinc-400">Loading conversation...</p>
            </div>
          ) : messages.length === 0 ? (
            /* Empty State Hero */
            <div className="max-w-3xl mx-auto py-12 text-center space-y-7 animate-in fade-in duration-300">
              <div className="w-14 h-14 rounded-2xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-100 dark:border-indigo-900/60 flex items-center justify-center text-indigo-600 dark:text-indigo-400 mx-auto shadow-xs">
                <MessageSquareText className="w-7 h-7" />
              </div>

              <div className="space-y-1.5">
                <h2 className="text-xl font-bold text-slate-900 dark:text-zinc-100 tracking-tight">
                  Ask anything about your meetings
                </h2>
                <p className="text-xs text-slate-500 dark:text-zinc-400 max-w-md mx-auto leading-relaxed">
                  Synthesize decisions, extract pending action items, or search for verbatim spoken dialogue across all your recorded calls.
                </p>
              </div>

              {/* 4 Clean Starter Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 text-left pt-1">
                {SUGGESTED_PROMPTS.map((prompt, idx) => {
                  const Icon = prompt.icon;
                  return (
                    <button
                      key={idx}
                      onClick={() => handleSendMessage(prompt.query)}
                      className="group p-4 bg-white dark:bg-zinc-900 hover:bg-indigo-50/30 dark:hover:bg-indigo-950/20 rounded-2xl border border-slate-200/90 dark:border-zinc-800 hover:border-indigo-200 dark:hover:border-indigo-800 transition-all shadow-2xs hover:shadow-xs text-left flex flex-col justify-between"
                    >
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className={`w-8 h-8 rounded-xl border flex items-center justify-center ${prompt.iconColor}`}>
                            <Icon className="w-4 h-4" />
                          </div>
                          <ArrowUpRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-600 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                        </div>
                        <div>
                          <div className="font-semibold text-xs text-slate-900 dark:text-zinc-100 group-hover:text-indigo-950 dark:group-hover:text-indigo-300">
                            {prompt.title}
                          </div>
                          <p className="text-[11px] text-slate-500 dark:text-zinc-400 leading-normal mt-0.5">
                            {prompt.description}
                          </p>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-5 pb-6">
              {messages.map((message, mIdx) => {
                const isUser = message.role === 'user';

                return (
                  <div
                    key={message.id}
                    className={`flex items-start gap-3.5 ${isUser ? 'justify-end' : 'justify-start'} animate-in fade-in duration-200`}
                  >
                    {!isUser && (
                      <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-600 via-indigo-600 to-violet-600 text-white flex items-center justify-center shrink-0 shadow-xs ring-1 ring-indigo-500/30 mt-0.5">
                        <Bot className="w-4.5 h-4.5 text-white" />
                      </div>
                    )}

                    <div
                      className={`relative group max-w-2xl text-[13px] leading-relaxed ${
                        isUser
                          ? 'px-4 py-3 bg-indigo-600 text-white rounded-2xl rounded-tr-sm shadow-xs'
                          : 'p-5 bg-white dark:bg-zinc-900 text-slate-800 dark:text-zinc-200 border border-slate-200/90 dark:border-zinc-800 rounded-2xl rounded-tl-sm shadow-2xs'
                      }`}
                    >
                      {isUser ? (
                        <p className="whitespace-pre-wrap">{message.content}</p>
                      ) : (
                        <div className="space-y-3.5">
                          {/* Assistant Meta Header */}
                          <div className="flex items-center justify-between pb-2.5 border-b border-slate-100 dark:border-zinc-800/80">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-xs text-slate-900 dark:text-zinc-100">CrestMeet AI</span>
                              <span className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200/60 dark:border-indigo-800/60">
                                Meeting Synthesis
                              </span>
                            </div>
                            <span className="text-[10px] text-slate-400 dark:text-zinc-500 font-mono">
                              {new Date(message.createdAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>

                          {!message.content ? (
                            <div className="flex items-center gap-2 text-slate-400 py-2">
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500" />
                              <span className="text-xs font-medium text-slate-500 dark:text-zinc-400 animate-pulse">
                                Searching knowledge base & streaming response...
                              </span>
                            </div>
                          ) : (
                            <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-p:leading-relaxed prose-headings:font-bold prose-headings:text-slate-900 dark:prose-headings:text-zinc-100 prose-h2:text-sm prose-h2:mt-4 prose-h2:mb-1.5 prose-h3:text-xs prose-h3:mt-3 prose-h3:mb-1 prose-strong:font-semibold prose-strong:text-slate-900 dark:prose-strong:text-zinc-100 prose-ul:my-2 prose-li:my-0.5 prose-pre:bg-slate-900 prose-pre:text-slate-100">
                              <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                components={{
                                  table: ({ ...props }) => (
                                    <div className="my-4 w-full overflow-x-auto rounded-xl border border-slate-200 dark:border-zinc-800 shadow-2xs bg-white dark:bg-zinc-900">
                                      <table className="w-full min-w-[640px] border-collapse text-left text-xs m-0" {...props} />
                                    </div>
                                  ),
                                  thead: ({ ...props }) => (
                                    <thead className="bg-slate-50/90 dark:bg-zinc-800/80 border-b border-slate-200 dark:border-zinc-800" {...props} />
                                  ),
                                  th: ({ children, ...props }) => (
                                    <th className="px-3.5 py-2.5 text-xs font-semibold text-slate-900 dark:text-zinc-100 border-r border-slate-200/80 dark:border-zinc-800 last:border-r-0 whitespace-nowrap bg-slate-100/60 dark:bg-zinc-800/50" {...props}>
                                      {renderFormattedText(children)}
                                    </th>
                                  ),
                                  tbody: ({ ...props }) => (
                                    <tbody className="divide-y divide-slate-200/80 dark:divide-zinc-800/80 bg-white dark:bg-zinc-900" {...props} />
                                  ),
                                  tr: ({ ...props }) => (
                                    <tr className="hover:bg-indigo-50/20 dark:hover:bg-indigo-950/20 transition-colors odd:bg-white dark:odd:bg-zinc-900 even:bg-slate-50/40 dark:even:bg-zinc-800/20" {...props} />
                                  ),
                                  td: ({ children, ...props }) => (
                                    <td className="px-3.5 py-2.5 text-xs text-slate-700 dark:text-zinc-300 border-r border-slate-200/80 dark:border-zinc-800 last:border-r-0 align-top leading-relaxed" {...props}>
                                      {renderFormattedText(children)}
                                    </td>
                                  ),
                                  p: ({ children, ...props }) => (
                                    <p className="my-2 leading-relaxed" {...props}>
                                      {renderFormattedText(children)}
                                    </p>
                                  ),
                                  li: ({ children, ...props }) => (
                                    <li className="my-0.5" {...props}>
                                      {renderFormattedText(children)}
                                    </li>
                                  ),
                                }}
                              >
                                {message.content}
                              </ReactMarkdown>
                            </div>
                          )}

                          {/* Citations Row */}
                          {message.citations && message.citations.length > 0 && (
                            <div className="mt-4 pt-3.5 border-t border-slate-100 dark:border-zinc-800/80 space-y-2.5">
                              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-zinc-400">
                                <ExternalLink className="w-3.5 h-3.5 text-indigo-500" />
                                <span>Sources & Citations ({message.citations.length})</span>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {message.citations.map((cite, cIdx) => {
                                  const timeFormatted = formatCitationTime(cite.startSeconds);
                                  return (
                                    <button
                                      key={cIdx}
                                      onClick={() => {
                                        const priorUserMsg = messages
                                          .slice(0, mIdx)
                                          .reverse()
                                          .find((m) => m.role === 'user');
                                        const queryContext = priorUserMsg?.content || inputQuery || '';
                                        navigateToMeeting(
                                          cite.meetingId,
                                          cite.startSeconds,
                                          cite.endSeconds,
                                          cite.snippet,
                                          queryContext
                                        );
                                      }}
                                      title={cite.snippet ? `"${cite.snippet}"` : `Jump to ${cite.meetingTitle}`}
                                      className="group/cite flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium bg-slate-50 dark:bg-zinc-800/90 text-slate-700 dark:text-zinc-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/50 hover:text-indigo-600 dark:hover:text-indigo-400 border border-slate-200/90 dark:border-zinc-700 hover:border-indigo-200 dark:hover:border-indigo-800 transition-all cursor-pointer shadow-2xs"
                                    >
                                      {cite.label && (
                                        <span className="px-1.5 py-0.5 rounded-md bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 font-mono text-[10px] font-bold">
                                          [{cite.label}]
                                        </span>
                                      )}
                                      <Calendar className="w-3.5 h-3.5 text-slate-400 group-hover/cite:text-indigo-500 transition-colors" />
                                      <span className="font-semibold text-slate-800 dark:text-zinc-200 group-hover/cite:text-indigo-600 dark:group-hover/cite:text-indigo-400 max-w-[200px] truncate">
                                        {cite.meetingTitle}
                                      </span>
                                      {timeFormatted && (
                                        <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-slate-200/80 dark:bg-zinc-700 text-slate-600 dark:text-zinc-300 font-mono text-[10px]">
                                          <Clock className="w-2.5 h-2.5 text-slate-400" />
                                          {timeFormatted}
                                        </span>
                                      )}
                                      {cite.speaker && (
                                        <span className="text-[11px] text-slate-400">({cite.speaker})</span>
                                      )}
                                      <ArrowUpRight className="w-3.5 h-3.5 text-slate-400 opacity-60 group-hover/cite:opacity-100 group-hover/cite:translate-x-0.5 group-hover/cite:-translate-y-0.5 transition-all ml-0.5" />
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {/* Action Toolbar */}
                          <div className="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-zinc-800/80 text-[11px] text-slate-400 dark:text-zinc-500">
                            <span className="font-mono text-[10px]">CrestMeet RAG</span>
                            <button
                              onClick={() => handleCopyMessage(message.id, message.content)}
                              className="flex items-center gap-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200 transition-colors cursor-pointer py-0.5 px-2 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800"
                              title="Copy response"
                            >
                              {copiedMsgId === message.id ? (
                                <Check className="w-3.5 h-3.5 text-emerald-500" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                              <span>{copiedMsgId === message.id ? 'Copied' : 'Copy'}</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    {isUser && (
                      <div className="w-8 h-8 rounded-xl bg-slate-200 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 flex items-center justify-center shrink-0 border border-slate-300/60 dark:border-zinc-700 shadow-2xs mt-0.5">
                        <UserIcon className="w-4 h-4" />
                      </div>
                    )}
                  </div>
                );
              })}

              <div ref={messagesEndRef} />
            </div>
          )}
        </main>

        {/* Input Composer Footer */}
        <footer className="flex-shrink-0 bg-white dark:bg-zinc-900 border-t border-slate-200/90 dark:border-zinc-800 px-4 lg:px-8 py-3.5 print:hidden">
          <div className="max-w-3xl mx-auto">
            <div className="relative flex items-center bg-slate-50/80 dark:bg-zinc-950/70 border border-slate-200/90 dark:border-zinc-800 rounded-2xl focus-within:ring-2 focus-within:ring-indigo-500/20 focus-within:border-indigo-500 transition-all p-1.5 shadow-2xs">
              <textarea
                ref={textareaRef}
                value={inputQuery}
                onChange={handleTextareaInput}
                onKeyDown={handleKeyDown}
                placeholder="Ask about decisions, action items, or meetings... (Enter to send, Shift+Enter for newline)"
                rows={1}
                disabled={isLoading}
                className="w-full bg-transparent resize-none border-0 focus:ring-0 focus:outline-none text-xs text-slate-900 dark:text-zinc-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500 px-3 py-1.5 max-h-36 leading-relaxed"
              />
              <button
                onClick={() => handleSendMessage()}
                disabled={!inputQuery.trim() || isLoading}
                className="flex-shrink-0 w-8 h-8 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:scale-95 disabled:bg-slate-200 dark:disabled:bg-zinc-800 text-white disabled:text-slate-400 dark:disabled:text-zinc-600 flex items-center justify-center transition-all ml-1.5 shadow-xs"
                title="Send message"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex items-center justify-between text-[10px] text-slate-400 dark:text-zinc-500 px-2 pt-1.5">
              <span>Answers synthesized using in-scope meeting transcripts & verified citations</span>
              <span>Markdown supported</span>
            </div>
          </div>
        </footer>
      </div>

      {/* Share Snapshot Dialog */}
      <ShareChatDialog
        open={isShareOpen}
        onOpenChange={setIsShareOpen}
        sessionId={activeSessionId}
        sessionTitle={currentSessionRecord?.title}
      />
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center bg-slate-50 dark:bg-zinc-950">
          <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
        </div>
      }
    >
      <ChatPageContent />
    </Suspense>
  );
}
