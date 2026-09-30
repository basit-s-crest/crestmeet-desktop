'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Users,
  UserPlus,
  ShieldCheck,
  Star,
  User,
  Trash2,
  Mail,
  Clock,
  Loader2,
  XCircle,
} from 'lucide-react';
import { useProject } from '@/contexts/ProjectContext';
import { projectService } from '@/services/projectService';
import { ProjectMemberWithUser, ProjectInvitation, ProjectRole, ProjectWithRole } from '@/types/project';
import { toast } from 'sonner';

interface ProjectMembersDialogProps {
  isOpen: boolean;
  onClose: () => void;
  project?: ProjectWithRole | null;
}

export const ProjectMembersDialog: React.FC<ProjectMembersDialogProps> = ({
  isOpen,
  onClose,
  project,
}) => {
  const { activeProject, refreshProjects } = useProject();
  const currentProject = project || activeProject;
  const [members, setMembers] = useState<ProjectMemberWithUser[]>([]);
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'team_leader' | 'member'>('member');
  const [isInviting, setIsInviting] = useState(false);

  const fetchMembers = useCallback(async () => {
    if (!currentProject) return;
    try {
      setIsLoading(true);
      const res = await projectService.getMembers(currentProject.id);
      setMembers(res.members);
      setInvitations(res.pending_invitations);
    } catch (err: any) {
      toast.error(typeof err === 'string' ? err : 'Failed to load project members');
    } finally {
      setIsLoading(false);
    }
  }, [currentProject]);

  useEffect(() => {
    if (isOpen) {
      fetchMembers();
    }
  }, [isOpen, fetchMembers]);

  const canManage = currentProject?.role === 'owner' || currentProject?.role === 'team_leader';
  const isOwner = currentProject?.role === 'owner';

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentProject || !inviteEmail.trim()) return;

    try {
      setIsInviting(true);
      const msg = await projectService.inviteMember(
        currentProject.id,
        inviteEmail.trim(),
        inviteRole
      );
      toast.success(msg);
      setInviteEmail('');
      setInviteRole('member');
      await fetchMembers();
      await refreshProjects();
    } catch (err: any) {
      toast.error(typeof err === 'string' ? err : 'Failed to invite member');
    } finally {
      setIsInviting(false);
    }
  };

  const handleRemoveMember = async (targetUserId: string, email: string) => {
    if (!currentProject) return;
    const confirm = window.confirm(`Remove ${email} from this project?`);
    if (!confirm) return;

    try {
      await projectService.removeMember(currentProject.id, targetUserId);
      toast.success(`Removed ${email}`);
      await fetchMembers();
      await refreshProjects();
    } catch (err: any) {
      toast.error(typeof err === 'string' ? err : 'Failed to remove member');
    }
  };

  const handleRoleChange = async (targetUserId: string, newRole: string) => {
    if (!currentProject) return;
    try {
      await projectService.updateMemberRole(currentProject.id, targetUserId, newRole);
      toast.success('Member role updated');
      await fetchMembers();
    } catch (err: any) {
      toast.error(typeof err === 'string' ? err : 'Failed to update role');
    }
  };

  const handleRevokeInvitation = async (invitationId: string) => {
    if (!currentProject) return;
    try {
      await projectService.revokeInvitation(currentProject.id, invitationId);
      toast.success('Invitation revoked');
      await fetchMembers();
    } catch (err: any) {
      toast.error(typeof err === 'string' ? err : 'Failed to revoke invitation');
    }
  };

  const renderRoleBadge = (role: ProjectRole) => {
    switch (role) {
      case 'owner':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700 border border-amber-200/70">
            <ShieldCheck className="w-3 h-3 text-amber-600" />
            Project Owner
          </span>
        );
      case 'team_leader':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200/70">
            <Star className="w-3 h-3 text-indigo-600" />
            Team Leader
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-600 border border-slate-200/70">
            <User className="w-3 h-3 text-slate-500" />
            Member
          </span>
        );
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[540px] max-h-[85vh] overflow-y-auto bg-white rounded-2xl shadow-xl border border-slate-100 p-6 custom-scrollbar">
        <DialogHeader className="space-y-1 pb-2 border-b border-slate-100">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600">
                <Users className="w-4 h-4" />
              </div>
              <div>
                <DialogTitle className="text-base font-semibold text-slate-900">
                  {currentProject?.name || 'Project'} Members
                </DialogTitle>
                <p className="text-xs text-slate-500">
                  Manage access and collaborate with team members
                </p>
              </div>
            </div>
            {currentProject && renderRoleBadge(currentProject.role)}
          </div>
        </DialogHeader>

        {/* Invite New Member Section */}
        {canManage && (
          <form onSubmit={handleInvite} className="pt-3 pb-4 border-b border-slate-100 space-y-2.5">
            <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
              <UserPlus className="w-3.5 h-3.5 text-indigo-600" />
              Invite Team Member
            </label>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Mail className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="colleague@company.com"
                  className="pl-8 text-xs h-9 rounded-xl border-slate-200 focus-visible:ring-indigo-500"
                  required
                />
              </div>

              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'team_leader' | 'member')}
                className="h-9 px-2.5 text-xs rounded-xl border border-slate-200 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-medium"
              >
                <option value="member">Member</option>
                <option value="team_leader">Team Leader</option>
              </select>

              <Button
                type="submit"
                disabled={!inviteEmail.trim() || isInviting}
                className="h-9 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium shrink-0"
              >
                {isInviting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  'Invite'
                )}
              </Button>
            </div>
          </form>
        )}

        {/* Active Members List */}
        <div className="space-y-3 pt-3">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-600 px-1">
            <span>Members ({members.length})</span>
            {isLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
          </div>

          <div className="space-y-2">
            {members.map((member) => (
              <div
                key={member.user_id}
                className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50/70 border border-slate-100 hover:border-slate-200 transition-all"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-500 text-white flex items-center justify-center font-bold text-xs uppercase shrink-0 shadow-xs">
                    {member.email.charAt(0)}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-slate-900 truncate">
                      {member.email}
                    </p>
                    <p className="text-[10px] text-slate-400 flex items-center gap-1">
                      Joined {new Date(member.joined_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {isOwner && member.role !== 'owner' ? (
                    <select
                      value={member.role}
                      onChange={(e) => handleRoleChange(member.user_id, e.target.value)}
                      className="text-[11px] font-semibold rounded-lg border border-slate-200 bg-white px-2 py-0.5 text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    >
                      <option value="member">Member</option>
                      <option value="team_leader">Team Leader</option>
                    </select>
                  ) : (
                    renderRoleBadge(member.role)
                  )}

                  {canManage && member.role !== 'owner' && (
                    <button
                      type="button"
                      onClick={() => handleRemoveMember(member.user_id, member.email)}
                      className="p-1 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                      title="Remove member"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Pending Invitations Section */}
        {invitations.length > 0 && (
          <div className="space-y-2 pt-3 border-t border-slate-100">
            <p className="text-xs font-semibold text-slate-600 px-1 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-amber-500" />
              Pending Invitations ({invitations.length})
            </p>
            <div className="space-y-1.5">
              {invitations.map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between p-2 rounded-xl bg-amber-50/40 border border-amber-100/70 text-xs"
                >
                  <div className="min-w-0 pr-2">
                    <p className="font-medium text-slate-800 truncate">{inv.email}</p>
                    <p className="text-[10px] text-slate-500 capitalize">
                      Role: {inv.role.replace('_', ' ')} • Sent {new Date(inv.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => handleRevokeInvitation(inv.id)}
                      className="p-1 rounded-lg text-slate-400 hover:text-red-600 hover:bg-white transition-colors"
                      title="Revoke invitation"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
