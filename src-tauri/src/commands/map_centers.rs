use serde::Deserialize;
use tauri::State;

use crate::app_state::AppState;
use crate::repositories::{map_centers::MapCenter, offline_regions::RegionBounds};
use crate::services::map_centers::MapCenterService;

fn run<T: Send + 'static>(
    state: &AppState,
    op: impl FnOnce(MapCenterService) -> Result<T, String> + Send + 'static,
) -> impl std::future::Future<Output = Result<T, String>> {
    let service = MapCenterService::new(state.db.clone());
    async move {
        tauri::async_runtime::spawn_blocking(move || op(service))
            .await
            .map_err(|_| "FoodMap center task failed".to_owned())?
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMapCenter {
    pub name: String,
    pub kind: String,
    pub icon_variant: u8,
    pub map_icon_scale: f64,
    pub longitude: f64,
    pub latitude: f64,
    pub coverage_bounds: RegionBounds,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMapCenter {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub icon_variant: u8,
    pub map_icon_scale: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveMapCenter {
    pub id: String,
    pub longitude: f64,
    pub latitude: f64,
    pub coverage_bounds: RegionBounds,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapCenterId {
    pub id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachMapCenterRegion {
    pub id: String,
    pub region_id: String,
}

#[tauri::command]
pub async fn list_map_centers(state: State<'_, AppState>) -> Result<Vec<MapCenter>, String> {
    run(&state, |service| {
        service.list().map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn create_map_center(
    input: CreateMapCenter,
    state: State<'_, AppState>,
) -> Result<MapCenter, String> {
    run(&state, move |service| {
        service.create(
            input.name,
            input.kind,
            input.icon_variant,
            input.map_icon_scale,
            input.longitude,
            input.latitude,
            input.coverage_bounds,
        )
    })
    .await
}

#[tauri::command]
pub async fn update_map_center(
    input: UpdateMapCenter,
    state: State<'_, AppState>,
) -> Result<MapCenter, String> {
    run(&state, move |service| {
        service.update(
            input.id,
            input.name,
            input.kind,
            input.icon_variant,
            input.map_icon_scale,
        )
    })
    .await
}

#[tauri::command]
pub async fn move_map_center(
    input: MoveMapCenter,
    state: State<'_, AppState>,
) -> Result<MapCenter, String> {
    run(&state, move |service| {
        service.move_to(
            input.id,
            input.longitude,
            input.latitude,
            input.coverage_bounds,
        )
    })
    .await
}

#[tauri::command]
pub async fn attach_map_center_region(
    input: AttachMapCenterRegion,
    state: State<'_, AppState>,
) -> Result<MapCenter, String> {
    run(&state, move |service| {
        service.attach_region(input.id, input.region_id)
    })
    .await
}

#[tauri::command]
pub async fn delete_map_center(
    input: MapCenterId,
    state: State<'_, AppState>,
) -> Result<(), String> {
    run(&state, move |service| service.delete(input.id)).await
}
