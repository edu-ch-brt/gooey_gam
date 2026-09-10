use crate::config::{self, Settings};
use crate::courses::{parse_course_detail_json, parse_courses_json, ActionResult, Course, CourseDetail, CourseTeachers};
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

/// Calendar date two years before today (local), as `YYYY-MM-dd` for GAM timefilter.
pub fn two_years_ago_ymd() -> String {
    use chrono::{Datelike, Local};
    let today = Local::now().date_naive();
    let y = today.year() - 2;
    let start = today
        .with_year(y)
        .unwrap_or_else(|| today - chrono::Duration::days(365 * 2));
    start.format("%Y-%m-%d").to_string()
}

/// Fast list: no `show teachers` (teachers filled later per visible page).
///
/// For Active courses, unless `show_all_active` is true, applies GAM
/// `timefilter updatetime start <today-2y>` so the UI list is smaller.
/// Note: GAM may still enumerate all matching-state courses server-side then
/// filter locally - the filter mainly shrinks the list returned to the UI.
pub fn list_courses(
    gam_path: &Path,
    state: &str,
    show_all_active: bool,
) -> Result<Vec<Course>, String> {
    let state = normalize_state(state)?;
    let start_date = two_years_ago_ymd();
    let mut args: Vec<&str> = vec!["print", "courses", "states", state];
    if state == "active" && !show_all_active {
        args.extend_from_slice(&[
            "timefilter",
            "updatetime",
            "start",
            start_date.as_str(),
        ]);
    }
    args.push("formatjson");
    let out = run_gam(gam_path, &args)?;
    let ctx = if state == "active" && !show_all_active {
        format!("List active courses updated since {start_date}")
    } else {
        format!("List {state} courses")
    };
    require_success(&out, &ctx)?;
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

pub fn get_course_detail(gam_path: &Path, id: &str) -> Result<CourseDetail, String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("Course id is empty".to_string());
    }
    let out = run_gam(
        gam_path,
        &["info", "course", id, "owneremail", "show", "all", "formatjson"],
    )?;
    require_success(&out, &format!("Get course detail for {id}"))?;
    parse_course_detail_json(&out.stdout)
}

pub fn transfer_ownership(gam_path: &Path, id: &str, email: &str) -> Result<(), String> {
    let id = id.trim();
    let email = email.trim();
    if id.is_empty() {
        return Err("Course id is empty".to_string());
    }
    if email.is_empty() {
        return Err("New owner email is empty".to_string());
    }
    let out = run_gam(gam_path, &["update", "course", id, "owner", email])?;
    require_success(&out, &format!("Transfer ownership of course {id} to {email}"))
}

pub fn add_student(gam_path: &Path, id: &str, email: &str) -> Result<(), String> {
    let email = email.trim();
    if email.is_empty() {
        return Err("Student email is empty".to_string());
    }
    let out = run_gam(gam_path, &["course", id, "add", "students", email])?;
    require_success(&out, &format!("Add student {email} to course {id}"))
}

pub fn remove_teacher(gam_path: &Path, id: &str, email: &str) -> Result<(), String> {
    let email = email.trim();
    if email.is_empty() {
        return Err("Teacher email is empty".to_string());
    }
    let out = run_gam(gam_path, &["course", id, "remove", "teachers", email])?;
    require_success(&out, &format!("Remove teacher {email} from course {id}"))
}

pub fn remove_student(gam_path: &Path, id: &str, email: &str) -> Result<(), String> {
    let email = email.trim();
    if email.is_empty() {
        return Err("Student email is empty".to_string());
    }
    let out = run_gam(gam_path, &["course", id, "remove", "students", email])?;
    require_success(&out, &format!("Remove student {email} from course {id}"))
}

pub fn batch_remove_teachers(gam_path: &Path, id: &str, emails: &[String]) -> Vec<ActionResult> {
    emails
        .iter()
        .map(|email| match remove_teacher(gam_path, id, email) {
            Ok(()) => ActionResult {
                id: email.clone(),
                ok: true,
                message: format!("Removed teacher {email}"),
            },
            Err(message) => ActionResult {
                id: email.clone(),
                ok: false,
                message,
            },
        })
        .collect()
}

pub fn batch_remove_students(gam_path: &Path, id: &str, emails: &[String]) -> Vec<ActionResult> {
    emails
        .iter()
        .map(|email| match remove_student(gam_path, id, email) {
            Ok(()) => ActionResult {
                id: email.clone(),
                ok: true,
                message: format!("Removed student {email}"),
            },
            Err(message) => ActionResult {
                id: email.clone(),
                ok: false,
                message,
            },
        })
        .collect()
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

#[cfg(test)]
mod tests {
    use super::two_years_ago_ymd;

    #[test]
    fn two_years_ago_ymd_format() {
        let s = two_years_ago_ymd();
        assert_eq!(s.len(), 10, "{s}");
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[7..8], "-");
        let y: i32 = s[0..4].parse().unwrap();
        assert!(y >= 2020);
    }
}
