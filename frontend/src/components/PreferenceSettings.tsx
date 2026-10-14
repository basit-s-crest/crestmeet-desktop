"use client"

import { useEffect, useState, useRef } from "react"
import { Switch } from "./ui/switch"
import { Button } from "./ui/button"
import { FolderOpen, FolderEdit, RotateCcw } from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import Analytics from "@/lib/analytics"
import AnalyticsConsentSwitch from "./AnalyticsConsentSwitch"
import { useConfig, NotificationSettings } from "@/contexts/ConfigContext"

export function PreferenceSettings() {
  const {
    notificationSettings,
    storageLocations,
    isLoadingPreferences,
    loadPreferences,
    updateNotificationSettings
  } = useConfig();

  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean | null>(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [previousNotificationsEnabled, setPreviousNotificationsEnabled] = useState<boolean | null>(null);
  const hasTrackedViewRef = useRef(false);

  // Lazy load preferences on mount (only loads if not already cached)
  useEffect(() => {
    loadPreferences();
    // Reset tracking ref on mount (every tab visit)
    hasTrackedViewRef.current = false;
  }, [loadPreferences]);

  // Track preferences viewed analytics on every tab visit (once per mount)
  useEffect(() => {
    if (hasTrackedViewRef.current) return;

    const trackPreferencesViewed = async () => {
      // Wait for notification settings to be available (either from cache or after loading)
      if (notificationSettings) {
        await Analytics.track('preferences_viewed', {
          notifications_enabled: notificationSettings.notification_preferences.show_recording_started ? 'true' : 'false'
        });
        hasTrackedViewRef.current = true;
      } else if (!isLoadingPreferences) {
        // If not loading and no settings available, track with default value
        await Analytics.track('preferences_viewed', {
          notifications_enabled: 'false'
        });
        hasTrackedViewRef.current = true;
      }
    };

    trackPreferencesViewed();
  }, [notificationSettings, isLoadingPreferences]);

  // Update notificationsEnabled when notificationSettings are loaded from global state
  useEffect(() => {
    if (notificationSettings) {
      // Notification enabled means both started and stopped notifications are enabled
      const enabled =
        notificationSettings.notification_preferences.show_recording_started &&
        notificationSettings.notification_preferences.show_recording_stopped;
      setNotificationsEnabled(enabled);
      if (isInitialLoad) {
        setPreviousNotificationsEnabled(enabled);
        setIsInitialLoad(false);
      }
    } else if (!isLoadingPreferences) {
      // If not loading and no settings, use default
      setNotificationsEnabled(true);
      if (isInitialLoad) {
        setPreviousNotificationsEnabled(true);
        setIsInitialLoad(false);
      }
    }
  }, [notificationSettings, isLoadingPreferences, isInitialLoad])

  useEffect(() => {
    // Skip update on initial load or if value hasn't actually changed
    if (isInitialLoad || notificationsEnabled === null || notificationsEnabled === previousNotificationsEnabled) return;
    if (!notificationSettings) return;

    const handleUpdateNotificationSettings = async () => {
      console.log("Updating notification settings to:", notificationsEnabled);

      try {
        // Update the notification preferences
        const updatedSettings: NotificationSettings = {
          ...notificationSettings,
          notification_preferences: {
            ...notificationSettings.notification_preferences,
            show_recording_started: notificationsEnabled,
            show_recording_stopped: notificationsEnabled,
          }
        };

        console.log("Calling updateNotificationSettings with:", updatedSettings);
        await updateNotificationSettings(updatedSettings);
        setPreviousNotificationsEnabled(notificationsEnabled);
        console.log("Successfully updated notification settings to:", notificationsEnabled);

        // Track notification preference change - only fires when user manually toggles
        await Analytics.track('notification_settings_changed', {
          notifications_enabled: notificationsEnabled.toString()
        });
      } catch (error) {
        console.error('Failed to update notification settings:', error);
      }
    };

    handleUpdateNotificationSettings();
  }, [notificationsEnabled, notificationSettings, isInitialLoad, previousNotificationsEnabled, updateNotificationSettings])

  const handleOpenFolder = async (folderType: 'database' | 'models' | 'recordings') => {
    try {
      switch (folderType) {
        case 'database':
          await invoke('open_database_folder');
          break;
        case 'models':
          await invoke('open_models_folder');
          break;
        case 'recordings':
          await invoke('open_recordings_folder');
          break;
      }

      // Track storage folder access
      await Analytics.track('storage_folder_opened', {
        folder_type: folderType
      });
    } catch (error) {
      console.error(`Failed to open ${folderType} folder:`, error);
    }
  };

  const [recordingsFolder, setRecordingsFolder] = useState<string>("");

  useEffect(() => {
    if (storageLocations?.recordings) {
      setRecordingsFolder(storageLocations.recordings);
    }
  }, [storageLocations]);

  const handleSelectFolder = async () => {
    try {
      const selected = await invoke<string | null>('select_recording_folder');
      if (selected) {
        setRecordingsFolder(selected);
        toast.success('Recordings save location updated!', { description: selected });
      }
    } catch (error) {
      console.error('Failed to select recording folder:', error);
      toast.error('Failed to update folder');
    }
  };

  const handleResetFolder = async () => {
    try {
      const defaultPath = await invoke<string>('reset_recording_folder_to_default');
      setRecordingsFolder(defaultPath);
      toast.success('Reset to default recording folder', { description: defaultPath });
    } catch (error) {
      console.error('Failed to reset recording folder:', error);
      toast.error('Failed to reset folder');
    }
  };

  // Show loading only if we're actually loading and don't have cached data
  if (isLoadingPreferences && !notificationSettings && !storageLocations) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="flex items-center gap-2.5 text-gray-500 text-sm">
          <div className="w-4 h-4 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />
          <span>Loading system preferences...</span>
        </div>
      </div>
    );
  }

  // Show loading if notificationsEnabled hasn't been determined yet
  if (notificationsEnabled === null && !isLoadingPreferences) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="flex items-center gap-2.5 text-gray-500 text-sm">
          <div className="w-4 h-4 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />
          <span>Loading system preferences...</span>
        </div>
      </div>
    );
  }

  // Ensure we have a boolean value for the Switch component
  const notificationsEnabledValue = notificationsEnabled ?? false;

  return (
    <div className="space-y-6">
      {/* Notifications Section */}
      <div className="bg-white rounded-xl border border-gray-200/80 p-6 shadow-xs transition-all hover:border-gray-300">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600 shrink-0">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-gray-900">Meeting Notifications</h3>
                <span className="text-[11px] font-medium bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full border border-indigo-100">
                  Alerts
                </span>
              </div>
              <p className="text-sm text-gray-500 mt-1 leading-relaxed">
                Receive non-intrusive system desktop notifications when meeting recordings begin and finish.
              </p>
            </div>
          </div>
          <Switch
            checked={notificationsEnabledValue}
            onCheckedChange={setNotificationsEnabled}
            className="cursor-pointer"
          />
        </div>
      </div>

      {/* Data Storage Locations Section */}
      <div className="bg-white rounded-xl border border-gray-200/80 p-6 shadow-xs transition-all hover:border-gray-300">
        <div className="flex items-start gap-4 mb-5">
          <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600 shrink-0">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2 1.5 3 3.5 3h9c2 0 3.5-1 3.5-3V7M4 7c0-2 1.5-3 3.5-3h9c2 0 3.5 1 3.5 3M4 7h16m-5 4h.01M9 11h.01M9 15h6" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-gray-900">Storage & File Locations</h3>
              <span className="text-[11px] font-medium bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full border border-blue-100">
                Local Disk
              </span>
            </div>
            <p className="text-sm text-gray-500 mt-1 leading-relaxed">
              Configure where recordings, audio segments, and session data folders are persisted on your device.
            </p>
          </div>
        </div>

        <div className="p-4 rounded-xl bg-slate-50/80 border border-slate-200/80">
          <div className="flex items-center justify-between mb-1.5">
            <span className="font-semibold text-gray-900 text-sm">Recordings Directory</span>
            <span className="text-xs text-blue-700 bg-blue-50 font-medium px-2 py-0.5 rounded-full border border-blue-100">
              Customizable
            </span>
          </div>
          <p className="text-xs text-gray-500 mb-3">
            Audio captures and meeting metadata folders are automatically stored here.
          </p>

          <div className="text-xs text-gray-700 mb-3.5 break-all font-mono p-3 bg-white border border-gray-200 rounded-lg shadow-2xs select-all">
            {recordingsFolder || storageLocations?.recordings || 'Loading storage location...'}
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <Button
              onClick={handleSelectFolder}
              size="sm"
              className="bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-1.5 shadow-xs transition-all active:scale-95"
            >
              <FolderEdit className="w-3.5 h-3.5" />
              <span>Change Directory...</span>
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
              onClick={() => handleOpenFolder('recordings')}
              variant="outline"
              size="sm"
              className="border-gray-200 hover:bg-gray-100 text-gray-700 flex items-center gap-1.5 shadow-2xs transition-all"
            >
              <FolderOpen className="w-3.5 h-3.5 text-gray-500" />
              <span>Open in Explorer</span>
            </Button>
          </div>
        </div>

        <div className="mt-4 p-3 bg-blue-50/70 border border-blue-100 rounded-lg flex items-center gap-2 text-xs text-blue-800">
          <span className="font-semibold">Note:</span>
          <span>Database indexes and vector knowledge caches are managed securely within your local user data directory.</span>
        </div>
      </div>

      {/* Analytics & Privacy Section */}
      <div className="bg-white rounded-xl border border-gray-200/80 p-6 shadow-xs transition-all hover:border-gray-300">
        <AnalyticsConsentSwitch />
      </div>
    </div>
  );
}
