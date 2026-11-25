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
/// `from`: the branch whose lane the changeset is on. Its name goes in the new branch's reflog
/// ("branch: Created from 1.0", as `git branch new 1.0` writes), so the Branch Explorer keeps the
/// shared history on that branch even when `at` is one of its older changesets.
#[tauri::command]
pub async fn create_branch(repo: String, name: String, at: String, switch_to: bool, from: Option<String>) -> Result<Created, String> {
    tauri::async_runtime::spawn_blocking(move || create(&repo, &name, &at, switch_to, from.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

fn create(repo: &str, name: &str, at: &str, switch_to: bool, from: Option<&str>) -> Result<Created, String> {
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
    let full = commit_id(&root, at)?;
    let from = from.filter(|f| !f.starts_with('-') && git(&root, &["rev-parse", "--verify", "-q", &format!("refs/heads/{f}")], &[], None).is_ok());
    match from {
        // The empty old value makes git refuse if the branch appeared meanwhile.
        Some(f) => git(&root, &["update-ref", "--create-reflog", "-m", &format!("branch: Created from {f}"), &format!("refs/heads/{name}"), &full, ""], &[], None)?,
        None => git(&root, &["branch", "--no-track", name, at], &[], None)?,
    };
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
        let tip = tip.trim();
        if b.starts_with('-') {
            return Err(format!("{b} is not a local branch"));
        }
        if tip == full {
            git(&root, &["switch", b], &[], None)?;
            return Ok(Switched::after(&root, format!("Switched to {b}")));
        }
        let Some(remote) = catch_up_from(&root, b, tip, &full) else { return Err(format!("{b} does not point at {short}")) };
        return catch_up(&root, b, tip, &full, &remote);
    }
    git(&root, &["switch", "--detach", &full], &[], None)?;
    Ok(Switched::after(&root, format!("Switched to changeset {short} (detached HEAD). Create a branch here before committing")))
}

/// The remote branch ("origin/1.0") that `branch` can be brought up along to changeset `to`:
/// the branch has nothing of its own past `tip` (its tip is in `to`'s history), and `to` is
/// on the branch's own remote branch (its upstream, or the same-named one). None otherwise.
fn catch_up_from(root: &std::path::Path, branch: &str, tip: &str, to: &str) -> Option<String> {
    git(root, &["merge-base", "--is-ancestor", tip, to], &[], None).ok()?;
    let own: Vec<String> = match crate::merge::upstream(root, branch) {
        Some((tracking, _)) => vec![tracking],
        None => git(root, &["for-each-ref", "--format=%(refname)", &format!("refs/remotes/*/{branch}")], &[], None).ok()?.lines().map(str::to_string).collect(),
    };
    let containing = git(root, &["for-each-ref", "--format=%(refname)", "--contains", to, "refs/remotes"], &[], None).ok()?;
    let found = own.iter().find(|r| containing.lines().any(|c| c == r.as_str()))?;
    Some(found.trim_start_matches("refs/remotes/").to_string())
}

/// Brings `branch` (at `tip`) forward to `to` along its remote branch and switches to it. It only
/// moves the branch along changesets it doesn't have yet, so nothing is merged and no merge
/// changeset is made. If the switch can't happen (uncommitted changes in the way), the branch
/// stays where it was.
fn catch_up(root: &std::path::Path, branch: &str, tip: &str, to: &str, remote: &str) -> Result<Switched, String> {
    let n: usize = git(root, &["rev-list", "--count", &format!("{tip}..{to}")], &[], None)?.trim().parse().unwrap_or(0);
    let what = format!("{n} changeset{} from {remote}", if n == 1 { "" } else { "s" });
    let on_it = git(root, &["symbolic-ref", "-q", "--short", "HEAD"], &[], None).is_ok_and(|h| h.trim() == branch);
    if on_it {
        git(root, &["merge", "--ff-only", "--quiet", to], &[], None).map_err(|e| format!("Could not bring {branch} up to {}: {e}", &to[..8]))?;
    } else {
        git(root, &["branch", "--force", branch, to], &[], None)?;
        if let Err(e) = git(root, &["switch", branch], &[], None) {
            let _ = git(root, &["branch", "--force", branch, tip], &[], None);
            return Err(e);
        }
    }
    Ok(Switched::after(root, format!("Switched to {branch}, brought up to date with {what}")))
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

        let c = create(&repo, "feature/x", &first, false, None).unwrap();
        assert!(!c.switched);
        assert_eq!(git(&dir, &["rev-parse", "feature/x"], &[], None).unwrap().trim(), first);
        assert_eq!(head(&dir), "main");

        let c = create(&repo, "  fix  ", &first, true, None).unwrap();
        assert!(c.switched);
        assert_eq!(head(&dir), "fix");

        assert!(create(&repo, "fix", &first, false, None).unwrap_err().contains("already exists"));
        assert!(create(&repo, "has space", &first, false, None).is_err());
        assert!(create(&repo, "-f", &first, false, None).is_err());
        assert!(create(&repo, "a..b", &first, false, None).is_err());
        assert!(create(&repo, "", &first, false, None).is_err());
        assert!(create(&repo, "ok", "HEAD~1", false, None).is_err()); // ids only, no revision syntax
        assert!(create(&repo, "ok", "deadbeef", false, None).is_err());

        // Named after the lane it was made on, in git's own words, even from an older changeset.
        create(&repo, "from-lane", &first, false, Some("main")).unwrap();
        let log = git(&dir, &["reflog", "show", "--format=%gs", "refs/heads/from-lane"], &[], None).unwrap();
        assert_eq!(log.trim(), "branch: Created from main");
        assert_eq!(git(&dir, &["rev-parse", "from-lane"], &[], None).unwrap().trim(), first);
        assert!(create(&repo, "from-lane", &first, false, Some("main")).unwrap_err().contains("already exists"));
        // Not a branch: the changeset id, as before.
        create(&repo, "from-id", &first, false, Some("nope")).unwrap();
        let log = git(&dir, &["reflog", "show", "--format=%gs", "refs/heads/from-id"], &[], None).unwrap();
        assert!(log.trim().starts_with("branch: Created from "), "{log}");
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
    fn switching_further_along_its_remote_branch_brings_a_branch_up_to_date() {
        let (dir, first, second) = repo_with_two_commits();
        let repo = dir.to_string_lossy().into_owned();
        let g = |args: &[&str]| git(&dir, args, &[], None).unwrap().trim().to_string();
        // As after a fetch: origin/main has moved on to `second`, local main is still at `first`.
        g(&["remote", "add", "origin", "https://example.invalid/repo.git"]);
        g(&["update-ref", "refs/remotes/origin/main", &second]);
        g(&["config", "branch.main.remote", "origin"]);
        g(&["config", "branch.main.merge", "refs/heads/main"]);
        g(&["switch", "-q", "--detach", &first]);
        g(&["branch", "--force", "main", &first]);

        // From elsewhere: main moves up and is checked out; no merge changeset.
        let s = switch(&repo, &second, Some("main")).unwrap();
        assert_eq!(s.message, "Switched to main, brought up to date with 1 changeset from origin/main");
        assert_eq!(g(&["symbolic-ref", "--short", "HEAD"]), "main");
        assert_eq!(g(&["rev-parse", "main"]), second);

        // While on it.
        g(&["reset", "-q", "--keep", &first]);
        switch(&repo, &second, Some("main")).unwrap();
        assert_eq!(g(&["rev-parse", "HEAD"]), second);

        // Not on its remote branch: refused, as before.
        g(&["commit", "-q", "--allow-empty", "-m", "three"]);
        let third = g(&["rev-parse", "HEAD"]);
        g(&["reset", "-q", "--keep", &second]);
        assert!(switch(&repo, &third, Some("main")).unwrap_err().contains("does not point"));

        // The branch has a changeset of its own: that's a merge, not this.
        g(&["update-ref", "refs/remotes/origin/main", &third]);
        g(&["commit", "-q", "--allow-empty", "-m", "mine"]);
        assert!(switch(&repo, &third, Some("main")).unwrap_err().contains("does not point"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_branch_stays_put_when_uncommitted_changes_stop_the_switch() {
        let (dir, _, second) = repo_with_two_commits();
        let repo = dir.to_string_lossy().into_owned();
        let g = |args: &[&str]| git(&dir, args, &[], None).unwrap().trim().to_string();
        std::fs::write(dir.join("f.txt"), "one\n").unwrap();
        g(&["add", "f.txt"]);
        g(&["commit", "-q", "-m", "f"]);
        let tip = g(&["rev-parse", "HEAD"]);
        std::fs::write(dir.join("f.txt"), "two\n").unwrap();
        g(&["commit", "-q", "-am", "f two"]);
        let newer = g(&["rev-parse", "HEAD"]);
        g(&["remote", "add", "origin", "https://example.invalid/repo.git"]);
        g(&["update-ref", "refs/remotes/origin/main", &newer]);
        g(&["branch", "--force", "other", &second]);
        g(&["switch", "-q", "other"]);
        g(&["branch", "--force", "main", &tip]);
        std::fs::write(dir.join("f.txt"), "edited\n").unwrap();
        assert!(switch(&repo, &newer, Some("main")).is_err());
        assert_eq!(g(&["rev-parse", "main"]), tip);
        assert_eq!(g(&["symbolic-ref", "--short", "HEAD"]), "other");
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
