use crate::db::Db;
use crate::paths::PathResolver;
use crate::services::local_server::LocalServer;
use crate::services::offline_regions::OfflineRegionService;

#[derive(Clone)]
pub struct AppState {
    pub _paths: PathResolver,
    pub db: Db,
    pub local_server: std::sync::Arc<LocalServer>,
    pub offline_regions: std::sync::Arc<OfflineRegionService>,
}
