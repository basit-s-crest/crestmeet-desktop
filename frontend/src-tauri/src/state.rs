use crate::database::manager::DatabaseManager;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

pub struct AppState {
    pub db_manager: DatabaseManager,
    pub current_user_id: Arc<RwLock<Option<Uuid>>>,
    pub active_project_id: Arc<RwLock<Option<Uuid>>>,
}

impl AppState {
    pub fn new(db_manager: DatabaseManager) -> Self {
        Self {
            db_manager,
            current_user_id: Arc::new(RwLock::new(None)),
            active_project_id: Arc::new(RwLock::new(None)),
        }
    }

    pub fn with_user(db_manager: DatabaseManager, current_user_id: Arc<RwLock<Option<Uuid>>>) -> Self {
        Self {
            db_manager,
            current_user_id,
            active_project_id: Arc::new(RwLock::new(None)),
        }
    }
}
