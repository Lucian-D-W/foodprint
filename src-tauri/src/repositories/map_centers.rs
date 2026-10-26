use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MapCenter {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub icon_variant: u8,
    pub map_icon_scale: f64,
    pub longitude: f64,
    pub latitude: f64,
    pub cached_region_ids: Vec<String>,
    pub primary_region_id: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

fn row_to_center(row: &Row<'_>) -> rusqlite::Result<MapCenter> {
    Ok(MapCenter {
        id: row.get(0)?,
        name: row.get(1)?,
        kind: row.get(2)?,
        icon_variant: row.get(3)?,
        map_icon_scale: row.get(4)?,
        longitude: row.get(5)?,
        latitude: row.get(6)?,
        cached_region_ids: Vec::new(),
        primary_region_id: None,
        created_at_ms: row.get(7)?,
        updated_at_ms: row.get(8)?,
    })
}

const SELECT_COLUMNS: &str =
    "id,name,kind,icon_variant,map_icon_scale,longitude,latitude,created_at_ms,updated_at_ms";

fn hydrate_links(connection: &Connection, center: &mut MapCenter) -> AppResult<()> {
    let mut statement = connection.prepare(
        "SELECT region_id FROM map_center_regions WHERE center_id=?1 ORDER BY linked_at_ms DESC, region_id",
    )?;
    center.cached_region_ids = statement
        .query_map([&center.id], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    center.primary_region_id = center.cached_region_ids.first().cloned();
    Ok(())
}

pub fn list(connection: &Connection) -> AppResult<Vec<MapCenter>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {SELECT_COLUMNS} FROM map_centers ORDER BY updated_at_ms DESC, id"
    ))?;
    let mut centers: Vec<MapCenter> = statement
        .query_map([], row_to_center)?
        .collect::<Result<_, _>>()?;
    for center in &mut centers {
        hydrate_links(connection, center)?;
    }
    Ok(centers)
}

pub fn get(connection: &Connection, id: &str) -> AppResult<Option<MapCenter>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {SELECT_COLUMNS} FROM map_centers WHERE id=?1"
    ))?;
    let mut center = statement.query_row([id], row_to_center).optional()?;
    if let Some(center) = center.as_mut() {
        hydrate_links(connection, center)?;
    }
    Ok(center)
}

#[allow(clippy::too_many_arguments)]
pub fn insert(
    transaction: &Transaction<'_>,
    id: &str,
    name: &str,
    kind: &str,
    icon_variant: u8,
    map_icon_scale: f64,
    longitude: f64,
    latitude: f64,
    now_ms: i64,
) -> AppResult<()> {
    transaction.execute(
        "INSERT INTO map_centers(id,name,kind,icon_variant,map_icon_scale,longitude,latitude,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8)",
        params![id, name, kind, icon_variant, map_icon_scale, longitude, latitude, now_ms],
    )?;
    Ok(())
}

pub fn update_identity(
    transaction: &Transaction<'_>,
    id: &str,
    name: &str,
    kind: &str,
    icon_variant: u8,
    map_icon_scale: f64,
    now_ms: i64,
) -> AppResult<bool> {
    Ok(transaction.execute(
        "UPDATE map_centers SET name=?2,kind=?3,icon_variant=?4,map_icon_scale=?5,updated_at_ms=?6 WHERE id=?1",
        params![id, name, kind, icon_variant, map_icon_scale, now_ms],
    )? == 1)
}

pub fn move_to(
    transaction: &Transaction<'_>,
    id: &str,
    longitude: f64,
    latitude: f64,
    now_ms: i64,
) -> AppResult<bool> {
    Ok(transaction.execute(
        "UPDATE map_centers SET longitude=?2,latitude=?3,updated_at_ms=?4 WHERE id=?1",
        params![id, longitude, latitude, now_ms],
    )? == 1)
}

pub fn replace_links(
    transaction: &Transaction<'_>,
    center_id: &str,
    region_ids: &[String],
    now_ms: i64,
) -> AppResult<()> {
    transaction.execute(
        "DELETE FROM map_center_regions WHERE center_id=?1",
        [center_id],
    )?;
    for (index, region_id) in region_ids.iter().enumerate() {
        transaction.execute(
            "INSERT OR IGNORE INTO map_center_regions(center_id,region_id,linked_at_ms) VALUES(?1,?2,?3)",
            params![center_id, region_id, now_ms - index as i64],
        )?;
    }
    Ok(())
}

pub fn delete(transaction: &Transaction<'_>, id: &str) -> AppResult<bool> {
    Ok(transaction.execute("DELETE FROM map_centers WHERE id=?1", [id])? == 1)
}
