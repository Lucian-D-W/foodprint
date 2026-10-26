use std::{
    fs,
    io::Read,
    time::{Duration, Instant},
};

use image::GenericImageView;
use rusqlite::params;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::commands::bootstrap as bootstrap_commands;
use crate::db::Db;
use crate::paths::PathResolver;
use crate::repositories::offline_regions::RegionBounds;
use crate::services::food_log::FoodLogService;
use crate::services::local_server::LocalServer;
use crate::services::map_centers::MapCenterService;
use crate::services::media::MediaService;
use crate::services::restaurant::RestaurantService;
use crate::services::stage8::Stage8Service;
use crate::services::{assets, bootstrap, cleanup};

fn fixture() -> (TempDir, PathResolver, Db) {
    let temporary = TempDir::new().expect("temporary app data directory");
    let paths = PathResolver::from_root(temporary.path().to_path_buf());
    let state = bootstrap::initialize(
        paths.clone(),
        &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources"),
        1_000,
    )
    .expect("initialize fixture");
    (temporary, paths, state.db)
}

fn restaurant_service(paths: &PathResolver, db: Db) -> RestaurantService {
    RestaurantService::new(db, &paths.root().join("assets/food-icons/manifest.json"))
        .expect("restaurant service")
}

fn food_log_service(db: Db) -> FoodLogService {
    FoodLogService::new(db)
}

fn media_service(paths: &PathResolver, db: Db) -> MediaService {
    MediaService::new(db, paths.clone())
}

fn stage8_service(paths: &PathResolver, db: Db) -> Stage8Service {
    Stage8Service::new(db, paths.clone())
}

#[test]
fn map_center_groups_nearby_cache_and_leaves_unrelated_cache_standalone() {
    use crate::repositories::offline_regions::{self, OfflineRegion, RegionBounds};

    let (_temporary, _paths, db) = fixture();
    let make_region = |id: &str, west: f64, south: f64, east: f64, north: f64| OfflineRegion {
        id: id.into(),
        label: id.into(),
        display_name: id.into(),
        locale: "zh".into(),
        west,
        south,
        east,
        north,
        center_longitude: (west + east) / 2.0,
        center_latitude: (south + north) / 2.0,
        return_zoom: 14.0,
        tile_min_zoom: 12,
        tile_max_zoom: 14,
        provider_url: "https://tiles.example.test".into(),
        tile_template: "https://tiles.example.test/{z}/{x}/{y}.pbf".into(),
        provider_version: "1".into(),
        attribution: "test".into(),
        tile_count: 1,
        byte_size: 1,
        status: "ready".into(),
        created_at_ms: 1,
        updated_at_ms: 1,
    };
    db.with_write(|transaction| {
        offline_regions::insert(
            transaction,
            &make_region("near", 113.20, 23.00, 113.30, 23.10),
        )?;
        offline_regions::insert(
            transaction,
            &make_region("far", 114.20, 24.00, 114.30, 24.10),
        )
    })
    .expect("insert cached regions");

    let center = MapCenterService::new(db)
        .create(
            "家".into(),
            "home".into(),
            1,
            1.0,
            113.305,
            23.05,
            RegionBounds {
                west: 113.305,
                south: 23.02,
                east: 113.405,
                north: 23.08,
            },
        )
        .expect("create center");

    assert_eq!(center.cached_region_ids, vec!["near"]);
    assert_eq!(center.primary_region_id.as_deref(), Some("near"));
    assert!(!center.cached_region_ids.contains(&"far".to_owned()));
}

#[test]
fn restaurant_position_lock_defaults_false_and_round_trips_in_app_settings() {
    let (_temporary, _paths, db) = fixture();

    assert!(!bootstrap_commands::read_restaurant_position_locked(&db).expect("default lock"));
    bootstrap_commands::persist_restaurant_position_locked(&db, true).expect("save lock");
    assert!(bootstrap_commands::read_restaurant_position_locked(&db).expect("read enabled lock"));
    bootstrap_commands::persist_restaurant_position_locked(&db, false).expect("clear lock");
    assert!(!bootstrap_commands::read_restaurant_position_locked(&db).expect("read disabled lock"));
}

#[test]
fn bootstrap_info_serializes_position_lock_and_registers_its_commands() {
    let source = include_str!("lib.rs");
    assert!(source.contains("commands::bootstrap::get_restaurant_position_locked"));
    assert!(source.contains("commands::bootstrap::set_restaurant_position_locked"));

    let info = bootstrap_commands::BootstrapInfo {
        database_ready: true,
        local_asset_origin: "http://127.0.0.1".into(),
        map_manifest: serde_json::json!({}),
        icon_manifest: serde_json::json!({}),
        food_icon_base_url: "http://127.0.0.1/assets/food-icons".into(),
        last_map_view: None,
        restaurant_position_locked: false,
    };
    let serialized = serde_json::to_value(info).expect("bootstrap info json");
    assert_eq!(serialized["restaurantPositionLocked"], false);
}

#[test]
fn stage8_backup_round_trip_uses_disposable_data_and_rejects_tampering() {
    let (_temporary, paths, db) = fixture();
    let safety = stage8_service(&paths, db.clone());
    let archive = paths.root().join("backup.foodmap-backup.zip");
    let made = safety.backup(archive.clone()).expect("backup");
    assert!(archive.is_file());
    assert!(made.map_reinstall_hint);
    let preview = safety.inspect_restore(&archive).expect("validated preview");
    assert_eq!(preview.restaurants, 0);
    fs::write(
        paths.root().join("db/foodmap.sqlite3.before-restore"),
        b"stale",
    )
    .expect("legacy collision fixture");
    fs::create_dir_all(paths.root().join("media.before-restore"))
        .expect("legacy media collision fixture");
    safety
        .restore(&archive)
        .expect("restored disposable database");

    let bad = paths.root().join("bad.zip");
    let f = fs::File::create(&bad).expect("bad archive");
    let mut zip = zip::ZipWriter::new(f);
    zip.start_file("../outside", zip::write::SimpleFileOptions::default())
        .expect("entry");
    use std::io::Write;
    zip.write_all(b"bad").expect("body");
    zip.finish().expect("finish");
    assert!(safety.inspect_restore(&bad).is_err());
}

#[test]
fn stage8_backup_records_present_or_missing_map_manifest_and_restore_makes_inspectable_safety_copy()
{
    let (_temporary, paths, db) = fixture();
    let safety = stage8_service(&paths, db);
    let map_manifest = paths.root().join("maps/default/manifest.json");
    fs::create_dir_all(map_manifest.parent().expect("maps parent")).expect("maps parent");
    fs::write(
        &map_manifest,
        r#"{"packageId":"city-map","packageVersion":"2026.8"}"#,
    )
    .expect("map manifest");
    let present = paths.root().join("present.zip");
    assert!(
        !safety
            .backup(present)
            .expect("present backup")
            .map_reinstall_hint
    );
    let mut archive = zip::ZipArchive::new(
        fs::File::open(paths.root().join("present.zip")).expect("present zip"),
    )
    .expect("zip");
    let mut manifest = String::new();
    use std::io::Read;
    archive
        .by_name("backup-manifest.json")
        .expect("manifest")
        .read_to_string(&mut manifest)
        .expect("manifest text");
    let manifest: serde_json::Value = serde_json::from_str(&manifest).expect("manifest json");
    assert_eq!(manifest["mapPackageId"], "city-map");
    assert_eq!(manifest["mapPackageVersion"], "2026.8");
    fs::remove_file(&map_manifest).expect("remove map manifest");
    let missing = paths.root().join("missing.zip");
    assert!(
        safety
            .backup(missing.clone())
            .expect("missing backup")
            .map_reinstall_hint
    );
    safety
        .restore(&missing)
        .expect("restore produces safety backup");
    let safety_archive = fs::read_dir(paths.root().join("backups"))
        .expect("backups")
        .map(|e| e.expect("entry").path())
        .find(|p| p.extension().and_then(|x| x.to_str()) == Some("zip"))
        .expect("safety archive");
    safety
        .inspect_restore(&safety_archive)
        .expect("inspect safety archive");
}

#[test]
fn stage8_rejected_archives_clean_staging_and_preserve_live_data() {
    let (_temporary, paths, db) = fixture();
    let safety = stage8_service(&paths, db.clone());
    let original = fs::read(paths.database_path()).expect("original db");
    let live_media = paths.media_root().join("original/live.jpg");
    fs::write(&live_media, b"live").expect("live media");
    let bad = paths.root().join("invalid-hash.zip");
    let file = fs::File::create(&bad).expect("bad archive");
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default();
    zip.start_file("db/foodmap.sqlite3", opts)
        .expect("db entry");
    use std::io::Write;
    zip.write_all(b"not sqlite").expect("db body");
    zip.start_file("backup-manifest.json", opts)
        .expect("manifest entry");
    zip.write_all(br#"{"format":"foodmap-backup-v1","schemaVersion":1,"createdAtMs":1,"files":[{"path":"db/foodmap.sqlite3","sha256":"00","bytes":10}],"restaurants":0,"foodLogs":0,"media":0,"mapPackageId":"missing","mapPackageVersion":"missing"}"#).expect("manifest body");
    zip.finish().expect("finish invalid archive");
    assert!(safety.inspect_restore(&bad).is_err());
    assert!(safety.restore(&bad).is_err());
    assert_eq!(
        fs::read(paths.database_path()).expect("db retained"),
        original
    );
    assert_eq!(fs::read(&live_media).expect("media retained"), b"live");
    let staging = paths.root().join("restore-staging");
    assert_eq!(fs::read_dir(&staging).expect("staging").count(), 0);
    assert_eq!(
        fs::read_dir(paths.root().join("db"))
            .expect("db root")
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains("before-restore-"))
            .count(),
        0
    );
}

#[test]
fn stage8_restore_safety_backup_failure_cleans_already_unpacked_staging() {
    let (_temporary, paths, db) = fixture();
    let safety = stage8_service(&paths, db);
    let archive = paths.root().join("source.zip");
    safety.backup(archive.clone()).expect("source backup");
    fs::remove_dir_all(paths.root().join("backups")).expect("remove backups dir");
    fs::write(paths.root().join("backups"), b"not a directory").expect("blocking backups file");
    assert!(safety.restore(&archive).is_err());
    assert_eq!(
        fs::read_dir(paths.root().join("restore-staging"))
            .expect("staging")
            .count(),
        0
    );
}

