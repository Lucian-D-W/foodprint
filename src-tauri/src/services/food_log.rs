use uuid::Uuid;

use crate::db::Db;
use crate::error::AppError;
use crate::repositories::food_log::{self, FoodLog, FoodLogPage};

#[derive(Clone)]
pub struct FoodLogService {
    db: Db,
}

impl FoodLogService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }
    fn id() -> String {
        Uuid::now_v7().to_string()
    }
    fn optional_text(
        value: Option<String>,
        label: &str,
        max: usize,
    ) -> Result<Option<String>, String> {
        match value
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
        {
            Some(value) if value.chars().count() > max => {
                Err(format!("{label} must be at most {max} characters"))
            }
            value => Ok(value),
        }
    }
    fn note(value: String) -> Result<String, String> {
        let value = value.trim().to_owned();
        if value.chars().count() <= 4_000 {
            Ok(value)
        } else {
            Err("Note must be at most 4000 characters".into())
        }
    }
    fn validate(
        occurred_at_ms: i64,
        tz_offset_minutes: i64,
        meal_type: &Option<String>,
        dining_mode: &Option<String>,
        rating: Option<i64>,
    ) -> Result<(), String> {
        if occurred_at_ms <= 0 {
            return Err("Occurred time must be valid".into());
        }
        if !(-840..=840).contains(&tz_offset_minutes) {
            return Err("Timezone offset must be between -840 and 840 minutes".into());
        }
        if !meal_type.as_deref().is_none_or(|value| {
            ["breakfast", "lunch", "dinner", "late_night", "other"].contains(&value)
        }) {
            return Err("Meal type is invalid".into());
        }
        if !dining_mode
            .as_deref()
            .is_none_or(|value| ["dine_in", "delivery", "takeaway", "other"].contains(&value))
        {
            return Err("Dining mode is invalid".into());
        }
        if !rating.is_none_or(|value| (1..=5).contains(&value)) {
            return Err("Rating must be between 1 and 5".into());
        }
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        restaurant_id: String,
        occurred_at_ms: i64,
        tz_offset_minutes: i64,
        meal_type: Option<String>,
        dining_mode: Option<String>,
        title: Option<String>,
        note: String,
        rating: Option<i64>,
    ) -> Result<FoodLog, String> {
        let meal_type = Self::optional_text(meal_type, "Meal type", 20)?;
        let dining_mode = Self::optional_text(dining_mode, "Dining mode", 20)?;
        let title = Self::optional_text(title, "Title", 160)?;
        let note = Self::note(note)?;
        Self::validate(
            occurred_at_ms,
            tz_offset_minutes,
            &meal_type,
            &dining_mode,
            rating,
        )?;
        let id = Self::id();
        let now = crate::now_ms();
        self.db.with_write(|transaction| {
            if !food_log::restaurant_is_active(transaction, &restaurant_id)? { return Err(AppError::BackgroundTask); }
            let first = transaction.query_row("SELECT COUNT(*) FROM food_logs WHERE restaurant_id=?1 AND deleted_at_ms IS NULL", [&restaurant_id], |row| row.get::<_, i64>(0))? == 0;
            food_log::create(transaction, &id, &restaurant_id, occurred_at_ms, tz_offset_minutes, meal_type.as_deref(), dining_mode.as_deref(), title.as_deref(), &note, rating, now)?;
            if first { transaction.execute("UPDATE restaurants SET visit_status='visited',updated_at_ms=?2 WHERE id=?1 AND visit_status IN ('unknown','want_to_go') AND deleted_at_ms IS NULL", rusqlite::params![restaurant_id, now])?; }
            food_log::get(transaction, &id)?.ok_or(AppError::BackgroundTask)
        }).map_err(|error| error.to_string())
    }
    pub fn list(
        &self,
        restaurant_id: String,
        cursor: Option<String>,
        limit: Option<i64>,
    ) -> Result<FoodLogPage, String> {
        let cursor = cursor
            .map(|value| {
                let (time, id) = value
                    .split_once(':')
                    .ok_or_else(|| "Cursor is invalid".to_owned())?;
                Ok::<(i64, String), String>((
                    time.parse::<i64>()
                        .map_err(|_| "Cursor is invalid".to_owned())?,
                    id.to_owned(),
                ))
            })
            .transpose()?;
        let limit = limit.unwrap_or(30);
        if !(1..=100).contains(&limit) {
            return Err("Page size must be between 1 and 100".into());
        }
        self.db
            .with_write(|transaction| {
                if !food_log::restaurant_is_active(transaction, &restaurant_id)? {
                    return Err(AppError::BackgroundTask);
                }
                food_log::list(transaction, &restaurant_id, cursor, limit)
            })
            .map_err(|error| error.to_string())
    }
    #[allow(clippy::too_many_arguments)]
    pub fn update(
        &self,
        id: String,
        occurred_at_ms: i64,
        tz_offset_minutes: i64,
        meal_type: Option<String>,
        dining_mode: Option<String>,
        title: Option<String>,
        note: String,
        rating: Option<i64>,
    ) -> Result<FoodLog, String> {
        let meal_type = Self::optional_text(meal_type, "Meal type", 20)?;
        let dining_mode = Self::optional_text(dining_mode, "Dining mode", 20)?;
        let title = Self::optional_text(title, "Title", 160)?;
        let note = Self::note(note)?;
        Self::validate(
            occurred_at_ms,
            tz_offset_minutes,
            &meal_type,
            &dining_mode,
            rating,
        )?;
        self.db
            .with_write(|transaction| {
                let existing = food_log::get(transaction, &id)?.ok_or(AppError::BackgroundTask)?;
                if !food_log::restaurant_is_active(transaction, &existing.restaurant_id)? {
                    return Err(AppError::BackgroundTask);
                }
                if !food_log::update(
                    transaction,
                    &id,
                    occurred_at_ms,
                    tz_offset_minutes,
                    meal_type.as_deref(),
                    dining_mode.as_deref(),
                    title.as_deref(),
                    &note,
                    rating,
                    crate::now_ms(),
                )? {
                    return Err(AppError::BackgroundTask);
                }
                food_log::get(transaction, &id)?.ok_or(AppError::BackgroundTask)
            })
            .map_err(|error| error.to_string())
    }
    pub fn soft_delete(&self, id: String) -> Result<(), String> {
        self.mutate_deleted(id, false)
    }
    pub fn restore(&self, id: String) -> Result<FoodLog, String> {
        self.db
            .with_write(|transaction| {
                if !food_log::restore(transaction, &id, crate::now_ms())? {
                    return Err(AppError::BackgroundTask);
                }
                let log = food_log::get(transaction, &id)?.ok_or(AppError::BackgroundTask)?;
                if !food_log::restaurant_is_active(transaction, &log.restaurant_id)? {
                    return Err(AppError::BackgroundTask);
                }
                Ok(log)
            })
            .map_err(|error| error.to_string())
    }
    fn mutate_deleted(&self, id: String, restore: bool) -> Result<(), String> {
        self.db
            .with_write(|transaction| {
                let changed = if restore {
                    food_log::restore(transaction, &id, crate::now_ms())?
                } else {
                    food_log::soft_delete(transaction, &id, crate::now_ms())?
                };
                if changed {
                    Ok(())
                } else {
                    Err(AppError::BackgroundTask)
                }
            })
            .map_err(|error| error.to_string())
    }
}
