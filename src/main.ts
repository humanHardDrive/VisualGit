import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Menu } from "@tauri-apps/api/menu";
import { open } from "@tauri-apps/plugin-dialog";
import { loadRepo, type GitRunner } from "./git/load.ts";
import { inTauri, tauriRunner } from "./git/tauriRunner.ts";
import { inferModel, pendingChangesOn, uncommittedHead, type Model } from "./model/infer.ts";
import { layoutModel } from "./model/layout.ts";
import { searchModel, type SearchResults } from "./model/search.ts";
import { branchRows, renderBranchList, type BranchSort } from "./view/branchList.ts";
import { clearDetails, showBranch, showCommit } from "./view/details.ts";
import { branchColor, Explorer, type Selection, type View } from "./view/explorer.ts";
import { filterRepos, renderWorkspaceList, type RepoInfo } from "./view/workspaceList.ts";

/** Selection saved across reloads; branches by name, since ids are reassigned. */
type SavedSelection = { kind: "commit"; hash: string } | { kind: "branch"; name: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("explorer");
const details = $("details");
const searchInput = $<HTMLInputElement>("search");
const searchPanel = $("search-results");
const workspaceName = $("workspace-name");
const workspaceView = $("workspace-view");
const repoSearch = $<HTMLInputElement>("repo-search");
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
  onOpenChangeset: (hash) => openDiffWindow(hash),
  onOpenBranch: (id) => openBranchDiff(id),
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
  // The explorer only scrolls to the selection while it's on screen (see showView).
  explorer.select(sel, reveal && currentView === "explorer");
  if (!model || !git || !sel) clearDetails(details);
  else if (sel.kind === "commit") showCommit(details, model, sel.hash, (s) => applySelection(s, true));
  else showBranch(details, model, sel.id, (s) => applySelection(s, true));
  renderBranchView();
  updateNav();
}

// ---- context menu and pending changes ---------------------------------------------

async function showContextMenu(sel: Selection) {
  if (!model) return;
  // Pending changes are relative to the checked-out changeset: offered on it and on the checked-out branch.
  const isHead = sel.kind === "commit" ? sel.hash === model.headHash : model.branches[sel.id].isHead;
  const items: ({ id: string; text: string; enabled: boolean; action: () => void } | { item: "Separator" })[] = [
    { id: "pending-changes", text: "Pending Changes", enabled: isHead, action: openPendingChanges },
  ];
  if (sel.kind === "commit") {
    const hash = sel.hash;
    const target = switchTarget(model, hash);
    // The double-click action, so it comes first.
    items.unshift({ id: "view-changes", text: "View Changes", enabled: true, action: () => openDiffWindow(hash) });
    items.push(
      { item: "Separator" },
      {
        id: "switch",
        text: target.branch ? `Switch to This Changeset (${target.branch})` : "Switch to This Changeset",
        enabled: !target.current,
        action: () => void switchTo(hash, target.branch),
      },
      { id: "create-branch", text: "Create Branch from This Changeset", enabled: true, action: () => openBranchDialog(hash) },
      { item: "Separator" },
      // Merging the checked-out changeset into itself would do nothing.
      { id: "merge-from", text: "Merge from This Changeset", enabled: hash !== model.headHash, action: () => openMergeWindow(hash) },
      { id: "cherry-pick", text: "Cherry Pick This Changeset", enabled: hash !== model.headHash, action: () => void cherryPick(hash) },
    );
  }
  if (sel.kind === "branch") {
    const b = model.branches[sel.id];
    const id = sel.id;
    // The double-click action, so it comes first; a branch with no changesets has nothing to show.
    items.unshift({ id: "view-branch-changes", text: "View Changes", enabled: b.commits.length > 0, action: () => openBranchDiff(id) });
    const go = switchToBranchCall(b);
    items.push({ id: "switch-branch", text: "Switch to This Branch", enabled: !!go && !b.isHead, action: () => go && void runSwitch(b.name, go) });
    const local = b.refs.find((r) => r.startsWith("refs/heads/"));
    if (local) {
      const name = local.slice("refs/heads/".length);
      // Offered while there is something to push: unpushed changesets, or a branch never pushed.
      const text = !b.published ? "Push (new branch)" : b.unpushed ? `Push (↑${b.unpushed})` : "Push (up to date)";
      items.push({ id: "push", text, enabled: !b.published || b.unpushed > 0, action: () => void pushBranch(name) });
    }
  }
  const menu = await Menu.new({ items });
  await menu.popup();
}

