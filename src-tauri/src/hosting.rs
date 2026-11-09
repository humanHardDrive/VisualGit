//! Where a repository is hosted (GitHub, GitLab, …), worked out from its
//! remote's URL, and opening its page there in the browser.
//!
//! The web address is built here rather than in the page, and only ever from
//! a remote's URL, so the browser can't be pointed anywhere else. Credentials
//! in a remote URL (`https://user:token@host/…`) never make it into the
//! address.

use std::process::{Command, Stdio};

use serde::Serialize;

use crate::pending::{git, repo_root};

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebPage {
    /// The service's name ("GitHub", "GitLab", …), or the server's host name if it isn't a known one.
    pub host: String,
    pub url: String,
    /// The remote the page was worked out from.
    pub remote: String,
}

/// The repository's page on its hosting service, if it has a remote that points at one.
#[tauri::command]
pub async fn repo_web_page(repo: String) -> Result<Option<WebPage>, String> {
    tauri::async_runtime::spawn_blocking(move || find(&repo)).await.map_err(|e| e.to_string())?
}

/// What a remote URL points at, for showing while it's typed: the service
/// and the repository's page there. None if it isn't recognisable as hosted.
#[tauri::command]
pub async fn describe_remote(url: String) -> Option<WebPage> {
    let url = url.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        web_page(&url, &ssh_hostname).map(|(host, url)| WebPage { host, url, remote: "origin".into() })
    })
    .await
    .ok()
    .flatten()
}

/// Opens the repository's page in the default browser.
#[tauri::command]
pub async fn open_repo_web_page(repo: String) -> Result<(), String> {
    let page = tauri::async_runtime::spawn_blocking(move || find(&repo))
        .await
        .map_err(|e| e.to_string())??
        .ok_or("This repository has no remote on a hosting service")?;
    let mut cmd = if cfg!(target_os = "macos") {
        Command::new("open")
    } else if cfg!(target_os = "windows") {
        // Not `cmd /C start`: cmd would interpret characters like & in the address.
        let mut c = Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler");
        c
    } else {
        Command::new("xdg-open")
    };
    cmd.arg(&page.url).spawn().map(|_| ()).map_err(|e| format!("could not open the browser: {e}"))
}

fn find(repo: &str) -> Result<Option<WebPage>, String> {
    let root = repo_root(repo)?;
    let remotes = git(&root, &["remote"], &[], None)?;
    let names: Vec<&str> = remotes.lines().map(str::trim).filter(|n| !n.is_empty()).collect();
    // origin, else upstream, else whichever comes first.
    let preferred = |n: &str| ["origin", "upstream"].iter().position(|p| *p == n).unwrap_or(usize::MAX);
    let mut order = names.clone();
    order.sort_by_key(|n| preferred(n)); // stable: the rest keep git's order
    for name in order {
        // `get-url` applies `url.<base>.insteadOf` rewrites, so this is the address git really uses.
        let Ok(url) = git(&root, &["remote", "get-url", "--", name], &[], None) else { continue };
        if let Some((host, url)) = web_page(url.trim(), &ssh_hostname) {
            return Ok(Some(WebPage { host, url, remote: name.to_string() }));
        }
    }
    Ok(None)
}

/// The real host behind an SSH host name, which may be an alias from
/// `~/.ssh/config` (`Host work` → `HostName github.com`). `ssh -G` only reads
/// the configuration; it doesn't connect.
fn ssh_hostname(host: &str) -> String {
    Command::new("ssh")
        .args(["-G", "--", host])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .find_map(|l| l.strip_prefix("hostname ").map(|h| h.trim().to_lowercase()))
        })
        .filter(|h| valid_host(h))
        .unwrap_or_else(|| host.to_string())
}

/// A remote URL's web page: (service name, address). None for local paths,
/// `file://` URLs and anything that doesn't look like a hosted repository.
fn web_page(remote: &str, resolve_ssh: &dyn Fn(&str) -> String) -> Option<(String, String)> {
    let (scheme, authority, path, ssh) = if let Some((scheme, rest)) = remote.split_once("://") {
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        match scheme.to_ascii_lowercase().as_str() {
            s @ ("https" | "http") => (s.to_string(), authority, path, false),
            "ssh" | "git+ssh" | "ssh+git" => ("https".to_string(), authority, path, true),
            "git" => ("https".to_string(), authority, path, false),
            _ => return None, // file://, ext::, and the like
        }
    } else {
        // scp-like `user@host:path`. A colon after a slash, or a single letter
        // before it (a Windows drive), means a local path instead.
        let (authority, path) = remote.split_once(':')?;
        if authority.contains('/') || authority.contains('\\') || authority.len() <= 1 {
            return None;
        }
        ("https".to_string(), authority, path, true)
    };

    // Drop any `user:password@`: credentials don't belong in a browser address.
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => (h, Some(p)),
        _ => (host_port, None),
    };
    let mut host = host.to_lowercase();
    if ssh && !host.starts_with('-') {
        host = resolve_ssh(&host);
    }
    if !valid_host(&host) {
        return None;
    }
    // An SSH or git:// port says nothing about the web server's.
    let port = if remote.get(..4).is_some_and(|s| s.eq_ignore_ascii_case("http")) { port } else { None };

    let mut path = path.trim_matches('/').to_string();
    if let Some(p) = path.strip_suffix(".git") {
        path = p.trim_end_matches('/').to_string();
    }
    if path.is_empty() || !path.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~/%+@!$()*,;=".contains(&b)) {
        return None;
    }

    // SSH-only host names, and Azure DevOps' different SSH and web paths.
    match host.as_str() {
        "ssh.github.com" => host = "github.com".into(),
        "altssh.gitlab.com" => host = "gitlab.com".into(),
        "altssh.bitbucket.org" => host = "bitbucket.org".into(),
        "ssh.dev.azure.com" => {
            let [_, org, project, name] = path.splitn(4, '/').collect::<Vec<_>>()[..] else { return None };
            return Some(("Azure DevOps".into(), format!("https://dev.azure.com/{org}/{project}/_git/{name}")));
        }
        h if h == "vs-ssh.visualstudio.com" || h.ends_with(".vs-ssh.visualstudio.com") => {
            let [_, org, project, name] = path.splitn(4, '/').collect::<Vec<_>>()[..] else { return None };
            return Some(("Azure DevOps".into(), format!("https://{org}.visualstudio.com/{project}/_git/{name}")));
        }
        _ => {}
    }
    let url = match port {
        Some(p) => format!("{scheme}://{host}:{p}/{path}"),
        None => format!("{scheme}://{host}/{path}"),
    };
    Some((service_name(&host), url))
}