#[test]
fn stage8_post_swap_foreign_key_failure_rolls_back_live_database_and_media() {
    let (_temporary, paths, db) = fixture();
    db.with_write(|t| { t.execute("INSERT INTO restaurants(id,name,longitude,latitude,cuisine_key,icon_key,created_at_ms,updated_at_ms) VALUES('live','Live',0,0,'thai','thai.shop.01',1,1)",[])?; Ok(()) }).expect("live record");
    let safety = stage8_service(&paths, db.clone());
    let source = paths.root().join("valid.zip");
    safety.backup(source.clone()).expect("valid source");
    let mut source_zip =
        zip::ZipArchive::new(fs::File::open(source).expect("source zip")).expect("read source zip");
    let mut db_bytes = Vec::new();
    source_zip
        .by_name("db/foodmap.sqlite3")
        .expect("db entry")
        .read_to_end(&mut db_bytes)
        .expect("db bytes");
    let altered = paths.root().join("altered.sqlite3");
    fs::write(&altered, &db_bytes).expect("altered db");
    let c = rusqlite::Connection::open(&altered).expect("open altered");
    c.pragma_update(None, "foreign_keys", "OFF")
        .expect("disable fk");
    c.execute("INSERT INTO food_logs(id,restaurant_id,occurred_at_ms,tz_offset_minutes,note,created_at_ms,updated_at_ms) VALUES('bad','missing',1,0,'',1,1)",[]).expect("insert fk violation");
    drop(c);
    let altered_bytes = fs::read(&altered).expect("altered bytes");
    let invalid = paths.root().join("fk-invalid.zip");
    let mut out = zip::ZipWriter::new(fs::File::create(&invalid).expect("invalid zip"));
    let opts = zip::write::SimpleFileOptions::default();
    out.start_file("db/foodmap.sqlite3", opts)
        .expect("db entry");
    use std::io::Write;
    out.write_all(&altered_bytes).expect("db body");
    let manifest = serde_json::json!({"format":"foodmap-backup-v1","schemaVersion":1,"createdAtMs":1,"files":[{"path":"db/foodmap.sqlite3","sha256":sha(&altered_bytes),"bytes":altered_bytes.len()}],"restaurants":1,"foodLogs":1,"media":0,"mapPackageId":"missing","mapPackageVersion":"missing"});
    out.start_file("backup-manifest.json", opts)
        .expect("manifest entry");
    out.write_all(
        serde_json::to_string(&manifest)
            .expect("manifest json")
            .as_bytes(),
    )
    .expect("manifest body");
    out.finish().expect("finish invalid");
    let before_media = paths.media_root().join("original/live.jpg");
    fs::write(&before_media, b"live-media").expect("media");
    let before_db = fs::read(paths.database_path()).expect("live database bytes");
    assert!(safety.restore(&invalid).is_err());
    assert_eq!(
        fs::read(paths.database_path()).expect("database bytes restored"),
        before_db
    );
    let count: i64 = db
        .with_read(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM restaurants WHERE id='live'",
                [],
                |r| r.get(0),
            )?)
        })
        .expect("live db");
    assert_eq!(count, 1);
    assert_eq!(
        fs::read(&before_media).expect("media restored"),
        b"live-media"
    );
    assert_eq!(
        fs::read_dir(paths.root().join("restore-staging"))
            .expect("staging")
            .count(),
        0
    );
    assert_eq!(
        fs::read_dir(paths.root().join("db"))
            .expect("db")
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains("before-restore-"))
            .count(),
        0
    );
    let safety_archive = fs::read_dir(paths.root().join("backups"))
        .expect("backups")
        .map(|e| e.expect("entry").path())
        .find(|p| p.extension().and_then(|x| x.to_str()) == Some("zip"))
        .expect("safety");
    safety
        .inspect_restore(&safety_archive)
        .expect("inspect retained safety");
}

#[test]
fn stage8_permanent_media_delete_queues_three_relative_files_then_cleans_them() {
    let (_temporary, paths, db) = fixture();
    let now = 9_999;
    for (kind, relative) in [
        ("media_original", "a.jpg"),
        ("media_preview", "a.jpg"),
        ("media_thumbnail", "a.jpg"),
    ] {
        let path = paths
            .resolve_cleanup_path(kind, relative)
            .expect("safe fixture path");
        fs::write(path, b"fixture").expect("managed file");
    }
    db.with_write(|t| {
        t.execute("INSERT INTO restaurants(id,name,longitude,latitude,cuisine_key,icon_key,created_at_ms,updated_at_ms) VALUES('r','R',0,0,'thai','thai.shop.01',?1,?1)",[now])?;
        t.execute("INSERT INTO media(id,restaurant_id,category,sha256,original_name,mime_type,original_rel_path,preview_rel_path,thumbnail_rel_path,width,height,file_size_bytes,created_at_ms,updated_at_ms,deleted_at_ms) VALUES('m','r','food','test-sha','a.jpg','image/jpeg','a.jpg','a.jpg','a.jpg',1,1,1,?1,?1,?1)",[now])?;
        Ok(())
    }).expect("seed deleted media");
    let safety = stage8_service(&paths, db.clone());
    assert_eq!(safety.list_trash().expect("trash").items[0].entity, "media");
    safety
        .permanently_delete("media", "m")
        .expect("permanent delete");
    assert_eq!(safety.list_trash().expect("queue").cleanup_pending, 0);
    assert_eq!(safety.retry_cleanup().expect("retry has no work"), 0);
    assert!(!paths
        .resolve_cleanup_path("media_original", "a.jpg")
        .expect("path")
        .exists());
}

fn write_image(path: &std::path::Path) {
    let image = image::RgbImage::from_fn(800, 400, |x, y| {
        image::Rgb([(x % 255) as u8, (y % 255) as u8, 80])
    });
    image.save(path).expect("image fixture");
}

fn write_transparent_image(path: &std::path::Path) {
    let image = image::RgbaImage::from_pixel(2_000, 400, image::Rgba([0, 0, 0, 0]));
    image.save(path).expect("transparent image fixture");
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn write_asset_source(root: &std::path::Path, version: &str, map: &[u8]) {
    let map_root = root.join("map-default");
    let icons_root = root.join("food-icons");
    fs::create_dir_all(&map_root).expect("map source directory");
    fs::create_dir_all(icons_root.join("icons")).expect("icon source directory");
    fs::create_dir_all(icons_root.join("overlays")).expect("overlay source directory");
    fs::write(map_root.join("basemap.pmtiles"), map).expect("map asset");
    fs::write(map_root.join("style.json"), b"{}").expect("style asset");
    fs::write(icons_root.join("icons/a.png"), b"icon").expect("icon asset");
    fs::write(icons_root.join("overlays/a.png"), b"overlay").expect("overlay asset");
    fs::write(map_root.join("manifest.json"), format!("{{\"packageVersion\":\"{version}\",\"sha256\":{{\"basemap.pmtiles\":\"{}\",\"style.json\":\"{}\"}}}}", sha(map), sha(b"{}"))).expect("map manifest");
    fs::write(icons_root.join("manifest.json"), format!("{{\"assetVersion\":\"{version}\",\"icons\":{{\"a\":{{\"src\":\"icons/a.png\",\"sha256\":\"{}\"}}}},\"overlays\":{{\"a\":{{\"src\":\"overlays/a.png\",\"sha256\":\"{}\"}}}}}}", sha(b"icon"), sha(b"overlay"))).expect("icon manifest");
}

#[test]
fn asset_install_verifies_hashes_skips_valid_versions_and_rolls_back_failures() {
    let temporary = TempDir::new().expect("temporary assets");
    let source = temporary.path().join("source");
    let paths = PathResolver::from_root(temporary.path().join("app"));
    paths.ensure_directories().expect("app directories");
    write_asset_source(&source, "one", b"first");
    assets::install(&paths, &source).expect("first install");
    let installed = paths.root().join("maps/default/basemap.pmtiles");
    assert_eq!(fs::read(&installed).expect("installed map"), b"first");
    assets::install(&paths, &source).expect("matching version skip");
    fs::write(&installed, b"tampered").expect("tamper installed map");
    assets::install(&paths, &source).expect("tampered install repaired");
    assert_eq!(fs::read(&installed).expect("repaired map"), b"first");
    write_asset_source(&source, "two", b"second");
    fs::write(source.join("map-default/basemap.pmtiles"), b"corrupt")
        .expect("corrupt shipped fixture");
    assert!(assets::install(&paths, &source).is_err());
    assert_eq!(fs::read(&installed).expect("old map survives"), b"first");
}

#[test]
fn first_initialization_creates_the_database_and_records_current_migrations() {
    let (_temporary, paths, db) = fixture();
    assert!(paths.database_path().is_file());
    db.with_read(|connection| {
        let count: i64 =
            connection.query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })?;
        assert_eq!(count, 8);
        let map_centers_table: String = connection.query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='map_centers'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(map_centers_table, "map_centers");
        let foreign_keys: i64 =
            connection.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
        assert_eq!(foreign_keys, 1);
        Ok(())
    })
    .expect("migration query");
    db.with_read(|connection| {
        let journal_mode: String =
            connection.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
        assert_eq!(journal_mode, "wal");
        Ok(())
    })
    .expect("journal mode");
}

#[test]
fn repeated_initialization_does_not_reapply_the_initial_migration() {
    let temporary = TempDir::new().expect("temporary app data directory");
    let paths = PathResolver::from_root(temporary.path().to_path_buf());
    bootstrap::initialize(
        paths.clone(),
        &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources"),
        1_000,
    )
    .expect("first initialization");
    let state = bootstrap::initialize(
        paths,
        &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources"),
        2_000,
    )
    .expect("second initialization");
    state
        .db
        .with_read(|connection| {
            let count: i64 =
                connection.query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                    row.get(0)
                })?;
            assert_eq!(count, 8);
            Ok(())
        })
        .expect("migration count");
}

