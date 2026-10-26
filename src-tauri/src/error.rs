use std::io;

use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("file system error: {0}")]
    Io(#[from] io::Error),
    #[error("application data directory is unavailable")]
    DataDirectoryUnavailable,
    #[error("migration {0} has already been recorded with a different name")]
    MigrationConflict(i64),
    #[error("database foreign-key integrity check failed")]
    ForeignKeyIntegrity,
    #[error("cleanup path is not a safe relative path")]
    UnsafeRelativePath,
    #[error("background task failed")]
    BackgroundTask,
    #[error("backup or restore error: {0}")]
    Backup(String),
    #[error("offline map region is invalid: {0}")]
    InvalidOfflineRegion(String),
    #[error("map provider request failed: {0}")]
    MapProvider(String),
    #[error("offline map download failed: {0}")]
    MapDownload(String),
}