// ---- switch ----------------------------------------------------------------------

/**
 * What switching to `hash` checks out: a local branch whose tip it is (the
 * lane's own branch first), else the changeset itself as a detached HEAD.
 * `current` when that is what's checked out already.
 */
function switchTarget(m: Model, hash: string): { branch?: string; current: boolean } {
  const tipOf = (b: Model["branches"][number]) => {
    const local = b.refs.find((r) => r.startsWith("refs/heads/"));
    return local && b.tips[0] === hash ? local.slice("refs/heads/".length) : undefined;
  };
  const names = m.branches.map(tipOf).filter((n): n is string => !!n);
  if (hash === m.headHash && (m.headBranch ? names.includes(m.headBranch) : names.length === 0)) {
    return { branch: m.headBranch, current: true };
  }
  const lane = tipOf(m.branches[m.owner.get(hash)!]);
  return { branch: lane ?? names[0], current: false };
}

function switchTo(hash: string, branch: string | undefined) {
  void runSwitch(branch ?? hash.slice(0, 8), (repo) => invoke<string>("switch_to_changeset", { repo, at: hash, branch: branch ?? null }));
}

/**
 * How "Switch to This Branch" gets there: a local branch is checked out; a
 * remote-only one gets a local tracking branch; a deleted or unnamed lane's
 * last changeset is checked out as a detached HEAD.
 */
function switchToBranchCall(b: Model["branches"][number]): ((repo: string) => Promise<string>) | null {
  const local = b.refs.find((r) => r.startsWith("refs/heads/"));
  if (local) {
    const name = local.slice("refs/heads/".length);
    return (repo) => invoke<string>("switch_to_changeset", { repo, at: b.tips[0], branch: name });
  }
  const remote = b.refs.find((r) => r.startsWith("refs/remotes/"));
  if (remote) return (repo) => invoke<string>("switch_to_remote_branch", { repo, remoteRef: remote });
  const last = b.commits[b.commits.length - 1];
  return last ? (repo) => invoke<string>("switch_to_changeset", { repo, at: last, branch: null }) : null;
}

/** Applies a changeset on top of HEAD; on conflicts, Pending Changes takes over. */
async function cherryPick(hash: string) {
  if (!repoPath || !git || !model) return;
  const path = repoPath;
  const short = hash.slice(0, 8);
  if (await hasPendingChanges("cherry picking")) return;
  notify(`Cherry picking ${short}…`);
  try {
    const result = await invoke<{ committed: string | null; conflicts: string[] }>("cherry_pick", { repo: path, at: hash });
    if (result.committed) {
      notify(`Cherry picked ${short} as ${result.committed.slice(0, 8)}.`, "ok");
    } else {
      const n = result.conflicts.length;
      notify(`Cherry picking ${short} stopped with conflicts in ${n} file${n === 1 ? "" : "s"}. Resolve them in Pending Changes and commit, or abort there.`, "error");
      openPendingChanges();
    }
  } catch (err) {
    notify(`Could not cherry pick ${short}: ${err}`, "error");
    return;
  }
  if (repoPath !== path) return;
  await loadRepoAt(path, { reload: true });
  goHome();
}

/**
 * True (after opening Pending Changes) when tracked files have uncommitted
 * changes, which should be committed before `doing` something to HEAD.
 * Untracked files don't get in the way and simply stay put.
 */
async function hasPendingChanges(doing: string): Promise<boolean> {
  const status = await git!.run(["status", "--porcelain", "-z", "--untracked-files=no"]).catch(() => "");
  if (!status) return false;
  openPendingChanges();
  notify(`You have pending changes. Commit them in Pending Changes before ${doing}.`);
  return true;
}

/** Runs a switch unless there are pending changes, then reloads and shows the new HEAD. */
async function runSwitch(label: string, call: (repo: string) => Promise<string>) {
  if (!repoPath || !git) return;
  const path = repoPath;
  if (await hasPendingChanges("switching")) return;
  notify(`Switching to ${label}…`);
  try {
    notify(`${await call(path)}.`, "ok");
  } catch (err) {
    notify(`Could not switch: ${err}`, "error");
    return;
  }
  if (repoPath !== path) return;
  await loadRepoAt(path, { reload: true });
  goHome();
}

// ---- create branch -----------------------------------------------------------------

