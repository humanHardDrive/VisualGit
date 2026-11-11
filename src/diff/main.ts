/**
 * Diff window: what one committed changeset changed, everything a branch
 * changed (from the changeset it was created from to its latest), or the
 * differences between two changesets. Lists the
 * files and shows each one before and after. A merge changeset can be
 * compared with either parent. Read-only.
 */

import { goToNextChunk, goToPreviousChunk, MergeView } from "@codemirror/merge";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { basicSetup } from "codemirror";
import { loadChangesetFiles, type ChangedFile } from "../git/changeset.ts";
import { loadFileHistory, type HistoryEntry } from "../git/history.ts";
import { loadRepo } from "../git/load.ts";
import { tauriRunner } from "../git/tauriRunner.ts";
import { inferModel, type Model } from "../model/infer.ts";
import { localizeShortcuts } from "../platform.ts";
import { dark, lineEndings, readOnly, theme, themeSlot } from "../view/codemirror.ts";
import { branchColor } from "../view/explorer.ts";

localizeShortcuts();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fileList = $("file-list");
const diffHost = $("diff");
const diffMessage = $("diff-message");
const diffTitle = $("diff-title");
const changeCount = $("change-count");
const prevBtn = $<HTMLButtonElement>("prev-change");
const nextBtn = $<HTMLButtonElement>("next-change");
const prevFileBtn = $<HTMLButtonElement>("prev-file");
const nextFileBtn = $<HTMLButtonElement>("next-file");

let repo = "";
let changeset = "";
/** Set when showing a whole branch rather than one changeset. */
let branchName: string | null = null;
/** Set when comparing two changesets: the one `changeset` is compared with. */
let compareFrom: string | null = null;
let model: Model | null = null;
let parents: string[] = [];
/** Which parent the changeset is compared with (merges have several). */
let parentIndex = 0;
/** A row in the list: a changed file, or (for a file's history) one changeset of it. */
type Item = ChangedFile & { entry?: HistoryEntry };
let files: Item[] = [];
let current: Item | null = null;
/** Set when showing one file's history. */
let historyOf: string | null = null;
/** Rows are files, except in a history, where the same path repeats: there they're changesets. */
const keyOf = (f: Item) => f.entry?.hash ?? f.path;
let view: MergeView | null = null;

const git = () => tauriRunner(repo);
const span = (cls: string, text: string) => Object.assign(document.createElement("span"), { className: cls, textContent: text });
const parent = () => parents[parentIndex] ?? null;

const STATUS_NAMES: Record<ChangedFile["status"], string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
};

const laneOf = (hash: string) => {
  const id = model?.owner.get(hash);
  return id === undefined ? null : model!.branches[id];
};

/** A file's text in changeset `rev`, "" if it isn't there, null if binary. */
async function textAt(rev: string | null, path: string): Promise<string | null> {
  if (!rev) return "";
  try {
    const text = await git().run(["show", `${rev}:${path}`]);
    return text.includes("\0") ? null : text;
  } catch {
    return "";
  }
}

// ---- header -----------------------------------------------------------------------------

function renderBranchHeader(name: string) {
  const b = model?.branches.find((x) => x.name === name);
  const base = parents[0];
  $("subject").textContent = `Changes on ${name}`;
  const id = $("cs-id");
  id.textContent = base ? `${base.slice(0, 8)} → ${changeset.slice(0, 8)}` : `up to ${changeset.slice(0, 8)}`;
  id.title = base ? `From ${base} to ${changeset}` : changeset;
  const branch = $("cs-branch");
  branch.textContent = name;
  branch.style.color = b && model ? branchColor(model, b.id) : "";
  const n = b?.commits.length ?? 0;
  $("cs-author").textContent = b ? `${n} changeset${n === 1 ? "" : "s"}` : "";
  const first = b && model?.commits.get(b.commits[0]);
  const last = model?.commits.get(changeset);
  $("cs-date").textContent = first && last ? `${new Date(first.time * 1000).toLocaleDateString()} – ${new Date(last.time * 1000).toLocaleDateString()}` : "";
  $("cs-tags").textContent = "";
  $<HTMLDetailsElement>("cs-message").hidden = true;
  document.title = `Changes on ${name}`;
}

