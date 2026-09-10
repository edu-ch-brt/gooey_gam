use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

pub const DEFAULT_GAM_PATH: &str = r"C:\GAM7\gam.exe";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub gam_path: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            gam_path: DEFAULT_GAM_PATH.to_string(),
        }
    }
}

fn settings_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("gam_classroom_gui")
}

fn settings_path() -> PathBuf {
    settings_dir().join("settings.json")
}

pub fn load_settings() -> Settings {
    let path = settings_path();
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save_settings(settings: &Settings) -> Result<(), String> {
    let dir = settings_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create config dir {}: {e}", dir.display()))?;
    let path = settings_path();
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("Cannot write {}: {e}", path.display()))?;
    Ok(())
}

pub fn resolve_gam_path(settings: &Settings) -> PathBuf {
    PathBuf::from(&settings.gam_path)
}


