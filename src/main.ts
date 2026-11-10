import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Menu } from "@tauri-apps/api/menu";
import { ask, message, open } from "@tauri-apps/plugin-dialog";
import { loadRepo, type GitRunner } from "./git/load.ts";
import { inTauri, tauriRunner } from "./git/tauriRunner.ts";
import { inferModel, pendingChangesOn, uncommittedHead, type Model } from "./model/infer.ts";
import { layoutModel, type Edge } from "./model/layout.ts";
import { nextOf, previousOf } from "./model/navigate.ts";
import { branchRows, renderBranchList, type BranchSort } from "./view/branchList.ts";
import { clearDetails, showBranch, showCommit } from "./view/details.ts";
import { buildTree, loadFiles, loadLastChanges, type FileList, type Folder, type LastChange } from "./git/files.ts";
import { fileRows, renderFiles, rowKey, type FileRow } from "./view/files.ts";
import { ignorePatterns } from "./git/ignore.ts";
import { branchColor, Explorer, type Selection, type View } from "./view/explorer.ts";
import { filterRepos, renderWorkspaceList, type RepoInfo } from "./view/workspaceList.ts";
import { createPendingView } from "./pending/view.ts";
import { createSearchBox } from "./view/searchBox.ts";

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
const repoNameEl = $("repo-name");
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

const pendingDot = $("pending-dot");
// A commit, save or undo there changes what every other view shows.
const pendingView = createPendingView({ onChanged: () => reload() });

