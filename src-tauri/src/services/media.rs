use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    thread,
};

use image::{DynamicImage, GenericImageView, ImageEncoder};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    db::Db,
    error::AppError,
    paths::PathResolver,
    repositories::media::{self, Media, MediaPage},
};

const MAX_BYTES: u64 = 100 * 1024 * 1024;
const MAX_PIXELS: u64 = 100_000_000;
const CATEGORIES: [&str; 6] = ["food", "menu", "exterior", "interior", "checkin", "other"];
const VIDEO_POSTER_WIDTH: u32 = 1_600;
const VIDEO_POSTER_HEIGHT: u32 = 900;
const VIDEO_THUMBNAIL_WIDTH: u32 = 384;

enum ImportError {
    Message(String),
    Duplicate(Box<Option<Media>>),
}

impl ImportError {
    fn message(value: impl Into<String>) -> Self {
        Self::Message(value.into())
    }
}

#[derive(Clone)]
pub struct MediaService {
    db: Db,
    paths: PathResolver,
}

// This is process-wide rather than service-owned: Tauri commands can construct or receive
// distinct MediaService values that still write to the same content-addressed media store.
// Derivative generation remains concurrent; only file placement and SHA row creation are
// serialized.
static MEDIA_PLACEMENT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn placement_lock() -> &'static Mutex<()> {
    MEDIA_PLACEMENT_LOCK.get_or_init(|| Mutex::new(()))
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaImportItem {
    pub source_path: String,
    pub media: Option<Media>,
    pub error: Option<String>,
    pub code: Option<String>,
    pub existing_media: Option<Media>,
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaImportResult {
    pub results: Vec<MediaImportItem>,
}

impl MediaService {
    pub fn new(db: Db, paths: PathResolver) -> Self {
        Self { db, paths }
    }
    fn validate_category(value: &str) -> Result<(), String> {
        if CATEGORIES.contains(&value) {
            Ok(())
        } else {
            Err("Media category is invalid".into())
        }
    }
    fn cursor(value: Option<String>) -> Result<Option<(i64, String)>, String> {
        value
            .map(|v| {
                let (time, id) = v
                    .split_once(':')
                    .ok_or_else(|| "Cursor is invalid".to_owned())?;
                Ok((
                    time.parse().map_err(|_| "Cursor is invalid".to_owned())?,
                    id.to_owned(),
                ))
            })
            .transpose()
    }
    pub fn list(
        &self,
        restaurant_id: Option<String>,
        food_log_id: Option<String>,
        category: Option<String>,
        cursor: Option<String>,
        limit: Option<i64>,
    ) -> Result<MediaPage, String> {
        if let Some(ref category) = category {
            Self::validate_category(category)?;
        }
        let limit = limit.unwrap_or(30);
        if !(1..=100).contains(&limit) {
            return Err("Page size must be between 1 and 100".into());
        }
        let cursor = Self::cursor(cursor)?;
        self.db
            .with_write(|t| {
                media::list(
                    t,
                    restaurant_id.as_deref(),
                    food_log_id.as_deref(),
                    category.as_deref(),
                    cursor,
                    limit,
                )
            })
            .map_err(|e| e.to_string())
    }
    pub fn import(
        &self,
        restaurant_id: String,
        food_log_id: Option<String>,
        category: String,
        source_paths: Vec<String>,
    ) -> Result<MediaImportResult, String> {
        Self::validate_category(&category)?;
        if source_paths.is_empty() {
            return Err("Choose at least one media file".into());
        }
        self.db
            .with_write(|t| {
                if !media::restaurant_active(t, &restaurant_id)? {
                    return Err(AppError::BackgroundTask);
                }
                if let Some(ref id) = food_log_id {
                    if !media::food_log_at_restaurant(t, id, &restaurant_id)? {
                        return Err(AppError::BackgroundTask);
                    }
                }
                Ok(())
            })
            .map_err(|e| e.to_string())?;
        // Media decoding/resizing is blocking work. Process no more than two sources at
        // once, preserving request order in the result even when jobs finish out of order.
        let mut results = Vec::with_capacity(source_paths.len());
        for batch in source_paths.chunks(2) {
            thread::scope(|scope| {
                let jobs: Vec<_> = batch
                    .iter()
                    .map(|source_path| {
                        scope.spawn(|| {
                            self.import_item(
                                &restaurant_id,
                                food_log_id.as_deref(),
                                &category,
                                source_path,
                            )
                        })
                    })
                    .collect();
                for job in jobs {
                    results.push(job.join().expect("media import worker must not panic"));
                }
            });
        }
        Ok(MediaImportResult { results })
    }
    fn import_item(
        &self,
        restaurant_id: &str,
        food_log_id: Option<&str>,
        category: &str,
        source_path: &str,
    ) -> MediaImportItem {
        match self.import_one(restaurant_id, food_log_id, category, Path::new(source_path)) {
            Ok(media) => MediaImportItem {
                source_path: source_path.to_owned(),
                media: Some(media),
                error: None,
                code: None,
                existing_media: None,
            },
            Err(ImportError::Duplicate(media)) => MediaImportItem {
                source_path: source_path.to_owned(),
                media: None,
                error: Some("This media has already been imported".into()),
                code: Some("DUPLICATE_MEDIA".into()),
                // A duplicate never changes category or FoodLog association implicitly.
                // The existing record identifies where the content is already managed,
                // including when it belongs to a different restaurant.
                existing_media: *media,
            },
            Err(ImportError::Message(error)) => MediaImportItem {
                source_path: source_path.to_owned(),
                media: None,
                error: Some(error),
                code: None,
                existing_media: None,
            },
        }
    }
    fn import_one(
        &self,
        restaurant_id: &str,
        food_log_id: Option<&str>,
        category: &str,
        supplied: &Path,
    ) -> Result<Media, ImportError> {
        let source = supplied
            .canonicalize()
            .map_err(|_| ImportError::message("Selected media is unavailable"))?;
        let metadata = source
            .metadata()
            .map_err(|_| ImportError::message("Selected media cannot be read"))?;
        if !metadata.is_file() {
            return Err(ImportError::message("Selected path is not a regular file"));
        }
        if metadata.len() > MAX_BYTES {
            return Err(ImportError::message("Media must be 100 MB or smaller"));
        }
        let supplied_extension = source
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase());
        let mime = mime_guess::from_path(&source)
            .first_or_octet_stream()
            .essence_str()
            .to_owned();
        let (extension, is_video) = match (mime.as_str(), supplied_extension.as_deref()) {
            ("image/jpeg", Some("jpg" | "jpeg")) => ("jpg", false),
            ("image/png", Some("png")) => ("png", false),
            ("image/webp", Some("webp")) => ("webp", false),
            ("video/mp4", Some("mp4")) => ("mp4", true),
            ("video/webm", Some("webm")) => ("webm", true),
            _ => {
                return Err(ImportError::message(
                    "Only JPEG, PNG, WebP, MP4, and WebM media are supported",
                ))
            }
        };
        let temp_root = self.paths.media_root().join("temp");
        let token = Uuid::now_v7().to_string();
        let original_temp = temp_root.join(format!("{token}.original"));
        let (hash, size) = copy_and_hash(&source, &original_temp)
            .map_err(|e| ImportError::message(e.to_string()))?;
        let sha = format!("{:x}", hash.finalize());
        let duplicate = self
            .db
            .with_write(|t| media::by_sha(t, &sha))
            .map_err(|e| ImportError::message(e.to_string()))?;
        if let Some(existing) = duplicate {
            let _ = fs::remove_file(&original_temp);
            return Err(ImportError::Duplicate(Box::new(Some(existing))));
        }
        let prepared = (|| -> Result<(Media, Vec<(PathBuf, PathBuf)>), String> {
            let shard = &sha[0..2];
            let shard2 = &sha[2..4];
            let original_rel = format!("original/{shard}/{shard2}/{sha}.{extension}");
            let preview_rel = format!("preview/{shard}/{shard2}/{sha}.jpg");
            let thumbnail_rel = format!("thumbnail/{shard}/{shard2}/{sha}.jpg");
            let media_root = self.paths.media_root();
            let original_final = media_root.join(&original_rel);
            let preview_final = media_root.join(&preview_rel);
            let thumbnail_final = media_root.join(&thumbnail_rel);
            let preview_temp = temp_root.join(format!("{token}.preview"));
            let thumbnail_temp = temp_root.join(format!("{token}.thumbnail"));
            let (width, height) = if is_video {
                // Video metadata is intentionally not probed.  These dimensions describe
                // the generated poster used by the grid and preview, not the source video.
                let poster = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
                    VIDEO_POSTER_WIDTH,
                    VIDEO_POSTER_HEIGHT,
                    image::Rgb([32, 41, 34]),
                ));
                write_jpeg(&poster, VIDEO_POSTER_WIDTH, 85, &preview_temp)?;
                write_jpeg(&poster, VIDEO_THUMBNAIL_WIDTH, 82, &thumbnail_temp)?;
                (VIDEO_POSTER_WIDTH, VIDEO_POSTER_HEIGHT)
            } else {
                let (image, width, height) = decode_oriented(&original_temp)?;
                if u64::from(width) * u64::from(height) > MAX_PIXELS {
                    return Err("Media is too large after decoding".into());
                }
                write_jpeg(&image, 1600, 85, &preview_temp)?;
                write_jpeg(&image, 384, 82, &thumbnail_temp)?;
                (width, height)
            };
            let name = source
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("media")
                .to_owned();
            let item = Media {
                id: Uuid::now_v7().to_string(),
                restaurant_id: restaurant_id.to_owned(),
                food_log_id: food_log_id.map(str::to_owned),
                category: category.to_owned(),
                original_name: name,
                mime_type: mime,
                original_rel_path: original_rel,
                preview_rel_path: preview_rel,
                thumbnail_rel_path: thumbnail_rel,
                width: i64::from(width),
                height: i64::from(height),
                file_size_bytes: size as i64,
                captured_at_ms: None,
                caption: None,
                created_at_ms: crate::now_ms(),
                restaurant: None,
                food_log: None,
            };
            Ok((
                item,
                vec![
                    (original_temp.clone(), original_final),
                    (preview_temp, preview_final),
                    (thumbnail_temp, thumbnail_final),
                ],
            ))
        })();
        let (item, moves) = match prepared {
            Ok(value) => value,
            Err(error) => {
                let _ = fs::remove_file(&original_temp);
                return Err(ImportError::Message(error));
            }
        };
        for (_, final_path) in &moves {
            if let Some(parent) = final_path.parent() {
                fs::create_dir_all(parent).map_err(|e| ImportError::message(e.to_string()))?;
            }
        }
        let _placement = placement_lock()
            .lock()
            .map_err(|_| ImportError::message("Media import lock failed"))?;
        if let Some(existing) = self
            .db
            .with_write(|t| media::by_sha(t, &sha))
            .map_err(|e| ImportError::message(e.to_string()))?
        {
            remove_temps(&moves);
            return Err(ImportError::Duplicate(Box::new(Some(existing))));
        }
        let mut placed = Vec::new();
        for (temp, final_path) in &moves {
            if let Err(error) = place_new_file(temp, final_path) {
                for path in &placed {
                    let _ = fs::remove_file(path);
                }
                remove_temps(&moves);
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    let existing = self
                        .db
                        .with_write(|t| media::by_sha(t, &sha))
                        .ok()
                        .flatten();
                    return Err(ImportError::Duplicate(Box::new(existing)));
                }
                return Err(ImportError::message(format!(
                    "Unable to store media: {error}"
                )));
            }
            placed.push(final_path.clone());
        }
        match self.db.with_write(|t| {
            if !media::restaurant_active(t, restaurant_id)? {
                return Err(AppError::BackgroundTask);
            }
            if let Some(log) = food_log_id {
                if !media::food_log_at_restaurant(t, log, restaurant_id)? {
                    return Err(AppError::BackgroundTask);
                }
            }
            if media::by_sha(t, &sha)?.is_some() {
                return Err(AppError::BackgroundTask);
            }
            media::create(t, &item, &sha, crate::now_ms())?;
            media::get(t, &item.id)?.ok_or(AppError::BackgroundTask)
        }) {
            Ok(media) => Ok(media),
            Err(error) => {
                for path in placed {
                    let _ = fs::remove_file(path);
                }
                Err(ImportError::message(error.to_string()))
            }
        }
    }
    pub fn update_category(&self, id: String, category: String) -> Result<Media, String> {
        Self::validate_category(&category)?;
        self.db
            .with_write(|t| {
                if !media::update_category(t, &id, &category, crate::now_ms())? {
                    return Err(AppError::BackgroundTask);
                }
                media::get(t, &id)?.ok_or(AppError::BackgroundTask)
            })
            .map_err(|e| e.to_string())
    }
    pub fn attach(&self, id: String, food_log_id: Option<String>) -> Result<Media, String> {
        self.db
            .with_write(|t| {
                let current = media::get(t, &id)?.ok_or(AppError::BackgroundTask)?;
                if let Some(ref log) = food_log_id {
                    if !media::food_log_at_restaurant(t, log, &current.restaurant_id)? {
                        return Err(AppError::BackgroundTask);
                    }
                }
                if !media::attach(t, &id, food_log_id.as_deref(), crate::now_ms())? {
                    return Err(AppError::BackgroundTask);
                }
                media::get(t, &id)?.ok_or(AppError::BackgroundTask)
            })
            .map_err(|e| e.to_string())
    }
    pub fn update_caption(&self, id: String, caption: Option<String>) -> Result<Media, String> {
        let caption = caption
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        if caption
            .as_ref()
            .is_some_and(|value| value.chars().count() > 1_000)
        {
            return Err("Caption must be at most 1000 characters".into());
        }
        self.db
            .with_write(|t| {
                if !media::caption(t, &id, caption.as_deref(), crate::now_ms())? {
                    return Err(AppError::BackgroundTask);
                }
                media::get(t, &id)?.ok_or(AppError::BackgroundTask)
            })
            .map_err(|e| e.to_string())
    }
    pub fn soft_delete(&self, id: String) -> Result<(), String> {
        self.db
            .with_write(|t| {
                if media::soft_delete(t, &id, crate::now_ms())? {
                    Ok(())
                } else {
                    Err(AppError::BackgroundTask)
                }
            })
            .map_err(|e| e.to_string())
    }
    pub fn restore(&self, id: String) -> Result<Media, String> {
        self.db
            .with_write(|t| {
                if !media::restore(t, &id, crate::now_ms())? {
                    return Err(AppError::BackgroundTask);
                }
                media::get(t, &id)?.ok_or(AppError::BackgroundTask)
            })
            .map_err(|e| e.to_string())
    }
    pub fn original_path(&self, id: String) -> Result<PathBuf, String> {
        self.db
            .with_write(|t| media::get(t, &id)?.ok_or(AppError::BackgroundTask))
            .map_err(|e| e.to_string())
            .and_then(|m| safe_media_path(&self.paths, &m.original_rel_path))
    }
}
fn copy_and_hash(source: &Path, temp: &Path) -> std::io::Result<(Sha256, u64)> {
    let mut reader = BufReader::new(File::open(source)?);
    let mut writer = OpenOptions::new().write(true).create_new(true).open(temp)?;
    let mut hash = Sha256::new();
    let mut total = 0;
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total += read as u64;
        hash.update(&buffer[..read]);
        writer.write_all(&buffer[..read])?;
    }
    writer.sync_all()?;
    Ok((hash, total))
}
fn decode_oriented(path: &Path) -> Result<(DynamicImage, u32, u32), String> {
    let mut image = image::ImageReader::open(path)
        .map_err(|_| "Media could not be decoded".to_owned())?
        .with_guessed_format()
        .map_err(|_| "Media could not be decoded".to_owned())?
        .decode()
        .map_err(|_| "Media could not be decoded".to_owned())?;
    let orientation = File::open(path)
        .ok()
        .and_then(|file| {
            exif::Reader::new()
                .read_from_container(&mut BufReader::new(file))
                .ok()
        })
        .and_then(|exif| {
            exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
                .and_then(|field| field.value.get_uint(0))
        })
        .unwrap_or(1);
    image = match orientation {
        2 => image.fliph(),
        3 => image.rotate180(),
        4 => image.flipv(),
        5 => image.rotate90().fliph(),
        6 => image.rotate90(),
        7 => image.rotate270().fliph(),
        8 => image.rotate270(),
        _ => image,
    };
    let (w, h) = image.dimensions();
    Ok((image, w, h))
}
fn write_jpeg(image: &DynamicImage, max: u32, quality: u8, path: &Path) -> Result<(), String> {
    let (w, h) = image.dimensions();
    let ratio = (max as f64 / w as f64).min(max as f64 / h as f64).min(1.0);
    let resized = if ratio < 1.0 {
        image.resize(
            (w as f64 * ratio).round() as u32,
            (h as f64 * ratio).round() as u32,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        image.clone()
    };
    // JPEG has no alpha channel. Composite transparent pixels on the neutral canvas used
    // by the UI instead of silently discarding alpha and producing dark artifacts.
    let canvas = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        resized.width(),
        resized.height(),
        image::Rgb([245, 245, 245]),
    ));
    let mut canvas = canvas;
    image::imageops::overlay(&mut canvas, &resized, 0, 0);
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    image::codecs::jpeg::JpegEncoder::new_with_quality(file, quality)
        .write_image(
            canvas.as_bytes(),
            canvas.width(),
            canvas.height(),
            canvas.color().into(),
        )
        .map_err(|e| e.to_string())
}

// `rename` replaces an existing destination on some platforms. Hard-linking within the
// app-data filesystem is an atomic create-new operation, so no import can overwrite a
// concurrently placed content-addressed file.
fn place_new_file(temp: &Path, destination: &Path) -> std::io::Result<()> {
    fs::hard_link(temp, destination)?;
    fs::remove_file(temp)
}

fn remove_temps(moves: &[(PathBuf, PathBuf)]) {
    for (temp, _) in moves {
        let _ = fs::remove_file(temp);
    }
}
fn safe_media_path(paths: &PathResolver, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("Stored media path is invalid".into());
    }
    Ok(paths.media_root().join(path))
}
