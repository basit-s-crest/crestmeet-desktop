"use client";

import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  Cloud,
  Calendar,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  LogOut,
  ExternalLink,
  ShieldAlert,
} from "lucide-react";
import { Button } from "./ui/button";

interface GoogleServiceStatus {
  is_connected: boolean;
  email: string | null;
}

export function IntegrationSettings() {
  const [driveStatus, setDriveStatus] = useState<GoogleServiceStatus | null>(null);
  const [calendarStatus, setCalendarStatus] = useState<GoogleServiceStatus | null>(null);
  const [loadingDrive, setLoadingDrive] = useState(false);
  const [loadingCalendar, setLoadingCalendar] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchStatuses = useCallback(async () => {
    try {
      const [drive, calendar] = await Promise.all([
        invoke<GoogleServiceStatus>("api_google_drive_get_status").catch(() => ({
          is_connected: false,
          email: null,
        })),
        invoke<GoogleServiceStatus>("api_google_calendar_get_status").catch(() => ({
          is_connected: false,
          email: null,
        })),
      ]);
      setDriveStatus(drive);
      setCalendarStatus(calendar);
    } catch (err) {
      console.error("Failed to fetch integration statuses:", err);
    }
  }, []);

  useEffect(() => {
    fetchStatuses();
  }, [fetchStatuses]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await fetchStatuses();
    setIsRefreshing(false);
    toast.success("Integration status refreshed");
  };

  const handleConnectDrive = async () => {
    setLoadingDrive(true);
    try {
      toast.info("Opening browser for Google Drive authorization...");
      const status = await invoke<GoogleServiceStatus>("api_google_drive_start_auth", {
        userEmailHint: null,
      });
      setDriveStatus(status);
      toast.success(
        status.is_connected
          ? `Connected Google Drive (${status.email || "Account linked"})`
          : "Google Drive connected!"
      );
    } catch (err: any) {
      console.error("Failed to connect Google Drive:", err);
      toast.error(typeof err === "string" ? err : err?.message || "Failed to connect Google Drive");
    } finally {
      setLoadingDrive(false);
      fetchStatuses();
    }
  };

  const handleDisconnectDrive = async () => {
    setLoadingDrive(true);
    try {
      await invoke("api_google_drive_disconnect");
      setDriveStatus({ is_connected: false, email: null });
      toast.success("Disconnected Google Drive");
    } catch (err: any) {
      console.error("Failed to disconnect Google Drive:", err);
      toast.error(typeof err === "string" ? err : err?.message || "Failed to disconnect Google Drive");
    } finally {
      setLoadingDrive(false);
      fetchStatuses();
    }
  };

  const handleConnectCalendar = async () => {
    setLoadingCalendar(true);
    try {
      toast.info("Opening browser for Google Calendar authorization...");
      const status = await invoke<GoogleServiceStatus>("api_google_calendar_start_auth", {
        userEmailHint: null,
      });
      setCalendarStatus(status);
      toast.success(
        status.is_connected
          ? `Connected Google Calendar (${status.email || "Account linked"})`
          : "Google Calendar connected!"
      );
    } catch (err: any) {
      console.error("Failed to connect Google Calendar:", err);
      toast.error(typeof err === "string" ? err : err?.message || "Failed to connect Google Calendar");
    } finally {
      setLoadingCalendar(false);
      fetchStatuses();
    }
  };

  const handleDisconnectCalendar = async () => {
    setLoadingCalendar(true);
    try {
      await invoke("api_google_calendar_disconnect");
      setCalendarStatus({ is_connected: false, email: null });
      toast.success("Disconnected Google Calendar");
    } catch (err: any) {
      console.error("Failed to disconnect Google Calendar:", err);
      toast.error(typeof err === "string" ? err : err?.message || "Failed to disconnect Google Calendar");
    } finally {
      setLoadingCalendar(false);
      fetchStatuses();
    }
  };

  return (
    <div className="space-y-6">
      {/* Header bar */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Cloud & External Integrations</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Manage linked Google Cloud services for recording storage and meeting scheduling.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="flex items-center gap-1.5"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
          Refresh Status
        </Button>
      </div>

      {/* Google Drive Card */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600 shrink-0">
              <Cloud className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h3 className="text-base font-semibold text-gray-900">Google Drive</h3>
                {driveStatus?.is_connected ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-full">
                    <CheckCircle2 className="w-3 h-3" />
                    Connected
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 bg-gray-100 border border-gray-200 px-2.5 py-0.5 rounded-full">
                    <XCircle className="w-3 h-3" />
                    Not connected
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-600 mt-1 max-w-xl leading-relaxed">
                Automatically synchronizes meeting recordings to your Google Drive account, allowing
                team members to stream recordings directly within the app.
              </p>
              {driveStatus?.is_connected && driveStatus.email && (
                <div className="mt-2.5 text-xs text-gray-500 flex items-center gap-1.5">
                  <span className="font-medium text-gray-700">Account:</span>
                  <span className="bg-gray-100 text-gray-800 px-2 py-0.5 rounded-md font-mono">
                    {driveStatus.email}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {driveStatus?.is_connected ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleDisconnectDrive}
                disabled={loadingDrive}
                className="text-rose-600 hover:text-rose-700 hover:bg-rose-50 border-rose-200"
              >
                {loadingDrive ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                ) : (
                  <LogOut className="w-3.5 h-3.5 mr-1.5" />
                )}
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleConnectDrive}
                disabled={loadingDrive}
                className="bg-blue-600 hover:bg-blue-700 text-white"
              >
                {loadingDrive ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                ) : (
                  <Cloud className="w-3.5 h-3.5 mr-1.5" />
                )}
                Connect Google Drive
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Google Calendar Card */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-amber-50 border border-amber-100 flex items-center justify-center text-amber-600 shrink-0">
              <Calendar className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h3 className="text-base font-semibold text-gray-900">Google Calendar</h3>
                {calendarStatus?.is_connected ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-full">
                    <CheckCircle2 className="w-3 h-3" />
                    Connected
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 bg-gray-100 border border-gray-200 px-2.5 py-0.5 rounded-full">
                    <XCircle className="w-3 h-3" />
                    Not connected
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-600 mt-1 max-w-xl leading-relaxed">
                Connect your Google Calendar to schedule follow-up meetings and sync action items
                detected by AI summaries directly to your agenda.
              </p>
              {calendarStatus?.is_connected && calendarStatus.email && (
                <div className="mt-2.5 text-xs text-gray-500 flex items-center gap-1.5">
                  <span className="font-medium text-gray-700">Account:</span>
                  <span className="bg-gray-100 text-gray-800 px-2 py-0.5 rounded-md font-mono">
                    {calendarStatus.email}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {calendarStatus?.is_connected ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleDisconnectCalendar}
                disabled={loadingCalendar}
                className="text-rose-600 hover:text-rose-700 hover:bg-rose-50 border-rose-200"
              >
                {loadingCalendar ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                ) : (
                  <LogOut className="w-3.5 h-3.5 mr-1.5" />
                )}
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleConnectCalendar}
                disabled={loadingCalendar}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {loadingCalendar ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                ) : (
                  <Calendar className="w-3.5 h-3.5 mr-1.5" />
                )}
                Connect Google Calendar
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
