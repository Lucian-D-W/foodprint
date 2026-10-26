use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegionBounds {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OfflineRegion {
    pub id: String,
    pub label: String,
    pub display_name: String,
    pub locale: String,
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
    pub center_longitude: f64,
    pub center_latitude: f64,
    pub return_zoom: f64,
    pub tile_min_zoom: u8,
    pub tile_max_zoom: u8,
    pub provider_url: String,
    pub tile_template: String,
    pub provider_version: String,
    pub attribution: String,
    pub tile_count: u64,
    pub byte_size: u64,
    pub status: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl OfflineRegion {
    pub fn bounds(&self) -> RegionBounds {
        RegionBounds {
            west: self.west,
            south: self.south,
            east: self.east,
            north: self.north,
        }
    }
}

fn row_to_region(row: &Row<'_>) -> rusqlite::Result<OfflineRegion> {
    Ok(OfflineRegion {
        id: row.get(0)?,
        label: row.get(1)?,
        display_name: row.get(2)?,
        locale: row.get(3)?,
        west: row.get(4)?,
        south: row.get(5)?,
        east: row.get(6)?,
        north: row.get(7)?,
        center_longitude: row.get(8)?,
        center_latitude: row.get(9)?,
        return_zoom: row.get(10)?,
        tile_min_zoom: row.get(11)?,
        tile_max_zoom: row.get(12)?,
        provider_url: row.get(13)?,
        tile_template: row.get(14)?,
        provider_version: row.get(15)?,
        attribution: row.get(16)?,
        tile_count: row.get::<_, i64>(17)?.max(0) as u64,
        byte_size: row.get::<_, i64>(18)?.max(0) as u64,
        status: row.get(19)?,
        created_at_ms: row.get(20)?,
        updated_at_ms: row.get(21)?,
    })
}

const SELECT_COLUMNS: &str = "id, label, display_name, locale, west, south, east, north, center_longitude, center_latitude, return_zoom, tile_min_zoom, tile_max_zoom, provider_url, tile_template, provider_version, attribution, tile_count, byte_size, status, created_at_ms, updated_at_ms";

pub fn list(connection: &Connection) -> AppResult<Vec<OfflineRegion>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {SELECT_COLUMNS} FROM offline_regions WHERE status='ready' ORDER BY updated_at_ms DESC, id"
    ))?;
    let regions = statement
        .query_map([], row_to_region)?
        .collect::<Result<_, _>>()?;
    Ok(regions)
}

pub fn get(connection: &Connection, id: &str) -> AppResult<Option<OfflineRegion>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {SELECT_COLUMNS} FROM offline_regions WHERE id=?1 AND status='ready'"
    ))?;
    Ok(statement.query_row([id], row_to_region).optional()?)
}

pub fn insert(transaction: &Transaction<'_>, region: &OfflineRegion) -> AppResult<()> {
    transaction.execute(
        "INSERT INTO offline_regions (id,label,display_name,locale,west,south,east,north,center_longitude,center_latitude,return_zoom,tile_min_zoom,tile_max_zoom,provider_url,tile_template,provider_version,attribution,tile_count,byte_size,status,created_at_ms,updated_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)",
        params![
            region.id,
            region.label,
            region.display_name,
            region.locale,
            region.west,
            region.south,
            region.east,
            region.north,
            region.center_longitude,
            region.center_latitude,
            region.return_zoom,
            region.tile_min_zoom,
            region.tile_max_zoom,
            region.provider_url,
            region.tile_template,
            region.provider_version,
            region.attribution,
            region.tile_count as i64,
            region.byte_size as i64,
            region.status,
            region.created_at_ms,
            region.updated_at_ms,
        ],
    )?;
    Ok(())
}

pub fn delete(transaction: &Transaction<'_>, id: &str) -> AppResult<bool> {
    Ok(transaction.execute("DELETE FROM offline_regions WHERE id=?1", [id])? == 1)
}

pub fn cached_response(connection: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT response_json FROM map_geocode_cache WHERE cache_key=?1",
            [key],
            |row| row.get(0),
        )
        .optional()?)
}

pub fn save_cached_response(
    transaction: &Transaction<'_>,
    key: &str,
    response_json: &str,
    now_ms: i64,
) -> AppResult<()> {
    transaction.execute(
        "INSERT INTO map_geocode_cache(cache_key,response_json,created_at_ms) VALUES(?1,?2,?3) ON CONFLICT(cache_key) DO UPDATE SET response_json=excluded.response_json,created_at_ms=excluded.created_at_ms",
        params![key, response_json, now_ms],
    )?;
    Ok(())
}
