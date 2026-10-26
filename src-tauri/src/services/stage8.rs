//! Stage 8 data-safety operations.  All paths in archives are application
//! relative; user supplied archive entries are never joined to a data path
//! until they have passed `safe_archive_path`.
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::Duration,
};

#[cfg(test)]
thread_local! {
    // Test-only, thread-local fault injection. Production always calls fs4.
    static TEST_AVAILABLE_SPACE: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

use rusqlite::{backup::Backup, params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

use crate::{
    db::{connection, Db},
    error::{AppError, AppResult},
    paths::PathResolver,
    services::cleanup,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: String,
    pub entity: String,
    pub title: String,
    pub deleted_at_ms: i64,
    pub restaurant_id: Option<String>,
    pub media_count: Option<i64>,
    pub log_count: Option<i64>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashPage {
    pub items: Vec<TrashItem>,
    pub cleanup_pending: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub path: String,
    pub restaurants: i64,
    pub food_logs: i64,
    pub media: i64,
    pub bytes: u64,
    pub map_reinstall_hint: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct ManifestFile {
    path: String,
    sha256: String,
    bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    format: String,
    schema_version: i64,
    created_at_ms: i64,
    files: Vec<ManifestFile>,
    restaurants: i64,
    food_logs: i64,
    media: i64,
    map_package_id: String,
    map_package_version: String,
}
type ActiveBackupFiles = (i64, i64, i64, Vec<(String, PathBuf)>);

#[derive(Clone)]
pub struct Stage8Service {
    db: Db,
    paths: PathResolver,
}
impl Stage8Service {
    pub fn new(db: Db, paths: PathResolver) -> Self {
        Self { db, paths }
    }
    pub fn list_trash(&self) -> AppResult<TrashPage> {
        self.db.with_read(|c| {
            let mut items = Vec::new();
            let mut s = c.prepare("SELECT r.id,'restaurant',r.name,r.deleted_at_ms,NULL,(SELECT COUNT(*) FROM food_logs f WHERE f.restaurant_id=r.id),(SELECT COUNT(*) FROM media m WHERE m.restaurant_id=r.id) FROM restaurants r WHERE r.deleted_at_ms IS NOT NULL UNION ALL SELECT f.id,'foodLog',COALESCE(f.title,'餐饮记录'),f.deleted_at_ms,f.restaurant_id,NULL,NULL FROM food_logs f WHERE f.deleted_at_ms IS NOT NULL UNION ALL SELECT m.id,'media',m.original_name,m.deleted_at_ms,m.restaurant_id,NULL,NULL FROM media m WHERE m.deleted_at_ms IS NOT NULL ORDER BY 4 DESC")?;
            for row in s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, Option<String>>(4)?, r.get::<_, Option<i64>>(5)?, r.get::<_, Option<i64>>(6)?)))? {
                let (id, entity, title, deleted_at_ms, restaurant_id, log_count, media_count) = row?;
                items.push(TrashItem { id, entity, title, deleted_at_ms, restaurant_id, media_count, log_count });
            }
   let pending=c.query_row("SELECT COUNT(*) FROM file_cleanup_queue",[],|r|r.get(0))?; Ok(TrashPage{items,cleanup_pending:pending}) })
    }
    pub fn restore_trash(&self, entity: &str, id: &str) -> AppResult<()> {
        let now = crate::now_ms();
        self.db.with_write(|t| { let table=table(entity)?; let changed=t.execute(&format!("UPDATE {table} SET deleted_at_ms=NULL,updated_at_ms=?2 WHERE id=?1 AND deleted_at_ms IS NOT NULL"),params![id,now])?; if changed==1 {Ok(())}else{Err(AppError::BackgroundTask)} })
    }
    pub fn permanently_delete(&self, entity: &str, id: &str) -> AppResult<()> {
        let now = crate::now_ms();
        self.db.with_write(|t| {
            let ids: Vec<String> = match entity {
                "media" => vec![id.to_owned()],
                "foodLog" => {
                    t.execute(
                        "UPDATE media SET food_log_id=NULL WHERE food_log_id=?1",
                        [id],
                    )?;
                    vec![]
                }
                "restaurant" => {
                    let mut st = t.prepare("SELECT id FROM media WHERE restaurant_id=?1")?;
                    let ids = st
                        .query_map([id], |r| r.get(0))?
                        .collect::<Result<_, _>>()?;
                    ids
                }
                _ => return Err(AppError::Backup("unknown trash entity".into())),
            };
            for media_id in ids {
                queue_media(t, &media_id, now)?;
            }
            let (sql, ok) = match entity {
                "media" => (
                    "DELETE FROM media WHERE id=?1 AND deleted_at_ms IS NOT NULL",
                    true,
                ),
                "foodLog" => (
                    "DELETE FROM food_logs WHERE id=?1 AND deleted_at_ms IS NOT NULL",
                    true,
                ),
                "restaurant" => (
                    "DELETE FROM restaurants WHERE id=?1 AND deleted_at_ms IS NOT NULL",
                    true,
                ),
                _ => unreachable!(),
            };
            if ok && t.execute(sql, [id])? == 1 {
                Ok(())
            } else {
                Err(AppError::BackgroundTask)
            }
        })?;
        cleanup::run_due(&self.db, &self.paths, crate::now_ms())?;
        Ok(())
    }
    pub fn retry_cleanup(&self) -> AppResult<usize> {
        cleanup::run_due(&self.db, &self.paths, crate::now_ms())
    }
    pub fn backup(&self, destination: PathBuf) -> AppResult<BackupSummary> {
        if destination.extension().and_then(|x| x.to_str()) != Some("zip") {
            return Err(AppError::Backup(
                "backup destination must end in .zip".into(),
            ));
        }
        let parent = destination
            .parent()
            .ok_or_else(|| AppError::Backup("backup destination has no parent".into()))?;
        fs::create_dir_all(parent)?;
        if destination.exists() {
            return Err(AppError::Backup("backup destination already exists".into()));
        }
        let live_estimate = self.live_backup_estimate()?;
        for location in [self.paths.root(), parent] {
            let free = available_space(location)?;
            if free < live_estimate.saturating_add(1_048_576) {
                return Err(AppError::Backup(
                    "insufficient free space for backup snapshot or destination".into(),
                ));
            }
        }
        let nonce = Uuid::now_v7();
        let temp = parent.join(format!(".foodmap-backup-{nonce}.partial"));
        fs::create_dir_all(self.paths.root().join("restore-staging"))?;
        let snapshot = self
            .paths
            .root()
            .join("restore-staging")
            .join(format!("backup-{nonce}.sqlite3"));
        // SQLite online backup produces a consistent DB image while the process gate
        // prevents a new application write from beginning during snapshot creation.
        if let Err(error) = self.db.with_exclusive(|source_path| {
            let source = connection::open_write(source_path, false)?;
            let mut target = rusqlite::Connection::open(&snapshot)?;
            let backup = Backup::new(&source, &mut target)?;
            backup.run_to_completion(64, Duration::from_millis(1), None)?;
            Ok(())
        }) {
            remove_sqlite_artifacts(&snapshot);
            return Err(error);
        }
        let result = (|| {
            let (restaurants, food_logs, media, rel_files) = self.snapshot_files(&snapshot)?;
            let estimated = fs::metadata(&snapshot)?.len()
                + rel_files
                    .iter()
                    .map(|(_, p)| fs::metadata(p).map(|m| m.len()).unwrap_or(0))
                    .sum::<u64>();
            let available = available_space(parent)?;
            if available < estimated.saturating_add(1_048_576) {
                return Err(AppError::Backup(
                    "insufficient free space for backup".into(),
                ));
            }
            let file = fs::File::create(&temp)?;
            let mut zip = ZipWriter::new(file);
            let opts = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .large_file(true);
            let mut files = Vec::new();
            add_zip(&mut zip, &snapshot, "db/foodmap.sqlite3", opts, &mut files)?;
            for (name, path) in rel_files {
                add_zip(&mut zip, &path, &name, opts, &mut files)?;
            }
            let (map_package_id, map_package_version) = self.map_package();
            let map_reinstall_hint =
                map_package_id == "missing" || map_package_version == "missing";
            let manifest = BackupManifest {
                format: "foodmap-backup-v1".into(),
                schema_version: 1,
                created_at_ms: crate::now_ms(),
                files,
                restaurants,
                food_logs,
                media,
                map_package_id,
                map_package_version,
            };
            let bytes = serde_json::to_vec_pretty(&manifest)
                .map_err(|e| AppError::Backup(e.to_string()))?;
            zip.start_file("backup-manifest.json", opts)
                .map_err(ziperr)?;
            zip.write_all(&bytes)?;
            zip.finish().map_err(ziperr)?;
            fs::rename(&temp, &destination)?;
            Ok(BackupSummary {
                path: destination.to_string_lossy().into_owned(),
                restaurants,
                food_logs,
                media,
                bytes: fs::metadata(&destination)?.len(),
                map_reinstall_hint,
            })
        })();
        remove_sqlite_artifacts(&snapshot);
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result
    }
    pub fn inspect_restore(&self, archive: &Path) -> AppResult<BackupSummary> {
        let staging = self.fresh_staging()?;
        let result = self
            .unpack_verify(archive, &staging)
            .map(|manifest| manifest_summary(&manifest, archive));
        let _ = fs::remove_dir_all(staging);
        result
    }
    pub fn restore(&self, archive: &Path) -> AppResult<BackupSummary> {
        let staging = self.fresh_staging()?;
        let manifest = match self.unpack_verify(archive, &staging) {
            Ok(value) => value,
            Err(error) => {
                let _ = fs::remove_dir_all(staging);
                return Err(error);
            }
        };
        let safety = self
            .paths
            .root()
            .join("backups")
            .join(format!("pre-restore-{}.foodmap-backup.zip", Uuid::now_v7()));
        if let Err(error) = self.backup(safety) {
            let _ = fs::remove_dir_all(staging);
            return Err(error);
        }
        let staged_db = staging.join("db/foodmap.sqlite3");
        let staged_media = staging.join("media");
        let root = self.paths.root().to_path_buf();
        let swap_nonce = Uuid::now_v7();
        let old_db = root.join(format!("db/foodmap.sqlite3.before-restore-{swap_nonce}"));
        let old_media = root.join(format!("media.before-restore-{swap_nonce}"));
        let db = self.paths.database_path();
        let media = self.paths.media_root();
        // The filesystem replacement must not race an application command
        // opening a write transaction against the database we are swapping.
        // Keep both the rename and the immediate integrity check inside the
        // same process-local DB gate; rollback is performed before releasing it.
        let swap = self.db.with_exclusive(|_| {
            let result = (|| {
                if db.exists() {
                    fs::rename(&db, &old_db)?;
                }
                if media.exists() {
                    fs::rename(&media, &old_media)?;
                }
                fs::create_dir_all(db.parent().unwrap())?;
                fs::rename(&staged_db, &db)?;
                if staged_media.exists() {
                    fs::rename(&staged_media, &media)?;
                } else {
                    fs::create_dir_all(&media)?;
                }
                let mut check = connection::open_write(&db, true)?;
                let quick: String = check.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
                if quick != "ok" {
                    return Err(AppError::Backup(
                        "restored database quick_check failed".into(),
                    ));
                }
                crate::db::migrations::apply(&mut check, crate::now_ms())?;
                if !crate::db::foreign_key_check(&check)? {
                    return Err(AppError::ForeignKeyIntegrity);
                }
                Ok(())
            })();
            if result.is_err() {
                let _ = fs::remove_file(&db);
                let _ = fs::remove_dir_all(&media);
                if old_db.exists() {
                    let _ = fs::rename(&old_db, &db);
                }
                if old_media.exists() {
                    let _ = fs::rename(&old_media, &media);
                }
            }
            result
        });
        if let Err(error) = swap {
            let _ = fs::remove_dir_all(staging);
            return Err(error);
        }
        let _ = fs::remove_file(old_db);
        let _ = fs::remove_dir_all(old_media);
        let _ = fs::remove_dir_all(staging);
        Ok(manifest_summary(&manifest, archive))
    }
    fn snapshot_files(&self, snapshot: &Path) -> AppResult<ActiveBackupFiles> {
        let c = connection::open_read(snapshot)?;
        let restaurants = c.query_row("SELECT COUNT(*) FROM restaurants", [], |r| r.get(0))?;
        let food_logs = c.query_row("SELECT COUNT(*) FROM food_logs", [], |r| r.get(0))?;
        let media = c.query_row("SELECT COUNT(*) FROM media", [], |r| r.get(0))?;
        let mut st =
            c.prepare("SELECT original_rel_path,preview_rel_path,thumbnail_rel_path FROM media")?;
        let mut out = Vec::new();
        for row in st.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })? {
            let (a, b, d) = row?;
            let modern_path = |relative: &str, kind: &str| -> AppResult<(String, PathBuf)> {
                let prefix = match kind {
                    "media_original" => "original/",
                    "media_preview" => "preview/",
                    "media_thumbnail" => "thumbnail/",
                    _ => return Err(AppError::UnsafeRelativePath),
                };
                let archive = if relative.starts_with(prefix) {
                    format!("media/{relative}")
                } else {
                    format!("media/{prefix}{relative}")
                };
                Ok((archive, self.paths.resolve_cleanup_path(kind, relative)?))
            };
            out.push(modern_path(&a, "media_original")?);
            out.push(modern_path(&b, "media_preview")?);
            out.push(modern_path(&d, "media_thumbnail")?);
        }
        Ok((restaurants, food_logs, media, out))
    }
    fn live_backup_estimate(&self) -> AppResult<u64> {
        let mut bytes = fs::metadata(self.paths.database_path())?.len();
        for root in [
            self.paths.media_root().join("original"),
            self.paths.media_root().join("preview"),
            self.paths.media_root().join("thumbnail"),
        ] {
            bytes = bytes.saturating_add(tree_size(&root)?);
        }
        Ok(bytes)
    }
    fn map_package(&self) -> (String, String) {
        let path = self.paths.root().join("maps/default/manifest.json");
        let parsed = fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
        let id = parsed
            .as_ref()
            .and_then(|v| v.get("packageId").or_else(|| v.get("id")))
            .and_then(|v| v.as_str())
            .unwrap_or("missing")
            .to_owned();
        let version = parsed
            .as_ref()
            .and_then(|v| v.get("packageVersion").or_else(|| v.get("version")))
            .and_then(|v| v.as_str())
            .unwrap_or("missing")
            .to_owned();
        (id, version)
    }
    fn fresh_staging(&self) -> AppResult<PathBuf> {
        let p = self
            .paths
            .root()
            .join("restore-staging")
            .join(format!("restore-{}", Uuid::now_v7()));
        fs::create_dir_all(&p)?;
        Ok(p)
    }
    fn unpack_verify(&self, archive: &Path, staging: &Path) -> AppResult<BackupManifest> {
        let f = fs::File::open(archive)?;
        let mut zip = ZipArchive::new(f).map_err(ziperr)?;
        let mut manifest = None;
        let mut archive_entries = Vec::new();
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(ziperr)?;
            let name = entry.name().to_owned();
            archive_entries.push(name.clone());
            let target = safe_archive_path(staging, &name)?;
            if entry.is_dir() {
                fs::create_dir_all(target)?;
                continue;
            }
            if name == "backup-manifest.json" {
                let mut b = Vec::new();
                entry.read_to_end(&mut b)?;
                manifest =
                    Some(serde_json::from_slice(&b).map_err(|e| AppError::Backup(e.to_string()))?);
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut dest = fs::File::create(target)?;
            std::io::copy(&mut entry, &mut dest)?;
        }
        let manifest: BackupManifest =
            manifest.ok_or_else(|| AppError::Backup("backup manifest missing".into()))?;
        if manifest.format != "foodmap-backup-v1" || manifest.schema_version != 1 {
            return Err(AppError::Backup("unsupported backup manifest".into()));
        }
        let mut declared: Vec<String> = manifest
            .files
            .iter()
            .map(|file| file.path.clone())
            .collect();
        declared.push("backup-manifest.json".into());
        declared.sort();
        archive_entries.sort();
        if archive_entries != declared {
            return Err(AppError::Backup(
                "backup contains undeclared or missing entries".into(),
            ));
        }
        for file in &manifest.files {
            let p = safe_archive_path(staging, &file.path)?;
            if !p.is_file() || fs::metadata(&p)?.len() != file.bytes || hash(&p)? != file.sha256 {
                return Err(AppError::Backup(format!(
                    "backup hash mismatch: {}",
                    file.path
                )));
            }
        }
        let db = staging.join("db/foodmap.sqlite3");
        let c = connection::open_write(&db, false)?;
        let quick: String = c.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if quick != "ok" {
            return Err(AppError::Backup("backup SQLite quick_check failed".into()));
        }
        Ok(manifest)
    }
}

