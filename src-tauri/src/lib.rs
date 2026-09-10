mod config;
mod courses;
mod gam;

use courses::{ActionResult, Course, CourseDetail, CourseTeachers};
use config::Settings;

#[tauri::command]
fn list_courses(state: String, show_all_active: Option<bool>) -> Result<Vec<Course>, String> {
    let path = gam::gam_path_from_settings();
    let show_all = show_all_active.unwrap_or(false);
    gam::list_courses(&path, &state, show_all)
}

#[tauri::command]
fn fetch_course_teachers(ids: Vec<String>) -> Result<Vec<CourseTeachers>, String> {
    let path = gam::gam_path_from_settings();
    gam::fetch_course_teachers(&path, &ids)
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
fn get_course_detail(id: String) -> Result<CourseDetail, String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("Course id is empty".to_string());
    }
    let path = gam::gam_path_from_settings();
    gam::get_course_detail(&path, &id)
}

#[tauri::command]
fn transfer_ownership(id: String, email: String) -> Result<ActionResult, String> {
    let id = id.trim().to_string();
    let email = email.trim().to_string();
    if id.is_empty() {
        return Err("Course id is empty".to_string());
    }
    if email.is_empty() || !email.contains('@') {
        return Err("Enter a valid co-teacher email address".to_string());
    }
    let path = gam::gam_path_from_settings();
    match gam::transfer_ownership(&path, &id, &email) {
        Ok(()) => Ok(ActionResult {
            id: id.clone(),
            ok: true,
            message: format!("Ownership transferred to {email}"),
        }),
        Err(message) => Ok(ActionResult {
            id,
            ok: false,
            message,
        }),
    }
}

#[tauri::command]
fn remove_teachers(id: String, emails: Vec<String>) -> Result<Vec<ActionResult>, String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("Course id is empty".to_string());
    }
    let emails: Vec<String> = emails
        .into_iter()
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty())
        .collect();
    if emails.is_empty() {
        return Err("No teachers selected".to_string());
    }
    let path = gam::gam_path_from_settings();
    Ok(gam::batch_remove_teachers(&path, &id, &emails))
}

#[tauri::command]
fn remove_students(id: String, emails: Vec<String>) -> Result<Vec<ActionResult>, String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("Course id is empty".to_string());
    }
    let emails: Vec<String> = emails
        .into_iter()
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty())
        .collect();
    if emails.is_empty() {
        return Err("No students selected".to_string());
    }
    let path = gam::gam_path_from_settings();
    Ok(gam::batch_remove_students(&path, &id, &emails))
}

#[tauri::command]
fn add_student(id: String, email: String) -> Result<ActionResult, String> {
    let id = id.trim().to_string();
    let email = email.trim().to_string();
    if id.is_empty() {
        return Err("Course id is empty".to_string());
    }
    if email.is_empty() || !email.contains('@') {
        return Err("Enter a valid student email address".to_string());
    }
    let path = gam::gam_path_from_settings();
    match gam::add_student(&path, &id, &email) {
        Ok(()) => Ok(ActionResult {
            id: id.clone(),
            ok: true,
            message: format!("Added student {email}"),
        }),
        Err(message) => Ok(ActionResult {
            id,
            ok: false,
            message,
        }),
    }
}

#[tauri::command]
fn add_teacher_to_course(id: String, email: String) -> Result<ActionResult, String> {
    let id = id.trim().to_string();
    let email = email.trim().to_string();
    if id.is_empty() {
        return Err("Course id is empty".to_string());
    }
    if email.is_empty() || !email.contains('@') {
        return Err("Enter a valid teacher email address".to_string());
    }
    let path = gam::gam_path_from_settings();
    match gam::add_teacher(&path, &id, &email) {
        Ok(()) => Ok(ActionResult {
            id: id.clone(),
            ok: true,
            message: format!("Added teacher {email}"),
        }),
        Err(message) => Ok(ActionResult {
            id,
            ok: false,
            message,
        }),
    }
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
            fetch_course_teachers,
            archive_courses,
            activate_courses,
            add_teacher,
            add_teacher_to_course,
            add_student,
            get_course_detail,
            transfer_ownership,
            remove_teachers,
            remove_students,
            get_settings,
            set_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
