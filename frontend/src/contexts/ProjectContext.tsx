import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { ProjectWithRole, UserProjectInvitation } from '@/types/project';
import { projectService } from '@/services/projectService';
import { invitationService } from '@/services/invitationService';
import { useAuth } from './AuthContext';
import { toast } from 'sonner';

interface ProjectContextType {
  projects: ProjectWithRole[];
  activeProject: ProjectWithRole | null;
  isLoading: boolean;
  refreshProjects: () => Promise<void>;
  switchProject: (projectId: string) => Promise<boolean>;
  createProject: (name: string, description?: string) => Promise<ProjectWithRole>;
  updateProject: (projectId: string, name: string, description?: string) => Promise<ProjectWithRole>;
  deleteProject: (projectId: string) => Promise<boolean>;
  archiveProject: (projectId: string, archive?: boolean) => Promise<boolean>;
  // Inbox Invitations
  invitations: UserProjectInvitation[];
  pendingInvitationsCount: number;
  isLoadingInvitations: boolean;
  refreshInvitations: () => Promise<void>;
  respondToInvitation: (invitationId: string, accept: boolean) => Promise<boolean>;
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

export const ProjectProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const [projects, setProjects] = useState<ProjectWithRole[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectWithRole | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [invitations, setInvitations] = useState<UserProjectInvitation[]>([]);
  const [isLoadingInvitations, setIsLoadingInvitations] = useState(false);

  const refreshProjects = useCallback(async () => {
    if (!user) {
      setProjects([]);
      setActiveProject(null);
      return;
    }

    try {
      setIsLoading(true);
      const res = await projectService.listProjects();
      setProjects(res.projects);

      if (res.active_project_id) {
        const found = res.projects.find(p => p.id === res.active_project_id);
        setActiveProject(found || res.projects[0] || null);
      } else if (res.projects.length > 0) {
        const fallback = res.projects.find(p => !p.is_archived) || res.projects[0] || null;
        setActiveProject(fallback);
      } else {
        setActiveProject(null);
      }
    } catch (err: any) {
      console.error('[ProjectContext] Failed to load projects:', err);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  const switchProject = async (projectId: string): Promise<boolean> => {
    try {
      await projectService.setActiveProject(projectId);
      const target = projects.find(p => p.id === projectId);
      if (target) {
        setActiveProject(target);
      } else {
        await refreshProjects();
      }
      toast.success(`Switched to ${target?.name || 'project'}`);
      return true;
    } catch (err: any) {
      console.error('[ProjectContext] Switch project error:', err);
      toast.error(typeof err === 'string' ? err : 'Failed to switch project');
      return false;
    }
  };

  const createProject = async (name: string, description?: string): Promise<ProjectWithRole> => {
    try {
      const created = await projectService.createProject(name, description);
      await refreshProjects();
      setActiveProject(created);
      toast.success(`Project "${created.name}" created`);
      return created;
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : 'Failed to create project';
      toast.error(msg);
      throw new Error(msg);
    }
  };

  const updateProject = async (
    projectId: string,
    name: string,
    description?: string
  ): Promise<ProjectWithRole> => {
    try {
      const updated = await projectService.updateProject(projectId, name, description);
      await refreshProjects();
      toast.success(`Project settings updated`);
      return updated;
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : 'Failed to update project';
      toast.error(msg);
      throw new Error(msg);
    }
  };

  const deleteProject = async (projectId: string): Promise<boolean> => {
    try {
      await projectService.deleteProject(projectId);
      await refreshProjects();
      toast.success('Project deleted');
      return true;
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : 'Failed to delete project';
      toast.error(msg);
      return false;
    }
  };

  const archiveProject = async (projectId: string, archive: boolean = true): Promise<boolean> => {
    try {
      await projectService.archiveProject(projectId, archive);
      await refreshProjects();
      toast.success(archive ? 'Project archived' : 'Project restored');
      return true;
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : 'Failed to archive project';
      toast.error(msg);
      return false;
    }
  };

  const refreshInvitations = useCallback(async () => {
    if (!user) {
      setInvitations([]);
      return;
    }
    try {
      setIsLoadingInvitations(true);
      const list = await invitationService.getMyInvitations();
      setInvitations(list);
    } catch (err) {
      console.error('[ProjectContext] Failed to load invitations:', err);
    } finally {
      setIsLoadingInvitations(false);
    }
  }, [user]);

  useEffect(() => {
    refreshInvitations();
  }, [refreshInvitations]);

  const respondToInvitation = async (invitationId: string, accept: boolean): Promise<boolean> => {
    try {
      const targetInv = invitations.find((inv) => inv.id === invitationId);
      const msg = await invitationService.respondToInvitation(invitationId, accept);
      toast.success(msg);
      await Promise.all([refreshInvitations(), refreshProjects()]);

      // Automatically switch active project to the newly accepted project so user immediately sees all meetings
      if (accept && targetInv?.project_id) {
        await switchProject(targetInv.project_id);
      }

      return true;
    } catch (err: any) {
      console.error('[ProjectContext] Respond to invitation error:', err);
      toast.error(typeof err === 'string' ? err : 'Failed to respond to invitation');
      return false;
    }
  };

  const pendingInvitationsCount = invitations.filter(inv => inv.status === 'pending').length;

  return (
    <ProjectContext.Provider
      value={{
        projects,
        activeProject,
        isLoading,
        refreshProjects,
        switchProject,
        createProject,
        updateProject,
        deleteProject,
        archiveProject,
        invitations,
        pendingInvitationsCount,
        isLoadingInvitations,
        refreshInvitations,
        respondToInvitation,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
};

export const useProject = (): ProjectContextType => {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useProject must be used within a ProjectProvider');
  }
  return context;
};