/** Two changesets compared: both ids, their branches and dates. */
function renderCompareHeader(from: string) {
  const describe = (hash: string) => {
    const lane = laneOf(hash);
    return `${lane ? `${lane.name} ` : ""}${hash.slice(0, 8)}`;
  };
  $("subject").textContent = `${describe(from)} → ${describe(changeset)}`;
  const id = $("cs-id");
  id.textContent = `${from.slice(0, 8)} → ${changeset.slice(0, 8)}`;
  id.title = `From ${from} to ${changeset}`;
  const lanes = [laneOf(from), laneOf(changeset)];
  const branch = $("cs-branch");
  branch.textContent = lanes[0] && lanes[1] && lanes[0] !== lanes[1] ? `${lanes[0].name} → ${lanes[1].name}` : (lanes[1]?.name ?? "");
  branch.style.color = lanes[1] && model ? branchColor(model, lanes[1].id) : "";
  $("cs-author").textContent = "Two changesets compared";
  const a = model?.commits.get(from);
  const b = model?.commits.get(changeset);
  $("cs-date").textContent = a && b ? `${new Date(a.time * 1000).toLocaleDateString()} → ${new Date(b.time * 1000).toLocaleDateString()}` : "";
  $("cs-tags").textContent = "";
  $<HTMLDetailsElement>("cs-message").hidden = true;
  document.title = `Changesets ${from.slice(0, 8)} → ${changeset.slice(0, 8)}`;
}

function renderHeader() {
  if (branchName) return renderBranchHeader(branchName);
  if (compareFrom) return renderCompareHeader(compareFrom);
  const c = model?.commits.get(changeset);
  const lane = laneOf(changeset);
  $("subject").textContent = c?.subject || "(no message)";
  const id = $("cs-id");
  id.textContent = changeset.slice(0, 8);
  id.title = changeset;
  const branch = $("cs-branch");
  branch.textContent = lane?.name ?? "";
  branch.style.color = lane && model ? branchColor(model, lane.id) : "";
  $("cs-author").textContent = c ? `${c.author} <${c.email}>` : "";
  $("cs-date").textContent = c ? new Date(c.time * 1000).toLocaleString() : "";
  const tags = model?.tags.get(changeset);
  $("cs-tags").textContent = tags ? `Release ${tags.join(", ")}` : "";
  document.title = `${changeset.slice(0, 8)} · ${c?.subject ?? "Changeset"}`;
  const details = $<HTMLDetailsElement>("cs-message");
  details.hidden = !c?.body;
  $("cs-message-text").textContent = c ? `${c.subject}\n\n${c.body}` : "";
}

/** For merges: one button per parent, named after the parent's branch. */
function renderParents() {
  const group = $("parents");
  group.hidden = parents.length < 2;
  group.querySelectorAll("button").forEach((b) => b.remove());
  parents.forEach((p, i) => {
    const btn = document.createElement("button");
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(i === parentIndex));
    btn.className = i === parentIndex ? "on" : "";
    btn.textContent = laneOf(p)?.name ?? p.slice(0, 8);
    btn.title = `Parent ${i + 1}: ${p.slice(0, 8)} ${model?.commits.get(p)?.subject ?? ""}`;
    btn.onclick = () => void chooseParent(i);
    group.append(btn);
  });
}

function renderParentInfo() {
  const p = parent();
  if (compareFrom) {
    $("parent-info").textContent = `Everything that differs between ${compareFrom.slice(0, 8)} and ${changeset.slice(0, 8)}`;
  } else if (branchName) {
    $("parent-info").textContent = p
      ? `Since it was created from ${laneOf(p)?.name ?? ""} ${p.slice(0, 8)}`
      : "From the start of history: everything is new";
  } else {
    $("parent-info").textContent = p
      ? `Compared with ${parents.length > 1 ? `parent ${parentIndex + 1}, ` : "its parent "}${p.slice(0, 8)}`
      : "The first changeset: everything in it is new";
  }
  $("file-count").textContent = `${files.length} file${files.length === 1 ? "" : "s"} changed`;
}

// ---- file list ------------------------------------------------------------------------------

