//! Adding a submodule, in two windows:
//!
//! 1. *Add Submodule* (`submodule-…`): choose the repository, on this computer
//!    or remote, and where it goes. A remote repository is cloned (bare) into
//!    the app's cache so its history can be shown.
//! 2. *Choose Changeset* (`submodule-pick-…`): that repository's Branch
//!    Explorer. Double-clicking a changeset adds the submodule checked out
//!    there (`git submodule add`, then a detached checkout, then `git
//!    submodule init`), staged for the next commit.

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

/// One submodule is added (or removed) at a time: each edits .gitmodules
/// and the index, and a second running alongside would find the index locked.
static ADDING: Mutex<()> = Mutex::new(());

fn add(root: &Path, info: &PickChangesetInfo, at: &str) -> Result<(), String> {
    let _one_at_a_time = ADDING.lock().unwrap_or_else(|e| e.into_inner());
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
    // Register it in .git/config from .gitmodules (its URL, and that it's active), so
    // `git submodule update` and friends work on it straight away. Just this one:
    // the others are left as they are.
    git(root, &["submodule", "--quiet", "init", "--"], &[info.path.clone()], None)
        .map_err(|e| format!("Added the submodule, but `git submodule init` failed: {e}"))?;
    Ok(())
}

/// What updating the submodules after a switch did.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleUpdate {
    /// Submodules (including ones inside them) now checked out at a different changeset, or for the first time.
    pub updated: Vec<String>,
    /// Ones that couldn't be updated, with git's reason.
    pub failed: Vec<SubmoduleFailure>,
    /// Submodules the new changeset doesn't have, whose folders were put away: removed when git
    /// can restore everything in them from .git/modules, or moved to the Trash when they also
    /// held ignored files (build output and the like). Switching back brings them back.
    pub put_away: Vec<String>,
    /// Ones the new changeset doesn't have that were left on disk (they have uncommitted
    /// changes, say), with why. They show as new folders until dealt with.
    pub kept: Vec<SubmoduleFailure>,
}

#[derive(Debug, Serialize)]
pub struct SubmoduleFailure {
    pub path: String,
    pub error: String,
}

/// After switching changesets: checks out every submodule at the changeset
/// the new one records, setting up any that are new (and submodules inside
/// them), one submodule at a time so one failing doesn't stop the rest.
pub(crate) fn update_all(root: &Path) -> SubmoduleUpdate {
    let mut result = SubmoduleUpdate::default();
    let staged = git(root, &["ls-files", "--stage", "-z"], &[], None).unwrap_or_default();
    let paths: Vec<String> = staged
        .split('\0')
        .filter(|e| e.starts_with("160000 "))
        .filter_map(|e| e.split_once('\t').map(|(_, p)| p.to_string()))
        .collect();
    let _one_at_a_time = ADDING.lock().unwrap_or_else(|e| e.into_inner());
    // Submodules this changeset doesn't have: git leaves their folders behind, where they'd look like new files.
    put_away_leftovers(root, &paths, &mut result);
    if paths.is_empty() {
        return result;
    }
    let before = submodule_states(root);
    for path in paths {
        // No --remote: the changeset each is recorded at, not its branch's latest.
        if let Err(error) = git(root, &["submodule", "--quiet", "update", "--init", "--recursive", "--"], &[path.clone()], None) {
            result.failed.push(SubmoduleFailure { path, error });
        }
    }
    let after = submodule_states(root);
    // Checked out where it should be now ("' '"), and wasn't before.
    for (path, state) in after {
        if state.starts_with(' ') && before.get(&path) != Some(&state) {
            result.updated.push(path);
        }
    }
    result.updated.sort();
    result
}

