//! Adding a submodule, in two windows:
//!
//! 1. *Add Submodule* (`submodule-…`): choose the repository, on this computer
//!    or remote, and where it goes. A remote repository is cloned (bare) into
//!    the app's cache so its history can be shown.
//! 2. *Choose Changeset* (`submodule-pick-…`): that repository's Branch
//!    Explorer. Double-clicking a changeset adds the submodule checked out
//!    there (`git submodule add`, then a detached checkout), staged for the
//!    next commit.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};

use crate::branch::commit_id;
use crate::pending::{git, repo_root};
use crate::workspace::{check_remote_url, clone_with_progress};

#[derive(Clone, Serialize)]
pub struct AddSubmoduleInfo {
    /// The repository the submodule goes into.
    repo: String,
    /// The folder it goes in, relative to `repo` ("" for the top).
    folder: String,
    /// The open workspace, whose repositories are offered as local choices.
    workspace: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct PickChangesetInfo {
    repo: String,
    /// Where the submodule goes, relative to `repo`.
    path: String,
    /// What .gitmodules will record: the remote URL, or the local repository's folder.
    source: String,
    /// The repository whose history is shown: the local one, or the cached clone of a remote.
    history: String,
    remote: bool,
}

/// What each Add Submodule and Choose Changeset window is for, by window label.
#[derive(Default)]
pub struct SubmoduleWindows {
    add: Mutex<HashMap<String, AddSubmoduleInfo>>,
    pick: Mutex<HashMap<String, PickChangesetInfo>>,
}

fn label(prefix: &str, key: impl Hash) -> String {
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    format!("{prefix}{:016x}", hasher.finish())
}

fn focus(app: &AppHandle, label: &str) -> Option<Result<(), String>> {
    let existing = app.get_webview_window(label)?;
    existing.unminimize().ok();
    Some(existing.show().and_then(|_| existing.set_focus()).map_err(|e| e.to_string()))
}

/// Opens the Add Submodule window for a submodule in `folder` of `repo`.
#[tauri::command]
pub async fn open_add_submodule_window(
    app: AppHandle,
    windows: State<'_, SubmoduleWindows>,
    repo: String,
    folder: String,
    workspace: Option<String>,
) -> Result<(), String> {
    let root = repo_root(&repo)?;
    let folder = folder.trim_matches('/').to_string();
    if !folder.is_empty() {
        check_path(&folder)?;
    }
    let label = label("submodule-", (&root, &folder));
    if let Some(done) = focus(&app, &label) {
        return done;
    }
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let info = AddSubmoduleInfo { repo: root.to_string_lossy().into_owned(), folder, workspace };
    windows.add.lock().unwrap().insert(label.clone(), info);
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("submodule.html".into()))
        .title(format!("Add Submodule to {name}"))
        .inner_size(620.0, 560.0)
        .min_inner_size(480.0, 420.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn add_submodule_info(window: Window, windows: State<'_, SubmoduleWindows>) -> Option<AddSubmoduleInfo> {
    windows.add.lock().unwrap().get(window.label()).cloned()
}

#[tauri::command]
pub fn pick_changeset_info(window: Window, windows: State<'_, SubmoduleWindows>) -> Option<PickChangesetInfo> {
    windows.pick.lock().unwrap().get(window.label()).cloned()
}

/// A path inside the repository for the submodule: relative, no `..`, nothing named `.git`.
fn check_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("Enter where the submodule goes".into());
    }
    if path.starts_with('-') || path.chars().any(|c| c.is_control() || c == '\\') {
        return Err(format!("“{path}” isn't a usable path"));
    }
    for c in Path::new(path).components() {
        match c {
            Component::Normal(name) if name == ".git" => return Err(format!("{path} is inside .git")),
            Component::Normal(_) => {}
            _ => return Err(format!("{path} isn't a path inside the repository")),
        }
    }
    Ok(())
}

/// Where the submodule will go, refusing a place that's already taken.
fn submodule_target(root: &Path, path: &str) -> Result<PathBuf, String> {
    check_path(path)?;
    let target = root.join(path);
    if target.read_dir().is_ok_and(|mut d| d.next().is_some()) || target.is_file() {
        return Err(format!("{path} already exists; choose another name"));
    }
    // Following a symbolic link out of the repository isn't allowed.
    let mut dir = target.parent();
    while let Some(d) = dir {
        if let Ok(real) = d.canonicalize() {
            if !real.starts_with(root) {
                return Err(format!("{path} is outside the repository"));
            }
            break;
        }
        dir = d.parent();
    }
    if git(root, &["ls-files", "--"], &[path.to_string()], None).is_ok_and(|out| !out.trim().is_empty()) {
        return Err(format!("{path} is already in source control; choose another name"));
    }
    Ok(target)
}

