//! Creating branches and switching between changesets from the explorer.

use crate::pending::{git, repo_root};
use crate::submodule::{update_all, SubmoduleUpdate};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    /// Whether the new branch is now checked out.
    switched: bool,
    /// Why switching failed, when it was asked for and didn't happen. The branch exists either way.
    switch_error: Option<String>,
    /// After switching: the submodules brought up to date.
    submodules: SubmoduleUpdate,
}

/// What a switch did: a summary for the user, and the submodules it updated.
#[derive(Debug, Serialize)]
pub struct Switched {
    message: String,
    submodules: SubmoduleUpdate,
}

impl Switched {
    /// Having checked out another changeset: its submodules follow.
    fn after(root: &std::path::Path, message: String) -> Self {
        Switched { message, submodules: update_all(root) }
    }
}

/// Creates branch `name` at changeset `at`, and checks it out if `switch_to` is set.
#[tauri::command]
pub async fn create_branch(repo: String, name: String, at: String, switch_to: bool) -> Result<Created, String> {
    tauri::async_runtime::spawn_blocking(move || create(&repo, &name, &at, switch_to))
        .await
        .map_err(|e| e.to_string())?
}

fn create(repo: &str, name: &str, at: &str, switch_to: bool) -> Result<Created, String> {
    let root = repo_root(repo)?;
    let name = name.trim();
    if name.is_empty() {
        return Err("Enter a branch name".into());
    }
    if name.starts_with('-') || git(&root, &["check-ref-format", "--branch", name], &[], None).is_err() {
        return Err(format!("“{name}” isn't a valid branch name (no spaces, and none of ~ ^ : ? * [ \\ or ..)"));
    }
    if git(&root, &["rev-parse", "--verify", "-q", &format!("refs/heads/{name}")], &[], None).is_ok() {
        return Err(format!("A branch named “{name}” already exists"));
    }
    commit_id(&root, at)?;
    git(&root, &["branch", "--no-track", name, at], &[], None)?;
    if !switch_to {
        return Ok(Created { switched: false, switch_error: None, submodules: SubmoduleUpdate::default() });
    }
    // Uncommitted changes come along; git refuses only if they would be overwritten.
    match git(&root, &["switch", name], &[], None) {
        Ok(_) => Ok(Created { switched: true, switch_error: None, submodules: update_all(&root) }),
        Err(e) => Ok(Created { switched: false, switch_error: Some(e), submodules: SubmoduleUpdate::default() }),
    }
}

