//! The commands behind the Pending Changes view, which change a repository:
//! reading and saving working-tree files, committing selected files, undoing
//! changes, and pushing branches.
//!
//! These are deliberately separate from the read-only `git` command: each one
//! does a single, narrow thing, with its paths checked to stay inside the
//! repository.

use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// Files larger than this are not loaded into the diff editor.
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Serialize)]
struct ShowPending {
    repo: String,
}

/// Brings the main window forward on its Pending Changes view for `repo`
/// (opening that repository there if another one is open). Used by the merge
/// window when a merge stops for conflicts or finds pending changes.
#[tauri::command]
pub fn show_pending_changes(app: AppHandle, repo: String) -> Result<(), String> {
    let root = repo_root(&repo)?;
    let main = app.get_webview_window("main").ok_or("The main window is closed")?;
    main.unminimize().ok();
    main.show().map_err(|e| e.to_string())?;
    main.set_focus().map_err(|e| e.to_string())?;
    main.emit("show-pending", ShowPending { repo: root.to_string_lossy().into_owned() }).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    /// The contents, when the file exists and is UTF-8 text of a reasonable size.
    text: Option<String>,
    missing: bool,
    binary: bool,
    too_large: bool,
}

/// Reads a working-tree file for the diff editor.
#[tauri::command]
pub fn read_worktree_file(repo: String, path: String) -> Result<FileText, String> {
    let file = resolve(&repo, &path)?;
    let none = FileText { text: None, missing: false, binary: false, too_large: false };
    let meta = match std::fs::metadata(&file) {
        Ok(m) if m.is_file() => m,
        Ok(_) | Err(_) => return Ok(FileText { missing: true, ..none }),
    };
    if meta.len() > MAX_FILE_BYTES {
        return Ok(FileText { too_large: true, ..none });
    }
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Ok(FileText { binary: true, ..none });
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok(FileText { text: Some(text), ..none }),
        // Not UTF-8: editing it as text would corrupt it on save.
        Err(_) => Ok(FileText { binary: true, ..none }),
    }
}

/// Saves an edited working-tree file. Only existing files can be written.
#[tauri::command]
pub fn write_worktree_file(repo: String, path: String, text: String) -> Result<(), String> {
    let file = resolve(&repo, &path)?;
    if !file.is_file() {
        return Err(format!("{path} no longer exists"));
    }
    std::fs::write(&file, text).map_err(|e| format!("could not save {path}: {e}"))
}

/// Commits the given files as they are in the working tree, with `message`,
/// and returns the new changeset id. Other staged files are left staged.
#[tauri::command]
pub async fn commit_changes(repo: String, message: String, paths: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || commit(&repo, &message, &paths))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn commit(repo: &str, message: &str, paths: &[String]) -> Result<String, String> {
    let root = repo_root(repo)?;
    if message.trim().is_empty() {
        return Err("Enter a commit message".into());
    }
    if paths.is_empty() {
        return Err("Select at least one file to commit".into());
    }
    for p in paths {
        check_relative(p)?;
    }
    // Stage the selected files exactly as they are on disk, including deletions.
    git(&root, &["add", "-A", "--"], paths, None)?;
    // A merge or cherry pick in progress must be committed whole; otherwise commit only the selection.
    let merging = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]
        .iter()
        .any(|r| git(&root, &["rev-parse", "-q", "--verify", r], &[], None).is_ok());
    let selection: &[String] = if merging { &[] } else { paths };
    let only: &[&str] = if merging { &["commit", "-F", "-"] } else { &["commit", "-F", "-", "--"] };
    git(&root, only, selection, Some(message))?;
    Ok(git(&root, &["rev-parse", "HEAD"], &[], None)?.trim().to_string())
}

/// Undoes pending changes. `tracked` paths (in the checked-out changeset) get
/// their committed content back, in the working tree and the index. `created`
/// paths (new files) are unstaged and moved to the Trash, so they can still be
/// recovered.
#[tauri::command]
pub async fn undo_changes(repo: String, tracked: Vec<String>, created: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || undo(&repo, &tracked, &created, &to_trash))
        .await
        .map_err(|e| e.to_string())?
}

