// src/database/repositories/project.rs

use crate::database::models::{
    Project, ProjectInvitation, ProjectMemberWithUser, ProjectWithRole,
};
use chrono::Utc;
use sqlx::{Error as SqlxError, PgPool};
use tracing::{error, info};
use uuid::Uuid;

pub struct ProjectsRepository;

impl ProjectsRepository {
    /// Get or create the user's default Personal project
    pub async fn get_or_create_personal_project(
        pool: &PgPool,
        user_id: Uuid,
    ) -> Result<Project, SqlxError> {
        let existing = sqlx::query_as::<_, Project>(
            r#"
            SELECT id, name, description, is_personal, COALESCE(is_archived, false) as is_archived, created_by, created_at, updated_at
            FROM projects
            WHERE created_by = $1 AND is_personal = true
            LIMIT 1
            "#,
        )
        .bind(user_id)
        .fetch_optional(pool)
        .await?;

        if let Some(project) = existing {
            // Ensure owner membership exists
            let _ = sqlx::query(
                r#"
                INSERT INTO project_members (project_id, user_id, role)
                VALUES ($1, $2, 'owner')
                ON CONFLICT (project_id, user_id) DO NOTHING
                "#,
            )
            .bind(project.id)
            .bind(user_id)
            .execute(pool)
            .await;

            return Ok(project);
        }

        // Create new Personal project
        let mut tx = pool.begin().await?;
        let project = sqlx::query_as::<_, Project>(
            r#"
            INSERT INTO projects (name, is_personal, created_by)
            VALUES ('Personal', true, $1)
            RETURNING id, name, description, is_personal, COALESCE(is_archived, false) as is_archived, created_by, created_at, updated_at
            "#,
        )
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO project_members (project_id, user_id, role)
            VALUES ($1, $2, 'owner')
            ON CONFLICT (project_id, user_id) DO NOTHING
            "#,
        )
        .bind(project.id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        info!("Created personal project {} for user {}", project.id, user_id);
        Ok(project)
    }

