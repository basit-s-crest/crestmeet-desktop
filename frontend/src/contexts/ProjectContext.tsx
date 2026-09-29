// frontend/src/contexts/ProjectContext.tsx
'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { ProjectWithRole } from '@/types/project';
import { projectService } from '@/services/projectService';
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
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

export const ProjectProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const [projects, setProjects] = useState<ProjectWithRole[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectWithRole | null>(null);
  const [isLoading, setIsLoading] = useState(false);

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
        // Default to personal or first project
        const personal = res.projects.find(p => p.is_personal) || res.projects[0];
        setActiveProject(personal);
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