fn to_trash(files: &[&PathBuf]) -> Result<(), String> {
    trash::delete_all(files).map_err(|e| format!("could not move new files to the Trash: {e}"))
}

/// `discard` gets rid of the new files (the Trash in the app; tests delete them).
fn undo(repo: &str, tracked: &[String], created: &[String], discard: &dyn Fn(&[&PathBuf]) -> Result<(), String>) -> Result<(), String> {
    let root = repo_root(repo)?;
    for p in tracked.iter().chain(created) {
        check_relative(p)?;
    }
    let files: Vec<PathBuf> = created.iter().map(|p| resolve(repo, p)).collect::<Result<_, _>>()?;
    if !created.is_empty() {
        git(&root, &["rm", "--cached", "--quiet", "--ignore-unmatch", "-r", "--"], created, None)?;
    }
    if !tracked.is_empty() {
        git(&root, &["restore", "--source=HEAD", "--staged", "--worktree", "--"], tracked, None)?;
    }
    let existing: Vec<&PathBuf> = files.iter().filter(|f| f.symlink_metadata().is_ok()).collect();
    if !existing.is_empty() {
        discard(&existing)?;
    }
    Ok(())
}

/// Pushes the checked-out branch and returns a summary like "Pushed main to origin".
#[tauri::command]
pub async fn push_current_branch(repo: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || push(&repo)).await.map_err(|e| e.to_string())?
}

/// Pushes a local branch (checked out or not) and returns a summary.
#[tauri::command]
pub async fn push_branch(repo: String, branch: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || push_named(&repo_root(&repo)?, &branch)).await.map_err(|e| e.to_string())?
}

fn push(repo: &str) -> Result<String, String> {
    let root = repo_root(repo)?;
    let branch = git(&root, &["symbolic-ref", "-q", "--short", "HEAD"], &[], None)
        .map_err(|_| "HEAD is detached. Check out a branch to push it.".to_string())?
        .trim()
        .to_string();
    push_named(&root, &branch)
}

/// Pushes `refs/heads/<branch>`: to its upstream if it has one, otherwise to
/// origin (or the only remote) under the same name, setting the upstream.
fn push_named(root: &Path, branch: &str) -> Result<String, String> {
    let root = root.to_path_buf();
    if branch.starts_with('-') || git(&root, &["rev-parse", "--verify", "-q", &format!("refs/heads/{branch}")], &[], None).is_err() {
        return Err(format!("{branch} is not a local branch"));
    }
    let config = |key: String| git(&root, &["config", "--get", &key], &[], None).ok().map(|s| s.trim().to_string());

    // A branch with an upstream goes to that remote and branch.
    if let (Some(remote), Some(merge)) = (config(format!("branch.{branch}.remote")), config(format!("branch.{branch}.merge"))) {
        if remote != "." {
            git(&root, &["push", "--porcelain", &remote, &format!("refs/heads/{branch}:{merge}")], &[], None)?;
            let target = merge.strip_prefix("refs/heads/").unwrap_or(&merge);
            return Ok(format!("Pushed {branch} to {remote}/{target}"));
        }
    }
    // Otherwise publish it under the same name and track it from now on.
    let remotes: Vec<String> = git(&root, &["remote"], &[], None)?.lines().map(str::to_string).collect();
    let remote = if remotes.iter().any(|r| r == "origin") {
        "origin".to_string()
    } else if remotes.len() == 1 {
        remotes[0].clone()
    } else if remotes.is_empty() {
        return Err("This repository has no remote to push to.".into());
    } else {
        return Err(format!("{branch} has no upstream and there is no origin remote; set one with git push -u <remote> {branch}"));
    };
    git(&root, &["push", "--porcelain", "-u", &remote, &format!("refs/heads/{branch}:refs/heads/{branch}")], &[], None)?;
    Ok(format!("Pushed {branch} to {remote} (new branch)"))
}

