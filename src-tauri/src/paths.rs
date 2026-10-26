use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, AppResult};

#[derive(Clone, Debug)]
pub struct PathResolver {
    root: PathBuf,
}

impl PathResolver {
    pub fn from_root(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn database_path(&self) -> PathBuf {
        self.root.join("db").join("foodmap.sqlite3")
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn media_root(&self) -> PathBuf {
        self.root.join("media")
    }

    pub fn map_regions_root(&self) -> PathBuf {
        self.root.join("maps/regions")
    }

    pub fn map_regions_staging_root(&self) -> PathBuf {
        self.root.join("maps/regions-staging")
    }

    pub fn map_region_path(&self, id: &str) -> AppResult<PathBuf> {
        validate_map_region_id(id)?;
        Ok(self.map_regions_root().join(id))
    }

    pub fn map_region_staging_path(&self, id: &str) -> AppResult<PathBuf> {
        validate_map_region_id(id)?;
        Ok(self.map_regions_staging_root().join(id))
    }

    pub fn cleanup_root(&self, file_kind: &str) -> AppResult<PathBuf> {
        let relative = match file_kind {
            "media_original" => Path::new("media/original"),
            "media_preview" => Path::new("media/preview"),
            "media_thumbnail" => Path::new("media/thumbnail"),
            "temp" => Path::new("media/temp"),
            _ => return Err(AppError::UnsafeRelativePath),
        };
        Ok(self.root.join(relative))
    }

    pub fn resolve_cleanup_path(&self, file_kind: &str, relative: &str) -> AppResult<PathBuf> {
        let relative = Path::new(relative);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(AppError::UnsafeRelativePath);
        }
        // Current Media records keep paths relative to `media/` (for example
        // `original/ab/cd/hash.jpg`).  Older cleanup rows stored only the
        // filename below their kind root.  Accept both representations while
        // requiring a current path to match its declared file kind.
        let expected = match file_kind {
            "media_original" => "original",
            "media_preview" => "preview",
            "media_thumbnail" => "thumbnail",
            "temp" => "temp",
            _ => return Err(AppError::UnsafeRelativePath),
        };
        if relative
            .components()
            .next()
            .is_some_and(|component| component.as_os_str() == expected)
        {
            Ok(self.media_root().join(relative))
        } else {
            Ok(self.cleanup_root(file_kind)?.join(relative))
        }
    }

    pub fn ensure_directories(&self) -> AppResult<()> {
        for relative in [
            "db",
            "media/original",
            "media/preview",
            "media/thumbnail",
            "media/temp",
            "maps/default",
            "maps/regions",
            "maps/regions-staging",
            "assets/food-icons",
            "backups",
            "restore-staging",
            "state",
        ] {
            fs::create_dir_all(self.root.join(relative))?;
        }
        Ok(())
    }
}

pub fn validate_map_region_id(id: &str) -> AppResult<()> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        || id.starts_with('-')
        || id.ends_with('-')
    {
        return Err(AppError::UnsafeRelativePath);
    }
    Ok(())
}