fn valid_host(host: &str) -> bool {
    !host.is_empty() && !host.starts_with(['-', '.']) && host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

/// The hosting service's name, from its host: well-known services, then
/// self-hosted servers whose names give them away, then just the host.
fn service_name(host: &str) -> String {
    let known = [
        ("github.com", "GitHub"),
        ("gitlab.com", "GitLab"),
        ("bitbucket.org", "Bitbucket"),
        ("dev.azure.com", "Azure DevOps"),
        ("codeberg.org", "Codeberg"),
        ("git.sr.ht", "SourceHut"),
    ];
    if let Some((_, name)) = known.iter().find(|(h, _)| *h == host) {
        return name.to_string();
    }
    if host.ends_with(".visualstudio.com") {
        return "Azure DevOps".into();
    }
    for (word, name) in [("github", "GitHub"), ("gitlab", "GitLab"), ("bitbucket", "Bitbucket"), ("gitea", "Gitea"), ("forgejo", "Forgejo")] {
        if host.split(['.', '-']).any(|part| part == word) {
            return name.to_string();
        }
    }
    host.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(url: &str) -> Option<(String, String)> {
        // `work` stands in for an alias in ~/.ssh/config.
        web_page(url, &|h| if h == "work" { "github.com".to_string() } else { h.to_string() })
    }
    fn ok(url: &str, host: &str, web: &str) {
        assert_eq!(page(url), Some((host.to_string(), web.to_string())), "{url}");
    }

    #[test]
    fn web_pages_from_remote_urls() {
        ok("https://github.com/humanHardDrive/VisualGit.git", "GitHub", "https://github.com/humanHardDrive/VisualGit");
        ok("git@github.com:owner/repo.git", "GitHub", "https://github.com/owner/repo");
        ok("ssh://git@ssh.github.com:443/owner/repo.git", "GitHub", "https://github.com/owner/repo");
        ok("git@work:owner/repo.git", "GitHub", "https://github.com/owner/repo");
        ok("https://user:secret-token@github.com/owner/repo", "GitHub", "https://github.com/owner/repo");
        ok("git@gitlab.com:group/sub/repo.git", "GitLab", "https://gitlab.com/group/sub/repo");
        ok("https://bitbucket.org/team/repo.git/", "Bitbucket", "https://bitbucket.org/team/repo");
        ok("git@ssh.dev.azure.com:v3/org/project/repo", "Azure DevOps", "https://dev.azure.com/org/project/_git/repo");
        ok("https://org@dev.azure.com/org/project/_git/repo", "Azure DevOps", "https://dev.azure.com/org/project/_git/repo");
        ok("org@vs-ssh.visualstudio.com:v3/org/project/repo", "Azure DevOps", "https://org.visualstudio.com/project/_git/repo");
        ok("git@git.sr.ht:~user/repo", "SourceHut", "https://git.sr.ht/~user/repo");
        ok("https://codeberg.org/user/repo.git", "Codeberg", "https://codeberg.org/user/repo");
        ok("https://gitlab.example.com:8443/team/app.git", "GitLab", "https://gitlab.example.com:8443/team/app");
        ok("ssh://git@git.example.com:2222/team/app.git", "git.example.com", "https://git.example.com/team/app");
        ok("git://git.kernel.org/pub/scm/git/git.git", "git.kernel.org", "https://git.kernel.org/pub/scm/git/git");

        for local in ["/srv/git/repo.git", "../other", "C:\\repos\\app", "C:/repos/app", "file:///srv/repo.git", "ext::ssh -o x host", "https://github.com/", "git@-oProxyCommand=x:repo", "https://github.com/a b"] {
            assert_eq!(page(local), None, "{local}");
        }
    }

    #[test]
    fn finds_the_page_from_the_preferred_remote() {
        let dir = std::env::temp_dir().join(format!("visualgit-hosting-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| assert!(Command::new("git").arg("-C").arg(&dir).args(args).status().unwrap().success());
        run(&["init", "-q"]);
        let repo = dir.to_string_lossy().into_owned();
        assert_eq!(find(&repo).unwrap(), None);
        run(&["remote", "add", "mirror", "https://gitlab.com/me/app.git"]);
        assert_eq!(find(&repo).unwrap().unwrap().host, "GitLab");
        run(&["remote", "add", "origin", "https://github.com/me/app.git"]);
        let page = find(&repo).unwrap().unwrap();
        assert_eq!((page.host.as_str(), page.url.as_str(), page.remote.as_str()), ("GitHub", "https://github.com/me/app", "origin"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
