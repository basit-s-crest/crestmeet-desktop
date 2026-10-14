import React, { useState, useEffect } from 'react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  FolderOpen,
  FolderEdit,
  RotateCcw,
  Mic,
  Headphones,
  Bell,
  FileText,
  AlertCircle,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { DeviceSelection, SelectedDevices } from '@/components/DeviceSelection';
import Analytics from '@/lib/analytics';
import { toast } from 'sonner';

export interface RecordingPreferences {
  save_folder: string;
  auto_save: boolean;
  file_format: string;
  preferred_mic_device: string | null;
  preferred_system_device: string | null;
}

interface RecordingSettingsProps {
  onSave?: (preferences: RecordingPreferences) => void;
}

export function RecordingSettings({ onSave }: RecordingSettingsProps) {
  const [preferences, setPreferences] = useState<RecordingPreferences>({
    save_folder: '',
    auto_save: true,
    file_format: 'mp4',
    preferred_mic_device: null,
    preferred_system_device: null
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showRecordingNotification, setShowRecordingNotification] = useState(true);

  // Load recording preferences on component mount
  useEffect(() => {
    const loadPreferences = async () => {
      try {
        const prefs = await invoke<RecordingPreferences>('get_recording_preferences');
        setPreferences(prefs);
      } catch (error) {
        console.error('Failed to load recording preferences:', error);
        // If loading fails, get default folder path
        try {
          const defaultPath = await invoke<string>('get_default_recordings_folder_path');
          setPreferences(prev => ({ ...prev, save_folder: defaultPath }));
        } catch (defaultError) {
          console.error('Failed to get default folder path:', defaultError);
        }
      } finally {
        setLoading(false);
      }
    };

    loadPreferences();
  }, []);

  // Load recording notification preference
  useEffect(() => {
    const loadNotificationPref = async () => {
      try {
        const { Store } = await import('@tauri-apps/plugin-store');
        const store = await Store.load('preferences.json');
        const show = await store.get<boolean>('show_recording_notification') ?? true;
        setShowRecordingNotification(show);
      } catch (error) {
        console.error('Failed to load notification preference:', error);
      }
    };
    loadNotificationPref();
  }, []);

  const handleAutoSaveToggle = async (enabled: boolean) => {
    const newPreferences = { ...preferences, auto_save: enabled };
    setPreferences(newPreferences);
    await savePreferences(newPreferences);

    // Track auto-save setting change
    await Analytics.track('auto_save_recording_toggled', {
      enabled: enabled.toString()
    });
  };

  const handleDeviceChange = async (devices: SelectedDevices) => {
    const newPreferences = {
      ...preferences,
      preferred_mic_device: devices.micDevice,
      preferred_system_device: devices.systemDevice
    };
    setPreferences(newPreferences);
    await savePreferences(newPreferences);

    // Track default device preference changes
    // Note: Individual device selection analytics are tracked in DeviceSelection component
    await Analytics.track('default_devices_changed', {
      has_preferred_microphone: (!!devices.micDevice).toString(),
      has_preferred_system_audio: (!!devices.systemDevice).toString()
    });
  };

  const handleOpenFolder = async () => {
    try {
      await invoke('open_recordings_folder');
    } catch (error) {
      console.error('Failed to open recordings folder:', error);
    }
  };

  const handleSelectFolder = async () => {
    try {
      const selected = await invoke<string | null>('select_recording_folder');
      if (selected) {
        setPreferences(prev => ({ ...prev, save_folder: selected }));
        toast.success('Recordings save location updated!', {
          description: selected
        });
      }
    } catch (error) {
      console.error('Failed to select recording folder:', error);
      toast.error('Failed to update folder', {
        description: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const handleResetFolder = async () => {
    try {
      const defaultPath = await invoke<string>('reset_recording_folder_to_default');
      setPreferences(prev => ({ ...prev, save_folder: defaultPath }));
      toast.success('Reset to default recording folder', {
        description: defaultPath
      });
    } catch (error) {
      console.error('Failed to reset recording folder:', error);
      toast.error('Failed to reset folder');
    }
  };

  const handleNotificationToggle = async (enabled: boolean) => {
    try {
      setShowRecordingNotification(enabled);
      const { Store } = await import('@tauri-apps/plugin-store');
      const store = await Store.load('preferences.json');
      await store.set('show_recording_notification', enabled);
      await store.save();
      toast.success('Preference saved');
      await Analytics.track('recording_notification_preference_changed', {
        enabled: enabled.toString()
      });
    } catch (error) {
      console.error('Failed to save notification preference:', error);
      toast.error('Failed to save preference');
    }
  };

  const savePreferences = async (prefs: RecordingPreferences) => {
    setSaving(true);
    try {
      await invoke('set_recording_preferences', { preferences: prefs });
      onSave?.(prefs);

      // Show success toast with device details
      const micDevice = prefs.preferred_mic_device || 'Default';
      const systemDevice = prefs.preferred_system_device || 'Default';
      toast.success("Device preferences saved", {
        description: `Microphone: ${micDevice}, System Audio: ${systemDevice}`
      });
    } catch (error) {
      console.error('Failed to save recording preferences:', error);
      toast.error("Failed to save device preferences", {
        description: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="flex items-center gap-2.5 text-gray-500 text-sm">
          <div className="w-4 h-4 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />
          <span>Loading recording settings...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Auto Save Toggle Card */}
      <div className="bg-white rounded-xl border border-gray-200/80 p-6 shadow-xs transition-all hover:border-gray-300">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-rose-50 border border-rose-100 flex items-center justify-center text-rose-600 shrink-0">
              <Mic className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-gray-900">Audio Persistence</h3>
                <span className="text-[11px] font-medium bg-rose-50 text-rose-700 px-2 py-0.5 rounded-full border border-rose-100">
                  Storage
                </span>
              </div>
              <p className="text-sm text-gray-500 mt-1 leading-relaxed">
                Automatically encode and persist audio files when recording stops.
              </p>
            </div>
          </div>
          <Switch
            checked={preferences.auto_save}
            onCheckedChange={handleAutoSaveToggle}
            disabled={saving}
            className="cursor-pointer"
          />
        </div>
      </div>

      {/* Folder Location & File Format Card */}
      {preferences.auto_save ? (
        <div className="bg-white rounded-xl border border-gray-200/80 p-6 shadow-xs transition-all hover:border-gray-300 space-y-5">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600 shrink-0">
              <FolderOpen className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-gray-900">Output Folder & Format</h3>
                <span className="text-[11px] font-medium bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full border border-blue-100">
                  Customizable
                </span>
              </div>
              <p className="text-sm text-gray-500 mt-1 leading-relaxed">
                Choose where your exported recordings and audio chunks are saved on disk.
              </p>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-50/80 border border-slate-200/80">
            <div className="text-xs text-gray-700 mb-3.5 break-all font-mono p-3 bg-white border border-gray-200 rounded-lg shadow-2xs select-all">
              {preferences.save_folder || 'Default system directory'}
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <Button
                onClick={handleSelectFolder}
                size="sm"
                className="bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-1.5 shadow-xs transition-all active:scale-95"
              >
                <FolderEdit className="w-3.5 h-3.5" />
                <span>Change Folder...</span>
              </Button>
              <Button
                onClick={handleResetFolder}
                variant="outline"
                size="sm"
                className="border-gray-200 hover:bg-gray-100 text-gray-700 flex items-center gap-1.5 shadow-2xs transition-all"
                title="Reset to default music recordings directory"
              >
                <RotateCcw className="w-3.5 h-3.5 text-gray-500" />
                <span>Reset Default</span>
              </Button>
              <Button
                onClick={handleOpenFolder}
                variant="outline"
                size="sm"
                className="border-gray-200 hover:bg-gray-100 text-gray-700 flex items-center gap-1.5 shadow-2xs transition-all"
              >
                <FolderOpen className="w-3.5 h-3.5 text-gray-500" />
                <span>Open in Explorer</span>
              </Button>
            </div>
          </div>

          <div className="p-3.5 bg-blue-50/70 border border-blue-100 rounded-lg flex items-center justify-between text-xs text-blue-800">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-blue-600" />
              <span>
                <strong>Format:</strong> High-fidelity {preferences.file_format.toUpperCase()} audio container
              </span>
            </div>
            <span className="font-mono text-[11px] bg-white px-2 py-0.5 rounded border border-blue-200 text-blue-900">
              recording_YYYYMMDD_HHMMSS.{preferences.file_format}
            </span>
          </div>
        </div>
      ) : (
        <div className="p-4 rounded-xl border border-amber-200 bg-amber-50/70 text-amber-800 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-amber-600 shrink-0" />
          <div className="text-xs leading-relaxed">
            <strong>Audio persistence is currently disabled.</strong> Meeting audio will be processed in-memory for live transcripts but not stored permanently on disk.
          </div>
        </div>
      )}

      {/* Recording Notification Toggle Card */}
      <div className="bg-white rounded-xl border border-gray-200/80 p-6 shadow-xs transition-all hover:border-gray-300">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-amber-50 border border-amber-100 flex items-center justify-center text-amber-600 shrink-0">
              <Bell className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-gray-900">Recording Banner Reminder</h3>
                <span className="text-[11px] font-medium bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full border border-amber-100">
                  Compliance
                </span>
              </div>
              <p className="text-sm text-gray-500 mt-1 leading-relaxed">
                Show a prompt when starting calls to inform participants they are being recorded.
              </p>
            </div>
          </div>
          <Switch
            checked={showRecordingNotification}
            onCheckedChange={handleNotificationToggle}
            className="cursor-pointer"
          />
        </div>
      </div>

      {/* Default Audio Devices Card */}
      <div className="bg-white rounded-xl border border-gray-200/80 p-6 shadow-xs transition-all hover:border-gray-300">
        <div className="flex items-start gap-4 mb-5">
          <div className="w-10 h-10 rounded-xl bg-violet-50 border border-violet-100 flex items-center justify-center text-violet-600 shrink-0">
            <Headphones className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-gray-900">Default Audio Hardware</h3>
              <span className="text-[11px] font-medium bg-violet-50 text-violet-700 px-2 py-0.5 rounded-full border border-violet-100">
                Input & Output
              </span>
            </div>
            <p className="text-sm text-gray-500 mt-1 leading-relaxed">
              Preset your preferred microphone and system loopback devices to automatically initialize on new recordings.
            </p>
          </div>
        </div>

        <div className="p-4 rounded-xl bg-slate-50/80 border border-slate-200/80">
          <DeviceSelection
            selectedDevices={{
              micDevice: preferences.preferred_mic_device,
              systemDevice: preferences.preferred_system_device,
            }}
            onDeviceChange={handleDeviceChange}
            disabled={saving}
          />
        </div>
      </div>
    </div>
  );
}