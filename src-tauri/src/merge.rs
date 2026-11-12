//! The merge window: a preview of merging a changeset into what's checked out,
//! and the merge itself (never a fast-forward). Also cherry picking, subtractive merges (taking a changeset's changes back
//! out), and the state of any of these left in progress by conflicts.
//!
//! The preview touches nothing: not the working tree, the index or any branch.
//! `git merge-tree --write-tree` computes the merged result in the object
//! database (as unreachable objects that `git gc` cleans up eventually), and
//! the window reads file versions from it.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::process::Stdio;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, Window};

use crate::branch::commit_id;
use crate::os::{command, slash_path};
use crate::pending::{git, repo_root};
use crate::submodule::{update_all, SubmoduleUpdate};

#[derive(Clone, Serialize)]
pub struct MergeWindowInfo {
    repo: String,
    from: String,
}

/// What each merge window is previewing, by window label.
#[derive(Default)]
pub struct MergeWindows(Mutex<HashMap<String, MergeWindowInfo>>);

/// Opens the merge window for merging changeset `from` into HEAD (or focuses it).
#[tauri::command]
pub async fn open_merge_window(app: AppHandle, windows: State<'_, MergeWindows>, repo: String, from: String) -> Result<(), String> {
    let root = repo_root(&repo)?;
    let from = commit_id(&root, &from)?;
    let mut hasher = DefaultHasher::new();
    (&root, &from).hash(&mut hasher);
    let label = format!("merge-{:016x}", hasher.finish());

    if let Some(existing) = app.get_webview_window(&label) {
        existing.unminimize().ok();
        existing.show().map_err(|e| e.to_string())?;
        return existing.set_focus().map_err(|e| e.to_string());
    }
    let info = MergeWindowInfo { repo: slash_path(&root), from: from.clone() };
    windows.0.lock().unwrap().insert(label.clone(), info);
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("merge.html".into()))
        .title(format!("Merge from {}", &from[..8]))
        .inner_size(1280.0, 820.0)
        .min_inner_size(760.0, 480.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The repository and changeset the calling merge window previews.
#[tauri::command]
pub fn merge_window_info(window: Window, windows: State<'_, MergeWindows>) -> Option<MergeWindowInfo> {
    windows.0.lock().unwrap().get(window.label()).cloned()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeFile {
    path: String,
    /// The path in the destination, for a file the merge renames.
    orig_path: Option<String>,
    /// How the merge result differs from the destination: A, M, D, R or T.
    status: String,
    /// Git could not merge this file on its own; its result has conflict markers.
    conflict: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    /// The destination: the checked-out changeset.
    to: String,
    /// The checked-out branch, if HEAD isn't detached.
    to_branch: Option<String>,
    /// The source changeset.
    from: String,
    /// Their merge base, if they share history.
    base: Option<String>,
    /// "up-to-date" (already merged), "fast-forward" or "merge".
    kind: String,
    /// The merged tree, for reading result versions as `<tree>:<path>`.
    tree: Option<String>,
    files: Vec<MergeFile>,
    /// git's own notes, e.g. "CONFLICT (content): Merge conflict in x".
    messages: Vec<String>,
}

#[tauri::command]
pub async fn merge_preview(repo: String, from: String) -> Result<MergePreview, String> {
    tauri::async_runtime::spawn_blocking(move || preview(&repo, &from))
        .await
        .map_err(|e| e.to_string())?
}

fn preview(repo: &str, from: &str) -> Result<MergePreview, String> {
    let root = repo_root(repo)?;
    let from = commit_id(&root, from)?;
    let to = git(&root, &["rev-parse", "--verify", "-q", "HEAD"], &[], None)
        .map_err(|_| "Nothing is checked out yet, so there's nothing to merge into.".to_string())?
        .trim()
        .to_string();
    let to_branch = git(&root, &["symbolic-ref", "-q", "--short", "HEAD"], &[], None).ok().map(|s| s.trim().to_string());
    let base = git(&root, &["merge-base", &to, &from], &[], None).ok().map(|s| s.trim().to_string());
    let is_ancestor = |a: &str, b: &str| git(&root, &["merge-base", "--is-ancestor", a, b], &[], None).is_ok();

    let mut result = MergePreview { to: to.clone(), to_branch, from: from.clone(), base, kind: "merge".into(), tree: None, files: vec![], messages: vec![] };
    if from == to || is_ancestor(&from, &to) {
        result.kind = "up-to-date".into();
        return Ok(result);
    }
    if is_ancestor(&to, &from) {
        result.kind = "fast-forward".into();
    }

    let (tree, conflicted, messages) = merge_tree(&root, &to, &from)?;
    result.files = changed_files(&root, &to, &tree, &conflicted)?;
    result.tree = Some(tree);
    result.messages = messages;
    Ok(result)
}

/// Runs `git merge-tree --write-tree`: the merged tree, the conflicted paths, and git's messages.
fn merge_tree(root: &Path, to: &str, from: &str) -> Result<(String, HashSet<String>, Vec<String>), String> {
    let out = command("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "core.quotepath=off", "merge-tree", "--write-tree", "--name-only", "--messages", "--allow-unrelated-histories", to, from])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    // Exit status 1 means "merged, with conflicts"; anything else above 0 is a real failure.
    if !matches!(out.status.code(), Some(0 | 1)) {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let tree = lines.next().ok_or("git merge-tree printed nothing")?.trim().to_string();
    let conflicted: HashSet<String> = lines.by_ref().take_while(|l| !l.is_empty()).map(str::to_string).collect();
    let messages = lines.filter(|l| !l.trim().is_empty()).map(str::to_string).collect();
    Ok((tree, conflicted, messages))
}

/// Files whose merge result differs from the destination.
fn changed_files(root: &Path, to: &str, tree: &str, conflicted: &HashSet<String>) -> Result<Vec<MergeFile>, String> {
    let out = git(root, &["diff-tree", "-r", "-z", "--no-commit-id", "--name-status", "-M", to, tree], &[], None)?;
    let mut tokens = out.split('\0').filter(|t| !t.is_empty());
    let mut files = Vec::new();
    while let Some(status) = tokens.next() {
        let letter = status.chars().next().unwrap_or('M').to_string();
        let (orig_path, path) = if matches!(letter.as_str(), "R" | "C") {
            let old = tokens.next().unwrap_or_default().to_string();
            (Some(old), tokens.next().unwrap_or_default().to_string())
        } else {
            (None, tokens.next().unwrap_or_default().to_string())
        };
        let conflict = conflicted.contains(&path) || orig_path.as_ref().is_some_and(|p| conflicted.contains(p));
        files.push(MergeFile { path, orig_path, status: letter, conflict });
    }
    // Conflicts with no textual difference (rare) still need to be listed.
    for path in conflicted {
        if !files.iter().any(|f| &f.path == path) {
            files.push(MergeFile { path: path.clone(), orig_path: None, status: "M".into(), conflict: true });
        }
    }
    files.sort_by(|a, b| b.conflict.cmp(&a.conflict).then_with(|| a.path.cmp(&b.path)));
    Ok(files)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CherryPick {
    /// The new changeset, when it applied cleanly.
    committed: Option<String>,
    /// Files left with conflict markers, when it didn't. The cherry pick is then in progress.
    conflicts: Vec<String>,
    /// When it applied cleanly: the submodules brought to the changesets the new one records.
    /// (After conflicts, that happens when the result is committed.)
    submodules: SubmoduleUpdate,
}

impl CherryPick {
    /// Done, as changeset HEAD: its submodules follow.
    fn committed(root: &Path) -> Result<Self, String> {
        let committed = git(root, &["rev-parse", "HEAD"], &[], None)?.trim().to_string();
        Ok(CherryPick { committed: Some(committed), conflicts: vec![], submodules: update_all(root) })
    }

    /// Stopped for conflicts, still in progress.
    fn stopped(conflicts: Vec<String>) -> Self {
        CherryPick { committed: None, conflicts, submodules: SubmoduleUpdate::default() }
    }
}

/// Applies changeset `at` on top of HEAD as a new changeset (`git cherry-pick`).
#[tauri::command]
pub async fn cherry_pick(repo: String, at: String) -> Result<CherryPick, String> {
    tauri::async_runtime::spawn_blocking(move || apply(&repo, &at, Apply::Pick)).await.map_err(|e| e.to_string())?
}

/// Takes changeset `at`'s changes back out of HEAD as a new changeset
/// (`git revert`): Plastic's subtractive merge.
#[tauri::command]
pub async fn subtractive_merge(repo: String, at: String) -> Result<CherryPick, String> {
    tauri::async_runtime::spawn_blocking(move || apply(&repo, &at, Apply::Subtract)).await.map_err(|e| e.to_string())?
}

#[derive(Clone, Copy, PartialEq)]
enum Apply {
    /// Add a changeset's changes (cherry pick).
    Pick,
    /// Remove them (subtractive merge).
    Subtract,
}

#[cfg(test)]
fn pick(repo: &str, at: &str) -> Result<CherryPick, String> {
    apply(repo, at, Apply::Pick)
}

fn apply(repo: &str, at: &str, how: Apply) -> Result<CherryPick, String> {
    let root = repo_root(repo)?;
    let at = commit_id(&root, at)?;
    let short = &at[..8];
    let head = git(&root, &["rev-parse", "--verify", "-q", "HEAD"], &[], None)
        .map_err(|_| "Nothing is checked out yet.".to_string())?;
    let included = git(&root, &["merge-base", "--is-ancestor", &at, head.trim()], &[], None).is_ok();
    match how {
        Apply::Pick if included => return Err(format!("{short} is already part of the checked-out changeset")),
        Apply::Subtract if !included => {
            return Err(format!("{short} isn't part of the checked-out changeset, so there's nothing to take out"))
        }
        _ => {}
    }
    if let Some(op) = in_progress(&root) {
        return Err(format!("A {op} is already in progress. Finish or abort it first."));
    }
    let parents = git(&root, &["rev-list", "--parents", "-n", "1", &at], &[], None)?;
    let is_merge = parents.split_whitespace().count() > 2;
    let command = if how == Apply::Pick { "cherry-pick" } else { "revert" };
    let mut args = vec![command];
    if how == Apply::Subtract {
        args.push("--no-edit"); // git's own "Revert …" message
    }
    // A merge changeset counts as the change it made to its first parent.
    if is_merge {
        args.extend(["-m", "1"]);
    }
    args.push(&at);
    match git(&root, &args, &[], None) {
        Ok(_) => CherryPick::committed(&root),
        Err(err) => {
            let conflicts = conflicted_paths(&root);
            if !conflicts.is_empty() {
                return Ok(CherryPick::stopped(conflicts));
            }
            // Nothing to apply (or remove), or another failure: leave no half-done state.
            if in_progress(&root).is_some() {
                let _ = git(&root, &[command, "--abort"], &[], None);
            }
            if err.contains("empty") || err.contains("nothing to commit") {
                Err(match how {
                    Apply::Pick => format!("The changes in {short} are already in the checked-out changeset"),
                    Apply::Subtract => format!("The changes in {short} have already been taken out"),
                })
            } else {
                Err(err)
            }
        }
    }
}

/// Merges changeset `from` into HEAD, always as a merge changeset of its own
/// (`git merge --no-ff`), even when git could fast-forward. A fast-forward
/// leaves no trace of the merge, so the branch explorer would credit the merged
/// branch's changesets to the destination and draw the source as empty.
///
/// `branch` names the local branch being merged when `from` is its tip, for
/// git's usual "Merge branch 'x' into y" message. On conflicts the merge is
/// left in progress, to finish (or abort) in Pending Changes.
#[tauri::command]
pub async fn merge(repo: String, from: String, branch: Option<String>) -> Result<CherryPick, String> {
    tauri::async_runtime::spawn_blocking(move || merge_into_head(&repo, &from, branch.as_deref())).await.map_err(|e| e.to_string())?
}

fn merge_into_head(repo: &str, from: &str, branch: Option<&str>) -> Result<CherryPick, String> {
    let root = repo_root(repo)?;
    let from = commit_id(&root, from)?;
    let short = &from[..8];
    let head = git(&root, &["rev-parse", "--verify", "-q", "HEAD"], &[], None)
        .map_err(|_| "Nothing is checked out yet, so there's nothing to merge into.".to_string())?
        .trim()
        .to_string();
    if git(&root, &["merge-base", "--is-ancestor", &from, &head], &[], None).is_ok() {
        return Err(format!("{short} is already merged into the checked-out changeset"));
    }
    if let Some(op) = in_progress(&root) {
        return Err(format!("A {op} is already in progress. Finish or abort it first."));
    }
    if !git(&root, &["status", "--porcelain", "--untracked-files=no"], &[], None)?.trim().is_empty() {
        return Err("There are pending changes. Commit or undo them before merging.".into());
    }
    // Only name the branch if it really is the changeset being merged.
    let branch = branch.filter(|b| {
        git(&root, &["rev-parse", "--verify", "-q", &format!("refs/heads/{b}^{{commit}}")], &[], None).is_ok_and(|h| h.trim() == from)
    });
    let into = git(&root, &["symbolic-ref", "-q", "--short", "HEAD"], &[], None).map(|s| s.trim().to_string()).unwrap_or_else(|_| head[..8].to_string());
    let message = match branch {
        Some(b) => format!("Merge branch '{b}' into {into}"),
        None => format!("Merge changeset {short} into {into}"),
    };
    let args = ["merge", "--no-ff", "--no-edit", "--allow-unrelated-histories", "-m", &message, &from];
    match git(&root, &args, &[], None) {
        Ok(_) => CherryPick::committed(&root),
        Err(err) => {
            let conflicts = conflicted_paths(&root);
            if !conflicts.is_empty() {
                return Ok(CherryPick::stopped(conflicts));
            }
            if in_progress(&root) == Some("merge") {
                let _ = git(&root, &["merge", "--abort"], &[], None);
            }
            Err(err)
        }
    }
}

fn conflicted_paths(root: &Path) -> Vec<String> {
    git(root, &["diff", "--name-only", "--diff-filter=U", "-z"], &[], None)
        .unwrap_or_default()
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect()
}

/// The operations that can stop for conflicts: (name, git's marker ref, how to abort).
const OPERATIONS: [(&str, &str, &str); 3] = [
    ("cherry pick", "CHERRY_PICK_HEAD", "cherry-pick"),
    ("subtractive merge", "REVERT_HEAD", "revert"),
    ("merge", "MERGE_HEAD", "merge"),
];

/// "merge", "cherry pick" or "subtractive merge" while one is in progress.
fn in_progress(root: &Path) -> Option<&'static str> {
    OPERATIONS
        .iter()
        .find(|(_, marker, _)| git(root, &["rev-parse", "-q", "--verify", marker], &[], None).is_ok())
        .map(|(name, _, _)| *name)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    /// "merge", "cherry pick" or "subtractive merge".
    kind: String,
    /// The changeset being merged, cherry picked or taken out.
    from: Option<String>,
    /// The commit message git prepared for it.
    message: Option<String>,
    /// Set when this merge brings a branch's local changesets into what its remote branch has
    /// (see `sync_branch`): aborting it puts the branch back where it was.
    sync: Option<SyncInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncInfo {
    /// The branch being brought level, e.g. "main".
    branch: String,
    /// Its remote branch, e.g. "origin/main".
    remote: String,
}

/// A merge, cherry pick or subtractive merge waiting for its conflicts to be resolved, if any.
#[tauri::command]
pub fn operation_in_progress(repo: String) -> Result<Option<Operation>, String> {
    let root = repo_root(&repo)?;
    let Some(kind) = in_progress(&root) else { return Ok(None) };
    let head_ref = OPERATIONS.iter().find(|(name, _, _)| *name == kind).map(|(_, marker, _)| *marker).unwrap_or("MERGE_HEAD");
    let from = git(&root, &["rev-parse", "-q", "--verify", head_ref], &[], None).ok().map(|s| s.trim().to_string());
    let message = git(&root, &["rev-parse", "--git-path", "MERGE_MSG"], &[], None)
        .ok()
        .map(|p| root.join(p.trim()))
        .and_then(|p| std::fs::read_to_string(p).ok())
        // Drop git's comment lines (the conflict list).
        .map(|m| m.lines().filter(|l| !l.starts_with('#')).collect::<Vec<_>>().join("\n").trim().to_string())
        .filter(|m| !m.is_empty());
    let sync = if kind == "merge" { sync_in_progress(&root) } else { None };
    let sync = sync.map(|(branch, _)| SyncInfo { remote: upstream(&root, &branch).map(|(_, short)| short).unwrap_or_else(|| "its remote branch".into()), branch });
    Ok(Some(Operation { kind: kind.into(), from, message, sync }))
}

/// Abandons the operation in progress, putting everything back as it was.
#[tauri::command]
pub fn abort_operation(repo: String) -> Result<(), String> {
    let root = repo_root(&repo)?;
    let Some(kind) = in_progress(&root) else { return Ok(()) };
    let command = OPERATIONS.iter().find(|(name, _, _)| *name == kind).map(|(_, _, c)| *c).unwrap_or("merge");
    let sync = if kind == "merge" { sync_in_progress(&root) } else { None };
    git(&root, &[command, "--abort"], &[], None)?;
    // Aborting a sync also puts the branch back on its own changesets.
    if let Some((branch, local)) = sync {
        git(&root, &["reset", "--quiet", "--keep", &local], &[], None)
            .map_err(|e| format!("The merge was aborted, but {branch} couldn't be put back on its own changesets ({}): {e}", &local[..8]))?;
        git(&root, &["update-ref", "-d", &sync_ref(&branch)], &[], None)?;
        update_all(&root);
    }
    Ok(())
}

// ---- bringing a branch level with its remote branch ------------------------------------

/// Where `sync_branch` keeps a branch's own changesets while they're merged
/// into what its remote branch has. It's not a branch, so it's never pushed,
/// switched to or listed by git; the branch explorer shows it as "main (local)".
pub(crate) const SYNC_REFS: &str = "refs/visualgit/sync/";

pub(crate) fn sync_ref(branch: &str) -> String {
    format!("{SYNC_REFS}{branch}")
}

/// The commit message of a sync merge; the branch explorer names the merged-in side after it.
fn sync_message(branch: &str) -> String {
    format!("Merge local changes into {branch}")
}

/// `branch`'s upstream as (its remote-tracking ref, its short name):
/// ("refs/remotes/origin/main", "origin/main"). None without one.
pub(crate) fn upstream(root: &Path, branch: &str) -> Option<(String, String)> {
    let config = |key: String| git(root, &["config", "--get", &key], &[], None).ok().map(|s| s.trim().to_string());
    let remote = config(format!("branch.{branch}.remote")).filter(|r| r != ".")?;
    let merge = config(format!("branch.{branch}.merge"))?;
    let name = merge.strip_prefix("refs/heads/")?;
    Some((format!("refs/remotes/{remote}/{name}"), format!("{remote}/{name}")))
}

/// A branch and its remote branch that have each moved on: pushing would be refused.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Diverged {
    pub branch: String,
    /// "origin/main".
    pub remote: String,
    /// Changesets the branch has that the remote branch doesn't.
    pub ahead: usize,
    /// Changesets the remote branch has that the branch doesn't.
    pub behind: usize,
    /// Whether it's the checked-out branch (the merge happens in the working copy).
    pub checked_out: bool,
}

/// How `branch` stands against its remote branch, as last fetched: Ok(None) when pushing it
/// would work (level, ahead, or no remote branch yet), Ok(Some) when both have moved on, and
/// Err when there's nothing to push because only the remote branch has.
pub(crate) fn diverged(root: &Path, branch: &str) -> Result<Option<Diverged>, String> {
    let Some((tracking, remote)) = upstream(root, branch) else { return Ok(None) };
    let rev = |r: &str| git(root, &["rev-parse", "--verify", "-q", &format!("{r}^{{commit}}")], &[], None).ok().map(|s| s.trim().to_string());
    let (Some(local), Some(theirs)) = (rev(&format!("refs/heads/{branch}")), rev(&tracking)) else { return Ok(None) };
    let count = |range: String| -> Result<usize, String> { git(root, &["rev-list", "--count", &range], &[], None)?.trim().parse().map_err(|e| format!("{e}")) };
    let behind = count(format!("{local}..{theirs}"))?;
    if behind == 0 {
        return Ok(None);
    }
    let ahead = count(format!("{theirs}..{local}"))?;
    if ahead == 0 {
        return Err(format!("Nothing to push: {remote} has {behind} changeset{} that {branch} doesn't, and {branch} has nothing new", if behind == 1 { "" } else { "s" }));
    }
    let checked_out = git(root, &["symbolic-ref", "-q", "--short", "HEAD"], &[], None).is_ok_and(|h| h.trim() == branch);
    Ok(Some(Diverged { branch: branch.into(), remote, ahead, behind, checked_out }))
}

/// The checked-out branch's remote branch has changesets the branch doesn't (as last
/// fetched) while there are pending changes: committing them adds to a branch that will
/// need merging with the remote before it can be pushed.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMoved {
    pub branch: String,
    /// "origin/main".
    pub remote: String,
    /// Changesets the remote branch has that the branch doesn't.
    pub behind: usize,
    /// Pending files the remote's changesets also change: likely conflicts when merging.
    pub overlap: Vec<String>,
}

/// Whether the remote moved on under the pending changes; see `RemoteMoved`. None when
/// there are no pending changes, no remote branch, or nothing new on it.
#[tauri::command]
pub async fn remote_moved(repo: String) -> Result<Option<RemoteMoved>, String> {
    tauri::async_runtime::spawn_blocking(move || remote_moved_at(&repo_root(&repo)?)).await.map_err(|e| e.to_string())?
}

pub(crate) fn remote_moved_at(root: &Path) -> Result<Option<RemoteMoved>, String> {
    let Ok(branch) = git(root, &["symbolic-ref", "-q", "--short", "HEAD"], &[], None) else { return Ok(None) };
    let branch = branch.trim().to_string();
    let Some((tracking, remote)) = upstream(root, &branch) else { return Ok(None) };
    if git(root, &["rev-parse", "--verify", "-q", &format!("{tracking}^{{commit}}")], &[], None).is_err() {
        return Ok(None);
    }
    let behind: usize = git(root, &["rev-list", "--count", &format!("HEAD..{tracking}")], &[], None)?.trim().parse().map_err(|e| format!("{e}"))?;
    if behind == 0 {
        return Ok(None);
    }
    // Pending paths, a rename's old path too ("R  new\0old\0" in -z output).
    let status = git(root, &["status", "--porcelain=v1", "-z", "--untracked-files=all"], &[], None)?;
    let mut pending = HashSet::new();
    let mut entries = status.split('\0').filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        let (xy, path) = (entry.get(..2).unwrap_or(""), entry.get(3..).unwrap_or(""));
        pending.insert(path.to_string());
        if xy.contains('R') || xy.contains('C') {
            if let Some(orig) = entries.next() {
                pending.insert(orig.to_string());
            }
        }
    }
    if pending.is_empty() {
        return Ok(None);
    }
    // What the remote's changesets change, since where the branch and the remote branch part.
    let theirs = git(root, &["diff", "--name-only", "-z", &format!("HEAD...{tracking}")], &[], None)?;
    let mut overlap: Vec<String> = theirs.split('\0').filter(|p| pending.contains(*p)).map(String::from).collect();
    overlap.sort();
    Ok(Some(RemoteMoved { branch, remote, behind, overlap }))
}

/// The sync merge in progress, if the merge in progress is one: (branch, its own changeset).
fn sync_in_progress(root: &Path) -> Option<(String, String)> {
    let branch = git(root, &["symbolic-ref", "-q", "--short", "HEAD"], &[], None).ok()?.trim().to_string();
    let local = git(root, &["rev-parse", "--verify", "-q", &sync_ref(&branch)], &[], None).ok()?.trim().to_string();
    let merging = git(root, &["rev-parse", "--verify", "-q", "MERGE_HEAD"], &[], None).ok()?.trim().to_string();
    (merging == local).then_some((branch, local))
}

/// Forgets the kept changesets of syncs that were committed (the branch now contains them).
/// A sync whose branch was deleted keeps them, so they're never lost.
pub(crate) fn drop_finished_syncs(root: &Path) {
    let Ok(refs) = git(root, &["for-each-ref", "--format=%(refname)%00%(objectname)", SYNC_REFS], &[], None) else { return };
    for line in refs.lines() {
        let Some((name, local)) = line.split_once('\0') else { continue };
        let branch = &name[SYNC_REFS.len()..];
        if git(root, &["merge-base", "--is-ancestor", local, &format!("refs/heads/{branch}")], &[], None).is_ok() {
            let _ = git(root, &["update-ref", "-d", name, local], &[], None);
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStarted {
    /// The branch's own changeset being merged in (kept under `refs/visualgit/sync/`).
    pub local: String,
    /// Files with conflicts to resolve; empty when the result is ready to test and commit.
    pub conflicts: Vec<String>,
    pub submodules: SubmoduleUpdate,
}

/// Brings the checked-out `branch` level with its remote branch when both have moved on:
/// keeps the branch's own changesets aside, moves the branch to the remote branch, and merges
/// them back in (never a fast-forward) without committing. The result waits in Pending Changes
/// to be tested and committed; conflicts are left to resolve in the merge window first.
/// Aborting puts the branch back as it was.
#[tauri::command]
pub async fn sync_branch(repo: String, branch: String) -> Result<SyncStarted, String> {
    tauri::async_runtime::spawn_blocking(move || sync(&repo_root(&repo)?, &branch)).await.map_err(|e| e.to_string())?
}

pub(crate) fn sync(root: &Path, branch: &str) -> Result<SyncStarted, String> {
    let current = git(root, &["symbolic-ref", "-q", "--short", "HEAD"], &[], None).map(|s| s.trim().to_string()).unwrap_or_default();
    if current != branch {
        return Err(format!("Switch to {branch} first: the merge happens in its working copy."));
    }
    if let Some(op) = in_progress(root) {
        return Err(format!("A {op} is already in progress. Finish or abort it first."));
    }
    if !git(root, &["status", "--porcelain", "--untracked-files=no"], &[], None)?.trim().is_empty() {
        return Err("There are pending changes. Commit or undo them before merging.".into());
    }
    let Some(d) = diverged(root, branch)? else { return Err(format!("{branch} can be pushed as it is: there's nothing to merge.")) };
    let (tracking, _) = upstream(root, branch).ok_or("No remote branch")?;
    let local = git(root, &["rev-parse", "HEAD"], &[], None)?.trim().to_string();
    let theirs = git(root, &["rev-parse", &format!("{tracking}^{{commit}}")], &[], None)?.trim().to_string();

    drop_finished_syncs(root);
    let keep = sync_ref(branch);
    if git(root, &["rev-parse", "--verify", "-q", &keep], &[], None).is_ok() {
        return Err(format!("{branch} already has local changes waiting to be merged ({keep}). Merge or remove them first."));
    }
    let note = format!("VisualGit: {branch}'s own changesets, while merging them with {}", d.remote);
    git(root, &["update-ref", "-m", &note, &keep, &local], &[], None)?;
    let undo = |err: String| {
        if in_progress(root) == Some("merge") {
            let _ = git(root, &["merge", "--abort"], &[], None);
        }
        let _ = git(root, &["reset", "--quiet", "--keep", &local], &[], None);
        let _ = git(root, &["update-ref", "-d", &keep], &[], None);
        err
    };
    // Untracked files the remote's changesets would overwrite stop this, with nothing changed.
    git(root, &["reset", "--quiet", "--keep", &theirs], &[], None).map_err(|e| undo(format!("Could not move {branch} to {}: {e}", d.remote)))?;
    let message = sync_message(branch);
    match git(root, &["merge", "--no-ff", "--no-commit", "-m", &message, &local], &[], None) {
        Ok(_) => Ok(SyncStarted { local, conflicts: vec![], submodules: update_all(root) }),
        Err(err) => {
            let conflicts = conflicted_paths(root);
            if conflicts.is_empty() {
                return Err(undo(err));
            }
            Ok(SyncStarted { local, conflicts, submodules: SubmoduleUpdate::default() })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    fn repo() -> (PathBuf, impl Fn(&[&str]) -> String) {
        let dir = std::env::temp_dir().join(format!("visualgit-merge-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.clone();
        let run = move |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&d).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.name", "Test"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "commit.gpgsign", "false"]);
        (crate::os::canonical(&dir).unwrap(), run)
    }

    #[test]
    fn previews_clean_merges_conflicts_and_no_ops() {
        let (dir, run) = repo();
        let repo = dir.to_string_lossy().into_owned();
        let write = |p: &str, t: &str| std::fs::write(dir.join(p), t).unwrap();
        write("shared.txt", "1\n2\n3\n");
        write("keep.txt", "k\n");
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "base"]);
        let base = run(&["rev-parse", "HEAD"]);

        run(&["checkout", "-q", "-b", "feature"]);
        write("shared.txt", "1\n2\nfeature\n");
        write("new.txt", "n\n");
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "feature"]);
        let feature = run(&["rev-parse", "HEAD"]);

        run(&["checkout", "-q", "main"]);
        write("keep.txt", "main\n");
        run(&["commit", "-q", "-am", "main"]);

        // Clean: feature's edits apply on top of main's.
        let p = preview(&repo, &feature).unwrap();
        assert_eq!(p.kind, "merge");
        assert_eq!(p.base.as_deref(), Some(base.as_str()));
        let summary: Vec<(&str, &str, bool)> = p.files.iter().map(|f| (f.path.as_str(), f.status.as_str(), f.conflict)).collect();
        assert_eq!(summary, vec![("new.txt", "A", false), ("shared.txt", "M", false)]);
        assert!(!p.files.iter().any(|f| f.conflict));

        // Conflict: main changes the same line.
        write("shared.txt", "1\n2\nmain\n");
        run(&["commit", "-q", "-am", "main conflicts"]);
        let head = run(&["rev-parse", "HEAD"]);
        let p = preview(&repo, &feature).unwrap();
        let shared = p.files.iter().find(|f| f.path == "shared.txt").unwrap();
        assert!(shared.conflict);
        assert_eq!(p.files[0].path, "shared.txt"); // conflicts first
        let merged = run(&["show", &format!("{}:shared.txt", p.tree.as_ref().unwrap())]);
        assert!(merged.contains("<<<<<<<") && merged.contains(">>>>>>>"));
        assert!(p.messages.iter().any(|m| m.contains("CONFLICT")));

        // Already merged, and the preview never moved HEAD or touched files.
        assert_eq!(preview(&repo, &base).unwrap().kind, "up-to-date");
        assert_eq!(run(&["rev-parse", "HEAD"]), head);
        assert_eq!(run(&["status", "--porcelain"]), "");
        assert_eq!(std::fs::read_to_string(dir.join("shared.txt")).unwrap(), "1\n2\nmain\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cherry_picks_cleanly_with_conflicts_and_refuses_repeats() {
        let (dir, run) = repo();
        let repo = dir.to_string_lossy().into_owned();
        let write = |p: &str, t: &str| std::fs::write(dir.join(p), t).unwrap();
        write("f.txt", "1\n");
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "base"]);
        let base = run(&["rev-parse", "HEAD"]);
        run(&["checkout", "-q", "-b", "side"]);
        write("g.txt", "g\n");
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "add g"]);
        let add_g = run(&["rev-parse", "HEAD"]);
        write("f.txt", "side\n");
        run(&["commit", "-q", "-am", "side edits f"]);
        let edit_f = run(&["rev-parse", "HEAD"]);
        run(&["checkout", "-q", "main"]);
        write("f.txt", "main\n");
        run(&["commit", "-q", "-am", "main edits f"]);

        // Clean pick: a new changeset with the same message.
        let p = pick(&repo, &add_g).unwrap();
        let new = p.committed.unwrap();
        assert_ne!(new, add_g);
        assert_eq!(run(&["log", "-1", "--format=%s"]), "add g");
        assert!(dir.join("g.txt").exists());

        // Already included: refused.
        assert!(pick(&repo, &base).unwrap_err().contains("already part"));

        // Conflicting pick: stops, reports the file, and can be aborted.
        let p = pick(&repo, &edit_f).unwrap();
        assert_eq!(p.conflicts, vec!["f.txt".to_string()]);
        let op = operation_in_progress(repo.clone()).unwrap().unwrap();
        assert_eq!(op.kind, "cherry pick");
        assert_eq!(op.from.as_deref(), Some(edit_f.as_str()));
        assert_eq!(op.message.as_deref(), Some("side edits f"));
        assert!(pick(&repo, &add_g).is_err()); // one at a time
        abort_operation(repo.clone()).unwrap();
        assert!(operation_in_progress(repo.clone()).unwrap().is_none());
        assert_eq!(std::fs::read_to_string(dir.join("f.txt")).unwrap(), "main\n");
        assert_eq!(run(&["rev-parse", "HEAD"]), new);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn subtractive_merge_takes_changes_out() {
        let (dir, run) = repo();
        let repo = dir.to_string_lossy().into_owned();
        let write = |p: &str, t: &str| std::fs::write(dir.join(p), t).unwrap();
        write("f.txt", "1\n");
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "base"]);
        write("g.txt", "g\n");
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "add g"]);
        let add_g = run(&["rev-parse", "HEAD"]);
        write("f.txt", "2\n");
        run(&["commit", "-q", "-am", "edit f"]);
        let edit_f = run(&["rev-parse", "HEAD"]);

        // Clean: g.txt goes away in a new "Revert" changeset.
        let r = apply(&repo, &add_g, Apply::Subtract).unwrap();
        assert!(r.committed.is_some());
        assert!(!dir.join("g.txt").exists());
        assert_eq!(run(&["log", "-1", "--format=%s"]), "Revert \"add g\"");
        // Again: nothing left to take out.
        assert!(apply(&repo, &add_g, Apply::Subtract).unwrap_err().contains("already been taken out"));

        // Not in HEAD: refused.
        run(&["checkout", "-q", "-b", "side", &edit_f]);
        write("h.txt", "h\n");
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "side only"]);
        let side = run(&["rev-parse", "HEAD"]);
        run(&["checkout", "-q", "main"]);
        assert!(apply(&repo, &side, Apply::Subtract).unwrap_err().contains("isn't part of"));

        // Conflict: a later change touches the same line; reported, then aborted.
        write("f.txt", "3\n");
        run(&["commit", "-q", "-am", "edit f again"]);
        let head = run(&["rev-parse", "HEAD"]);
        let r = apply(&repo, &edit_f, Apply::Subtract).unwrap();
        assert_eq!(r.conflicts, vec!["f.txt".to_string()]);
        let op = operation_in_progress(repo.clone()).unwrap().unwrap();
        assert_eq!(op.kind, "subtractive merge");
        assert_eq!(op.from.as_deref(), Some(edit_f.as_str()));
        abort_operation(repo.clone()).unwrap();
        assert!(operation_in_progress(repo.clone()).unwrap().is_none());
        assert_eq!(run(&["rev-parse", "HEAD"]), head);
        assert_eq!(std::fs::read_to_string(dir.join("f.txt")).unwrap(), "3\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn previews_a_fast_forward() {
        let (dir, run) = repo();
        let repo = dir.to_string_lossy().into_owned();
        run(&["commit", "-q", "--allow-empty", "-m", "one"]);
        run(&["checkout", "-q", "-b", "ahead"]);
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "two"]);
        let ahead = run(&["rev-parse", "HEAD"]);
        run(&["checkout", "-q", "main"]);
        let p = preview(&repo, &ahead).unwrap();
        assert_eq!(p.kind, "fast-forward");
        assert_eq!(p.files.len(), 1);
        assert_eq!(p.files[0].status, "A");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn merges_never_fast_forward() {
        let (dir, run) = repo();
        let repo = dir.to_string_lossy().into_owned();
        run(&["commit", "-q", "--allow-empty", "-m", "one"]);
        let base = run(&["rev-parse", "HEAD"]);
        run(&["checkout", "-q", "-b", "feature"]);
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "two"]);
        let tip = run(&["rev-parse", "HEAD"]);
        run(&["checkout", "-q", "main"]);
        // Even with fast-forwards forced on in the config.
        run(&["config", "merge.ff", "only"]);

        let done = merge_into_head(&repo, &tip, Some("feature")).unwrap();
        let merged = done.committed.unwrap();
        assert_eq!(run(&["rev-list", "--parents", "-n", "1", &merged]), format!("{merged} {base} {tip}"));
        assert_eq!(run(&["log", "-1", "--format=%s"]), "Merge branch 'feature' into main");
        assert_eq!(run(&["rev-parse", "feature"]), tip, "the merged branch stays where it was");
        assert!(merge_into_head(&repo, &tip, None).unwrap_err().contains("already merged"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn merge_conflicts_stay_in_progress_and_pending_changes_block() {
        let (dir, run) = repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("f.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "base"]);
        run(&["checkout", "-q", "-b", "other"]);
        std::fs::write(dir.join("f.txt"), "theirs\n").unwrap();
        run(&["commit", "-q", "-am", "theirs"]);
        let theirs = run(&["rev-parse", "HEAD"]);
        run(&["checkout", "-q", "main"]);
        std::fs::write(dir.join("f.txt"), "ours\n").unwrap();
        run(&["commit", "-q", "-am", "ours"]);

        // A tracked file with uncommitted changes stops the merge before it starts.
        std::fs::write(dir.join("f.txt"), "edited\n").unwrap();
        assert!(merge_into_head(&repo, &theirs, None).unwrap_err().contains("pending changes"));
        run(&["checkout", "--", "f.txt"]);

        // A changeset that isn't a branch tip gets a message naming it.
        let done = merge_into_head(&repo, &theirs, Some("main")).unwrap();
        assert_eq!(done.conflicts, vec!["f.txt".to_string()]);
        assert_eq!(in_progress(&dir), Some("merge"));
        let op = operation_in_progress(repo.clone()).unwrap().unwrap();
        assert_eq!(op.message.as_deref(), Some(format!("Merge changeset {} into main", &theirs[..8]).as_str()));
        abort_operation(repo.clone()).unwrap();
        assert_eq!(in_progress(&dir), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_merge_resolved_in_the_merge_window_commits_with_both_parents() {
        // What the merge window does: merge, write the resolved file over git's, commit with git's message.
        let (dir, run) = repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("f.txt"), "base\n").unwrap();
        std::fs::write(dir.join("clean.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "base"]);
        run(&["checkout", "-q", "-b", "feature"]);
        std::fs::write(dir.join("f.txt"), "theirs\n").unwrap();
        std::fs::write(dir.join("clean.txt"), "one\ntwo\n").unwrap();
        run(&["commit", "-q", "-am", "theirs"]);
        let theirs = run(&["rev-parse", "HEAD"]);
        run(&["checkout", "-q", "main"]);
        std::fs::write(dir.join("f.txt"), "ours\n").unwrap();
        run(&["commit", "-q", "-am", "ours"]);
        let ours = run(&["rev-parse", "HEAD"]);

        let done = merge_into_head(&repo, &theirs, Some("feature")).unwrap();
        assert_eq!(done.conflicts, vec!["f.txt".to_string()]);
        std::fs::write(dir.join("f.txt"), "resolved\n").unwrap();
        let message = operation_in_progress(repo.clone()).unwrap().unwrap().message.unwrap();
        let merged = crate::pending::commit(&repo, &message, &done.conflicts).unwrap();

        assert_eq!(run(&["rev-list", "--parents", "-n", "1", &merged]), format!("{merged} {ours} {theirs}"));
        assert_eq!(run(&["log", "-1", "--format=%s"]), "Merge branch 'feature' into main");
        assert_eq!(run(&["show", &format!("{merged}:f.txt")]), "resolved");
        assert_eq!(run(&["show", &format!("{merged}:clean.txt")]), "one\ntwo", "the cleanly merged file comes along");
        assert_eq!(in_progress(&dir), None);
        assert_eq!(run(&["status", "--porcelain"]), "");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn submodules_follow_a_merge_clean_or_after_conflicts() {
        let tmp = std::env::temp_dir().join(format!("visualgit-merge-sub-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let at = |dir: PathBuf| {
            move |args: &[&str]| {
                let out = Command::new("git")
                    .arg("-C")
                    .arg(&dir)
                    .args(["-c", "user.name=T", "-c", "user.email=t@e", "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always"])
                    .args(args)
                    .output()
                    .unwrap();
                assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
                String::from_utf8_lossy(&out.stdout).trim().to_string()
            }
        };
        let (lib, app) = (tmp.join("lib"), tmp.join("app"));
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::create_dir_all(&app).unwrap();
        let l = at(lib.clone());
        l(&["init", "-q"]);
        for n in ["one", "two", "three"] {
            l(&["commit", "-q", "--allow-empty", "-m", n]);
        }
        let commits: Vec<String> = l(&["rev-list", "--reverse", "HEAD"]).lines().map(str::to_string).collect();
        let a = at(app.clone());
        a(&["init", "-q"]);
        std::fs::write(app.join("f.txt"), "base\n").unwrap();
        a(&["submodule", "add", "-q", lib.to_str().unwrap(), "lib"]);
        at(app.join("lib"))(&["checkout", "-q", "--detach", &commits[0]]);
        a(&["add", "."]);
        a(&["commit", "-qm", "base"]);
        let sub = |c: &str| {
            at(app.join("lib"))(&["checkout", "-q", "--detach", c]);
            a(&["add", "lib"]);
        };
        let lib_head = || at(app.join("lib"))(&["rev-parse", "HEAD"]);

        // A branch that moves the submodule on; merged cleanly, the submodule follows.
        a(&["switch", "-q", "-c", "bump"]);
        sub(&commits[1]);
        a(&["commit", "-qm", "lib to two"]);
        a(&["switch", "-q", "main"]);
        sub(&commits[0]); // git switch leaves it where it was
        let root = repo_root(app.to_str().unwrap()).unwrap();
        let done = merge_into_head(root.to_str().unwrap(), &a(&["rev-parse", "bump"]), Some("bump")).unwrap();
        assert!(done.committed.is_some());
        assert_eq!(done.submodules.updated, vec!["lib".to_string()]);
        assert_eq!(lib_head(), commits[1]);

        // Another that moves it again, but also conflicts in a file: it follows when the result is committed.
        a(&["switch", "-q", "-c", "clash", "HEAD~1"]);
        sub(&commits[2]);
        std::fs::write(app.join("f.txt"), "clash\n").unwrap();
        a(&["commit", "-qam", "lib to three, f clashes"]);
        a(&["switch", "-q", "main"]);
        sub(&commits[1]);
        std::fs::write(app.join("f.txt"), "main\n").unwrap();
        a(&["commit", "-qam", "f on main"]);
        let stopped = merge_into_head(root.to_str().unwrap(), &a(&["rev-parse", "clash"]), None).unwrap();
        assert_eq!(stopped.conflicts, vec!["f.txt".to_string()]);
        assert_eq!(lib_head(), commits[1], "git leaves it while the merge is in progress");
        std::fs::write(app.join("f.txt"), "resolved\n").unwrap();
        let committed = crate::pending::commit_and_follow(root.to_str().unwrap(), "Merge clash", &["f.txt".into()]).unwrap();
        assert_eq!(committed.submodules.updated, vec!["lib".to_string()]);
        assert_eq!(lib_head(), commits[2]);
        // An ordinary commit afterwards leaves submodules alone.
        std::fs::write(app.join("f.txt"), "later\n").unwrap();
        assert!(crate::pending::commit_and_follow(root.to_str().unwrap(), "later", &["f.txt".into()]).unwrap().submodules.updated.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_push_the_remote_would_refuse_becomes_a_merge_to_test_first() {
        let tmp = std::env::temp_dir().join(format!("visualgit-sync-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let tmp = crate::os::canonical(&tmp).unwrap();
        let (remote, mine, theirs) = (tmp.join("remote.git"), tmp.join("mine"), tmp.join("theirs"));
        let run = |dir: &Path, args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=T", "-c", "user.email=t@e", "-c", "commit.gpgsign=false"]).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        run(&tmp, &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
        run(&tmp, &["clone", "-q", remote.to_str().unwrap(), mine.to_str().unwrap()]);
        std::fs::write(mine.join("f.txt"), "one\ntwo\nthree\n").unwrap();
        run(&mine, &["add", "f.txt"]);
        run(&mine, &["commit", "-q", "-m", "base"]);
        run(&mine, &["push", "-q", "-u", "origin", "main"]);
        run(&tmp, &["clone", "-q", remote.to_str().unwrap(), theirs.to_str().unwrap()]);
        let repo = mine.to_str().unwrap();

        // Someone else pushes; I commit without fetching.
        std::fs::write(theirs.join("t.txt"), "theirs\n").unwrap();
        run(&theirs, &["add", "t.txt"]);
        run(&theirs, &["commit", "-q", "-m", "theirs"]);
        run(&theirs, &["push", "-q", "origin", "main"]);
        std::fs::write(mine.join("m.txt"), "mine\n").unwrap();
        run(&mine, &["add", "m.txt"]);
        run(&mine, &["commit", "-q", "-m", "mine"]);
        let local = run(&mine, &["rev-parse", "HEAD"]);

        // Pushing checks first and pushes nothing.
        let pushed = crate::pending::push_branch_now(&mine, "main").unwrap();
        assert_eq!(pushed.message, None);
        assert_eq!(pushed.diverged, Some(Diverged { branch: "main".into(), remote: "origin/main".into(), ahead: 1, behind: 1, checked_out: true }));
        let remote_tip = run(&mine, &["rev-parse", "origin/main"]);

        // Merging: main moves to origin/main, my changeset is merged in, and nothing is committed.
        let started = sync(&mine, "main").unwrap();
        assert!(started.conflicts.is_empty());
        assert_eq!(started.local, local);
        assert_eq!(run(&mine, &["rev-parse", "HEAD"]), remote_tip);
        assert_eq!(run(&mine, &["rev-parse", "MERGE_HEAD"]), local);
        assert_eq!(run(&mine, &["rev-parse", &sync_ref("main")]), local);
        assert!(mine.join("m.txt").exists() && mine.join("t.txt").exists());
        let op = operation_in_progress(repo.into()).unwrap().unwrap();
        assert_eq!(op.message.as_deref(), Some("Merge local changes into main"));
        assert_eq!(op.sync.as_ref().map(|s| (s.branch.as_str(), s.remote.as_str())), Some(("main", "origin/main")));

        // Committing it: origin/main is the first parent, my changeset the second; then the push goes through.
        crate::pending::commit_and_follow(repo, "Merge local changes into main", &["m.txt".into()]).unwrap();
        assert_eq!(run(&mine, &["rev-parse", "HEAD^1"]), remote_tip);
        assert_eq!(run(&mine, &["rev-parse", "HEAD^2"]), local);
        assert!(run(&mine, &["for-each-ref", SYNC_REFS]).is_empty(), "the kept changesets are forgotten once merged");
        assert_eq!(crate::pending::push_branch_now(&mine, "main").unwrap().message.as_deref(), Some("Pushed main to origin/main"));

        // Conflicting changes: the merge stops for them; aborting puts main back on my changeset.
        std::fs::write(theirs.join("f.txt"), "one\nTHEIRS\nthree\n").unwrap();
        run(&theirs, &["pull", "-q", "--no-rebase"]);
        run(&theirs, &["commit", "-q", "-am", "theirs 2"]);
        run(&theirs, &["push", "-q", "origin", "main"]);
        std::fs::write(mine.join("f.txt"), "one\nMINE\nthree\n").unwrap();
        run(&mine, &["commit", "-q", "-am", "mine 2"]);
        let local = run(&mine, &["rev-parse", "HEAD"]);
        assert!(crate::pending::push_branch_now(&mine, "main").unwrap().diverged.is_some());
        let started = sync(&mine, "main").unwrap();
        assert_eq!(started.conflicts, vec!["f.txt".to_string()]);
        abort_operation(repo.into()).unwrap();
        assert_eq!(run(&mine, &["rev-parse", "HEAD"]), local);
        assert_eq!(run(&mine, &["symbolic-ref", "--short", "HEAD"]), "main");
        assert!(run(&mine, &["status", "--porcelain"]).is_empty());
        assert!(run(&mine, &["for-each-ref", SYNC_REFS]).is_empty());

        // Only the checked-out branch can be merged, with no pending changes.
        std::fs::write(mine.join("f.txt"), "dirty\n").unwrap();
        assert!(sync(&mine, "main").unwrap_err().contains("pending changes"));
        assert!(sync(&mine, "other").unwrap_err().contains("Switch to other"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn says_when_the_remote_moved_on_under_pending_changes() {
        let tmp = std::env::temp_dir().join(format!("visualgit-moved-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let tmp = crate::os::canonical(&tmp).unwrap();
        let (remote, mine, theirs) = (tmp.join("remote.git"), tmp.join("mine"), tmp.join("theirs"));
        let run = |dir: &Path, args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=T", "-c", "user.email=t@e", "-c", "commit.gpgsign=false"]).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        run(&tmp, &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
        run(&tmp, &["clone", "-q", remote.to_str().unwrap(), mine.to_str().unwrap()]);
        std::fs::write(mine.join("a.txt"), "a\n").unwrap();
        std::fs::write(mine.join("b.txt"), "b\n").unwrap();
        run(&mine, &["add", "."]);
        run(&mine, &["commit", "-q", "-m", "base"]);
        run(&mine, &["push", "-q", "-u", "origin", "main"]);
        run(&tmp, &["clone", "-q", remote.to_str().unwrap(), theirs.to_str().unwrap()]);

        // Pending changes, and the remote level: nothing to say.
        std::fs::write(mine.join("a.txt"), "mine\n").unwrap();
        std::fs::write(mine.join("new.txt"), "new\n").unwrap();
        assert_eq!(remote_moved_at(&mine).unwrap(), None);

        // Someone pushes changes to a.txt and c.txt; after a fetch, a.txt is in both.
        std::fs::write(theirs.join("a.txt"), "theirs\n").unwrap();
        std::fs::write(theirs.join("c.txt"), "c\n").unwrap();
        run(&theirs, &["add", "."]);
        run(&theirs, &["commit", "-q", "-m", "theirs"]);
        run(&theirs, &["push", "-q", "origin", "main"]);
        assert_eq!(remote_moved_at(&mine).unwrap(), None, "not known until fetched");
        crate::pending::fetch(&mine).unwrap();
        assert_eq!(
            remote_moved_at(&mine).unwrap(),
            Some(RemoteMoved { branch: "main".into(), remote: "origin/main".into(), behind: 1, overlap: vec!["a.txt".into()] })
        );

        // No pending changes: nothing to warn about before committing.
        run(&mine, &["checkout", "-q", "--", "a.txt"]);
        std::fs::remove_file(mine.join("new.txt")).unwrap();
        assert_eq!(remote_moved_at(&mine).unwrap(), None);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
