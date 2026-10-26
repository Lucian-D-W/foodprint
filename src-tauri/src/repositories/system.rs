use crate::db::{foreign_key_check, Db};
use crate::error::{AppError, AppResult};

pub fn ensure_integrity(db: &Db) -> AppResult<()> {
    if db.with_read(foreign_key_check)? {
        Ok(())
    } else {
        Err(AppError::ForeignKeyIntegrity)
    }
}
