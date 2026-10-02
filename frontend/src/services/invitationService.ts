import { invoke } from '@tauri-apps/api/core';
import { UserProjectInvitation } from '@/types/project';

export class InvitationService {
  /**
   * Fetch all invitations sent to the currently authenticated user's email
   */
  async getMyInvitations(): Promise<UserProjectInvitation[]> {
    return invoke<UserProjectInvitation[]>('api_get_my_invitations');
  }

  /**
   * Accept or decline a project invitation
   */
  async respondToInvitation(invitationId: string, accept: boolean): Promise<string> {
    return invoke<string>('api_respond_to_invitation', {
      invitationId,
      accept,
    });
  }
}

export const invitationService = new InvitationService();
