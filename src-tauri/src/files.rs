//! Commands behind the Files view's right-click menu: opening a file,
//! ignoring it, and removing it from source control (and disk).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::os::{self, OpenError, TRASH};
use crate::pending::{git, repo_root, resolve};

/// Opens a working-tree file with the system's default application. On
/// Windows, a kind of file with no application gets the "Open with" chooser.
#[tauri::command]
pub async fn open_file(repo: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = existing(&repo, &path)?;
        match os::open(windows_path(&file).as_os_str()) {
            Ok(()) => Ok(()),
            #[cfg(windows)]
            Err(OpenError::NoApplication) => os::open_with_dialog(&windows_path(&file)),
            #[cfg(not(windows))]
            Err(OpenError::NoApplication) => Err(format!("No application opens {path}")),
            Err(OpenError::Failed(e)) => Err(format!("could not open {path}: {e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens a working-tree file with `app` (a macOS `.app` bundle or a program).
/// Without `app` on Windows, shows the system's "Open with" chooser.
#[tauri::command]
pub async fn open_file_with(repo: String, path: String, app: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = existing(&repo, &path)?;
        let mut cmd = match app {
            Some(app) if cfg!(target_os = "macos") => {
                let mut c = Command::new("open");
                c.arg("-a").arg(app).arg(&file);
                c
            }
            Some(app) => {
                let mut c = Command::new(app);
                c.arg(&file);
                c
            }
            #[cfg(windows)]
            None => return os::open_with_dialog(&windows_path(&file)),
            #[cfg(not(windows))]
            None => return Err("Choose an application to open the file with".into()),
        };
        cmd.spawn().map(|_| ()).map_err(|e| format!("could not open {path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn existing(repo: &str, path: &str) -> Result<PathBuf, String> {
    let file = resolve(repo, path)?;
    if !file.exists() {
        return Err(format!("{path} isn't on disk (it may have been deleted)"));
    }
    Ok(file)
}

/// `file` with Windows' own `\` between folders: repository paths use `/`
/// (`C:\repo` joined with `src/a.txt`), which not every application accepts.
fn windows_path(file: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(file.to_string_lossy().replace('/', "\\"))
    } else {
        file.to_path_buf()
    }
}

/// Appends `pattern` to the repository's top-level `.gitignore` (creating it),
/// unless it is already there. Returns false if it was already listed.
#[tauri::command]
pub fn add_to_gitignore(repo: String, pattern: String) -> Result<bool, String> {
    let root = repo_root(&repo)?;
    add_pattern(&root, &pattern)
}

fn add_pattern(root: &Path, pattern: &str) -> Result<bool, String> {
    if pattern.trim().is_empty() || pattern.contains('\n') || pattern.contains('\r') {
        return Err("not a valid ignore pattern".into());
    }
    let file = root.join(".gitignore");
    let existing = std::fs::read_to_string(&file).unwrap_or_default();
    if existing.lines().any(|l| l == pattern) {
        return Ok(false);
    }
    let mut out = std::fs::OpenOptions::new().create(true).append(true).open(&file).map_err(|e| format!("could not update .gitignore: {e}"))?;
    let sep = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
    write!(out, "{sep}{pattern}\n").map_err(|e| format!("could not update .gitignore: {e}"))?;
    Ok(true)
}

/// Stops tracking a file (`git rm --cached`), leaving it on disk as a new,
/// untracked file. With `from_disk`, also moves it to the Trash. For a file
/// git doesn't track, only `from_disk` does anything.
#[tauri::command]
pub fn remove_file(repo: String, path: String, from_disk: bool) -> Result<(), String> {
    remove(&repo, &path, from_disk, &|f| trash::delete(f).map_err(|e| format!("could not move {path} to the {TRASH}: {e}")))
}

fn remove(repo: &str, path: &str, from_disk: bool, discard: &dyn Fn(&Path) -> Result<(), String>) -> Result<(), String> {
    let root = repo_root(repo)?;
    let file = resolve(repo, path)?;
    let tracked = git(&root, &["ls-files", "--error-unmatch", "--"], &[path.to_string()], None).is_ok();
    if tracked {
        git(&root, &["rm", "--cached", "--quiet", "--"], &[path.to_string()], None)?;
    } else if !from_disk {
        return Err(format!("{path} isn't in source control"));
    }
    if from_disk && file.symlink_metadata().is_ok() {
        discard(&file)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("visualgit-files-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for args in [&["init", "-q", "-b", "main"][..], &["config", "user.name", "Test"], &["config", "user.email", "t@example.com"]] {
            assert!(Command::new("git").arg("-C").arg(&dir).args(args).status().unwrap().success());
        }
        os::canonical(&dir).unwrap()
    }

    #[test]
    fn adds_ignore_patterns_once() {
        let dir = repo();
        std::fs::write(dir.join(".gitignore"), "target/").unwrap(); // no trailing newline
        assert!(add_pattern(&dir, "*.log").unwrap());
        assert!(!add_pattern(&dir, "*.log").unwrap());
        assert!(add_pattern(&dir, "/src/secret.txt").unwrap());
        assert_eq!(std::fs::read_to_string(dir.join(".gitignore")).unwrap(), "target/\n*.log\n/src/secret.txt\n");
        assert!(add_pattern(&dir, "two\nlines").is_err());
        assert!(add_pattern(&dir, "  ").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn removes_from_source_control_and_optionally_disk() {
        let dir = repo();
        let repo_s = dir.to_string_lossy().into_owned();
        let run = |args: &[&str]| Command::new("git").arg("-C").arg(&dir).args(args).output().unwrap();
        std::fs::write(dir.join("keep.txt"), "k\n").unwrap();
        std::fs::write(dir.join("gone.txt"), "g\n").unwrap();
        assert!(run(&["add", "."]).status.success());
        assert!(run(&["commit", "-q", "-m", "base"]).status.success());
        let delete = |f: &Path| std::fs::remove_file(f).map_err(|e| e.to_string());

        // From source control only: untracked now, still on disk.
        remove(&repo_s, "keep.txt", false, &delete).unwrap();
        assert!(dir.join("keep.txt").exists());
        let status = String::from_utf8_lossy(&run(&["status", "--porcelain"]).stdout).into_owned();
        assert!(status.contains("D  keep.txt") && status.contains("?? keep.txt"), "{status}");

        // From source control and disk.
        remove(&repo_s, "gone.txt", true, &delete).unwrap();
        assert!(!dir.join("gone.txt").exists());

        // Untracked: only removing from disk makes sense.
        std::fs::write(dir.join("new.txt"), "n\n").unwrap();
        assert!(remove(&repo_s, "new.txt", false, &delete).is_err());
        remove(&repo_s, "new.txt", true, &delete).unwrap();
        assert!(!dir.join("new.txt").exists());
        assert!(remove(&repo_s, "../outside", true, &delete).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