#[test]
fn map_icon_scale_migration_defaults_existing_restaurants_to_one() {
    let temporary = TempDir::new().expect("temporary app data directory");
    let paths = PathResolver::from_root(temporary.path().to_path_buf());
    paths.ensure_directories().expect("directories");
    let database = paths.database_path();
    let connection = rusqlite::Connection::open(&database).expect("legacy database");
    connection
        .execute_batch(include_str!("../migrations/0001_initial.sql"))
        .expect("initial schema");
    connection
        .execute(
            "INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(1,'initial',1)",
            [],
        )
        .expect("initial migration record");
    connection
        .execute_batch("ALTER TABLE file_cleanup_queue RENAME TO file_cleanup_queue_legacy; CREATE TABLE file_cleanup_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, rel_path TEXT NOT NULL, file_kind TEXT NOT NULL CHECK (file_kind IN ('media_original','media_preview','media_thumbnail','temp')), attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count>=0), last_error TEXT, created_at_ms INTEGER NOT NULL, next_attempt_at_ms INTEGER NOT NULL, UNIQUE(file_kind,rel_path)); INSERT INTO file_cleanup_queue(rel_path,file_kind,attempt_count,last_error,created_at_ms,next_attempt_at_ms) SELECT rel_path,file_kind,attempt_count,last_error,created_at_ms,next_attempt_at_ms FROM file_cleanup_queue_legacy; DROP TABLE file_cleanup_queue_legacy; CREATE INDEX idx_cleanup_queue_due ON file_cleanup_queue(next_attempt_at_ms,id);")
        .expect("legacy cleanup migration");
    connection
        .execute(
            "INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(2,'cleanup_queue_file_kind',2)",
            [],
        )
        .expect("cleanup migration record");
    connection
        .execute(
            "INSERT INTO restaurants(id,name,longitude,latitude,cuisine_key,icon_key,created_at_ms,updated_at_ms) VALUES('legacy','Legacy',0,0,'thai','thai.shop.01',1,1)",
            [],
        )
        .expect("legacy restaurant");
    drop(connection);

    let db = Db::new(database);
    db.initialize(3).expect("map icon scale migration");
    db.with_read(|connection| {
        let scale: f64 = connection.query_row(
            "SELECT map_icon_scale FROM restaurants WHERE id='legacy'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(scale, 1.0);
        let position_locked: i64 = connection.query_row(
            "SELECT position_locked FROM restaurants WHERE id='legacy'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(position_locked, 0);
        let version: String = connection.query_row(
            "SELECT name FROM schema_migrations WHERE version=3",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(version, "restaurant_map_icon_scale");
        let position_lock_version: String = connection.query_row(
            "SELECT name FROM schema_migrations WHERE version=6",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(position_lock_version, "restaurant_position_lock");
        Ok(())
    })
    .expect("migrated legacy restaurant");
}

#[test]
fn map_center_icon_scale_migration_defaults_existing_centers_to_one() {
    let connection = rusqlite::Connection::open_in_memory().expect("legacy center database");
    connection
        .execute_batch(include_str!("../migrations/0007_map_centers.sql"))
        .expect("legacy center schema");
    connection
        .execute(
            "INSERT INTO map_centers(id,name,kind,icon_variant,longitude,latitude,created_at_ms,updated_at_ms) VALUES('legacy-center','家','home',1,113.3,23.1,1,1)",
            [],
        )
        .expect("legacy center");
    connection
        .execute_batch(include_str!("../migrations/0008_map_center_icon_scale.sql"))
        .expect("center icon scale migration");

    let scale: f64 = connection
        .query_row(
            "SELECT map_icon_scale FROM map_centers WHERE id='legacy-center'",
            [],
            |row| row.get(0),
        )
        .expect("migrated center scale");
    assert_eq!(scale, 1.0);
}

#[test]
fn map_center_icon_scale_round_trips_and_rejects_values_outside_the_control_range() {
    let (_temporary, _paths, db) = fixture();
    let service = MapCenterService::new(db);
    let created = service
        .create(
            "家".into(),
            "home".into(),
            1,
            0.25,
            113.3,
            23.1,
            RegionBounds {
                west: 113.2,
                south: 23.0,
                east: 113.4,
                north: 23.2,
            },
        )
        .expect("create scaled center");
    assert_eq!(created.map_icon_scale, 0.25);

    let updated = service
        .update(
            created.id.clone(),
            created.name.clone(),
            created.kind.clone(),
            created.icon_variant,
            2.5,
        )
        .expect("update center scale");
    assert_eq!(updated.map_icon_scale, 2.5);
    assert_eq!(service.list().expect("list centers")[0].map_icon_scale, 2.5);

    assert!(service
        .update(
            created.id.clone(),
            created.name.clone(),
            created.kind.clone(),
            created.icon_variant,
            0.24,
        )
        .is_err());
    assert!(service
        .update(
            created.id,
            created.name,
            created.kind,
            created.icon_variant,
            2.51,
        )
        .is_err());
}

#[test]
fn cuisine_taxonomy_migration_maps_every_legacy_pair_and_preserves_unrelated_columns() {
    let temporary = TempDir::new().expect("temporary migration directory");
    let paths = PathResolver::from_root(temporary.path().to_path_buf());
    paths.ensure_directories().expect("directories");
    let database = paths.database_path();
    let connection = rusqlite::Connection::open(&database).expect("legacy database");
    connection
        .execute_batch(include_str!("../migrations/0001_initial.sql"))
        .expect("initial schema");
    connection
        .execute(
            "INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(1,'initial',1)",
            [],
        )
        .expect("initial migration record");
    connection
        .execute_batch("ALTER TABLE file_cleanup_queue RENAME TO file_cleanup_queue_legacy; CREATE TABLE file_cleanup_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, rel_path TEXT NOT NULL, file_kind TEXT NOT NULL CHECK (file_kind IN ('media_original','media_preview','media_thumbnail','temp')), attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count>=0), last_error TEXT, created_at_ms INTEGER NOT NULL, next_attempt_at_ms INTEGER NOT NULL, UNIQUE(file_kind,rel_path)); INSERT INTO file_cleanup_queue(rel_path,file_kind,attempt_count,last_error,created_at_ms,next_attempt_at_ms) SELECT rel_path,file_kind,attempt_count,last_error,created_at_ms,next_attempt_at_ms FROM file_cleanup_queue_legacy; DROP TABLE file_cleanup_queue_legacy; CREATE INDEX idx_cleanup_queue_due ON file_cleanup_queue(next_attempt_at_ms,id);")
        .expect("cleanup migration");
    connection
        .execute(
            "INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(2,'cleanup_queue_file_kind',2)",
            [],
        )
        .expect("cleanup migration record");
    connection
        .execute_batch(include_str!(
            "../migrations/0003_restaurant_map_icon_scale.sql"
        ))
        .expect("map icon scale migration");
    connection
        .execute(
            "INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(3,'restaurant_map_icon_scale',3)",
            [],
        )
        .expect("map icon scale migration record");

    let legacy = [
        ("hotpot", "hotpot"),
        ("thai", "southeast_asian"),
        ("vietnamese", "southeast_asian"),
        ("indian", "south_asian"),
        ("cantonese", "cantonese"),
        ("noodles", "rice_noodles"),
        ("congee", "fast_meal"),
        ("dimsum", "dimsum_dumpling"),
        ("cafe", "coffee"),
        ("bakery", "bakery_pastry"),
        ("western", "pasta_pizza"),
        ("other", "snacks"),
    ];
    for (index, (old_key, _new_key)) in legacy.iter().enumerate() {
        let suffix = format!("{:02}", (index % 3) + 1);
        connection
            .execute(
                "INSERT INTO restaurants(id,name,longitude,latitude,cuisine_key,icon_key,phone,opening_hours_text,address_note,visit_status,affection_status,is_bookmarked,overall_rating,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'visited','favorite',1,?10,?11,?12)",
                rusqlite::params![
                    format!("legacy-{index}"),
                    format!("Legacy place {index}"),
                    113.3 + index as f64 / 1_000.0,
                    23.1 + index as f64 / 1_000.0,
                    old_key,
                    format!("{old_key}.shop.{suffix}"),
                    format!("phone-{index}"),
                    format!("hours-{index}"),
                    format!("note-{index}"),
                    (index % 5 + 1) as i64,
                    10_000 + index as i64,
                    20_000 + index as i64,
                ],
            )
            .expect("legacy restaurant");
    }
    drop(connection);

    let db = Db::new(database);
    db.initialize(4_000).expect("cuisine taxonomy migration");
    db.with_read(|connection| {
        for (index, (_old_key, new_key)) in legacy.iter().enumerate() {
            let suffix = format!("{:02}", (index % 3) + 1);
            let row = connection.query_row(
                "SELECT cuisine_key,icon_key,name,longitude,latitude,phone,opening_hours_text,address_note,visit_status,affection_status,is_bookmarked,overall_rating,created_at_ms,updated_at_ms FROM restaurants WHERE id=?1",
                [format!("legacy-{index}")],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, f64>(3)?,
                        row.get::<_, f64>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, i64>(10)?,
                        row.get::<_, i64>(11)?,
                        row.get::<_, i64>(12)?,
                        row.get::<_, i64>(13)?,
                    ))
                },
            )?;
            assert_eq!(row.0, *new_key);
            assert_eq!(row.1, format!("{new_key}.shop.{suffix}"));
            assert_eq!(row.2, format!("Legacy place {index}"));
            assert!((row.3 - (113.3 + index as f64 / 1_000.0)).abs() < f64::EPSILON);
            assert!((row.4 - (23.1 + index as f64 / 1_000.0)).abs() < f64::EPSILON);
            assert_eq!(row.5, format!("phone-{index}"));
            assert_eq!(row.6, format!("hours-{index}"));
            assert_eq!(row.7, format!("note-{index}"));
            assert_eq!(row.8, "visited");
            assert_eq!(row.9, "favorite");
            assert_eq!(row.10, 1);
            assert_eq!(row.11, (index % 5 + 1) as i64);
            assert_eq!(row.12, 10_000 + index as i64);
            assert_eq!(row.13, 20_000 + index as i64);
        }
        let version: String = connection.query_row(
            "SELECT name FROM schema_migrations WHERE version=4",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(version, "cuisine_taxonomy");
        Ok(())
    })
    .expect("migrated legacy restaurants");
}

#[test]
fn database_constraints_and_foreign_key_check_hold() {
    let (_temporary, _paths, db) = fixture();
    assert!(db
        .with_write(|transaction| {
            transaction.execute(
                "INSERT INTO restaurants (id, name, longitude, latitude, cuisine_key, icon_key, created_at_ms, updated_at_ms) VALUES ('r1', '', 0, 0, 'thai', 'thai.shop.01', 1, 1)",
                [],
            )?;
            Ok(())
        })
        .is_err());

    for (id, longitude, latitude, rating) in [
        ("r2", 181.0, 0.0, None),
        ("r3", 0.0, 91.0, None),
        ("r4", 0.0, 0.0, Some(6)),
    ] {
        assert!(db
            .with_write(|transaction| {
                transaction.execute(
                    "INSERT INTO restaurants (id, name, longitude, latitude, cuisine_key, icon_key, overall_rating, created_at_ms, updated_at_ms) VALUES (?1, 'Valid name', ?2, ?3, 'thai', 'thai.shop.01', ?4, 1, 1)",
                    params![id, longitude, latitude, rating],
                )?;
                Ok(())
            })
            .is_err());
    }

    db.with_read(|connection| {
        let violations: i64 =
            connection.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })?;
        assert_eq!(violations, 0);
        Ok(())
    })
    .expect("foreign-key check");
}