/// Where remote repositories are cloned to show their history.
fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join("submodule-sources"))
}

/// Checks the choices in the Add Submodule window, clones a remote repository
/// so its history can be shown (sending git's progress to the window as
/// `submodule-progress`), then opens the Choose Changeset window and closes
/// the Add Submodule one.
#[tauri::command]
pub async fn choose_submodule_changeset(
    app: AppHandle,
    window: Window,
    windows: State<'_, SubmoduleWindows>,
    repo: String,
    path: String,
    source: String,
    remote: bool,
) -> Result<(), String> {
    let root = repo_root(&repo)?;
    let path = path.trim().trim_matches('/').to_string();
    submodule_target(&root, &path)?;
    let source = source.trim().to_string();

    let history = if remote {
        check_remote_url(&source).map_err(|e| e.replace("the remote to push to", "the URL of the repository"))?;
        let dir = cache_dir(&app)?.join(label("", (&root, &path, &source)));
        let progress = window.clone();
        let src = source.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
            // Always fresh: an old copy would show old history.
            if dir.exists() {
                std::fs::remove_dir_all(&dir).map_err(|e| format!("Could not clear {}: {e}", dir.display()))?;
            }
            std::fs::create_dir_all(dir.parent().unwrap()).map_err(|e| e.to_string())?;
            // Just the history, bare: its branches keep the remote's names, and there are no pending changes to show.
            clone_with_progress(&src, &dir, &["--bare"], &|line| {
                let _ = progress.emit("submodule-progress", line);
            })?;
            Ok(dir)
        })
        .await
        .map_err(|e| e.to_string())??
    } else {
        if source.is_empty() {
            return Err("Choose the repository to add".into());
        }
        let local = repo_root(&source).map_err(|_| format!("{source} isn't a Git repository (choose the folder that has the .git in it)"))?;
        if local == root {
            return Err("A repository can't be a submodule of itself".into());
        }
        local
    };
    if git(&history, &["rev-parse", "--verify", "-q", "HEAD^{commit}"], &[], None).is_err()
        && git(&history, &["for-each-ref", "--count=1", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"], &[], None)
            .is_ok_and(|s| s.trim().is_empty())
    {
        return Err("That repository has no changesets yet, so there's nothing to check out".into());
    }

    let info = PickChangesetInfo {
        repo: root.to_string_lossy().into_owned(),
        path: path.clone(),
        source: if remote { source } else { history.to_string_lossy().into_owned() },
        history: history.to_string_lossy().into_owned(),
        remote,
    };
    let label = label("submodule-pick-", (&root, &path));
    if let Some(old) = app.get_webview_window(&label) {
        old.destroy().ok();
    }
    windows.pick.lock().unwrap().insert(label.clone(), info);
    let picker = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("submodule-pick.html".into()))
        .title(format!("Choose the Changeset for {path}"))
        .inner_size(1180.0, 720.0)
        .min_inner_size(640.0, 400.0)
        .build()
        .map_err(|e| e.to_string())?;
    // Closed (added or not): forget it, and a remote's clone, which was only for showing its history.
    let handle = picker.app_handle().clone();
    picker.on_window_event(move |e| {
        if let WindowEvent::Destroyed = e {
            let windows = handle.state::<SubmoduleWindows>();
            let info = windows.pick.lock().unwrap().remove(&label);
            if let Some(info) = info.filter(|i| i.remote) {
                let _ = std::fs::remove_dir_all(&info.history);
            }
        }
    });
    windows.add.lock().unwrap().remove(window.label());
    window.destroy().map_err(|e| e.to_string())
}

/// Adds the submodule chosen in a Choose Changeset window, checked out at
/// `at`, and stages it (and .gitmodules). Tells the main window
/// (`submodule-added`) and closes the calling window.
#[tauri::command]
pub async fn add_submodule(app: AppHandle, window: Window, windows: State<'_, SubmoduleWindows>, at: String) -> Result<String, String> {
    let info = windows.pick.lock().unwrap().get(window.label()).cloned().ok_or("This window has no submodule to add")?;
    let at = commit_id(Path::new(&info.history), &at)?;
    let root = repo_root(&info.repo)?;
    let added = SubmoduleAdded { repo: info.repo.clone(), path: info.path.clone(), changeset: at.clone() };
    tauri::async_runtime::spawn_blocking(move || add(&root, &info, &at)).await.map_err(|e| e.to_string())??;
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("submodule-added", &added);
    }
    window.destroy().map_err(|e| e.to_string())?;
    Ok(added.changeset)
}

