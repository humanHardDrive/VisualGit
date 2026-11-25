//! External tools (Settings › External Tools): a diff tool and a merge tool,
//! each either git's own (`git difftool` / `git mergetool`, with the tool
//! chosen in git's config) or a command of your own, and commands to open
//! files with from the Files view.
//!
//! Commands are only ever the ones stored in the settings file (read here,
//! never passed in by the page), and they're run directly, never through a
//! shell: `$FILE` and the rest are replaced inside each argument, so a file
//! name can't become part of a command.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::branch::commit_id;
use crate::os::command;
use crate::pending::{git, repo_root, resolve};

#[derive(Clone, Copy, PartialEq, Debug)]
enum Which {
    Diff,
    Merge,
}

impl Which {
    fn parse(s: &str) -> Result<Which, String> {
        match s {
            "diff" => Ok(Which::Diff),
            "merge" => Ok(Which::Merge),
            _ => Err(format!("no such tool: {s}")),
        }
    }
    fn key(self) -> &'static str {
        if self == Which::Diff { "diff" } else { "merge" }
    }
    /// git's command and config section: difftool / diff.tool, mergetool / merge.tool.
    fn git(self) -> (&'static str, &'static str) {
        if self == Which::Diff { ("difftool", "diff.tool") } else { ("mergetool", "merge.tool") }
    }
    fn what(self) -> &'static str {
        if self == Which::Diff { "diff tool" } else { "merge tool" }
    }
}

/// The stored choice for a diff or merge tool: "builtin", "git" or "custom", and the custom command.
fn chosen(app: &AppHandle, which: Which) -> (String, String) {
    let s = crate::settings::stored(app);
    let t = &s["tools"][which.key()];
    (t["kind"].as_str().unwrap_or("builtin").to_string(), t["command"].as_str().unwrap_or("").trim().to_string())
}

// ---- commands -------------------------------------------------------------------------

/// Splits a command line into the program and its arguments. Quotes ("…" or '…') group
/// words with spaces; there are no other special characters (so Windows paths' backslashes
/// stay as they are), and nothing is expanded but the `$NAME`s, later, by `substitute`.
pub(crate) fn split(line: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut quote: Option<char> = None;
    for ch in line.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => word.push(ch),
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
                in_word = true;
            }
            None if ch.is_whitespace() => {
                if in_word {
                    out.push(std::mem::take(&mut word));
                    in_word = false;
                }
            }
            None => {
                word.push(ch);
                in_word = true;
            }
        }
    }
    if quote.is_some() {
        return Err("The command has a quote that isn't closed.".into());
    }
    if in_word {
        out.push(word);
    }
    if out.is_empty() {
        return Err("The command is empty.".into());
    }
    Ok(out)
}