/// The folders of submodules that aren't in the checked-out changeset (`current`
/// lists the ones that are), found from their repositories in .git/modules.
/// Each is removed if git can restore everything in it, moved to the Trash if
/// it also holds ignored files, and otherwise left alone and reported.
fn put_away_leftovers(root: &Path, current: &[String], result: &mut SubmoduleUpdate) {
    let Ok(modules) = root.join(".git").join("modules").canonicalize() else { return };
    let Ok(top) = root.canonicalize() else { return };
    let mut gitdirs = Vec::new();
    find_gitdirs(&modules, &mut gitdirs, 0);
    for gitdir in gitdirs {
        let config = gitdir.join("config");
        let Ok(worktree) = git(root, &["config", "--file", &config.to_string_lossy(), "--get", "core.worktree"], &[], None) else { continue };
        let Ok(folder) = gitdir.join(worktree.trim()).canonicalize() else { continue }; // not on disk: nothing left behind
        let Ok(rel) = folder.strip_prefix(&top) else { continue };
        let path = rel.to_string_lossy().replace('\\', "/");
        if path.is_empty() || current.contains(&path) || current.iter().any(|c| path.starts_with(&format!("{c}/"))) {
            continue; // still a submodule here (or inside one, which its own repository looks after)
        }
        // Only a folder that's this repository's checkout: its .git file points back at `gitdir`.
        let points_back = std::fs::read_to_string(folder.join(".git"))
            .ok()
            .and_then(|t| t.trim().strip_prefix("gitdir:").map(|p| folder.join(p.trim())))
            .and_then(|p| p.canonicalize().ok())
            .is_some_and(|p| p == gitdir);
        if !points_back {
            continue;
        }
        let status = match git(&folder, &["status", "--porcelain", "--ignored", "--untracked-files=all"], &[], None) {
            Ok(s) => s,
            Err(e) => {
                result.kept.push(SubmoduleFailure { path, error: format!("Couldn't tell whether it has uncommitted changes: {e}") });
                continue;
            }
        };
        let changed = status.lines().filter(|l| !l.starts_with("!!")).count();
        let ignored = status.lines().any(|l| l.starts_with("!!"));
        if changed > 0 {
            result.kept.push(SubmoduleFailure {
                path,
                error: format!("It has {changed} uncommitted change{}, so it was left where it is. Switch back to commit them, or move the folder away.", if changed == 1 { "" } else { "s" }),
            });
            continue;
        }
        // Everything in it is in .git/modules, which stays: switching back checks it out again.
        let gone = if ignored { trash::delete(&folder).map_err(|e| e.to_string()) } else { std::fs::remove_dir_all(&folder).map_err(|e| e.to_string()) };
        match gone {
            Ok(()) => {
                prune_empty(folder.parent(), &top);
                result.put_away.push(path);
            }
            Err(e) => result.kept.push(SubmoduleFailure { path, error: format!("Couldn't put its folder away: {e}") }),
        }
    }
    result.put_away.sort();
}

/// The repositories under .git/modules (submodules' own, not those inside them, which live in theirs).
fn find_gitdirs(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 16 {
        return;
    }
    if dir.join("HEAD").is_file() && dir.join("config").is_file() {
        out.push(dir.to_path_buf());
        return;
    }
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            find_gitdirs(&e.path(), out, depth + 1);
        }
    }
}

/// `git submodule status --recursive`, by path: the state character and changeset.
fn submodule_states(root: &Path) -> HashMap<String, String> {
    let out = git(root, &["submodule", "status", "--recursive"], &[], None).unwrap_or_default();
    out.lines()
        .filter_map(|line| {
            // "<state><id> <path>[ (<describe>)]"; the state is ' ', '-', '+' or 'U'.
            let state = line.get(..1)?;
            let (id, path) = line[1..].split_once(' ')?;
            let state_id = format!("{state}{id}");
            let path = match path.rfind(" (") {
                Some(i) if path.ends_with(')') => &path[..i],
                _ => path,
            };
            Some((path.to_string(), state_id))
        })
        .collect()
}

