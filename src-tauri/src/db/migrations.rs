use rusqlite::{Connection, OptionalExtension};

use crate::error::{AppError, AppResult};

const INITIAL_SQL: &str = include_str!("../../migrations/0001_initial.sql");
const INITIAL_VERSION: i64 = 1;
const INITIAL_NAME: &str = "initial";
const CLEANUP_QUEUE_VERSION: i64 = 2;
const CLEANUP_QUEUE_NAME: &str = "cleanup_queue_file_kind";
const MAP_ICON_SCALE_SQL: &str =
    include_str!("../../migrations/0003_restaurant_map_icon_scale.sql");
const MAP_ICON_SCALE_VERSION: i64 = 3;
const MAP_ICON_SCALE_NAME: &str = "restaurant_map_icon_scale";
const CUISINE_TAXONOMY_SQL: &str = include_str!("../../migrations/0004_cuisine_taxonomy.sql");
const CUISINE_TAXONOMY_VERSION: i64 = 4;
const CUISINE_TAXONOMY_NAME: &str = "cuisine_taxonomy";
const OFFLINE_REGIONS_SQL: &str = include_str!("../../migrations/0005_offline_regions.sql");
const OFFLINE_REGIONS_VERSION: i64 = 5;
const OFFLINE_REGIONS_NAME: &str = "offline_regions";
const RESTAURANT_POSITION_LOCK_SQL: &str =
    include_str!("../../migrations/0006_restaurant_position_lock.sql");
const RESTAURANT_POSITION_LOCK_VERSION: i64 = 6;
const RESTAURANT_POSITION_LOCK_NAME: &str = "restaurant_position_lock";
const MAP_CENTERS_SQL: &str = include_str!("../../migrations/0007_map_centers.sql");
const MAP_CENTERS_VERSION: i64 = 7;
const MAP_CENTERS_NAME: &str = "map_centers";
const MAP_CENTER_ICON_SCALE_SQL: &str =
    include_str!("../../migrations/0008_map_center_icon_scale.sql");
const MAP_CENTER_ICON_SCALE_VERSION: i64 = 8;
const MAP_CENTER_ICON_SCALE_NAME: &str = "map_center_icon_scale";

