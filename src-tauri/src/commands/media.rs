use serde::Deserialize;
use tauri::State;
use tauri_plugin_opener::OpenerExt;

use crate::{
    app_state::AppState,
    repositories::media::{Media, MediaPage},
    services::media::{MediaImportResult, MediaService},
};

fn run<T: Send + 'static>(
    state: &AppState,
    op: impl FnOnce(MediaService) -> Result<T, String> + Send + 'static,
) -> impl std::future::Future<Output = Result<T, String>> {
    let service = MediaService::new(state.db.clone(), state._paths.clone());
    async move {
        tauri::async_runtime::spawn_blocking(move || op(service))
            .await
            .map_err(|_| "FoodMap media task failed".to_owned())?
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListMedia {
    pub restaurant_id: Option<String>,
    pub food_log_id: Option<String>,
    pub category: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMedia {
    pub restaurant_id: String,
    pub food_log_id: Option<String>,
    pub category: String,
    pub paths: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaId {
    pub id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMediaCategory {
    pub id: String,
    pub category: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachMedia {
    pub id: String,
    pub food_log_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMediaCaption {
    pub id: String,
    pub caption: Option<String>,
}

#[tauri::command]
pub async fn list_media(input: ListMedia, state: State<'_, AppState>) -> Result<MediaPage, String> {
    run(&state, move |s| {
        s.list(
            input.restaurant_id,
            input.food_log_id,
            input.category,
            input.cursor,
            input.limit,
        )
    })
    .await
}
#[tauri::command]
pub async fn import_media(
    input: ImportMedia,
    state: State<'_, AppState>,
) -> Result<MediaImportResult, String> {
    run(&state, move |s| {
        s.import(
            input.restaurant_id,
            input.food_log_id,
            input.category,
            input.paths,
        )
    })
    .await
}
#[tauri::command]
pub async fn update_media_category(
    input: UpdateMediaCategory,
    state: State<'_, AppState>,
) -> Result<Media, String> {
    run(&state, move |s| s.update_category(input.id, input.category)).await
}
#[tauri::command]
pub async fn attach_media_to_log(
    input: AttachMedia,
    state: State<'_, AppState>,
) -> Result<Media, String> {
    run(&state, move |s| s.attach(input.id, input.food_log_id)).await
}
#[tauri::command]
pub async fn update_media_caption(
    input: UpdateMediaCaption,
    state: State<'_, AppState>,
) -> Result<Media, String> {
    run(&state, move |s| s.update_caption(input.id, input.caption)).await
}
#[tauri::command]
pub async fn soft_delete_media(input: MediaId, state: State<'_, AppState>) -> Result<(), String> {
    run(&state, move |s| s.soft_delete(input.id)).await
}
#[tauri::command]
pub async fn restore_media(input: MediaId, state: State<'_, AppState>) -> Result<Media, String> {
    run(&state, move |s| s.restore(input.id)).await
}
#[tauri::command]
pub async fn open_media_original(
    input: MediaId,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let path = run(&state, move |s| s.original_path(input.id)).await?;
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| error.to_string())
}
