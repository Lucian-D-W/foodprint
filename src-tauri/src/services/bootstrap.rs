use crate::app_state::AppState;
use crate::db::Db;
use crate::error::AppResult;
use crate::paths::PathResolver;
use crate::repositories::system;
use crate::services::cleanup;
use crate::services::{assets, local_server};

pub fn initialize(
    paths: PathResolver,
    source_root: &std::path::Path,
    now_ms: i64,
) -> AppResult<AppState> {
    paths.ensure_directories()?;
    assets::install(&paths, source_root)?;
    let db = Db::new(paths.database_path());
    db.initialize(now_ms)?;
    cleanup::run_due(&db, &paths, now_ms)?;
    system::ensure_integrity(&db)?;
    let server = tauri::async_runtime::block_on(local_server::LocalServer::start(
        paths.root().to_path_buf(),
    ))?;
    let offline_regions =
        crate::services::offline_regions::OfflineRegionService::new(db.clone(), paths.clone())?;
    Ok(AppState {
        _paths: paths,
        db,
        local_server: std::sync::Arc::new(server),
        offline_regions: std::sync::Arc::new(offline_regions),
    })
}
