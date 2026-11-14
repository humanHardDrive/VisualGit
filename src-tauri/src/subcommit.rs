//! Committing changes made inside a submodule from the containing repository's
//! Pending Changes, the way Plastic's writable Xlinks work: the submodule's
//! changes go on a branch of its own, named after the containing repository's,
//! and the containing repository's commit records the new changeset.
//!
//! Which branch the submodule's commit goes on:
//! - A submodule checked out on a branch (someone chose it) commits there.
//! - A detached one (the usual state: checked out at the changeset recorded
//!   for it) gets a branch named after the containing repository's, created
//!   at that changeset, or the existing one if it's already there. That
//!   branch is recorded in `.gitmodules` (`submodule.<name>.branch`), so the
//!   containing branch says which submodule branch it created; it's a
//!   standard git setting, versioned with the branch.
//!
//! Everything is plain git: a branch and a commit in the submodule, then a
//! commit in the containing repository.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::pending::{commit, commit_and_follow, git, repo_root, Committed};
use crate::submodule::submodule_name;

/// Which branch a submodule's changes would be committed on.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubmodulePlan {
    /// The submodule's folder, relative to the containing repository.
    pub path: String,
    /// The branch the commit goes on, when it can be committed.
    pub branch: Option<String>,
    /// The branch doesn't exist yet: committing creates it.
    pub creates: bool,
    /// The branch is named after the containing repository's and is recorded in `.gitmodules`.
    pub follows: bool,
    /// Why the changes can't be committed from here, if they can't.
    pub problem: Option<String>,
}

fn current_branch(dir: &Path) -> Option<String> {
    git(dir, &["symbolic-ref", "-q", "--short", "HEAD"], &[], None).ok().map(|s| s.trim().to_string())
}

fn rev(dir: &Path, r: &str) -> Option<String> {
    git(dir, &["rev-parse", "--verify", "-q", &format!("{r}^{{commit}}")], &[], None).ok().map(|s| s.trim().to_string())
}

/// Works out where the changes inside the submodule at `path` would be committed.
pub(crate) fn plan(root: &Path, path: &str) -> SubmodulePlan {
    let mut p = SubmodulePlan { path: path.into(), branch: None, creates: false, follows: false, problem: None };
    let dir = root.join(path);
    if submodule_name(root, path).is_none() || !dir.join(".git").exists() {
        p.problem = Some(format!("{path} isn't a checked-out submodule."));
        return p;
    }
    let containing = current_branch(root);
    // On a branch already: that's where the changes go. It follows the containing
    // repository's branch if it's named after it; otherwise someone chose it.
    if let Some(b) = current_branch(&dir) {
        p.follows = containing.as_deref() == Some(b.as_str());
        p.branch = Some(b);
        return p;
    }
    let Some(branch) = containing else {
        p.problem = Some(format!("This repository's HEAD is detached, so there's no branch to name {path}'s branch after. Switch to a branch first."));
        return p;
    };
    let Some(head) = rev(&dir, "HEAD") else {
        p.problem = Some(format!("{path} has no changeset checked out."));
        return p;
    };
    let short = |h: &str| h.chars().take(8).collect::<String>();
    match rev(&dir, &format!("refs/heads/{branch}")) {
        Some(at) if at == head => {}
        Some(at) => {
            p.problem = Some(format!(
                "{path} already has a branch {branch}, at another changeset ({}) than the one checked out ({}). Open {path} as a repository to choose where its changes go.",
                short(&at),
                short(&head)
            ));
            return p;
        }
        None => {
            // Someone else may have made it already, on the submodule's remote.
            let remotes = git(&dir, &["for-each-ref", "--format=%(refname)", &format!("refs/remotes/*/{branch}")], &[], None).unwrap_or_default();
            if let Some(other) = remotes.lines().find(|r| rev(&dir, r).is_some_and(|at| at != head)) {
                let name = other.trim_start_matches("refs/remotes/");
                p.problem = Some(format!(
                    "{path}'s {name} is at another changeset than the one checked out ({}). Open {path} as a repository to bring its branch up to date first.",
                    short(&head)
                ));
                return p;
            }
            p.creates = true;
        }
    }
    p.branch = Some(branch);
    p.follows = true;
    p
}

