'use client';

import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Folder,
  FolderPlus,
  Mic,
  ShieldCheck,
  Star,
  User,
  Check,
  NotebookPen,
} from 'lucide-react';
import { useProject } from '@/contexts/ProjectContext';
import { CreateProjectDialog } from './CreateProjectDialog';
import { ProjectRole } from '@/types/project';

interface SelectProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (projectId: string) => void;
}

export const SelectProjectDialog: React.FC<SelectProjectDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
}) => {
  const { projects, activeProject } = useProject();
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  // Set default selection to activeProject or first project
  useEffect(() => {
    if (activeProject) {
      setSelectedProjectId(activeProject.id);
    } else if (projects.length > 0) {
      const personal = projects.find((p) => p.is_personal) || projects[0];
      setSelectedProjectId(personal.id);
    }
  }, [activeProject, projects, isOpen]);

  const handleStart = () => {
    if (!selectedProjectId) return;
    onConfirm(selectedProjectId);
  };

  const renderRoleBadge = (role: ProjectRole) => {
    switch (role) {
      case 'owner':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
            <ShieldCheck className="w-3 h-3 text-amber-600" />
            Owner
          </span>
        );
      case 'team_leader':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-purple-50 text-purple-700 border border-purple-200">
            <Star className="w-3 h-3 text-purple-600" />
            Team Leader
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-700 border border-gray-200">
            <User className="w-3 h-3 text-gray-500" />
            Member
          </span>
        );
    }
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-[480px] bg-white rounded-2xl shadow-xl border border-gray-200 p-6">
          <DialogHeader className="space-y-1.5 pb-2">
            <div className="w-10 h-10 rounded-xl bg-red-50 border border-red-100 flex items-center justify-center text-red-600 mb-1">
              <Mic className="w-5 h-5" />
            </div>
            <DialogTitle className="text-lg font-semibold text-gray-900">
              Select Project for Recording
            </DialogTitle>
            <p className="text-xs text-gray-500">
              Choose the project where this meeting, transcript, and summary will be saved.
            </p>
          </DialogHeader>

          {/* Project Selection List */}
          <div className="py-2">
            <div className="max-h-[260px] overflow-y-auto space-y-2 pr-1 custom-scrollbar">
              {projects.map((project) => {
                const isSelected = selectedProjectId === project.id;
                return (
                  <div
                    key={project.id}
                    onClick={() => setSelectedProjectId(project.id)}
                    className={`flex items-center justify-between p-3.5 rounded-xl border transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-blue-50/70 border-blue-500/80 shadow-xs'
                        : 'bg-white border-gray-200 hover:border-gray-300 hover:bg-gray-50/60'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
                          isSelected
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        <Folder className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-gray-900 truncate">
                            {project.name}
                          </span>
                          {project.is_personal && (
                            <span className="px-2 py-0.2 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-700">
                              Personal
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
                          <span className="flex items-center gap-1">
                            <NotebookPen className="w-3 h-3 text-gray-400" />
                            {project.meeting_count} calls
                          </span>
                          <span>•</span>
                          <span>{project.role}</span>
                        </div>
                      </div>
                    </div>

                    <div className="shrink-0 pl-2">
                      <div
                        className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${
                          isSelected
                            ? 'bg-blue-600 border-blue-600 text-white'
                            : 'border-gray-300 bg-white'
                        }`}
                      >
                        {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Quick create new project trigger */}
            <button
              type="button"
              onClick={() => setIsCreateOpen(true)}
              className="mt-3 w-full flex items-center justify-center gap-2 p-2.5 rounded-xl border border-dashed border-gray-300 hover:border-blue-400 hover:bg-blue-50/20 text-xs font-semibold text-gray-700 transition-all cursor-pointer"
            >
              <FolderPlus className="w-4 h-4 text-gray-500" />
              <span>Create New Project</span>
            </button>
          </div>

          <DialogFooter className="pt-3 border-t border-gray-100 flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              className="rounded-lg border-gray-300 text-gray-700 hover:bg-gray-100 text-xs font-medium h-9 px-4"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleStart}
              disabled={!selectedProjectId}
              className="rounded-lg bg-red-500 hover:bg-red-600 text-white text-xs font-medium h-9 px-4 flex items-center gap-1.5 shadow-sm transition-colors"
            >
              <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
              <Mic className="w-3.5 h-3.5" />
              <span>Start Recording</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Nested Create Project Dialog */}
      <CreateProjectDialog
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
      />
    </>
  );
};
