//! Finds the Git repositories inside a workspace folder, and creates new ones there.

use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

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

/// Creates a repository at `name` (a folder path such as `tools/app`)
/// inside the workspace, and returns it as the Workspace view lists it.
/// An existing folder that isn't a repository yet is turned into one, its
/// files left as they are (new, uncommitted). `branch` names the first
/// branch; without it git's `init.defaultBranch` applies. `remote` becomes
/// `origin`, so the first push has somewhere to go.
#[tauri::command]
pub async fn create_repo(workspace: String, name: String, branch: Option<String>, remote: String) -> Result<RepoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create(Path::new(&workspace), &name, branch.as_deref().map(str::trim).filter(|b| !b.is_empty()), remote.trim())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn create(workspace: &Path, name: &str, branch: Option<&str>, remote: &str) -> Result<RepoInfo, String> {
    let root = workspace.canonicalize().map_err(|_| format!("The workspace folder {} doesn't exist", workspace.display()))?;
    let parts = folder_parts(name)?;
    // Checked before anything is created, so a bad remote leaves nothing behind.
    check_remote_url(remote)?;
    // Repositories inside repositories aren't listed (or wanted): check the workspace and every folder on the way.
    let mut dir = root.clone();
    for (i, part) in std::iter::once(None).chain(parts.iter().map(Some)).enumerate() {
        if let Some(part) = part {
            dir.push(part);
        }
        if !dir.exists() {
            break;
        }
        // A symlinked folder could lead out of the workspace.
        if !dir.canonicalize().is_ok_and(|d| d.starts_with(&root)) {
            return Err(format!("{} leads outside the workspace", parts[..i].join("/")));
        }
        if dir.join(".git").exists() {
            let at = if i == 0 { "The workspace folder".to_string() } else { parts[..i].join("/") };
            return Err(if i == parts.len() {
                format!("{at} is already a repository")
            } else {
                format!("{at} is a repository already; a repository can't go inside another one")
            });
        }
    }
    let target = root.join(parts.join("/"));
    if target.exists() && !target.is_dir() {
        return Err(format!("{name} is a file, not a folder"));
    }
    if let Some(b) = branch {
        let ok = Command::new("git").args(["check-ref-format", "--branch", b]).stdin(Stdio::null()).output().is_ok_and(|o| o.status.success());
        if !ok {
            return Err(format!("“{b}” isn't a valid branch name"));
        }
    }
    fs::create_dir_all(&target).map_err(|e| format!("could not create {name}: {e}"))?;
    let mut cmd = Command::new("git");
    cmd.arg("init").arg("-q");
    if let Some(b) = branch {
        cmd.args(["-b", b]);
    }
    let out = cmd.arg("--").arg(&target).stdin(Stdio::null()).env("GIT_TERMINAL_PROMPT", "0").output().map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    crate::pending::git(&target, &["remote", "add", "origin", remote], &[], None)
        .map_err(|e| format!("Created the repository, but could not add the remote: {e}"))?;
    // Listed under the workspace path as given, like the scan does.
    repo_info(workspace, &workspace.join(parts.join("/"))).ok_or_else(|| "git init didn't create a repository".to_string())
}

/// A URL (or path) git can push to. Only the transports people host
/// repositories on: in particular not `ext::`, which runs a command.
pub(crate) fn check_remote_url(url: &str) -> Result<(), String> {
    if url.is_empty() {
        return Err("Enter the remote to push to, e.g. https://github.com/you/my-project.git".into());
    }
    if url.starts_with('-') || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("That isn't a valid remote URL".into());
    }
    if let Some((scheme, rest)) = url.split_once("://") {
        let known = ["https", "http", "ssh", "git", "git+ssh", "ssh+git", "file"];
        if !known.contains(&scheme.to_ascii_lowercase().as_str()) || rest.is_empty() {
            return Err(format!("VisualGit doesn't push to {scheme}:// remotes; use an https:// or SSH URL"));
        }
        return Ok(());
    }
    if url.contains("::") {
        return Err("That isn't a valid remote URL".into());
    }
    // scp-like `git@host:owner/repo.git`, or a path to a repository on this machine or a network drive.
    let scp_like = url.split_once(':').is_some_and(|(host, path)| host.len() > 1 && !host.contains('/') && !path.is_empty());
    if scp_like || Path::new(url).is_absolute() {
        Ok(())
    } else {
        Err("Enter a full URL, such as https://github.com/you/my-project.git or git@github.com:you/my-project.git".into())
    }
}