fn available_space(path: &Path) -> AppResult<u64> {
    #[cfg(test)]
    if let Some(value) = TEST_AVAILABLE_SPACE.with(std::cell::Cell::get) {
        return Ok(value);
    }
    fs4::available_space(path)
        .map_err(|e| AppError::Backup(format!("cannot determine backup free space: {e}")))
}

#[cfg(test)]
pub(crate) struct TestAvailableSpaceOverride(Option<u64>);

#[cfg(test)]
impl Drop for TestAvailableSpaceOverride {
    fn drop(&mut self) {
        TEST_AVAILABLE_SPACE.with(|value| value.set(self.0));
    }
}

#[cfg(test)]
pub(crate) fn test_available_space_override(value: u64) -> TestAvailableSpaceOverride {
    TestAvailableSpaceOverride(TEST_AVAILABLE_SPACE.with(|current| {
        let previous = current.get();
        current.set(Some(value));
        previous
    }))
}
fn table(entity: &str) -> AppResult<&'static str> {
    match entity {
        "restaurant" => Ok("restaurants"),
        "foodLog" => Ok("food_logs"),
        "media" => Ok("media"),
        _ => Err(AppError::Backup("unknown trash entity".into())),
    }
}
fn queue_media(t: &rusqlite::Transaction<'_>, id: &str, now: i64) -> AppResult<()> {
    let row: Option<(String, String, String)> = t
        .query_row(
            "SELECT original_rel_path,preview_rel_path,thumbnail_rel_path FROM media WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    if let Some((a, b, c)) = row {
        for (rel, kind) in [
            (a, "media_original"),
            (b, "media_preview"),
            (c, "media_thumbnail"),
        ] {
            t.execute("INSERT OR IGNORE INTO file_cleanup_queue(rel_path,file_kind,created_at_ms,next_attempt_at_ms) VALUES(?1,?2,?3,?3)",params![rel,kind,now])?;
        }
    }
    Ok(())
}
fn hash(path: &Path) -> AppResult<String> {
    let mut f = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut b = [0; 65536];
    loop {
        let n = f.read(&mut b)?;
        if n == 0 {
            break;
        }
        h.update(&b[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
fn add_zip(
    zip: &mut ZipWriter<fs::File>,
    path: &Path,
    name: &str,
    opts: SimpleFileOptions,
    files: &mut Vec<ManifestFile>,
) -> AppResult<()> {
    let bytes = fs::metadata(path)?.len();
    let sha256 = hash(path)?;
    zip.start_file(name, opts).map_err(ziperr)?;
    let mut source = fs::File::open(path)?;
    std::io::copy(&mut source, zip)?;
    files.push(ManifestFile {
        path: name.into(),
        sha256,
        bytes,
    });
    Ok(())
}
fn ziperr(e: zip::result::ZipError) -> AppError {
    AppError::Backup(e.to_string())
}
fn safe_archive_path(root: &Path, name: &str) -> AppResult<PathBuf> {
    let p = Path::new(name);
    if p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(AppError::UnsafeRelativePath);
    };
    Ok(root.join(p))
}
fn manifest_summary(m: &BackupManifest, path: &Path) -> BackupSummary {
    BackupSummary {
        path: path.to_string_lossy().into_owned(),
        restaurants: m.restaurants,
        food_logs: m.food_logs,
        media: m.media,
        bytes: fs::metadata(path).map(|x| x.len()).unwrap_or(0),
        map_reinstall_hint: m.map_package_id == "missing" || m.map_package_version == "missing",
    }
}
fn tree_size(root: &Path) -> AppResult<u64> {
    if !root.exists() {
        return Ok(0);
    }
    let mut total: u64 = 0;
    for entry in fs::read_dir(root)? {
        let path = entry?.path();
        if path.is_dir() {
            total = total.saturating_add(tree_size(&path)?)
        } else {
            total = total.saturating_add(fs::metadata(path)?.len())
        }
    }
    Ok(total)
}
fn remove_sqlite_artifacts(path: &Path) {
    let _ = fs::remove_file(path);
    let _ = fs::remove_file(format!("{}-wal", path.to_string_lossy()));
    let _ = fs::remove_file(format!("{}-shm", path.to_string_lossy()));
}
