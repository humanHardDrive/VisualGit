mod branch;
mod diff;
mod menu;
mod merge;
mod pending;
mod workspace;

use std::path::Path;
use std::process::Command;
use workspace::RepoInfo;

/// Subcommands the UI may run. Everything here is read-only once the
/// argument checks in `validate` pass.
/// `status` would refresh the index's stat cache, but GIT_OPTIONAL_LOCKS=0
/// (set in `run_git`) makes it skip that write.
const ALLOWED: &[&str] = &["log", "show", "for-each-ref", "rev-parse", "reflog", "symbolic-ref", "status", "diff-tree", "ls-files"];

/// Rejects anything that could modify the repository or write files.
fn validate(args: &[String]) -> Result<(), String> {
    let sub = args.first().ok_or("missing git subcommand")?;
    if !ALLOWED.contains(&sub.as_str()) {
        return Err(format!("git {sub} is not allowed"));
    }
    if args.iter().any(|a| a.starts_with("--output")) {
        return Err("--output is not allowed".into());
    }
    match sub.as_str() {
        // `reflog expire` / `reflog delete` rewrite reflogs.
        "reflog" if args.get(1).map(String::as_str) != Some("show") => {
            Err("only `git reflog show` is allowed".into())
        }
        // `symbolic-ref <name> <ref>` and `-d` modify refs.
        "symbolic-ref" => {
            let positional = args[1..].iter().filter(|a| !a.starts_with('-')).count();
            let deletes = args.iter().any(|a| a == "-d" || a == "--delete");
            if positional > 1 || deletes {
                Err("symbolic-ref may only read".into())
            } else {
                Ok(())
            }
        }
        _ => Ok(()),
    }
}

fn run_git(repo: &str, args: &[String]) -> Result<String, String> {
    validate(args)?;
    if !Path::new(repo).is_dir() {
        return Err(format!("not a directory: {repo}"));
    }
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args(["--no-pager", "-c", "core.quotepath=off"])
        .arg(&args[0]);
    // Never invoke user-configured external diff or textconv programs.
    if matches!(args[0].as_str(), "log" | "show" | "diff-tree") {
        cmd.args(["--no-ext-diff", "--no-textconv"]);
    }
    let output = cmd
        .args(&args[1..])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Runs a read-only git command in `repo` and returns stdout.
#[tauri::command]
async fn git(repo: String, args: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_git(&repo, &args))
        .await
        .map_err(|e| e.to_string())?
}

/// Lists the repositories inside a workspace folder.
#[tauri::command]
async fn find_repos(root: String) -> Result<Vec<RepoInfo>, String> {
    if !Path::new(&root).is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    tauri::async_runtime::spawn_blocking(move || workspace::find_repos(Path::new(&root), workspace::MAX_DEPTH))
        .await
        .map_err(|e| e.to_string())
}

/// Repository to open at startup: `visualgit <path>` or `VISUALGIT_REPO=<path>`.
#[tauri::command]
fn initial_repo() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && Path::new(a).is_dir())
        .or_else(|| std::env::var("VISUALGIT_REPO").ok().filter(|p| Path::new(p).is_dir()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .menu(menu::build)
        .on_menu_event(menu::handle)
        .manage(pending::PendingWindows::default())
        .manage(merge::MergeWindows::default())
        .manage(diff::DiffWindows::default())
        .invoke_handler(tauri::generate_handler![
            git,
            find_repos,
            initial_repo,
            pending::open_pending_window,
            pending::window_repo,
            pending::read_worktree_file,
            pending::write_worktree_file,
            pending::commit_changes,
            pending::undo_changes,
            pending::push_current_branch,
            pending::push_branch,
            branch::create_branch,
            branch::switch_to_changeset,
            branch::switch_to_remote_branch,
            diff::open_diff_window,
            diff::diff_window_info,
            merge::open_merge_window,
            merge::merge_window_info,
            merge::merge_preview,
            merge::cherry_pick,
            merge::operation_in_progress,
            merge::abort_operation,
        ])
        .run(tauri::generate_context!())
        .expect("error while running VisualGit");
}

#[cfg(test)]
mod tests {
    use super::validate;

    fn v(args: &[&str]) -> Result<(), String> {
        validate(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn allows_reads() {
        assert!(v(&["log", "--all", "--format=%H"]).is_ok());
        assert!(v(&["reflog", "show", "--all"]).is_ok());
        assert!(v(&["symbolic-ref", "-q", "HEAD"]).is_ok());
        assert!(v(&["for-each-ref", "refs/heads"]).is_ok());
        assert!(v(&["status", "--porcelain=v2", "-z", "--branch"]).is_ok());
        assert!(v(&["diff-tree", "-r", "-z", "--name-status", "HEAD~1", "HEAD"]).is_ok());
        assert!(v(&["ls-files", "-z", "--others", "--exclude-standard"]).is_ok());
    }

    #[test]
    fn rejects_writes() {
        assert!(v(&[]).is_err());
        assert!(v(&["commit", "-m", "x"]).is_err());
        assert!(v(&["branch", "x"]).is_err());
        assert!(v(&["reflog", "expire", "--all"]).is_err());
        assert!(v(&["reflog", "delete", "HEAD@{0}"]).is_err());
        assert!(v(&["symbolic-ref", "HEAD", "refs/heads/x"]).is_err());
        assert!(v(&["symbolic-ref", "-d", "HEAD"]).is_err());
        assert!(v(&["log", "--output=/tmp/x"]).is_err());
        assert!(v(&["show", "--output", "/tmp/x"]).is_err());
    }
}