pub(crate) fn git(root: &Path, args: &[&str], paths: &[String], stdin: Option<&str>) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(root)
        // Paths are file names, never glob patterns.
        .args(["--no-pager", "--literal-pathspecs"])
        .args(args)
        .args(paths)
        .env("GIT_TERMINAL_PROMPT", "0")
        // Never open an editor; the message comes from stdin.
        .env("GIT_EDITOR", "true")
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("failed to run git: {e}"))?;
    if let Some(input) = stdin {
        child.stdin.take().unwrap().write_all(input.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err };
        Err(msg)
    }
}

/// The repository's top-level folder, canonicalised.
pub(crate) fn repo_root(repo: &str) -> Result<PathBuf, String> {
    let path = Path::new(repo).canonicalize().map_err(|_| format!("not a directory: {repo}"))?;
    if !path.join(".git").exists() {
        return Err(format!("not the top of a Git repository: {repo}"));
    }
    Ok(path)
}

/// A repository-relative path that cannot climb out of the repository or into `.git`.
fn check_relative(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    let mut parts = p.components().peekable();
    if parts.peek().is_none() {
        return Err("empty path".into());
    }
    for (i, c) in p.components().enumerate() {
        match c {
            Component::Normal(name) if i == 0 && name == ".git" => return Err(format!("{path} is inside .git")),
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(format!("{path} is not a path inside the repository")),
        }
    }
    Ok(())
}