const branchDialog = $<HTMLDialogElement>("branch-dialog");
const branchName = $<HTMLInputElement>("branch-name");
const branchSwitch = $<HTMLInputElement>("branch-switch");
const branchError = $("branch-error");
const branchCreate = $<HTMLButtonElement>("branch-create");
let branchAt: string | null = null;

function openBranchDialog(hash: string) {
  if (!model) return;
  branchAt = hash;
  const owner = model.branches[model.owner.get(hash)!];
  $("branch-from").textContent = hash.slice(0, 8);
  $("branch-from-branch").textContent = owner.name;
  $("branch-from-branch").style.color = branchColor(model, owner.id);
  branchName.value = "";
  branchError.textContent = "";
  // Switching from the checked-out changeset just carries any work in progress along.
  branchSwitch.checked = hash === model.headHash;
  branchCreate.disabled = true;
  branchDialog.showModal();
  branchName.focus();
}

branchName.addEventListener("input", () => {
  const name = branchName.value.trim();
  const taken = model?.branches.some((b) => b.name === name && b.refs.some((r) => r === `refs/heads/${name}`));
  branchError.textContent = taken ? `A branch named “${name}” already exists` : /\s/.test(name) ? "Branch names can't contain spaces" : "";
  branchCreate.disabled = !name || !!branchError.textContent;
});
$("branch-cancel").addEventListener("click", () => branchDialog.close());

$("branch-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!repoPath || !branchAt) return;
  const path = repoPath;
  const name = branchName.value.trim();
  branchCreate.disabled = true;
  try {
    const result = await invoke<{ switched: boolean; switchError: string | null }>("create_branch", {
      repo: path,
      name,
      at: branchAt,
      switchTo: branchSwitch.checked,
    });
    branchDialog.close();
    if (result.switchError) notify(`Created ${name}, but could not switch to it: ${result.switchError}`, "error");
    else notify(result.switched ? `Created ${name} and switched to it.` : `Created ${name}.`, "ok");
    if (repoPath !== path) return;
    await loadRepoAt(path, { reload: true });
    const created = model?.branches.find((b) => b.name === name);
    if (created) applySelection({ kind: "branch", id: created.id }, true);
  } catch (err) {
    branchError.textContent = String(err);
    branchCreate.disabled = false;
  }
});

const toast = $("toast");
let toastTimer = 0;

/** A short notice in the explorer's corner; errors stay until clicked. */
function notify(text: string, kind: "" | "ok" | "error" = "") {
  clearTimeout(toastTimer);
  toast.textContent = text;
  toast.className = `toast ${kind}`;
  toast.hidden = false;
  if (kind === "ok") toastTimer = window.setTimeout(() => (toast.hidden = true), 4000);
}
toast.addEventListener("click", () => (toast.hidden = true));

async function pushBranch(branch: string) {
  if (!repoPath) return;
  const path = repoPath;
  notify(`Pushing ${branch}…`);
  try {
    notify(`${await invoke<string>("push_branch", { repo: path, branch })}.`, "ok");
  } catch (err) {
    notify(`Could not push ${branch}: ${err}`, "error");
  }
  if (repoPath === path) reload();
}

/** Opens the diff window showing what changeset `hash` changed. */
function openDiffWindow(hash: string) {
  if (repoPath) void invoke("open_diff_window", { repo: repoPath, at: hash }).catch((err) => notify(`Could not open the changeset: ${err}`, "error"));
}

/**
 * Opens the diff window with everything branch `id` changed: from the
 * changeset it was created from (or from nothing, for a root branch) to its
 * latest changeset.
 */
function openBranchDiff(id: number) {
  if (!repoPath || !model) return;
  const b = model.branches[id];
  const tip = b.commits[b.commits.length - 1];
  if (!tip) {
    notify(`${b.name} has no changesets of its own yet, so it hasn't changed anything.`, "ok");
    return;
  }
  void invoke("open_diff_window", { repo: repoPath, at: tip, branch: b.name, base: b.base }).catch((err) =>
    notify(`Could not open the changes on ${b.name}: ${err}`, "error"),
  );
}

