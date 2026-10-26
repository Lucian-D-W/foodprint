mod app_state;
mod commands;
mod db;
mod error;
mod paths;
mod repositories;
mod services;

use tauri::Manager;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

use crate::paths::PathResolver;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Keep this first: a second process must stop before future data initialization.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("foodmap".into()),
                    }),
                ])
                .max_file_size(1_000_000)
                .rotation_strategy(RotationStrategy::KeepSome(5))
                .build(),
        )
        .setup(|app| {
            let root = debug_data_root().unwrap_or_else(|| {
                app.path()
                    .app_local_data_dir()
                    .map_err(|_| error::AppError::DataDirectoryUnavailable)
            })?;
            #[cfg(debug_assertions)]
            let assets = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources");
            #[cfg(not(debug_assertions))]
            let assets = app
                .path()
                .resource_dir()
                .map_err(|_| error::AppError::DataDirectoryUnavailable)?
                .join("resources");
            let state =
                services::bootstrap::initialize(PathResolver::from_root(root), &assets, now_ms())?;
            app.manage(state);
            log::info!("FoodMap {} started", app.package_info().version);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap::app_bootstrap,
            commands::bootstrap::get_restaurant_position_locked,
            commands::bootstrap::set_restaurant_position_locked,
            commands::bootstrap::save_last_map_view,
            commands::food_log::list_food_logs,
            commands::food_log::create_food_log,
            commands::food_log::update_food_log,
            commands::food_log::soft_delete_food_log,
            commands::food_log::restore_food_log,
            commands::media::list_media,
            commands::media::import_media,
            commands::media::update_media_category,
            commands::media::attach_media_to_log,
            commands::media::update_media_caption,
            commands::media::soft_delete_media,
            commands::media::restore_media,
            commands::media::open_media_original,
            commands::map_centers::list_map_centers,
            commands::map_centers::create_map_center,
            commands::map_centers::update_map_center,
            commands::map_centers::move_map_center,
            commands::map_centers::attach_map_center_region,
            commands::map_centers::delete_map_center,
            commands::offline_regions::list_cached_regions,
            commands::offline_regions::search_places,
            commands::offline_regions::resolve_nearby_place,
            commands::offline_regions::estimate_cached_region,
            commands::offline_regions::create_cached_region,
            commands::offline_regions::delete_cached_region,
            commands::restaurant::list_restaurant_map,
            commands::restaurant::restaurant_manifest,
            commands::restaurant::get_restaurant,
            commands::restaurant::create_restaurant,
            commands::restaurant::update_restaurant_profile,
            commands::restaurant::update_restaurant_status,
            commands::restaurant::set_restaurant_map_position_locked,
            commands::restaurant::move_restaurant,
            commands::restaurant::soft_delete_restaurant,
            commands::restaurant::restore_restaurant,
            commands::restaurant::create_tag,
            commands::restaurant::list_tags,
            commands::restaurant::rename_tag,
            commands::restaurant::delete_tag,
            commands::restaurant::set_restaurant_tag,
            commands::stage8::list_trash,
            commands::stage8::restore_trash_item,
            commands::stage8::permanently_delete_trash_item,
            commands::stage8::retry_file_cleanup,
            commands::stage8::create_backup,
            commands::stage8::inspect_backup,
            commands::stage8::restore_backup,
            commands::stage8::open_app_data_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running FoodMap");
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// A debug-only harness escape hatch for the Windows release verification. It
// is deliberately absent from release binaries: normal users always receive
// the platform AppLocalData directory.
#[cfg(debug_assertions)]
fn debug_data_root() -> Option<Result<std::path::PathBuf, error::AppError>> {
    std::env::var_os("FOODMAP_TEST_DATA_ROOT").map(|value| {
        let root = std::path::PathBuf::from(value);
        if root.is_absolute() {
            Ok(root)
        } else {
            Err(error::AppError::DataDirectoryUnavailable)
        }
    })
}

#[cfg(not(debug_assertions))]
fn debug_data_root() -> Option<Result<std::path::PathBuf, error::AppError>> {
    None
}

#[cfg(test)]
mod tests;
