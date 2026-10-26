use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::Deserialize;
use uuid::Uuid;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::repositories::restaurant::{self, Restaurant, RestaurantMap, Tag};

pub const MAP_ICON_SCALE_MIN: f64 = 0.75;
pub const MAP_ICON_SCALE_MAX: f64 = 1.50;

#[derive(Deserialize)]
struct IconManifest {
    cuisines: Vec<Cuisine>,
}
#[derive(Deserialize)]
struct Cuisine {
    key: String,
    icons: Vec<String>,
}

#[derive(Clone)]
pub struct RestaurantService {
    db: Db,
    manifest: HashMap<String, HashSet<String>>,
}

impl RestaurantService {
    pub fn new(db: Db, manifest_path: &Path) -> Result<Self, String> {
        let raw = std::fs::read_to_string(manifest_path).map_err(|e| e.to_string())?;
        let parsed: IconManifest =
            serde_json::from_str(raw.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())?;
        let manifest = parsed
            .cuisines
            .into_iter()
            .map(|c| (c.key, c.icons.into_iter().collect()))
            .collect();
        Ok(Self { db, manifest })
    }
    fn name(value: String) -> Result<String, String> {
        let value = value.trim().to_owned();
        if (1..=120).contains(&value.chars().count()) {
            Ok(value)
        } else {
            Err("Restaurant name must be 1–120 characters".into())
        }
    }
    fn tag_name(value: String) -> Result<String, String> {
        let value = value.trim().to_owned();
        if (1..=40).contains(&value.chars().count()) {
            Ok(value)
        } else {
            Err("Tag name must be 1–40 characters".into())
        }
    }
    fn point(longitude: f64, latitude: f64) -> Result<(), String> {
        if longitude.is_finite()
            && latitude.is_finite()
            && (-180.0..=180.0).contains(&longitude)
            && (-90.0..=90.0).contains(&latitude)
        {
            Ok(())
        } else {
            Err("Coordinates are invalid".into())
        }
    }
    fn manifest(&self, cuisine_key: &str, icon_key: &str) -> Result<(), String> {
        match self.manifest.get(cuisine_key) {
            Some(icons) if icons.contains(icon_key) => Ok(()),
            _ => Err("Cuisine and icon must match the installed icon manifest".into()),
        }
    }
    fn canonical_pair(cuisine_key: String, icon_key: String) -> (String, String) {
        let cuisine_key = match cuisine_key.as_str() {
            "thai" | "vietnamese" => "southeast_asian",
            "indian" => "south_asian",
            "noodles" => "rice_noodles",
            "congee" => "fast_meal",
            "dimsum" => "dimsum_dumpling",
            "cafe" => "coffee",
            "bakery" => "bakery_pastry",
            "western" => "pasta_pizza",
            "other" => "snacks",
            value => value,
        }
        .to_owned();
        let icon_key = match icon_key.as_str() {
            "thai.shop.01" | "vietnamese.shop.01" => "southeast_asian.shop.01",
            "thai.shop.02" | "vietnamese.shop.02" => "southeast_asian.shop.02",
            "thai.shop.03" | "vietnamese.shop.03" => "southeast_asian.shop.03",
            "indian.shop.01" => "south_asian.shop.01",
            "indian.shop.02" => "south_asian.shop.02",
            "indian.shop.03" => "south_asian.shop.03",
            "noodles.shop.01" => "rice_noodles.shop.01",
            "noodles.shop.02" => "rice_noodles.shop.02",
            "noodles.shop.03" => "rice_noodles.shop.03",
            "congee.shop.01" => "fast_meal.shop.01",
            "congee.shop.02" => "fast_meal.shop.02",
            "congee.shop.03" => "fast_meal.shop.03",
            "dimsum.shop.01" => "dimsum_dumpling.shop.01",
            "dimsum.shop.02" => "dimsum_dumpling.shop.02",
            "dimsum.shop.03" => "dimsum_dumpling.shop.03",
            "cafe.shop.01" => "coffee.shop.01",
            "cafe.shop.02" => "coffee.shop.02",
            "cafe.shop.03" => "coffee.shop.03",
            "bakery.shop.01" => "bakery_pastry.shop.01",
            "bakery.shop.02" => "bakery_pastry.shop.02",
            "bakery.shop.03" => "bakery_pastry.shop.03",
            "western.shop.01" => "pasta_pizza.shop.01",
            "western.shop.02" => "pasta_pizza.shop.02",
            "western.shop.03" => "pasta_pizza.shop.03",
            "other.shop.01" => "snacks.shop.01",
            "other.shop.02" => "snacks.shop.02",
            "other.shop.03" => "snacks.shop.03",
            value => value,
        }
        .to_owned();
        (cuisine_key, icon_key)
    }
    fn status(visit: &str, affection: &str, rating: Option<i64>) -> Result<(), String> {
        if !["unknown", "want_to_go", "visited", "frequent"].contains(&visit) {
            return Err("Visit status is invalid".into());
        }
        if !["neutral", "like", "favorite", "avoid"].contains(&affection) {
            return Err("Affection status is invalid".into());
        }
        if !rating.is_none_or(|v| (1..=5).contains(&v)) {
            return Err("Overall rating must be between 1 and 5".into());
        }
        Ok(())
    }
    fn map_icon_scale(value: f64) -> Result<f64, String> {
        if value.is_finite() && (MAP_ICON_SCALE_MIN..=MAP_ICON_SCALE_MAX).contains(&value) {
            Ok(value)
        } else {
            Err(format!(
                "Map icon scale must be finite and between {MAP_ICON_SCALE_MIN:.2} and {MAP_ICON_SCALE_MAX:.2}"
            ))
        }
    }
    fn id() -> String {
        Uuid::now_v7().to_string()
    }
    pub fn list_map(&self) -> AppResult<Vec<RestaurantMap>> {
        self.db.with_write(restaurant::list_map)
    }
    pub fn get(&self, id: String) -> AppResult<Option<Restaurant>> {
        self.db.with_write(|t| restaurant::get(t, &id))
    }
    pub fn create(
        &self,
        name: String,
        longitude: f64,
        latitude: f64,
        cuisine_key: String,
        icon_key: String,
    ) -> Result<Restaurant, String> {
        let name = Self::name(name)?;
        Self::point(longitude, latitude)?;
        let (cuisine_key, icon_key) = Self::canonical_pair(cuisine_key, icon_key);
        self.manifest(&cuisine_key, &icon_key)?;
        let id = Self::id();
        let now = crate::now_ms();
        self.db
            .with_write(|t| {
                restaurant::create(
                    t,
                    &id,
                    &name,
                    longitude,
                    latitude,
                    &cuisine_key,
                    &icon_key,
                    now,
                )?;
                restaurant::get(t, &id)?.ok_or(AppError::BackgroundTask)
            })
            .map_err(|e| e.to_string())
    }
    #[allow(clippy::too_many_arguments)]
    pub fn update_profile(
        &self,
        id: String,
        name: String,
        cuisine_key: String,
        icon_key: String,
        map_icon_scale: f64,
        phone: Option<String>,
        opening_hours_text: Option<String>,
        address_note: Option<String>,
    ) -> Result<Restaurant, String> {
        let name = Self::name(name)?;
        let (cuisine_key, icon_key) = Self::canonical_pair(cuisine_key, icon_key);
        self.manifest(&cuisine_key, &icon_key)?;
        let map_icon_scale = Self::map_icon_scale(map_icon_scale)?;
        let now = crate::now_ms();
        self.db
            .with_write(|t| {
                if !restaurant::update_profile(
                    t,
                    &id,
                    &name,
                    &cuisine_key,
                    &icon_key,
                    map_icon_scale,
                    phone.as_deref(),
                    opening_hours_text.as_deref(),
                    address_note.as_deref(),
                    now,
                )? {
                    return Err(AppError::BackgroundTask);
                }
                restaurant::get(t, &id)?.ok_or(AppError::BackgroundTask)
            })
            .map_err(|e| e.to_string())
    }
    pub fn update_status(
        &self,
        id: String,
        visit_status: Option<String>,
        affection_status: Option<String>,
        is_bookmarked: Option<bool>,
        overall_rating: Option<Option<i64>>,
    ) -> Result<Restaurant, String> {
        let current = self
            .get(id.clone())
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Restaurant not found".to_owned())?;
        let visit_status = visit_status.unwrap_or(current.visit_status);
        let affection_status = affection_status.unwrap_or(current.affection_status);
        let is_bookmarked = is_bookmarked.unwrap_or(current.is_bookmarked);
        let overall_rating = overall_rating.unwrap_or(current.overall_rating);
        Self::status(&visit_status, &affection_status, overall_rating)?;
        let now = crate::now_ms();
        self.db
            .with_write(|t| {
                if !restaurant::update_status(
                    t,
                    &id,
                    &visit_status,
                    &affection_status,
                    is_bookmarked,
                    overall_rating,
                    now,
                )? {
                    return Err(AppError::BackgroundTask);
                }
                restaurant::get(t, &id)?.ok_or(AppError::BackgroundTask)
            })
            .map_err(|e| e.to_string())
    }
    pub fn set_position_locked(
        &self,
        id: String,
        position_locked: bool,
    ) -> Result<Restaurant, String> {
        self.db
            .with_write(|t| {
                if !restaurant::set_position_locked(t, &id, position_locked, crate::now_ms())? {
                    return Err(AppError::BackgroundTask);
                }
                restaurant::get(t, &id)?.ok_or(AppError::BackgroundTask)
            })
            .map_err(|e| e.to_string())
    }
    pub fn move_to(&self, id: String, longitude: f64, latitude: f64) -> Result<Restaurant, String> {
        Self::point(longitude, latitude)?;
        let now = crate::now_ms();
        self.db
            .with_write(|t| {
                if !restaurant::move_to(t, &id, longitude, latitude, now)? {
                    return Err(AppError::BackgroundTask);
                }
                restaurant::get(t, &id)?.ok_or(AppError::BackgroundTask)
            })
            .map_err(|e| e.to_string())
    }
    pub fn soft_delete(&self, id: String) -> Result<(), String> {
        self.db
            .with_write(|t| {
                if restaurant::soft_delete(t, &id, crate::now_ms())? {
                    Ok(())
                } else {
                    Err(AppError::BackgroundTask)
                }
            })
            .map_err(|e| e.to_string())
    }
    pub fn restore(&self, id: String) -> Result<Restaurant, String> {
        let now = crate::now_ms();
        self.db
            .with_write(|t| {
                if !restaurant::restore(t, &id, now)? {
                    return Err(AppError::BackgroundTask);
                }
                restaurant::get(t, &id)?.ok_or(AppError::BackgroundTask)
            })
            .map_err(|e| e.to_string())
    }
    pub fn create_tag(&self, name: String) -> Result<Tag, String> {
        let name = Self::tag_name(name)?;
        let id = Self::id();
        self.db
            .with_write(|t| restaurant::create_tag(t, &id, &name, crate::now_ms()))
            .map_err(|e| e.to_string())
    }
    pub fn list_tags(&self) -> AppResult<Vec<Tag>> {
        self.db.with_write(restaurant::list_tags)
    }
    pub fn rename_tag(&self, id: String, name: String) -> Result<Tag, String> {
        let name = Self::tag_name(name)?;
        self.db
            .with_write(|t| {
                if !restaurant::rename_tag(t, &id, &name, crate::now_ms())? {
                    return Err(AppError::BackgroundTask);
                }
                Ok(Tag { id, name })
            })
            .map_err(|e| e.to_string())
    }
    pub fn delete_tag(&self, id: String) -> Result<(), String> {
        self.db
            .with_write(|t| {
                if restaurant::delete_tag(t, &id)? {
                    Ok(())
                } else {
                    Err(AppError::BackgroundTask)
                }
            })
            .map_err(|e| e.to_string())
    }
    pub fn set_tag(
        &self,
        restaurant_id: String,
        tag_id: String,
        associated: bool,
    ) -> Result<(), String> {
        self.db
            .with_write(|t| {
                restaurant::set_tag(t, &restaurant_id, &tag_id, associated, crate::now_ms())?;
                Ok(())
            })
            .map_err(|e| e.to_string())
    }
}
