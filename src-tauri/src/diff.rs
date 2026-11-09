//! The diff window: what one committed changeset changed, everything a branch
//! changed (from the changeset it was created from to its latest), the
//! differences between any two changesets, or the history of one file.
//! Read-only; the window reads everything through the read-only `git` command.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, Window};

use crate::branch::commit_id;
use crate::pending::repo_root;

#[derive(Clone, Serialize)]
pub struct DiffWindowInfo {
    repo: String,
    /// The changeset shown (for a branch, its latest).
    changeset: String,
    /// For a branch: its name, and the changeset it started from (none for a root branch).
    branch: Option<String>,
    /// For a branch, where it started; without a branch, the changeset `changeset` is compared with.
    base: Option<String>,
    /// For a file's history: its repository-relative path.
    file: Option<String>,
}

/// Which changeset each diff window shows, by window label.
#[derive(Default)]
pub struct DiffWindows(Mutex<HashMap<String, DiffWindowInfo>>);

/// Opens the diff window for changeset `at`, or brings it forward if it is already open.
/// With `branch`, it shows all of that branch's changes: from `base` (or from nothing) to `at`.
/// With `base` and no `branch`, it shows the differences between changesets `base` and `at`.
#[tauri::command]
pub async fn open_diff_window(
    app: AppHandle,
    windows: State<'_, DiffWindows>,
    repo: String,
    at: String,
    branch: Option<String>,
    base: Option<String>,
    file: Option<String>,
) -> Result<(), String> {
    let root = repo_root(&repo)?;
    let changeset = commit_id(&root, &at)?;
    let base = base.map(|b| commit_id(&root, &b)).transpose()?;
    let mut hasher = DefaultHasher::new();
    (&root, &changeset, &branch, &base, &file).hash(&mut hasher);
    let label = format!("diff-{:016x}", hasher.finish());

    if let Some(existing) = app.get_webview_window(&label) {
        existing.unminimize().ok();
        existing.show().map_err(|e| e.to_string())?;
        return existing.set_focus().map_err(|e| e.to_string());
    }
    let title = match (&file, &branch) {
        (Some(path), _) => format!("History of {path}"),
        (None, Some(name)) => format!("Changes on {name}"),
        (None, None) => match &base {
            Some(b) => format!("Changesets {} → {}", &b[..8], &changeset[..8]),
            None => format!("Changeset {}", &changeset[..8]),
        },
    };
    let info = DiffWindowInfo { repo: root.to_string_lossy().into_owned(), changeset, branch, base, file };
    windows.0.lock().unwrap().insert(label.clone(), info);
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("diff.html".into()))
        .title(title)
        .inner_size(1280.0, 820.0)
        .min_inner_size(760.0, 480.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The repository and changeset the calling diff window shows.
#[tauri::command]
pub fn diff_window_info(window: Window, windows: State<'_, DiffWindows>) -> Option<DiffWindowInfo> {
    windows.0.lock().unwrap().get(window.label()).cloned()
}