#[test]
fn schema_enums_ranges_and_foreign_keys_reject_invalid_data() {
    let (_temporary, _paths, db) = fixture();
    db.with_write(|transaction| {
        transaction.execute(
            "INSERT INTO restaurants (id, name, longitude, latitude, cuisine_key, icon_key, created_at_ms, updated_at_ms) VALUES ('restaurant', 'Valid name', 0, 0, 'thai', 'thai.shop.01', 1, 1)",
            [],
        )?;
        Ok(())
    })
    .expect("valid restaurant");

    for statement in [
        "INSERT INTO restaurants (id, name, longitude, latitude, cuisine_key, icon_key, visit_status, created_at_ms, updated_at_ms) VALUES ('bad-visit', 'Valid name', 0, 0, 'thai', 'thai.shop.01', 'invalid', 1, 1)",
        "INSERT INTO restaurants (id, name, longitude, latitude, cuisine_key, icon_key, affection_status, created_at_ms, updated_at_ms) VALUES ('bad-affection', 'Valid name', 0, 0, 'thai', 'thai.shop.01', 'invalid', 1, 1)",
        "INSERT INTO restaurants (id, name, longitude, latitude, cuisine_key, icon_key, is_bookmarked, created_at_ms, updated_at_ms) VALUES ('bad-bookmark', 'Valid name', 0, 0, 'thai', 'thai.shop.01', 2, 1, 1)",
        "INSERT INTO food_logs (id, restaurant_id, occurred_at_ms, tz_offset_minutes, meal_type, created_at_ms, updated_at_ms) VALUES ('bad-meal', 'restaurant', 1, 0, 'invalid', 1, 1)",
        "INSERT INTO food_logs (id, restaurant_id, occurred_at_ms, tz_offset_minutes, dining_mode, created_at_ms, updated_at_ms) VALUES ('bad-mode', 'restaurant', 1, 0, 'invalid', 1, 1)",
        "INSERT INTO food_logs (id, restaurant_id, occurred_at_ms, tz_offset_minutes, created_at_ms, updated_at_ms) VALUES ('bad-offset', 'restaurant', 1, 841, 1, 1)",
        "INSERT INTO food_logs (id, restaurant_id, occurred_at_ms, tz_offset_minutes, created_at_ms, updated_at_ms) VALUES ('bad-foreign-key', 'missing', 1, 0, 1, 1)",
        "INSERT INTO media (id, restaurant_id, category, sha256, original_name, mime_type, original_rel_path, preview_rel_path, thumbnail_rel_path, width, height, file_size_bytes, created_at_ms, updated_at_ms) VALUES ('bad-category', 'restaurant', 'invalid', 'hash-1', 'a.jpg', 'image/jpeg', 'original/a.jpg', 'preview/a.jpg', 'thumbnail/a.jpg', 1, 1, 0, 1, 1)",
        "INSERT INTO media (id, restaurant_id, category, sha256, original_name, mime_type, original_rel_path, preview_rel_path, thumbnail_rel_path, width, height, file_size_bytes, created_at_ms, updated_at_ms) VALUES ('bad-width', 'restaurant', 'food', 'hash-2', 'b.jpg', 'image/jpeg', 'original/b.jpg', 'preview/b.jpg', 'thumbnail/b.jpg', 0, 1, 0, 1, 1)",
        "INSERT INTO media (id, restaurant_id, category, sha256, original_name, mime_type, original_rel_path, preview_rel_path, thumbnail_rel_path, width, height, file_size_bytes, created_at_ms, updated_at_ms) VALUES ('bad-height', 'restaurant', 'food', 'hash-3', 'c.jpg', 'image/jpeg', 'original/c.jpg', 'preview/c.jpg', 'thumbnail/c.jpg', 1, 0, 0, 1, 1)",
        "INSERT INTO media (id, restaurant_id, category, sha256, original_name, mime_type, original_rel_path, preview_rel_path, thumbnail_rel_path, width, height, file_size_bytes, created_at_ms, updated_at_ms) VALUES ('bad-size', 'restaurant', 'food', 'hash-4', 'd.jpg', 'image/jpeg', 'original/d.jpg', 'preview/d.jpg', 'thumbnail/d.jpg', 1, 1, -1, 1, 1)",
    ] {
        assert!(db
            .with_write(|transaction| {
                transaction.execute(statement, [])?;
                Ok(())
            })
            .is_err(), "statement must be rejected: {statement}");
    }
}

#[test]
fn cleanup_queue_removes_due_temp_files_and_rejects_traversal() {
    let (_temporary, paths, db) = fixture();
    let cleanup_file = paths
        .cleanup_root("temp")
        .expect("temp root")
        .join("old.tmp");
    fs::write(&cleanup_file, "orphan").expect("temporary file");
    db.with_write(|transaction| {
        transaction.execute(
            "INSERT INTO file_cleanup_queue (rel_path, file_kind, created_at_ms, next_attempt_at_ms) VALUES (?1, 'temp', 1, 1)",
            params!["old.tmp"],
        )?;
        Ok(())
    })
    .expect("enqueue cleanup");

    assert_eq!(cleanup::run_due(&db, &paths, 1).expect("run cleanup"), 1);
    assert!(!cleanup_file.exists());
    assert!(paths.resolve_cleanup_path("temp", "../outside").is_err());
}

#[test]
fn local_server_serves_exact_ranges_with_local_cors_and_rejects_bad_requests() {
    tauri::async_runtime::block_on(async {
        let temporary = TempDir::new().expect("temporary server root");
        let file = temporary.path().join("maps/default/sample.pmtiles");
        fs::create_dir_all(file.parent().expect("file parent")).expect("map directory");
        fs::write(&file, b"0123456789").expect("map fixture");
        fs::write(temporary.path().join("maps/default/font.pbf"), b"font").expect("font fixture");
        fs::write(temporary.path().join("maps/default/style.json"), b"{}").expect("json fixture");
        fs::create_dir_all(temporary.path().join("media")).expect("media directory");
        fs::write(temporary.path().join("media/clip.mp4"), b"mp4 fixture").expect("mp4 fixture");
        fs::write(temporary.path().join("media/clip.webm"), b"webm fixture").expect("webm fixture");
        fs::create_dir_all(temporary.path().join("assets/icons")).expect("asset directory");
        fs::write(temporary.path().join("assets/icons/icon.png"), b"png").expect("png fixture");
        fs::write(temporary.path().join("assets/icons/unknown.bin"), b"bin")
            .expect("unknown fixture");
        let server = LocalServer::start(temporary.path().to_path_buf())
            .await
            .expect("server");
        let target = server
            .origin
            .strip_prefix("http://")
            .expect("server origin");
        let (address, prefix) = target.split_once('/').expect("origin prefix");

        async fn request(address: &str, request: String) -> String {
            let mut stream = tokio::net::TcpStream::connect(address)
                .await
                .expect("connect");
            stream
                .write_all(request.as_bytes())
                .await
                .expect("write request");
            let mut response = Vec::new();
            stream
                .read_to_end(&mut response)
                .await
                .expect("read response");
            String::from_utf8(response).expect("utf8 response")
        }

        let response = request(address, format!("GET /{prefix}/maps/default/sample.pmtiles HTTP/1.1\r\nHost: {address}\r\nOrigin: http://tauri.localhost\r\nRange: bytes=2-5\r\nConnection: close\r\n\r\n")).await;
        assert!(response.starts_with("HTTP/1.1 206"));
        assert!(response.contains("content-range: bytes 2-5/10"));
        assert!(response.contains("access-control-allow-origin: http://tauri.localhost"));
        assert!(response.contains("etag: \""));
        assert!(response.contains("cache-control: public, max-age=31536000, immutable"));
        assert!(response.ends_with("2345"));

        for (path, content_type) in [
            ("maps/default/font.pbf", "application/x-protobuf"),
            ("maps/default/style.json", "application/json"),
            ("assets/icons/icon.png", "image/png"),
            ("media/clip.mp4", "video/mp4"),
            ("media/clip.webm", "video/webm"),
        ] {
            let response = request(
                address,
                format!(
                    "GET /{prefix}/{path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
                ),
            )
            .await;
            assert!(response.starts_with("HTTP/1.1 200"));
            assert!(response.contains(&format!("content-type: {content_type}")));
        }
        for (path, content_type, body) in [
            ("media/clip.mp4", "video/mp4", "p4 "),
            ("media/clip.webm", "video/webm", "ebm"),
        ] {
            let response = request(
                address,
                format!(
                    "GET /{prefix}/{path} HTTP/1.1\r\nHost: {address}\r\nRange: bytes=1-3\r\nConnection: close\r\n\r\n"
                ),
            )
            .await;
            assert!(response.starts_with("HTTP/1.1 206"));
            assert!(response.contains(&format!("content-type: {content_type}")));
            assert!(response.contains("content-range: bytes 1-3/"));
            assert!(response.ends_with(body));
        }
        let unknown = request(address, format!("GET /{prefix}/assets/icons/unknown.bin HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n")).await;
        assert!(unknown.starts_with("HTTP/1.1 415"));

        let invalid = request(address, format!("GET /{prefix}/maps/default/sample.pmtiles HTTP/1.1\r\nHost: {address}\r\nRange: bytes=99-100\r\nConnection: close\r\n\r\n")).await;
        assert!(invalid.starts_with("HTTP/1.1 416"));
        assert!(invalid.contains("content-range: bytes */10"));

        let rejected = request(address, format!("POST /{prefix}/maps/default/sample.pmtiles HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n")).await;
        assert!(rejected.starts_with("HTTP/1.1 405"));

        for path in [
            format!("/{prefix}/secrets/default/style.json"),
            format!("/{prefix}/maps/../default/style.json"),
            format!("/{prefix}/maps/%2e%2e/default/style.json"),
        ] {
            let response = request(
                address,
                format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"),
            )
            .await;
            assert!(response.starts_with("HTTP/1.1 400") || response.starts_with("HTTP/1.1 404"));
        }
    });
}

