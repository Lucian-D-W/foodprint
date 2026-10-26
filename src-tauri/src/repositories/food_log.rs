use rusqlite::{params, OptionalExtension, Row, Transaction};
use serde::Serialize;

use crate::error::AppResult;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoodLog {
    pub id: String,
    pub restaurant_id: String,
    pub occurred_at_ms: i64,
    pub tz_offset_minutes: i64,
    pub meal_type: Option<String>,
    pub dining_mode: Option<String>,
    pub title: Option<String>,
    pub note: String,
    pub rating: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoodLogPage {
    pub items: Vec<FoodLog>,
    pub next_cursor: Option<String>,
}

fn row(row: &Row<'_>) -> rusqlite::Result<FoodLog> {
    Ok(FoodLog {
        id: row.get(0)?,
        restaurant_id: row.get(1)?,
        occurred_at_ms: row.get(2)?,
        tz_offset_minutes: row.get(3)?,
        meal_type: row.get(4)?,
        dining_mode: row.get(5)?,
        title: row.get(6)?,
        note: row.get(7)?,
        rating: row.get(8)?,
    })
}

pub fn restaurant_is_active(transaction: &Transaction<'_>, id: &str) -> AppResult<bool> {
    Ok(transaction
        .query_row(
            "SELECT 1 FROM restaurants WHERE id=?1 AND deleted_at_ms IS NULL",
            [id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

pub fn get(transaction: &Transaction<'_>, id: &str) -> AppResult<Option<FoodLog>> {
    Ok(transaction.query_row("SELECT id, restaurant_id, occurred_at_ms, tz_offset_minutes, meal_type, dining_mode, title, note, rating FROM food_logs WHERE id=?1 AND deleted_at_ms IS NULL", [id], row).optional()?)
}

pub fn list(
    transaction: &Transaction<'_>,
    restaurant_id: &str,
    cursor: Option<(i64, String)>,
    limit: i64,
) -> AppResult<FoodLogPage> {
    let (occurred_at, id) = cursor.unwrap_or((i64::MAX, "\u{10ffff}".into()));
    let mut statement = transaction.prepare("SELECT id, restaurant_id, occurred_at_ms, tz_offset_minutes, meal_type, dining_mode, title, note, rating FROM food_logs WHERE restaurant_id=?1 AND deleted_at_ms IS NULL AND (occurred_at_ms < ?2 OR (occurred_at_ms = ?2 AND id < ?3)) ORDER BY occurred_at_ms DESC, id DESC LIMIT ?4")?;
    let items = statement
        .query_map(params![restaurant_id, occurred_at, id, limit + 1], row)?
        .collect::<Result<Vec<_>, _>>()?;
    let mut items = items;
    let next_cursor = if items.len() > limit as usize {
        items.pop();
        items
            .last()
            .map(|item| format!("{}:{}", item.occurred_at_ms, item.id))
    } else {
        None
    };
    Ok(FoodLogPage { items, next_cursor })
}

#[allow(clippy::too_many_arguments)]
pub fn create(
    transaction: &Transaction<'_>,
    id: &str,
    restaurant_id: &str,
    occurred_at_ms: i64,
    tz_offset_minutes: i64,
    meal_type: Option<&str>,
    dining_mode: Option<&str>,
    title: Option<&str>,
    note: &str,
    rating: Option<i64>,
    now_ms: i64,
) -> AppResult<()> {
    transaction.execute("INSERT INTO food_logs (id,restaurant_id,occurred_at_ms,tz_offset_minutes,meal_type,dining_mode,title,note,rating,created_at_ms,updated_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)", params![id, restaurant_id, occurred_at_ms, tz_offset_minutes, meal_type, dining_mode, title, note, rating, now_ms])?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn update(
    transaction: &Transaction<'_>,
    id: &str,
    occurred_at_ms: i64,
    tz_offset_minutes: i64,
    meal_type: Option<&str>,
    dining_mode: Option<&str>,
    title: Option<&str>,
    note: &str,
    rating: Option<i64>,
    now_ms: i64,
) -> AppResult<bool> {
    Ok(transaction.execute("UPDATE food_logs SET occurred_at_ms=?2,tz_offset_minutes=?3,meal_type=?4,dining_mode=?5,title=?6,note=?7,rating=?8,updated_at_ms=?9 WHERE id=?1 AND deleted_at_ms IS NULL", params![id, occurred_at_ms, tz_offset_minutes, meal_type, dining_mode, title, note, rating, now_ms])? == 1)
}

pub fn soft_delete(transaction: &Transaction<'_>, id: &str, now_ms: i64) -> AppResult<bool> {
    Ok(transaction.execute("UPDATE food_logs SET deleted_at_ms=?2,updated_at_ms=?2 WHERE id=?1 AND deleted_at_ms IS NULL", params![id, now_ms])? == 1)
}

pub fn restore(transaction: &Transaction<'_>, id: &str, now_ms: i64) -> AppResult<bool> {
    Ok(transaction.execute("UPDATE food_logs SET deleted_at_ms=NULL,updated_at_ms=?2 WHERE id=?1 AND deleted_at_ms IS NOT NULL", params![id, now_ms])? == 1)
}
