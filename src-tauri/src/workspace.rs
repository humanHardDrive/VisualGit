//! Finds the Git repositories inside a workspace folder.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Absolute path of the working tree.
    pub path: String,
    /// Path relative to the workspace root (`group/repo`), or the folder name.
    pub name: String,
    /// Checked-out branch, or the short commit hash when detached.
    pub head: Option<String>,
    pub detached: bool,
}

/// How many folder levels below the workspace root to look for repositories.
pub const MAX_DEPTH: usize = 4;
const MAX_REPOS: usize = 1000;
/// Folders that never contain repositories worth listing and can be huge.
const SKIP: &[&str] = &[
    "node_modules", "target", "vendor", "dist", "build", "Pods", "DerivedData", "__pycache__", "venv",
];

/// Lists repositories under `root`, sorted by name. A repository's own
/// subfolders (submodules, nested checkouts) are not searched.
pub fn find_repos(root: &Path, max_depth: usize) -> Vec<RepoInfo> {
    let mut out = Vec::new();
    walk(root, root, 0, max_depth, &mut out);
    out.sort_by_key(|r| r.name.to_lowercase());
    out
}

fn walk(root: &Path, dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<RepoInfo>) {
    if out.len() >= MAX_REPOS {
        return;
    }
    if let Some(info) = repo_info(root, dir) {
        out.push(info);
        return;
    }
    if depth >= max_depth {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        // `file_type` does not follow symlinks, so symlink loops can't trap the scan.
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            !name.starts_with('.') && !SKIP.contains(&name.as_ref())
        })
        .map(|e| e.path())
        .collect();
    dirs.sort();
    for d in dirs {
        walk(root, &d, depth + 1, max_depth, out);
    }
}

fn repo_info(root: &Path, dir: &Path) -> Option<RepoInfo> {
    let dotgit = dir.join(".git");
    let git_dir = if dotgit.is_dir() {
        dotgit
    } else if dotgit.is_file() {
        // Linked worktree or submodule checkout: `.git` is a file pointing at the real git dir.
        let text = fs::read_to_string(&dotgit).ok()?;
        let target = Path::new(text.strip_prefix("gitdir:")?.trim());
        if target.is_absolute() { target.to_path_buf() } else { dir.join(target) }
    } else {
        return None;
    };
    let head = fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();
    let (head, detached) = match head.strip_prefix("ref: ") {
        Some(r) => (r.strip_prefix("refs/heads/").unwrap_or(r).to_string(), false),
        None => (head.chars().take(8).collect(), true),
    };
    let name = dir
        .strip_prefix(root)
        .ok()
        .filter(|p| !p.as_os_str().is_empty())
        .or_else(|| dir.file_name().map(Path::new))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| dir.to_string_lossy().into_owned());
    Some(RepoInfo { path: dir.to_string_lossy().into_owned(), name, head: Some(head), detached })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A fresh folder per call. Tests run in parallel and the clock only ticks
    /// in microseconds on macOS, so a timestamp alone let two tests share (and
    /// delete) one folder; the counter keeps every name distinct.
    fn temp_root() -> TempDir {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("visualgit-scan-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }

    fn fake_repo(dir: &Path, head: &str) {
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git/HEAD"), head).unwrap();
    }

    #[test]
    fn finds_repos_and_skips_noise() {
        let tmp = temp_root();
        let root = &tmp.0;
        fake_repo(&root.join("app"), "ref: refs/heads/main\n");
        fake_repo(&root.join("app/nested"), "ref: refs/heads/x\n"); // inside a repo: not listed
        fake_repo(&root.join("clients/Zeta"), "0123456789abcdef0123456789abcdef01234567\n");
        fake_repo(&root.join("node_modules/pkg"), "ref: refs/heads/main\n");
        fake_repo(&root.join(".cache/thing"), "ref: refs/heads/main\n");
        fake_repo(&root.join("a/b/c/d/e/too-deep"), "ref: refs/heads/main\n");
        fs::create_dir_all(root.join("not-a-repo/src")).unwrap();
        // A linked worktree whose .git file points into app's git dir.
        fs::create_dir_all(root.join("app/.git/worktrees/wt")).unwrap();
        fs::write(root.join("app/.git/worktrees/wt/HEAD"), "ref: refs/heads/feature/wt\n").unwrap();
        fs::create_dir_all(root.join("wt")).unwrap();
        fs::write(root.join("wt/.git"), "gitdir: ../app/.git/worktrees/wt\n").unwrap();

        let repos = find_repos(root, MAX_DEPTH);
        let summary: Vec<(&str, &str, bool)> =
            repos.iter().map(|r| (r.name.as_str(), r.head.as_deref().unwrap(), r.detached)).collect();
        assert_eq!(
            summary,
            vec![("app", "main", false), ("clients/Zeta", "01234567", true), ("wt", "feature/wt", false)]
        );
    }

    #[test]
    fn workspace_that_is_itself_a_repo() {
        let tmp = temp_root();
        fake_repo(&tmp.0, "ref: refs/heads/main\n");
        let repos = find_repos(&tmp.0, MAX_DEPTH);
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].path, tmp.0.to_string_lossy());
    }
}
