//! The repositories VisualGit keeps a list of: workspaces (folders whose
//! repositories are all listed) and individual repositories, plus the one
//! last opened. Stored as `library.json` in VisualGit's settings folder, not
//! the webview's storage, which can be wiped. The list itself is kept by the
//! page (src/model/library.ts); this reads and writes it, and answers the
//! questions the repository menu asks about each repository.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::pending::{git, repo_root};
use crate::workspace::RepoInfo;

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Library {
    /// Workspace folders, in the order they were added.
    pub workspaces: Vec<String>,
    /// Repositories added on their own (opened from outside any workspace).
    pub repositories: Vec<String>,
    /// The repository open when VisualGit last closed, reopened at start.
    pub last: Option<String>,
}

fn file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("library.json"))
}

/// The stored list; None before there is one (the page then carries over what it remembered before).
#[tauri::command]
pub fn load_library(app: AppHandle) -> Result<Option<Library>, String> {
    read(&file(&app)?)
}

#[tauri::command]
pub fn save_library(app: AppHandle, library: Library) -> Result<(), String> {
    write(&file(&app)?, &library)
}

fn read(path: &Path) -> Result<Option<Library>, String> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| format!("{} is damaged ({e}), so the repository list starts empty.", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

/// Written beside the old file and then moved over it, so a crash mid-write never leaves half a list.
fn write(path: &Path, library: &Library) -> Result<(), String> {
    let dir = path.parent().ok_or("no settings folder")?;
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let text = serde_json::to_string_pretty(library).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("Could not save the repository list: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("Could not save the repository list: {e}"))
}

/// Each repository added on its own, as the Workspace view lists it; None for one that's gone
/// (moved or deleted), so it can be shown as missing rather than dropped.
#[tauri::command]
pub async fn repository_infos(paths: Vec<String>) -> Vec<Option<RepoInfo>> {
    tauri::async_runtime::spawn_blocking(move || crate::workspace::infos(&paths)).await.unwrap_or_default()
}

/// Whether a repository has uncommitted changes (including new files), for the dot in the
/// repository menu. Asked in the background, so it takes none of git's optional locks:
/// it never gets in the way of git running in that repository at the same time.
#[tauri::command]
pub async fn has_pending_changes(repo: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = repo_root(&repo)?;
        let out = git(&root, &["--no-optional-locks", "status", "--porcelain", "--untracked-files=normal"], &[], None)?;
        Ok(!out.trim().is_empty())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_list_in_a_file() {
        let dir = std::env::temp_dir().join(format!("visualgit-library-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("settings").join("library.json");
        assert_eq!(read(&path).unwrap(), None, "no list yet");

        let lib = Library { workspaces: vec!["/w".into()], repositories: vec!["/r".into()], last: Some("/r".into()) };
        write(&path, &lib).unwrap();
        assert_eq!(read(&path).unwrap(), Some(lib));
        assert!(!path.with_extension("json.tmp").exists());

        // Missing fields read as empty; a damaged file says so.
        fs::write(&path, r#"{"workspaces":["/w"]}"#).unwrap();
        assert_eq!(read(&path).unwrap(), Some(Library { workspaces: vec!["/w".into()], ..Default::default() }));
        fs::write(&path, "{not json").unwrap();
        assert!(read(&path).unwrap_err().contains("damaged"));
        let _ = fs::remove_dir_all(&dir);
    }
}
