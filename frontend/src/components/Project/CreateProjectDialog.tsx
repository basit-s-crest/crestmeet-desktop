'use client';

import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FolderPlus, Loader2 } from 'lucide-react';
import { useProject } from '@/contexts/ProjectContext';

interface CreateProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CreateProjectDialog: React.FC<CreateProjectDialogProps> = ({ isOpen, onClose }) => {
  const { createProject } = useProject();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    try {
      setIsSubmitting(true);
      await createProject(name.trim(), description.trim() || undefined);
      setName('');
      setDescription('');
      onClose();
    } catch (err) {
      // Error handled by toast in context
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[440px] bg-white rounded-2xl shadow-xl border border-slate-100 p-6">
        <DialogHeader className="space-y-2">
          <div className="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600 mb-1">
            <FolderPlus className="w-5 h-5" />
          </div>
          <DialogTitle className="text-lg font-semibold text-slate-900">
            Create New Project
          </DialogTitle>
          <p className="text-xs text-slate-500">
            Organize meetings, transcripts, and team members under a shared workspace.
          </p>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-700">Project Name *</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Mobile App Redesign, Q3 Planning"
              className="h-10 text-sm rounded-xl border-slate-200 focus-visible:ring-indigo-500 focus-visible:border-indigo-500"
              autoFocus
              required
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-700">Description (Optional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief summary of the project goals or team..."
              rows={3}
              className="w-full text-sm rounded-xl border border-slate-200 p-3 text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all resize-none"
            />
          </div>

          <DialogFooter className="pt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              className="rounded-xl border-slate-200 text-slate-700 hover:bg-slate-50 h-9 px-4 text-xs font-medium"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || isSubmitting}
              className="rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white h-9 px-4 text-xs font-medium shadow-sm transition-all"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Project'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