/// `name` as folder names, refusing anything the workspace scan wouldn't find.
fn folder_parts(name: &str) -> Result<Vec<String>, String> {
    let name = name.trim().trim_end_matches('/');
    if name.is_empty() {
        return Err("Enter a name for the repository".into());
    }
    if name.contains('\\') || name.contains('\0') {
        return Err("Use / to separate folders".into());
    }
    let mut parts = Vec::new();
    for c in Path::new(name).components() {
        let Component::Normal(part) = c else {
            return Err("The repository must be a folder inside the workspace".into());
        };
        let part = part.to_string_lossy().into_owned();
        if part.starts_with('.') {
            return Err(format!("“{part}”: folder names starting with . are hidden, so the workspace wouldn't list the repository"));
        }
        if SKIP.contains(&part.as_str()) {
            return Err(format!("“{part}” folders are skipped when looking for repositories; choose another name"));
        }
        parts.push(part);
    }
    if parts.len() > MAX_DEPTH {
        return Err(format!("Too deep: the workspace only looks {MAX_DEPTH} folders down for repositories"));
    }
    Ok(parts)
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

    #[test]
    fn creates_repositories_only_where_the_scan_finds_them() {
        let tmp = temp_root();
        let root = &tmp.0;
        let made = create(root, "tools/app", Some("trunk"), "git@github.com:me/app.git").unwrap();
        assert_eq!((made.name.as_str(), made.head.as_deref(), made.detached), ("tools/app", Some("trunk"), false));
        let url = Command::new("git").arg("-C").arg(root.join("tools/app")).args(["remote", "get-url", "origin"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&url.stdout).trim(), "git@github.com:me/app.git");
        assert_eq!(made.path, root.join("tools/app").to_string_lossy());
        assert!(find_repos(root, MAX_DEPTH).contains(&made));

        // An existing folder of files becomes a repository; its files stay.
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/todo.txt"), "x").unwrap();
        create(root, "notes/", None, "https://gitlab.com/me/notes.git").unwrap();
        assert!(root.join("notes/.git").is_dir() && root.join("notes/todo.txt").exists());

        for (name, why) in [
            ("tools/app", "already a repository"),
            ("tools/app/inner", "inside another"),
            ("../escape", "inside the workspace"),
            ("/abs", "inside the workspace"),
            ("a/.hidden", "hidden"),
            ("node_modules/x", "skipped"),
            ("a/b/c/d/e", "Too deep"),
            ("  ", "Enter a name"),
        ] {
            let err = create(root, name, None, "https://github.com/me/x.git").unwrap_err();
            assert!(err.contains(why), "{name}: {err}");
        }
        assert!(create(root, "bad-branch", Some("no spaces"), "https://github.com/me/x.git").unwrap_err().contains("valid branch name"));
        // The remote is checked first: nothing is created for a bad one.
        for bad in ["", "ext::sh -c touch% /tmp/x", "-uhttps://x", "https://github.com/a b", "my-project", "ftp://host/x"] {
            assert!(create(root, "bad-remote", None, bad).is_err(), "{bad}");
        }
        assert!(!root.join("bad-remote").exists());
        assert!(!root.join("bad-branch").exists(), "nothing is created for a bad branch name");
        fs::write(root.join("file"), "").unwrap();
        assert!(create(root, "file", None, "https://github.com/me/x.git").unwrap_err().contains("is a file"));
    }
}
