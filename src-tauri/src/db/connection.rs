use std::path::Path;

use rusqlite::{Connection, OpenFlags};

use crate::error::AppResult;

pub fn open_write(path: &Path, set_wal: bool) -> AppResult<Connection> {
    let connection = Connection::open(path)?;
    if set_wal {
        connection.pragma_update(None, "journal_mode", "WAL")?;
    }
    configure(&connection)?;
    Ok(connection)
}

pub fn open_read(path: &Path) -> AppResult<Connection> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    configure(&connection)?;
    connection.pragma_update(None, "query_only", "ON")?;
    Ok(connection)
}

fn configure(connection: &Connection) -> AppResult<()> {
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "busy_timeout", 5000)?;
    connection.pragma_update(None, "temp_store", "MEMORY")?;
    Ok(())
}