#[test]
fn csp_allows_only_loopback_map_images_and_fonts() {
    let config = include_str!("../tauri.conf.json");
    assert!(config.contains("img-src 'self' asset: http://asset.localhost http://127.0.0.1:*"));
    assert!(config.contains("font-src 'self' http://127.0.0.1:* data:"));
}

#[test]
fn bootstrap_manifest_parser_accepts_utf8_bom() {
    assert_eq!(
        crate::commands::bootstrap::manifest("\u{feff}{\"packageVersion\":\"one\"}")
            .expect("BOM manifest"),
        serde_json::json!({ "packageVersion": "one" })
    );
}

#[test]
fn restaurant_service_persists_full_stage_four_lifecycle() {
    let (_temporary, paths, db) = fixture();
    let service = restaurant_service(&paths, db.clone());

    let created = service
        .create(
            "  Thai Place  ".into(),
            121.5,
            25.03,
            "thai".into(),
            "thai.shop.01".into(),
        )
        .expect("create restaurant");
    assert_eq!(created.name, "Thai Place");
    assert_eq!(created.id.len(), 36);
    assert_eq!(&created.id[14..15], "7", "restaurant ID is UUIDv7");
    assert_eq!(created.map_icon_scale, 1.0);
    assert!(!created.position_locked);

    let profile = service
        .update_profile(
            created.id.clone(),
            "Thai Place Updated".into(),
            "thai".into(),
            "thai.shop.02".into(),
            1.25,
            Some("12345".into()),
            Some("10:00-22:00".into()),
            Some("Near the station".into()),
        )
        .expect("update profile");
    assert_eq!(profile.icon_key, "southeast_asian.shop.02");
    assert_eq!(profile.map_icon_scale, 1.25);
    assert_eq!(profile.phone.as_deref(), Some("12345"));

    let status = service
        .update_status(
            created.id.clone(),
            Some("visited".into()),
            Some("favorite".into()),
            Some(true),
            Some(Some(5)),
        )
        .expect("update status");
    assert_eq!(status.visit_status, "visited");
    assert!(status.is_bookmarked);
    assert_eq!(status.overall_rating, Some(5));

    let moved = service
        .move_to(created.id.clone(), 121.51, 25.04)
        .expect("move restaurant");
    assert_eq!((moved.longitude, moved.latitude), (121.51, 25.04));

    let locked = service
        .set_position_locked(created.id.clone(), true)
        .expect("lock restaurant position");
    assert!(locked.position_locked);
    assert!(service.move_to(created.id.clone(), 121.52, 25.05).is_err());

    let tag = service
        .create_tag("  Favorite  ".into())
        .expect("create tag");
    assert_eq!(tag.name, "Favorite");
    assert_eq!(&tag.id[14..15], "7", "tag ID is UUIDv7");
    let tag = service
        .rename_tag(tag.id, "Top pick".into())
        .expect("rename tag");
    service
        .set_tag(created.id.clone(), tag.id.clone(), true)
        .expect("associate tag");

    let persisted = restaurant_service(&paths, db.clone())
        .get(created.id.clone())
        .expect("read persisted restaurant")
        .expect("active restaurant");
    assert_eq!(persisted.name, "Thai Place Updated");
    assert_eq!(persisted.tags.len(), 1);
    assert_eq!(persisted.tags[0].name, "Top pick");
    assert!(persisted.position_locked);

    let map = service.list_map().expect("map dto");
    assert_eq!(map.len(), 1);
    assert_eq!(map[0].id, created.id);
    assert_eq!(map[0].overall_rating, Some(5));
    assert_eq!(map[0].map_icon_scale, 1.25);
    assert!(map[0].position_locked);
    assert!(map[0].is_bookmarked);

    service
        .soft_delete(created.id.clone())
        .expect("soft delete restaurant");
    assert!(service
        .get(created.id.clone())
        .expect("get deleted")
        .is_none());
    assert!(service.list_map().expect("map without deleted").is_empty());

    let restored = service
        .restore(created.id.clone())
        .expect("restore restaurant");
    assert_eq!(restored.id, created.id);
    assert_eq!(restored.tags[0].id, tag.id);

    service.delete_tag(tag.id).expect("delete tag");
    assert!(service.list_tags().expect("list tags").is_empty());
    assert!(service
        .get(created.id)
        .expect("get restaurant after tag delete")
        .expect("restaurant remains")
        .tags
        .is_empty());
}

#[test]
fn restaurant_service_rejects_invalid_stage_four_inputs() {
    let (_temporary, paths, db) = fixture();
    let service = restaurant_service(&paths, db);

    for (name, longitude, latitude, cuisine, icon) in [
        (" ", 0.0, 0.0, "thai", "thai.shop.01"),
        ("Valid", f64::NAN, 0.0, "thai", "thai.shop.01"),
        ("Valid", 0.0, 91.0, "thai", "thai.shop.01"),
        ("Valid", 0.0, 0.0, "thai", "hotpot.shop.01"),
        ("Valid", 0.0, 0.0, "missing", "thai.shop.01"),
    ] {
        assert!(service
            .create(
                name.into(),
                longitude,
                latitude,
                cuisine.into(),
                icon.into()
            )
            .is_err());
    }

    let restaurant = service
        .create(
            "Valid".into(),
            0.0,
            0.0,
            "thai".into(),
            "thai.shop.01".into(),
        )
        .expect("valid restaurant");
    assert!(service
        .update_status(
            restaurant.id.clone(),
            Some("invalid".into()),
            None,
            None,
            None,
        )
        .is_err());
    assert!(service
        .update_status(restaurant.id, None, None, None, Some(Some(6)))
        .is_err());
    let restaurant = service
        .create(
            "Scale validation".into(),
            0.0,
            0.0,
            "thai".into(),
            "thai.shop.01".into(),
        )
        .expect("scale validation restaurant");
    for scale in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.74, 1.51] {
        assert!(service
            .update_profile(
                restaurant.id.clone(),
                "Scale validation".into(),
                "thai".into(),
                "thai.shop.01".into(),
                scale,
                None,
                None,
                None,
            )
            .is_err());
    }
    assert!(service.create_tag(" ".into()).is_err());
}

#[test]
fn food_log_service_persists_paginated_lifecycle_and_updates_map_count() {
    let (_temporary, paths, db) = fixture();
    let restaurants = restaurant_service(&paths, db.clone());
    let logs = food_log_service(db.clone());
    let restaurant = restaurants
        .create(
            "Log place".into(),
            121.5,
            25.0,
            "thai".into(),
            "thai.shop.01".into(),
        )
        .expect("restaurant");
    let first = logs
        .create(
            restaurant.id.clone(),
            2_000,
            480,
            Some("dinner".into()),
            Some("dine_in".into()),
            Some("First".into()),
            "note".into(),
            Some(5),
        )
        .expect("first log");
    assert_eq!(&first.id[14..15], "7", "FoodLog ID is UUIDv7");
    assert_eq!(
        restaurants
            .get(restaurant.id.clone())
            .expect("restaurant")
            .expect("active")
            .visit_status,
        "visited"
    );
    assert_eq!(restaurants.list_map().expect("map")[0].log_count, 1);
    let second = logs
        .create(
            restaurant.id.clone(),
            3_000,
            480,
            None,
            Some("takeaway".into()),
            None,
            "".into(),
            None,
        )
        .expect("second log");
    let page = logs
        .list(restaurant.id.clone(), None, Some(1))
        .expect("first page");
    assert_eq!(page.items[0].id, second.id);
    let next = page.next_cursor.expect("next cursor");
    let page = logs
        .list(restaurant.id.clone(), Some(next), Some(1))
        .expect("second page");
    assert_eq!(page.items[0].id, first.id);
    let updated = logs
        .update(
            first.id.clone(),
            4_000,
            480,
            Some("lunch".into()),
            None,
            Some("Updated".into()),
            "updated note".into(),
            None,
        )
        .expect("update");
    assert_eq!(updated.rating, None);
    assert_eq!(updated.title.as_deref(), Some("Updated"));
    logs.soft_delete(second.id.clone()).expect("soft delete");
    assert_eq!(restaurants.list_map().expect("map")[0].log_count, 1);
    let restored = logs.restore(second.id).expect("restore");
    assert_eq!(restored.restaurant_id, restaurant.id);
    assert_eq!(restaurants.list_map().expect("map")[0].log_count, 2);
    let persisted = food_log_service(db)
        .list(restaurant.id, None, Some(10))
        .expect("persisted logs");
    assert_eq!(persisted.items.len(), 2);
}

