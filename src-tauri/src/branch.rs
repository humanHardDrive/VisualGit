//! Creating branches from the explorer.

use crate::pending::{git, repo_root};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    /// Whether the new branch is now checked out.
    switched: bool,
    /// Why switching failed, when it was asked for and didn't happen. The branch exists either way.
    switch_error: Option<String>,
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
    if !at.chars().all(|c| c.is_ascii_hexdigit()) || git(&root, &["rev-parse", "--verify", "-q", &format!("{at}^{{commit}}")], &[], None).is_err() {
        return Err(format!("{at} is not a changeset in this repository"));
    }
    git(&root, &["branch", "--no-track", name, at], &[], None)?;
    if !switch_to {
        return Ok(Created { switched: false, switch_error: None });
    }
    // Uncommitted changes come along; git refuses only if they would be overwritten.
    match git(&root, &["switch", name], &[], None) {
        Ok(_) => Ok(Created { switched: true, switch_error: None }),
        Err(e) => Ok(Created { switched: false, switch_error: Some(e) }),
    }
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
        (dir.canonicalize().unwrap(), first, second)
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
}
