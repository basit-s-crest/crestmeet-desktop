// frontend/src/types/project.ts

export type ProjectRole = 'owner' | 'team_leader' | 'member';

export interface ProjectWithRole {
  id: string;
  name: string;
  description: string | null;
  is_personal: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  role: ProjectRole;
  member_count: number;
  meeting_count: number;
}

export interface ProjectMemberWithUser {
  project_id: string;
  user_id: string;
  email: string;
  role: ProjectRole;
  joined_at: string;
}

export interface ProjectInvitation {
  id: string;
  project_id: string;
  email: string;
  role: 'team_leader' | 'member';
  invited_by: string | null;
  status: 'pending' | 'accepted' | 'revoked';
  created_at: string;
  accepted_at: string | null;
}

export interface ProjectListResponse {
  active_project_id: string | null;
  projects: ProjectWithRole[];
}

export interface ProjectMembersResponse {
  members: ProjectMemberWithUser[];
  pending_invitations: ProjectInvitation[];
}
