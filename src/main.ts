import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Menu } from "@tauri-apps/api/menu";
import { open } from "@tauri-apps/plugin-dialog";
import { loadRepo, type GitRunner } from "./git/load.ts";
import { inTauri, tauriRunner } from "./git/tauriRunner.ts";
import { inferModel, pendingChangesOn, uncommittedHead, type Model } from "./model/infer.ts";
import { layoutModel } from "./model/layout.ts";
import { searchModel, type SearchResults } from "./model/search.ts";
import { clearDetails, showBranch, showCommit } from "./view/details.ts";
import { branchColor, Explorer, pushLabel, type Selection, type View } from "./view/explorer.ts";

/** Mirrors `RepoInfo` in src-tauri/src/workspace.rs. */
interface RepoInfo {
  path: string;
  name: string;
  head: string | null;
  detached: boolean;
}

/** Selection saved across reloads; branches by name, since ids are reassigned. */
type SavedSelection = { kind: "commit"; hash: string } | { kind: "branch"; name: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("explorer");
const details = $("details");
const branchList = $("branch-list");
const searchInput = $<HTMLInputElement>("search");
const searchPanel = $("search-results");
const workspaceSection = $("workspace");
const workspaceName = $("workspace-name");
const repoList = $("repo-list");
const repoFilter = $<HTMLInputElement>("repo-filter");
const emptyState = $("empty-state");
const stats = $("stats");
const repoPathEl = $("repo-path");
const reloadBtn = $<HTMLButtonElement>("reload");

const LAST_REPO_KEY = "visualgit.lastRepo";
const WORKSPACE_KEY = "visualgit.workspace";
const welcome = [...emptyState.childNodes].map((n) => n.cloneNode(true));

let workspace: string | null = null;
let repos: RepoInfo[] = [];
let repoPath: string | null = null;
let git: GitRunner | null = null;
let model: Model | null = null;
let selection: Selection | null = null;
/** Incremented per load; a load whose number is stale when it finishes is dropped. */
let loadSeq = 0;
let loadingPath: string | null = null;
/** Per-repository pan/zoom and selection, restored when switching back. */
const saved = new Map<string, { view: View; selection: SavedSelection | null }>();

const explorer = new Explorer(canvas, $("tooltip"), {
  onSelect: (sel) => applySelection(sel, false),
  onContextMenu: (sel) => void showContextMenu(sel),
  onOpenPending: openPendingChanges,
});

// ---- storage ---------------------------------------------------------------

function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: nothing is remembered between sessions.
  }
}

function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// ---- selection ---------------------------------------------------------------

function applySelection(sel: Selection | null, reveal: boolean) {
  selection = sel;
  explorer.select(sel, reveal);
  if (!model || !git || !sel) clearDetails(details);
  else if (sel.kind === "commit") showCommit(details, model, sel.hash, (s) => applySelection(s, true));
  else showBranch(details, model, sel.id, (s) => applySelection(s, true));
  renderBranches();
  updateNav();
}

// ---- context menu and pending changes ---------------------------------------------

async function showContextMenu(sel: Selection) {
  if (!model) return;
  // Pending changes are relative to the checked-out changeset: offered on it and on the checked-out branch.
  const isHead = sel.kind === "commit" ? sel.hash === model.headHash : model.branches[sel.id].isHead;
  const menu = await Menu.new({
    items: [{ id: "pending-changes", text: "Pending Changes", enabled: isHead, action: openPendingChanges }],
  });
  await menu.popup();
}

/** Opens (or brings forward) the Pending Changes window for the open repository. */
function openPendingChanges() {
  if (repoPath) void invoke("open_pending_window", { repo: repoPath }).catch((err) => showMessage("Could not open Pending Changes", String(err)));
}

// ---- search ---------------------------------------------------------------------

const MAX_BRANCH_RESULTS = 50;
const MAX_COMMIT_RESULTS = 200;