const explorer = new Explorer(canvas, $("tooltip"), {
  onSelect: (sel) => applySelection(sel, false),
  onContextMenu: (sel) => void showContextMenu(sel),
  onOpenPending: () => openPendingChanges(),
  onOpenChangeset: (hash) => openDiffWindow(hash),
  onOpenBranch: (id) => openBranchDiff(id),
  onArrowMenu: (edge) => void showArrowMenu(edge),
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

/** Right-click on a merge arrow: jump to the changeset it comes from, or the one it merges into. */
async function showArrowMenu(edge: Edge) {
  const go = (hash: string) => applySelection({ kind: "commit", hash }, true);
  const menu = await Menu.new({
    items: [
      { id: "arrow-source", text: "Source", action: () => go(edge.from) },
      { id: "arrow-destination", text: "Destination", action: () => go(edge.to) },
    ],
  });
  await menu.popup();
}

async function showContextMenu(sel: Selection) {
  if (!model) return;
  // Pending changes are relative to the checked-out changeset: offered on it and on the checked-out branch.
  const isHead = sel.kind === "commit" ? sel.hash === model.headHash : model.branches[sel.id].isHead;
  const items: ({ id: string; text: string; enabled: boolean; action: () => void } | { item: "Separator" })[] = [
    { id: "pending-changes", text: "Pending Changes", enabled: isHead, action: () => openPendingChanges() },
  ];
  if (sel.kind === "commit") {
    const hash = sel.hash;
    const target = switchTarget(model, hash);
    // The double-click action, so it comes first.
    items.unshift({ id: "view-changes", text: "View Changes", enabled: true, action: () => openDiffWindow(hash) });
    // With a second changeset Ctrl/⌘-clicked, on either of the two.
    const pair = explorer.selectedPair();
    if (pair?.includes(hash)) {
      items.splice(1, 0, { id: "diff-selected", text: "Diff Selected Changesets", enabled: true, action: () => openCompareWindow(pair[0], pair[1]) });
    }
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
      // Cherry pick brings in what HEAD doesn't have; a subtractive merge takes out what it does.
      { id: "cherry-pick", text: "Cherry Pick This Changeset", enabled: !inHead(model, hash), action: () => void applyChangeset(hash, "pick") },
      { id: "subtract", text: "Subtractive Merge", enabled: inHead(model, hash), action: () => void applyChangeset(hash, "subtract") },
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
/** The changesets HEAD contains (itself and everything it was built on), per loaded model. */
const headHistory = new WeakMap<Model, Set<string>>();

function inHead(m: Model, hash: string): boolean {
  let set = headHistory.get(m);
  if (!set) {
    set = new Set();
    const todo = m.headHash ? [m.headHash] : [];
    while (todo.length) {
      const h = todo.pop()!;
      if (set.has(h) || !m.commits.has(h)) continue;
      set.add(h);
      todo.push(...m.commits.get(h)!.parents);
    }
    headHistory.set(m, set);
  }
  return set.has(hash);
}

/**
 * Cherry pick (bring a changeset's changes in) or subtractive merge (take them
 * back out), each as a new changeset; on conflicts, Pending Changes takes over.
 */
async function applyChangeset(hash: string, how: "pick" | "subtract") {
  if (!repoPath || !git || !model) return;
  const path = repoPath;
  const short = hash.slice(0, 8);
  const doing = how === "pick" ? "cherry picking" : "a subtractive merge";
  if (await hasPendingChanges(doing)) return;
  notify(how === "pick" ? `Cherry picking ${short}…` : `Taking ${short}'s changes out…`);
  try {
    const result = await invoke<{ committed: string | null; conflicts: string[] }>(how === "pick" ? "cherry_pick" : "subtractive_merge", {
      repo: path,
      at: hash,
    });
    if (result.committed) {
      notify(
        how === "pick" ? `Cherry picked ${short} as ${result.committed.slice(0, 8)}.` : `Took ${short}'s changes out in ${result.committed.slice(0, 8)}.`,
        "ok",
      );
    } else {
      const n = result.conflicts.length;
      const what = how === "pick" ? `Cherry picking ${short}` : `The subtractive merge of ${short}`;
      notify(`${what} stopped with conflicts in ${n} file${n === 1 ? "" : "s"}. Resolve them in Pending Changes and commit, or abort there.`, "error");
      openPendingChanges();
    }
  } catch (err) {
    notify(`Could not ${how === "pick" ? "cherry pick" : "take out"} ${short}: ${err}`, "error");
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

/** Opens the diff window comparing two changesets, the older one (further left) as "before". */
function openCompareWindow(a: string, b: string) {
  if (!repoPath || !model) return;
  const [before, after] = (model.index.get(a) ?? 0) <= (model.index.get(b) ?? 0) ? [a, b] : [b, a];
  void invoke("open_diff_window", { repo: repoPath, at: after, base: before }).catch((err) => notify(`Could not compare the changesets: ${err}`, "error"));
}

/** Opens the merge window previewing `hash` merged into the checked-out changeset. */
function openMergeWindow(hash: string) {
  if (repoPath) void invoke("open_merge_window", { repo: repoPath, from: hash }).catch((err) => notify(`Could not open the merge window: ${err}`, "error"));
}

/** Switches to the Pending Changes view, showing `path` first if it has pending changes. */
function openPendingChanges(path?: string) {
  showView("pending", { pendingPath: path });
}

// ---- search ---------------------------------------------------------------------

const search = createSearchBox({
  input: searchInput,
  panel: searchPanel,
  model: () => model,
  onResults: (results) => {
    explorer.setMatches(results && { commits: new Set(results.commits), branches: new Set(results.branches) });
    renderBranchView();
  },
  onChoose: (sel) => applySelection(sel, true),
});
const refreshSearch = () => search.refresh();
const clearSearch = () => search.clear();

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

    // The name the Workspace view lists it under (`group/app`), else its folder name; the path is in the tooltip.
    const name = repos.find((r) => r.path === root)?.name ?? (root.split("/").pop() || root);
    repoNameEl.textContent = name;
    repoNameEl.title = root;
    document.title = `${name} · VisualGit`;
    pendingDot.hidden = !next.pendingChanges;
    void pendingView.setRepo(root);
    stats.textContent =
      `${next.order.length.toLocaleString()} changeset${next.order.length === 1 ? "" : "s"} · ${next.branches.length} branch${next.branches.length === 1 ? "" : "es"}` +
      (next.unpushed.size ? ` · ${next.unpushed.size.toLocaleString()} not pushed` : "") +
      (next.truncated ? " · history truncated" : "");
    // A new repository still has its first branch (an empty lane with HEAD on it), so this is rare: e.g. a bare repository.
    if (next.branches.length === 0) showMessage("Empty repository", "This repository has no commits yet.");
    else emptyState.hidden = true;

    explorer.setData(next, layout, switching ? (saved.get(root)?.view ?? "latest") : "keep");
    searchInput.disabled = false;
    refreshSearch();
    applySelection(restoreSelection(next, keptSelection), false);
    void showFiles(); // refreshes the Files view's list (and statuses) if it's showing
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
      repoNameEl.textContent = "";
      repoNameEl.title = "";
      stats.textContent = "";
      pendingDot.hidden = true;
      void pendingView.setRepo(null);
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

// ---- create repository -------------------------------------------------------------

const repoDialog = $<HTMLDialogElement>("repo-dialog");
const repoName = $<HTMLInputElement>("repo-name");
const repoBranch = $<HTMLInputElement>("repo-branch");
const repoOpen = $<HTMLInputElement>("repo-open");
const repoRemote = $<HTMLInputElement>("repo-remote");
const repoRemoteNote = $("repo-remote-note");
const REMOTE_HINT = repoRemoteNote.textContent ?? "";
const repoError = $("repo-error");
const repoCreate = $<HTMLButtonElement>("repo-create");

workspaceView.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  // On a repository's row: that repository's items first. Anywhere else: just Create.
  const path = (e.target as HTMLElement).closest<HTMLElement>("tr[data-path]")?.dataset.path;
  void showWorkspaceMenu(listedRepos().find((r) => r.path === path));
});

/** Mirrors `WebPage` in src-tauri/src/hosting.rs. */
interface WebPage {
  host: string;
  url: string;
  remote: string;
}

async function showWorkspaceMenu(repo?: RepoInfo) {
  const items: ({ id: string; text: string; enabled?: boolean; action?: () => void } | { item: "Separator" })[] = [];
  if (repo) {
    // Where the repository is hosted, from its remote's URL; not knowing just leaves the item disabled.
    const page = await invoke<WebPage | null>("repo_web_page", { repo: repo.path }).catch(() => null);
    items.push(
      // The same as double-clicking the row.
      { id: "switch-repo", text: "Switch Active Repo", action: () => openRepoInExplorer(repo) },
      page
        ? {
            id: "open-web",
            text: `Open on ${page.host}`,
            action: () => void invoke("open_repo_web_page", { repo: repo.path }).catch((err) => notify(`Could not open ${page.url}: ${err}`, "error")),
          }
        : { id: "open-web", text: "Open on Hosting Site (no remote)", enabled: false },
      { item: "Separator" },
    );
  }
  items.push(
    {
      id: "create-repo",
      text: workspace ? "Create New Repository…" : "Create New Repository… (open a workspace first)",
      enabled: !!workspace,
      action: () => openRepoDialog(),
    },
    {
      id: "clone-repo",
      text: workspace ? "Clone Repository…" : "Clone Repository… (open a workspace first)",
      enabled: !!workspace && !cloning,
      action: () => openCloneDialog(),
    },
  );
  const menu = await Menu.new({ items });
  await menu.popup();
}

function openRepoDialog() {
  if (!workspace) return;
  $("repo-workspace").textContent = workspace.split("/").pop() || workspace;
  $("repo-workspace").title = workspace;
  repoName.value = "";
  repoBranch.value = "main";
  repoRemote.value = "";
  repoRemoteNote.textContent = REMOTE_HINT;
  repoError.textContent = "";
  updateRepoDialog();
  repoDialog.showModal();
  repoName.focus();
}

/** The folder the new repository goes in, and anything wrong with the name that's quick to spot. */
function updateRepoDialog() {
  const name = repoName.value.trim().replace(/\/+$/, "");
  $("repo-location").textContent = workspace ? `${workspace}/${name || "…"}` : "";
  const taken = repos.some((r) => r.name === name);
  const inside = repos.find((r) => name.startsWith(`${r.name}/`));
  repoError.textContent = taken
    ? `The workspace already has a repository named “${name}”`
    : inside
      ? `“${inside.name}” is a repository already; a repository can't go inside another one`
      : /\s/.test(repoBranch.value.trim())
        ? "Branch names can't contain spaces"
        : "";
  repoCreate.disabled = !name || !!repoError.textContent;
}

let remoteSeq = 0;
/** Says where the typed remote points ("Pushes to GitHub · https://github.com/you/app"). */
async function describeRemote() {
  const url = repoRemote.value.trim();
  const seq = ++remoteSeq;
  const page = url ? await invoke<WebPage | null>("describe_remote", { url }).catch(() => null) : null;
  if (seq !== remoteSeq) return; // typed on meanwhile
  repoRemoteNote.textContent = page ? `Pushes to ${page.host} · ${page.url}` : REMOTE_HINT;
}

repoName.addEventListener("input", updateRepoDialog);
repoBranch.addEventListener("input", updateRepoDialog);
repoRemote.addEventListener("input", () => {
  updateRepoDialog();
  void describeRemote();
});
$("repo-cancel").addEventListener("click", () => repoDialog.close());

$("repo-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!workspace) return;
  repoCreate.disabled = true;
  try {
    const made = await invoke<RepoInfo>("create_repo", {
      workspace,
      name: repoName.value,
      branch: repoBranch.value.trim() || null,
      remote: repoRemote.value.trim() || null,
    });
    repoDialog.close();
    notify(made.remote ? `Created the repository ${made.name}. Its first Commit & Push publishes it to ${made.remote.host ?? "the remote"}.` : `Created the repository ${made.name}.`, "ok");
    await rescanWorkspace();
    if (repoOpen.checked) void loadRepoAt(made.path);
  } catch (err) {
    repoError.textContent = String(err);
    repoCreate.disabled = false;
  }
});

// ---- clone repository -------------------------------------------------------------

const cloneDialog = $<HTMLDialogElement>("clone-dialog");
const cloneUrl = $<HTMLInputElement>("clone-url");
const cloneName = $<HTMLInputElement>("clone-name");
const cloneOpen = $<HTMLInputElement>("clone-open");
const cloneError = $("clone-error");
const cloneStart = $<HTMLButtonElement>("clone-start");
/** The folder name was typed, not suggested from the URL: leave it alone. */
let cloneNameTyped = false;
/** A clone is running (one at a time). */
let cloning = false;

/** The folder a URL suggests: its last path segment, minus `.git`. */
function folderFromUrl(url: string): string {
  const path = url.trim().replace(/[/\\]+$/, "").replace(/\.git$/i, "");
  return path.split(/[/:\\]/).pop() ?? "";
}

function openCloneDialog() {
  if (!workspace || cloning) return;
  $("clone-workspace").textContent = workspace.split("/").pop() || workspace;
  $("clone-workspace").title = workspace;
  cloneUrl.value = "";
  cloneName.value = "";
  cloneNameTyped = false;
  cloneError.textContent = "";
  updateCloneDialog();
  cloneDialog.showModal();
  cloneUrl.focus();
}

function updateCloneDialog() {
  if (!cloneNameTyped) cloneName.value = folderFromUrl(cloneUrl.value);
  const name = cloneName.value.trim().replace(/\/+$/, "");
  $("clone-location").textContent = workspace ? `${workspace}/${name || "…"}` : "";
  const taken = repos.some((r) => r.name === name);
  const inside = repos.find((r) => name.startsWith(`${r.name}/`));
  cloneError.textContent = taken
    ? `The workspace already has a repository named “${name}”`
    : inside
      ? `“${inside.name}” is a repository already; a repository can't go inside another one`
      : "";
  cloneStart.disabled = !cloneUrl.value.trim() || !name || !!cloneError.textContent;
}

cloneUrl.addEventListener("input", updateCloneDialog);
cloneName.addEventListener("input", () => {
  cloneNameTyped = cloneName.value.trim() !== "";
  updateCloneDialog();
});
$("clone-cancel").addEventListener("click", () => cloneDialog.close());

$("clone-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!workspace || cloning) return;
  const url = cloneUrl.value.trim();
  const name = cloneName.value.trim();
  const at = workspace;
  // The dialog closes; git's progress shows in the corner while it runs.
  cloneDialog.close();
  cloning = true;
  notify(`Cloning ${name}…`);
  const stop = inTauri() ? await listen<string>("clone-progress", (ev) => notify(`Cloning ${name}: ${ev.payload}`)) : () => {};
  try {
    const made = await invoke<RepoInfo>("clone_repo", { workspace: at, url, name });
    notify(`Cloned ${made.name}.`, "ok");
    if (workspace === at) await rescanWorkspace();
    if (cloneOpen.checked) void loadRepoAt(made.path);
  } catch (err) {
    notify(`Could not clone ${url}: ${err}`, "error");
  } finally {
    stop();
    cloning = false;
  }
});

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

type ViewName = "workspace" | "explorer" | "list" | "files" | "pending";
const VIEW_KEY = "visualgit.view";
const listView = $("branch-list-view");
const zoomControls = document.querySelector<HTMLElement>(".zoom")!;
const remembered = recall(VIEW_KEY);
let currentView: ViewName = (["list", "workspace", "files", "pending"] as const).find((v) => v === remembered) ?? "explorer";
let branchSort: BranchSort = "tree";

/** `pendingPath`: with the Pending Changes view, the file to show first. */
function showView(view: ViewName, opts: { pendingPath?: string } = {}) {
  const leaving = currentView;
  currentView = view;
  store(VIEW_KEY, view);
  // Leaving Pending Changes saves any edits there; if that fails they stay in its editor.
  if (leaving === "pending" && view !== "pending") {
    void pendingView.hide().then((ok) => ok || notify("Your edits in Pending Changes could not be saved. They're still there.", "error"));
  }
  $("pc-view").hidden = view !== "pending";
  // The details panel is the Branch Explorer's: what's selected in it.
  document.querySelector(".layout")!.classList.toggle("no-details", view !== "explorer");
  if (view === "pending") void pendingView.show(opts.pendingPath);
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
  $("files-bar").hidden = view !== "files";
  listView.hidden = view !== "list";
  workspaceView.hidden = view !== "workspace";
  filesView.hidden = view !== "files";
  if (!explorerShown) {
    $("tooltip").hidden = true;
    if (searchInput.value) clearSearch();
  } else {
    explorer.select(selection, true); // catch up with what was selected in another view
  }
  renderBranchView();
  renderRepos();
  if (view === "files") void showFiles();
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

// ---- files ---------------------------------------------------------------------------

const filesView = $("files-view");
const fileSearch = $<HTMLInputElement>("file-search");
let files: { repo: string; list: FileList; tree: Folder } | null = null;
/** Expanded folders, per repository. */
const expandedFolders = new Map<string, Set<string>>();
/** The selected row in the Files view: a file path, or a folder path ending in "/". */
let selectedFile: string | null = null;
let filesSeq = 0;
/** Last changes per file, for one repository at one HEAD: history only changes when HEAD moves. */
let lastChanges: { key: string; map: Map<string, LastChange> } | null = null;

const expanded = () => {
  let set = expandedFolders.get(repoPath ?? "");
  if (!set) expandedFolders.set(repoPath ?? "", (set = new Set()));
  return set;
};

/** Loads (or reloads) the file list when the Files view is showing. */
async function showFiles() {
  if (currentView !== "files") return;
  if (!repoPath || !git) {
    files = null;
    filesView.replaceChildren();
    $("file-count").textContent = "";
    return;
  }
  const seq = ++filesSeq;
  const path = repoPath;
  try {
    const list = await loadFiles(git);
    if (seq !== filesSeq || repoPath !== path) return;
    if (files?.repo !== path) selectedFile = null;
    const key = `${path}\0${model?.headHash ?? ""}`;
    if (lastChanges?.key === key) list.last = lastChanges.map;
    files = { repo: path, list, tree: buildTree(list) };
  } catch (err) {
    if (seq === filesSeq) filesView.replaceChildren(Object.assign(document.createElement("div"), { className: "tree-empty", textContent: `Could not list files: ${err}` }));
    return;
  }
  renderFileView();
  if (!files.list.last) void fillLastChanges(seq, path);
}

/** Fills in the date and author columns: one pass over history, after the tree is already showing. */
async function fillLastChanges(seq: number, path: string) {
  const runner = git;
  if (!runner) return;
  const key = `${path}\0${model?.headHash ?? ""}`;
  let map: Map<string, LastChange>;
  try {
    map = await loadLastChanges(runner);
  } catch {
    map = new Map(); // e.g. no changesets yet: every file is "Not committed"
  }
  lastChanges = { key, map };
  if (seq !== filesSeq || files?.repo !== path) return;
  files.list.last = map;
  files.tree = buildTree(files.list);
  renderFileView();
}

function renderFileView() {
  if (currentView !== "files" || !files) return;
  const { list, tree } = files;
  const changed = list.status.size;
  $("file-count").textContent =
    `${list.paths.length.toLocaleString()} file${list.paths.length === 1 ? "" : "s"}` + (changed ? ` · ${changed} with pending changes` : "");
  renderFiles(filesView, tree, list, {
    expanded: expanded(),
    query: fileSearch.value,
    selected: selectedFile,
    onSelect: (r) => selectFileRow(r),
    onOpen: (r) => openFileRow(r),
    onContextMenu: (r) => {
      if (rowKey(r) !== selectedFile) {
        selectedFile = rowKey(r);
        renderFileView();
      }
      if (r.kind === "file") void showFileMenu(r.path);
      else void showFolderMenu(r.folder.path);
    },
  });
}

/** Right-click on the Files view's empty space: things for the top folder. */
filesView.addEventListener("contextmenu", (e) => {
  if (e.defaultPrevented) return; // a row's own menu
  e.preventDefault();
  void showFolderMenu("");
});

/** Opens the Add Submodule window, for a submodule in `folder` ("" for the top of the repository). */
function openAddSubmodule(folder: string) {
  if (!repoPath) return;
  void invoke("open_add_submodule_window", { repo: repoPath, folder, workspace }).catch((err) => notify(`Could not add a submodule: ${err}`, "error"));
}

async function showFolderMenu(folder: string) {
  const menu = await Menu.new({
    items: [{ id: "add-submodule", text: folder ? `Add Submodule in “${folder.slice(folder.lastIndexOf("/") + 1)}”…` : "Add Submodule…", action: () => openAddSubmodule(folder) }],
  });
  await menu.popup();
}

// ---- file right-click menu -------------------------------------------------------------

async function showFileMenu(path: string) {
  if (!files || !repoPath) return;
  const status = files.list.status.get(path);
  const name = path.slice(path.lastIndexOf("/") + 1);
  const untracked = status?.letter === "?";
  const onDisk = status?.letter !== "D";
  const patterns = ignorePatterns(path);
  const dot = name.lastIndexOf(".");
  const ext = patterns.extension ? `*${name.slice(dot)}` : null;
  const menu = await Menu.new({
    items: [
      { id: "open", text: "Open", enabled: onDisk, action: () => void openFile(path) },
      { id: "open-with", text: "Open With…", enabled: onDisk, action: () => void openFileWith(path) },
      { item: "Separator" },
      { id: "history", text: "View History", enabled: !untracked, action: () => openHistory(path) },
      { item: "Separator" },
      {
        text: "Ignore",
        items: [
          { id: "ignore-name", text: `Ignore “${name}”`, action: () => void ignoreFile(path, patterns.name, `every file named ${name}`) },
          {
            id: "ignore-ext",
            text: ext ? `Ignore “${ext}”` : "Ignore by Extension",
            enabled: !!ext,
            action: () => void ignoreFile(path, patterns.extension!, `every ${ext} file`),
          },
          { id: "ignore-path", text: `Ignore “/${path}”`, action: () => void ignoreFile(path, patterns.path, `/${path}`) },
        ],
      },
      { id: "delete", text: "Delete…", action: () => void deleteFile(path, untracked) },
      { item: "Separator" },
      // Next to this file, in its folder.
      { id: "add-submodule", text: "Add Submodule…", action: () => openAddSubmodule(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "") },
    ],
  });
  await menu.popup();
}

async function openFile(path: string) {
  if (!repoPath) return;
  await invoke("open_file", { repo: repoPath, path }).catch((err) => notify(String(err), "error"));
}

async function openFileWith(path: string) {
  if (!repoPath) return;
  const repo = repoPath;
  const platform = navigator.userAgent;
  let app: string | null = null;
  // Windows has its own "Open with" chooser; elsewhere, pick the application here.
  if (!platform.includes("Windows")) {
    const mac = platform.includes("Mac");
    const chosen = await open({
      title: `Open “${path.slice(path.lastIndexOf("/") + 1)}” With`,
      defaultPath: mac ? "/Applications" : "/usr/bin",
      filters: mac ? [{ name: "Applications", extensions: ["app"] }] : undefined,
    });
    if (typeof chosen !== "string") return;
    app = chosen;
  }
  await invoke("open_file_with", { repo, path, app }).catch((err) => notify(String(err), "error"));
}

/** The file's history in the diff window: every changeset that changed it. */
function openHistory(path: string) {
  if (!repoPath || !model?.headHash) return;
  void invoke("open_diff_window", { repo: repoPath, at: model.headHash, file: path }).catch((err) =>
    notify(`Could not open the history of ${path}: ${err}`, "error"),
  );
}

async function ignoreFile(path: string, pattern: string, what: string) {
  if (!repoPath) return;
  try {
    const added = await invoke<boolean>("add_to_gitignore", { repo: repoPath, pattern });
    const tracked = files?.list.status.get(path)?.letter !== "?";
    notify(
      (added ? `Added ${pattern} to .gitignore, so git ignores ${what}.` : `.gitignore already ignores ${what}.`) +
        // gitignore only affects files git doesn't track yet.
        (tracked ? ` ${path} is already in source control, so git keeps tracking it until it's removed (Delete… › Remove from Source Control).` : ""),
      tracked ? "" : "ok", // the tracked-file note stays until read
    );
  } catch (err) {
    notify(`Could not update .gitignore: ${err}`, "error");
    return;
  }
  reload();
}

async function deleteFile(path: string, untracked: boolean) {
  if (!repoPath) return;
  const repo = repoPath;
  const name = path.slice(path.lastIndexOf("/") + 1);
  let fromDisk: boolean;
  if (untracked) {
    // Not in source control: the only thing to do is remove it from disk.
    const ok = await ask(`“${name}” isn't in source control. Move it to the Trash?`, {
      title: "Delete",
      kind: "warning",
      okLabel: "Move to Trash",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    fromDisk = true;
  } else {
    const KEEP = "Remove from Source Control";
    const BOTH = "Remove from Source Control and Disk";
    const choice = await message(
      `Delete “${path}”?

${KEEP}: git stops tracking it; the file stays on disk as a new, untracked file.

${BOTH}: also moves the file to the Trash.

Either way the removal is a pending change: commit it to record it.`,
      { title: "Delete", kind: "warning", buttons: { yes: KEEP, no: BOTH, cancel: "Cancel" } },
    );
    if (choice === "Yes" || choice === KEEP) fromDisk = false;
    else if (choice === "No" || choice === BOTH) fromDisk = true;
    else return;
  }
  try {
    await invoke("remove_file", { repo, path, fromDisk });
    notify(
      untracked
        ? `Moved ${name} to the Trash.`
        : fromDisk
          ? `Removed ${path} from source control and moved it to the Trash. Commit to record the removal.`
          : `Removed ${path} from source control; it's still on disk. Commit to record the removal.`,
      "ok",
    );
  } catch (err) {
    notify(`Could not delete ${path}: ${err}`, "error");
    return;
  }
  if (repoPath === repo) reload();
}

function selectFileRow(r: FileRow) {
  selectedFile = rowKey(r);
  if (r.kind === "folder") toggleFolder(r.folder.path);
  else renderFileView();
}

/** Folders open and close; a file with pending changes opens Pending Changes. */
function openFileRow(r: FileRow) {
  if (r.kind === "file" && files?.list.status.has(r.path)) openPendingChanges(r.path);
}

function toggleFolder(path: string, open?: boolean) {
  const set = expanded();
  if (open ?? !set.has(path)) set.add(path);
  else set.delete(path);
  renderFileView();
}

/** Keyboard in the Files view: ↑/↓ move, ←/→ close/open folders, Enter opens. */
function fileKey(key: string) {
  if (!files) return;
  const rows = fileRows(files.tree, files.list, expanded(), fileSearch.value);
  if (rows.length === 0) return;
  const at = rows.findIndex((r) => rowKey(r) === selectedFile);
  const cur = rows[at];
  if (key === "ArrowUp" || key === "ArrowDown") {
    const next = rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + (key === "ArrowUp" ? -1 : 1)))];
    selectedFile = rowKey(next);
    renderFileView();
  } else if (key === "ArrowRight" && cur?.kind === "folder") {
    toggleFolder(cur.folder.path, true);
  } else if (key === "ArrowLeft" && cur) {
    if (cur.kind === "folder" && expanded().has(cur.folder.path)) toggleFolder(cur.folder.path, false);
    else {
      // Up to the containing folder.
      const path = cur.kind === "folder" ? cur.folder.path : cur.path;
      const i = path.lastIndexOf("/");
      if (i > 0) {
        selectedFile = `${path.slice(0, i)}/`;
        renderFileView();
      }
    }
  } else if (key === "Enter" && cur) {
    if (cur.kind === "folder") toggleFolder(cur.folder.path);
    else openFileRow(cur);
  }
}

fileSearch.addEventListener("input", renderFileView);
fileSearch.addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter") {
    e.preventDefault();
    fileKey(e.key);
  } else if (e.key === "Escape" && fileSearch.value) {
    e.preventDefault();
    e.stopPropagation();
    fileSearch.value = "";
    renderFileView();
  }
});
$("expand-all").addEventListener("click", () => {
  if (!files) return;
  const set = expanded();
  const all = (f: Folder) => f.folders.forEach((s) => (set.add(s.path), all(s)));
  all(files.tree);
  renderFileView();
});
$("collapse-all").addEventListener("click", () => {
  expanded().clear();
  renderFileView();
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
      repoNameEl.textContent = "";
      repoNameEl.title = "";
      stats.textContent = "";
      pendingDot.hidden = true;
      void pendingView.setRepo(null);
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
  void pendingView.refresh();
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
  if (branchDialog.open || repoDialog.open || cloneDialog.open) return; // dialogs handle their own keys (Esc closes them)
  const mod = e.metaKey || e.ctrlKey;
  // ⌘O and ⇧⌘O are File menu accelerators (src-tauri/src/menu.rs).
  if (mod && e.key === "r") {
    e.preventDefault();
    reload();
  } else if (mod && e.key === "f") {
    e.preventDefault();
    // Each view has its own search (Pending Changes has none).
    const box = { list: branchSearch, workspace: repoSearch, files: fileSearch, explorer: searchInput, pending: null }[currentView];
    box?.focus();
    box?.select();
  } else if (mod && e.key === "[") {
    e.preventDefault();
    switchRepo(-1);
  } else if (mod && e.key === "]") {
    e.preventDefault();
    switchRepo(1);
  } else if (currentView === "pending") {
    // The view, its editor and its message box handle their own keys.
  } else if (e.target instanceof HTMLInputElement) {
    if (e.key === "Escape") e.target.blur();
  } else if (currentView === "files" && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(e.key)) {
    e.preventDefault();
    fileKey(e.key);
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
    } else if (currentView === "files" && fileSearch.value) {
      fileSearch.value = "";
      renderFileView();
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
  // A merge made in a merge window.
  void listen<{ repo: string }>("repo-changed", (e) => {
    if (e.payload.repo === repoPath) reload();
  });
  // A submodule added from the Choose Changeset window: it's a pending change now.
  void listen<{ repo: string; path: string; changeset: string }>("submodule-added", (e) => {
    if (e.payload.repo !== repoPath) return;
    reload();
    notify(`Added the submodule ${e.payload.path} at ${e.payload.changeset.slice(0, 8)}. It's staged, with .gitmodules, for your next commit.`, "ok");
  });
  // A merge window that stopped for conflicts (or found pending changes) hands over to Pending Changes.
  void listen<{ repo: string }>("show-pending", async (e) => {
    if (e.payload.repo !== repoPath) await loadRepoAt(e.payload.repo);
    openPendingChanges();
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
