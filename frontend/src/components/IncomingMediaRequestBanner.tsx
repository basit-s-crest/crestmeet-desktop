"use client";

import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Video, Send, X, CheckCircle, ArrowUpRight, Loader2 } from "lucide-react";
import { MediaRequest } from "@/types";
import { mediaTransferService, TransferProgress } from "@/services/mediaTransferService";
import { getSupabase } from "@/lib/supabaseClient";

export function IncomingMediaRequestBanner() {
  const [requests, setRequests] = useState<MediaRequest[]>([]);
  const [activeTransfer, setActiveTransfer] = useState<{
    requestId: string;
    progress: number;
    speedMBs: number;
  } | null>(null);
  const [completedMessage, setCompletedMessage] = useState<string | null>(null);
  const activeCleanupRef = useRef<(() => void) | null>(null);

  // Poll / Listen for incoming requests
  useEffect(() => {
    let isMounted = true;

    const fetchPending = async () => {
      try {
        const pending = await mediaTransferService.getIncomingRequests();
        if (isMounted) {
          setRequests(pending);
        }
      } catch (err) {
        console.warn("Could not check incoming media requests:", err);
      }
    };

    fetchPending();

    // Check periodically (e.g. every 10s) and via Supabase Realtime
    const interval = setInterval(fetchPending, 10000);

    const supabase = getSupabase();
    let sub: any = null;
    if (supabase) {
      sub = supabase
        .channel("public:media_requests")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "media_requests" },
          () => {
            fetchPending();
          }
        )
        .subscribe();
    }

    return () => {
      isMounted = false;
      clearInterval(interval);
      if (sub && supabase) {
        supabase.removeChannel(sub);
      }
    };
  }, []);

  const handleSend = async (req: MediaRequest) => {
    try {
      // Get meeting metadata to locate folder_path
      const metadata = await invoke<{ folder_path?: string }>("api_get_meeting_metadata", {
        meetingId: req.meeting_id,
      });

      if (!metadata?.folder_path) {
        alert("Could not locate local recording folder for this meeting.");
        return;
      }

      setActiveTransfer({ requestId: req.id, progress: 0, speedMBs: 0 });

      const cleanup = await mediaTransferService.startSender(
        req,
        metadata.folder_path,
        (progress: TransferProgress) => {
          setActiveTransfer({
            requestId: req.id,
            progress: progress.progress,
            speedMBs: progress.speedMBs,
          });
        },
        () => {
          setActiveTransfer(null);
          setCompletedMessage(`Video successfully sent to ${req.requester_email || "teammate"}!`);
          setRequests((prev) => prev.filter((r) => r.id !== req.id));
          setTimeout(() => setCompletedMessage(null), 5000);
        },
        (error: string) => {
          setActiveTransfer(null);
          alert(`Transfer error: ${error}`);
        }
      );

      activeCleanupRef.current = cleanup;
    } catch (err: any) {
      console.error("Failed to start sending video:", err);
      alert(`Could not start transfer: ${err.message || err}`);
    }
  };

  const handleDecline = async (req: MediaRequest) => {
    try {
      await mediaTransferService.declineRequest(req);
      setRequests((prev) => prev.filter((r) => r.id !== req.id));
    } catch (err) {
      console.warn("Could not decline request:", err);
    }
  };

  if (completedMessage) {
    return (
      <div className="fixed bottom-5 right-5 z-50 animate-in fade-in slide-in-from-bottom-5 duration-300">
        <div className="flex items-center space-x-3 bg-emerald-600 text-white px-4 py-3 rounded-xl shadow-xl text-sm font-medium">
          <CheckCircle size={18} />
          <span>{completedMessage}</span>
        </div>
      </div>
    );
  }

  if (activeTransfer) {
    const currentReq = requests.find((r) => r.id === activeTransfer.requestId);
    return (
      <div className="fixed bottom-5 right-5 z-50 max-w-sm w-full animate-in fade-in slide-in-from-bottom-5 duration-300">
        <div className="bg-slate-900 border border-slate-700 text-white p-4 rounded-2xl shadow-2xl space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <div className="w-7 h-7 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center">
                <Loader2 size={16} className="animate-spin" />
              </div>
              <div>
                <h5 className="text-xs font-semibold text-slate-100">
                  Sending Meeting Recording
                </h5>
                <p className="text-[11px] text-slate-400 truncate max-w-[200px]">
                  {currentReq?.meeting_title || "Meeting Recording"}
                </p>
              </div>
            </div>
            <span className="text-xs font-mono font-medium text-blue-400">
              {activeTransfer.progress}%
            </span>
          </div>

          <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-blue-500 h-1.5 transition-all duration-200 rounded-full"
              style={{ width: `${activeTransfer.progress}%` }}
            />
          </div>

          <div className="flex justify-between items-center text-[10px] text-slate-400 font-mono">
            <span>Direct P2P Encrypted</span>
            <span>{activeTransfer.speedMBs} MB/s</span>
          </div>
        </div>
      </div>
    );
  }

  if (requests.length === 0) {
    return null;
  }

  const current = requests[0];

  return (
    <div className="fixed bottom-5 right-5 z-50 max-w-md w-full animate-in fade-in slide-in-from-bottom-5 duration-300">
      <div className="bg-white border border-gray-200 p-4 rounded-2xl shadow-2xl space-y-3.5 ring-1 ring-black/5">
        <div className="flex items-start justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600">
              <Video size={16} />
            </div>
            <div>
              <h4 className="text-sm font-semibold text-gray-900">
                Recording Request
              </h4>
              <p className="text-xs text-gray-500">
                {current.requester_email || "A teammate"} requested access
              </p>
            </div>
          </div>

          <button
            onClick={() => handleDecline(current)}
            className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors"
            title="Dismiss request"
          >
            <X size={16} />
          </button>
        </div>

        <div className="bg-gray-50 rounded-xl p-2.5 border border-gray-100">
          <p className="text-xs font-medium text-gray-700 truncate">
            Meeting: <span className="text-gray-900 font-semibold">{current.meeting_title}</span>
          </p>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Will be transferred directly peer-to-peer from your computer.
          </p>
        </div>

        <div className="flex items-center justify-end space-x-2 pt-1">
          <button
            onClick={() => handleDecline(current)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-gray-600 hover:bg-gray-100 transition-colors"
          >
            Decline
          </button>
          <button
            onClick={() => handleSend(current)}
            className="inline-flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 shadow-sm transition-colors"
          >
            <Send size={13} />
            <span>Send Video</span>
          </button>
        </div>
      </div>
    </div>
  );
}