/** Opens the merge window previewing `hash` merged into the checked-out changeset. */
function openMergeWindow(hash: string) {
  if (repoPath) void invoke("open_merge_window", { repo: repoPath, from: hash }).catch((err) => notify(`Could not open the merge window: ${err}`, "error"));
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
  renderBranchView();
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
        ? `${repos.length} repositories in this workspace. Choose one in the Workspace view.`
        : "No Git repositories were found in this folder or the four levels below it.",
    );
    // Show the list to pick from.
    showView("workspace");
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
  workspaceName.textContent = workspace ? workspace.split("/").pop() || workspace : "No workspace open";
  workspaceName.title = workspace ?? "";
  ($("rescan") as HTMLButtonElement).disabled = !workspace;
  const list = listedRepos();
  const shown = filterRepos(list, repoSearch.value).length;
  $("repo-count").textContent = repoSearch.value.trim()
    ? `${shown} of ${list.length} repositories`
    : `${list.length} repositor${list.length === 1 ? "y" : "ies"}`;
  if (currentView !== "workspace") return;
  renderWorkspaceList(workspaceView, list, {
    current: repoPath,
    loading: loadingPath,
    query: repoSearch.value,
    empty: workspace
      ? "No Git repositories were found in this folder or the four levels below it."
      : "No workspace is open. Choose Open Workspace… and pick the folder you keep your repositories in.",
    onOpen: (r) => {
      if (r.path !== repoPath) void loadRepoAt(r.path);
    },
    onActivate: (r) => openRepoInExplorer(r),
  });
}

/** Opens a repository (if it isn't already) and shows it in the Branch Explorer. */
function openRepoInExplorer(r: RepoInfo) {
  if (r.path !== repoPath) void loadRepoAt(r.path);
  showView("explorer");
}

function switchRepo(delta: number) {
  const list = listedRepos();
  if (list.length === 0) return;
  const i = list.findIndex((r) => r.path === (loadingPath ?? repoPath));
  const next = list[(i + delta + list.length) % list.length];
  if (next.path !== repoPath) void loadRepoAt(next.path);
}

// ---- views ---------------------------------------------------------------------

type ViewName = "workspace" | "explorer" | "list";
const VIEW_KEY = "visualgit.view";
const listView = $("branch-list-view");
const zoomControls = document.querySelector<HTMLElement>(".zoom")!;
const remembered = recall(VIEW_KEY);
let currentView: ViewName = remembered === "list" || remembered === "workspace" ? remembered : "explorer";
let branchSort: BranchSort = "tree";

function showView(view: ViewName) {
  currentView = view;
  store(VIEW_KEY, view);
  for (const item of document.querySelectorAll<HTMLButtonElement>(".view-item")) {
    item.setAttribute("aria-pressed", String(item.dataset.view === view));
  }
  const explorerShown = view === "explorer";
  $("canvas-wrap").dataset.view = view;
  canvas.hidden = !explorerShown;
  zoomControls.hidden = !explorerShown;
  // Each view has its own bar: the explorer's (reload, changeset browsing, search), the list's and the workspace's searches.
  $("explorer-bar").hidden = !explorerShown;
  $("list-bar").hidden = view !== "list";
  $("workspace-bar").hidden = view !== "workspace";
  listView.hidden = view !== "list";
  workspaceView.hidden = view !== "workspace";
  if (!explorerShown) {
    $("tooltip").hidden = true;
    if (searchInput.value) clearSearch();
  } else {
    explorer.select(selection, true); // catch up with what was selected in another view
  }
  renderBranchView();
  renderRepos();
}

for (const item of document.querySelectorAll<HTMLButtonElement>(".view-item")) {
  item.addEventListener("click", () => showView(item.dataset.view as ViewName));
}

/** The branch the selection belongs to: the selected branch, or the selected changeset's lane. */
function selectedBranchId(m: Model): number | undefined {
  return selection?.kind === "branch" ? selection.id : selection?.kind === "commit" ? m.owner.get(selection.hash) : undefined;
}

function renderBranchView() {
  if (currentView !== "list") return;
  if (!model) {
    listView.replaceChildren();
    return;
  }
  const m = model;
  const query = branchSearch.value;
  const shown = branchRows(m, branchSort, query).length;
  $("branch-count").textContent = query.trim() ? `${shown} of ${m.branches.length} branches` : `${m.branches.length} branches`;
  renderBranchList(listView, m, {
    selected: selectedBranchId(m),
    sort: branchSort,
    query,
    onSelect: (id) => applySelection({ kind: "branch", id }, true),
    onOpen: (id) => openBranchDiff(id),
    onContextMenu: (id) => {
      applySelection({ kind: "branch", id }, true);
      void showContextMenu({ kind: "branch", id });
    },
    onSort: (sort) => {
      branchSort = sort;
      renderBranchView();
    },
  });
}

