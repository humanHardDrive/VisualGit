/** Workspace view: the repositories in the open workspace, as a table. */

import { compileQuery } from "../model/search.ts";
import { shownPath } from "../platform.ts";

/** Mirrors `Remote` in src-tauri/src/hosting.rs. */
export interface Remote {
  name: string;
  /** Without any user name or password. */
  url: string;
  /** The hosting service ("GitHub", …) and the repository's page there, when known. */
  host: string | null;
  page: string | null;
}

/** Mirrors `RepoInfo` in src-tauri/src/workspace.rs. */
export interface RepoInfo {
  path: string;
  name: string;
  head: string | null;
  detached: boolean;
  /** null: no remotes. Undefined: not looked up (a repository opened from outside the workspace). */
  remote?: Remote | null;
}

export interface WorkspaceListOptions {
  /** The open repository. */
  current: string | null;
  /** The repository being opened right now. */
  loading: string | null;
  /** Repository-name search (`*` and `?` wildcards). */
  query: string;
  /** Shown when there is nothing to list. */
  empty: string;
  onOpen(repo: RepoInfo): void;
  onActivate(repo: RepoInfo): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/** The repositories matching `query`, in workspace order. */
export function filterRepos(repos: RepoInfo[], query: string): RepoInfo[] {
  const re = compileQuery(query);
  return re ? repos.filter((r) => re.test(r.name)) : repos;
}

/** Just where the remote is: the hosting service ("GitHub") or server; the full URL is in the tooltip. */
function remoteCell(remote: Remote | null | undefined): HTMLElement {
  const td = el("td", "col-remote");
  if (remote === undefined) return td;
  if (remote === null) {
    td.append(el("span", "muted", "Local only"));
    td.title = "No remote: nowhere to push to";
    return td;
  }
  // A remote other than origin is named, since that's not where pushes go by default.
  if (remote.name !== "origin") td.append(el("span", "muted", `${remote.name}: `));
  // No host for a remote that's a folder (a path or file:// URL).
  td.append(remote.host ? el("span", "badge host", remote.host) : el("span", "muted", "Local folder"));
  td.title = `${remote.name}: ${remote.url}`;
  return td;
}

export function renderWorkspaceList(host: HTMLElement, repos: RepoInfo[], opts: WorkspaceListOptions) {
  const table = el("table", "branch-table workspace-table");
  const head = el("tr");
  for (const [label, cls] of [
    ["Repository", "col-repo"],
    ["Checked out", "col-head"],
    ["Remote", "col-remote"],
    ["Path", "col-path"],
  ]) {
    head.append(el("th", cls, label));
  }
  const thead = el("thead");
  thead.append(head);

  const tbody = el("tbody");
  const shown = filterRepos(repos, opts.query);
  for (const r of shown) {
    const tr = el("tr", "branch-row");
    tr.dataset.path = r.path; // for the right-click menu
    if (r.path === opts.current) tr.classList.add("selected");
    if (r.path === opts.loading) tr.classList.add("loading");
    const name = el("td", "col-repo");
    name.append(el("span", "name", r.name));
    const headCell = el("td", "col-head");
    if (r.head) headCell.append(el("span", r.detached ? "mono muted" : "mono", r.detached ? `detached at ${r.head}` : r.head));
    const path = el("td", "col-path muted", shownPath(r.path));
    path.title = shownPath(r.path);
    tr.append(name, headCell, remoteCell(r.remote), path);
    tr.onclick = () => opts.onOpen(r);
    tr.ondblclick = () => opts.onActivate(r);
    tbody.append(tr);
  }
  if (shown.length === 0) {
    const tr = el("tr");
    const td = el("td", "branch-table-empty", opts.query.trim() ? `No repositories match “${opts.query.trim()}”` : opts.empty);
    td.colSpan = 4;
    tr.append(td);
    tbody.append(tr);
  }
  table.append(thead, tbody);
  const scroll = host.scrollTop;
  host.replaceChildren(table);
  host.scrollTop = scroll;
}