    /// List all projects where user is a member, ordered by updated_at DESC
    pub async fn get_user_projects(
        pool: &PgPool,
        user_id: Uuid,
    ) -> Result<Vec<ProjectWithRole>, SqlxError> {
        let rows = sqlx::query_as::<_, (Uuid, String, Option<String>, bool, bool, Option<Uuid>, chrono::DateTime<Utc>, chrono::DateTime<Utc>, String, i64, i64)>(
            r#"
            SELECT 
                p.id,
                p.name,
                p.description,
                p.is_personal,
                COALESCE(p.is_archived, false) as is_archived,
                p.created_by,
                p.created_at,
                p.updated_at,
                pm.role,
                (SELECT COUNT(*)::bigint FROM project_members WHERE project_id = p.id) AS member_count,
                (SELECT COUNT(*)::bigint FROM meetings WHERE project_id = p.id) AS meeting_count
            FROM projects p
            JOIN project_members pm ON p.id = pm.project_id
            WHERE pm.user_id = $1
            ORDER BY p.updated_at DESC
            "#
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?;

        let result = rows
            .into_iter()
            .map(|(id, name, description, is_personal, is_archived, created_by, created_at, updated_at, role, member_count, meeting_count)| {
                ProjectWithRole {
                    id: id.to_string(),
                    name,
                    description,
                    is_personal,
                    is_archived,
                    created_by: created_by.map(|u| u.to_string()),
                    created_at: created_at.to_rfc3339(),
                    updated_at: updated_at.to_rfc3339(),
                    role,
                    member_count,
                    meeting_count,
                }
            })
            .collect();

        Ok(result)
    }

    /// Get user's role in a project (owner, team_leader, member, or None)
    pub async fn get_user_role(
        pool: &PgPool,
        project_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<String>, SqlxError> {
        let row = sqlx::query_scalar::<_, String>(
            "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2",
        )
        .bind(project_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await?;

        Ok(row)
    }

    /// Create a new project (caller becomes owner)
    pub async fn create_project(
        pool: &PgPool,
        user_id: Uuid,
        name: &str,
        description: Option<&str>,
    ) -> Result<ProjectWithRole, String> {
        let clean_name = name.trim();
        if clean_name.is_empty() {
            return Err("Project name cannot be empty".to_string());
        }

        let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

        let project = sqlx::query_as::<_, Project>(
            r#"
            INSERT INTO projects (name, description, is_personal, created_by)
            VALUES ($1, $2, false, $3)
            RETURNING id, name, description, is_personal, COALESCE(is_archived, false) as is_archived, created_by, created_at, updated_at
            "#,
        )
        .bind(clean_name)
        .bind(description)
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| {
            error!("Failed to insert project: {}", e);
            e.to_string()
        })?;

        sqlx::query(
            r#"
            INSERT INTO project_members (project_id, user_id, role)
            VALUES ($1, $2, 'owner')
            "#,
        )
        .bind(project.id)
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| {
            error!("Failed to add project owner: {}", e);
            e.to_string()
        })?;

        tx.commit().await.map_err(|e| e.to_string())?;

        info!("Created project '{}' ({}) by user {}", clean_name, project.id, user_id);

        Ok(ProjectWithRole {
            id: project.id.to_string(),
            name: project.name,
            description: project.description,
            is_personal: project.is_personal,
            is_archived: false,
            created_by: project.created_by.map(|u| u.to_string()),
            created_at: project.created_at.to_rfc3339(),
            updated_at: project.updated_at.to_rfc3339(),
            role: "owner".to_string(),
            member_count: 1,
            meeting_count: 0,
        })
    }

    /// Update project name / description (owner or team_leader only)
    pub async fn update_project(
        pool: &PgPool,
        user_id: Uuid,
        project_id: Uuid,
        name: &str,
        description: Option<&str>,
    ) -> Result<ProjectWithRole, String> {
        let role = Self::get_user_role(pool, project_id, user_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "You are not a member of this project".to_string())?;

        if role != "owner" && role != "team_leader" {
            return Err("Only the project owner or team leader can edit project settings".to_string());
        }

        let clean_name = name.trim();
        if clean_name.is_empty() {
            return Err("Project name cannot be empty".to_string());
        }

        let updated = sqlx::query_as::<_, Project>(
            r#"
            UPDATE projects
            SET name = $1, description = $2, updated_at = NOW()
            WHERE id = $3
            RETURNING id, name, description, is_personal, COALESCE(is_archived, false) as is_archived, created_by, created_at, updated_at
            "#,
        )
        .bind(clean_name)
        .bind(description)
        .bind(project_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;

        let (member_count, meeting_count) = sqlx::query_as::<_, (i64, i64)>(
            r#"
            SELECT 
                (SELECT COUNT(*)::bigint FROM project_members WHERE project_id = $1),
                (SELECT COUNT(*)::bigint FROM meetings WHERE project_id = $1)
            "#,
        )
        .bind(project_id)
        .fetch_one(pool)
        .await
        .unwrap_or((1, 0));

        Ok(ProjectWithRole {
            id: updated.id.to_string(),
            name: updated.name,
            description: updated.description,
            is_personal: updated.is_personal,
            is_archived: updated.is_archived,
            created_by: updated.created_by.map(|u| u.to_string()),
            created_at: updated.created_at.to_rfc3339(),
            updated_at: updated.updated_at.to_rfc3339(),
            role,
            member_count,
            meeting_count,
        })
    }

    /// Archive or unarchive a project (owner or team_leader only; cannot archive is_personal project)
    pub async fn archive_project(
        pool: &PgPool,
        user_id: Uuid,
        project_id: Uuid,
        archive: bool,
    ) -> Result<bool, String> {
        let role = Self::get_user_role(pool, project_id, user_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "You are not a member of this project".to_string())?;

        if role != "owner" && role != "team_leader" {
            return Err("Only the project owner or team leader can archive this project".to_string());
        }

        sqlx::query("UPDATE projects SET is_archived = $1, updated_at = NOW() WHERE id = $2")
            .bind(archive)
            .bind(project_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;

        info!("Set is_archived = {} for project {} by user {}", archive, project_id, user_id);
        Ok(true)
    }

    /// Delete project (owner only)
    pub async fn delete_project(
        pool: &PgPool,
        user_id: Uuid,
        project_id: Uuid,
    ) -> Result<(), String> {
        let role = Self::get_user_role(pool, project_id, user_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "You are not a member of this project".to_string())?;

        if role != "owner" {
            return Err("Only the project owner can delete this project".to_string());
        }

        sqlx::query("DELETE FROM projects WHERE id = $1")
            .bind(project_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;

        info!("Deleted project {} by owner {}", project_id, user_id);
        Ok(())
    }

    /// Get all members of a project with their email and role
    pub async fn get_project_members(
        pool: &PgPool,
        project_id: Uuid,
    ) -> Result<Vec<ProjectMemberWithUser>, SqlxError> {
        let rows = sqlx::query_as::<_, (Uuid, Uuid, String, String, chrono::DateTime<Utc>)>(
            r#"
            SELECT 
                pm.project_id,
                pm.user_id,
                COALESCE(u.email, au.email, 'unknown@crestmeet.com') as email,
                pm.role,
                pm.joined_at
            FROM project_members pm
            LEFT JOIN app_users u ON pm.user_id = u.id
            LEFT JOIN auth.users au ON pm.user_id = au.id
            WHERE pm.project_id = $1
            ORDER BY 
                CASE pm.role WHEN 'owner' THEN 1 WHEN 'team_leader' THEN 2 ELSE 3 END,
                pm.joined_at ASC
            "#,
        )
        .bind(project_id)
        .fetch_all(pool)
        .await?;

        let result = rows
            .into_iter()
            .map(|(proj_id, usr_id, email, role, joined_at)| {
                ProjectMemberWithUser {
                    project_id: proj_id.to_string(),
                    user_id: usr_id.to_string(),
                    email,
                    role,
                    joined_at: joined_at.to_rfc3339(),
                }
            })
            .collect();

        Ok(result)
    }

    /// Invite a member to the project (by email)
    /// If user is already registered in DB, directly adds them to project_members.
    /// Otherwise creates a pending project_invitation.
    pub async fn invite_member(
        pool: &PgPool,
        caller_user_id: Uuid,
        project_id: Uuid,
        email: &str,
        role: &str,
    ) -> Result<String, String> {
        let caller_role = Self::get_user_role(pool, project_id, caller_user_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "You are not a member of this project".to_string())?;

        if caller_role != "owner" && caller_role != "team_leader" {
            return Err("Only the project owner or team leader can invite new members".to_string());
        }

        let clean_role = match role.to_lowercase().as_str() {
            "team_leader" | "team leader" => "team_leader",
            "member" => "member",
            _ => return Err("Invalid role. Role must be 'team_leader' or 'member'".to_string()),
        };

        let clean_email = email.trim().to_lowercase();
        if clean_email.is_empty() || !clean_email.contains('@') {
            return Err("Please provide a valid email address".to_string());
        }

        // Check if user with this email exists in app_users or auth.users
        let existing_user_id = sqlx::query_scalar::<_, Uuid>(
            r#"
            SELECT COALESCE(u.id, au.id)
            FROM app_users u
            FULL OUTER JOIN auth.users au ON LOWER(u.email) = LOWER(au.email)
            WHERE LOWER(COALESCE(u.email, au.email)) = $1
            LIMIT 1
            "#,
        )
        .bind(&clean_email)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;

        let existing_member = if let Some(target_uid) = existing_user_id {
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2)"
            )
            .bind(project_id)
            .bind(target_uid)
            .fetch_one(pool)
            .await
            .unwrap_or(false)
        } else {
            false
        };

        if existing_member {
            return Err(format!("{} is already a member of this project", clean_email));
        }

        let pending_exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM project_invitations WHERE project_id = $1 AND LOWER(email) = $2 AND status = 'pending')"
        )
        .bind(project_id)
        .bind(&clean_email)
        .fetch_one(pool)
        .await
        .unwrap_or(false);

        if pending_exists {
            return Err(format!("An invitation is already pending for {}", clean_email));
        }

        // Insert into project_invitations so user can accept/decline in their Inbox
        sqlx::query(
            r#"
            INSERT INTO project_invitations (project_id, email, role, invited_by, status)
            VALUES ($1, $2, $3, $4, 'pending')
            "#,
        )
        .bind(project_id)
        .bind(&clean_email)
        .bind(clean_role)
        .bind(caller_user_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

        info!("Created invitation for {} to project {}", clean_email, project_id);
        Ok(format!("Invitation sent to {}. It will appear in their Inbox.", clean_email))
    }

    /// Remove a member from the project
    pub async fn remove_member(
        pool: &PgPool,
        caller_user_id: Uuid,
        project_id: Uuid,
        target_user_id: Uuid,
    ) -> Result<(), String> {
        let caller_role = Self::get_user_role(pool, project_id, caller_user_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "You are not a member of this project".to_string())?;

        if caller_user_id == target_user_id {
            return Err("You cannot remove yourself using remove_member. Transfer ownership or leave project.".to_string());
        }

        let target_role = Self::get_user_role(pool, project_id, target_user_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Target user is not a member of this project".to_string())?;

        if target_role == "owner" {
            return Err("Project owner cannot be removed".to_string());
        }

        if caller_role == "team_leader" && target_role == "team_leader" {
            return Err("Team leaders cannot remove another team leader".to_string());
        }

        if caller_role != "owner" && caller_role != "team_leader" {
            return Err("You do not have permission to remove members".to_string());
        }

        sqlx::query(
            "DELETE FROM project_members WHERE project_id = $1 AND user_id = $2",
        )
        .bind(project_id)
        .bind(target_user_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

        info!("Removed member {} from project {} by caller {}", target_user_id, project_id, caller_user_id);
        Ok(())
    }

    /// Update a member's role (owner only)
    pub async fn update_member_role(
        pool: &PgPool,
        caller_user_id: Uuid,
        project_id: Uuid,
        target_user_id: Uuid,
        new_role: &str,
    ) -> Result<(), String> {
        let caller_role = Self::get_user_role(pool, project_id, caller_user_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "You are not a member of this project".to_string())?;

        if caller_role != "owner" {
            return Err("Only the project owner can change member roles".to_string());
        }

        if caller_user_id == target_user_id {
            return Err("Cannot change your own role here".to_string());
        }

        let clean_role = match new_role.to_lowercase().as_str() {
            "team_leader" | "team leader" => "team_leader",
            "member" => "member",
            _ => return Err("Invalid role. Role must be 'team_leader' or 'member'".to_string()),
        };

        sqlx::query(
            "UPDATE project_members SET role = $1 WHERE project_id = $2 AND user_id = $3",
        )
        .bind(clean_role)
        .bind(project_id)
        .bind(target_user_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

        info!("Updated member {} role to {} in project {}", target_user_id, clean_role, project_id);
        Ok(())
    }

    /// Get pending invitations for a project
    pub async fn get_pending_invitations(
        pool: &PgPool,
        project_id: Uuid,
    ) -> Result<Vec<ProjectInvitation>, SqlxError> {
        sqlx::query_as::<_, ProjectInvitation>(
            r#"
            SELECT id, project_id, email, role, invited_by, status, created_at, accepted_at
            FROM project_invitations
            WHERE project_id = $1 AND status = 'pending'
            ORDER BY created_at DESC
            "#,
        )
        .bind(project_id)
        .fetch_all(pool)
        .await
    }

    /// Revoke an invitation
    pub async fn revoke_invitation(
        pool: &PgPool,
        caller_user_id: Uuid,
        project_id: Uuid,
        invitation_id: Uuid,
    ) -> Result<(), String> {
        let caller_role = Self::get_user_role(pool, project_id, caller_user_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "You are not a member of this project".to_string())?;

        if caller_role != "owner" && caller_role != "team_leader" {
            return Err("Only project owner or team leader can revoke invitations".to_string());
        }

        sqlx::query(
            "UPDATE project_invitations SET status = 'revoked' WHERE id = $1 AND project_id = $2",
        )
        .bind(invitation_id)
        .bind(project_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    /// Get all invitations received by a specific user email
    pub async fn get_user_invitations(
        pool: &PgPool,
        user_email: &str,
    ) -> Result<Vec<crate::database::models::UserProjectInvitation>, SqlxError> {
        let clean_email = user_email.trim().to_lowercase();
        sqlx::query_as::<_, crate::database::models::UserProjectInvitation>(
            r#"
            SELECT 
                pi.id,
                pi.project_id,
                p.name AS project_name,
                p.description AS project_description,
                pi.role,
                pi.invited_by,
                u.email AS invited_by_email,
                pi.status,
                pi.created_at,
                pi.accepted_at
            FROM project_invitations pi
            JOIN projects p ON p.id = pi.project_id
            LEFT JOIN app_users u ON u.id = pi.invited_by
            WHERE LOWER(pi.email) = $1
            ORDER BY 
                CASE WHEN pi.status = 'pending' THEN 0 ELSE 1 END,
                pi.created_at DESC
            "#,
        )
        .bind(&clean_email)
        .fetch_all(pool)
        .await
    }

    /// Respond to an invitation (accept or decline)
    pub async fn respond_to_invitation(
        pool: &PgPool,
        user_id: Uuid,
        user_email: &str,
        invitation_id: Uuid,
        accept: bool,
    ) -> Result<String, String> {
        let clean_email = user_email.trim().to_lowercase();

        // Fetch pending invitation ensuring recipient email matches
        let invitation = sqlx::query_as::<_, ProjectInvitation>(
            r#"
            SELECT id, project_id, email, role, invited_by, status, created_at, accepted_at
            FROM project_invitations
            WHERE id = $1 AND LOWER(email) = $2 AND status = 'pending'
            "#,
        )
        .bind(invitation_id)
        .bind(&clean_email)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Pending invitation not found or already responded".to_string())?;

        let mut transaction = pool.begin().await.map_err(|e| e.to_string())?;

        if accept {
            // Add user to project_members
            sqlx::query(
                r#"
                INSERT INTO project_members (project_id, user_id, role, added_by)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (project_id, user_id) 
                DO UPDATE SET role = EXCLUDED.role
                "#,
            )
            .bind(invitation.project_id)
            .bind(user_id)
            .bind(&invitation.role)
            .bind(invitation.invited_by)
            .execute(&mut *transaction)
            .await
            .map_err(|e| format!("Failed to add member to project: {}", e))?;

            // Mark invitation accepted
            sqlx::query(
                "UPDATE project_invitations SET status = 'accepted', accepted_at = NOW() WHERE id = $1",
            )
            .bind(invitation_id)
            .execute(&mut *transaction)
            .await
            .map_err(|e| format!("Failed to update invitation status: {}", e))?;

            transaction.commit().await.map_err(|e| e.to_string())?;
            info!("User {} accepted invite {} to project {}", user_id, invitation_id, invitation.project_id);
            Ok("Invitation accepted! You have joined the project.".to_string())
        } else {
            // Mark invitation declined
            sqlx::query(
                "UPDATE project_invitations SET status = 'declined' WHERE id = $1",
            )
            .bind(invitation_id)
            .execute(&mut *transaction)
            .await
            .map_err(|e| format!("Failed to decline invitation: {}", e))?;

            transaction.commit().await.map_err(|e| e.to_string())?;
            info!("User {} declined invite {}", user_id, invitation_id);
            Ok("Invitation declined.".to_string())
        }
    }
}
