use rusqlite::{params, OptionalExtension, Row, Transaction};
use serde::Serialize;

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestaurantMap {
    pub id: String,
    pub name: String,
    pub longitude: f64,
    pub latitude: f64,
    pub cuisine_key: String,
    pub icon_key: String,
    pub visit_status: String,
    pub affection_status: String,
    pub is_bookmarked: bool,
    pub overall_rating: Option<i64>,
    pub map_icon_scale: f64,
    pub position_locked: bool,
    pub log_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restaurant {
    pub id: String,
    pub name: String,
    pub longitude: f64,
    pub latitude: f64,
    pub cuisine_key: String,
    pub icon_key: String,
    pub phone: Option<String>,
    pub opening_hours_text: Option<String>,
    pub address_note: Option<String>,
    pub visit_status: String,
    pub affection_status: String,
    pub is_bookmarked: bool,
    pub overall_rating: Option<i64>,
    pub map_icon_scale: f64,
    pub position_locked: bool,
    pub tags: Vec<Tag>,
}

fn map_row(row: &Row<'_>) -> rusqlite::Result<RestaurantMap> {
    Ok(RestaurantMap {
        id: row.get(0)?,
        name: row.get(1)?,
        longitude: row.get(2)?,
        latitude: row.get(3)?,
        cuisine_key: row.get(4)?,
        icon_key: row.get(5)?,
        visit_status: row.get(6)?,
        affection_status: row.get(7)?,
        is_bookmarked: row.get::<_, i64>(8)? != 0,
        overall_rating: row.get(9)?,
        map_icon_scale: row.get(10)?,
        position_locked: row.get::<_, i64>(11)? != 0,
        log_count: row.get(12)?,
    })
}

pub fn list_map(transaction: &Transaction<'_>) -> AppResult<Vec<RestaurantMap>> {
    let mut statement = transaction.prepare("SELECT r.id, r.name, r.longitude, r.latitude, r.cuisine_key, r.icon_key, r.visit_status, r.affection_status, r.is_bookmarked, r.overall_rating, r.map_icon_scale, r.position_locked, COUNT(fl.id) AS log_count FROM restaurants r LEFT JOIN food_logs fl ON fl.restaurant_id = r.id AND fl.deleted_at_ms IS NULL WHERE r.deleted_at_ms IS NULL GROUP BY r.id ORDER BY r.updated_at_ms DESC, r.id")?;
    let restaurants = statement
        .query_map([], map_row)?
        .collect::<Result<_, _>>()?;
    Ok(restaurants)
}

pub fn get(transaction: &Transaction<'_>, id: &str) -> AppResult<Option<Restaurant>> {
    let restaurant = transaction.query_row("SELECT id, name, longitude, latitude, cuisine_key, icon_key, phone, opening_hours_text, address_note, visit_status, affection_status, is_bookmarked, overall_rating, map_icon_scale, position_locked FROM restaurants WHERE id = ?1 AND deleted_at_ms IS NULL", [id], |row| Ok(Restaurant { id: row.get(0)?, name: row.get(1)?, longitude: row.get(2)?, latitude: row.get(3)?, cuisine_key: row.get(4)?, icon_key: row.get(5)?, phone: row.get(6)?, opening_hours_text: row.get(7)?, address_note: row.get(8)?, visit_status: row.get(9)?, affection_status: row.get(10)?, is_bookmarked: row.get::<_, i64>(11)? != 0, overall_rating: row.get(12)?, map_icon_scale: row.get(13)?, position_locked: row.get::<_, i64>(14)? != 0, tags: Vec::new() })).optional()?;
    let Some(mut restaurant) = restaurant else {
        return Ok(None);
    };
    let mut statement = transaction.prepare("SELECT t.id, t.name FROM tags t JOIN restaurant_tags rt ON rt.tag_id = t.id WHERE rt.restaurant_id = ?1 ORDER BY t.name COLLATE NOCASE")?;
    restaurant.tags = statement
        .query_map([id], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(Some(restaurant))
}

#[allow(clippy::too_many_arguments)]
pub fn create(
    transaction: &Transaction<'_>,
    id: &str,
    name: &str,
    longitude: f64,
    latitude: f64,
    cuisine_key: &str,
    icon_key: &str,
    now_ms: i64,
) -> AppResult<()> {
    transaction.execute("INSERT INTO restaurants (id, name, longitude, latitude, cuisine_key, icon_key, map_icon_scale, created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1.0, ?7, ?7)", params![id, name, longitude, latitude, cuisine_key, icon_key, now_ms])?;
    Ok(())
}
#[allow(clippy::too_many_arguments)]
pub fn update_profile(
    transaction: &Transaction<'_>,
    id: &str,
    name: &str,
    cuisine_key: &str,
    icon_key: &str,
    map_icon_scale: f64,
    phone: Option<&str>,
    opening_hours_text: Option<&str>,
    address_note: Option<&str>,
    now_ms: i64,
) -> AppResult<bool> {
    Ok(transaction.execute("UPDATE restaurants SET name=?2,cuisine_key=?3,icon_key=?4,map_icon_scale=?5,phone=?6,opening_hours_text=?7,address_note=?8,updated_at_ms=?9 WHERE id=?1 AND deleted_at_ms IS NULL", params![id,name,cuisine_key,icon_key,map_icon_scale,phone,opening_hours_text,address_note,now_ms])? == 1)
}
pub fn update_status(
    transaction: &Transaction<'_>,
    id: &str,
    visit_status: &str,
    affection_status: &str,
    is_bookmarked: bool,
    overall_rating: Option<i64>,
    now_ms: i64,
) -> AppResult<bool> {
    Ok(transaction.execute("UPDATE restaurants SET visit_status=?2,affection_status=?3,is_bookmarked=?4,overall_rating=?5,updated_at_ms=?6 WHERE id=?1 AND deleted_at_ms IS NULL", params![id,visit_status,affection_status,is_bookmarked as i64,overall_rating,now_ms])? == 1)
}
pub fn set_position_locked(
    transaction: &Transaction<'_>,
    id: &str,
    position_locked: bool,
    now_ms: i64,
) -> AppResult<bool> {
    Ok(transaction.execute(
        "UPDATE restaurants SET position_locked=?2,updated_at_ms=?3 WHERE id=?1 AND deleted_at_ms IS NULL",
        params![id, position_locked as i64, now_ms],
    )? == 1)
}
pub fn move_to(
    transaction: &Transaction<'_>,
    id: &str,
    longitude: f64,
    latitude: f64,
    now_ms: i64,
) -> AppResult<bool> {
    Ok(transaction.execute("UPDATE restaurants SET longitude=?2,latitude=?3,updated_at_ms=?4 WHERE id=?1 AND deleted_at_ms IS NULL AND position_locked=0", params![id,longitude,latitude,now_ms])? == 1)
}
pub fn soft_delete(transaction: &Transaction<'_>, id: &str, now_ms: i64) -> AppResult<bool> {
    Ok(transaction.execute("UPDATE restaurants SET deleted_at_ms=?2,updated_at_ms=?2 WHERE id=?1 AND deleted_at_ms IS NULL", params![id,now_ms])? == 1)
}
pub fn restore(transaction: &Transaction<'_>, id: &str, now_ms: i64) -> AppResult<bool> {
    Ok(transaction.execute("UPDATE restaurants SET deleted_at_ms=NULL,updated_at_ms=?2 WHERE id=?1 AND deleted_at_ms IS NOT NULL", params![id,now_ms])? == 1)
}
pub fn create_tag(
    transaction: &Transaction<'_>,
    id: &str,
    name: &str,
    now_ms: i64,
) -> AppResult<Tag> {
    transaction.execute(
        "INSERT INTO tags (id,name,created_at_ms,updated_at_ms) VALUES (?1,?2,?3,?3)",
        params![id, name, now_ms],
    )?;
    Ok(Tag {
        id: id.into(),
        name: name.into(),
    })
}
pub fn list_tags(transaction: &Transaction<'_>) -> AppResult<Vec<Tag>> {
    let mut s = transaction.prepare("SELECT id,name FROM tags ORDER BY name COLLATE NOCASE")?;
    let tags = s
        .query_map([], |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(tags)
}
pub fn rename_tag(
    transaction: &Transaction<'_>,
    id: &str,
    name: &str,
    now_ms: i64,
) -> AppResult<bool> {
    Ok(transaction.execute(
        "UPDATE tags SET name=?2,updated_at_ms=?3 WHERE id=?1",
        params![id, name, now_ms],
    )? == 1)
}
pub fn delete_tag(transaction: &Transaction<'_>, id: &str) -> AppResult<bool> {
    Ok(transaction.execute("DELETE FROM tags WHERE id=?1", [id])? == 1)
}
pub fn set_tag(
    transaction: &Transaction<'_>,
    restaurant_id: &str,
    tag_id: &str,
    associated: bool,
    now_ms: i64,
) -> AppResult<bool> {
    if associated {
        Ok(transaction.execute("INSERT OR IGNORE INTO restaurant_tags (restaurant_id,tag_id,created_at_ms) SELECT id,?2,?3 FROM restaurants WHERE id=?1 AND deleted_at_ms IS NULL",params![restaurant_id,tag_id,now_ms])? == 1)
    } else {
        Ok(transaction.execute(
            "DELETE FROM restaurant_tags WHERE restaurant_id=?1 AND tag_id=?2",
            params![restaurant_id, tag_id],
        )? == 1)
    }
}