pub fn apply(connection: &mut Connection, now_ms: i64) -> AppResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at_ms INTEGER NOT NULL);",
    )?;
    let applied: Option<String> = match connection.query_row(
        "SELECT name FROM schema_migrations WHERE version = ?1",
        [INITIAL_VERSION],
        |row| row.get(0),
    ) {
        Ok(name) => Some(name),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(error) => return Err(error.into()),
    };
    if let Some(name) = applied {
        if name != INITIAL_NAME {
            return Err(AppError::MigrationConflict(INITIAL_VERSION));
        }
    } else {
        let transaction = connection.transaction()?;
        transaction.execute_batch(INITIAL_SQL)?;
        transaction.execute(
            "INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?1, ?2, ?3)",
            (INITIAL_VERSION, INITIAL_NAME, now_ms),
        )?;
        transaction.commit()?;
    }
    let cleanup_name: Option<String> = connection
        .query_row(
            "SELECT name FROM schema_migrations WHERE version=?1",
            [CLEANUP_QUEUE_VERSION],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(name) = cleanup_name {
        if name != CLEANUP_QUEUE_NAME {
            return Err(AppError::MigrationConflict(CLEANUP_QUEUE_VERSION));
        }
    } else {
        let t = connection.transaction()?;
        t.execute_batch("ALTER TABLE file_cleanup_queue RENAME TO file_cleanup_queue_legacy; CREATE TABLE file_cleanup_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, rel_path TEXT NOT NULL, file_kind TEXT NOT NULL CHECK (file_kind IN ('media_original','media_preview','media_thumbnail','temp')), attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count>=0), last_error TEXT, created_at_ms INTEGER NOT NULL, next_attempt_at_ms INTEGER NOT NULL, UNIQUE(file_kind,rel_path)); INSERT OR IGNORE INTO file_cleanup_queue(rel_path,file_kind,attempt_count,last_error,created_at_ms,next_attempt_at_ms) SELECT rel_path,file_kind,attempt_count,last_error,created_at_ms,next_attempt_at_ms FROM file_cleanup_queue_legacy; DROP TABLE file_cleanup_queue_legacy; CREATE INDEX idx_cleanup_queue_due ON file_cleanup_queue(next_attempt_at_ms,id);")?;
        t.execute(
            "INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(?1,?2,?3)",
            (CLEANUP_QUEUE_VERSION, CLEANUP_QUEUE_NAME, now_ms),
        )?;
        t.commit()?;
    }
    let map_icon_scale_name: Option<String> = connection
        .query_row(
            "SELECT name FROM schema_migrations WHERE version=?1",
            [MAP_ICON_SCALE_VERSION],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(name) = map_icon_scale_name {
        if name != MAP_ICON_SCALE_NAME {
            return Err(AppError::MigrationConflict(MAP_ICON_SCALE_VERSION));
        }
    } else {
        let t = connection.transaction()?;
        t.execute_batch(MAP_ICON_SCALE_SQL)?;
        t.execute(
            "INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(?1,?2,?3)",
            (MAP_ICON_SCALE_VERSION, MAP_ICON_SCALE_NAME, now_ms),
        )?;
        t.commit()?;
    }
    let cuisine_taxonomy_name: Option<String> = connection
        .query_row(
            "SELECT name FROM schema_migrations WHERE version=?1",
            [CUISINE_TAXONOMY_VERSION],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(name) = cuisine_taxonomy_name {
        if name != CUISINE_TAXONOMY_NAME {
            return Err(AppError::MigrationConflict(CUISINE_TAXONOMY_VERSION));
        }
    } else {
        let t = connection.transaction()?;
        t.execute_batch(CUISINE_TAXONOMY_SQL)?;
        t.execute(
            "INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(?1,?2,?3)",
            (CUISINE_TAXONOMY_VERSION, CUISINE_TAXONOMY_NAME, now_ms),
        )?;
        t.commit()?;
    }
    let offline_regions_name: Option<String> = connection
        .query_row(
            "SELECT name FROM schema_migrations WHERE version=?1",
            [OFFLINE_REGIONS_VERSION],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(name) = offline_regions_name {
        if name != OFFLINE_REGIONS_NAME {
            return Err(AppError::MigrationConflict(OFFLINE_REGIONS_VERSION));
        }
    } else {
        let t = connection.transaction()?;
        t.execute_batch(OFFLINE_REGIONS_SQL)?;
        t.execute(
            "INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(?1,?2,?3)",
            (OFFLINE_REGIONS_VERSION, OFFLINE_REGIONS_NAME, now_ms),
        )?;
        t.commit()?;
    }
    let restaurant_position_lock_name: Option<String> = connection
        .query_row(
            "SELECT name FROM schema_migrations WHERE version=?1",
            [RESTAURANT_POSITION_LOCK_VERSION],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(name) = restaurant_position_lock_name {
        if name != RESTAURANT_POSITION_LOCK_NAME {
            return Err(AppError::MigrationConflict(
                RESTAURANT_POSITION_LOCK_VERSION,
            ));
        }
    } else {
        let t = connection.transaction()?;
        t.execute_batch(RESTAURANT_POSITION_LOCK_SQL)?;
        t.execute(
            "INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(?1,?2,?3)",
            (
                RESTAURANT_POSITION_LOCK_VERSION,
                RESTAURANT_POSITION_LOCK_NAME,
                now_ms,
            ),
        )?;
        t.commit()?;
    }
    let map_centers_name: Option<String> = connection
        .query_row(
            "SELECT name FROM schema_migrations WHERE version=?1",
            [MAP_CENTERS_VERSION],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(name) = map_centers_name {
        if name != MAP_CENTERS_NAME {
            return Err(AppError::MigrationConflict(MAP_CENTERS_VERSION));
        }
    } else {
        let t = connection.transaction()?;
        t.execute_batch(MAP_CENTERS_SQL)?;
        t.execute(
            "INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(?1,?2,?3)",
            (MAP_CENTERS_VERSION, MAP_CENTERS_NAME, now_ms),
        )?;
        t.commit()?;
    }
    let map_center_icon_scale_name: Option<String> = connection
        .query_row(
            "SELECT name FROM schema_migrations WHERE version=?1",
            [MAP_CENTER_ICON_SCALE_VERSION],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(name) = map_center_icon_scale_name {
        if name != MAP_CENTER_ICON_SCALE_NAME {
            return Err(AppError::MigrationConflict(MAP_CENTER_ICON_SCALE_VERSION));
        }
    } else {
        let t = connection.transaction()?;
        t.execute_batch(MAP_CENTER_ICON_SCALE_SQL)?;
        t.execute(
            "INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(?1,?2,?3)",
            (
                MAP_CENTER_ICON_SCALE_VERSION,
                MAP_CENTER_ICON_SCALE_NAME,
                now_ms,
            ),
        )?;
        t.commit()?;
    }
    Ok(())
}
