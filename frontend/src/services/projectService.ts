// frontend/src/services/projectService.ts

import { invoke } from '@tauri-apps/api/core';
import {
  ProjectListResponse,
  ProjectWithRole,
  ProjectMembersResponse,
} from '@/types/project';

export class ProjectService {
  async listProjects(): Promise<ProjectListResponse> {
    return invoke<ProjectListResponse>('api_project_list');
  }

  async getActiveProject(): Promise<ProjectWithRole | null> {
    return invoke<ProjectWithRole | null>('api_project_get_active');
  }

  async setActiveProject(projectId: string): Promise<boolean> {
    return invoke<boolean>('api_project_set_active', { projectId });
  }

  async createProject(name: string, description?: string): Promise<ProjectWithRole> {
    return invoke<ProjectWithRole>('api_project_create', {
      name,
      description: description || null,
    });
  }

  async updateProject(
    projectId: string,
    name: string,
    description?: string
  ): Promise<ProjectWithRole> {
    return invoke<ProjectWithRole>('api_project_update', {
      projectId,
      name,
      description: description || null,
    });
  }

  async deleteProject(projectId: string): Promise<boolean> {
    return invoke<boolean>('api_project_delete', { projectId });
  }

  async archiveProject(projectId: string, archive: boolean = true): Promise<boolean> {
    return invoke<boolean>('api_project_archive', { projectId, archive });
  }

  async getMembers(projectId: string): Promise<ProjectMembersResponse> {
    return invoke<ProjectMembersResponse>('api_project_get_members', { projectId });
  }

  async inviteMember(
    projectId: string,
    email: string,
    role: string
  ): Promise<string> {
    return invoke<string>('api_project_invite_member', {
      projectId,
      email,
      role,
    });
  }

  async removeMember(
    projectId: string,
    targetUserId: string
  ): Promise<boolean> {
    return invoke<boolean>('api_project_remove_member', {
      projectId,
      targetUserId,
    });
  }

  async updateMemberRole(
    projectId: string,
    targetUserId: string,
    role: string
  ): Promise<boolean> {
    return invoke<boolean>('api_project_update_member_role', {
      projectId,
      targetUserId,
      role,
    });
  }

  async revokeInvitation(
    projectId: string,
    invitationId: string
  ): Promise<boolean> {
    return invoke<boolean>('api_project_revoke_invitation', {
      projectId,
      invitationId,
    });
  }
}

export const projectService = new ProjectService();
