use crate::config::{self, Settings};
use crate::courses::{parse_courses_json, ActionResult, Course, CourseTeachers};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug)]
pub struct GamOutput {
    pub stdout: String,
    pub stderr: String,
    pub status: i32,
}

pub fn run_gam(gam_path: &Path, args: &[&str]) -> Result<GamOutput, String> {
    if !gam_path.is_file() {
        return Err(format!(
            "gam executable not found at {}. Open Settings and set the correct path.",
            gam_path.display()
        ));
    }

    let mut cmd = Command::new(gam_path);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to start gam ({}): {e}", gam_path.display()))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let status = output.status.code().unwrap_or(-1);

    Ok(GamOutput {
        stdout,
        stderr,
        status,
    })
}

fn require_success(out: &GamOutput, context: &str) -> Result<(), String> {
    if out.status == 0 {
        return Ok(());
    }
    let detail = if !out.stderr.trim().is_empty() {
        out.stderr.trim()
    } else {
        out.stdout.trim()
    };
    Err(format!("{context} failed (exit {}): {detail}", out.status))
}

/// Fast list: no `show teachers` (teachers filled later per visible page).
pub fn list_courses(gam_path: &Path, state: &str) -> Result<Vec<Course>, String> {
    let state = normalize_state(state)?;
    let out = run_gam(
        gam_path,
        &["print", "courses", "states", state, "formatjson"],
    )?;
    require_success(&out, &format!("List {state} courses"))?;
    parse_courses_json(&out.stdout)
}

/// Fetch teachers for specific course IDs.
/// Prefers one batched GAM call:
/// `gam print courses course <id1> course <id2> ... show teachers formatjson`
/// Falls back to one call per id if the batch fails.
pub fn fetch_course_teachers(
    gam_path: &Path,
    ids: &[String],
) -> Result<Vec<CourseTeachers>, String> {
    let mut unique: Vec<String> = Vec::new();
    for id in ids {
        let id = id.trim();
        if id.is_empty() {
            continue;
        }
        if !unique.iter().any(|u| u == id) {
            unique.push(id.to_string());
        }
    }
    if unique.is_empty() {
        return Ok(Vec::new());
    }

    match fetch_teachers_batch(gam_path, &unique) {
        Ok(rows) => Ok(rows),
        Err(batch_err) => {
            // Fall back to per-course so a single bad id does not block the page.
            let mut rows = Vec::new();
            let mut errors = Vec::new();
            for id in &unique {
                match fetch_teachers_batch(gam_path, &[id.clone()]) {
                    Ok(mut one) => rows.append(&mut one),
                    Err(e) => errors.push(format!("{id}: {e}")),
                }
            }
            if rows.is_empty() && !errors.is_empty() {
                return Err(format!(
                    "Fetch teachers failed (batch: {batch_err}; per-course: {})",
                    errors.join("; ")
                ));
            }
            Ok(rows)
        }
    }
}

fn fetch_teachers_batch(
    gam_path: &Path,
    ids: &[String],
) -> Result<Vec<CourseTeachers>, String> {
    let mut args: Vec<String> = vec!["print".into(), "courses".into()];
    for id in ids {
        args.push("course".into());
        args.push(id.clone());
    }
    args.push("show".into());
    args.push("teachers".into());
    args.push("formatjson".into());

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_gam(gam_path, &arg_refs)?;
    require_success(
        &out,
        &format!("Fetch teachers for {} course(s)", ids.len()),
    )?;
    let courses = parse_courses_json(&out.stdout)?;
    Ok(courses
        .into_iter()
        .map(|c| CourseTeachers {
            id: c.id,
            teachers: c.teachers,
        })
        .collect())
}

pub fn set_course_state(gam_path: &Path, id: &str, state: &str) -> Result<(), String> {
    let state = normalize_state(state)?;
    let out = run_gam(gam_path, &["update", "course", id, "state", state])?;
    require_success(&out, &format!("Update course {id} to {state}"))
}

pub fn add_teacher(gam_path: &Path, id: &str, email: &str) -> Result<(), String> {
    let email = email.trim();
    if email.is_empty() {
        return Err("Teacher email is empty".to_string());
    }
    let out = run_gam(gam_path, &["course", id, "add", "teachers", email])?;
    require_success(&out, &format!("Add teacher {email} to course {id}"))
}

pub fn batch_set_state(gam_path: &Path, ids: &[String], state: &str) -> Vec<ActionResult> {
    ids.iter()
        .map(|id| match set_course_state(gam_path, id, state) {
            Ok(()) => ActionResult {
                id: id.clone(),
                ok: true,
                message: format!("Set to {state}"),
            },
            Err(message) => ActionResult {
                id: id.clone(),
                ok: false,
                message,
            },
        })
        .collect()
}

pub fn batch_add_teacher(gam_path: &Path, ids: &[String], email: &str) -> Vec<ActionResult> {
    ids.iter()
        .map(|id| match add_teacher(gam_path, id, email) {
            Ok(()) => ActionResult {
                id: id.clone(),
                ok: true,
                message: format!("Added {email}"),
            },
            Err(message) => ActionResult {
                id: id.clone(),
                ok: false,
                message,
            },
        })
        .collect()
}

fn normalize_state(state: &str) -> Result<&'static str, String> {
    let lower = state.trim().to_ascii_lowercase();
    match lower.as_str() {
        "active" => Ok("active"),
        "archived" => Ok("archived"),
        other => Err(format!(
            "Unsupported course state '{other}' (use active or archived)"
        )),
    }
}

pub fn gam_path_from_settings() -> PathBuf {
    let settings = config::load_settings();
    config::resolve_gam_path(&settings)
}

pub fn current_settings() -> Settings {
    config::load_settings()
}
