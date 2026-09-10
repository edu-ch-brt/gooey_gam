use csv::ReaderBuilder;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::Cursor;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Course {
    pub id: String,
    pub name: String,
    pub enrollment_code: String,
    pub teachers: Vec<String>,
    pub state: String,
    /// Classroom `updateTime` (ISO), best proxy for recent activity — not last access.
    #[serde(default)]
    pub update_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CourseTeachers {
    pub id: String,
    pub teachers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActionResult {
    pub id: String,
    pub ok: bool,
    pub message: String,
}

/// Parse `gam print courses ... formatjson` stdout into courses.
///
/// GAM 7 on Windows typically emits CSV with columns `id,JSON` or
/// `id,JSON,JSON-teachers` (not a bare JSON array). Also accepts a JSON
/// array / object / NDJSON for fixtures and alternate modes.
pub fn parse_courses_json(raw: &str) -> Result<Vec<Course>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    // Drop GAM progress lines; locate meaningful payload.
    let payload = extract_payload(trimmed);

    if looks_like_gam_csv(&payload) {
        return parse_gam_csv_json(&payload);
    }

    let start = payload
        .find(['[', '{'])
        .ok_or_else(|| "No JSON object/array or GAM CSV found in gam output".to_string())?;
    let json_part = &payload[start..];

    if let Ok(value) = serde_json::from_str::<Value>(json_part) {
        return courses_from_value(value);
    }

    // NDJSON fallback
    let mut courses = Vec::new();
    for line in json_part.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(line)
            .map_err(|e| format!("Failed to parse gam JSON line: {e}"))?;
        courses.extend(courses_from_value(value)?);
    }
    Ok(courses)
}

fn extract_payload(raw: &str) -> String {
    let mut lines = Vec::new();
    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        // Skip common GAM progress chatter
        if t.starts_with("Getting ")
            || t.starts_with("Got ")
            || t.starts_with("GAM ")
            || t.starts_with("Help:")
            || t.starts_with("Python ")
            || t.starts_with("Path:")
            || t.starts_with("Config ")
            || t.starts_with("Time:")
            || t.starts_with("Windows ")
        {
            continue;
        }
        lines.push(line);
    }
    lines.join("\n")
}

fn looks_like_gam_csv(payload: &str) -> bool {
    let first = payload.lines().next().unwrap_or("").trim_start_matches('\u{feff}');
    first.starts_with("id,JSON") || first.starts_with("\"id\",\"JSON\"")
}

fn parse_gam_csv_json(payload: &str) -> Result<Vec<Course>, String> {
    let mut rdr = ReaderBuilder::new()
        .flexible(true)
        .from_reader(Cursor::new(payload.as_bytes()));

    let headers = rdr
        .headers()
        .map_err(|e| format!("GAM CSV header error: {e}"))?
        .clone();

    let json_idx = headers
        .iter()
        .position(|h| h.eq_ignore_ascii_case("JSON"))
        .ok_or_else(|| "GAM CSV missing JSON column".to_string())?;
    let teachers_idx = headers
        .iter()
        .position(|h| h.eq_ignore_ascii_case("JSON-teachers"));

    let mut courses = Vec::new();
    for (row_i, rec) in rdr.records().enumerate() {
        let rec = rec.map_err(|e| format!("GAM CSV row {row_i}: {e}"))?;
        let json_text = rec.get(json_idx).unwrap_or("").trim();
        if json_text.is_empty() {
            continue;
        }
        let mut value: Value = serde_json::from_str(json_text)
            .map_err(|e| format!("GAM CSV JSON column row {row_i}: {e}"))?;

        // Prefer dedicated JSON-teachers column when present
        if let Some(ti) = teachers_idx {
            if let Some(tjson) = rec.get(ti).map(str::trim).filter(|s| !s.is_empty()) {
                if let Ok(teachers_val) = serde_json::from_str::<Value>(tjson) {
                    if let Some(obj) = value.as_object_mut() {
                        obj.insert("teachers".to_string(), teachers_val);
                    }
                }
            }
        }

        // Expand flattened teachers.N.emailAddress into teachers list if needed
        expand_flattened_teachers(&mut value);

        courses.push(course_from_object(value)?);
    }
    Ok(courses)
}

fn expand_flattened_teachers(value: &mut Value) {
    let Some(obj) = value.as_object_mut() else {
        return;
    };

    // If teachers is already an array, keep it.
    if matches!(obj.get("teachers"), Some(Value::Array(_))) {
        return;
    }

    let mut by_index: BTreeMap<usize, String> = BTreeMap::new();
    for (k, v) in obj.iter() {
        // teachers.0.emailAddress
        if let Some(rest) = k.strip_prefix("teachers.") {
            let mut parts = rest.splitn(2, '.');
            if let (Some(idx_s), Some(field)) = (parts.next(), parts.next()) {
                if field == "emailAddress" {
                    if let (Ok(idx), Some(email)) = (idx_s.parse::<usize>(), v.as_str()) {
                        by_index.insert(idx, email.to_string());
                    }
                }
            }
        }
    }
    if !by_index.is_empty() {
        let arr: Vec<Value> = by_index
            .into_values()
            .map(Value::String)
            .collect();
        obj.insert("teachers".to_string(), Value::Array(arr));
    }
}

fn courses_from_value(value: Value) -> Result<Vec<Course>, String> {
    match value {
        Value::Array(items) => items.into_iter().map(course_from_object).collect(),
        Value::Object(_) => Ok(vec![course_from_object(value)?]),
        other => Err(format!("Unexpected JSON root type: {other}")),
    }
}