#[derive(Clone, Serialize)]
struct SubmoduleAdded {
    repo: String,
    path: String,
    changeset: String,
}

fn add(root: &Path, info: &PickChangesetInfo, at: &str) -> Result<(), String> {
    submodule_target(root, &info.path)?;
    // `file` transport is off by default for submodules; the user chose this repository.
    let mut args = vec!["-c", "protocol.file.allow=always", "submodule", "add", "--quiet"];
    // A remote was already cloned to show its history: borrow its objects instead of downloading them again.
    if info.remote {
        args.extend(["--reference", &info.history, "--dissociate"]);
    }
    args.extend(["--", &info.source, &info.path]);
    git(root, &args, &[], None).map_err(|e| format!("Could not add the submodule: {e}"))?;

    let sub = root.join(&info.path);
    let checkout = |what: &str| git(&sub, &["checkout", "--quiet", "--detach", what], &[], None);
    if checkout(at).is_err() {
        // Only on a branch the clone didn't bring (e.g. one of the source's remote-tracking branches): fetch it.
        git(&sub, &["-c", "protocol.file.allow=always", "fetch", "--quiet", "origin", at], &[], None)
            .and_then(|_| checkout(at))
            .map_err(|e| format!("Added the submodule, but could not check out {}: {e}", &at[..8]))?;
    }
    git(root, &["add", "--"], &[info.path.clone(), ".gitmodules".into()], None).map_err(|e| format!("Could not stage the submodule: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn run(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=T", "-c", "user.email=t@e", "-c", "init.defaultBranch=main"])
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn repo(dir: &Path, files: &[&str]) {
        std::fs::create_dir_all(dir).unwrap();
        run(dir, &["init", "-q"]);
        for f in files {
            std::fs::write(dir.join(f), f).unwrap();
            run(dir, &["add", "."]);
            run(dir, &["commit", "-qm", f]);
        }
    }

    #[test]
    fn adds_a_local_or_remote_repository_at_the_chosen_changeset() {
        let tmp = std::env::temp_dir().join(format!("visualgit-submodule-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let (lib, app) = (tmp.join("lib"), tmp.join("app"));
        repo(&lib, &["a", "b"]);
        repo(&app, &["x"]);
        let first = run(&lib, &["rev-parse", "HEAD~1"]);
        let root = repo_root(app.to_str().unwrap()).unwrap();
        let lib = repo_root(lib.to_str().unwrap()).unwrap();

        // On this computer: the folder itself, at an older changeset.
        let local = PickChangesetInfo {
            repo: root.to_string_lossy().into(),
            path: "libs/lib".into(),
            source: lib.to_string_lossy().into(),
            history: lib.to_string_lossy().into(),
            remote: false,
        };
        add(&root, &local, &first).unwrap();
        assert_eq!(run(&root.join("libs/lib"), &["rev-parse", "HEAD"]), first);
        let staged = run(&root, &["diff", "--cached", "--name-status"]);
        assert!(staged.contains("A\t.gitmodules") && staged.contains("A\tlibs/lib"), "{staged}");
        // Taken now.
        assert!(submodule_target(&root, "libs/lib").unwrap_err().contains("already"));

        // Remote: through a clone made only to show its history, which can go afterwards.
        let peek = tmp.join("peek");
        clone_with_progress(lib.to_str().unwrap(), &peek, &["--bare"], &|_| {}).unwrap();
        let remote = PickChangesetInfo {
            path: "other".into(),
            source: format!("file://{}", lib.display()),
            history: peek.to_string_lossy().into(),
            remote: true,
            ..local
        };
        let tip = run(&lib, &["rev-parse", "HEAD"]);
        add(&root, &remote, &tip).unwrap();
        std::fs::remove_dir_all(&peek).unwrap();
        assert_eq!(run(&root.join("other"), &["rev-parse", "HEAD"]), tip);
        run(&root.join("other"), &["fsck", "--no-progress"]);

        assert!(check_path("../out").is_err());
        assert!(check_path("a/.git/b").is_err());
        assert!(check_path("-x").is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
