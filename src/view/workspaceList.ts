/** Workspace view: the repositories in the open workspace, as a table. */

import { compileQuery } from "../model/search.ts";

/** Mirrors `RepoInfo` in src-tauri/src/workspace.rs. */
export interface RepoInfo {
  path: string;
  name: string;
  head: string | null;
  detached: boolean;
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

export function renderWorkspaceList(host: HTMLElement, repos: RepoInfo[], opts: WorkspaceListOptions) {
  const table = el("table", "branch-table workspace-table");
  const head = el("tr");
  for (const [label, cls] of [
    ["Repository", "col-repo"],
    ["Checked out", "col-head"],
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
    const path = el("td", "col-path muted", r.path);
    path.title = r.path;
    tr.append(name, headCell, path);
    tr.onclick = () => opts.onOpen(r);
    tr.ondblclick = () => opts.onActivate(r);
    tbody.append(tr);
  }
  if (shown.length === 0) {
    const tr = el("tr");
    const td = el("td", "branch-table-empty", opts.query.trim() ? `No repositories match “${opts.query.trim()}”` : opts.empty);
    td.colSpan = 3;
    tr.append(td);
    tbody.append(tr);
  }
  table.append(thead, tbody);
  const scroll = host.scrollTop;
  host.replaceChildren(table);
  host.scrollTop = scroll;
}
