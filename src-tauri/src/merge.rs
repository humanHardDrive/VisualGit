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
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, Window};

use crate::branch::commit_id;
use crate::pending::{git, repo_root};

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
    let info = MergeWindowInfo { repo: root.to_string_lossy().into_owned(), from: from.clone() };
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
    let out = Command::new("git")
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
        Ok(_) => Ok(CherryPick { committed: Some(git(&root, &["rev-parse", "HEAD"], &[], None)?.trim().to_string()), conflicts: vec![] }),
        Err(err) => {
            let conflicts = conflicted_paths(&root);
            if !conflicts.is_empty() {
                return Ok(CherryPick { committed: None, conflicts });
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
        Ok(_) => Ok(CherryPick { committed: Some(git(&root, &["rev-parse", "HEAD"], &[], None)?.trim().to_string()), conflicts: vec![] }),
        Err(err) => {
            let conflicts = conflicted_paths(&root);
            if !conflicts.is_empty() {
                return Ok(CherryPick { committed: None, conflicts });
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
    Ok(Some(Operation { kind: kind.into(), from, message }))
}

/// Abandons the operation in progress, putting everything back as it was.
#[tauri::command]
pub fn abort_operation(repo: String) -> Result<(), String> {
    let root = repo_root(&repo)?;
    let Some(kind) = in_progress(&root) else { return Ok(()) };
    let command = OPERATIONS.iter().find(|(name, _, _)| *name == kind).map(|(_, _, c)| *c).unwrap_or("merge");
    git(&root, &[command, "--abort"], &[], None).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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
        (dir.canonicalize().unwrap(), run)
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
}