/// Replaces `$NAME` and `${NAME}` in `arg` with their values, in one pass (so a value is
/// never looked at again). Names it doesn't know are left as they are.
pub(crate) fn substitute(arg: &str, vars: &[(&str, &str)]) -> String {
    let mut out = String::new();
    let mut rest = arg;
    while let Some(i) = rest.find('$') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let (name, len) = if let Some(inner) = after.strip_prefix('{') {
            match inner.find('}') {
                Some(end) => (&inner[..end], end + 2),
                None => ("", 0),
            }
        } else {
            let end = after.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(after.len());
            (&after[..end], end)
        };
        match vars.iter().find(|(k, _)| *k == name) {
            Some((_, v)) if len > 0 => {
                out.push_str(v);
                rest = &after[len..];
            }
            _ => {
                out.push('$');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The process for a stored command with its `$NAME`s filled in.
fn build(line: &str, vars: &[(&str, &str)], cwd: &Path) -> Result<Command, String> {
    let argv: Vec<String> = split(line)?.iter().map(|a| substitute(a, vars)).collect();
    let mut cmd = program(&argv)?;
    cmd.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    // Opened from the Finder, the app has a short PATH without where most tools are installed.
    #[cfg(target_os = "macos")]
    {
        let path = std::env::var("PATH").unwrap_or_default();
        let extra: Vec<&str> = ["/opt/homebrew/bin", "/usr/local/bin"].into_iter().filter(|d| !path.split(':').any(|p| p == *d)).collect();
        if !extra.is_empty() {
            cmd.env("PATH", format!("{path}:{}", extra.join(":")));
        }
    }
    Ok(cmd)
}

#[cfg(not(windows))]
fn program(argv: &[String]) -> Result<Command, String> {
    let mut cmd = command(&argv[0]);
    cmd.args(&argv[1..]);
    Ok(cmd)
}

/// On Windows, many tools are batch-file shims (`code.cmd`), which only cmd.exe can run. cmd
/// would read characters such as `&` in a file name as its own, so those are refused.
#[cfg(windows)]
fn program(argv: &[String]) -> Result<Command, String> {
    let first = Path::new(&argv[0]);
    let found = if first.extension().is_some() || first.components().count() > 1 {
        Some(first.to_path_buf())
    } else {
        let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths).find_map(|dir| exts.split(';').map(|e| dir.join(format!("{}{e}", argv[0]))).find(|p| p.is_file()))
        })
    };
    let Some(found) = found else {
        let mut cmd = command(&argv[0]);
        cmd.args(&argv[1..]);
        return Ok(cmd);
    };
    let batch = found.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    if !batch {
        let mut cmd = command(&found);
        cmd.args(&argv[1..]);
        return Ok(cmd);
    }
    if let Some(bad) = argv[1..].iter().find(|a| a.contains(['&', '|', '<', '>', '^', '%', '"', '\n'])) {
        return Err(format!("{} is a batch file, and cmd.exe would misread “{bad}”. Use the program's .exe instead.", found.display()));
    }
    let mut cmd = command("cmd");
    cmd.args(["/D", "/C"]).arg(&found).args(&argv[1..]);
    Ok(cmd)
}

/// Starts a tool and leaves it running; `cleanup` runs once it exits (temporary files).
fn start(mut cmd: Command, what: &str, cleanup: impl FnOnce() + Send + 'static) -> Result<(), String> {
    let mut child = cmd.spawn().map_err(|e| format!("Could not start the {what}: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
        cleanup();
    });
    Ok(())
}

/// Runs a tool and waits for it; Ok(true) when it exits successfully.
fn run(mut cmd: Command, what: &str) -> Result<bool, String> {
    let out = cmd.output().map_err(|e| format!("Could not start the {what}: {e}"))?;
    Ok(out.status.success())
}

// ---- temporary copies ---------------------------------------------------------------------

