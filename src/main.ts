import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { loadRepo, type GitRunner } from "./git/load.ts";
import { inTauri, tauriRunner } from "./git/tauriRunner.ts";
import { inferModel, type Model } from "./model/infer.ts";
import { layoutModel } from "./model/layout.ts";
import { clearDetails, showBranch, showCommit } from "./view/details.ts";
import { branchColor, Explorer, type Selection } from "./view/explorer.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("explorer");
const details = $("details");
const list = $("branch-list");
const filter = $<HTMLInputElement>("filter");
const emptyState = $("empty-state");
const stats = $("stats");
const repoPathEl = $("repo-path");
const reloadBtn = $<HTMLButtonElement>("reload");

const LAST_REPO_KEY = "visualgit.lastRepo";
const welcome = [...emptyState.childNodes].map((n) => n.cloneNode(true));

let repoPath: string | null = null;
let git: GitRunner | null = null;
let model: Model | null = null;
let selection: Selection | null = null;
let loading = false;

const explorer = new Explorer(canvas, $("tooltip"), { onSelect: (sel) => applySelection(sel, false) });

function applySelection(sel: Selection | null, reveal: boolean) {
  selection = sel;
  explorer.select(sel, reveal);
  if (!model || !git || !sel) clearDetails(details);
  else if (sel.kind === "commit") void showCommit(details, model, sel.hash, git, (s) => applySelection(s, true));
  else showBranch(details, model, sel.id, (s) => applySelection(s, true));
  renderList();
}

/** `remembered`: the path came from a previous session; if it is gone, forget it quietly. */
async function loadPath(path: string, keepView = false, remembered = false) {
  if (loading) return;
  loading = true;
  reloadBtn.disabled = true;
  try {
    const runner = tauriRunner(path);
    const root = (await runner.run(["rev-parse", "--show-toplevel"])).trim();
    const raw = await loadRepo(tauriRunner(root));
    const next = inferModel(raw);
    const layout = layoutModel(next);
    const changed = root !== repoPath;
    repoPath = root;
    git = tauriRunner(root);
    model = next;
    try {
      localStorage.setItem(LAST_REPO_KEY, root);
    } catch {
      // Storage unavailable; we just won't reopen it next time.
    }
    repoPathEl.textContent = root;
    document.title = `${root.split("/").pop()} · VisualGit`;
    stats.textContent =
      `${next.order.length.toLocaleString()} changesets · ${next.branches.length} branches` +
      (next.truncated ? " · history truncated" : "");
    emptyState.hidden = next.branches.length > 0;
    if (next.branches.length === 0) showMessage("Empty repository", "This repository has no commits yet.");
    explorer.setData(next, layout, keepView && !changed);
    // Keep the selection if it still exists after a reload.
    const keep =
      !changed && selection &&
      ((selection.kind === "commit" && next.commits.has(selection.hash)) ||
        (selection.kind === "branch" && next.branches[selection.id]));
    applySelection(keep ? selection : null, false);
  } catch (err) {
    if (remembered) {
      try {
        localStorage.removeItem(LAST_REPO_KEY);
      } catch {
        // ignore
      }
      showWelcome();
    } else {
      showMessage("Could not open repository", String(err));
    }
  } finally {
    loading = false;
    reloadBtn.disabled = repoPath === null;
  }
}

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

function renderList() {
  if (!model) {
    list.replaceChildren();
    return;
  }
  const m = model;
  const q = filter.value.trim().toLowerCase();
  const selectedBranch =
    selection?.kind === "branch" ? selection.id : selection?.kind === "commit" ? m.owner.get(selection.hash) : undefined;
  const items: HTMLElement[] = [];
  const add = (id: number, depth: number) => {
    const b = m.branches[id];
    if (!q || b.name.toLowerCase().includes(q)) {
      const item = document.createElement("div");
      item.className = "branch-item";
      if (id === selectedBranch) item.classList.add("selected");
      if (b.kind === "deleted" || b.kind === "anonymous") item.classList.add("dim");
      item.style.paddingLeft = `${8 + (q ? 0 : depth) * 14}px`;
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
      if (b.kind === "deleted") badge("deleted");
      item.onclick = () => applySelection({ kind: "branch", id }, true);
      items.push(item);
    }
    for (const c of b.children) add(c, depth + 1);
  };
  for (const b of m.branches) if (b.parent === null) add(b.id, 0);
  list.replaceChildren(...items);
}

async function chooseRepo() {
  const dir = await open({ directory: true, title: "Open Git repository" });
  if (typeof dir === "string") await loadPath(dir);
}

$("open").addEventListener("click", () => void chooseRepo());
reloadBtn.addEventListener("click", () => repoPath && void loadPath(repoPath, true));
$("zoom-in").addEventListener("click", () => explorer.zoomBy(1.25));
$("zoom-out").addEventListener("click", () => explorer.zoomBy(0.8));
$("zoom-fit").addEventListener("click", () => explorer.fit());
$("zoom-latest").addEventListener("click", () => explorer.latest());
filter.addEventListener("input", renderList);

window.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === "o") {
    e.preventDefault();
    void chooseRepo();
  } else if (mod && e.key === "r") {
    e.preventDefault();
    if (repoPath) void loadPath(repoPath, true);
  } else if (mod && e.key === "f") {
    e.preventDefault();
    filter.focus();
  } else if (e.target instanceof HTMLInputElement) {
    if (e.key === "Escape") filter.blur();
  } else if (e.key === "+" || e.key === "=") explorer.zoomBy(1.25);
  else if (e.key === "-") explorer.zoomBy(0.8);
  else if (e.key === "0") explorer.fit();
  else if (e.key === "l" || e.key === "L") explorer.latest();
  else if (e.key === "Escape") applySelection(null, false);
});

// Pick up commits/branches made in a terminal while the window was in the background.
window.addEventListener("focus", () => {
  if (repoPath) void loadPath(repoPath, true);
});

if (!inTauri()) {
  showMessage("Run inside the desktop app", "VisualGit reads repositories through its Tauri backend. Start it with `npm run app`.");
  $<HTMLButtonElement>("open").disabled = true;
} else {
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_REPO_KEY);
  } catch {
    // ignore
  }
  void invoke<string | null>("initial_repo").then((fromArgs) => {
    if (fromArgs) void loadPath(fromArgs);
    else if (last) void loadPath(last, false, true);
  });
}