const branchSearch = $<HTMLInputElement>("branch-search");
branchSearch.addEventListener("input", () => renderBranchView());
branchSearch.addEventListener("keydown", (e) => {
  // Browse the matches without leaving the search box.
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    stepRow(e.key === "ArrowUp" ? -1 : 1);
  } else if (e.key === "Enter" && selection?.kind === "branch") {
    e.preventDefault();
    openBranchDiff(selection.id);
  } else if (e.key === "Escape" && branchSearch.value) {
    e.preventDefault();
    e.stopPropagation();
    branchSearch.value = "";
    renderBranchView();
  }
});

/** ↑/↓ in the Branch List: select the row above or below. */
function stepRow(dir: 1 | -1) {
  if (!model) return;
  const rows = branchRows(model, branchSort, branchSearch.value);
  if (rows.length === 0) return;
  const at = rows.findIndex((r) => r.id === selectedBranchId(model!));
  const next = rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + dir))];
  applySelection({ kind: "branch", id: next.id }, true);
}

// ---- commands ----------------------------------------------------------------------

async function chooseWorkspace() {
  const dir = await open({ directory: true, title: "Open workspace folder", defaultPath: workspace ?? undefined });
  if (typeof dir !== "string") return;
  if (await openWorkspace(dir)) {
    showView("workspace");
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
repoSearch.addEventListener("input", renderRepos);
repoSearch.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    // Open the first match.
    const first = filterRepos(listedRepos(), repoSearch.value)[0];
    if (first) openRepoInExplorer(first);
  } else if (e.key === "Escape" && repoSearch.value) {
    e.preventDefault();
    e.stopPropagation();
    repoSearch.value = "";
    renderRepos();
  }
});
$("open-workspace").addEventListener("click", () => void chooseWorkspace());

window.addEventListener("keydown", (e) => {
  if (branchDialog.open) return; // the dialog handles its own keys (Esc closes it)
  const mod = e.metaKey || e.ctrlKey;
  // ⌘O and ⇧⌘O are File menu accelerators (src-tauri/src/menu.rs).
  if (mod && e.key === "r") {
    e.preventDefault();
    reload();
  } else if (mod && e.key === "f") {
    e.preventDefault();
    // Each view has its own search.
    const box = currentView === "list" ? branchSearch : currentView === "workspace" ? repoSearch : searchInput;
    box.focus();
    box.select();
  } else if (mod && e.key === "[") {
    e.preventDefault();
    switchRepo(-1);
  } else if (mod && e.key === "]") {
    e.preventDefault();
    switchRepo(1);
  } else if (e.target instanceof HTMLInputElement) {
    if (e.key === "Escape") e.target.blur();
  } else if (currentView === "list" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    stepRow(e.key === "ArrowUp" ? -1 : 1);
  } else if (currentView === "list" && e.key === "Enter" && selection?.kind === "branch") {
    openBranchDiff(selection.id);
  } else if (currentView === "explorer" && (e.key === "+" || e.key === "=")) explorer.zoomBy(1.25);
  else if (currentView === "explorer" && e.key === "-") explorer.zoomBy(0.8);
  else if (currentView === "explorer" && e.key === "0") explorer.fit();
  else if (currentView === "explorer" && (e.key === "l" || e.key === "L")) explorer.latest();
  else if (currentView === "explorer" && e.key === "ArrowLeft") {
    e.preventDefault();
    step(-1);
  } else if (currentView === "explorer" && e.key === "ArrowRight") {
    e.preventDefault();
    step(1);
  } else if (currentView === "explorer" && e.key === "Home") {
    e.preventDefault();
    goHome();
  } else if (e.key === "Escape") {
    // First Escape ends a search, the next clears the selection.
    if (currentView === "list" && branchSearch.value) {
      branchSearch.value = "";
      renderBranchView();
    } else if (currentView === "workspace" && repoSearch.value) {
      repoSearch.value = "";
      renderRepos();
    } else if (searchInput.value) clearSearch();
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

showView(currentView);

if (!inTauri()) {
  showMessage("Run inside the desktop app", "VisualGit reads repositories through its Tauri backend. Start it with `npm run app`.");
} else {
  void start();
}
