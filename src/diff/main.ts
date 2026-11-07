/**
 * Changeset diff window: what one committed changeset changed. Lists its
 * files and shows each one before (in the parent) and after (in the
 * changeset). A merge changeset can be compared with either parent.
 * Read-only.
 */

import { goToNextChunk, goToPreviousChunk, MergeView } from "@codemirror/merge";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { basicSetup } from "codemirror";
import { loadChangesetFiles, type ChangedFile } from "../git/changeset.ts";
import { loadRepo } from "../git/load.ts";
import { tauriRunner } from "../git/tauriRunner.ts";
import { inferModel, type Model } from "../model/infer.ts";
import { dark, lineEndings, readOnly, theme, themeSlot } from "../view/codemirror.ts";
import { branchColor } from "../view/explorer.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fileList = $("file-list");
const diffHost = $("diff");
const diffMessage = $("diff-message");
const diffTitle = $("diff-title");
const changeCount = $("change-count");
const prevBtn = $<HTMLButtonElement>("prev-change");
const nextBtn = $<HTMLButtonElement>("next-change");

let repo = "";
let changeset = "";
let model: Model | null = null;
let parents: string[] = [];
/** Which parent the changeset is compared with (merges have several). */
let parentIndex = 0;
let files: ChangedFile[] = [];
let current: ChangedFile | null = null;
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

function renderHeader() {
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
  $("parent-info").textContent = p
    ? `Compared with ${parents.length > 1 ? `parent ${parentIndex + 1}, ` : "its parent "}${p.slice(0, 8)}`
    : "The first changeset: everything in it is new";
  $("file-count").textContent = `${files.length} file${files.length === 1 ? "" : "s"} changed`;
}

// ---- file list ------------------------------------------------------------------------------

function renderFiles() {
  const rows = files.map((f) => {
    const row = document.createElement("div");
    row.className = "pfile";
    row.setAttribute("role", "option");
    if (f.path === current?.path) row.classList.add("current");
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
    none.textContent = "This changeset changes no files compared with this parent.";
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
  if (!f) return showMessage(files.length ? "Select a file." : "No files changed.");
  const p = parent();
  const [before, after] = await Promise.all([textAt(p, f.origPath ?? f.path), textAt(changeset, f.path)]);
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
  const p = parent();
  $("side-a").textContent = p ? `Before · ${laneOf(p)?.name ?? ""} ${p.slice(0, 8)}` : "Before · (nothing)";
  $("side-b").textContent = `After · ${changeset.slice(0, 8)}`;
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

async function selectFile(f: ChangedFile) {
  if (f.path === current?.path) return;
  current = f;
  renderFiles();
  await loadDiff();
}

async function loadFiles() {
  try {
    files = await loadChangesetFiles(git(), changeset, parent());
  } catch (err) {
    files = [];
    showMessage(`Could not read the changeset: ${err}`);
  }
  current = files.find((f) => f.path === current?.path) ?? files[0] ?? null;
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
  }
});

async function start() {
  const info = await invoke<{ repo: string; changeset: string } | null>("diff_window_info");
  if (!info) {
    showMessage("This window has no changeset. Open it by double-clicking a changeset in the branch explorer.");
    return;
  }
  ({ repo, changeset } = info);
  try {
    model = inferModel(await loadRepo(git()));
  } catch {
    model = null; // the header gets less detail; the diff still works
  }
  // Parents from git directly, so this works even for changesets the explorer didn't load.
  const line = await git()
    .run(["log", "-1", "--format=%P", changeset])
    .catch(() => "");
  parents = line.trim() ? line.trim().split(" ") : [];
  renderHeader();
  renderParents();
  await loadFiles();
}

void start();
