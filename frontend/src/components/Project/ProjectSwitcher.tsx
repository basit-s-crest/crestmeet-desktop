'use client';

import React, { useState, useRef, useEffect } from 'react';
import {
  Folder,
  ChevronDown,
  Check,
  Plus,
  Users,
  Settings,
  ShieldCheck,
  Star,
  User,
  Sparkles,
} from 'lucide-react';
import { useProject } from '@/contexts/ProjectContext';
import { CreateProjectDialog } from './CreateProjectDialog';
import { ProjectMembersDialog } from './ProjectMembersDialog';
import { ProjectSettingsDialog } from './ProjectSettingsDialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface ProjectSwitcherProps {
  isCollapsed?: boolean;
}

export const ProjectSwitcher: React.FC<ProjectSwitcherProps> = ({ isCollapsed = false }) => {
  const { projects, activeProject, switchProject } = useProject();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Modals
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showMembersModal, setShowMembersModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelectProject = (projectId: string) => {
    switchProject(projectId);
    setIsOpen(false);
  };

  const getRoleIcon = (role?: string) => {
    switch (role) {
      case 'owner':
        return <ShieldCheck className="w-3 h-3 text-amber-500" />;
      case 'team_leader':
        return <Star className="w-3 h-3 text-indigo-500" />;
      default:
        return <User className="w-3 h-3 text-slate-400" />;
    }
  };

  if (isCollapsed) {
    return (
      <TooltipProvider>
        <div className="relative" ref={dropdownRef}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className={`p-2.5 rounded-xl transition-all duration-150 relative ${
                  isOpen
                    ? 'bg-indigo-50 text-indigo-700 shadow-xs'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
                aria-label="Switch Project"
              >
                <div className="w-5 h-5 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-[10px] uppercase">
                  {activeProject?.name.charAt(0) || 'P'}
                </div>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p className="font-medium text-xs">{activeProject?.name || 'Project'}</p>
              <p className="text-[10px] text-slate-400 capitalize">
                Role: {activeProject?.role.replace('_', ' ')}
              </p>
            </TooltipContent>
          </Tooltip>

          {/* Collapsed Dropdown Popover */}
          {isOpen && (
            <div className="absolute left-14 top-0 z-50 w-56 rounded-2xl bg-white shadow-xl border border-slate-100 py-1.5 animate-in fade-in-0 zoom-in-95">
              <div className="px-3 py-2 border-b border-slate-100">
                <p className="text-[10px] uppercase tracking-wider font-bold text-slate-400">
                  Projects
                </p>
              </div>

              <div className="max-h-52 overflow-y-auto py-1 custom-scrollbar">
                {projects.map((p) => {
                  const isActive = p.id === activeProject?.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => handleSelectProject(p.id)}
                      className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium transition-colors ${
                        isActive
                          ? 'bg-indigo-50 text-indigo-700 font-semibold'
                          : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate pr-2">
                        {getRoleIcon(p.role)}
                        <span className="truncate">{p.name}</span>
                      </div>
                      {isActive && <Check className="w-3.5 h-3.5 text-indigo-600 shrink-0" />}
                    </button>
                  );
                })}
              </div>

              <div className="pt-1 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => {
                    setIsOpen(false);
                    setShowCreateModal(true);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-indigo-600 font-medium hover:bg-indigo-50/70 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Create Project</span>
                </button>
              </div>
            </div>
          )}

          {/* Dialogs */}
          <CreateProjectDialog
            isOpen={showCreateModal}
            onClose={() => setShowCreateModal(false)}
          />
          <ProjectMembersDialog
            isOpen={showMembersModal}
            onClose={() => setShowMembersModal(false)}
          />
          <ProjectSettingsDialog
            isOpen={showSettingsModal}
            onClose={() => setShowSettingsModal(false)}
          />
        </div>
      </TooltipProvider>
    );
  }

  return (
    <div className="relative px-3 pt-2 pb-1" ref={dropdownRef}>
      {/* Switcher Trigger Button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-2 rounded-xl border border-slate-200/80 bg-slate-50/80 hover:bg-slate-100 hover:border-slate-300 transition-all text-left group shadow-2xs"
      >
        <div className="flex items-center gap-2.5 min-w-0 pr-1">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-indigo-500 to-indigo-600 text-white flex items-center justify-center font-bold text-xs shadow-xs shrink-0 uppercase">
            {activeProject?.name.charAt(0) || 'P'}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold text-slate-800 truncate block">
                {activeProject?.name || 'Personal Project'}
              </span>
            </div>
            <span className="text-[10px] text-slate-400 capitalize block truncate">
              {activeProject?.role.replace('_', ' ') || 'owner'} • {activeProject?.meeting_count ?? 0} meetings
            </span>
          </div>
        </div>

        <ChevronDown
          className={`w-3.5 h-3.5 text-slate-400 group-hover:text-slate-600 transition-transform shrink-0 ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>

      {/* Expanded Dropdown Menu */}
      {isOpen && (
        <div className="absolute left-3 right-3 top-full mt-1.5 z-50 rounded-2xl bg-white shadow-xl border border-slate-100 py-1.5 animate-in fade-in-0 zoom-in-95">
          <div className="px-3 py-1.5 border-b border-slate-100 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider font-bold text-slate-400">
              Your Projects
            </span>
            <span className="text-[10px] text-slate-400 font-medium">
              {projects.length} available
            </span>
          </div>

          <div className="max-h-56 overflow-y-auto py-1 custom-scrollbar">
            {projects.map((p) => {
              const isActive = p.id === activeProject?.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleSelectProject(p.id)}
                  className={`w-full flex items-center justify-between px-3 py-2 text-xs transition-colors ${
                    isActive
                      ? 'bg-indigo-50 text-indigo-700 font-semibold'
                      : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate pr-2">
                    <div className="w-5 h-5 rounded-md bg-slate-100 flex items-center justify-center shrink-0">
                      {getRoleIcon(p.role)}
                    </div>
                    <div className="truncate text-left">
                      <p className="truncate text-xs font-medium leading-tight">{p.name}</p>
                      <p className="text-[10px] text-slate-400 font-normal leading-tight">
                        {p.member_count} {p.member_count === 1 ? 'member' : 'members'}
                      </p>
                    </div>
                  </div>
                  {isActive && <Check className="w-4 h-4 text-indigo-600 shrink-0" />}
                </button>
              );
            })}
          </div>

          {/* Quick Actions */}
          <div className="pt-1 border-t border-slate-100 space-y-0.5">
            {activeProject && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setIsOpen(false);
                    setShowMembersModal(true);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors font-medium"
                >
                  <Users className="w-3.5 h-3.5 text-slate-400" />
                  <span>Project Members</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setIsOpen(false);
                    setShowSettingsModal(true);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors font-medium"
                >
                  <Settings className="w-3.5 h-3.5 text-slate-400" />
                  <span>Project Settings</span>
                </button>
              </>
            )}

            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setShowCreateModal(true);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-indigo-600 font-semibold hover:bg-indigo-50/70 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Create New Project</span>
            </button>
          </div>
        </div>
      )}

      {/* Dialogs */}
      <CreateProjectDialog
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
      />
      <ProjectMembersDialog
        isOpen={showMembersModal}
        onClose={() => setShowMembersModal(false)}
      />
      <ProjectSettingsDialog
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
      />
    </div>
  );
};
