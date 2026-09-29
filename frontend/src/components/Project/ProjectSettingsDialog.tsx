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
import { Input } from '@/components/ui/input';
import { Settings, Trash2, AlertTriangle, Loader2 } from 'lucide-react';
import { useProject } from '@/contexts/ProjectContext';
import { toast } from 'sonner';

interface ProjectSettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ProjectSettingsDialog: React.FC<ProjectSettingsDialogProps> = ({
  isOpen,
  onClose,
}) => {
  const { activeProject, updateProject, deleteProject } = useProject();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (activeProject) {
      setName(activeProject.name);
      setDescription(activeProject.description || '');
    }
  }, [activeProject, isOpen]);

  const canEdit = activeProject?.role === 'owner' || activeProject?.role === 'team_leader';
  const isOwner = activeProject?.role === 'owner';
  const isPersonal = activeProject?.is_personal ?? false;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProject || !name.trim()) return;

    try {
      setIsSaving(true);
      await updateProject(activeProject.id, name.trim(), description.trim() || undefined);
      onClose();
    } catch (err) {
      // toast shown by context
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!activeProject || isPersonal) return;
    const confirm = window.confirm(
      `Are you sure you want to permanently delete "${activeProject.name}"? All associated meetings and transcripts will be removed.`
    );
    if (!confirm) return;

    try {
      setIsDeleting(true);
      const success = await deleteProject(activeProject.id);
      if (success) {
        onClose();
      }
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[460px] bg-white rounded-2xl shadow-xl border border-slate-100 p-6">
        <DialogHeader className="space-y-2">
          <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-slate-700">
            <Settings className="w-5 h-5" />
          </div>
          <DialogTitle className="text-lg font-semibold text-slate-900">
            Project Settings
          </DialogTitle>
          <p className="text-xs text-slate-500">
            Configure settings and preferences for {activeProject?.name}.
          </p>
        </DialogHeader>

        <form onSubmit={handleSave} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-700">Project Name *</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canEdit}
              className="h-10 text-sm rounded-xl border-slate-200 focus-visible:ring-indigo-500"
              required
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-700">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={!canEdit}
              placeholder="What is this project about?"
              rows={3}
              className="w-full text-sm rounded-xl border border-slate-200 p-3 text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all resize-none disabled:bg-slate-50 disabled:text-slate-400"
            />
          </div>

          {canEdit && (
            <div className="flex justify-end pt-1">
              <Button
                type="submit"
                disabled={isSaving || !name.trim()}
                className="rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white h-9 px-4 text-xs font-medium shadow-sm transition-all"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Save Changes'
                )}
              </Button>
            </div>
          )}
        </form>

        {/* Danger Zone: Delete Project */}
        {isOwner && !isPersonal && (
          <div className="mt-4 pt-4 border-t border-slate-100">
            <div className="flex items-center justify-between p-3 rounded-xl bg-red-50/60 border border-red-100">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                <div>
                  <p className="text-xs font-semibold text-red-900">Delete Project</p>
                  <p className="text-[11px] text-red-600">
                    Permanently delete this project and all its data.
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={isDeleting}
                className="h-8 px-3 rounded-lg text-xs bg-red-600 hover:bg-red-700 shrink-0 font-medium"
              >
                {isDeleting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
