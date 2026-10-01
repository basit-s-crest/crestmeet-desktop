'use client';

import React, { useState, useEffect } from 'react';
import { initializeInterceptors } from './interceptor';
import { telemetryStore } from './telemetryStore';
import { InfoTab } from './InfoTab';
import { ConsoleTab } from './ConsoleTab';
import { NetworkTab } from './NetworkTab';
import { ActionsTab } from './ActionsTab';
import {
  Activity,
  X,
  Download,
  Trash2,
  Terminal,
  Wifi,
  MousePointer,
  Info,
  Maximize2,
  Minimize2,
} from 'lucide-react';

export function ObservabilityDrawer() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'info' | 'console' | 'network' | 'actions'>('console');
  const [errorCount, setErrorCount] = useState(0);
  const [networkErrorCount, setNetworkErrorCount] = useState(0);
  const [isExpanded, setIsExpanded] = useState(false);

  // Initialize interceptors once on mount
  useEffect(() => {
    initializeInterceptors();

    const unsubscribe = telemetryStore.subscribe(() => {
      setErrorCount(telemetryStore.getErrorCount());
      setNetworkErrorCount(telemetryStore.getNetworkErrorCount());
    });

    return () => unsubscribe();
  }, []);

  // Global shortcut: Ctrl + Shift + O or Cmd + Shift + O
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleExport = () => {
    const jsonString = telemetryStore.exportReport();
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `crestmeet-qa-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  interface TabConfig {
    id: 'info' | 'console' | 'network' | 'actions';
    label: string;
    icon: React.ReactNode;
    badge?: number;
  }

  const tabs: TabConfig[] = [
    { id: 'info', label: 'Info', icon: <Info className="w-3.5 h-3.5" /> },
    {
      id: 'console',
      label: 'Console',
      icon: <Terminal className="w-3.5 h-3.5" />,
      badge: errorCount > 0 ? errorCount : undefined,
    },
    {
      id: 'network',
      label: 'Network',
      icon: <Wifi className="w-3.5 h-3.5" />,
      badge: networkErrorCount > 0 ? networkErrorCount : undefined,
    },
    { id: 'actions', label: 'Actions', icon: <MousePointer className="w-3.5 h-3.5" /> },
  ];

  return (
    <>
      {/* Floating Trigger Pill (Bottom-Right) */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          data-observability-panel="true"
          title="Open DevTools Observability (Ctrl+Shift+O)"
          style={{
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            zIndex: 99998,
            backgroundColor: '#18181b',
            color: '#fafafa',
            border: '1px solid #3f3f46',
            boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
          }}
          className="flex items-center gap-2 text-xs px-3.5 py-2 rounded-full backdrop-blur transition-all hover:scale-105 active:scale-95 group font-sans cursor-pointer"
        >
          <div className="relative flex items-center">
            <Activity className="w-3.5 h-3.5 text-sky-400 group-hover:rotate-12 transition-transform" />
            {(errorCount > 0 || networkErrorCount > 0) && (
              <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-rose-500 animate-ping" />
            )}
          </div>
          <span className="font-medium text-[11px] tracking-wide">DevTools</span>
          {(errorCount > 0 || networkErrorCount > 0) && (
            <span className="bg-rose-600 text-white font-bold text-[10px] px-1.5 py-0.2 rounded-full">
              {errorCount + networkErrorCount}
            </span>
          )}
        </button>
      )}

      {/* Observability Drawer */}
      {isOpen && (
        <div
          data-observability-panel="true"
          style={{
            position: 'fixed',
            top: 0,
            right: 0,
            width: isExpanded ? '660px' : '440px',
            maxWidth: '92vw',
            height: '100vh',
            maxHeight: '100vh',
            zIndex: 99999,
            backgroundColor: '#090a0f',
            color: '#f4f4f5',
            boxShadow: '-8px 0 35px rgba(0, 0, 0, 0.75)',
            borderLeft: '1px solid #27272a',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
          className="font-sans transition-all duration-200 select-none"
        >
          {/* Top Bar */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800 bg-neutral-900/80">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="font-semibold text-xs tracking-tight text-neutral-200">
                Observability DevTools
              </span>
              <span className="text-[10px] text-neutral-500 font-mono hidden sm:inline">
                (Ctrl+Shift+O)
              </span>
            </div>

            <div className="flex items-center gap-1">
              <button
                onClick={handleExport}
                title="Export QA Debug Report (JSON)"
                className="p-1.5 hover:bg-neutral-800 text-neutral-400 hover:text-sky-300 rounded transition-colors flex items-center gap-1 text-[11px]"
              >
                <Download className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Export</span>
              </button>

              <button
                onClick={() => telemetryStore.clearAll()}
                title="Clear all logs & network"
                className="p-1.5 hover:bg-neutral-800 text-neutral-400 hover:text-rose-400 rounded transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>

              <button
                onClick={() => setIsExpanded(!isExpanded)}
                title={isExpanded ? 'Collapse width' : 'Expand width'}
                className="p-1.5 hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 rounded transition-colors"
              >
                {isExpanded ? (
                  <Minimize2 className="w-3.5 h-3.5" />
                ) : (
                  <Maximize2 className="w-3.5 h-3.5" />
                )}
              </button>

              <button
                onClick={() => setIsOpen(false)}
                title="Close drawer (Ctrl+Shift+O)"
                className="p-1.5 hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 rounded transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Jam-style Navigation Tabs */}
          <div className="flex items-center px-2 border-b border-neutral-800 bg-neutral-900/40 text-xs gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`relative flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 ${
                  activeTab === tab.id
                    ? 'border-sky-500 text-sky-400 bg-neutral-900/60'
                    : 'border-transparent text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900/30'
                }`}
              >
                {tab.icon}
                <span>{tab.label}</span>
                {tab.badge !== undefined && (
                  <span className="w-2 h-2 rounded-full bg-rose-500" />
                )}
              </button>
            ))}
          </div>

          {/* Tab Content Container */}
          <div className="flex-1 overflow-hidden relative bg-neutral-950">
            {activeTab === 'info' && <InfoTab />}
            {activeTab === 'console' && <ConsoleTab />}
            {activeTab === 'network' && <NetworkTab />}
            {activeTab === 'actions' && <ActionsTab />}
          </div>
        </div>
      )}
    </>
  );
}
