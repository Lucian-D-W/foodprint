use serde::{Deserialize, Serialize};
use tauri::State;

use crate::app_state::AppState;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::repositories::system;

const RESTAURANT_POSITION_LOCK_KEY: &str = "restaurant_position_locked";

pub(crate) fn read_restaurant_position_locked(db: &Db) -> AppResult<bool> {
    db.with_read(|connection| {
        let value = connection.query_row(
            "SELECT value_json FROM app_settings WHERE key = ?1",
            [RESTAURANT_POSITION_LOCK_KEY],
            |row| row.get::<_, String>(0),
        );
        match value {
            Ok(value) => serde_json::from_str(&value).map_err(|_| AppError::BackgroundTask),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(error) => Err(error.into()),
        }
    })
}

pub(crate) fn persist_restaurant_position_locked(db: &Db, locked: bool) -> AppResult<()> {
    let value = serde_json::to_string(&locked).map_err(|_| AppError::BackgroundTask)?;
    db.with_write(|transaction| {
        transaction.execute(
            "INSERT INTO app_settings (key, value_json, updated_at_ms) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
            rusqlite::params![RESTAURANT_POSITION_LOCK_KEY, value, crate::now_ms()],
        )?;
        Ok(())
    })
}

pub(crate) fn manifest(value: &str) -> Result<serde_json::Value, String> {
    serde_json::from_str(value.trim_start_matches('\u{feff}')).map_err(|error| error.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapInfo {
    pub database_ready: bool,
    pub local_asset_origin: String,
    pub map_manifest: serde_json::Value,
    pub icon_manifest: serde_json::Value,
    pub food_icon_base_url: String,
    pub last_map_view: Option<MapView>,
    pub restaurant_position_locked: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapView {
    pub longitude: f64,
    pub latitude: f64,
    pub zoom: f64,
}

#[tauri::command]
pub async fn app_bootstrap(state: State<'_, AppState>) -> Result<BootstrapInfo, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || system::ensure_integrity(&db))
        .await
        .map_err(|_| "FoodMap bootstrap task failed".to_owned())?
        .map_err(|error| error.to_string())?;
    let map_manifest =
        std::fs::read_to_string(state._paths.root().join("maps/default/manifest.json"))
            .map_err(|error| error.to_string())
            .and_then(|value| manifest(&value))?;
    let icon_manifest =
        std::fs::read_to_string(state._paths.root().join("assets/food-icons/manifest.json"))
            .map_err(|error| error.to_string())
            .and_then(|value| manifest(&value))?;
    let last_map_view = state
        .db
        .with_read(|connection| {
            let value = connection.query_row(
                "SELECT value_json FROM app_settings WHERE key = 'last_map_view'",
                [],
                |row| row.get::<_, String>(0),
            );
            match value {
                Ok(value) => serde_json::from_str(&value)
                    .map(Some)
                    .map_err(|_| crate::error::AppError::BackgroundTask),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(error) => Err(error.into()),
            }
        })
        .map_err(|error| error.to_string())?;
    let restaurant_position_locked =
        read_restaurant_position_locked(&state.db).map_err(|error| error.to_string())?;
    let origin = state.local_server.origin.clone();
    Ok(BootstrapInfo {
        database_ready: true,
        food_icon_base_url: format!("{origin}/assets/food-icons"),
        local_asset_origin: origin,
        map_manifest,
        icon_manifest,
        last_map_view,
        restaurant_position_locked,
    })
}

#[tauri::command]
pub async fn get_restaurant_position_locked(state: State<'_, AppState>) -> Result<bool, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || read_restaurant_position_locked(&db))
        .await
        .map_err(|_| "FoodMap position lock read failed".to_owned())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn set_restaurant_position_locked(
    locked: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || persist_restaurant_position_locked(&db, locked))
        .await
        .map_err(|_| "FoodMap position lock save failed".to_owned())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn save_last_map_view(view: MapView, state: State<'_, AppState>) -> Result<(), String> {
    if !view.longitude.is_finite() || !view.latitude.is_finite() || !view.zoom.is_finite() {
        return Err("Map view must use finite coordinates".to_owned());
    }
    let value = serde_json::to_string(&view).map_err(|error| error.to_string())?;
    let now_ms = crate::now_ms();
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        db.with_write(|transaction| {
            transaction.execute(
                "INSERT INTO app_settings (key, value_json, updated_at_ms) VALUES ('last_map_view', ?1, ?2) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
                rusqlite::params![value, now_ms],
            )?;
            Ok(())
        })
    }).await.map_err(|_| "FoodMap map view save failed".to_owned())?.map_err(|error| error.to_string())
}