/// Checks out changeset `at`: as `branch` when given (it must point there), otherwise
/// as a detached HEAD. Returns a summary for the user.
#[tauri::command]
pub async fn switch_to_changeset(repo: String, at: String, branch: Option<String>) -> Result<Switched, String> {
    tauri::async_runtime::spawn_blocking(move || switch(&repo, &at, branch.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

fn switch(repo: &str, at: &str, branch: Option<&str>) -> Result<Switched, String> {
    let root = repo_root(repo)?;
    let full = commit_id(&root, at)?;
    let short = &full[..8.min(full.len())];
    if let Some(b) = branch {
        let tip = git(&root, &["rev-parse", "--verify", "-q", &format!("refs/heads/{b}")], &[], None).map_err(|_| format!("{b} is not a local branch"))?;
        if b.starts_with('-') || tip.trim() != full {
            return Err(format!("{b} does not point at {short}"));
        }
        git(&root, &["switch", b], &[], None)?;
        return Ok(Switched::after(&root, format!("Switched to {b}")));
    }
    git(&root, &["switch", "--detach", &full], &[], None)?;
    Ok(Switched::after(&root, format!("Switched to changeset {short} (detached HEAD). Create a branch here before committing")))
}

/// Creates a local branch tracking `remote_ref` (`refs/remotes/<remote>/<name>`)
/// under the same name, and switches to it.
#[tauri::command]
pub async fn switch_to_remote_branch(repo: String, remote_ref: String) -> Result<Switched, String> {
    tauri::async_runtime::spawn_blocking(move || track(&repo, &remote_ref))
        .await
        .map_err(|e| e.to_string())?
}

fn track(repo: &str, remote_ref: &str) -> Result<Switched, String> {
    let root = repo_root(repo)?;
    let short = remote_ref.strip_prefix("refs/remotes/").ok_or_else(|| format!("{remote_ref} is not a remote branch"))?;
    let (_, name) = short.split_once('/').ok_or_else(|| format!("{remote_ref} is not a remote branch"))?;
    if short.starts_with('-') || git(&root, &["rev-parse", "--verify", "-q", remote_ref], &[], None).is_err() {
        return Err(format!("{short} is not a remote branch"));
    }
    if git(&root, &["rev-parse", "--verify", "-q", &format!("refs/heads/{name}")], &[], None).is_ok() {
        return Err(format!("A local branch named {name} already exists"));
    }
    git(&root, &["switch", "-c", name, "--track", short], &[], None)?;
    Ok(Switched::after(&root, format!("Switched to {name}, a new local branch tracking {short}")))
}

/// The full id of changeset `at`, which must be a (possibly abbreviated) commit id.
pub(crate) fn commit_id(root: &std::path::Path, at: &str) -> Result<String, String> {
    if at.is_empty() || !at.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("{at} is not a changeset in this repository"));
    }
    git(root, &["rev-parse", "--verify", "-q", &format!("{at}^{{commit}}")], &[], None)
        .map(|s| s.trim().to_string())
        .map_err(|_| format!("{at} is not a changeset in this repository"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    fn repo_with_two_commits() -> (PathBuf, String, String) {
        let dir = std::env::temp_dir().join(format!("visualgit-branch-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&dir).args(args).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.name", "Test"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "commit.gpgsign", "false"]);
        run(&["commit", "-q", "--allow-empty", "-m", "one"]);
        let first = run(&["rev-parse", "HEAD"]);
        run(&["commit", "-q", "--allow-empty", "-m", "two"]);
        let second = run(&["rev-parse", "HEAD"]);
        (crate::os::canonical(&dir).unwrap(), first, second)
    }

    #[test]
    fn creates_and_optionally_switches() {
        let (dir, first, _) = repo_with_two_commits();
        let repo = dir.to_string_lossy().into_owned();
        let head = |d: &PathBuf| git(d, &["symbolic-ref", "--short", "HEAD"], &[], None).unwrap().trim().to_string();

        let c = create(&repo, "feature/x", &first, false).unwrap();
        assert!(!c.switched);
        assert_eq!(git(&dir, &["rev-parse", "feature/x"], &[], None).unwrap().trim(), first);
        assert_eq!(head(&dir), "main");

        let c = create(&repo, "  fix  ", &first, true).unwrap();
        assert!(c.switched);
        assert_eq!(head(&dir), "fix");

        assert!(create(&repo, "fix", &first, false).unwrap_err().contains("already exists"));
        assert!(create(&repo, "has space", &first, false).is_err());
        assert!(create(&repo, "-f", &first, false).is_err());
        assert!(create(&repo, "a..b", &first, false).is_err());
        assert!(create(&repo, "", &first, false).is_err());
        assert!(create(&repo, "ok", "HEAD~1", false).is_err()); // ids only, no revision syntax
        assert!(create(&repo, "ok", "deadbeef", false).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn switches_to_a_branch_or_detaches() {
        let (dir, first, second) = repo_with_two_commits();
        let repo = dir.to_string_lossy().into_owned();
        let head = || git(&dir, &["rev-parse", "HEAD"], &[], None).unwrap().trim().to_string();

        assert!(switch(&repo, &first, None).unwrap().message.contains("detached"));
        assert_eq!(head(), first);
        assert!(git(&dir, &["symbolic-ref", "-q", "HEAD"], &[], None).is_err());

        assert_eq!(switch(&repo, &second[..10], Some("main")).unwrap().message, "Switched to main");
        assert_eq!(git(&dir, &["symbolic-ref", "--short", "HEAD"], &[], None).unwrap().trim(), "main");

        assert!(switch(&repo, &first, Some("main")).unwrap_err().contains("does not point"));
        assert!(switch(&repo, &first, Some("nope")).is_err());
        assert!(switch(&repo, "HEAD~1", None).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tracks_a_remote_only_branch() {
        let (dir, first, _) = repo_with_two_commits();
        let repo = dir.to_string_lossy().into_owned();
        // Fake a fetched remote branch (tracking needs the remote to be configured).
        git(&dir, &["remote", "add", "origin", "https://example.invalid/repo.git"], &[], None).unwrap();
        git(&dir, &["update-ref", "refs/remotes/origin/topic", &first], &[], None).unwrap();
        assert_eq!(track(&repo, "refs/remotes/origin/topic").unwrap().message, "Switched to topic, a new local branch tracking origin/topic");
        assert_eq!(git(&dir, &["symbolic-ref", "--short", "HEAD"], &[], None).unwrap().trim(), "topic");
        assert_eq!(git(&dir, &["rev-parse", "--abbrev-ref", "@{u}"], &[], None).unwrap().trim(), "origin/topic");
        assert!(track(&repo, "refs/remotes/origin/topic").unwrap_err().contains("already exists"));
        assert!(track(&repo, "refs/remotes/origin/missing").is_err());
        assert!(track(&repo, "refs/heads/main").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