#[test]
fn food_log_service_validates_inputs_and_only_promotes_first_log_status() {
    let (_temporary, paths, db) = fixture();
    let restaurants = restaurant_service(&paths, db.clone());
    let logs = food_log_service(db);
    let frequent = restaurants
        .create(
            "Frequent place".into(),
            121.5,
            25.0,
            "thai".into(),
            "thai.shop.01".into(),
        )
        .expect("restaurant");
    restaurants
        .update_status(
            frequent.id.clone(),
            Some("frequent".into()),
            None,
            None,
            None,
        )
        .expect("frequent");
    logs.create(frequent.id.clone(), 1, 0, None, None, None, "".into(), None)
        .expect("valid log");
    assert_eq!(
        restaurants
            .get(frequent.id.clone())
            .expect("get")
            .expect("restaurant")
            .visit_status,
        "frequent"
    );
    for (time, offset, meal, mode, rating) in [
        (0, 0, None, None, None),
        (1, 841, None, None, None),
        (1, 0, Some("invalid"), None, None),
        (1, 0, None, Some("invalid"), None),
        (1, 0, None, None, Some(6)),
    ] {
        assert!(logs
            .create(
                frequent.id.clone(),
                time,
                offset,
                meal.map(str::to_owned),
                mode.map(str::to_owned),
                None,
                "".into(),
                rating
            )
            .is_err());
    }
    restaurants
        .soft_delete(frequent.id.clone())
        .expect("delete restaurant");
    assert!(logs
        .create(frequent.id, 1, 0, None, None, None, "".into(), None)
        .is_err());
}

#[test]
fn media_pipeline_copies_derives_deduplicates_and_survives_source_removal() {
    let (temporary, paths, db) = fixture();
    let restaurants = restaurant_service(&paths, db.clone());
    let logs = food_log_service(db.clone());
    let media = media_service(&paths, db);
    let restaurant = restaurants
        .create(
            "Image place".into(),
            121.5,
            25.0,
            "thai".into(),
            "thai.shop.01".into(),
        )
        .expect("restaurant");
    let log = logs
        .create(
            restaurant.id.clone(),
            10,
            0,
            None,
            None,
            None,
            "".into(),
            None,
        )
        .expect("log");
    let source = temporary.path().join("meal.png");
    write_image(&source);
    let result = media
        .import(
            restaurant.id.clone(),
            Some(log.id.clone()),
            "food".into(),
            vec![
                source.to_string_lossy().into_owned(),
                temporary
                    .path()
                    .join("missing.jpg")
                    .to_string_lossy()
                    .into_owned(),
            ],
        )
        .expect("import");
    assert_eq!(result.results.len(), 2);
    assert!(result.results[1].error.is_some());
    let imported = result.results[0].media.clone().unwrap_or_else(|| {
        panic!(
            "media: {}",
            result.results[0].error.as_deref().unwrap_or("unknown")
        )
    });
    assert_eq!(imported.food_log_id.as_deref(), Some(log.id.as_str()));
    assert_eq!(imported.width, 800);
    assert!(paths
        .media_root()
        .join(&imported.original_rel_path)
        .is_file());
    assert!(paths
        .media_root()
        .join(&imported.preview_rel_path)
        .is_file());
    let thumbnail =
        image::open(paths.media_root().join(&imported.thumbnail_rel_path)).expect("thumbnail");
    assert!(thumbnail.width() <= 384 && thumbnail.height() <= 384);
    let preview =
        image::open(paths.media_root().join(&imported.preview_rel_path)).expect("preview");
    assert_eq!(preview.width(), 800);
    assert_eq!(preview.color(), image::ColorType::Rgb8);
    std::fs::remove_file(&source).expect("remove source");
    assert!(media
        .original_path(imported.id.clone())
        .expect("managed original")
        .is_file());
    let repeated = media
        .import(
            restaurant.id,
            None,
            "food".into(),
            vec![paths
                .media_root()
                .join(&imported.original_rel_path)
                .to_string_lossy()
                .into_owned()],
        )
        .expect("batch result");
    assert!(repeated.results[0]
        .code
        .as_deref()
        .is_some_and(|code| code == "DUPLICATE_MEDIA"));
    assert_eq!(
        repeated.results[0]
            .existing_media
            .as_ref()
            .map(|media| media.id.as_str()),
        Some(imported.id.as_str())
    );
}

#[test]
fn video_media_imports_both_formats_with_posters_and_lifecycle_association() {
    let (temporary, paths, db) = fixture();
    let restaurants = restaurant_service(&paths, db.clone());
    let logs = food_log_service(db.clone());
    let media = media_service(&paths, db);
    let restaurant = restaurants
        .create(
            "Video place".into(),
            121.5,
            25.0,
            "thai".into(),
            "thai.shop.01".into(),
        )
        .expect("restaurant");
    let log = logs
        .create(
            restaurant.id.clone(),
            10,
            0,
            None,
            None,
            Some("video dinner".into()),
            "".into(),
            None,
        )
        .expect("log");
    let mp4 = temporary.path().join("dinner.mp4");
    let webm = temporary.path().join("dinner.webm");
    fs::write(&mp4, b"minimal mp4 bytes").expect("mp4 source");
    fs::write(&webm, b"minimal webm bytes").expect("webm source");

    let mut imported = media
        .import(
            restaurant.id.clone(),
            Some(log.id.clone()),
            "food".into(),
            vec![
                mp4.to_string_lossy().into_owned(),
                webm.to_string_lossy().into_owned(),
            ],
        )
        .expect("video import")
        .results
        .into_iter()
        .map(|result| result.media.expect("video record"))
        .collect::<Vec<_>>();
    assert_eq!(imported.len(), 2);
    imported.sort_by(|a, b| a.mime_type.cmp(&b.mime_type));
    for record in &imported {
        assert!(matches!(
            record.mime_type.as_str(),
            "video/mp4" | "video/webm"
        ));
        assert_eq!(record.food_log_id.as_deref(), Some(log.id.as_str()));
        assert_eq!((record.width, record.height), (1_600, 900));
        assert_eq!(
            record.file_size_bytes,
            fs::metadata(if record.mime_type == "video/mp4" {
                &mp4
            } else {
                &webm
            })
            .expect("source metadata")
            .len() as i64
        );
        assert!(record
            .original_rel_path
            .ends_with(if record.mime_type == "video/mp4" {
                ".mp4"
            } else {
                ".webm"
            }));
        let original = paths.media_root().join(&record.original_rel_path);
        let preview = paths.media_root().join(&record.preview_rel_path);
        let thumbnail = paths.media_root().join(&record.thumbnail_rel_path);
        assert!(original.is_file());
        assert!(preview.is_file());
        assert!(thumbnail.is_file());
        assert_eq!(
            image::open(preview).expect("video poster").dimensions(),
            (1_600, 900)
        );
        assert_eq!(
            image::open(thumbnail)
                .expect("video thumbnail")
                .dimensions(),
            (384, 216)
        );
    }

    let duplicate = media
        .import(
            restaurant.id.clone(),
            None,
            "other".into(),
            vec![mp4.to_string_lossy().into_owned()],
        )
        .expect("duplicate result");
    assert_eq!(
        duplicate.results[0].code.as_deref(),
        Some("DUPLICATE_MEDIA")
    );
    assert_eq!(
        duplicate.results[0]
            .existing_media
            .as_ref()
            .map(|record| record.id.as_str()),
        Some(
            imported
                .iter()
                .find(|record| record.mime_type == "video/mp4")
                .expect("mp4 record")
                .id
                .as_str(),
        )
    );

    let video = imported
        .iter()
        .find(|record| record.mime_type == "video/webm")
        .expect("webm record");
    media
        .soft_delete(video.id.clone())
        .expect("soft delete video");
    assert!(media
        .list(Some(restaurant.id.clone()), None, None, None, Some(100))
        .expect("list after delete")
        .items
        .iter()
        .all(|record| record.id != video.id));
    let restored = media.restore(video.id.clone()).expect("restore video");
    assert_eq!(restored.mime_type, "video/webm");
    assert_eq!(restored.food_log_id.as_deref(), Some(log.id.as_str()));
}

#[test]
fn video_media_backup_restore_keeps_all_three_managed_files() {
    let (temporary, paths, db) = fixture();
    let restaurants = restaurant_service(&paths, db.clone());
    let media = media_service(&paths, db.clone());
    let safety = stage8_service(&paths, db.clone());
    let restaurant = restaurants
        .create(
            "Video backup place".into(),
            121.5,
            25.0,
            "thai".into(),
            "thai.shop.01".into(),
        )
        .expect("restaurant");
    let source = temporary.path().join("backup.webm");
    fs::write(&source, b"backup webm bytes").expect("webm source");
    let imported = media
        .import(
            restaurant.id,
            None,
            "other".into(),
            vec![source.to_string_lossy().into_owned()],
        )
        .expect("video import")
        .results
        .into_iter()
        .next()
        .and_then(|result| result.media)
        .expect("video record");
    let archive = temporary.path().join("video.foodmap-backup.zip");
    safety.backup(archive.clone()).expect("video backup");

    let clean_root = TempDir::new().expect("clean root");
    let clean_paths = PathResolver::from_root(clean_root.path().to_path_buf());
    let clean_state = bootstrap::initialize(
        clean_paths.clone(),
        &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources"),
        2_000,
    )
    .expect("initialize clean root");
    stage8_service(&clean_paths, clean_state.db.clone())
        .restore(&archive)
        .expect("video restore");
    let restored = media_service(&clean_paths, clean_state.db)
        .list(None, None, None, None, Some(100))
        .expect("restored media")
        .items
        .into_iter()
        .find(|record| record.mime_type == "video/webm")
        .expect("restored video record");
    for relative in [
        restored.original_rel_path,
        restored.preview_rel_path,
        restored.thumbnail_rel_path,
    ] {
        assert!(clean_paths.media_root().join(relative).is_file());
    }
    assert_eq!(restored.original_name, imported.original_name);
}