function historyRow(f: Item & { entry: HistoryEntry }) {
  const e = f.entry;
  const row = document.createElement("div");
  row.className = "pfile history-row";
  row.setAttribute("role", "option");
  if (current && keyOf(f) === keyOf(current)) row.classList.add("current");
  row.title = `${e.hash.slice(0, 8)} ${e.subject}\n${e.author}, ${new Date(e.time * 1000).toLocaleString()}${e.oldPath ? `\nRenamed from ${e.oldPath}` : ""}`;
  const text = document.createElement("span");
  text.className = "history-text";
  text.append(span("history-subject", e.subject || "(no message)"), span("history-meta", `${e.hash.slice(0, 8)} · ${e.author} · ${new Date(e.time * 1000).toLocaleDateString()}`));
  row.append(span(`file-status st-${f.status}`, f.status), text);
  row.onclick = () => void selectFile(f);
  // Double-click: everything else that changeset changed.
  row.ondblclick = () => void invoke("open_diff_window", { repo, at: e.hash });
  return row;
}

function renderFiles() {
  const rows = files.map((f) => {
    if (f.entry) return historyRow(f as Item & { entry: HistoryEntry });
    const row = document.createElement("div");
    row.className = "pfile";
    row.setAttribute("role", "option");
    if (current && keyOf(f) === keyOf(current)) row.classList.add("current");
    row.title = f.origPath ? `${STATUS_NAMES[f.status]}: ${f.origPath} → ${f.path}` : `${STATUS_NAMES[f.status]}: ${f.path}`;
    const slash = f.path.lastIndexOf("/");
    const path = document.createElement("span");
    path.className = "file-path";
    if (slash >= 0) path.append(span("file-dir", f.path.slice(0, slash + 1)));
    path.append(span("file-name", f.path.slice(slash + 1)));
    row.append(span(`file-status st-${f.status}`, f.status), path);
    row.onclick = () => void selectFile(f);
    return row;
  });
  if (rows.length === 0) {
    const none = document.createElement("div");
    none.className = "file-empty";
    none.textContent = historyOf
      ? "This file has never been committed."
      : compareFrom
        ? "These two changesets have the same files."
        : branchName
          ? "This branch's changesets add up to no file changes."
          : "This changeset changes no files compared with this parent.";
    rows.push(none);
  }
  fileList.replaceChildren(...rows);
  fileList.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  const i = current ? files.indexOf(current) : -1;
  prevFileBtn.disabled = i <= 0;
  nextFileBtn.disabled = i < 0 || i >= files.length - 1;
}

