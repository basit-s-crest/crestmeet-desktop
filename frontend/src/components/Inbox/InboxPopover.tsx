'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useProject } from '@/contexts/ProjectContext';
import {
  Inbox,
  Check,
  X,
  Loader2,
  Folder,
  Shield,
  RotateCcw,
  Sparkles,
  Bell,
  MailOpen,
} from 'lucide-react';
import { toast } from 'sonner';

export function InboxPopover() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'pending' | 'history'>('pending');
  const [respondingId, setRespondingId] = useState<string | null>(null);

  const {
    invitations,
    pendingInvitationsCount,
    isLoadingInvitations,
    refreshInvitations,
    respondToInvitation,
  } = useProject();

  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleRespond = async (invitationId: string, accept: boolean) => {
    try {
      setRespondingId(invitationId);
      const success = await respondToInvitation(invitationId, accept);
      if (success) {
        toast.success(accept ? 'Invitation accepted!' : 'Invitation declined', {
          description: accept ? 'You are now a member of this project.' : undefined,
        });
      }
    } catch (err: any) {
      toast.error('Action failed', {
        description: err.message || 'Could not update invitation.',
      });
    } finally {
      setRespondingId(null);
    }
  };

  const pendingList = invitations.filter((inv) => inv.status === 'pending');
  const historyList = invitations.filter((inv) => inv.status !== 'pending');

  return (
    <div className="relative inline-block text-left">
      {/* Small extension-style button at top-right */}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className={`relative flex items-center justify-center w-9 h-9 rounded-xl border transition-all duration-200 cursor-pointer shadow-xs ${
          isOpen
            ? 'bg-blue-50 border-blue-300 text-blue-600 shadow-sm ring-2 ring-blue-100'
            : 'bg-white/90 hover:bg-white border-gray-200/90 hover:border-gray-300 text-gray-600 hover:text-gray-900 backdrop-blur-sm'
        }`}
        title="Project Invitations"
        aria-label="Project Invitations"
      >
        <Bell size={17} className={pendingInvitationsCount > 0 ? 'text-blue-600' : 'text-gray-500'} />

        {/* Small badge count */}
        {pendingInvitationsCount > 0 && (
          <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] px-1 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white shadow-xs animate-in zoom-in-75">
            {pendingInvitationsCount}
          </span>
        )}
      </button>

      {/* Chrome Extension-Style Dropdown Box */}
      {isOpen && (
        <div
          ref={popoverRef}
          className="absolute right-0 top-11 z-50 w-88 md:w-96 rounded-2xl border border-gray-200/90 bg-white shadow-2xl overflow-hidden animate-in fade-in-0 zoom-in-95 duration-150"
        >
          {/* Popover Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50/70">
            <div className="flex items-center space-x-2">
              <div className="w-7 h-7 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600 font-semibold">
                <Inbox size={15} />
              </div>
              <div>
                <h3 className="text-xs font-bold text-gray-800 flex items-center gap-1.5">
                  <span>Project Invitations</span>
                  {pendingInvitationsCount > 0 && (
                    <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-blue-600 text-white">
                      {pendingInvitationsCount}
                    </span>
                  )}
                </h3>
                <p className="text-[10px] text-gray-400">Collaborate with your team</p>
              </div>
            </div>

            <div className="flex items-center space-x-1">
              <button
                type="button"
                onClick={() => refreshInvitations()}
                title="Refresh invitations"
                className="p-1 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors cursor-pointer"
              >
                <RotateCcw size={13} className={isLoadingInvitations ? 'animate-spin text-blue-600' : ''} />
              </button>

              <button
                type="button"
                onClick={() => setIsOpen(false)}
                title="Close"
                className="p-1 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {/* Sub Navigation Tabs */}
          <div className="flex border-b border-gray-100 px-3 pt-2 bg-white text-xs">
            <button
              onClick={() => setActiveTab('pending')}
              className={`pb-2 px-2.5 font-medium border-b-2 transition-all cursor-pointer ${
                activeTab === 'pending'
                  ? 'border-blue-600 text-blue-600 font-semibold'
                  : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              Pending ({pendingList.length})
            </button>
            <button
              onClick={() => setActiveTab('history')}
              className={`pb-2 px-2.5 font-medium border-b-2 transition-all cursor-pointer ${
                activeTab === 'history'
                  ? 'border-blue-600 text-blue-600 font-semibold'
                  : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              History ({historyList.length})
            </button>
          </div>

          {/* Popover Content */}
          <div className="max-h-[360px] overflow-y-auto p-3 space-y-2.5">
            {isLoadingInvitations && invitations.length === 0 ? (
              <div className="py-8 flex flex-col items-center justify-center text-gray-400">
                <Loader2 size={20} className="animate-spin text-blue-600 mb-2" />
                <span className="text-xs">Loading invitations...</span>
              </div>
            ) : activeTab === 'pending' ? (
              pendingList.length === 0 ? (
                <div className="py-8 text-center px-4">
                  <div className="w-10 h-10 mx-auto rounded-full bg-blue-50 text-blue-500 flex items-center justify-center mb-2">
                    <MailOpen size={18} />
                  </div>
                  <p className="text-xs font-semibold text-gray-700">No pending invitations</p>
                  <p className="text-[11px] text-gray-400 mt-0.5">
                    When someone invites you to a project, it will appear right here.
                  </p>
                </div>
              ) : (
                pendingList.map((inv) => {
                  const isResponding = respondingId === inv.id;
                  return (
                    <div
                      key={inv.id}
                      className="p-3 rounded-xl border border-gray-100 bg-white hover:border-blue-100 hover:bg-blue-50/20 shadow-2xs transition-all"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start space-x-2.5 min-w-0">
                          <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0 mt-0.5">
                            <Folder size={15} />
                          </div>
                          <div className="min-w-0">
                            <h4 className="text-xs font-bold text-gray-900 truncate">
                              {inv.project_name}
                            </h4>
                            <p className="text-[11px] text-gray-500 truncate">
                              Invited by{' '}
                              <span className="text-gray-700 font-medium">
                                {inv.invited_by_email || 'Project Admin'}
                              </span>
                            </p>
                          </div>
                        </div>

                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-700 uppercase tracking-wider shrink-0">
                          <Shield size={10} />
                          <span>{inv.role}</span>
                        </span>
                      </div>

                      {/* Action buttons */}
                      <div className="mt-3 flex items-center gap-2">
                        <button
                          type="button"
                          disabled={isResponding}
                          onClick={() => handleRespond(inv.id, true)}
                          className="flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 active:scale-98 disabled:opacity-60 transition-all shadow-xs cursor-pointer"
                        >
                          {isResponding ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : (
                            <>
                              <Check size={13} className="stroke-[2.5]" />
                              <span>Accept</span>
                            </>
                          )}
                        </button>

                        <button
                          type="button"
                          disabled={isResponding}
                          onClick={() => handleRespond(inv.id, false)}
                          className="inline-flex items-center justify-center gap-1 py-1.5 px-3 rounded-lg text-xs font-medium text-gray-600 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 active:scale-98 disabled:opacity-60 transition-all cursor-pointer"
                        >
                          <X size={13} />
                          <span>Decline</span>
                        </button>
                      </div>
                    </div>
                  );
                })
              )
            ) : historyList.length === 0 ? (
              <div className="py-8 text-center text-xs text-gray-400">
                No past invitation history.
              </div>
            ) : (
              historyList.map((inv) => (
                <div
                  key={inv.id}
                  className="p-2.5 rounded-xl border border-gray-100 bg-gray-50/50 flex items-center justify-between text-xs"
                >
                  <div className="min-w-0 pr-2">
                    <p className="font-semibold text-gray-800 truncate">{inv.project_name}</p>
                    <p className="text-[10px] text-gray-400 truncate">
                      {inv.invited_by_email || 'Invited to collaborate'}
                    </p>
                  </div>

                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-semibold capitalize shrink-0 ${
                      inv.status === 'accepted'
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60'
                        : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {inv.status}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