#[test]
fn media_derivatives_use_bounded_jpeg_sizes_and_neutralize_transparency() {
    let (temporary, paths, db) = fixture();
    let restaurants = restaurant_service(&paths, db.clone());
    let media = media_service(&paths, db);
    let restaurant = restaurants
        .create(
            "Transparent".into(),
            0.0,
            0.0,
            "thai".into(),
            "thai.shop.01".into(),
        )
        .expect("restaurant");
    let source = temporary.path().join("transparent.png");
    write_transparent_image(&source);
    let mut imported_result = media
        .import(
            restaurant.id,
            None,
            "food".into(),
            vec![source.to_string_lossy().into_owned()],
        )
        .expect("import");
    let imported = imported_result.results.remove(0).media.expect("media");
    let preview =
        image::open(paths.media_root().join(&imported.preview_rel_path)).expect("preview");
    let thumbnail =
        image::open(paths.media_root().join(&imported.thumbnail_rel_path)).expect("thumbnail");
    assert_eq!(preview.color(), image::ColorType::Rgb8);
    assert_eq!(thumbnail.color(), image::ColorType::Rgb8);
    assert_eq!(preview.width(), 1_600);
    assert_eq!(thumbnail.width(), 384);
    let pixel = preview.to_rgb8().get_pixel(0, 0).0;
    assert!(pixel.iter().all(|channel| *channel >= 235), "{pixel:?}");
}

#[test]
fn concurrent_media_services_share_placement_lock_and_report_cross_restaurant_duplicate() {
    let (temporary, paths, db) = fixture();
    let restaurants = restaurant_service(&paths, db.clone());
    let first_media = media_service(&paths, db.clone());
    let second_media = media_service(&paths, db);
    let first = restaurants
        .create(
            "First".into(),
            0.0,
            0.0,
            "thai".into(),
            "thai.shop.01".into(),
        )
        .expect("first restaurant");
    let second = restaurants
        .create(
            "Second".into(),
            1.0,
            1.0,
            "thai".into(),
            "thai.shop.01".into(),
        )
        .expect("second restaurant");
    let source = temporary.path().join("same.png");
    write_image(&source);
    let source_path = source.to_string_lossy().into_owned();
    let first_id = first.id.clone();
    let second_id = second.id.clone();
    let first_source = source_path.clone();
    let first_job = std::thread::spawn(move || {
        first_media.import(first_id, None, "food".into(), vec![first_source])
    });
    let second_job = std::thread::spawn(move || {
        second_media.import(second_id, None, "food".into(), vec![source_path])
    });
    let first_result = first_job.join().expect("first worker must not panic");
    let second_result = second_job.join().expect("second worker must not panic");
    let results = [
        first_result.expect("first result"),
        second_result.expect("second result"),
    ];
    let successful = results
        .iter()
        .flat_map(|result| result.results.iter())
        .find_map(|item| item.media.as_ref())
        .expect("exactly one successful import");
    assert_eq!(
        results
            .iter()
            .flat_map(|result| result.results.iter())
            .filter(|item| item.media.is_some())
            .count(),
        1
    );
    let duplicate = results
        .iter()
        .flat_map(|result| result.results.iter())
        .find(|item| item.code.as_deref() == Some("DUPLICATE_MEDIA"))
        .expect("one duplicate result");
    let existing = duplicate
        .existing_media
        .as_ref()
        .expect("duplicate location");
    assert_eq!(existing.id, successful.id);
    assert_eq!(existing.restaurant_id, successful.restaurant_id);
    assert!(paths
        .media_root()
        .join(&successful.original_rel_path)
        .is_file());
    assert!(paths
        .media_root()
        .join(&successful.preview_rel_path)
        .is_file());
    assert!(paths
        .media_root()
        .join(&successful.thumbnail_rel_path)
        .is_file());
}

#[test]
fn media_association_category_and_delete_lifecycle_are_scoped_to_restaurant() {
    let (temporary, paths, db) = fixture();
    let restaurants = restaurant_service(&paths, db.clone());
    let logs = food_log_service(db.clone());
    let media = media_service(&paths, db);
    let first = restaurants
        .create(
            "First".into(),
            0.0,
            0.0,
            "thai".into(),
            "thai.shop.01".into(),
        )
        .expect("first");
    let second = restaurants
        .create(
            "Second".into(),
            1.0,
            1.0,
            "thai".into(),
            "thai.shop.01".into(),
        )
        .expect("second");
    let other_log = logs
        .create(second.id, 10, 0, None, None, None, "".into(), None)
        .expect("other log");
    let source = temporary.path().join("first.png");
    write_image(&source);
    let result = media
        .import(
            first.id.clone(),
            None,
            "other".into(),
            vec![source.to_string_lossy().into_owned()],
        )
        .expect("import");
    let imported = result.results[0].media.clone().unwrap_or_else(|| {
        panic!(
            "media: {}",
            result.results[0].error.as_deref().unwrap_or("unknown")
        )
    });
    assert!(media
        .attach(imported.id.clone(), Some(other_log.id))
        .is_err());
    let changed = media
        .update_category(imported.id.clone(), "menu".into())
        .expect("category");
    assert_eq!(changed.category, "menu");
    media.soft_delete(imported.id.clone()).expect("delete");
    assert!(media
        .list(Some(first.id), None, None, None, None)
        .expect("list")
        .items
        .is_empty());
    assert_eq!(
        media.restore(imported.id).expect("restore").category,
        "menu"
    );
}

#[test]
fn global_media_gallery_paginates_stably_filters_and_includes_context() {
    let (_temporary, paths, db) = fixture();
    let restaurants = restaurant_service(&paths, db.clone());
    let logs = food_log_service(db.clone());
    let media = media_service(&paths, db.clone());
    let first = restaurants
        .create(
            "First gallery place".into(),
            0.0,
            0.0,
            "thai".into(),
            "thai.shop.01".into(),
        )
        .expect("first restaurant");
    let second = restaurants
        .create(
            "Second gallery place".into(),
            1.0,
            1.0,
            "thai".into(),
            "thai.shop.02".into(),
        )
        .expect("second restaurant");
    // This restaurant's only media is below the first unfiltered page. The gallery
    // selector must still be able to start a complete server-filtered cursor stream.
    let later = restaurants
        .create(
            "Later gallery place".into(),
            2.0,
            2.0,
            "thai".into(),
            "thai.shop.03".into(),
        )
        .expect("later restaurant");
    let log = logs
        .create(
            first.id.clone(),
            100,
            480,
            Some("dinner".into()),
            Some("dine_in".into()),
            Some("Gallery dinner".into()),
            "".into(),
            None,
        )
        .expect("food log");

    db.with_write(|transaction| {
        for (id, restaurant_id, food_log_id, category, captured_at_ms) in [
            ("media-01", &first.id, Some(&log.id), "food", 800_i64),
            ("media-02", &second.id, None, "menu", 800),
            ("media-03", &first.id, None, "food", 900),
            ("media-04", &second.id, None, "exterior", 900),
            ("media-05", &later.id, None, "interior", 700),
            ("media-06", &later.id, None, "checkin", 600),
        ] {
            transaction.execute(
                "INSERT INTO media (id, restaurant_id, food_log_id, category, sha256, original_name, mime_type, original_rel_path, preview_rel_path, thumbnail_rel_path, width, height, file_size_bytes, captured_at_ms, created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, 'gallery.jpg', 'image/jpeg', ?6, ?7, ?8, 1, 1, 1, ?9, 1, 1)",
                params![id, restaurant_id, food_log_id, category, format!("sha-{id}"), format!("original/{id}.jpg"), format!("preview/{id}.jpg"), format!("thumbnail/{id}.jpg"), captured_at_ms],
            )?;
        }
        Ok(())
    })
    .expect("gallery rows");

    let first_page = media
        .list(None, None, None, None, Some(2))
        .expect("first global page");
    assert_eq!(
        first_page
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["media-04", "media-03"]
    );
    assert_eq!(
        first_page.items[0]
            .restaurant
            .as_ref()
            .map(|owner| owner.name.as_str()),
        Some("Second gallery place")
    );
    let second_page = media
        .list(None, None, None, first_page.next_cursor, Some(2))
        .expect("second global page");
    assert_eq!(
        second_page
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["media-02", "media-01"]
    );
    let log_context = second_page.items[1].food_log.as_ref().expect("log context");
    assert_eq!(log_context.id, log.id);
    assert_eq!(log_context.title.as_deref(), Some("Gallery dinner"));
    assert_eq!(log_context.meal_type.as_deref(), Some("dinner"));

    let restaurant_filtered = media
        .list(Some(first.id), None, None, None, Some(100))
        .expect("restaurant filter");
    assert_eq!(restaurant_filtered.items.len(), 2);
    assert!(restaurant_filtered
        .items
        .iter()
        .all(|item| item.category == "food"));
    let category_filtered = media
        .list(None, None, Some("menu".into()), None, Some(100))
        .expect("category filter");
    assert_eq!(
        category_filtered
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["media-02"]
    );

    // `media-05` is not present in the first global page. Filtering is server-side,
    // so selecting its restaurant begins at that restaurant's newest item rather
    // than incorrectly filtering whichever global items happen to be loaded.
    let later_page = media
        .list(Some(later.id.clone()), None, None, None, Some(1))
        .expect("later restaurant first page");
    assert_eq!(
        later_page
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["media-05"]
    );
    let later_second_page = media
        .list(Some(later.id), None, None, later_page.next_cursor, Some(1))
        .expect("later restaurant second page");
    assert_eq!(
        later_second_page
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["media-06"]
    );
    assert!(later_second_page.next_cursor.is_none());
    assert!(media.list(None, None, None, None, Some(101)).is_err());
}