let results: SearchResults | null = null;
/** Result rows in display order, for keyboard navigation. */
let resultRows: { sel: Selection; el: HTMLElement }[] = [];
let activeResult = -1;

/** Re-runs the query against the current model; `open` shows the results list. */
function runSearch(open: boolean) {
  results = model ? searchModel(model, searchInput.value) : null;
  explorer.setMatches(results && { commits: new Set(results.commits), branches: new Set(results.branches) });
  activeResult = -1;
  renderResults();
  searchPanel.hidden = !open || !results;
}

/** After a reload or repository switch: same query, new history. */
function refreshSearch() {
  runSearch(!searchPanel.hidden);
}

function clearSearch() {
  searchInput.value = "";
  runSearch(false);
}

function renderResults() {
  if (!results || !model) {
    resultRows = [];
    searchPanel.replaceChildren();
    return;
  }
  const m = model;
  const rows: { sel: Selection; el: HTMLElement }[] = [];
  const nodes: HTMLElement[] = [];
  const div = (cls: string, text = "") => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    return d;
  };
  const addRow = (sel: Selection, ...kids: HTMLElement[]) => {
    const el = div("result");
    el.setAttribute("role", "option");
    el.append(...kids);
    const i = rows.length;
    // Keep focus in the search box, so the list doesn't close before the click lands.
    el.onmousedown = (e) => e.preventDefault();
    el.onclick = () => chooseResult(i, true);
    rows.push({ sel, el });
    nodes.push(el);
  };
  const more = (n: number, what: string) => {
    if (n > 0) nodes.push(div("result-more", `and ${n.toLocaleString()} more ${what}; refine the search to see them`));
  };

  const { branches, commits } = results;
  const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  nodes.push(
    div(
      "result-summary",
      branches.length || commits.length
        ? `${plural(branches.length, "branch", "branches")} · ${plural(commits.length, "changeset", "changesets")}`
        : "No matches",
    ),
  );

  if (branches.length) {
    nodes.push(div("result-head", "Branches"));
    for (const id of branches.slice(0, MAX_BRANCH_RESULTS)) {
      const b = m.branches[id];
      const swatch = div("swatch");
      swatch.style.background = branchColor(m, id);
      addRow({ kind: "branch", id }, swatch, div("result-text", b.name));
    }
    more(branches.length - MAX_BRANCH_RESULTS, "branches");
  }
  if (commits.length) {
    nodes.push(div("result-head", "Changesets"));
    for (const hash of commits.slice(0, MAX_COMMIT_RESULTS)) {
      const c = m.commits.get(hash)!;
      const owner = m.owner.get(hash)!;
      const branch = div("result-meta", m.branches[owner].name);
      branch.style.color = branchColor(m, owner);
      addRow({ kind: "commit", hash }, div("result-id", hash.slice(0, 8)), div("result-text", c.subject || "(no message)"), branch);
    }
    more(commits.length - MAX_COMMIT_RESULTS, "changesets");
  }
  nodes.push(div("result-hint", "* matches anything · ? matches one character · ↑↓ to browse · Enter to go"));
  resultRows = rows;
  searchPanel.replaceChildren(...nodes);
}

function setActiveResult(i: number) {
  resultRows[activeResult]?.el.classList.remove("active");
  activeResult = i;
  const row = resultRows[i];
  if (!row) return;
  row.el.classList.add("active");
  row.el.scrollIntoView({ block: "nearest" });
}

/** Shows a result in the explorer; `close` also hands the keyboard back to the explorer. */
function chooseResult(i: number, close: boolean) {
  const row = resultRows[i];
  if (!row) return;
  setActiveResult(i);
  applySelection(row.sel, true);
  if (close) {
    searchPanel.hidden = true;
    searchInput.blur();
  }
}