/// Removes the submodule at `path` from everything git keeps about it: the
/// index, `.gitmodules` (staged; removed if it's left empty), `.git/config`
/// and its repository under `.git/modules`. Nothing is lost: the folder
/// becomes a standalone repository, its history moved into it, and stays on
/// disk (as a repository inside this one) or, with `from_disk`, goes to the
/// Trash. The removal is a pending change, for the next commit.
#[tauri::command]
pub async fn remove_submodule(repo: String, path: String, from_disk: bool) -> Result<(), String> {
    let root = repo_root(&repo)?;
    let path = path.trim().trim_matches('/').to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let folder = remove(&root, &path)?;
        if from_disk && folder.symlink_metadata().is_ok() {
            trash::delete(&folder).map_err(|e| format!("Removed the submodule, but could not move {path} to the Trash: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The removal itself (see `remove_submodule`); returns the submodule's folder.
fn remove(root: &Path, path: &str) -> Result<PathBuf, String> {
    let _one_at_a_time = ADDING.lock().unwrap_or_else(|e| e.into_inner());
    check_path(path)?;
    let staged = git(root, &["ls-files", "--stage", "--"], &[path.to_string()], None)?;
    if !staged.lines().any(|l| l.starts_with("160000 ") && l.split('\t').nth(1) == Some(path)) {
        return Err(format!("{path} isn't a submodule"));
    }
    let name = submodule_name(root, path);
    let folder = root.join(path);
    let modules = root.join(".git").join("modules");

    // First, where its repository is (under .git/modules), while the submodule still works.
    let gitdir = if folder.join(".git").is_file() {
        let dir = PathBuf::from(git(&folder, &["rev-parse", "--absolute-git-dir"], &[], None)?.trim());
        let dir = dir.canonicalize().map_err(|e| format!("Could not find {path}'s repository: {e}"))?;
        let m = modules.canonicalize().map_err(|_| format!("{path}'s repository isn't under .git/modules"))?;
        if !dir.starts_with(&m) || dir == m {
            return Err(format!("{path}'s repository isn't under .git/modules, so VisualGit won't move it"));
        }
        Some((dir, m))
    } else {
        None
    };

    // Then git's records. `--force` with `--cached` only affects the index, never the files.
    git(root, &["rm", "--quiet", "--cached", "--force", "--"], &[path.to_string()], None).map_err(|e| format!("Could not remove {path} from the index: {e}"))?;
    if let Some(n) = &name {
        let section = format!("submodule.{n}");
        let gitmodules = root.join(".gitmodules");
        let file = gitmodules.to_string_lossy().into_owned();
        git(root, &["config", "--file", &file, "--remove-section", &section], &[], None).map_err(|e| format!("Could not update .gitmodules: {e}"))?;
        // Left with no submodules, .gitmodules goes too.
        let left = std::fs::read_to_string(&gitmodules).unwrap_or_default();
        if left.lines().all(|l| l.trim().is_empty() || l.trim_start().starts_with(['#', ';'])) {
            git(root, &["rm", "--quiet", "--cached", "--force", "--ignore-unmatch", "--"], &[".gitmodules".into()], None)?;
            let _ = std::fs::remove_file(&gitmodules);
        } else {
            git(root, &["add", "--"], &[".gitmodules".into()], None)?;
        }
        // Registered by `git submodule init`; absent if it never was.
        let _ = git(root, &["config", "--local", "--remove-section", &section], &[], None);
    }

    // Last, its repository: moved into the folder, so the folder works on its own and nothing is lost.
    if let Some((dir, m)) = gitdir {
        make_standalone(&folder, &dir)?;
        prune_empty(dir.parent(), &m);
    } else if !folder.join(".git").exists() {
        // Not checked out: nothing of the user's to keep, just git's copy, if any.
        if let Some(n) = &name {
            let dir = modules.join(n);
            if let (Ok(real), Ok(m)) = (dir.canonicalize(), modules.canonicalize()) {
                if real.starts_with(&m) && real != m {
                    std::fs::remove_dir_all(&real).map_err(|e| format!("Could not remove {}: {e}", real.display()))?;
                    prune_empty(real.parent(), &m);
                }
            }
        }
        if folder.read_dir().is_ok_and(|mut d| d.next().is_none()) {
            let _ = std::fs::remove_dir(&folder);
        }
    }
    Ok(folder)
}

/// The submodule's name in .gitmodules (usually its path, but not always).
pub(crate) fn submodule_name(root: &Path, path: &str) -> Option<String> {
    let file = root.join(".gitmodules");
    let out = git(root, &["config", "--file", &file.to_string_lossy(), "--null", "--get-regexp", r"^submodule\..*\.path$"], &[], None).ok()?;
    out.split('\0').find_map(|entry| {
        let (key, value) = entry.split_once('\n')?;
        (value == path).then(|| key.strip_prefix("submodule.")?.strip_suffix(".path").map(str::to_string))?
    })
}

/// Moves `gitdir` (the submodule's repository under .git/modules) into
/// `folder` as its `.git`, so it's an ordinary repository; submodules inside
/// it are pointed at their moved repositories, with relative paths, so they
/// keep working wherever the folder goes (such as the Trash).
fn make_standalone(folder: &Path, gitdir: &Path) -> Result<(), String> {
    // Submodules inside, whose repositories are inside this one's: found before anything moves.
    let mut inner = Vec::new();
    find_gitfiles(folder, gitdir, &mut inner, 0);
    let target = folder.join(".git");
    std::fs::remove_file(&target).map_err(|e| e.to_string())?;
    std::fs::rename(gitdir, &target).map_err(|e| format!("Could not move {} into {}: {e}", gitdir.display(), folder.display()))?;
    // Run from outside the folder: inside it, git would first try to use the old setting.
    let outside = folder.parent().unwrap_or(folder);
    let config = target.join("config");
    let has_worktree = git(outside, &["config", "--file", &config.to_string_lossy(), "--get", "core.worktree"], &[], None).is_ok();
    if has_worktree {
        git(outside, &["config", "--file", &config.to_string_lossy(), "--unset", "core.worktree"], &[], None)
            .map_err(|e| format!("Moved {}'s repository into it, but could not update its settings: {e}", folder.display()))?;
    }
    for (worktree, old) in inner {
        let Ok(rest) = old.strip_prefix(gitdir) else { continue };
        let moved = target.join(rest);
        std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", relative(&worktree, &moved).display())).map_err(|e| e.to_string())?;
        let config = moved.join("config");
        git(outside, &["config", "--file", &config.to_string_lossy(), "core.worktree", &relative(&moved, &worktree).to_string_lossy()], &[], None)
            .map_err(|e| format!("Could not update the submodule in {}: {e}", worktree.display()))?;
    }
    Ok(())
}

/// Working folders below `dir` whose `.git` file points into `gitdir`.
fn find_gitfiles(dir: &Path, gitdir: &Path, out: &mut Vec<(PathBuf, PathBuf)>, depth: usize) {
    if depth > 32 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let Ok(kind) = e.file_type() else { continue };
        if !kind.is_dir() || e.file_name() == ".git" {
            continue;
        }
        let sub = e.path();
        let gitfile = sub.join(".git");
        if let Ok(text) = std::fs::read_to_string(&gitfile) {
            if let Some(p) = text.trim().strip_prefix("gitdir:") {
                if let Ok(real) = sub.join(p.trim()).canonicalize() {
                    if real.starts_with(gitdir) {
                        out.push((sub.clone(), real));
                    }
                }
            }
        }
        find_gitfiles(&sub, gitdir, out, depth + 1);
    }
}

/// `to` as a path relative to the folder `from`.
fn relative(from: &Path, to: &Path) -> PathBuf {
    let (a, b): (Vec<_>, Vec<_>) = (from.components().collect(), to.components().collect());
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let mut out = PathBuf::new();
    for _ in common..a.len() {
        out.push("..");
    }
    for c in &b[common..] {
        out.push(c);
    }
    out
}

/// Removes empty folders from `dir` up to (not including) `stop`.
fn prune_empty(mut dir: Option<&Path>, stop: &Path) {
    while let Some(d) = dir {
        if d == stop || !d.starts_with(stop) || std::fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
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
        // Initialised: registered in .git/config, and `git submodule status` has it at the chosen changeset.
        assert_eq!(run(&root, &["config", "--local", "--get", "submodule.libs/lib.active"]), "true");
        assert!(!run(&root, &["config", "--local", "--get", "submodule.libs/lib.url"]).is_empty());
        let status = run(&root, &["submodule", "status", "--", "libs/lib"]);
        // (`run` trims the leading space; "-" would be uninitialised, "+" a different changeset.)
        assert!(status.starts_with(&first), "{status}");
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

        // Added one after the other, each is initialised on its own and keeps its own changeset.
        let status = run(&root, &["submodule", "status"]);
        let lines: Vec<&str> = status.lines().map(str::trim).collect();
        assert_eq!(lines.len(), 2, "{status}");
        assert!(lines.iter().any(|l| l.starts_with(&first) && l.contains("libs/lib")), "{status}");
        assert!(lines.iter().any(|l| l.starts_with(&tip) && l.contains("other")), "{status}");
        assert_eq!(run(&root, &["config", "--local", "--get", "submodule.other.active"]), "true");

        // Removing one cleans up after it everywhere, and leaves its folder as a working repository.
        std::fs::write(root.join("libs/lib/work.txt"), "not committed").unwrap();
        let folder = remove(&root, "libs/lib").unwrap();
        assert!(!run(&root, &["ls-files", "--stage"]).contains("libs/lib"));
        let gitmodules = std::fs::read_to_string(root.join(".gitmodules")).unwrap();
        assert!(!gitmodules.contains("libs/lib") && gitmodules.contains("\"other\""), "{gitmodules}");
        assert!(!run(&root, &["config", "--local", "--list"]).contains("submodule.libs/lib"));
        assert!(!root.join(".git/modules/libs").exists());
        assert!(folder.join(".git").is_dir());
        assert_eq!(run(&folder, &["rev-parse", "HEAD"]), first);
        assert!(run(&folder, &["status", "--porcelain"]).contains("work.txt"));
        assert_eq!(run(&folder, &["rev-parse", "--show-toplevel"]), folder.to_string_lossy());
        assert!(remove(&root, "libs/lib").unwrap_err().contains("isn't a submodule"));
        // The last one: .gitmodules goes too, and the removals are staged.
        remove(&root, "other").unwrap();
        assert!(!root.join(".gitmodules").exists());
        let staged = run(&root, &["diff", "--cached", "--name-status"]);
        assert!(!staged.contains("libs/lib") && !staged.contains("other") && !staged.contains(".gitmodules"), "{staged}");
        assert_eq!(run(&root, &["submodule", "status"]), "");
        assert_eq!(relative(Path::new("/a/b/c"), Path::new("/a/x/y")), PathBuf::from("../../x/y"));

        assert!(check_path("../out").is_err());
        assert!(check_path("a/.git/b").is_err());
        assert!(check_path("-x").is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn switching_changesets_brings_submodules_along() {
        let tmp = std::env::temp_dir().join(format!("visualgit-submodule-switch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let (lib, other, app) = (tmp.join("lib"), tmp.join("other"), tmp.join("app"));
        repo(&lib, &["one", "two"]);
        repo(&other, &["o"]);
        let (one, two) = (run(&lib, &["rev-parse", "HEAD~1"]), run(&lib, &["rev-parse", "HEAD"]));
        repo(&app, &["a"]);
        let file = |p: &Path| p.to_string_lossy().into_owned();
        run(&app, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", &file(&lib), "lib"]);
        run(&app.join("lib"), &["checkout", "-q", "--detach", &one]);
        run(&app, &["add", "lib"]);
        run(&app, &["commit", "-qm", "lib at one"]);
        let at_one = run(&app, &["rev-parse", "HEAD"]);
        // Later: lib moves on, and another submodule arrives.
        run(&app.join("lib"), &["checkout", "-q", "--detach", &two]);
        run(&app, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", &file(&other), "other"]);
        run(&app, &["add", "lib"]);
        run(&app, &["commit", "-qm", "lib at two, plus other"]);
        let at_two = run(&app, &["rev-parse", "HEAD"]);
        let root = repo_root(app.to_str().unwrap()).unwrap();

        // Back to the first: lib follows, and `other`, which it doesn't have, is put away.
        run(&root, &["switch", "-q", "--detach", &at_one]);
        assert_eq!(run(&root.join("lib"), &["rev-parse", "HEAD"]), two, "git switch alone leaves it behind");
        assert!(root.join("other").exists(), "git switch alone leaves its folder behind");
        let update = update_all(&root);
        assert!(update.failed.is_empty() && update.kept.is_empty(), "{update:?}");
        assert_eq!(update.updated, vec!["lib".to_string()]);
        assert_eq!(update.put_away, vec!["other".to_string()]);
        assert_eq!(run(&root.join("lib"), &["rev-parse", "HEAD"]), one);
        assert!(!root.join("other").exists());
        assert_eq!(run(&root, &["status", "--porcelain"]), "", "nothing left over to look like a pending change");

        // Forward again: lib moves, and `other` comes back from .git/modules, without fetching anything.
        run(&root, &["switch", "-q", "--detach", &at_two]);
        let update = update_all(&root);
        assert!(update.failed.is_empty(), "{update:?}");
        assert_eq!(update.updated, vec!["lib".to_string(), "other".to_string()]);
        assert_eq!(run(&root.join("lib"), &["rev-parse", "HEAD"]), two);
        assert!(root.join("other/o").exists());
        // Nothing to do: nothing updated.
        let update = update_all(&root);
        assert!(update.updated.is_empty() && update.put_away.is_empty(), "{update:?}");

        // With work of its own in it, a submodule the changeset doesn't have stays, and says why.
        std::fs::write(root.join("other/draft.txt"), "not committed").unwrap();
        run(&root, &["switch", "-q", "--detach", &at_one]);
        let update = update_all(&root);
        assert!(update.put_away.is_empty(), "{update:?}");
        assert_eq!(update.kept.iter().map(|k| k.path.as_str()).collect::<Vec<_>>(), vec!["other"]);
        assert!(root.join("other/draft.txt").exists());
        // It looks like a new folder now, but it isn't committed as one.
        let refused = crate::pending::commit(root.to_str().unwrap(), "oops", &["other".into()]).unwrap_err();
        assert!(refused.contains("separate repository"), "{refused}");
        assert_eq!(run(&root, &["rev-parse", "HEAD"]), at_one);
        assert!(!run(&root, &["diff", "--cached", "--name-only"]).contains("other"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn removing_a_submodule_keeps_submodules_inside_it_working_wherever_it_goes() {
        let tmp = std::env::temp_dir().join(format!("visualgit-submodule-nested-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let (inner, lib, app) = (tmp.join("inner"), tmp.join("lib"), tmp.join("app"));
        repo(&inner, &["i"]);
        repo(&lib, &["l"]);
        run(&lib, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", inner.to_str().unwrap(), "inner"]);
        run(&lib, &["commit", "-qm", "inner"]);
        repo(&app, &["a"]);
        run(&app, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib.to_str().unwrap(), "libs/lib"]);
        run(&app, &["-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init", "--recursive"]);
        run(&app, &["commit", "-qm", "lib"]);
        let root = repo_root(app.to_str().unwrap()).unwrap();
        let inner_head = run(&root.join("libs/lib/inner"), &["rev-parse", "HEAD"]);

        let folder = remove(&root, "libs/lib").unwrap();
        assert!(!root.join(".git/modules").join("libs").exists());
        // Moved somewhere else (as into the Trash), it and the submodule inside it still work.
        let moved = tmp.join("moved");
        std::fs::rename(&folder, &moved).unwrap();
        assert_eq!(run(&moved, &["status", "--porcelain"]), "");
        assert_eq!(run(&moved.join("inner"), &["rev-parse", "HEAD"]), inner_head);
        assert_eq!(run(&moved.join("inner"), &["status", "--porcelain"]), "");
        assert!(run(&moved, &["submodule", "status"]).starts_with(&inner_head));
        let _ = std::fs::remove_dir_all(&tmp);

    }
}
