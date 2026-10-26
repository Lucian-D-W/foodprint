use rusqlite::{params, OptionalExtension, Row, Transaction};
use serde::Serialize;

use crate::error::AppResult;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub id: String,
    pub restaurant_id: String,
    pub food_log_id: Option<String>,
    pub category: String,
    pub original_name: String,
    pub mime_type: String,
    pub original_rel_path: String,
    pub preview_rel_path: String,
    pub thumbnail_rel_path: String,
    pub width: i64,
    pub height: i64,
    pub file_size_bytes: i64,
    pub captured_at_ms: Option<i64>,
    pub caption: Option<String>,
    pub created_at_ms: i64,
    /// Present for list results so the global gallery can render ownership without
    /// doing an N+1 lookup. Lifecycle and import responses keep these unset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restaurant: Option<MediaRestaurant>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub food_log: Option<MediaFoodLog>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRestaurant {
    pub id: String,
    pub name: String,
    pub cuisine_key: String,
    pub icon_key: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFoodLog {
    pub id: String,
    pub occurred_at_ms: i64,
    pub title: Option<String>,
    pub meal_type: Option<String>,
    pub dining_mode: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPage {
    pub items: Vec<Media>,
    pub next_cursor: Option<String>,
}

fn row(row: &Row<'_>) -> rusqlite::Result<Media> {
    Ok(Media {
        id: row.get(0)?,
        restaurant_id: row.get(1)?,
        food_log_id: row.get(2)?,
        category: row.get(3)?,
        original_name: row.get(4)?,
        mime_type: row.get(5)?,
        original_rel_path: row.get(6)?,
        preview_rel_path: row.get(7)?,
        thumbnail_rel_path: row.get(8)?,
        width: row.get(9)?,
        height: row.get(10)?,
        file_size_bytes: row.get(11)?,
        captured_at_ms: row.get(12)?,
        caption: row.get(13)?,
        created_at_ms: row.get(14)?,
        restaurant: None,
        food_log: None,
    })
}

fn gallery_row(record: &Row<'_>) -> rusqlite::Result<Media> {
    let mut media = row(record)?;
    media.restaurant = Some(MediaRestaurant {
        id: record.get(15)?,
        name: record.get(16)?,
        cuisine_key: record.get(17)?,
        icon_key: record.get(18)?,
    });
    media.food_log = record
        .get::<_, Option<String>>(19)?
        .map(|id| {
            Ok::<MediaFoodLog, rusqlite::Error>(MediaFoodLog {
                id,
                occurred_at_ms: record.get(20)?,
                title: record.get(21)?,
                meal_type: record.get(22)?,
                dining_mode: record.get(23)?,
            })
        })
        .transpose()?;
    Ok(media)
}

const SELECT: &str = "SELECT id,restaurant_id,food_log_id,category,original_name,mime_type,original_rel_path,preview_rel_path,thumbnail_rel_path,width,height,file_size_bytes,captured_at_ms,caption,created_at_ms FROM media";

pub fn restaurant_active(transaction: &Transaction<'_>, id: &str) -> AppResult<bool> {
    Ok(transaction
        .query_row(
            "SELECT 1 FROM restaurants WHERE id=?1 AND deleted_at_ms IS NULL",
            [id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}
pub fn food_log_at_restaurant(
    transaction: &Transaction<'_>,
    id: &str,
    restaurant_id: &str,
) -> AppResult<bool> {
    Ok(transaction
        .query_row(
            "SELECT 1 FROM food_logs WHERE id=?1 AND restaurant_id=?2",
            params![id, restaurant_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}
pub fn by_sha(transaction: &Transaction<'_>, sha256: &str) -> AppResult<Option<Media>> {
    Ok(transaction
        .query_row(&format!("{SELECT} WHERE sha256=?1"), [sha256], row)
        .optional()?)
}
pub fn get(transaction: &Transaction<'_>, id: &str) -> AppResult<Option<Media>> {
    Ok(transaction
        .query_row(
            &format!("{SELECT} WHERE id=?1 AND deleted_at_ms IS NULL"),
            [id],
            row,
        )
        .optional()?)
}
pub fn list(
    transaction: &Transaction<'_>,
    restaurant_id: Option<&str>,
    food_log_id: Option<&str>,
    category: Option<&str>,
    cursor: Option<(i64, String)>,
    limit: i64,
) -> AppResult<MediaPage> {
    let (time, id) = cursor.unwrap_or((i64::MAX, "\u{10ffff}".to_owned()));
    // `id` is the deterministic second key: galleries can safely page through rows
    // with identical capture times without omissions or duplicates.
    let mut statement = transaction.prepare("SELECT m.id,m.restaurant_id,m.food_log_id,m.category,m.original_name,m.mime_type,m.original_rel_path,m.preview_rel_path,m.thumbnail_rel_path,m.width,m.height,m.file_size_bytes,m.captured_at_ms,m.caption,m.created_at_ms,r.id,r.name,r.cuisine_key,r.icon_key,fl.id,fl.occurred_at_ms,fl.title,fl.meal_type,fl.dining_mode FROM media m JOIN restaurants r ON r.id=m.restaurant_id AND r.deleted_at_ms IS NULL LEFT JOIN food_logs fl ON fl.id=m.food_log_id AND fl.deleted_at_ms IS NULL WHERE m.deleted_at_ms IS NULL AND (?1 IS NULL OR m.restaurant_id=?1) AND (?2 IS NULL OR m.food_log_id=?2) AND (?3 IS NULL OR m.category=?3) AND (COALESCE(m.captured_at_ms,m.created_at_ms) < ?4 OR (COALESCE(m.captured_at_ms,m.created_at_ms)=?4 AND m.id < ?5)) ORDER BY COALESCE(m.captured_at_ms,m.created_at_ms) DESC,m.id DESC LIMIT ?6")?;
    let mut items = statement
        .query_map(
            params![restaurant_id, food_log_id, category, time, id, limit + 1],
            gallery_row,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let next_cursor = if items.len() > limit as usize {
        items.pop();
        items
            .last()
            .map(|m| format!("{}:{}", m.captured_at_ms.unwrap_or(m.created_at_ms), m.id))
    } else {
        None
    };
    Ok(MediaPage { items, next_cursor })
}
#[allow(clippy::too_many_arguments)]
pub fn create(
    transaction: &Transaction<'_>,
    media: &Media,
    sha256: &str,
    now: i64,
) -> AppResult<()> {
    transaction.execute("INSERT INTO media (id,restaurant_id,food_log_id,category,sha256,original_name,mime_type,original_rel_path,preview_rel_path,thumbnail_rel_path,width,height,file_size_bytes,captured_at_ms,caption,created_at_ms,updated_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?16)", params![media.id,media.restaurant_id,media.food_log_id,media.category,sha256,media.original_name,media.mime_type,media.original_rel_path,media.preview_rel_path,media.thumbnail_rel_path,media.width,media.height,media.file_size_bytes,media.captured_at_ms,media.caption,now])?;
    Ok(())
}
pub fn update_category(
    transaction: &Transaction<'_>,
    id: &str,
    category: &str,
    now: i64,
) -> AppResult<bool> {
    Ok(transaction.execute(
        "UPDATE media SET category=?2,updated_at_ms=?3 WHERE id=?1 AND deleted_at_ms IS NULL",
        params![id, category, now],
    )? == 1)
}
pub fn attach(
    transaction: &Transaction<'_>,
    id: &str,
    food_log_id: Option<&str>,
    now: i64,
) -> AppResult<bool> {
    Ok(transaction.execute(
        "UPDATE media SET food_log_id=?2,updated_at_ms=?3 WHERE id=?1 AND deleted_at_ms IS NULL",
        params![id, food_log_id, now],
    )? == 1)
}
pub fn caption(
    transaction: &Transaction<'_>,
    id: &str,
    caption: Option<&str>,
    now: i64,
) -> AppResult<bool> {
    Ok(transaction.execute(
        "UPDATE media SET caption=?2,updated_at_ms=?3 WHERE id=?1 AND deleted_at_ms IS NULL",
        params![id, caption, now],
    )? == 1)
}
pub fn soft_delete(transaction: &Transaction<'_>, id: &str, now: i64) -> AppResult<bool> {
    Ok(transaction.execute(
        "UPDATE media SET deleted_at_ms=?2,updated_at_ms=?2 WHERE id=?1 AND deleted_at_ms IS NULL",
        params![id, now],
    )? == 1)
}
pub fn restore(transaction: &Transaction<'_>, id: &str, now: i64) -> AppResult<bool> {
    Ok(transaction.execute("UPDATE media SET deleted_at_ms=NULL,updated_at_ms=?2 WHERE id=?1 AND deleted_at_ms IS NOT NULL",params![id,now])? == 1)
}