/** Moves to the previous or next file in the list. */
function stepFile(dir: 1 | -1) {
  const i = current ? files.indexOf(current) : -1;
  const next = files[i + dir];
  if (next) void selectFile(next);
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
  if (!f) return showMessage(files.length ? "Select a file." : historyOf ? "No history yet." : "No files changed.");
  const p = f.entry ? f.entry.parent : parent();
  const at = f.entry ? f.entry.hash : changeset;
  const [before, after] = await Promise.all([
    textAt(p, f.origPath ?? f.path),
    // Deleted in this changeset: nothing after.
    f.status === "D" ? Promise.resolve("") : textAt(at, f.path),
  ]);
  if (current !== f) return; // moved on meanwhile
  if (before === null || after === null) return showMessage("Binary file. There is no text to compare.");

  view?.destroy();
  diffMessage.hidden = true;
  diffHost.hidden = false;
  const common = [basicSetup, themeSlot.of(theme()), readOnly];
  view = new MergeView({
    a: { doc: before, extensions: [common, lineEndings(before)] },
    b: {
      doc: after,
      extensions: [
        common,
        lineEndings(after),
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
  const e = current?.entry;
  const p = e ? e.parent : parent();
  $("side-a").textContent = p ? `Before · ${laneOf(p)?.name ?? ""} ${p.slice(0, 8)}` : "Before · (nothing)";
  $("side-b").textContent = e
    ? `After · ${e.hash.slice(0, 8)} ${e.subject}`
    : `After · ${branchName ? `${branchName} ` : compareFrom ? `${laneOf(changeset)?.name ?? ""} ` : ""}${changeset.slice(0, 8)}`;
  const chunks = view?.chunks ?? [];
  prevBtn.disabled = nextBtn.disabled = chunks.length === 0;
  if (!view) {
    changeCount.textContent = "";
    return;
  }
  const head = view.b.state.selection.main.head;
  const at = chunks.findIndex((c) => head >= c.fromB && head <= Math.max(c.fromB, c.toB));
  changeCount.textContent =
    chunks.length === 0 ? "No text changes" : at >= 0 ? `Change ${at + 1} of ${chunks.length}` : `${chunks.length} change${chunks.length === 1 ? "" : "s"}`;
}

function step(dir: 1 | -1) {
  if (!view) return;
  (dir > 0 ? goToNextChunk : goToPreviousChunk)({ state: view.b.state, dispatch: view.b.dispatch });
  view.b.focus();
}

async function selectFile(f: Item) {
  if (current && keyOf(f) === keyOf(current)) return;
  current = f;
  renderFiles();
  await loadDiff();
}

/** A file's history: one row per changeset that changed it, newest first. */
async function loadHistory(path: string) {
  try {
    const entries = await loadFileHistory(git(), path);
    files = entries.map((entry) => ({ path: entry.path, origPath: entry.oldPath, status: entry.status as ChangedFile["status"], entry }));
  } catch (err) {
    files = [];
    showMessage(`Could not read the history: ${err}`);
  }
  current = files[0] ?? null;
  const n = files.length;
  $("file-count").textContent = `${n} changeset${n === 1 ? "" : "s"}`;
  $("parent-info").textContent = "Newest first · double-click for the whole changeset";
  $("subject").textContent = `History of ${path}`;
  const id = $("cs-id");
  id.textContent = path;
  id.title = path;
  for (const k of ["cs-branch", "cs-author", "cs-date", "cs-tags"]) $(k).textContent = "";
  $<HTMLDetailsElement>("cs-message").hidden = true;
  document.title = `History of ${path}`;
  renderFiles();
  await loadDiff();
}

async function loadFiles() {
  if (historyOf) return loadHistory(historyOf);
  try {
    files = await loadChangesetFiles(git(), changeset, parent());
  } catch (err) {
    files = [];
    showMessage(`Could not read the changeset: ${err}`);
  }
  current = files.find((f) => current && keyOf(f) === keyOf(current)) ?? files[0] ?? null;
  renderParentInfo();
  renderFiles();
  await loadDiff();
}

async function chooseParent(i: number) {
  if (i === parentIndex) return;
  parentIndex = i;
  renderParents();
  await loadFiles();
}

prevFileBtn.addEventListener("click", () => stepFile(-1));
nextFileBtn.addEventListener("click", () => stepFile(1));
prevBtn.addEventListener("click", () => step(-1));
nextBtn.addEventListener("click", () => step(1));
dark.addEventListener("change", () => {
  if (view) for (const v of [view.a, view.b]) v.dispatch({ effects: themeSlot.reconfigure(theme()) });
});
window.addEventListener("keydown", (e) => {
  if (e.defaultPrevented) return;
  if (e.key === "F7") {
    e.preventDefault();
    step(e.shiftKey ? -1 : 1);
  } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !(e.target instanceof Element && e.target.closest(".cm-editor"))) {
    // Outside the editor (where arrows move the cursor), ↑/↓ move between files.
    e.preventDefault();
    stepFile(e.key === "ArrowUp" ? -1 : 1);
  }
});

async function start() {
  const info = await invoke<{ repo: string; changeset: string; branch: string | null; base: string | null; file: string | null } | null>(
    "diff_window_info",
  );
  if (!info) {
    showMessage("This window has no changeset. Open it by double-clicking a changeset in the branch explorer.");
    return;
  }
  ({ repo, changeset } = info);
  branchName = info.branch;
  historyOf = info.file;
  try {
    model = inferModel(await loadRepo(git()));
  } catch {
    model = null; // the header gets less detail; the diff still works
  }
  if (historyOf) {
    // Each history row brings its own parent.
    $("prev-file").title = "Newer changeset (↑)";
    $("next-file").title = "Older changeset (↓)";
    await loadFiles();
    return;
  }
  if (branchName) {
    // A branch is compared with where it started.
    parents = info.base ? [info.base] : [];
  } else if (info.base) {
    // Two changesets: the later one compared with the earlier.
    compareFrom = info.base;
    parents = [info.base];
  } else {
    // Parents from git directly, so this works even for changesets the explorer didn't load.
    const line = await git()
      .run(["log", "-1", "--format=%P", changeset])
      .catch(() => "");
    parents = line.trim() ? line.trim().split(" ") : [];
  }
  renderHeader();
  renderParents();
  await loadFiles();
}

void start();