/// Resolves a repository-relative path, refusing anything that leads outside
/// the repository, including through symbolic links.
pub(crate) fn resolve(repo: &str, path: &str) -> Result<PathBuf, String> {
    let root = repo_root(repo)?;
    check_relative(path)?;
    let file = root.join(path);
    let real = match file.canonicalize() {
        Ok(real) => real,
        // A deleted file: check the folder it was in instead.
        Err(_) => match file.parent().and_then(|d| d.canonicalize().ok()) {
            Some(dir) => dir.join(file.file_name().unwrap_or_default()),
            None => return Ok(file),
        },
    };
    if !real.starts_with(&root) {
        return Err(format!("{path} is outside the repository"));
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths() {
        assert!(check_relative("src/main.ts").is_ok());
        assert!(check_relative("a file with spaces.txt").is_ok());
        assert!(check_relative("./x").is_ok());
        assert!(check_relative("").is_err());
        assert!(check_relative("../outside").is_err());
        assert!(check_relative("src/../../outside").is_err());
        assert!(check_relative("/etc/passwd").is_err());
        assert!(check_relative(".git/config").is_err());
    }

    fn scratch_repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("visualgit-pending-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            assert!(Command::new("git").arg("-C").arg(&dir).args(args).status().unwrap().success());
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.name", "Test"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "commit.gpgsign", "false"]);
        dir.canonicalize().unwrap()
    }

    #[test]
    fn commits_only_the_selected_files() {
        let dir = scratch_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        std::fs::write(dir.join("b.txt"), "b\n").unwrap();
        let first = commit(&repo, "first", &["a.txt".into()]).unwrap();
        assert_eq!(first.len(), 40);
        let tracked = git(&dir, &["ls-files"], &[], None).unwrap();
        assert_eq!(tracked, "a.txt\n");

        // Deleting a committed file and committing it records the deletion.
        std::fs::remove_file(dir.join("a.txt")).unwrap();
        commit(&repo, "remove a", &["a.txt".into()]).unwrap();
        assert_eq!(git(&dir, &["ls-files"], &[], None).unwrap(), "");
        assert_eq!(git(&dir, &["log", "-1", "--format=%s"], &[], None).unwrap(), "remove a\n");

        assert!(commit(&repo, "  ", &["b.txt".into()]).is_err());
        assert!(commit(&repo, "x", &[]).is_err());
        assert!(commit(&repo, "x", &["../escape".into()]).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pushes_the_checked_out_branch() {
        let dir = scratch_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        commit(&repo, "first", &["a.txt".into()]).unwrap();
        assert!(push(&repo).unwrap_err().contains("no remote"));

        let remote = dir.with_extension("remote.git");
        let _ = std::fs::remove_dir_all(&remote);
        assert!(Command::new("git").args(["init", "-q", "--bare"]).arg(&remote).status().unwrap().success());
        git(&dir, &["remote", "add", "origin", &remote.to_string_lossy()], &[], None).unwrap();

        // First push publishes the branch and sets its upstream.
        assert_eq!(push(&repo).unwrap(), "Pushed main to origin (new branch)");
        assert_eq!(git(&dir, &["rev-parse", "--abbrev-ref", "@{u}"], &[], None).unwrap().trim(), "origin/main");
        // Later pushes go to the upstream.
        std::fs::write(dir.join("a.txt"), "a2\n").unwrap();
        let second = commit(&repo, "second", &["a.txt".into()]).unwrap();
        assert_eq!(push(&repo).unwrap(), "Pushed main to origin/main");
        let on_remote = Command::new("git").arg("-C").arg(&remote).args(["rev-parse", "main"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&on_remote.stdout).trim(), second);

        // Any local branch can be pushed, not just the checked-out one.
        git(&dir, &["branch", "side"], &[], None).unwrap();
        assert_eq!(push_named(&dir, "side").unwrap(), "Pushed side to origin (new branch)");
        assert!(push_named(&dir, "no-such-branch").is_err());
        assert!(push_named(&dir, "--force").is_err());
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&remote).ok();
    }

    #[test]
    fn undoes_changes_and_trashes_new_files() {
        let dir = scratch_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("keep.txt"), "original\n").unwrap();
        std::fs::write(dir.join("gone.txt"), "g\n").unwrap();
        commit(&repo, "base", &["keep.txt".into(), "gone.txt".into()]).unwrap();

        std::fs::write(dir.join("keep.txt"), "edited\n").unwrap();
        git(&dir, &["add", "keep.txt"], &[], None).unwrap(); // staged too
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        std::fs::write(dir.join("added.txt"), "a\n").unwrap();
        git(&dir, &["add", "added.txt"], &[], None).unwrap();

        let delete = |files: &[&PathBuf]| {
            files.iter().try_for_each(|f| std::fs::remove_file(f)).map_err(|e| e.to_string())
        };
        undo(&repo, &["keep.txt".into(), "gone.txt".into()], &["added.txt".into()], &delete).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("keep.txt")).unwrap(), "original\n");
        assert_eq!(std::fs::read_to_string(dir.join("gone.txt")).unwrap(), "g\n");
        assert!(!dir.join("added.txt").exists());
        assert_eq!(git(&dir, &["status", "--porcelain"], &[], None).unwrap(), "");
        assert!(undo(&repo, &["../x".into()], &[], &delete).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reads_and_writes_inside_the_repository_only() {
        let dir = scratch_repo();
        let repo = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("t.txt"), "one\r\ntwo\r\n").unwrap();
        write_worktree_file(repo.clone(), "t.txt".into(), "one\r\nTWO\r\n".into()).unwrap();
        assert_eq!(read_worktree_file(repo.clone(), "t.txt".into()).unwrap().text.as_deref(), Some("one\r\nTWO\r\n"));
        assert!(read_worktree_file(repo.clone(), "gone.txt".into()).unwrap().missing);
        assert!(write_worktree_file(repo.clone(), "gone.txt".into(), "x".into()).is_err());
        assert!(write_worktree_file(repo.clone(), "../x.txt".into(), "x".into()).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(std::env::temp_dir(), dir.join("link")).unwrap();
            assert!(write_worktree_file(repo.clone(), "link/x.txt".into(), "x".into()).is_err());
        }
        std::fs::write(dir.join("bin"), [0u8, 1, 2]).unwrap();
        assert!(read_worktree_file(repo, "bin".into()).unwrap().binary);
        std::fs::remove_dir_all(&dir).ok();
    }
}
