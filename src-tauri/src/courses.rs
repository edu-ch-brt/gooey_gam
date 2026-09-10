use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Course {
    pub id: String,
    pub name: String,
    pub enrollment_code: String,
    pub teachers: Vec<String>,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActionResult {
    pub id: String,
    pub ok: bool,
    pub message: String,
}

/// Parse `gam print courses ... formatjson` stdout into courses.
/// Accepts a JSON array, a single object, or newline-delimited JSON objects.
pub fn parse_courses_json(raw: &str) -> Result<Vec<Course>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    // Strip possible GAM banners/noise: find first `[` or `{`
    let start = trimmed
        .find(['[', '{'])
        .ok_or_else(|| "No JSON object/array found in gam output".to_string())?;
    let json_part = &trimmed[start..];

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
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
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

    Ok(Course {
        id,
        name,
        enrollment_code,
        teachers,
        state,
    })
}

fn extract_teachers(value: Option<&Value>) -> Vec<String> {
    match value {
        None | Some(Value::Null) => Vec::new(),
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

    // Nested Classroom Teacher resource: teachers[].profile.emailAddress
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
        assert_eq!(courses[1].state, "ARCHIVED");

        assert_eq!(
            courses[2].teachers,
            vec!["dave@example.com", "eve@example.com"]
        );
    }

    #[test]
    fn parses_empty() {
        assert!(parse_courses_json("").unwrap().is_empty());
        assert!(parse_courses_json("   ").unwrap().is_empty());
    }

    #[test]
    fn parses_with_leading_noise() {
        let raw = "Getting Courses\n[{ \"id\": \"1\", \"name\": \"A\", \"enrollmentCode\": \"x\" }]";
        let courses = parse_courses_json(raw).unwrap();
        assert_eq!(courses.len(), 1);
        assert_eq!(courses[0].id, "1");
    }
}
