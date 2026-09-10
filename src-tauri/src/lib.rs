mod config;
mod courses;
mod gam;

use courses::{ActionResult, Course};
use config::Settings;

#[tauri::command]
fn list_courses(state: String) -> Result<Vec<Course>, String> {
    let path = gam::gam_path_from_settings();
    gam::list_courses(&path, &state)
}

#[tauri::command]
fn archive_courses(ids: Vec<String>) -> Result<Vec<ActionResult>, String> {
    if ids.is_empty() {
        return Err("No courses selected".to_string());
    }
    let path = gam::gam_path_from_settings();
    Ok(gam::batch_set_state(&path, &ids, "archived"))
}

#[tauri::command]
fn activate_courses(ids: Vec<String>) -> Result<Vec<ActionResult>, String> {
    if ids.is_empty() {
        return Err("No courses selected".to_string());
    }
    let path = gam::gam_path_from_settings();
    Ok(gam::batch_set_state(&path, &ids, "active"))
}

#[tauri::command]
fn add_teacher(ids: Vec<String>, email: String) -> Result<Vec<ActionResult>, String> {
    if ids.is_empty() {
        return Err("No courses selected".to_string());
    }
    let email = email.trim().to_string();
    if email.is_empty() || !email.contains('@') {
        return Err("Enter a valid teacher email address".to_string());
    }
    let path = gam::gam_path_from_settings();
    Ok(gam::batch_add_teacher(&path, &ids, &email))
}

#[tauri::command]
fn get_settings() -> Result<Settings, String> {
    Ok(gam::current_settings())
}

#[tauri::command]
fn set_settings(settings: Settings) -> Result<Settings, String> {
    if settings.gam_path.trim().is_empty() {
        return Err("gam path cannot be empty".to_string());
    }
    config::save_settings(&settings)?;
    Ok(config::load_settings())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_courses,
            archive_courses,
            activate_courses,
            add_teacher,
            get_settings,
            set_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
