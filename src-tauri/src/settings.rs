//! VisualGit's settings, as `settings.json` in its settings folder. What the
//! settings are, their defaults and their checks are the page's
//! (src/settings/settings.ts); this stores them, tells every open window when
//! they change, and opens the Settings window.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const WINDOW: &str = "settings";

fn file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("settings.json"))
}

/// The stored settings; None before any have been changed (every setting is then its default).
#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<Option<Value>, String> {
    let path = file(&app)?;
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| format!("{} is damaged ({e}), so the settings are back to their defaults.", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

/// Saves the settings and sends them to every window (`settings-changed`), so a change shows everywhere at once.
#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Value) -> Result<(), String> {
    if !settings.is_object() {
        return Err("Settings must be an object".into());
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    crate::library::write_file(&file(&app)?, &text).map_err(|e| format!("Could not save the settings: {e}"))?;
    app.emit("settings-changed", settings).map_err(|e| e.to_string())
}

/// Opens the Settings window, or brings it to the front.
#[tauri::command]
pub fn open_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(WINDOW) {
        let _ = w.unminimize();
        return w.set_focus().map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(&app, WINDOW, WebviewUrl::App("settings.html".into()))
        .title("Settings")
        .inner_size(760.0, 560.0)
        .min_inner_size(600.0, 420.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
