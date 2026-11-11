//! Finds the Git repositories inside a workspace folder, and creates new ones there.

use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::SystemTime;

use crate::hosting::{remote_of, Remote};

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
    /// The remote it pushes to (see `hosting::remote_of`), if any.
    pub remote: Option<Remote>,
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
    add_remotes(&mut out);
    out
}

/// Remotes already looked up, by repository: kept while its config file is unchanged.
static REMOTES: Mutex<Option<HashMap<PathBuf, (Option<SystemTime>, Option<Remote>)>>> = Mutex::new(None);

/// When the repository's config file (where remotes live) last changed.
/// A linked worktree's config is in the main repository's git directory.
fn config_time(dir: &Path) -> Option<SystemTime> {
    let dotgit = dir.join(".git");
    let git_dir = if dotgit.is_file() {
        let text = fs::read_to_string(&dotgit).ok()?;
        let target = PathBuf::from(text.strip_prefix("gitdir:")?.trim());
        let git_dir = if target.is_absolute() { target } else { dir.join(target) };
        match fs::read_to_string(git_dir.join("commondir")) {
            Ok(common) => git_dir.join(common.trim()),
            Err(_) => git_dir,
        }
    } else {
        dotgit
    };
    fs::metadata(git_dir.join("config")).and_then(|m| m.modified()).ok()
}

/// Fills in each repository's remote. Looking one up takes a git process, so
/// the answers are kept until the repository's config changes (rescans happen
/// on every reload), and new lookups run a few at a time.
fn add_remotes(repos: &mut [RepoInfo]) {
    let mut cache = REMOTES.lock().unwrap_or_else(|e| e.into_inner());
    let cache = cache.get_or_insert_with(HashMap::new);
    let mut todo: Vec<(&mut RepoInfo, Option<SystemTime>)> = Vec::new();
    for r in repos.iter_mut() {
        let time = config_time(Path::new(&r.path));
        match cache.get(Path::new(&r.path)) {
            Some((t, remote)) if time.is_some() && *t == time => r.remote = remote.clone(),
            _ => todo.push((r, time)),
        }
    }
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    let chunk = todo.len().div_ceil(threads).max(1);
    std::thread::scope(|s| {
        for part in todo.chunks_mut(chunk) {
            s.spawn(move || {
                for (r, _) in part {
                    r.remote = remote_of(Path::new(&r.path));
                }
            });
        }
    });
    for (r, time) in todo {
        cache.insert(PathBuf::from(&r.path), (time, r.remote.clone()));
    }
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
    Some(RepoInfo { path: dir.to_string_lossy().into_owned(), name, head: Some(head), detached, remote: None })
}

