pub(crate) mod connection;
pub(crate) mod migrations;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use crate::error::{AppError, AppResult};

#[derive(Clone, Debug)]
pub struct Db {
    path: PathBuf,
    write_gate: Arc<Mutex<()>>,
}

impl Db {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            write_gate: Arc::new(Mutex::new(())),
        }
    }

    pub fn initialize(&self, now_ms: i64) -> AppResult<()> {
        let _gate = self
            .write_gate
            .lock()
            .map_err(|_| AppError::BackgroundTask)?;
        let mut connection = connection::open_write(&self.path, true)?;
        migrations::apply(&mut connection, now_ms)?;
        if !foreign_key_check(&connection)? {
            return Err(AppError::ForeignKeyIntegrity);
        }
        Ok(())
    }

    pub fn with_read<T>(
        &self,
        operation: impl FnOnce(&Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        let connection = connection::open_read(&self.path)?;
        operation(&connection)
    }

    pub fn with_write<T>(
        &self,
        operation: impl FnOnce(&rusqlite::Transaction<'_>) -> AppResult<T>,
    ) -> AppResult<T> {
        let _gate = self
            .write_gate
            .lock()
            .map_err(|_| AppError::BackgroundTask)?;
        let mut connection = connection::open_write(&self.path, false)?;
        let transaction = connection.transaction()?;
        let result = operation(&transaction)?;
        transaction.commit()?;
        Ok(result)
    }

    /// Runs a short, process-local exclusive operation.  Stage 8 uses this for
    /// SQLite's online-backup snapshot so no new write transaction can start
    /// halfway through the snapshot.
    pub fn with_exclusive<T>(
        &self,
        operation: impl FnOnce(&PathBuf) -> AppResult<T>,
    ) -> AppResult<T> {
        let _gate = self
            .write_gate
            .lock()
            .map_err(|_| AppError::BackgroundTask)?;
        operation(&self.path)
    }
}

pub fn foreign_key_check(connection: &Connection) -> AppResult<bool> {
    let mut statement = connection.prepare("PRAGMA foreign_key_check")?;
    let valid = statement.query([])?.next()?.is_none();
    Ok(valid)
}