/// Where each submodule with changes would commit them; see `plan`.
#[tauri::command]
pub async fn submodule_commit_plans(repo: String, paths: Vec<String>) -> Result<Vec<SubmodulePlan>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = repo_root(&repo)?;
        Ok(paths.iter().map(|p| plan(&root, p)).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Files to commit inside one submodule, relative to it.
#[derive(Debug, Deserialize)]
pub struct SubmoduleFiles {
    pub path: String,
    pub paths: Vec<String>,
}

/// A commit made inside a submodule.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NestedCommit {
    pub path: String,
    pub hash: String,
    pub branch: String,
    pub created: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommittedAll {
    #[serde(flatten)]
    pub committed: Committed,
    /// The submodules' commits, made first.
    pub nested: Vec<NestedCommit>,
}

/// Commits the selected files inside each submodule (see `plan` for the branch), then
/// the containing repository's `paths` with the submodules' new changesets recorded,
/// all with `message`. Nothing is committed if any submodule can't be.
pub(crate) fn commit_all(repo: &str, message: &str, paths: &[String], submodules: &[SubmoduleFiles]) -> Result<CommittedAll, String> {
    let submodules: Vec<&SubmoduleFiles> = submodules.iter().filter(|s| !s.paths.is_empty()).collect();
    if submodules.is_empty() {
        return Ok(CommittedAll { committed: commit_and_follow(repo, message, paths)?, nested: vec![] });
    }
    let root = repo_root(repo)?;
    if message.trim().is_empty() {
        return Err("Enter a commit message".into());
    }
    if ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"].iter().any(|r| git(&root, &["rev-parse", "-q", "--verify", r], &[], None).is_ok()) {
        return Err("Finish the merge in progress first: it's committed whole, so changes inside submodules can't be committed with it.".into());
    }
    let plans: Vec<SubmodulePlan> = submodules.iter().map(|s| plan(&root, &s.path)).collect();
    if let Some(problem) = plans.iter().find_map(|p| p.problem.clone()) {
        return Err(format!("{problem} Nothing was committed."));
    }

    let mut nested = Vec::new();
    let mut app_paths: Vec<String> = paths.to_vec();
    let mut gitmodules = false;
    for (s, p) in submodules.iter().zip(&plans) {
        let dir = root.join(&s.path);
        let branch = p.branch.clone().unwrap_or_default();
        let done = |nested: &[NestedCommit]| {
            if nested.is_empty() {
                "Nothing was committed.".to_string()
            } else {
                format!("Already committed in {}; their changesets are pending changes here.", nested.iter().map(|n| n.path.as_str()).collect::<Vec<_>>().join(", "))
            }
        };
        if p.follows && current_branch(&dir).as_deref() != Some(&branch) {
            // Uncommitted changes come along: the branch is (or starts) at the checked-out changeset.
            let args: &[&str] = if p.creates { &["switch", "--quiet", "--no-track", "-c", &branch] } else { &["switch", "--quiet", &branch] };
            git(&dir, args, &[], None).map_err(|e| format!("Could not put {} on its branch {branch}: {e} {}", s.path, done(&nested)))?;
        }
        let hash = commit(&dir.to_string_lossy(), message, &s.paths).map_err(|e| format!("Could not commit in {}: {e} {}", s.path, done(&nested)))?;
        if p.follows {
            let name = submodule_name(&root, &s.path).unwrap_or_else(|| s.path.clone());
            let key = format!("submodule.{name}.branch");
            let recorded = git(&root, &["config", "-f", ".gitmodules", "--get", &key], &[], None).ok().map(|v| v.trim().to_string());
            if recorded.as_deref() != Some(&branch) {
                git(&root, &["config", "-f", ".gitmodules", &key, &branch], &[], None)?;
                gitmodules = true;
            }
        }
        nested.push(NestedCommit { path: s.path.clone(), hash, branch, created: p.creates });
        app_paths.push(s.path.clone());
    }
    if gitmodules {
        app_paths.push(".gitmodules".into());
    }
    app_paths.sort();
    app_paths.dedup();
    let committed = commit_and_follow(repo, message, &app_paths).map_err(|e| {
        let list = nested.iter().map(|n| n.path.as_str()).collect::<Vec<_>>().join(", ");
        format!("Committed in {list}, but not here: {e} The new changesets are pending changes here, to commit again.")
    })?;
    Ok(CommittedAll { committed, nested })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn changes_inside_a_submodule_go_on_a_branch_named_after_the_containing_one() {
        let tmp = std::env::temp_dir().join(format!("visualgit-subcommit-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let tmp = crate::os::canonical(&tmp).unwrap();
        let (lib_src, app) = (tmp.join("lib"), tmp.join("app"));
        let run = |dir: &Path, args: &[&str]| {
            let out = Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(["-c", "user.name=T", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always"])
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        std::fs::create_dir_all(&lib_src).unwrap();
        run(&lib_src, &["init", "-q", "-b", "main"]);
        std::fs::write(lib_src.join("parse.c"), "one\n").unwrap();
        run(&lib_src, &["add", "."]);
        run(&lib_src, &["commit", "-q", "-m", "lib base"]);
        std::fs::create_dir_all(&app).unwrap();
        run(&app, &["init", "-q", "-b", "main"]);
        run(&app, &["submodule", "add", "-q", lib_src.to_str().unwrap(), "lib"]);
        run(&app, &["commit", "-q", "-m", "app base"]);
        let lib = app.join("lib");
        run(&lib, &["checkout", "-q", "--detach"]);
        let base = run(&lib, &["rev-parse", "HEAD"]);
        let repo = app.to_str().unwrap();

        // On feature-x, editing lib: its changes will go on a new lib branch feature-x.
        run(&app, &["switch", "-q", "-c", "feature-x"]);
        std::fs::write(lib.join("parse.c"), "two\n").unwrap();
        std::fs::write(app.join("main.c"), "app\n").unwrap();
        assert_eq!(
            plan(&app, "lib"),
            SubmodulePlan { path: "lib".into(), branch: Some("feature-x".into()), creates: true, follows: true, problem: None }
        );

        // One commit: lib's on its branch first, then app's, recording it and the branch.
        let done = commit_all(repo, "Faster parsing", &["main.c".into()], &[SubmoduleFiles { path: "lib".into(), paths: vec!["parse.c".into()] }]).unwrap();
        let lib_commit = run(&lib, &["rev-parse", "HEAD"]);
        assert_eq!(done.nested, vec![NestedCommit { path: "lib".into(), hash: lib_commit.clone(), branch: "feature-x".into(), created: true }]);
        assert_eq!(run(&lib, &["symbolic-ref", "--short", "HEAD"]), "feature-x");
        assert_eq!(run(&lib, &["rev-parse", "HEAD^"]), base);
        assert_eq!(run(&lib, &["log", "-1", "--format=%s"]), "Faster parsing");
        assert_eq!(run(&app, &["rev-parse", "HEAD:lib"]), lib_commit);
        assert_eq!(run(&app, &["config", "-f", ".gitmodules", "submodule.lib.branch"]), "feature-x");
        assert_eq!(run(&app, &["show", "--name-only", "--format=", "HEAD"]).lines().collect::<Vec<_>>(), vec![".gitmodules", "lib", "main.c"]);
        assert!(run(&app, &["status", "--porcelain"]).is_empty());

        // Next time lib is already on it; .gitmodules doesn't change again.
        std::fs::write(lib.join("parse.c"), "three\n").unwrap();
        assert_eq!(plan(&app, "lib").creates, false);
        commit_all(repo, "More", &[], &[SubmoduleFiles { path: "lib".into(), paths: vec!["parse.c".into()] }]).unwrap();
        assert_eq!(run(&app, &["show", "--name-only", "--format=", "HEAD"]), "lib");

        // Checked out detached again where its branch is (as switching branches leaves it): it goes back on it.
        run(&lib, &["checkout", "-q", "--detach"]);
        std::fs::write(lib.join("parse.c"), "four\n").unwrap();
        let p = plan(&app, "lib");
        assert_eq!((p.branch.as_deref(), p.creates, p.follows), (Some("feature-x"), false, true));
        commit_all(repo, "Four", &[], &[SubmoduleFiles { path: "lib".into(), paths: vec!["parse.c".into()] }]).unwrap();
        assert_eq!(run(&lib, &["symbolic-ref", "--short", "HEAD"]), "feature-x");

        // Its branch elsewhere: nothing is committed, and it says why.
        run(&lib, &["checkout", "-q", "--detach", &base]);
        std::fs::write(lib.join("parse.c"), "five\n").unwrap();
        let before = run(&app, &["rev-parse", "HEAD"]);
        let err = commit_all(repo, "Five", &[], &[SubmoduleFiles { path: "lib".into(), paths: vec!["parse.c".into()] }]).err().unwrap();
        assert!(err.contains("already has a branch feature-x") && err.contains("Nothing was committed"), "{err}");
        assert_eq!(run(&app, &["rev-parse", "HEAD"]), before);

        // Checked out on a branch someone chose: the changes go there, and .gitmodules is left alone.
        run(&lib, &["switch", "-q", "-c", "chosen"]);
        let p = plan(&app, "lib");
        assert_eq!((p.branch.as_deref(), p.creates, p.follows), (Some("chosen"), false, false));

        // Pushing app before lib is refused: nobody else could get lib's changeset.
        let (lib_remote, app_remote) = (tmp.join("lib-remote.git"), tmp.join("app-remote.git"));
        run(&tmp, &["init", "-q", "--bare", "-b", "main", lib_remote.to_str().unwrap()]);
        run(&tmp, &["init", "-q", "--bare", "-b", "main", app_remote.to_str().unwrap()]);
        run(&lib, &["remote", "set-url", "origin", lib_remote.to_str().unwrap()]);
        run(&lib, &["push", "-q", "origin", &format!("{base}:refs/heads/main")]);
        run(&lib, &["fetch", "-q", "origin"]);
        run(&app, &["remote", "add", "origin", app_remote.to_str().unwrap()]);
        run(&lib, &["checkout", "-q", "--", "parse.c"]);
        run(&lib, &["switch", "-q", "feature-x"]);
        let err = crate::pending::push_branch_now(&app, "feature-x").err().unwrap();
        assert!(err.starts_with("Push lib first"), "{err}");
        assert!(run(&app_remote, &["branch", "--list"]).is_empty(), "nothing was pushed");
        crate::pending::push_branch_now(&lib, "feature-x").unwrap();
        crate::pending::push_branch_now(&app, "feature-x").unwrap();
        run(&lib, &["switch", "-q", "chosen"]);

        // A detached containing repository has no branch to name one after.
        run(&lib, &["checkout", "-q", "--detach"]);
        run(&app, &["checkout", "-q", "--detach"]);
        assert!(plan(&app, "lib").problem.unwrap().contains("detached"));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
