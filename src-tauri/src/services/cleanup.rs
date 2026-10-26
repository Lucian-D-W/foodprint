use std::fs;

use rusqlite::params;

use crate::db::Db;
use crate::error::AppResult;
use crate::paths::PathResolver;

const RETRY_DELAY_MS: i64 = 60_000;

pub fn run_due(db: &Db, paths: &PathResolver, now_ms: i64) -> AppResult<usize> {
    db.with_write(|transaction| {
        let due = {
            let mut statement = transaction.prepare(
                "SELECT id, rel_path, file_kind FROM file_cleanup_queue WHERE next_attempt_at_ms <= ?1 ORDER BY id",
            )?;
            let rows = statement.query_map([now_ms], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let mut removed = 0;
        for (id, relative, kind) in due {
            match paths.resolve_cleanup_path(&kind, &relative).and_then(remove_file_if_present) {
                Ok(()) => {
                    transaction.execute("DELETE FROM file_cleanup_queue WHERE id = ?1", [id])?;
                    removed += 1;
                }
                Err(error) => {
                    transaction.execute(
                        "UPDATE file_cleanup_queue SET attempt_count = attempt_count + 1, last_error = ?1, next_attempt_at_ms = ?2 WHERE id = ?3",
                        params![error.to_string(), now_ms + RETRY_DELAY_MS, id],
                    )?;
                }
            }
        }
        Ok(removed)
    })
}

fn remove_file_if_present(path: std::path::PathBuf) -> AppResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
