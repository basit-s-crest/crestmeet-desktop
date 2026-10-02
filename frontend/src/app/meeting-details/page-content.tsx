"use client";
import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Summary, SummaryResponse } from '@/types';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useProject } from '@/contexts/ProjectContext';
import { cleanMeetingTitle, formatMeetingDate, formatMeetingTime } from '@/lib/dateUtils';
import Analytics from '@/lib/analytics';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { TranscriptPanel } from '@/components/MeetingDetails/TranscriptPanel';
import { SummaryPanel } from '@/components/MeetingDetails/SummaryPanel';
import { ModelConfig } from '@/components/ModelSettingsModal';

// Custom hooks
import { useMeetingData } from '@/hooks/meeting-details/useMeetingData';
import { useSummaryGeneration } from '@/hooks/meeting-details/useSummaryGeneration';
import { useTemplates } from '@/hooks/meeting-details/useTemplates';
import { useCopyOperations } from '@/hooks/meeting-details/useCopyOperations';
import { useMeetingOperations } from '@/hooks/meeting-details/useMeetingOperations';
import { useConfig } from '@/contexts/ConfigContext';

export default function PageContent({
  meeting,
  summaryData,
  shouldAutoGenerate = false,
  onAutoGenerateComplete,
  onMeetingUpdated,
  onRefetchTranscripts,
  // Pagination props for efficient transcript loading
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
}: {
  meeting: any;
  summaryData: Summary | null;
  shouldAutoGenerate?: boolean;
  onAutoGenerateComplete?: () => void;
  onMeetingUpdated?: () => Promise<void>;
  onRefetchTranscripts?: () => Promise<void>;
  // Pagination props
  segments?: any[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;
}) {
  console.log('📄 PAGE CONTENT: Initializing with data:', {
    meetingId: meeting.id,
    summaryDataKeys: summaryData ? Object.keys(summaryData) : null,
    transcriptsCount: meeting.transcripts?.length
  });

  // Routing & Project Context
  const router = useRouter();
  const { activeProject } = useProject();

  const handleBackToProjects = () => {
    if (activeProject) {
      router.push(`/meetings?project=${activeProject.id}`);
    } else {
      router.push('/meetings');
    }
  };

  // State
  const [customPrompt, setCustomPrompt] = useState<string>('');
  const [isRecording] = useState(false);
  const [summaryResponse] = useState<SummaryResponse | null>(null);

  // Resizable panel width state (persisted in localStorage)
  const [transcriptWidth, setTranscriptWidth] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('crestmeet_transcript_panel_width');
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= 260 && parsed <= 1200) {
          return parsed;
        }
      }
    }
    return 380;
  });
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const startResizing = (mouseDownEvent: React.MouseEvent) => {
    mouseDownEvent.preventDefault();
    setIsDragging(true);

    const startX = mouseDownEvent.clientX;
    const startWidth = transcriptWidth;

    const onMouseMove = (mouseMoveEvent: MouseEvent) => {
      const delta = mouseMoveEvent.clientX - startX;
      const minW = 260;
      const maxW = Math.max(minW, window.innerWidth - 380);
      const newWidth = Math.min(Math.max(minW, startWidth + delta), maxW);
      setTranscriptWidth(newWidth);
    };

    const onMouseUp = () => {
      setIsDragging(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      setTranscriptWidth((finalW) => {
        if (typeof window !== 'undefined') {
          localStorage.setItem('crestmeet_transcript_panel_width', String(finalW));
        }
        return finalW;
      });
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // Ref to store the modal open function from SummaryGeneratorButtonGroup
  const openModelSettingsRef = useRef<(() => void) | null>(null);

  // Sidebar context
  const { serverAddress } = useSidebar();

  // Get model config from ConfigContext
  const { modelConfig, setModelConfig } = useConfig();

  // Custom hooks
  const meetingData = useMeetingData({ meeting, summaryData, onMeetingUpdated });
  const templates = useTemplates();

  // Callback to register the modal open function
  const handleRegisterModalOpen = (openFn: () => void) => {
    console.log('📝 Registering modal open function in PageContent');
    openModelSettingsRef.current = openFn;
  };

  // Callback to trigger modal open (called from error handler)
  const handleOpenModelSettings = () => {
    console.log('🔔 Opening model settings from PageContent');
    if (openModelSettingsRef.current) {
      openModelSettingsRef.current();
    } else {
      console.warn('⚠️ Modal open function not yet registered');
    }
  };

  // Save model config to backend database and sync via event
  const handleSaveModelConfig = async (config?: ModelConfig) => {
    if (!config) return;
    try {
      await invoke('api_save_model_config', {
        provider: config.provider,
        model: config.model,
        whisperModel: config.whisperModel,
        apiKey: config.apiKey ?? null,
        ollamaEndpoint: config.ollamaEndpoint ?? null,
      });

      // Emit event so ConfigContext and other listeners stay in sync
      const { emit } = await import('@tauri-apps/api/event');
      await emit('model-config-updated', config);

      toast.success('Model settings saved successfully');
    } catch (error) {
      console.error('Failed to save model config:', error);
      toast.error('Failed to save model settings');
    }
  };

  const summaryGeneration = useSummaryGeneration({
    meeting,
    transcripts: meetingData.transcripts,
    modelConfig: modelConfig,
    isModelConfigLoading: false, // ConfigContext loads on mount
    selectedTemplate: templates.selectedTemplate,
    onMeetingUpdated,
    updateMeetingTitle: meetingData.updateMeetingTitle,
    setAiSummary: meetingData.setAiSummary,
    onOpenModelSettings: handleOpenModelSettings,
  });

  const copyOperations = useCopyOperations({
    meeting,
    transcripts: meetingData.transcripts,
    meetingTitle: meetingData.meetingTitle,
    aiSummary: meetingData.aiSummary,
    blockNoteSummaryRef: meetingData.blockNoteSummaryRef,
  });

  const meetingOperations = useMeetingOperations({
    meeting,
  });

  // Track page view
  useEffect(() => {
    Analytics.trackPageView('meeting_details');
  }, []);

  // Auto-generate summary when flag is set
  useEffect(() => {
    let cancelled = false;

    const autoGenerate = async () => {
      if (shouldAutoGenerate && meetingData.transcripts.length > 0 && !cancelled) {
        console.log(`🤖 Auto-generating summary with ${modelConfig.provider}/${modelConfig.model}...`);
        await summaryGeneration.handleGenerateSummary('');

        // Notify parent that auto-generation is complete (only if not cancelled)
        if (onAutoGenerateComplete && !cancelled) {
          onAutoGenerateComplete();
        }
      }
    };

    autoGenerate();

    // Cleanup: cancel if component unmounts or meeting changes
    return () => {
      cancelled = true;
    };
  }, [shouldAutoGenerate, meeting.id]); // Re-run if meeting changes

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="flex flex-col h-screen bg-gray-50"
    >
      {/* Top Header Bar — Back feature in up-left corner & Editable Meeting Name */}
      <div className="min-h-[52px] bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between shrink-0 z-20 gap-3">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button
            onClick={handleBackToProjects}
            className="flex items-center gap-1.5 text-xs sm:text-sm font-semibold text-gray-700 hover:text-gray-900 transition-colors px-2.5 py-1.5 rounded-lg hover:bg-gray-100 cursor-pointer border border-gray-200 shadow-2xs shrink-0"
            title="Return to Projects page"
          >
            <ArrowLeft className="w-4 h-4 text-gray-600" />
            <span>Back to Projects</span>
          </button>

          <div className="h-4 w-[1px] bg-gray-200 hidden sm:block shrink-0" />

          {activeProject && (
            <span className="text-xs font-semibold text-gray-600 bg-gray-100 px-2.5 py-1 rounded-md border border-gray-200/80 truncate hidden md:inline shrink-0">
              {activeProject.name}
            </span>
          )}

          {/* Editable Meeting Title directly in the top header */}
          {meetingData.isEditingTitle ? (
            <input
              type="text"
              value={meetingData.meetingTitle}
              onChange={(e) => meetingData.handleTitleChange(e.target.value)}
              onBlur={async () => {
                meetingData.setIsEditingTitle(false);
                if (meetingData.isTitleDirty) {
                  await meetingData.handleSaveMeetingTitle();
                }
              }}
              onKeyDown={async (e) => {
                if (e.key === 'Enter') {
                  meetingData.setIsEditingTitle(false);
                  if (meetingData.isTitleDirty) {
                    await meetingData.handleSaveMeetingTitle();
                  }
                } else if (e.key === 'Escape') {
                  meetingData.setIsEditingTitle(false);
                }
              }}
              autoFocus
              className="text-base sm:text-lg font-bold text-gray-900 bg-gray-50 border border-blue-400 rounded-lg px-2.5 py-0.5 focus:outline-none focus:ring-2 focus:ring-blue-500/20 w-full max-w-sm sm:max-w-md md:max-w-xl"
            />
          ) : (
            <h1
              onClick={() => meetingData.setIsEditingTitle(true)}
              className="text-base sm:text-lg font-bold text-gray-900 hover:text-blue-600 hover:bg-gray-100/80 px-2 py-0.5 rounded-lg cursor-pointer transition-colors truncate max-w-sm sm:max-w-md md:max-w-xl select-none"
              title="Click to edit meeting title"
            >
              {cleanMeetingTitle(meetingData.meetingTitle || meeting.title, meeting.created_at)}
            </h1>
          )}
        </div>

        {meeting.created_at && (
          <div className="text-xs text-gray-500 shrink-0 hidden md:block">
            {formatMeetingDate(meeting.created_at)} · {formatMeetingTime(meeting.created_at)}
          </div>
        )}
      </div>

      <div className={`flex flex-1 overflow-hidden ${isDragging ? 'select-none cursor-col-resize' : ''}`}>
        <TranscriptPanel
          transcripts={meetingData.transcripts}
          customPrompt={customPrompt}
          onPromptChange={setCustomPrompt}
          onCopyTranscript={copyOperations.handleCopyTranscript}
          onOpenMeetingFolder={meetingOperations.handleOpenMeetingFolder}
          isRecording={isRecording}
          disableAutoScroll={true}
          // Pagination props for efficient loading
          usePagination={true}
          segments={segments}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          totalCount={totalCount}
          loadedCount={loadedCount}
          onLoadMore={onLoadMore}
          // Retranscription props
          meetingId={meeting.id}
          meetingFolderPath={meeting.folder_path}
          onRefetchTranscripts={onRefetchTranscripts}
          hasVideo={meeting.has_video}
          recorderId={meeting.user_id}
          recorderEmail={meeting.recorder_email}
          projectId={meeting.project_id || activeProject?.id}
          driveFileId={(meeting as any).drive_file_id}
          videoUrl={(meeting as any).video_url}
          uploadStatus={(meeting as any).upload_status}
          width={transcriptWidth}
        />

        {/* Draggable Divider Handle - slim 1px line with comfortable hit area */}
        <div
          onMouseDown={startResizing}
          title="Drag to resize panels"
          className={`relative w-[1px] bg-gray-200 hover:bg-blue-500 transition-colors cursor-col-resize z-20 shrink-0 select-none ${
            isDragging ? 'bg-blue-600' : ''
          }`}
        >
          {/* Invisible expanded hit area for effortless grabbing */}
          <div className="absolute inset-y-0 -left-1.5 -right-1.5 cursor-col-resize" />
        </div>

        <SummaryPanel
          meeting={meeting}
          meetingTitle={meetingData.meetingTitle}
          onTitleChange={meetingData.handleTitleChange}
          isEditingTitle={meetingData.isEditingTitle}
          onStartEditTitle={() => meetingData.setIsEditingTitle(true)}
          onFinishEditTitle={() => meetingData.setIsEditingTitle(false)}
          isTitleDirty={meetingData.isTitleDirty}
          summaryRef={meetingData.blockNoteSummaryRef}
          isSaving={meetingData.isSaving}
          onSaveAll={meetingData.saveAllChanges}
          onCopySummary={copyOperations.handleCopySummary}
          onOpenFolder={meetingOperations.handleOpenMeetingFolder}
          aiSummary={meetingData.aiSummary}
          summaryStatus={summaryGeneration.summaryStatus}
          transcripts={meetingData.transcripts}
          modelConfig={modelConfig}
          setModelConfig={setModelConfig}
          onSaveModelConfig={handleSaveModelConfig}
          onGenerateSummary={summaryGeneration.handleGenerateSummary}
          onStopGeneration={summaryGeneration.handleStopGeneration}
          customPrompt={customPrompt}
          summaryResponse={summaryResponse}
          onSaveSummary={meetingData.handleSaveSummary}
          onSummaryChange={meetingData.handleSummaryChange}
          onDirtyChange={meetingData.setIsSummaryDirty}
          summaryError={summaryGeneration.summaryError}
          onRegenerateSummary={summaryGeneration.handleRegenerateSummary}
          getSummaryStatusMessage={summaryGeneration.getSummaryStatusMessage}
          availableTemplates={templates.availableTemplates}
          selectedTemplate={templates.selectedTemplate}
          onTemplateSelect={templates.handleTemplateSelection}
          isModelConfigLoading={false}
          onOpenModelSettings={handleRegisterModalOpen}
        />
      </div>
    </motion.div>
  );
}
