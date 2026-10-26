use crate::app_state::AppState;
use crate::repositories::restaurant::{Restaurant, RestaurantMap, Tag};
use crate::services::restaurant::RestaurantService;
use serde::Deserialize;
use tauri::State;

fn service(state: &AppState) -> Result<RestaurantService, String> {
    RestaurantService::new(
        state.db.clone(),
        &state._paths.root().join("assets/food-icons/manifest.json"),
    )
}
#[tauri::command]
pub async fn restaurant_manifest(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let path = state._paths.root().join("assets/food-icons/manifest.json");
    let origin = state.local_server.origin.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let raw = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
        let manifest: serde_json::Value = serde_json::from_str(raw.trim_start_matches('\u{feff}'))
            .map_err(|error| error.to_string())?;
        let icon_entries = manifest
            .get("icons")
            .and_then(serde_json::Value::as_object)
            .ok_or_else(|| "Installed icon manifest has no icons".to_owned())?;
        let cuisines = manifest
            .get("cuisines")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| "Installed icon manifest has no cuisines".to_owned())?
            .iter()
            .map(|entry| {
                let mut cuisine = entry.clone();
                let icon_keys = entry
                    .get("icons")
                    .and_then(serde_json::Value::as_array)
                    .ok_or_else(|| "Installed cuisine entry has no icons".to_owned())?;
                let icons = icon_keys
                    .iter()
                    .map(|key| {
                        let key = key
                            .as_str()
                            .ok_or_else(|| "Installed cuisine icon key is invalid".to_owned())?;
                        let src = icon_entries
                            .get(key)
                            .and_then(|icon| icon.get("src"))
                            .and_then(serde_json::Value::as_str)
                            .ok_or_else(|| {
                                format!("Installed icon manifest has no src for {key}")
                            })?;
                        Ok(serde_json::json!({ "key": key, "src": src }))
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                cuisine["icons"] = serde_json::Value::Array(icons);
                Ok(cuisine)
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(serde_json::json!({
            "cuisines": cuisines,
            "foodIconBaseUrl": format!("{origin}/assets/food-icons"),
        }))
    })
    .await
    .map_err(|_| "FoodMap restaurant manifest task failed".to_owned())?
}
fn run<T: Send + 'static>(
    state: &AppState,
    op: impl FnOnce(RestaurantService) -> Result<T, String> + Send + 'static,
) -> impl std::future::Future<Output = Result<T, String>> {
    let service = service(state);
    async move {
        let service = service?;
        tauri::async_runtime::spawn_blocking(move || op(service))
            .await
            .map_err(|_| "FoodMap restaurant task failed".to_owned())?
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRestaurant {
    pub name: String,
    pub longitude: f64,
    pub latitude: f64,
    pub cuisine_key: String,
    pub icon_key: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRestaurantProfile {
    pub id: String,
    pub name: String,
    pub cuisine_key: String,
    pub icon_key: String,
    pub map_icon_scale: f64,
    pub phone: Option<String>,
    pub opening_hours_text: Option<String>,
    pub address_note: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRestaurantStatus {
    pub id: String,
    pub visit_status: Option<String>,
    pub affection_status: Option<String>,
    pub is_bookmarked: Option<bool>,
    pub overall_rating: Option<Option<i64>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestaurantId {
    pub id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveRestaurant {
    pub id: String,
    pub longitude: f64,
    pub latitude: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRestaurantPositionLocked {
    pub id: String,
    pub position_locked: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInput {
    pub name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameTag {
    pub id: String,
    pub name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestaurantTag {
    pub restaurant_id: String,
    pub tag_id: String,
    pub associated: bool,
}
#[tauri::command]
pub async fn list_restaurant_map(state: State<'_, AppState>) -> Result<Vec<RestaurantMap>, String> {
    run(&state, |s| s.list_map().map_err(|e| e.to_string())).await
}
#[tauri::command]
pub async fn get_restaurant(
    input: RestaurantId,
    state: State<'_, AppState>,
) -> Result<Option<Restaurant>, String> {
    run(&state, move |s| s.get(input.id).map_err(|e| e.to_string())).await
}
#[tauri::command]
pub async fn create_restaurant(
    input: CreateRestaurant,
    state: State<'_, AppState>,
) -> Result<Restaurant, String> {
    run(&state, move |s| {
        s.create(
            input.name,
            input.longitude,
            input.latitude,
            input.cuisine_key,
            input.icon_key,
        )
    })
    .await
}
#[tauri::command]
pub async fn update_restaurant_profile(
    input: UpdateRestaurantProfile,
    state: State<'_, AppState>,
) -> Result<Restaurant, String> {
    run(&state, move |s| {
        s.update_profile(
            input.id,
            input.name,
            input.cuisine_key,
            input.icon_key,
            input.map_icon_scale,
            input.phone,
            input.opening_hours_text,
            input.address_note,
        )
    })
    .await
}
#[tauri::command]
pub async fn update_restaurant_status(
    input: UpdateRestaurantStatus,
    state: State<'_, AppState>,
) -> Result<Restaurant, String> {
    run(&state, move |s| {
        s.update_status(
            input.id,
            input.visit_status,
            input.affection_status,
            input.is_bookmarked,
            input.overall_rating,
        )
    })
    .await
}
#[tauri::command]
pub async fn set_restaurant_map_position_locked(
    input: SetRestaurantPositionLocked,
    state: State<'_, AppState>,
) -> Result<Restaurant, String> {
    run(&state, move |s| {
        s.set_position_locked(input.id, input.position_locked)
    })
    .await
}
#[tauri::command]
pub async fn move_restaurant(
    input: MoveRestaurant,
    state: State<'_, AppState>,
) -> Result<Restaurant, String> {
    run(&state, move |s| {
        s.move_to(input.id, input.longitude, input.latitude)
    })
    .await
}
#[tauri::command]
pub async fn soft_delete_restaurant(
    input: RestaurantId,
    state: State<'_, AppState>,
) -> Result<(), String> {
    run(&state, move |s| s.soft_delete(input.id)).await
}
#[tauri::command]
pub async fn restore_restaurant(
    input: RestaurantId,
    state: State<'_, AppState>,
) -> Result<Restaurant, String> {
    run(&state, move |s| s.restore(input.id)).await
}
#[tauri::command]
pub async fn create_tag(input: TagInput, state: State<'_, AppState>) -> Result<Tag, String> {
    run(&state, move |s| s.create_tag(input.name)).await
}
#[tauri::command]
pub async fn list_tags(state: State<'_, AppState>) -> Result<Vec<Tag>, String> {
    run(&state, |s| s.list_tags().map_err(|e| e.to_string())).await
}
#[tauri::command]
pub async fn rename_tag(input: RenameTag, state: State<'_, AppState>) -> Result<Tag, String> {
    run(&state, move |s| s.rename_tag(input.id, input.name)).await
}
#[tauri::command]
pub async fn delete_tag(input: RestaurantId, state: State<'_, AppState>) -> Result<(), String> {
    run(&state, move |s| s.delete_tag(input.id)).await
}
#[tauri::command]
pub async fn set_restaurant_tag(
    input: RestaurantTag,
    state: State<'_, AppState>,
) -> Result<(), String> {
    run(&state, move |s| {
        s.set_tag(input.restaurant_id, input.tag_id, input.associated)
    })
    .await
}