fn course_from_object(value: Value) -> Result<Course, String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "Course entry is not an object".to_string())?;

    let id = obj
        .get("id")
        .or_else(|| obj.get("courseId"))
        .and_then(|v| match v {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        })
        .unwrap_or_default();
    if id.is_empty() {
        return Err("Course missing id".to_string());
    }

    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("(unnamed)")
        .to_string();

    let enrollment_code = obj
        .get("enrollmentCode")
        .or_else(|| obj.get("enrollment_code"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let state = obj
        .get("courseState")
        .or_else(|| obj.get("state"))
        .or_else(|| obj.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let teachers = extract_teachers(obj.get("teachers"));

    let update_time = obj
        .get("updateTime")
        .or_else(|| obj.get("update_time"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(Course {
        id,
        name,
        enrollment_code,
        teachers,
        state,
        update_time,
    })
}

fn extract_teachers(value: Option<&Value>) -> Vec<String> {
    match value {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Number(_)) => Vec::new(), // GAM count field when flattened
        Some(Value::String(s)) => s
            .split(',')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect(),
        Some(Value::Array(items)) => items.iter().filter_map(teacher_label).collect(),
        Some(other) => vec![other.to_string()],
    }
}

fn teacher_label(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    let obj = v.as_object()?;

    if let Some(profile) = obj.get("profile").and_then(|p| p.as_object()) {
        if let Some(email) = profile.get("emailAddress").and_then(|e| e.as_str()) {
            return Some(email.to_string());
        }
        if let Some(name) = profile
            .get("name")
            .and_then(|n| n.get("fullName"))
            .and_then(|n| n.as_str())
        {
            return Some(name.to_string());
        }
    }

    if let Some(email) = obj.get("emailAddress").and_then(|e| e.as_str()) {
        return Some(email.to_string());
    }
    if let Some(email) = obj.get("email").and_then(|e| e.as_str()) {
        return Some(email.to_string());
    }
    if let Some(name) = obj.get("fullName").and_then(|e| e.as_str()) {
        return Some(name.to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fixture_show_teachers() {
        let raw = include_str!("fixtures/courses_show_teachers.json");
        let courses = parse_courses_json(raw).expect("parse");
        assert_eq!(courses.len(), 3);
        assert_eq!(courses[0].id, "12345678901");
        assert_eq!(courses[0].name, "Year 7 Maths");
        assert_eq!(courses[0].enrollment_code, "abc123");
        assert_eq!(
            courses[0].teachers,
            vec!["alice@example.com", "bob@example.com"]
        );
        assert_eq!(courses[0].state, "ACTIVE");
        assert_eq!(courses[1].teachers, vec!["carol@example.com"]);
        assert_eq!(courses[2].teachers, vec!["dave@example.com", "eve@example.com"]);
    }

    #[test]
    fn parses_fixture_without_teachers() {
        let raw = include_str!("fixtures/courses_without_teachers.json");
        let courses = parse_courses_json(raw).expect("parse");
        assert_eq!(courses.len(), 2);
        assert_eq!(courses[0].id, "111");
        assert_eq!(courses[0].name, "Fast List Course");
        assert_eq!(courses[0].enrollment_code, "join01");
        assert!(courses[0].teachers.is_empty());
        assert_eq!(courses[0].state, "ACTIVE");
        assert_eq!(courses[1].id, "222");
        assert_eq!(courses[1].state, "ARCHIVED");
        assert!(courses[1].teachers.is_empty());
    }

    #[test]
    fn parses_gam7_csv_without_teachers_column() {
        let raw = include_str!("fixtures/courses_gam7_csv_no_teachers.txt");
        let courses = parse_courses_json(raw).expect("parse csv no teachers");
        assert_eq!(courses.len(), 2);
        assert_eq!(courses[0].id, "884230888941");
        assert_eq!(courses[0].name, "IT BTEC AAQ 13IV-B");
        assert_eq!(courses[0].enrollment_code, "lspgv4uu");
        assert!(courses[0].teachers.is_empty());
        assert_eq!(courses[0].state, "ACTIVE");
        assert_eq!(courses[1].id, "555");
        assert!(courses[1].teachers.is_empty());
    }

    #[test]
    fn parses_gam7_csv_formatjson() {
        let raw = include_str!("fixtures/courses_gam7_csv_json.txt");
        let courses = parse_courses_json(raw).expect("parse csv");
        assert_eq!(courses.len(), 2);
        assert_eq!(courses[0].id, "884230888941");
        assert_eq!(courses[0].name, "IT BTEC AAQ 13IV-B");
        assert_eq!(courses[0].enrollment_code, "lspgv4uu");
        assert_eq!(
            courses[0].teachers,
            vec!["salalasundaram2@cheam.sutton.sch.uk"]
        );
        assert_eq!(courses[0].state, "ACTIVE");
        assert_eq!(courses[1].teachers, vec!["onlyflat@example.com"]);
    }

    #[test]
    fn parses_empty() {
        assert!(parse_courses_json("").unwrap().is_empty());
        assert!(parse_courses_json("   ").unwrap().is_empty());
    }

    #[test]
    fn parses_with_leading_noise() {
        let raw = "Getting Courses\nGot 1 Courses...\n[{ \"id\": \"1\", \"name\": \"A\", \"enrollmentCode\": \"x\" }]";
        let courses = parse_courses_json(raw).unwrap();
        assert_eq!(courses.len(), 1);
        assert_eq!(courses[0].id, "1");
    }

    #[test]
    fn parses_update_time() {
        let raw = r#"[{ "id": "9", "name": "Z", "enrollmentCode": "c", "updateTime": "2025-01-02T03:04:05Z" }]"#;
        let courses = parse_courses_json(raw).unwrap();
        assert_eq!(courses[0].update_time, "2025-01-02T03:04:05Z");
    }
}
