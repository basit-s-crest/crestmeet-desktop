'use client';

import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import {
  Settings2,
  Mic,
  FileAudio,
  Sparkles,
  Cloud,
  Sliders,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { motion } from 'framer-motion';
import { TranscriptSettings } from '@/components/TranscriptSettings';
import { RecordingSettings } from '@/components/RecordingSettings';
import { PreferenceSettings } from '@/components/PreferenceSettings';
import { SummaryModelSettings } from '@/components/SummaryModelSettings';
import { IntegrationSettings } from '@/components/IntegrationSettings';
import { useConfig } from '@/contexts/ConfigContext';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

// Tabs configuration
const TABS = [
  { value: 'general', label: 'General', icon: Sliders, badge: 'System' },
  { value: 'integrations', label: 'Integrations', icon: Cloud, badge: 'Cloud' },
  { value: 'recording', label: 'Recordings', icon: Mic, badge: 'Audio' },
  { value: 'Transcriptionmodels', label: 'Transcription', icon: FileAudio, badge: 'STT' },
  { value: 'summaryModels', label: 'AI Summary', icon: Sparkles, badge: 'LLM' },
] as const;

export default function SettingsPage() {
  const { transcriptModelConfig, setTranscriptModelConfig } = useConfig();

  // Animation state for tabs
  const [activeTab, setActiveTab] = useState('general');
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [underlineStyle, setUnderlineStyle] = useState({ left: 0, width: 0 });

  // Load saved transcript configuration on mount
  useEffect(() => {
    const loadTranscriptConfig = async () => {
      try {
        const config = (await invoke('api_get_transcript_config')) as any;
        if (config) {
          setTranscriptModelConfig({
            provider: config.provider || 'deepgram',
            model: config.model || 'nova-2',
            apiKey: config.apiKey || null,
          });
        }
      } catch (error) {
        console.error('Failed to load transcript config:', error);
      }
    };
    loadTranscriptConfig();
  }, [setTranscriptModelConfig]);

  // Update underline position when active tab changes
  useLayoutEffect(() => {
    const activeIndex = TABS.findIndex((tab) => tab.value === activeTab);
    const activeTabElement = tabRefs.current[activeIndex];

    if (activeTabElement) {
      const { offsetLeft, offsetWidth } = activeTabElement;
      setUnderlineStyle({ left: offsetLeft, width: offsetWidth });
    }
  }, [activeTab]);

  return (
    <div className="h-screen bg-slate-50/60 flex flex-col overflow-hidden">
      {/* Sticky Header — Matches Projects & Meetings design language */}
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur-xs border-b border-gray-200/80 flex-shrink-0">
        <div className="max-w-5xl mx-auto px-6 sm:px-8 pt-6 pb-0">
          <div className="flex items-center justify-between gap-4 pb-5">
            <div className="flex items-center gap-3.5">
              <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600 shadow-2xs shrink-0">
                <Settings2 className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Settings</h1>
                  <span className="text-[11px] font-medium bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full border border-gray-200/80">
                    Preferences
                  </span>
                </div>
                <p className="text-xs sm:text-sm text-gray-500 mt-0.5">
                  Manage recording devices, speech recognition, AI models, and cloud integrations.
                </p>
              </div>
            </div>
          </div>

          {/* Navigation Tab Bar */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="bg-transparent relative rounded-none border-b border-transparent p-0 h-auto flex gap-1 justify-start overflow-x-auto no-scrollbar">
              {TABS.map((tab, index) => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.value;
                return (
                  <TabsTrigger
                    key={tab.value}
                    value={tab.value}
                    ref={(el) => {
                      tabRefs.current[index] = el;
                    }}
                    className={`flex items-center gap-2 px-4 py-3 bg-transparent rounded-none border-0 relative z-10 text-sm font-medium transition-colors cursor-pointer ${
                      isActive
                        ? 'text-blue-600 font-semibold'
                        : 'text-gray-500 hover:text-gray-900'
                    }`}
                  >
                    <Icon className={`w-4 h-4 transition-colors ${isActive ? 'text-blue-600' : 'text-gray-400'}`} />
                    <span>{tab.label}</span>
                    <span
                      className={`text-[10px] uppercase tracking-wider px-1.5 py-0.2 rounded-md font-medium transition-colors ${
                        isActive
                          ? 'bg-blue-100/70 text-blue-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {tab.badge}
                    </span>
                  </TabsTrigger>
                );
              })}

              <motion.div
                className="absolute bottom-0 z-20 h-0.5 bg-blue-600 rounded-full"
                layoutId="settingsTabUnderline"
                style={{ left: underlineStyle.left, width: underlineStyle.width }}
                transition={{ type: 'spring', stiffness: 400, damping: 38 }}
              />
            </TabsList>
          </Tabs>
        </div>
      </header>

      {/* Scrollable Content Area */}
      <main className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="max-w-5xl mx-auto px-6 sm:px-8 py-8">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsContent value="general" className="mt-0 focus-visible:outline-hidden">
              <PreferenceSettings />
            </TabsContent>
            <TabsContent value="integrations" className="mt-0 focus-visible:outline-hidden">
              <IntegrationSettings />
            </TabsContent>
            <TabsContent value="recording" className="mt-0 focus-visible:outline-hidden">
              <RecordingSettings />
            </TabsContent>
            <TabsContent value="Transcriptionmodels" className="mt-0 focus-visible:outline-hidden">
              <TranscriptSettings
                transcriptModelConfig={transcriptModelConfig}
                setTranscriptModelConfig={setTranscriptModelConfig}
              />
            </TabsContent>
            <TabsContent value="summaryModels" className="mt-0 focus-visible:outline-hidden">
              <SummaryModelSettings />
            </TabsContent>
          </Tabs>
        </div>
      </main>
    </div>
  );
}
