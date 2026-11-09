/**
 * Merge window: previews merging a changeset ("from") into the checked-out
 * changeset ("into"). Lists the files the merge changes, flags conflicts, and
 * shows each file's merge result next to either side. Nothing in the
 * repository changes until Merge is clicked, which always makes a merge
 * changeset (never a fast-forward), so the branch explorer keeps showing
 * where the merged changesets came from.
 */

import { goToNextChunk, goToPreviousChunk, MergeView } from "@codemirror/merge";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { basicSetup } from "codemirror";
import { loadRepo } from "../git/load.ts";
import { tauriRunner } from "../git/tauriRunner.ts";
import { inferModel, type Model } from "../model/infer.ts";
import { dark, lineEndings, readOnly, theme, themeSlot } from "../view/codemirror.ts";
import { branchColor } from "../view/explorer.ts";

/** Mirrors `MergeFile` / `MergePreview` in src-tauri/src/merge.rs. */
interface MergeFile {
  path: string;
  origPath: string | null;
  status: "A" | "M" | "D" | "R" | "C" | "T";
  conflict: boolean;
}
interface MergePreview {
  to: string;
  toBranch: string | null;
  from: string;
  base: string | null;
  kind: "up-to-date" | "fast-forward" | "merge";
  tree: string | null;
  files: MergeFile[];
  messages: string[];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fileList = $("file-list");
const diffHost = $("diff");
const diffMessage = $("diff-message");
const diffTitle = $("diff-title");
const changeCount = $("change-count");
const prevBtn = $<HTMLButtonElement>("prev-change");
const nextBtn = $<HTMLButtonElement>("next-change");
const cmpTo = $<HTMLButtonElement>("cmp-to");
const cmpFrom = $<HTMLButtonElement>("cmp-from");
const mergeBtn = $<HTMLButtonElement>("merge");

let repo = "";
let from = "";
let preview: MergePreview | null = null;
let model: Model | null = null;
let current: MergeFile | null = null;
/** Which side the result is compared with. */
let compareWith: "to" | "from" = "to";
let view: MergeView | null = null;
/** A merge, cherry pick or subtractive merge stopped for conflicts, if any. */
let operation: { kind: string; from: string | null } | null = null;
/** The merge changeset this window made, once it has. */
let mergedAs: string | null = null;
let merging = false;

const span = (cls: string, text: string) => Object.assign(document.createElement("span"), { className: cls, textContent: text });
const git = () => tauriRunner(repo);

const STATUS_NAMES: Record<MergeFile["status"], string> = {
  A: "Added by the merge",
  M: "Modified by the merge",
  D: "Deleted by the merge",
  R: "Renamed by the merge",
  C: "Copied by the merge",
  T: "Type changed by the merge",
};

/** A file's text at `rev` (a changeset or the merged tree), "" if it isn't there, null if binary. */
async function textAt(rev: string | null, path: string): Promise<string | null> {
  if (!rev) return "";
  try {
    const text = await git().run(["show", `${rev}:${path}`]);
    return text.includes("\0") ? null : text;
  } catch {
    return "";
  }
}

// ---- header ------------------------------------------------------------------------------

/** The branch whose lane a changeset is on, from the explorer's inference. */
function laneOf(hash: string) {
  const id = model?.owner.get(hash);
  return id === undefined ? null : model!.branches[id];
}

function showEnd(which: "from" | "to", hash: string, branchName: string | null) {
  const lane = laneOf(hash);
  const name = branchName ?? lane?.name ?? "(detached)";
  const el = $(`${which}-branch`);
  el.textContent = name;
  const coloured = model && lane && (branchName === null || lane.name === branchName) ? branchColor(model, lane.id) : "";
  el.style.color = coloured;
  $(`${which}-id`).textContent = hash.slice(0, 8);
  $(`${which}-subject`).textContent = model?.commits.get(hash)?.subject ?? "";
}

function renderHeader(p: MergePreview) {
  showEnd("from", p.from, null);
  showEnd("to", p.to, p.toBranch);
  document.title = `Merge ${laneOf(p.from)?.name ?? p.from.slice(0, 8)} into ${p.toBranch ?? p.to.slice(0, 8)}`;

  const summary = $("summary");
  const conflicts = p.files.filter((f) => f.conflict).length;
  const files = `${p.files.length} file${p.files.length === 1 ? "" : "s"}`;
  if (p.kind === "up-to-date") {
    summary.textContent = mergedAs
      ? `Merged as ${mergedAs.slice(0, 8)}.`
      : "Already merged: everything in this changeset is already in the checked-out changeset.";
    summary.className = "clean";
  } else if (operation) {
    summary.textContent =
      operation.kind === "merge" && operation.from === p.from
        ? "This merge is in progress. Resolve its conflicts in Pending Changes and commit, or abort it there."
        : `A ${operation.kind} is in progress. Finish or abort it in Pending Changes before merging.`;
    summary.className = "conflicts";
  } else if (conflicts) {
    summary.textContent = `${files} change · ${conflicts} conflict${conflicts === 1 ? "" : "s"} to resolve`;
    summary.className = "conflicts";
  } else {
    // git would fast-forward here; the merge still gets a changeset of its own.
    summary.textContent = `${files} change · merges cleanly${p.kind === "fast-forward" ? " (nothing new in the destination; still recorded as a merge)" : ""}`;
    summary.className = "clean";
  }
  updateMergeButton(p, conflicts);

  const messages = $<HTMLDetailsElement>("messages");
  messages.hidden = p.messages.length === 0;
  $("messages-text").textContent = p.messages.join("\n");

  $("base-info").textContent = p.base ? `Common ancestor ${p.base.slice(0, 8)}` : "No common history";
  $("file-count").textContent = p.kind === "up-to-date" ? "Nothing to merge" : files;
}

// ---- merging -------------------------------------------------------------------------

/** The local branch being merged, when `from` is its tip: for "Merge branch 'x' into y". */
function mergedBranch(hash: string): string | undefined {
  const lane = laneOf(hash);
  const local = lane?.refs.find((r) => r.startsWith("refs/heads/"));
  return lane && local && lane.tips[0] === hash ? local.slice("refs/heads/".length) : undefined;
}

function updateMergeButton(p: MergePreview, conflicts: number) {
  mergeBtn.disabled = merging || p.kind === "up-to-date" || !!operation;
  mergeBtn.textContent = merging ? "Merging…" : "Merge";
  const into = p.toBranch ?? p.to.slice(0, 8);
  mergeBtn.title = conflicts
    ? `Merge into ${into}, then resolve the ${conflicts} conflict${conflicts === 1 ? "" : "s"} in Pending Changes`
    : `Merge into ${into} as a new merge changeset`;
}

async function runMerge() {
  const p = preview;
  if (!p || merging) return;
  const summary = $("summary");
  // Pending changes would be mixed into the merge (or block it): commit or undo them first.
  const status = await git().run(["status", "--porcelain", "-z", "--untracked-files=no"]).catch(() => "");
  if (status) {
    summary.textContent = "There are pending changes. Commit or undo them in Pending Changes, then merge.";
    summary.className = "conflicts";
    void invoke("open_pending_window", { repo });
    return;
  }
  merging = true;
  updateMergeButton(p, p.files.filter((f) => f.conflict).length);
  try {
    const result = await invoke<{ committed: string | null; conflicts: string[] }>("merge", { repo, from: p.from, branch: mergedBranch(p.from) ?? null });
    void emit("repo-changed", { repo });
    if (result.committed) {
      mergedAs = result.committed;
    } else {
      // The merge is in progress: Pending Changes shows it, with the conflicts to resolve.
      void invoke("open_pending_window", { repo });
    }
  } catch (err) {
    merging = false;
    summary.textContent = `Could not merge: ${err}`;
    summary.className = "conflicts";
    updateMergeButton(p, 0);
    return;
  }
  merging = false;
  await refresh();
}

mergeBtn.addEventListener("click", () => void runMerge());

// ---- file list ------------------------------------------------------------------------

function renderFiles() {
  const files = preview?.files ?? [];
  const rows = files.map((f) => {
    const row = document.createElement("div");
    row.className = "pfile";
    row.setAttribute("role", "option");
    if (f.path === current?.path) row.classList.add("current");
    const status = f.conflict ? span("file-status st-U", "!") : span(`file-status st-${f.status}`, f.status);
    const title = f.conflict ? "Conflict: git can't merge this on its own" : STATUS_NAMES[f.status];
    row.title = f.origPath ? `${title}: ${f.origPath} → ${f.path}` : `${title}: ${f.path}`;
    const slash = f.path.lastIndexOf("/");
    const path = document.createElement("span");
    path.className = "file-path";
    if (slash >= 0) path.append(span("file-dir", f.path.slice(0, slash + 1)));
    path.append(span("file-name", f.path.slice(slash + 1)));
    row.append(status, path);
    if (f.conflict) row.append(span("conflict-badge", "conflict"));
    row.onclick = () => void selectFile(f);
    return row;
  });
  if (rows.length === 0) {
    const none = document.createElement("div");
    none.className = "file-empty";
    none.textContent = preview?.kind === "up-to-date" ? "Nothing to merge." : "The merge changes no files.";
    rows.push(none);
  }
  fileList.replaceChildren(...rows);
}

// ---- diff -----------------------------------------------------------------------------------

function showMessage(text: string) {
  view?.destroy();
  view = null;
  diffHost.hidden = true;
  diffMessage.hidden = false;
  diffMessage.textContent = text;
  updateDiffBar();
}

async function loadDiff() {
  const f = current;
  const p = preview;
  if (!f || !p) return showMessage(p?.kind === "up-to-date" ? "Nothing to merge." : "Select a file.");
  const sidePath = f.origPath ?? f.path;
  const [side, result] = await Promise.all([
    // The destination has the file under its old name if the merge renames it.
    textAt(compareWith === "to" ? p.to : p.from, compareWith === "to" ? sidePath : f.path),
    textAt(p.tree, f.path),
  ]);
  if (current !== f || preview !== p) return; // moved on meanwhile
  if (side === null || result === null) return showMessage("Binary file. There is no text to compare.");

  view?.destroy();
  diffMessage.hidden = true;
  diffHost.hidden = false;
  const common = [basicSetup, themeSlot.of(theme()), readOnly];
  view = new MergeView({
    a: { doc: side, extensions: [common, lineEndings(side)] },
    b: {
      doc: result,
      extensions: [
        common,
        lineEndings(result),
        Prec.high(
          keymap.of([
            { key: "F7", run: (v) => goToNextChunk(v) },
            { key: "Shift-F7", run: (v) => goToPreviousChunk(v) },
          ]),
        ),
        EditorView.updateListener.of((u) => {
          if (u.selectionSet) updateDiffBar();
        }),
      ],
    },
    parent: diffHost,
    highlightChanges: true,
    gutter: true,
  });
  updateDiffBar();
  if (view.chunks.length) goToNextChunk({ state: view.b.state, dispatch: view.b.dispatch });
}

function updateDiffBar() {
  diffTitle.replaceChildren(current ? current.path : "");
  if (current?.origPath) diffTitle.prepend(`${current.origPath} → `);
  $("side-a").textContent = compareWith === "to" ? `Into · ${preview?.toBranch ?? preview?.to.slice(0, 8) ?? ""}` : `From · ${preview ? (laneOf(preview.from)?.name ?? preview.from.slice(0, 8)) : ""}`;
  const chunks = view?.chunks ?? [];
  prevBtn.disabled = nextBtn.disabled = chunks.length === 0;
  if (!view) {
    changeCount.textContent = "";
    return;
  }
  const head = view.b.state.selection.main.head;
  const at = chunks.findIndex((c) => head >= c.fromB && head <= Math.max(c.fromB, c.toB));
  changeCount.textContent =
    chunks.length === 0 ? "Same as this side" : at >= 0 ? `Change ${at + 1} of ${chunks.length}` : `${chunks.length} change${chunks.length === 1 ? "" : "s"}`;
}

function step(dir: 1 | -1) {
  if (!view) return;
  (dir > 0 ? goToNextChunk : goToPreviousChunk)({ state: view.b.state, dispatch: view.b.dispatch });
  view.b.focus();
}

function setCompare(side: "to" | "from") {
  if (side === compareWith) return;
  compareWith = side;
  cmpTo.classList.toggle("on", side === "to");
  cmpFrom.classList.toggle("on", side === "from");
  cmpTo.setAttribute("aria-checked", String(side === "to"));
  cmpFrom.setAttribute("aria-checked", String(side === "from"));
  void loadDiff();
}

async function selectFile(f: MergeFile) {
  if (f.path === current?.path) return;
  current = f;
  renderFiles();
  await loadDiff();
}

prevBtn.addEventListener("click", () => step(-1));
nextBtn.addEventListener("click", () => step(1));
cmpTo.addEventListener("click", () => setCompare("to"));
cmpFrom.addEventListener("click", () => setCompare("from"));
dark.addEventListener("change", () => {
  if (view) for (const v of [view.a, view.b]) v.dispatch({ effects: themeSlot.reconfigure(theme()) });
});
window.addEventListener("keydown", (e) => {
  if (e.defaultPrevented) return;
  if (e.key === "F7") {
    e.preventDefault();
    step(e.shiftKey ? -1 : 1);
  }
});

// ---- loading -------------------------------------------------------------------------------

async function refresh() {
  try {
    const [p, raw, op] = await Promise.all([
      invoke<MergePreview>("merge_preview", { repo, from }),
      loadRepo(git()),
      invoke<{ kind: string; from: string | null } | null>("operation_in_progress", { repo }).catch(() => null),
    ]);
    model = inferModel(raw);
    preview = p;
    operation = op;
  } catch (err) {
    $("summary").textContent = `Could not preview the merge: ${err}`;
    $("summary").className = "conflicts";
    mergeBtn.disabled = true;
    return;
  }
  renderHeader(preview);
  // Keep the open file if it's still part of the merge; otherwise start with the first (conflicts come first).
  current = preview.files.find((f) => f.path === current?.path) ?? preview.files[0] ?? null;
  renderFiles();
  await loadDiff();
}

$("refresh").addEventListener("click", () => void refresh());
// The checked-out changeset may have moved while this window was in the background.
window.addEventListener("focus", () => void refresh());

async function start() {
  const info = await invoke<{ repo: string; from: string } | null>("merge_window_info");
  if (!info) {
    showMessage("This window has nothing to merge. Open it from a changeset in the branch explorer.");
    return;
  }
  ({ repo, from } = info);
  await refresh();
}

void start();