#[test]
fn stage9_disposable_pressure_matrix_imports_100_media_and_pages_5000_gallery_rows() {
    let (temporary, paths, db) = fixture();
    let restaurants = restaurant_service(&paths, db.clone());
    let media = media_service(&paths, db.clone());
    let owner = restaurants
        .create(
            "Pressure owner".into(),
            0.0,
            0.0,
            "thai".into(),
            "thai.shop.01".into(),
        )
        .expect("owner");

    // This deliberately runs the real import pipeline (copy, hash, decode and
    // derivatives) on 100 distinct, disposable source files.  It is a service
    // pressure baseline, not an assertion about a particular workstation speed.
    let import_started = Instant::now();
    for index in 0_u8..100 {
        let source = temporary.path().join(format!("pressure-{index}.png"));
        image::RgbImage::from_pixel(64, 64, image::Rgb([index, 255 - index, 91]))
            .save(&source)
            .expect("pressure image");
        let result = media
            .import(
                owner.id.clone(),
                None,
                "food".into(),
                vec![source.to_string_lossy().into_owned()],
            )
            .expect("pressure import");
        assert!(result.results[0].media.is_some(), "media {index} imported");
    }
    let import_elapsed = import_started.elapsed();

    // Add enough records to exercise the same server-side gallery cursor that
    // the virtualized UI uses, without generating 4,900 unnecessary files.
    db.with_write(|transaction| {
        for index in 1..1_000 {
            transaction.execute(
                "INSERT INTO restaurants(id,name,longitude,latitude,cuisine_key,icon_key,created_at_ms,updated_at_ms) VALUES(?1,?2,0,0,'thai','thai.shop.01',1,1)",
                params![format!("pressure-r-{index}"), format!("Pressure restaurant {index}")],
            )?;
        }
        for index in 0..4_900 {
            let restaurant_id = format!("pressure-r-{}", (index % 999) + 1);
            transaction.execute(
                "INSERT INTO media(id,restaurant_id,category,sha256,original_name,mime_type,original_rel_path,preview_rel_path,thumbnail_rel_path,width,height,file_size_bytes,captured_at_ms,created_at_ms,updated_at_ms) VALUES(?1,?2,'food',?3,'pressure.jpg','image/jpeg',?4,?5,?6,1,1,1,?7,1,1)",
                params![
                    format!("pressure-media-{index:05}"),
                    restaurant_id,
                    format!("pressure-sha-{index}"),
                    format!("original/pressure-{index}.jpg"),
                    format!("preview/pressure-{index}.jpg"),
                    format!("thumbnail/pressure-{index}.jpg"),
                    1_000_000_i64 + index as i64,
                ],
            )?;
        }
        Ok(())
    })
    .expect("pressure records");

    let map_started = Instant::now();
    let marker_count = restaurants.list_map().expect("map query").len();
    let map_elapsed = map_started.elapsed();
    let gallery_started = Instant::now();
    let gallery = media
        .list(None, None, None, None, Some(100))
        .expect("gallery page");
    let gallery_elapsed = gallery_started.elapsed();
    assert_eq!(marker_count, 1_000);
    assert_eq!(gallery.items.len(), 100);
    assert!(gallery.next_cursor.is_some());
    db.with_read(|connection| {
        let quick: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        assert_eq!(quick, "ok");
        assert!(crate::db::foreign_key_check(connection)?);
        Ok(())
    })
    .expect("pressure database integrity");

    // Keep the timings visible in `cargo test -- --nocapture` and prevent an
    // accidental hung import from being accepted as a healthy pressure run.
    assert!(import_elapsed < Duration::from_secs(120));
    println!(
        "stage9 pressure: import_100_ms={} map_1000_ms={} gallery_first_100_of_5000_ms={}",
        import_elapsed.as_millis(),
        map_elapsed.as_millis(),
        gallery_elapsed.as_millis()
    );
}

#[test]
fn stage9_logging_static_audit_has_rotation_and_no_user_content_interpolation() {
    let app = include_str!("lib.rs");
    let local_server = include_str!("services/local_server.rs");
    assert!(app.contains("max_file_size(1_000_000)"));
    assert!(app.contains("RotationStrategy::KeepSome(5)"));
    assert!(local_server.contains("log::debug!(\"Serving local {root} asset\")"));
    assert!(!local_server.contains("relative.display"));
    assert!(!local_server.contains("original_name"));
    assert!(!local_server.contains("food_log"));
    assert!(!local_server.contains("exif"));
}

#[test]
fn stage9_ordered_service_e2e_restores_backup_into_a_clean_disposable_root() {
    let (source_temp, source_paths, source_db) = fixture();
    let restaurants = restaurant_service(&source_paths, source_db.clone());
    let logs = food_log_service(source_db.clone());
    let media = media_service(&source_paths, source_db.clone());
    let safety = stage8_service(&source_paths, source_db.clone());
    let restaurant = restaurants
        .create(
            "Stage 9 E2E".into(),
            121.501,
            25.032,
            "thai".into(),
            "thai.shop.01".into(),
        )
        .expect("create restaurant");
    restaurants
        .move_to(restaurant.id.clone(), 121.502, 25.033)
        .expect("drag restaurant");
    restaurants
        .update_status(
            restaurant.id.clone(),
            Some("visited".into()),
            Some("favorite".into()),
            Some(true),
            Some(Some(5)),
        )
        .expect("status and rating");
    let first_log = logs
        .create(
            restaurant.id.clone(),
            1_000,
            480,
            Some("dinner".into()),
            Some("dine_in".into()),
            Some("E2E dinner".into()),
            "private note remains in database, never log output".into(),
            Some(5),
        )
        .expect("first log");
    for sequence in 1..10 {
        logs.create(
            restaurant.id.clone(),
            1_000 + sequence,
            480,
            None,
            None,
            None,
            format!("visual log {sequence}"),
            None,
        )
        .expect("additional log");
    }
    let categories = ["food", "menu", "exterior", "interior", "checkin", "other"];
    let mut imported = Vec::new();
    for (index, category) in categories.iter().enumerate() {
        let original_source = source_temp.path().join(format!("e2e-{category}.png"));
        image::RgbImage::from_pixel(96, 64, image::Rgb([index as u8, 255 - index as u8, 80]))
            .save(&original_source)
            .expect("six category source");
        let result = media
            .import(
                restaurant.id.clone(),
                Some(first_log.id.clone()),
                (*category).into(),
                vec![original_source.to_string_lossy().into_owned()],
            )
            .expect("media import");
        let record = result.results[0].media.clone().expect("imported media");
        fs::remove_file(&original_source).expect("simulate moved original source");
        assert!(media
            .original_path(record.id.clone())
            .expect("managed original after source move")
            .is_file());
        imported.push(record);
    }
    restaurants
        .soft_delete(restaurant.id.clone())
        .expect("delete restaurant");
    assert_eq!(safety.list_trash().expect("trash").items.len(), 1);
    safety
        .restore_trash("restaurant", &restaurant.id)
        .expect("restore restaurant");
    let archive = source_temp.path().join("e2e.foodmap-backup.zip");
    let summary = safety.backup(archive.clone()).expect("create backup");
    assert_eq!(summary.restaurants, 1);
    assert_eq!(summary.food_logs, 10);
    assert_eq!(summary.media, 6);

    let clean_root = TempDir::new().expect("clean restore root");
    let clean_paths = PathResolver::from_root(clean_root.path().to_path_buf());
    let clean_state = bootstrap::initialize(
        clean_paths.clone(),
        &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources"),
        2_000,
    )
    .expect("initialize clean root");
    let restored = stage8_service(&clean_paths, clean_state.db.clone());
    let restored_summary = restored.restore(&archive).expect("restore clean root");
    assert_eq!(restored_summary.restaurants, 1);
    assert_eq!(restored_summary.food_logs, 10);
    assert_eq!(restored_summary.media, 6);
    let restored_media = media_service(&clean_paths, clean_state.db.clone())
        .list(None, None, None, None, Some(100))
        .expect("restored gallery");
    assert_eq!(restored_media.items.len(), imported.len());
    clean_state
        .db
        .with_read(|connection| {
            let quick: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
            assert_eq!(quick, "ok");
            assert!(crate::db::foreign_key_check(connection)?);
            Ok(())
        })
        .expect("restored integrity");
}

#[test]
fn stage9_backup_os_path_fault_leaves_no_partial_and_preserves_live_database() {
    let (_temporary, paths, db) = fixture();
    let safety = stage8_service(&paths, db);
    let before = fs::read(paths.database_path()).expect("live database bytes");
    let blocked_parent = paths.root().join("blocked-parent");
    fs::write(&blocked_parent, b"file, not a directory").expect("OS path fault fixture");
    let target = blocked_parent.join("backup.foodmap-backup.zip");
    assert!(safety.backup(target).is_err());
    assert_eq!(
        fs::read(paths.database_path()).expect("live db retained"),
        before
    );
    let partials = fs::read_dir(paths.root())
        .expect("root")
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().contains(".partial"))
        .count();
    assert_eq!(partials, 0);
}

#[test]
fn stage9_insufficient_space_fails_before_snapshot_or_partial_and_preserves_media() {
    let (temporary, paths, db) = fixture();
    let restaurants = restaurant_service(&paths, db.clone());
    let media = media_service(&paths, db.clone());
    let restaurant = restaurants
        .create(
            "Space fault".into(),
            0.0,
            0.0,
            "thai".into(),
            "thai.shop.01".into(),
        )
        .expect("restaurant");
    let source = temporary.path().join("space-fault.png");
    write_image(&source);
    let import_result = media
        .import(
            restaurant.id,
            None,
            "food".into(),
            vec![source.to_string_lossy().into_owned()],
        )
        .expect("media import");
    let imported = import_result.results[0].media.clone().expect("media");
    let original = paths.media_root().join(&imported.original_rel_path);
    let original_bytes = fs::read(&original).expect("managed media before fault");
    let db_before = fs::read(paths.database_path()).expect("database before fault");
    let target = temporary.path().join("no-space.foodmap-backup.zip");
    let _space = crate::services::stage8::test_available_space_override(0);
    assert!(stage8_service(&paths, db).backup(target.clone()).is_err());
    assert!(!target.exists());
    assert_eq!(
        fs::read(paths.database_path()).expect("database retained"),
        db_before
    );
    assert_eq!(fs::read(&original).expect("media retained"), original_bytes);
    assert_eq!(
        fs::read_dir(paths.root().join("restore-staging"))
            .expect("staging root")
            .count(),
        0
    );
    assert_eq!(
        fs::read_dir(temporary.path())
            .expect("temporary root")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".partial"))
            .count(),
        0
    );
}