searchInput.addEventListener("input", () => runSearch(true));
searchInput.addEventListener("focus", () => {
  if (results) searchPanel.hidden = false;
});
searchInput.addEventListener("blur", () => {
  searchPanel.hidden = true;
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!results) return;
    searchPanel.hidden = false;
    const n = resultRows.length;
    if (n) chooseResult(e.key === "ArrowDown" ? (activeResult + 1) % n : (activeResult - 1 + n) % n, false);
  } else if (e.key === "Enter") {
    e.preventDefault();
    chooseResult(Math.max(activeResult, 0), true);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    clearSearch();
    searchInput.blur();
  }
});

// ---- changeset navigation --------------------------------------------------------

const navPrev = $<HTMLButtonElement>("nav-prev");
const navNext = $<HTMLButtonElement>("nav-next");
const navHome = $<HTMLButtonElement>("nav-home");

/**
 * Where navigation starts when no changeset is selected: a selected branch's
 * latest changeset (or the one it was created from, if empty), else HEAD.
 */
function navAnchor(m: Model): string | null {
  if (selection?.kind === "branch") {
    const b = m.branches[selection.id];
    return b.commits[b.commits.length - 1] ?? b.base;
  }
  return m.headHash && m.commits.has(m.headHash) ? m.headHash : null;
}

/** The changeset before `hash`: its first parent, which leaves a branch at the changeset it was created from. */
function previousOf(m: Model, hash: string): string | null {
  const p = m.commits.get(hash)?.parents[0];
  return p && m.commits.has(p) ? p : null;
}

/** The next changeset on the same branch lane. */
function nextOf(m: Model, hash: string): string | null {
  const b = m.branches[m.owner.get(hash)!];
  return b.commits[b.commits.indexOf(hash) + 1] ?? null;
}

function navTarget(dir: -1 | 1): string | null {
  if (!model) return null;
  // With no changeset selected, the first press lands on the starting changeset.
  if (selection?.kind !== "commit") return navAnchor(model);
  return dir < 0 ? previousOf(model, selection.hash) : nextOf(model, selection.hash);
}

function step(dir: -1 | 1) {
  const target = navTarget(dir);
  if (target) applySelection({ kind: "commit", hash: target }, true);
}

/** Where HEAD is drawn: on uncommitted work (an empty lane or a pending-changes changeset) if there is any, else the checked-out changeset. */
function homeTarget(m: Model | null): Selection | null {
  if (!m) return null;
  const lane = uncommittedHead(m) ?? pendingChangesOn(m);
  if (lane) return { kind: "branch", id: lane.id };
  return m.headHash && m.commits.has(m.headHash) ? { kind: "commit", hash: m.headHash } : null;
}

function goHome() {
  const target = homeTarget(model);
  if (target) applySelection(target, true);
}

function updateNav() {
  navPrev.disabled = navTarget(-1) === null;
  navNext.disabled = navTarget(1) === null;
  navHome.disabled = homeTarget(model) === null;
}

function saveSelection(): SavedSelection | null {
  if (!selection || !model) return null;
  return selection.kind === "commit"
    ? selection
    : { kind: "branch", name: model.branches[selection.id].name };
}

function restoreSelection(m: Model, s: SavedSelection | null | undefined): Selection | null {
  if (!s) return null;
  if (s.kind === "commit") return m.commits.has(s.hash) ? s : null;
  const b = m.branches.find((x) => x.name === s.name);
  return b ? { kind: "branch", id: b.id } : null;
}

function rememberCurrent() {
  if (repoPath && model) saved.set(repoPath, { view: explorer.getView(), selection: saveSelection() });
}

// ---- loading -------------------------------------------------------------------

/**
 * Opens (or reloads) a repository.
 * `remembered`: the path came from a previous session; if it is gone, forget it quietly.
 */
