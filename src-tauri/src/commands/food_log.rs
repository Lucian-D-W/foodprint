use serde::Deserialize;
use tauri::State;

use crate::app_state::AppState;
use crate::repositories::food_log::{FoodLog, FoodLogPage};
use crate::services::food_log::FoodLogService;

fn run<T: Send + 'static>(
    state: &AppState,
    op: impl FnOnce(FoodLogService) -> Result<T, String> + Send + 'static,
) -> impl std::future::Future<Output = Result<T, String>> {
    let service = FoodLogService::new(state.db.clone());
    async move {
        tauri::async_runtime::spawn_blocking(move || op(service))
            .await
            .map_err(|_| "FoodMap food log task failed".to_owned())?
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFoodLog {
    pub restaurant_id: String,
    pub occurred_at_ms: i64,
    pub tz_offset_minutes: i64,
    pub meal_type: Option<String>,
    pub dining_mode: Option<String>,
    pub title: Option<String>,
    pub note: String,
    pub rating: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFoodLog {
    pub id: String,
    pub occurred_at_ms: i64,
    pub tz_offset_minutes: i64,
    pub meal_type: Option<String>,
    pub dining_mode: Option<String>,
    pub title: Option<String>,
    pub note: String,
    pub rating: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFoodLogs {
    pub restaurant_id: String,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FoodLogId {
    pub id: String,
}

#[tauri::command]
pub async fn list_food_logs(
    input: ListFoodLogs,
    state: State<'_, AppState>,
) -> Result<FoodLogPage, String> {
    run(&state, move |service| {
        service.list(input.restaurant_id, input.cursor, input.limit)
    })
    .await
}
#[tauri::command]
pub async fn create_food_log(
    input: CreateFoodLog,
    state: State<'_, AppState>,
) -> Result<FoodLog, String> {
    run(&state, move |service| {
        service.create(
            input.restaurant_id,
            input.occurred_at_ms,
            input.tz_offset_minutes,
            input.meal_type,
            input.dining_mode,
            input.title,
            input.note,
            input.rating,
        )
    })
    .await
}
#[tauri::command]
pub async fn update_food_log(
    input: UpdateFoodLog,
    state: State<'_, AppState>,
) -> Result<FoodLog, String> {
    run(&state, move |service| {
        service.update(
            input.id,
            input.occurred_at_ms,
            input.tz_offset_minutes,
            input.meal_type,
            input.dining_mode,
            input.title,
            input.note,
            input.rating,
        )
    })
    .await
}
#[tauri::command]
pub async fn soft_delete_food_log(
    input: FoodLogId,
    state: State<'_, AppState>,
) -> Result<(), String> {
    run(&state, move |service| service.soft_delete(input.id)).await
}
#[tauri::command]
pub async fn restore_food_log(
    input: FoodLogId,
    state: State<'_, AppState>,
) -> Result<FoodLog, String> {
    run(&state, move |service| service.restore(input.id)).await
}
