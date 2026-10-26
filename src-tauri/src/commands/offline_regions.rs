use serde::Deserialize;
use tauri::State;

use crate::{
    app_state::AppState,
    repositories::offline_regions::{OfflineRegion, RegionBounds},
    services::offline_regions::{
        CreateRegionInput, GeocodedPlace, OfflineRegionService, RegionEstimate,
    },
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceSearchInput {
    pub query: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReversePlaceInput {
    pub longitude: f64,
    pub latitude: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionEstimateInput {
    pub bounds: RegionBounds,
    pub center_longitude: f64,
    pub center_latitude: f64,
    pub return_zoom: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionIdInput {
    pub id: String,
}

fn service(state: &State<'_, AppState>) -> std::sync::Arc<OfflineRegionService> {
    state.offline_regions.clone()
}

#[tauri::command]
pub async fn list_cached_regions(state: State<'_, AppState>) -> Result<Vec<OfflineRegion>, String> {
    let service = service(&state);
    tauri::async_runtime::spawn_blocking(move || service.list())
        .await
        .map_err(|_| "FoodMap offline region list task failed".to_owned())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn search_places(
    input: PlaceSearchInput,
    state: State<'_, AppState>,
) -> Result<Vec<GeocodedPlace>, String> {
    service(&state)
        .search(&input.query)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn resolve_nearby_place(
    input: ReversePlaceInput,
    state: State<'_, AppState>,
) -> Result<GeocodedPlace, String> {
    service(&state)
        .reverse(input.longitude, input.latitude)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn estimate_cached_region(
    input: RegionEstimateInput,
    state: State<'_, AppState>,
) -> Result<RegionEstimate, String> {
    service(&state)
        .estimate(
            input.bounds,
            input.center_longitude,
            input.center_latitude,
            input.return_zoom,
        )
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn create_cached_region(
    input: CreateRegionInput,
    state: State<'_, AppState>,
) -> Result<OfflineRegion, String> {
    service(&state)
        .create(input)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn delete_cached_region(
    input: RegionIdInput,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let service = service(&state);
    tauri::async_runtime::spawn_blocking(move || service.delete(&input.id))
        .await
        .map_err(|_| "FoodMap offline region delete task failed".to_owned())?
        .map_err(|error| error.to_string())
}