async function loadRepoAt(path: string, opts: { reload?: boolean; remembered?: boolean } = {}) {
  const seq = ++loadSeq;
  if (!opts.reload) {
    loadingPath = path;
    renderRepos();
    stats.textContent = "Loading…";
  }
  reloadBtn.disabled = true;
  try {
    const root = (await tauriRunner(path).run(["rev-parse", "--show-toplevel"])).trim();
    const runner = tauriRunner(root);
    const next = inferModel(await loadRepo(runner));
    const layout = layoutModel(next);
    if (seq !== loadSeq) return; // the user switched to another repository meanwhile

    const switching = root !== repoPath;
    if (switching) rememberCurrent();
    const keptSelection = switching ? saved.get(root)?.selection : saveSelection();
    repoPath = root;
    git = runner;
    model = next;
    store(LAST_REPO_KEY, root);

    repoPathEl.textContent = root;
    repoPathEl.title = root;
    document.title = `${root.split("/").pop()} · VisualGit`;
    stats.textContent =
      `${next.order.length.toLocaleString()} changesets · ${next.branches.length} branches` +
      (next.unpushed.size ? ` · ${next.unpushed.size.toLocaleString()} not pushed` : "") +
      (next.truncated ? " · history truncated" : "");
    if (next.branches.length === 0) showMessage("Empty repository", "This repository has no commits yet.");
    else emptyState.hidden = true;

    explorer.setData(next, layout, switching ? (saved.get(root)?.view ?? "latest") : "keep");
    searchInput.disabled = false;
    refreshSearch();
    applySelection(restoreSelection(next, keptSelection), false);
  } catch (err) {
    if (seq !== loadSeq) return;
    if (opts.remembered) {
      store(LAST_REPO_KEY, null);
      if (!repoPath) showWelcome();
    } else if (!opts.reload || repoPath === path) {
      // A failed switch leaves nothing stale on screen.
      rememberCurrent();
      repoPath = null;
      git = null;
      model = null;
      explorer.clear();
      searchInput.disabled = true;
      refreshSearch();
      applySelection(null, false);
      repoPathEl.textContent = "";
      stats.textContent = "";
      showMessage("Could not open repository", String(err));
    }
  } finally {
    if (seq === loadSeq) {
      loadingPath = null;
      reloadBtn.disabled = repoPath === null;
      renderRepos();
    }
  }
}

async function openWorkspace(path: string, opts: { remembered?: boolean } = {}) {
  try {
    const found = await invoke<RepoInfo[]>("find_repos", { root: path });
    workspace = path;
    repos = found;
    store(WORKSPACE_KEY, path);
    workspaceSection.hidden = false;
    workspaceName.textContent = path.split("/").pop() || path;
    workspaceName.title = path;
    repoFilter.hidden = repos.length <= 8;
    renderRepos();
    return true;
  } catch (err) {
    if (opts.remembered) store(WORKSPACE_KEY, null);
    else showMessage("Could not open workspace", String(err));
    return false;
  }
}

async function rescanWorkspace() {
  if (!workspace) return;
  try {
    repos = await invoke<RepoInfo[]>("find_repos", { root: workspace });
    renderRepos();
  } catch {
    // Workspace folder vanished; keep the last list until the user picks another.
  }
}

const isInside = (path: string, root: string) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

/** After opening a workspace: the last repository if it lives there, else ask the user to pick. */
function openDefaultRepo() {
  const last = recall(LAST_REPO_KEY);
  const target = last && workspace && isInside(last, workspace) ? repos.find((r) => r.path === last) : undefined;
  if (target) void loadRepoAt(target.path, { remembered: true });
  else if (!repoPath) {
    showMessage(
      repos.length ? "Pick a repository" : "No repositories found",
      repos.length
        ? `${repos.length} repositories in this workspace. Choose one on the left.`
        : "No Git repositories were found in this folder or the four levels below it.",
    );
  }
}

// ---- messages ------------------------------------------------------------------

function showWelcome() {
  emptyState.hidden = false;
  emptyState.classList.remove("error");
  emptyState.replaceChildren(...welcome.map((n) => n.cloneNode(true)));
}

