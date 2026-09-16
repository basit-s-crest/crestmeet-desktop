'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
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
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';

interface MeetingCitation {
  meetingId: string;
  meetingTitle: string;
  date: string;
  snippet?: string;
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

const SUGGESTED_PROMPTS = [
  {
    title: 'Pending Action Items',
    description: 'Find all assigned tasks, owners, and todos across meetings',
    query: 'What are all pending action items and who is responsible for each?',
    icon: '🎯',
  },
  {
    title: 'Recent Key Decisions',
    description: 'Recap all major conclusions and agreements reached',
    query: 'Summarize the key decisions made across all meetings recently',
    icon: '📋',
  },
  {
    title: 'Project Deadlines & Timelines',
    description: 'Review discussed milestones, release dates, and schedules',
    query: 'What deadlines and milestones were discussed in our meetings?',
    icon: '⏱️',
  },
  {
    title: 'Cross-Meeting Overview',
    description: 'Broad panoramic summary of topics and progress',
    query: 'Give me an overview of all discussions and progress from recent meetings',
    icon: '💡',
  },
];

export default function ChatPage() {
  const router = useRouter();
  const { meetings, setCurrentMeeting } = useSidebar();

  const navigateToMeeting = (meetingId: string) => {
    const targetMeeting = meetings.find((m) => m.id === meetingId);
    if (targetMeeting) {
      setCurrentMeeting(targetMeeting);
    }
    router.push(`/meeting-details?id=${meetingId}`);
  };

  const [sessionId, setSessionId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputQuery, setInputQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Initialize session ID from localStorage or generate a new one
  useEffect(() => {
    let currentSession = localStorage.getItem('crestmeet_chat_session_id');
    if (!currentSession) {
      currentSession = `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      localStorage.setItem('crestmeet_chat_session_id', currentSession);
    }
    setSessionId(currentSession);
    loadChatHistory(currentSession);
  }, []);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const loadChatHistory = async (session: string) => {
    setIsHistoryLoading(true);
    try {
      const history = await invoke<ChatMessage[]>('api_chat_get_history', {
        chatSessionId: session,
      });
      if (Array.isArray(history) && history.length > 0) {
        setMessages(history);
      }
    } catch (err) {
      console.warn('Could not load chat history:', err);
    } finally {
      setIsHistoryLoading(false);
    }
  };

  const handleClearHistory = async () => {
    if (!sessionId) return;
    try {
      await invoke('api_chat_clear_history', { chatSessionId: sessionId });
      setMessages([]);
      toast.success('Conversation cleared');
    } catch (err: any) {
      toast.error('Failed to clear conversation: ' + (err?.message || err));
    }
  };

  const handleStartNewChat = () => {
    const newSession = `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    localStorage.setItem('crestmeet_chat_session_id', newSession);
    setSessionId(newSession);
    setMessages([]);
    toast.info('Started a new conversation');
  };

  const handleSendMessage = async (textToSend?: string) => {
    const query = (textToSend || inputQuery).trim();
    if (!query || isLoading || !sessionId) return;

    const userMessage: ChatMessage = {
      id: `usr-${Date.now()}`,
      role: 'user',
      content: query,
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputQuery('');
    setIsLoading(true);

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    try {
      const response = await invoke<ChatApiResponse>('api_chat_send_message', {
        query,
        chatSessionId: sessionId,
      });

      const assistantMessage: ChatMessage = {
        id: `ast-${Date.now()}`,
        role: 'assistant',
        content: response.answer,
        citations: response.citations,
        relevancyScore: response.relevancyScore,
        relevancyLabel: response.relevancyLabel,
        isFallback: response.isFallback,
        recentMeetings: response.recentMeetings,
        createdAt: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err: any) {
      const errorMessage = typeof err === 'string' ? err : err?.message || 'Failed to query meetings';
      toast.error(errorMessage);

      setMessages((prev) => [
        ...prev,
        {
          id: `ast-err-${Date.now()}`,
          role: 'assistant',
          content: `⚠️ **Error processing request**: ${errorMessage}\n\n*Please ensure your Groq API key is configured in Settings -> AI Model.*`,
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
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

  const getRelevancyBadgeStyle = (label?: string, score?: number) => {
    if (!label) return null;
    const isHigh = label.toLowerCase().includes('high') || (score && score >= 0.8);
    const isLow = label.toLowerCase().includes('low') || (score && score < 0.4);

    if (isHigh) {
      return {
        bg: 'bg-emerald-50 border-emerald-200 text-emerald-700',
        dot: 'bg-emerald-500',
      };
    }
    if (isLow) {
      return {
        bg: 'bg-amber-50 border-amber-200 text-amber-700',
        dot: 'bg-amber-500',
      };
    }
    return {
      bg: 'bg-indigo-50 border-indigo-200 text-indigo-700',
      dot: 'bg-indigo-500',
    };
  };

  return (
    <div className="flex flex-col h-screen bg-slate-50/50 overflow-hidden pr-6">
      {/* Top Header Bar */}
      <header className="flex-shrink-0 bg-white border-b border-slate-200/80 px-6 lg:px-10 py-4 flex items-center justify-between shadow-xs">
        <div className="flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600 shadow-xs">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-base font-semibold text-slate-900 tracking-tight">
                AI Meeting Assistant
              </h1>
              <span className="text-[11px] px-2.5 py-0.5 rounded-full font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200/80">
                Groq GPT-OSS 120B
              </span>
            </div>
            <p className="text-xs text-slate-500 flex items-center gap-1.5 mt-0.5">
              <Layers className="w-3.5 h-3.5 text-slate-400" />
              <span>
                Searching across{' '}
                <strong className="text-slate-700 font-medium">
                  {meetings.length} meeting record{meetings.length === 1 ? '' : 's'}
                </strong>
              </span>
            </p>
          </div>
        </div>

        {/* Header Action Buttons */}
        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <>
              <button
                onClick={handleClearHistory}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors border border-slate-200"
                title="Clear current messages"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear</span>
              </button>
              <button
                onClick={handleStartNewChat}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors border border-indigo-200"
                title="Start a fresh conversation"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>New Chat</span>
              </button>
            </>
          )}
        </div>
      </header>

      {/* Main Conversation Canvas */}
      <main className="flex-1 overflow-y-auto px-4 lg:px-10 py-6">
        {/* Loading History State */}
        {isHistoryLoading ? (
          <div className="flex flex-col items-center justify-center h-72 text-slate-400 gap-3">
            <Loader2 className="w-7 h-7 animate-spin text-indigo-600" />
            <p className="text-xs font-medium text-slate-500">Loading meeting conversation...</p>
          </div>
        ) : messages.length === 0 ? (
          /* Empty State: Welcome Hero & Starter Prompt Cards */
          <div className="max-w-4xl mx-auto py-12 text-center space-y-8 animate-in fade-in duration-300">
            <div className="w-16 h-16 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600 mx-auto shadow-sm">
              <MessageSquareText className="w-8 h-8" />
            </div>

            <div className="space-y-2">
              <h2 className="text-2xl font-semibold text-slate-900 tracking-tight">
                Ask anything about your meetings
              </h2>
              <p className="text-sm text-slate-500 max-w-lg mx-auto leading-relaxed">
                Synthesize decisions, extract pending action items, or search for verbatim spoken dialogue across all your recorded calls.
              </p>
            </div>

            {/* Suggested Prompt Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-left pt-2">
              {SUGGESTED_PROMPTS.map((prompt, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSendMessage(prompt.query)}
                  className="group p-5 bg-white hover:bg-indigo-50/40 rounded-2xl border border-slate-200 hover:border-indigo-200 transition-all shadow-xs hover:shadow-sm text-left flex flex-col justify-between"
                >
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-2xl">{prompt.icon}</span>
                      <ArrowUpRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-600 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                    </div>
                    <div className="font-semibold text-sm text-slate-900 group-hover:text-indigo-900 pt-1">
                      {prompt.title}
                    </div>
                    <p className="text-xs text-slate-500 leading-normal">
                      {prompt.description}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* Message History Stream */
          <div className="max-w-4xl xl:max-w-5xl mx-auto space-y-6 pb-4">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-3.5 w-full ${
                  msg.role === 'user' ? 'justify-end' : 'justify-start'
                } animate-in fade-in duration-200`}
              >
                {/* Assistant Avatar */}
                {msg.role === 'assistant' && (
                  <div className="w-8 h-8 rounded-xl bg-indigo-600 flex items-center justify-center text-white shrink-0 shadow-xs mt-1">
                    <Bot className="w-4 h-4" />
                  </div>
                )}

                {/* Message Content Bubble/Card */}
                {msg.role === 'user' ? (
                  /* User Bubble with proper padding and readable width */
                  <div className="max-w-2xl bg-slate-900 text-white rounded-2xl rounded-tr-xs px-5 py-3.5 shadow-xs">
                    <p className="text-[14px] leading-relaxed font-normal whitespace-pre-wrap">
                      {msg.content}
                    </p>
                  </div>
                ) : (
                  /* Assistant Card with full comfortable width and generous padding */
                  <div className="flex-1 bg-white border border-slate-200/90 shadow-xs rounded-2xl p-6 space-y-4 text-slate-800">
                    {/* Markdown Body */}
                    <div className="text-[14.5px] leading-relaxed text-slate-800 prose prose-slate max-w-none prose-p:my-2.5 prose-headings:text-slate-900 prose-headings:font-semibold prose-strong:text-slate-900 prose-strong:font-semibold prose-ul:my-2.5 prose-li:my-1">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {msg.content}
                      </ReactMarkdown>
                    </div>

                    {/* Assistant Footer: Relevancy Badge + Source Citations */}
                    <div className="pt-4 border-t border-slate-100 space-y-3">
                      {/* Relevancy Tag */}
                      {msg.relevancyLabel && (
                        <div className="flex items-center gap-2">
                          {(() => {
                            const style = getRelevancyBadgeStyle(
                              msg.relevancyLabel,
                              msg.relevancyScore
                            );
                            if (!style) return null;
                            return (
                              <div
                                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border ${style.bg}`}
                              >
                                <span className={`w-2 h-2 rounded-full ${style.dot}`} />
                                <span>{msg.relevancyLabel}</span>
                              </div>
                            );
                          })()}
                        </div>
                      )}

                      {/* Interactive Source Citation Badges */}
                      {msg.citations && msg.citations.length > 0 && (
                        <div className="space-y-2 pt-1">
                          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                            Referenced Meetings:
                          </div>
                          <div className="flex flex-wrap gap-2.5">
                            {msg.citations.map((c, i) => (
                              <button
                                key={i}
                                onClick={() => navigateToMeeting(c.meetingId)}
                                className="group inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium bg-slate-50 hover:bg-indigo-50 border border-slate-200 hover:border-indigo-300 text-slate-700 hover:text-indigo-700 transition-all shadow-2xs"
                                title="Click to view meeting note"
                              >
                                <Calendar className="w-3.5 h-3.5 text-slate-400 group-hover:text-indigo-500" />
                                <span className="font-semibold text-slate-800 group-hover:text-indigo-900">
                                  {c.meetingTitle}
                                </span>
                                <span className="text-[11px] text-slate-400 group-hover:text-indigo-400 font-normal">
                                  ({c.date})
                                </span>
                                <ExternalLink className="w-3 h-3 opacity-40 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Fallback Suggestions if zero results matched */}
                      {msg.isFallback && msg.recentMeetings && msg.recentMeetings.length > 0 && (
                        <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200/80 space-y-2.5 mt-2">
                          <div className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                            <HelpCircle className="w-3.5 h-3.5 text-indigo-500" />
                            <span>Try exploring these recent meetings:</span>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {msg.recentMeetings.map((m) => (
                              <button
                                key={m.id}
                                onClick={() => navigateToMeeting(m.id)}
                                className="flex items-center justify-between px-3 py-2 bg-white hover:bg-indigo-50/50 rounded-lg border border-slate-200/70 text-left transition-colors"
                              >
                                <span className="text-xs font-medium text-slate-800 truncate pr-2">
                                  {m.title}
                                </span>
                                <span className="text-[11px] text-slate-400 shrink-0">
                                  {m.date}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* User Avatar */}
                {msg.role === 'user' && (
                  <div className="w-8 h-8 rounded-xl bg-slate-200 flex items-center justify-center text-slate-700 shrink-0 shadow-xs mt-1">
                    <UserIcon className="w-4 h-4" />
                  </div>
                )}
              </div>
            ))}

            {/* Loading Animated State */}
            {isLoading && (
              <div className="flex gap-3.5 justify-start animate-in fade-in duration-200">
                <div className="w-8 h-8 rounded-xl bg-indigo-600 flex items-center justify-center text-white shrink-0 shadow-xs mt-1">
                  <Bot className="w-4 h-4" />
                </div>
                <div className="flex-1 bg-white border border-slate-200/80 rounded-2xl rounded-bl-xs p-5 shadow-xs flex items-center gap-3">
                  <Loader2 className="w-5 h-5 animate-spin text-indigo-600" />
                  <span className="text-sm font-medium text-slate-600">
                    Synthesizing answers across meeting records...
                  </span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        )}
      </main>

      {/* Bottom Input Bar */}
      <footer className="flex-shrink-0 bg-white border-t border-slate-200/80 p-4 lg:px-10 shadow-xs">
        <div className="max-w-4xl xl:max-w-5xl mx-auto space-y-2">
          <div className="relative flex items-end gap-2 bg-slate-50 border border-slate-200 rounded-2xl p-2.5 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-100 transition-all">
            <textarea
              ref={textareaRef}
              value={inputQuery}
              onChange={handleTextareaInput}
              onKeyDown={handleKeyDown}
              disabled={isLoading}
              rows={1}
              placeholder={
                meetings.length === 0
                  ? 'Conduct or import a meeting first...'
                  : 'Ask about any meeting, decision, action item, or topic...'
              }
              className="w-full resize-none bg-transparent px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none max-h-44 custom-scrollbar disabled:opacity-50"
            />

            <button
              onClick={() => handleSendMessage()}
              disabled={!inputQuery.trim() || isLoading}
              className="p-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:scale-95 disabled:opacity-40 disabled:hover:bg-indigo-600 disabled:active:scale-100 text-white transition-all shrink-0 shadow-xs"
              aria-label="Send query"
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
          </div>

          <div className="flex items-center justify-between px-1.5 text-[11px] text-slate-400">
            <span>
              Press <kbd className="font-mono font-semibold text-slate-500">Enter</kbd> to send,{' '}
              <kbd className="font-mono font-semibold text-slate-500">Shift + Enter</kbd> for new line
            </span>
            <span className="hidden sm:inline">
              Powered by Groq High-Speed Inference
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
