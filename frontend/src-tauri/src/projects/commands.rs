// src/projects/commands.rs

use crate::database::models::{ProjectInvitation, ProjectMemberWithUser, ProjectWithRole};
use crate::database::repositories::project::ProjectsRepository;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use tauri::State;
use tracing::{error, info};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectListResponse {
    pub active_project_id: Option<String>,
    pub projects: Vec<ProjectWithRole>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectMembersResponse {
    pub members: Vec<ProjectMemberWithUser>,
    pub pending_invitations: Vec<ProjectInvitation>,
}

/// Helper: resolve the current authenticated user ID from AppState
async fn get_authenticated_user(state: &AppState) -> Result<Uuid, String> {
    let current = *state.current_user_id.read().await;
    current.ok_or_else(|| "User not authenticated. Please log in first.".to_string())
}

/// List all projects accessible by the authenticated user
#[tauri::command]
pub async fn api_project_list(
    state: State<'_, AppState>,
) -> Result<ProjectListResponse, String> {
    let user_id = get_authenticated_user(&state).await?;
    let pool = state.db_manager.pool();

    let projects = ProjectsRepository::get_user_projects(pool, user_id)
        .await
        .map_err(|e| {
            error!("Failed to fetch user projects: {}", e);
            e.to_string()
        })?;

    // Check or initialize active_project_id
    let mut active_lock = state.active_project_id.write().await;
    if active_lock.is_none() {
        if let Some(first) = projects.iter().find(|p| !p.is_archived) {
            if let Ok(pid) = Uuid::from_str(&first.id) {
                *active_lock = Some(pid);
            }
        }
    }

    let active_str = active_lock.map(|u| u.to_string());

    Ok(ProjectListResponse {
        active_project_id: active_str,
        projects,
    })
}

/// Get currently active project
#[tauri::command]
pub async fn api_project_get_active(
    state: State<'_, AppState>,
) -> Result<Option<ProjectWithRole>, String> {
    let user_id = get_authenticated_user(&state).await?;
    let pool = state.db_manager.pool();
    let projects = ProjectsRepository::get_user_projects(pool, user_id)
        .await
        .map_err(|e| e.to_string())?;

    let active_id = {
        let active_lock = state.active_project_id.read().await;
        active_lock.map(|u| u.to_string())
    };

    if let Some(ref aid) = active_id {
        if let Some(found) = projects.iter().find(|p| &p.id == aid) {
            return Ok(Some(found.clone()));
        }
    }

    // Default to first active project if found
    Ok(projects.into_iter().find(|p| !p.is_archived))
}

/// Set active project ID
#[tauri::command]
pub async fn api_project_set_active(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<bool, String> {
    let user_id = get_authenticated_user(&state).await?;
    let pid = Uuid::from_str(&project_id).map_err(|_| "Invalid project ID format".to_string())?;
    let pool = state.db_manager.pool();

    // Verify membership
    let role = ProjectsRepository::get_user_role(pool, pid, user_id)
        .await
        .map_err(|e| e.to_string())?;

    if role.is_none() {
        return Err("You are not a member of this project".to_string());
    }

    let mut active = state.active_project_id.write().await;
    *active = Some(pid);
    info!("Switched active project to {}", pid);

    Ok(true)
}

/// Create a new project
#[tauri::command]
pub async fn api_project_create(
    state: State<'_, AppState>,
    name: String,
    description: Option<String>,
) -> Result<ProjectWithRole, String> {
    let user_id = get_authenticated_user(&state).await?;
    let pool = state.db_manager.pool();

    let project = ProjectsRepository::create_project(
        pool,
        user_id,
        &name,
        description.as_deref(),
    )
    .await?;

    // Auto-switch active project to newly created project
    if let Ok(pid) = Uuid::from_str(&project.id) {
        let mut active = state.active_project_id.write().await;
        *active = Some(pid);
    }

    Ok(project)
}

/// Update project name / description
#[tauri::command]
pub async fn api_project_update(
    state: State<'_, AppState>,
    project_id: String,
    name: String,
    description: Option<String>,
) -> Result<ProjectWithRole, String> {
    let user_id = get_authenticated_user(&state).await?;
    let pid = Uuid::from_str(&project_id).map_err(|_| "Invalid project ID".to_string())?;
    let pool = state.db_manager.pool();

    ProjectsRepository::update_project(
        pool,
        user_id,
        pid,
        &name,
        description.as_deref(),
    )
    .await
}

/// Delete project (owner only)
#[tauri::command]
pub async fn api_project_delete(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<bool, String> {
    let user_id = get_authenticated_user(&state).await?;
    let pid = Uuid::from_str(&project_id).map_err(|_| "Invalid project ID".to_string())?;
    let pool = state.db_manager.pool();

    ProjectsRepository::delete_project(pool, user_id, pid).await?;

    // If deleted project was active, reset active project to Personal
    let mut active = state.active_project_id.write().await;
    if *active == Some(pid) {
        if let Ok(personal) = ProjectsRepository::get_or_create_personal_project(pool, user_id).await {
            *active = Some(personal.id);
        } else {
            *active = None;
        }
    }

    Ok(true)
}

/// Get members & pending invitations for a project
#[tauri::command]
pub async fn api_project_get_members(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<ProjectMembersResponse, String> {
    let user_id = get_authenticated_user(&state).await?;
    let pid = Uuid::from_str(&project_id).map_err(|_| "Invalid project ID".to_string())?;
    let pool = state.db_manager.pool();

    // Verify user is in project
    let role = ProjectsRepository::get_user_role(pool, pid, user_id)
        .await
        .map_err(|e| e.to_string())?;

    if role.is_none() {
        return Err("You are not a member of this project".to_string());
    }

    let members = ProjectsRepository::get_project_members(pool, pid)
        .await
        .map_err(|e| e.to_string())?;

    let pending_invitations = ProjectsRepository::get_pending_invitations(pool, pid)
        .await
        .map_err(|e| e.to_string())?;

    Ok(ProjectMembersResponse {
        members,
        pending_invitations,
    })
}

/// Invite a member to the project
#[tauri::command]
pub async fn api_project_invite_member(
    state: State<'_, AppState>,
    project_id: String,
    email: String,
    role: String,
) -> Result<String, String> {
    let user_id = get_authenticated_user(&state).await?;
    let pid = Uuid::from_str(&project_id).map_err(|_| "Invalid project ID".to_string())?;
    let pool = state.db_manager.pool();

    ProjectsRepository::invite_member(pool, user_id, pid, &email, &role).await
}

/// Remove a member from the project
#[tauri::command]
pub async fn api_project_remove_member(
    state: State<'_, AppState>,
    project_id: String,
    target_user_id: String,
) -> Result<bool, String> {
    let caller_user_id = get_authenticated_user(&state).await?;
    let pid = Uuid::from_str(&project_id).map_err(|_| "Invalid project ID".to_string())?;
    let target_uid = Uuid::from_str(&target_user_id).map_err(|_| "Invalid target user ID".to_string())?;
    let pool = state.db_manager.pool();

    ProjectsRepository::remove_member(pool, caller_user_id, pid, target_uid)
        .await
        .map(|_| true)
}

/// Update member role
#[tauri::command]
pub async fn api_project_update_member_role(
    state: State<'_, AppState>,
    project_id: String,
    target_user_id: String,
    role: String,
) -> Result<bool, String> {
    let caller_user_id = get_authenticated_user(&state).await?;
    let pid = Uuid::from_str(&project_id).map_err(|_| "Invalid project ID".to_string())?;
    let target_uid = Uuid::from_str(&target_user_id).map_err(|_| "Invalid target user ID".to_string())?;
    let pool = state.db_manager.pool();

    ProjectsRepository::update_member_role(pool, caller_user_id, pid, target_uid, &role)
        .await
        .map(|_| true)
}

/// Revoke a pending invitation
#[tauri::command]
pub async fn api_project_revoke_invitation(
    state: State<'_, AppState>,
    project_id: String,
    invitation_id: String,
) -> Result<bool, String> {
    let caller_user_id = get_authenticated_user(&state).await?;
    let pid = Uuid::from_str(&project_id).map_err(|_| "Invalid project ID".to_string())?;
    let inv_id = Uuid::from_str(&invitation_id).map_err(|_| "Invalid invitation ID".to_string())?;
    let pool = state.db_manager.pool();

    ProjectsRepository::revoke_invitation(pool, caller_user_id, pid, inv_id)
        .await
        .map(|_| true)
}

/// Archive or unarchive a project
#[tauri::command]
pub async fn api_project_archive(
    state: State<'_, AppState>,
    project_id: String,
    archive: bool,
) -> Result<bool, String> {
    let user_id = get_authenticated_user(&state).await?;
    let pid = Uuid::from_str(&project_id).map_err(|_| "Invalid project ID".to_string())?;
    let pool = state.db_manager.pool();

    ProjectsRepository::archive_project(pool, user_id, pid, archive).await
}