function showMessage(title: string, text: string) {
  emptyState.hidden = false;
  emptyState.classList.toggle("error", title.startsWith("Could not"));
  const h = document.createElement("h1");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = text;
  emptyState.replaceChildren(h, p);
}

// ---- sidebar ---------------------------------------------------------------------

/** Workspace repositories, plus the open repository if it lives elsewhere. */
function listedRepos(): RepoInfo[] {
  const list = [...repos];
  if (repoPath && !list.some((r) => r.path === repoPath)) {
    list.unshift({ path: repoPath, name: repoPath.split("/").pop() || repoPath, head: model?.headBranch ?? null, detached: false });
  }
  return list;
}

function renderRepos() {
  const q = repoFilter.value.trim().toLowerCase();
  const items = listedRepos()
    .filter((r) => !q || r.name.toLowerCase().includes(q))
    .map((r) => {
      const item = document.createElement("div");
      item.className = "repo-item";
      if (r.path === repoPath) item.classList.add("selected");
      if (r.path === loadingPath) item.classList.add("loading");
      item.title = r.path;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = r.name;
      const head = document.createElement("span");
      head.className = "head";
      head.textContent = r.head ?? "";
      if (r.detached) head.title = "Detached HEAD";
      item.append(name, head);
      item.onclick = () => {
        if (r.path !== repoPath) void loadRepoAt(r.path);
      };
      return item;
    });
  if (items.length === 0) {
    const none = document.createElement("div");
    none.className = "repo-empty";
    none.textContent = q ? "No matches" : "No repositories found";
    items.push(none);
  }
  repoList.replaceChildren(...items);
  if (workspace || repoPath) workspaceSection.hidden = false;
  $("rescan").hidden = !workspace;
}

function switchRepo(delta: number) {
  const list = listedRepos();
  if (list.length === 0) return;
  const i = list.findIndex((r) => r.path === (loadingPath ?? repoPath));
  const next = list[(i + delta + list.length) % list.length];
  if (next.path !== repoPath) void loadRepoAt(next.path);
}

function renderBranches() {
  if (!model) {
    branchList.replaceChildren();
    return;
  }
  const m = model;
  const selectedBranch =
    selection?.kind === "branch" ? selection.id : selection?.kind === "commit" ? m.owner.get(selection.hash) : undefined;
  const items: HTMLElement[] = [];
  const add = (id: number, depth: number) => {
    const b = m.branches[id];
    const item = document.createElement("div");
    item.className = "branch-item";
    if (id === selectedBranch) item.classList.add("selected");
    if (b.kind === "deleted" || b.kind === "anonymous") item.classList.add("dim");
    item.style.paddingLeft = `${8 + depth * 14}px`;
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = branchColor(m, id);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = b.name;
    name.title = b.name;
    item.append(swatch, name);
    const badge = (text: string, cls = "") => {
      const s = document.createElement("span");
      s.className = `badge ${cls}`;
      s.textContent = text;
      item.append(s);
    };
    if (b.isHead) badge("HEAD", "head");
    if (b.commits.length === 0 && b.kind !== "trunk") badge("empty");
    if (b.kind === "remote") badge("remote");
    const push = pushLabel(m, b);
    if (push) badge(push.replace("not pushed · ", "local · "), "unpushed");
    if (b.kind === "deleted") badge("deleted");
    item.onclick = () => applySelection({ kind: "branch", id }, true);
    item.oncontextmenu = (e) => {
      e.preventDefault();
      applySelection({ kind: "branch", id }, true);
      void showContextMenu({ kind: "branch", id });
    };
    items.push(item);
    for (const c of b.children) add(c, depth + 1);
  };
  for (const b of m.branches) if (b.parent === null) add(b.id, 0);
  branchList.replaceChildren(...items);
}

// ---- commands ----------------------------------------------------------------------