/// A folder for one tool run's copies of file versions, removed afterwards.
fn scratch() -> Result<PathBuf, String> {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("visualgit-tool-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Writes `spec`'s content (`<rev>:<path>`, or `:2:<path>` for a merge stage) to `side/<name>` in
/// `dir`, keeping the file's name so tools recognise its type. Missing (added or deleted on that
/// side, or no common version): an empty file.
fn copy_of(root: &Path, spec: Option<&str>, dir: &Path, side: &str, name: &str) -> Result<PathBuf, String> {
    let folder = dir.join(side);
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let file = folder.join(name);
    let bytes = match spec {
        Some(spec) => command("git").arg("-C").arg(root).args(["--no-pager", "show", spec]).output().ok().filter(|o| o.status.success()).map(|o| o.stdout).unwrap_or_default(),
        None => Vec::new(),
    };
    std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
    Ok(file)
}

/// A changeset id, or HEAD; nothing else (no options, no revision syntax).
fn revision(root: &Path, rev: &str) -> Result<String, String> {
    if rev == "HEAD" {
        return Ok("HEAD".into());
    }
    commit_id(root, rev)
}

fn file_name(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

/// git's tool must be chosen first: without one, git falls back to a terminal tool.
fn git_tool_set(root: &Path, which: Which) -> Result<(), String> {
    let (_, key) = which.git();
    match git(root, &["config", "--get", key], &[], None) {
        Ok(v) if !v.trim().is_empty() => Ok(()),
        _ => Err(format!("git has no {} chosen. Pick one in Settings › External Tools (it's saved as {key} in your git config).", which.what())),
    }
}

// ---- tauri commands ---------------------------------------------------------------------------

/// Shows `path` in the diff tool: as it is at `from` and at `to` (changesets, or HEAD); without
/// `to`, the working copy. Without `from` (the first changeset), an empty file. `orig_path`: where
/// a renamed file was at `from`. The tool is left running.
#[tauri::command]
pub async fn open_diff_tool(app: AppHandle, repo: String, from: Option<String>, to: Option<String>, path: String, orig_path: Option<String>) -> Result<(), String> {
    let (kind, line) = chosen(&app, Which::Diff);
    tauri::async_runtime::spawn_blocking(move || diff_with(&kind, &line, &repo, from, to, &path, orig_path)).await.map_err(|e| e.to_string())?
}

fn diff_with(kind: &str, line: &str, repo: &str, from: Option<String>, to: Option<String>, path: &str, orig_path: Option<String>) -> Result<(), String> {
    {
        let root = repo_root(repo)?;
        let from = from.map(|r| revision(&root, &r)).transpose()?;
        let to = to.map(|r| revision(&root, &r)).transpose()?;
        let old = orig_path.unwrap_or_else(|| path.to_string());
        match kind {
            "git" => {
                git_tool_set(&root, Which::Diff)?;
                // The first changeset is compared with the empty tree.
                let from = match from {
                    Some(f) => f,
                    None => git(&root, &["hash-object", "-t", "tree", "--stdin"], &[], Some(""))?.trim().to_string(),
                };
                let mut cmd = command("git");
                cmd.arg("-C").arg(&root).args(["--no-pager", "difftool", "--no-prompt", &from]);
                if let Some(to) = &to {
                    cmd.arg(to);
                }
                cmd.arg("--").arg(path);
                if old != path {
                    cmd.arg(&old);
                }
                cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
                start(cmd, "diff tool", || {})
            }
            "custom" if !line.is_empty() => {
                let dir = scratch()?;
                let name = file_name(path);
                let local = copy_of(&root, from.as_ref().map(|f| format!("{f}:{old}")).as_deref(), &dir, "before", &name)?;
                let remote = match &to {
                    Some(to) => copy_of(&root, Some(&format!("{to}:{path}")), &dir, "after", &name)?,
                    None => resolve(repo, path)?,
                };
                let (l, r) = (local.to_string_lossy().into_owned(), remote.to_string_lossy().into_owned());
                let cmd = build(line, &[("LOCAL", &l), ("REMOTE", &r), ("MERGED", &r), ("BASE", &l)], &root)?;
                start(cmd, "diff tool", move || {
                    let _ = std::fs::remove_dir_all(dir);
                })
            }
            "custom" => Err("The diff tool's command is empty. Set it in Settings › External Tools.".into()),
            _ => Err("No external diff tool is chosen. Choose one in Settings › External Tools.".into()),
        }
    }
}

/// Resolves a conflicted file in the merge tool, and waits for it to close. Ok(true) when the
/// tool says it resolved it (exited successfully). git's tool: `git mergetool`, without the
/// `.orig` backup files it would leave. Your own: `$BASE`, `$LOCAL` and `$REMOTE` are copies of
/// the common, this side's and the other side's versions, and `$MERGED` is the file itself.
#[tauri::command]
pub async fn open_merge_tool(app: AppHandle, repo: String, path: String) -> Result<bool, String> {
    let (kind, line) = chosen(&app, Which::Merge);
    tauri::async_runtime::spawn_blocking(move || merge_with(&kind, &line, &repo, &path)).await.map_err(|e| e.to_string())?
}

fn merge_with(kind: &str, line: &str, repo: &str, path: &str) -> Result<bool, String> {
    {
        let root = repo_root(repo)?;
        let merged = resolve(repo, path)?;
        match kind {
            "git" => {
                git_tool_set(&root, Which::Merge)?;
                let mut cmd = command("git");
                cmd.arg("-C").arg(&root).args(["-c", "mergetool.keepBackup=false", "--no-pager", "mergetool", "--no-prompt", "--"]).arg(path);
                cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
                run(cmd, "merge tool")
            }
            "custom" if !line.is_empty() => {
                let dir = scratch()?;
                let name = file_name(path);
                let base = copy_of(&root, Some(&format!(":1:{path}")), &dir, "base", &name)?;
                let local = copy_of(&root, Some(&format!(":2:{path}")), &dir, "local", &name)?;
                let remote = copy_of(&root, Some(&format!(":3:{path}")), &dir, "remote", &name)?;
                let s = |p: &Path| p.to_string_lossy().into_owned();
                let (b, l, r, m) = (s(&base), s(&local), s(&remote), s(&merged));
                let cmd = build(line, &[("BASE", &b), ("LOCAL", &l), ("REMOTE", &r), ("MERGED", &m)], &root)?;
                let done = run(cmd, "merge tool");
                let _ = std::fs::remove_dir_all(dir);
                done
            }
            "custom" => Err("The merge tool's command is empty. Set it in Settings › External Tools.".into()),
            _ => Err("No external merge tool is chosen. Choose one in Settings › External Tools.".into()),
        }
    }
}

/// Opens a working-tree file with the `index`th tool to open files with.
#[tauri::command]
pub async fn open_with_tool(app: AppHandle, repo: String, path: String, index: usize) -> Result<(), String> {
    let s = crate::settings::stored(&app);
    let tool = s["tools"]["open"].get(index).cloned().unwrap_or(Value::Null);
    let name = tool["name"].as_str().unwrap_or("the tool").to_string();
    let line = tool["command"].as_str().unwrap_or("").trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        if line.is_empty() {
            return Err(format!("{name} has no command. Set it in Settings › External Tools."));
        }
        let root = repo_root(&repo)?;
        let file = resolve(&repo, &path)?;
        if !file.exists() {
            return Err(format!("{path} isn't on disk (it may have been deleted)"));
        }
        let dir = file.parent().unwrap_or(&root).to_path_buf();
        let (f, d, r) = (file.to_string_lossy().into_owned(), dir.to_string_lossy().into_owned(), root.to_string_lossy().into_owned());
        let cmd = build(&line, &[("FILE", &f), ("DIR", &d), ("REPO", &r)], &root)?;
        start(cmd, &name, || {})
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The tools git can use for diff or merge, and the one chosen in its config.
#[derive(Serialize, Debug, PartialEq)]
pub struct GitTools {
    /// Installed tools that open a window of their own (git also has terminal ones, no use here),
    /// and any you defined yourself: (name, description).
    pub available: Vec<(String, String)>,
    pub current: Option<String>,
}

/// Reads `git difftool --tool-help` (or mergetool's): the tools listed before the ones that are
/// "valid, but not currently available".
pub(crate) fn parse_tool_help(out: &str) -> Vec<(String, String)> {
    let mut tools = Vec::new();
    let mut user_defined = false;
    for line in out.lines() {
        if line.starts_with("The following tools are valid, but not currently available") || line.starts_with("Some of the tools") {
            break;
        }
        if !line.starts_with(char::is_whitespace) {
            continue;
        }
        let text = line.trim();
        if text == "user-defined:" {
            user_defined = true;
            continue;
        }
        let (name, desc) = text.split_once(char::is_whitespace).map(|(n, d)| (n, d.trim())).unwrap_or((text, ""));
        // A terminal tool (vimdiff, emerge) has nowhere to show from here.
        if user_defined || desc.contains("graphical") {
            tools.push((name.to_string(), desc.replace(" (requires a graphical session)", "")));
        }
    }
    tools
}

#[tauri::command]
pub async fn git_tools(which: String) -> Result<GitTools, String> {
    let which = Which::parse(&which)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (sub, key) = which.git();
        let home = std::env::temp_dir();
        let out = command("git").arg("-C").arg(&home).args([sub, "--tool-help"]).output().map_err(|e| e.to_string())?;
        let available = parse_tool_help(&String::from_utf8_lossy(&out.stdout));
        let current = git(&home, &["config", "--global", "--get", key], &[], None).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        Ok(GitTools { available, current })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Chooses git's diff or merge tool: `diff.tool` / `merge.tool` in your global git config, so
/// command-line git and other clients use it too.
#[tauri::command]
pub async fn set_git_tool(which: String, name: String) -> Result<(), String> {
    let which = Which::parse(&which)?;
    if name.is_empty() || name.starts_with('-') || !name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return Err(format!("“{name}” isn't a tool name"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (_, key) = which.git();
        git(&std::env::temp_dir(), &["config", "--global", key, &name], &[], None).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_commands_like_a_shell_would_quote_them() {
        assert_eq!(split(r#"code --wait "$FILE""#).unwrap(), vec!["code", "--wait", "$FILE"]);
        assert_eq!(split(r#""C:\Program Files\Beyond Compare 4\BCompare.exe" $LOCAL $REMOTE"#).unwrap()[0], r"C:\Program Files\Beyond Compare 4\BCompare.exe");
        assert_eq!(split("open -a 'Visual Studio Code' $FILE").unwrap(), vec!["open", "-a", "Visual Studio Code", "$FILE"]);
        assert_eq!(split(r#"tool """#).unwrap(), vec!["tool", ""]);
        assert!(split("  ").is_err());
        assert!(split(r#"tool "unclosed"#).is_err());
    }

    #[test]
    fn fills_in_names_once_and_leaves_others() {
        let vars = [("FILE", "/a/$REMOTE b.txt"), ("REMOTE", "/r")];
        assert_eq!(substitute("$FILE", &vars), "/a/$REMOTE b.txt", "a value isn't expanded again");
        assert_eq!(substitute("--left=${REMOTE}x", &vars), "--left=/rx");
        assert_eq!(substitute("$REMOTEx $HOME $ ${NOPE", &vars), "$REMOTEx $HOME $ ${NOPE");
        assert_eq!(substitute("$REMOTE.txt", &vars), "/r.txt");
    }

    /// Your own tools get copies of each version, named like the file; `cp` stands in for a tool.
    #[cfg(unix)]
    #[test]
    fn hands_your_own_tools_each_version() {
        let tmp = std::env::temp_dir().join(format!("visualgit-tools-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let dir = crate::os::canonical(&tmp).unwrap();
        let g = |args: &[&str]| {
            let out = command("git").arg("-C").arg(&dir).args(["-c", "user.name=T", "-c", "user.email=t@e", "-c", "commit.gpgsign=false"]).args(args).output().unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        g(&["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("f.txt"), "base\n").unwrap();
        g(&["add", "."]);
        g(&["commit", "-q", "-m", "base"]);
        let base = g(&["rev-parse", "HEAD"]);
        std::fs::write(dir.join("f.txt"), "ours\n").unwrap();
        g(&["commit", "-q", "-am", "ours"]);
        let ours = g(&["rev-parse", "HEAD"]);
        let repo = dir.to_string_lossy().into_owned();
        let out = tmp.join("seen.txt");
        let o = out.to_string_lossy().into_owned();

        // A changeset's diff: the version before, as a copy.
        diff_with("custom", &format!("cp $LOCAL {o}"), &repo, Some(base.clone()), Some(ours.clone()), "f.txt", None).unwrap();
        for _ in 0..50 {
            if out.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "base\n");
        // Revisions are changeset ids or HEAD only.
        assert!(diff_with("custom", "cp $LOCAL x", &repo, Some("--output=x".into()), None, "f.txt", None).is_err());
        assert!(diff_with("builtin", "", &repo, None, None, "f.txt", None).unwrap_err().contains("Settings"));

        // A conflict: $REMOTE is their version, and the tool writes $MERGED.
        g(&["switch", "-q", "-c", "theirs", &base]);
        std::fs::write(dir.join("f.txt"), "theirs\n").unwrap();
        g(&["commit", "-q", "-am", "theirs"]);
        g(&["switch", "-q", "main"]);
        g(&["merge", "--no-ff", "theirs"]);
        assert!(merge_with("custom", "cp $REMOTE $MERGED", &repo, "f.txt").unwrap());
        assert_eq!(std::fs::read_to_string(dir.join("f.txt")).unwrap(), "theirs\n");
        assert!(!merge_with("custom", "false", &repo, "f.txt").unwrap(), "a tool that fails didn't resolve it");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn reads_the_tools_git_can_use_from_a_window() {
        let help = "'git difftool --tool=<tool>' may be set to one of the following:\n\t\topendiff         Use FileMerge (requires a graphical session)\n\t\tvimdiff          Use Vim\n\t\tuser-defined:\n\t\t\tmine.tool  mytool $LOCAL\n\nThe following tools are valid, but not currently available:\n\t\tbc               Use Beyond Compare (requires a graphical session)\n";
        assert_eq!(parse_tool_help(help), vec![("opendiff".to_string(), "Use FileMerge".to_string()), ("mine.tool".to_string(), "mytool $LOCAL".to_string())]);
    }
}