/// Creates a repository at `name` (a folder path such as `tools/app`)
/// inside the workspace, and returns it as the Workspace view lists it.
/// An existing folder that isn't a repository yet is turned into one, its
/// files left as they are (new, uncommitted). `branch` names the first
/// branch; without it git's `init.defaultBranch` applies. `remote`, if
/// given, becomes `origin`, so the first push has somewhere to go.
#[tauri::command]
pub async fn create_repo(workspace: String, name: String, branch: Option<String>, remote: Option<String>) -> Result<RepoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed = |s: Option<String>| s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        create(Path::new(&workspace), &name, trimmed(branch).as_deref(), trimmed(remote).as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Where a new repository named `name` goes in the workspace: (the folder
/// names, the folder). Refuses places the workspace scan wouldn't find it,
/// a repository inside another one, and folders leading outside the
/// workspace. The folder may already exist.
fn new_repo_location(workspace: &Path, name: &str) -> Result<(Vec<String>, PathBuf), String> {
    let root = workspace.canonicalize().map_err(|_| format!("The workspace folder {} doesn't exist", workspace.display()))?;
    let parts = folder_parts(name)?;
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
    Ok((parts, target))
}

/// The new repository as the Workspace view lists it: under the workspace
/// path as given, like the scan does.
fn listed(workspace: &Path, parts: &[String], target: &Path) -> Result<RepoInfo, String> {
    let mut made = repo_info(workspace, &workspace.join(parts.join("/"))).ok_or_else(|| "git didn't create a repository".to_string())?;
    made.remote = remote_of(target);
    Ok(made)
}

fn create(workspace: &Path, name: &str, branch: Option<&str>, remote: Option<&str>) -> Result<RepoInfo, String> {
    let (parts, target) = new_repo_location(workspace, name)?;
    // Checked before anything is created, so a bad remote leaves nothing behind.
    if let Some(remote) = remote {
        check_remote_url(remote)?;
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
    if let Some(remote) = remote {
        crate::pending::git(&target, &["remote", "add", "origin", remote], &[], None)
            .map_err(|e| format!("Created the repository, but could not add the remote: {e}"))?;
    }
    listed(workspace, &parts, &target)
}

/// Clones `url` into the workspace as `name` (`git clone`), sending git's
/// progress lines ("Receiving objects:  45% …") to the window as it goes.
#[tauri::command]
pub async fn clone_repo(window: tauri::Window, workspace: String, url: String, name: String) -> Result<RepoInfo, String> {
    use tauri::Emitter;
    tauri::async_runtime::spawn_blocking(move || {
        clone(Path::new(&workspace), url.trim(), &name, &|line| {
            let _ = window.emit("clone-progress", line);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn clone(workspace: &Path, url: &str, name: &str, progress: &dyn Fn(&str)) -> Result<RepoInfo, String> {
    check_remote_url(url).map_err(|e| e.replace("the remote to push to", "the URL of the repository to clone"))?;
    let (parts, target) = new_repo_location(workspace, name)?;
    // git clones into a new or empty folder only.
    if target.read_dir().is_ok_and(|mut d| d.next().is_some()) {
        return Err(format!("{name} already exists and isn't empty; choose another name"));
    }
    clone_with_progress(url, &target, &[], progress)?;
    listed(workspace, &parts, &target)
}

/// `git clone [extra] -- url target`, passing git's progress lines to
/// `progress` as they come. On failure, says why in git's words.
pub(crate) fn clone_with_progress(url: &str, target: &Path, extra: &[&str], progress: &dyn Fn(&str)) -> Result<(), String> {
    use std::io::Read;
    let mut child = Command::new("git")
        .args(["clone", "--progress"])
        .args(extra)
        .args(["--", url])
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        // No terminal to ask for a password on: credentials come from a credential helper or SSH agent.
        .env("GIT_TERMINAL_PROMPT", "0")
        .spawn()
        .map_err(|e| format!("failed to run git: {e}"))?;
    // Progress lines end in \r (redrawn in place) or \n; keep the last few for an error message.
    let mut stderr = child.stderr.take().ok_or("no output from git")?;
    let (mut line, mut recent) = (Vec::new(), Vec::<String>::new());
    let mut buf = [0u8; 4096];
    loop {
        let n = stderr.read(&mut buf).unwrap_or(0);
        if n == 0 {
            break;
        }
        for &b in &buf[..n] {
            if b == b'\r' || b == b'\n' {
                let text = String::from_utf8_lossy(&line).trim().to_string();
                line.clear();
                if text.is_empty() {
                    continue;
                }
                progress(&text);
                if b == b'\n' {
                    recent.push(text);
                    if recent.len() > 8 {
                        recent.remove(0);
                    }
                }
            } else {
                line.push(b);
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        // git removes a folder it created for a failed clone; say why it failed.
        let why: Vec<&String> = recent.iter().filter(|l| l.starts_with("fatal:") || l.starts_with("remote:") || l.starts_with("ERROR")).collect();
        let text = if why.is_empty() { recent.join("\n") } else { why.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n") };
        return Err(if text.is_empty() { "git clone failed".to_string() } else { text });
    }
    Ok(())
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
        let made = create(root, "tools/app", Some("trunk"), Some("git@github.com:me/app.git")).unwrap();
        assert_eq!((made.name.as_str(), made.head.as_deref(), made.detached), ("tools/app", Some("trunk"), false));
        let url = Command::new("git").arg("-C").arg(root.join("tools/app")).args(["remote", "get-url", "origin"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&url.stdout).trim(), "git@github.com:me/app.git");
        assert_eq!(made.path, root.join("tools/app").to_string_lossy());
        assert!(find_repos(root, MAX_DEPTH).contains(&made));

        // An existing folder of files becomes a repository; its files stay.
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/todo.txt"), "x").unwrap();
        create(root, "notes/", None, None).unwrap();
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
            let err = create(root, name, None, None).unwrap_err();
            assert!(err.contains(why), "{name}: {err}");
        }
        assert!(create(root, "bad-branch", Some("no spaces"), None).unwrap_err().contains("valid branch name"));
        // The remote is checked first: nothing is created for a bad one.
        for bad in ["ext::sh -c touch% /tmp/x", "ext::sh", "-uhttps://x", "https://github.com/a b", "my-project", "ftp://host/x"] {
            assert!(create(root, "bad-remote", None, Some(bad)).is_err(), "{bad}");
        }
        assert!(!root.join("bad-remote").exists());
        assert!(!root.join("bad-branch").exists(), "nothing is created for a bad branch name");
        fs::write(root.join("file"), "").unwrap();
        assert!(create(root, "file", None, None).unwrap_err().contains("is a file"));
    }

    #[test]
    fn clones_into_the_workspace_with_progress() {
        let tmp = temp_root();
        let root = &tmp.0;
        // Something to clone: a repository with one commit, outside the workspace's scan.
        let source = root.join(".source");
        let run = |dir: &Path, args: &[&str]| assert!(Command::new("git").arg("-C").arg(dir).args(args).status().unwrap().success());
        fs::create_dir_all(&source).unwrap();
        run(&source, &["init", "-q", "-b", "main"]);
        fs::write(source.join("a.txt"), "a").unwrap();
        run(&source, &["add", "."]);
        run(&source, &["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-q", "-m", "one"]);
        let url = source.canonicalize().unwrap().to_string_lossy().into_owned();

        let lines = std::cell::RefCell::new(Vec::new());
        let made = clone(root, &url, "copies/app", &|l| lines.borrow_mut().push(l.to_string())).unwrap();
        assert_eq!((made.name.as_str(), made.head.as_deref()), ("copies/app", Some("main")));
        assert!(root.join("copies/app/a.txt").exists());
        assert_eq!(made.remote.as_ref().map(|r| r.name.as_str()), Some("origin"));
        assert!(lines.borrow().iter().any(|l| l.starts_with("Cloning into")), "{:?}", lines.borrow());

        // Not over an existing repository or a folder with files; a failed clone leaves nothing.
        assert!(clone(root, &url, "copies/app", &|_| {}).unwrap_err().contains("already a repository"));
        fs::create_dir_all(root.join("full")).unwrap();
        fs::write(root.join("full/x"), "").unwrap();
        assert!(clone(root, &url, "full", &|_| {}).unwrap_err().contains("isn't empty"));
        assert!(clone(root, "ext::sh -c x", "evil", &|_| {}).is_err());
        assert!(clone(root, &format!("{url}-missing"), "missing", &|_| {}).is_err());
        assert!(!root.join("missing").exists());
    }
}