async function chooseWorkspace() {
  const dir = await open({ directory: true, title: "Open workspace folder", defaultPath: workspace ?? undefined });
  if (typeof dir !== "string") return;
  if (await openWorkspace(dir)) {
    // Stay on the current repository if it belongs to the new workspace.
    if (!repoPath || !isInside(repoPath, dir)) {
      rememberCurrent();
      repoPath = null;
      model = null;
      git = null;
      explorer.clear();
      searchInput.disabled = true;
      refreshSearch();
      applySelection(null, false);
      repoPathEl.textContent = "";
      stats.textContent = "";
      openDefaultRepo();
    }
    renderRepos();
  }
}

async function chooseRepo() {
  const dir = await open({ directory: true, title: "Open Git repository" });
  if (typeof dir === "string") await loadRepoAt(dir);
}

function reload() {
  if (repoPath && loadingPath === null) void loadRepoAt(repoPath, { reload: true });
  void rescanWorkspace();
}

$("rescan").addEventListener("click", () => void rescanWorkspace());
reloadBtn.addEventListener("click", reload);
navPrev.addEventListener("click", () => step(-1));
navNext.addEventListener("click", () => step(1));
navHome.addEventListener("click", goHome);
$("zoom-in").addEventListener("click", () => explorer.zoomBy(1.25));
$("zoom-out").addEventListener("click", () => explorer.zoomBy(0.8));
$("zoom-fit").addEventListener("click", () => explorer.fit());
repoFilter.addEventListener("input", renderRepos);

window.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  // ⌘O and ⇧⌘O are File menu accelerators (src-tauri/src/menu.rs).
  if (mod && e.key === "r") {
    e.preventDefault();
    reload();
  } else if (mod && e.key === "f") {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  } else if (mod && e.key === "[") {
    e.preventDefault();
    switchRepo(-1);
  } else if (mod && e.key === "]") {
    e.preventDefault();
    switchRepo(1);
  } else if (e.target instanceof HTMLInputElement) {
    if (e.key === "Escape") e.target.blur();
  } else if (e.key === "+" || e.key === "=") explorer.zoomBy(1.25);
  else if (e.key === "-") explorer.zoomBy(0.8);
  else if (e.key === "0") explorer.fit();
  else if (e.key === "l" || e.key === "L") explorer.latest();
  else if (e.key === "ArrowLeft") {
    e.preventDefault();
    step(-1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    step(1);
  } else if (e.key === "Home") {
    e.preventDefault();
    goHome();
  } else if (e.key === "Escape") {
    // First Escape ends a search, the next clears the selection.
    if (searchInput.value) clearSearch();
    else applySelection(null, false);
  }
});

// File menu commands.
if (inTauri()) {
  void listen<string>("menu", (e) => {
    if (e.payload === "open-workspace") void chooseWorkspace();
    else if (e.payload === "open-repository") void chooseRepo();
  });
  // A commit or save in a Pending Changes window.
  void listen<{ repo: string }>("repo-changed", (e) => {
    if (e.payload.repo === repoPath) reload();
  });
}

// Pick up commits, branch switches and new clones made while the window was in the background.
window.addEventListener("focus", reload);

// ---- startup -------------------------------------------------------------------------

async function start() {
  const fromArgs = await invoke<string | null>("initial_repo");
  const ws = recall(WORKSPACE_KEY);
  const hasWorkspace = ws ? await openWorkspace(ws, { remembered: true }) : false;
  if (fromArgs) void loadRepoAt(fromArgs);
  else if (hasWorkspace) openDefaultRepo();
  else {
    const last = recall(LAST_REPO_KEY);
    if (last) void loadRepoAt(last, { remembered: true });
  }
}

if (!inTauri()) {
  showMessage("Run inside the desktop app", "VisualGit reads repositories through its Tauri backend. Start it with `npm run app`.");
} else {
  void start();
}
