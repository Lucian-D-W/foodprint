use std::path::PathBuf;

use serde::Deserialize;
use tauri::State;
use tauri_plugin_opener::OpenerExt;

use crate::{
    app_state::AppState,
    services::stage8::{BackupSummary, Stage8Service, TrashPage},
};

fn run<T: Send + 'static>(
    state: &AppState,
    op: impl FnOnce(Stage8Service) -> Result<T, String> + Send + 'static,
) -> impl std::future::Future<Output = Result<T, String>> {
    let service = Stage8Service::new(state.db.clone(), state._paths.clone());
    async move {
        tauri::async_runtime::spawn_blocking(move || op(service))
            .await
            .map_err(|_| "FoodMap data-safety task failed".to_owned())?
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashInput {
    pub entity: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItemInput {
    pub entity: String,
    pub id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPathInput {
    pub destination_path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePathInput {
    pub source_path: String,
}

#[tauri::command]
pub async fn list_trash(
    input: TrashInput,
    state: State<'_, AppState>,
) -> Result<TrashPage, String> {
    let _ = input.entity;
    run(&state, |s| s.list_trash().map_err(|e| e.to_string())).await
}
#[tauri::command]
pub async fn restore_trash_item(
    input: TrashItemInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    run(&state, move |s| {
        s.restore_trash(&input.entity, &input.id)
            .map_err(|e| e.to_string())
    })
    .await
}
#[tauri::command]
pub async fn permanently_delete_trash_item(
    input: TrashItemInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    run(&state, move |s| {
        s.permanently_delete(&input.entity, &input.id)
            .map_err(|e| e.to_string())
    })
    .await
}
#[tauri::command]
pub async fn retry_file_cleanup(state: State<'_, AppState>) -> Result<usize, String> {
    run(&state, |s| s.retry_cleanup().map_err(|e| e.to_string())).await
}
#[tauri::command]
pub async fn create_backup(
    input: BackupPathInput,
    state: State<'_, AppState>,
) -> Result<BackupSummary, String> {
    run(&state, move |s| {
        s.backup(PathBuf::from(input.destination_path))
            .map_err(|e| e.to_string())
    })
    .await
}
#[tauri::command]
pub async fn inspect_backup(
    input: RestorePathInput,
    state: State<'_, AppState>,
) -> Result<BackupSummary, String> {
    run(&state, move |s| {
        s.inspect_restore(&PathBuf::from(input.source_path))
            .map_err(|e| e.to_string())
    })
    .await
}
#[tauri::command]
pub async fn restore_backup(
    input: RestorePathInput,
    state: State<'_, AppState>,
) -> Result<BackupSummary, String> {
    run(&state, move |s| {
        s.restore(&PathBuf::from(input.source_path))
            .map_err(|e| e.to_string())
    })
    .await
}
#[tauri::command]
pub fn open_app_data_directory(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    app.opener()
        .open_path(
            state._paths.root().to_string_lossy().into_owned(),
            None::<&str>,
        )
        .map_err(|e| e.to_string())
}
