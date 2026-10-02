'use client';

import React, { useState, useEffect } from 'react';
import {
  Settings,
  ChevronLeftCircle,
  ChevronRightCircle,
  Home,
  Mic,
  Square,
  NotebookPen,
  MessageSquareText,
  Upload,
  LogOut,
  User as UserIcon,
} from 'lucide-react';
import { useRouter, usePathname } from 'next/navigation';
import { useSidebar } from './SidebarProvider';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useImportDialog } from '@/contexts/ImportDialogContext';
import { useConfig } from '@/contexts/ConfigContext';
import { useAuth } from '@/contexts/AuthContext';

import Logo from '../Logo';
import Info from '../Info';

const Sidebar: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const {
    isCollapsed,
    toggleCollapse,
    handleRecordingToggle,
    meetings,
  } = useSidebar();

  // Get recording state from RecordingStateContext (single source of truth)
  const { isRecording } = useRecordingState();
  const { openImportDialog } = useImportDialog();
  const { betaFeatures } = useConfig();
  const { user, signOut } = useAuth();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);

    // Global function to open settings from tray
    (window as any).openSettings = () => {
      router.push('/settings');
    };

    return () => {
      delete (window as any).openSettings;
    };
  }, [router]);

  const isHomePage = pathname === '/';
  const isMeetingPage = pathname === '/meetings' || pathname?.includes('/meeting-details');
  const isChatPage = pathname === '/chat';
  const isSettingsPage = pathname === '/settings';

  const renderCollapsedIcons = () => {
    if (!isCollapsed) return null;

    return (
      <TooltipProvider>
        <div className="flex flex-col items-center space-y-3.5 mt-3">
          <Logo isCollapsed={isCollapsed} />

          {/* Home */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => router.push('/')}
                className={`p-2.5 rounded-xl transition-all duration-150 ${
                  isHomePage
                    ? 'bg-indigo-50 text-indigo-600 shadow-xs'
                    : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
                }`}
                aria-label="Home"
              >
                <Home className="w-5 h-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Home</p>
            </TooltipContent>
          </Tooltip>

          {/* Recording Toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleRecordingToggle}
                className={`p-2.5 rounded-xl transition-all duration-150 shadow-sm ${
                  isRecording
                    ? 'bg-red-500 text-white hover:bg-red-600'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                }`}
                aria-label="Record"
              >
                {isRecording ? (
                  <Square className="w-5 h-5" />
                ) : (
                  <Mic className="w-5 h-5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>{isRecording ? 'Recording in progress (Go to Home)' : 'Record'}</p>
            </TooltipContent>
          </Tooltip>

          {/* Import Audio (Beta) */}
          {betaFeatures.importAndRetranscribe && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => openImportDialog()}
                  className="p-2.5 rounded-xl transition-colors duration-150 text-blue-600 hover:bg-blue-100 bg-blue-50"
                  aria-label="Import Audio"
                >
                  <Upload className="w-5 h-5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>Import Audio</p>
              </TooltipContent>
            </Tooltip>
          )}

          {/* Meeting Notes */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => router.push('/meetings')}
                className={`p-2.5 rounded-xl transition-all duration-150 relative ${
                  isMeetingPage
                    ? 'bg-indigo-50 text-indigo-600 shadow-xs'
                    : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
                }`}
                aria-label="Meeting Notes"
              >
                <NotebookPen className="w-5 h-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Meeting Notes {meetings.length > 0 ? `(${meetings.length})` : ''}</p>
            </TooltipContent>
          </Tooltip>

          {/* AI Assistant */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => router.push('/chat')}
                className={`p-2.5 rounded-xl transition-all duration-150 relative ${
                  isChatPage
                    ? 'bg-indigo-50 text-indigo-600 shadow-xs'
                    : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
                }`}
                aria-label="AI Assistant"
              >
                <MessageSquareText className="w-5 h-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>AI Assistant</p>
            </TooltipContent>
          </Tooltip>

          {/* Settings */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => router.push('/settings')}
                className={`p-2.5 rounded-xl transition-all duration-150 ${
                  isSettingsPage
                    ? 'bg-indigo-50 text-indigo-600 shadow-xs'
                    : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
                }`}
                aria-label="Settings"
              >
                <Settings className="w-5 h-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Settings</p>
            </TooltipContent>
          </Tooltip>

          <div className="pt-2">
            <Info isCollapsed={isCollapsed} />
          </div>
        </div>
      </TooltipProvider>
    );
  };

  return (
    <div className="fixed top-0 left-0 h-screen z-40">
      {/* Floating collapse / expand button */}
      <button
        onClick={toggleCollapse}
        className="absolute -right-3.5 top-7 z-50 p-1 bg-white hover:bg-slate-50 text-slate-500 hover:text-slate-800 rounded-full shadow-md border border-slate-200 transition-transform active:scale-95"
        aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {isCollapsed ? (
          <ChevronRightCircle className="w-5 h-5" />
        ) : (
          <ChevronLeftCircle className="w-5 h-5" />
        )}
      </button>

      <div
        className={`h-screen bg-white border-r border-slate-200/90 shadow-xs flex flex-col transition-all duration-300 ${
          isCollapsed ? 'w-16' : 'w-60'
        }`}
      >
        {/* Collapsed Mode Icons */}
        {renderCollapsedIcons()}

        {/* Expanded Mode */}
        {!isCollapsed && (
          <>
            {/* Header with Logo */}
            <div className="flex-shrink-0 px-4 pt-5 pb-4 border-b border-slate-100">
              <Logo isCollapsed={isCollapsed} />
            </div>

            {/* Navigation items */}
            <div className="flex-1 px-3 py-4 space-y-1 overflow-y-auto custom-scrollbar">
              {/* Home */}
              <button
                type="button"
                onClick={() => router.push('/')}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                  isHomePage
                    ? 'bg-indigo-50 text-indigo-700 font-semibold shadow-xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/80'
                }`}
              >
                <Home className={`w-4 h-4 shrink-0 ${isHomePage ? 'text-indigo-600' : 'text-slate-500'}`} />
                <span>Home</span>
              </button>

              {/* Meeting Notes */}
              <button
                type="button"
                onClick={() => router.push('/meetings')}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                  isMeetingPage
                    ? 'bg-indigo-50 text-indigo-700 font-semibold shadow-xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/80'
                }`}
              >
                <div className="flex items-center gap-3">
                  <NotebookPen className={`w-4 h-4 shrink-0 ${isMeetingPage ? 'text-indigo-600' : 'text-slate-500'}`} />
                  <span>Meeting Notes</span>
                </div>
                {meetings.length > 0 && (
                  <span
                    className={`text-[11px] px-2 py-0.5 rounded-full font-semibold border ${
                      isMeetingPage
                        ? 'bg-indigo-100/80 text-indigo-800 border-indigo-200/60'
                        : 'bg-slate-100 text-slate-600 border-slate-200/60'
                    }`}
                  >
                    {meetings.length}
                  </span>
                )}
              </button>

              {/* AI Assistant */}
              <button
                type="button"
                onClick={() => router.push('/chat')}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                  isChatPage
                    ? 'bg-indigo-50 text-indigo-700 font-semibold shadow-xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/80'
                }`}
              >
                <div className="flex items-center gap-3">
                  <MessageSquareText className={`w-4 h-4 shrink-0 ${isChatPage ? 'text-indigo-600' : 'text-slate-500'}`} />
                  <span>AI Assistant</span>
                </div>
                <span className="text-[10px] px-1.5 py-0.5 rounded-md font-semibold bg-indigo-100 text-indigo-700">
                  Groq
                </span>
              </button>

              {/* Settings */}
              <button
                type="button"
                onClick={() => router.push('/settings')}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                  isSettingsPage
                    ? 'bg-indigo-50 text-indigo-700 font-semibold shadow-xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/80'
                }`}
              >
                <Settings className={`w-4 h-4 shrink-0 ${isSettingsPage ? 'text-indigo-600' : 'text-slate-500'}`} />
                <span>Settings</span>
              </button>
            </div>

            {/* Bottom Footer Actions */}
            <div className="flex-shrink-0 p-3 border-t border-slate-100 space-y-2">
              {/* Record Action Button */}
              <button
                onClick={handleRecordingToggle}
                className={`w-full flex items-center justify-center gap-2 px-3.5 py-2.5 text-sm font-medium rounded-xl transition-all shadow-sm ${
                  isRecording
                    ? 'bg-red-500 text-white hover:bg-red-600'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 active:scale-[0.98]'
                }`}
              >
                {isRecording ? (
                  <>
                    <Square className="w-4 h-4" />
                    <span>Recording...</span>
                  </>
                ) : (
                  <>
                    <Mic className="w-4 h-4" />
                    <span>Start Recording</span>
                  </>
                )}
              </button>

              {/* Import Audio (Beta) */}
              {betaFeatures.importAndRetranscribe && (
                <button
                  onClick={() => openImportDialog()}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-xl transition-colors border border-indigo-100/80"
                >
                  <Upload className="w-4 h-4" />
                  <span>Import Audio</span>
                </button>
              )}

              {/* User Profile / Sign Out */}
              {mounted && user && (
                <div className="w-full px-2.5 py-1.5 flex items-center justify-between text-xs bg-slate-50 rounded-xl border border-slate-200/70">
                  <div className="flex items-center gap-1.5 truncate max-w-[140px]" title={user.email || ''}>
                    <UserIcon className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                    <span className="truncate text-slate-700 font-medium">{user.email}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => signOut()}
                    title="Sign Out"
                    className="p-1 hover:bg-rose-100 hover:text-rose-600 rounded-lg text-slate-400 transition-colors"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* About and version */}
              <div className="pt-1 flex items-center justify-between px-1">
                <Info isCollapsed={isCollapsed} />
                <span className="text-[11px] text-slate-400 font-medium">v0.4.0</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default Sidebar;
