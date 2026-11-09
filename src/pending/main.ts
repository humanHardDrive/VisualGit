/**
 * Pending Changes window: pick files to commit, see each one's diff against
 * the checked-out changeset, step from change to change, edit the working
 * copy, and commit the selected files with a message.
 */

import { goToNextChunk, goToPreviousChunk, MergeView } from "@codemirror/merge";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { emit } from "@tauri-apps/api/event";
import { Menu } from "@tauri-apps/api/menu";
import { ask } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { basicSetup } from "codemirror";
import { loadPendingChanges, type PendingChanges, type PendingFile } from "../git/status.ts";
import { tauriRunner } from "../git/tauriRunner.ts";
import { dark, lineEndings, readOnly, theme, themeSlot } from "../view/codemirror.ts";

/** Mirrors `FileText` in src-tauri/src/pending.rs. */
interface FileText {
  text: string | null;
  missing: boolean;
  binary: boolean;
  tooLarge: boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const messageBox = $<HTMLTextAreaElement>("message");
const commitBtn = $<HTMLButtonElement>("commit");
const commitMore = $<HTMLButtonElement>("commit-more");
const commitStatus = $("commit-status");
const checkAll = $<HTMLInputElement>("check-all");
const fileCount = $("file-count");
const fileList = $("file-list");
const branchInfo = $("branch-info");
const diffHost = $("diff");
const diffMessage = $("diff-message");
const diffTitle = $("diff-title");
const changeCount = $("change-count");
const prevBtn = $<HTMLButtonElement>("prev-change");
const nextBtn = $<HTMLButtonElement>("next-change");
const saveBtn = $<HTMLButtonElement>("save");

let repo = "";
let pending: PendingChanges = { files: [] };
/** Files the user unticked; everything else is committed. Kept by path across refreshes. */
const excluded = new Set<string>();
/** The file shown in the diff. */
let current: PendingFile | null = null;

interface Open {
  path: string;
  view: MergeView;
  editable: boolean;
  base: string;
  /** Working-copy text as last loaded or saved; the editor is dirty when it differs. */
  saved: string;
}
let open: Open | null = null;

// ---- helpers ------------------------------------------------------------------------

const span = (cls: string, text: string) => Object.assign(document.createElement("span"), { className: cls, textContent: text });

function statusOf(f: PendingFile): { letter: string; cls: string; title: string } {
  if (f.conflict) return { letter: "U", cls: "st-U", title: "Conflict" };
  if (f.untracked) return { letter: "?", cls: "st-untracked", title: "New file (untracked)" };
  // The combined change against the checked-out changeset: an add stays an add even if edited since.
  const c = f.staged === "A" || f.staged === "R" || f.staged === "C" || f.staged === "D" ? f.staged : (f.unstaged ?? f.staged ?? "M");
  const names = { M: "Modified", T: "Type changed", A: "Added", D: "Deleted", R: "Renamed", C: "Copied" };
  return { letter: c, cls: `st-${c}`, title: names[c] };
}

function pathParts(path: string) {
  const slash = path.lastIndexOf("/");
  const el = document.createElement("span");
  el.className = "file-path";
  if (slash >= 0) el.append(span("file-dir", path.slice(0, slash + 1)));
  el.append(span("file-name", path.slice(slash + 1)));
  return el;
}

const isDirty = () => !!open && open.editable && open.view.b.state.sliceDoc() !== open.saved;
const selectedFiles = () => pending.files.filter((f) => !excluded.has(f.path));

function setStatus(text: string, kind: "" | "ok" | "error" = "") {
  commitStatus.textContent = text;
  commitStatus.className = `commit-status ${kind}`;
}

/** Tells the main window to reload its explorer. */
const announce = () => void emit("repo-changed", { repo });

// ---- file list ------------------------------------------------------------------------

function renderFiles() {
  const files = pending.files;
  const chosen = selectedFiles().length;
  fileCount.textContent = files.length ? `${chosen} of ${files.length} file${files.length === 1 ? "" : "s"} selected` : "No pending changes";
  checkAll.checked = files.length > 0 && chosen === files.length;
  checkAll.indeterminate = chosen > 0 && chosen < files.length;
  checkAll.disabled = files.length === 0;

  const rows = files.map((f) => {
    const row = document.createElement("div");
    row.className = "pfile";
    row.setAttribute("role", "option");
    if (f.path === current?.path) row.classList.add("current");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !excluded.has(f.path);
    box.title = "Include in the commit";
    box.onclick = (e) => e.stopPropagation();
    box.onchange = () => {
      if (box.checked) excluded.delete(f.path);
      else excluded.add(f.path);
      renderFiles();
    };
    const st = statusOf(f);
    const status = span(`file-status ${st.cls}`, st.letter);
    row.title = f.origPath ? `${st.title}: ${f.origPath} → ${f.path}` : `${st.title}: ${f.path}`;
    row.append(box, status, pathParts(f.path));
    if (f.path === open?.path && isDirty()) row.append(span("dirty", "●"));
    row.onclick = () => void selectFile(f);
    return row;
  });
  if (rows.length === 0) {
    const none = document.createElement("div");
    none.className = "file-empty";
    none.textContent = "The working tree matches the checked-out changeset.";
    rows.push(none);
  }
  fileList.replaceChildren(...rows);
  updateCommitButton();
}

checkAll.addEventListener("change", () => {
  for (const f of pending.files) {
    if (checkAll.checked) excluded.delete(f.path);
    else excluded.add(f.path);
  }
  renderFiles();
});

let busy = false;

function updateCommitButton() {
  const files = selectedFiles().length;
  commitBtn.disabled = busy || !messageBox.value.trim() || files === 0;
  // The drop-down also offers Undo Changes, which needs files but no message.
  commitMore.disabled = busy || files === 0;
}

// ---- diff -------------------------------------------------------------------------------

function showMessage(text: string) {
  open?.view.destroy();
  open = null;
  diffHost.hidden = true;
  diffMessage.hidden = false;
  diffMessage.textContent = text;
  updateDiffBar();
}

async function baseText(f: PendingFile): Promise<string | null> {
  // New in the working tree or the index: nothing to compare against.
  if (!pending.head || f.untracked || f.staged === "A") return "";
  try {
    const text = await tauriRunner(repo).run(["show", `HEAD:${f.origPath ?? f.path}`]);
    return text.includes("\0") ? null : text;
  } catch {
    return "";
  }
}

/** Loads `f` into the diff. `keepIfSame` skips rebuilding (and losing the scroll position) when nothing changed. */
async function loadDiff(f: PendingFile, keepIfSame = false) {
  const [base, work] = await Promise.all([baseText(f), invoke<FileText>("read_worktree_file", { repo, path: f.path })]);
  if (current?.path !== f.path) return; // the user moved on meanwhile
  if (work.tooLarge) return showMessage("This file is too large to show.");
  if (base === null || work.binary) return showMessage("Binary file. There is no text to compare.");

  const text = work.text ?? "";
  const editable = !work.missing;
  if (keepIfSame && open?.path === f.path && open.base === base && open.saved === text) return;

  open?.view.destroy();
  diffMessage.hidden = true;
  diffHost.hidden = false;
  const common = [basicSetup, themeSlot.of(theme())];
  const view = new MergeView({
    a: { doc: base, extensions: [common, readOnly, lineEndings(base)] },
    b: {
      doc: text,
      extensions: [
        common,
        editable ? [] : readOnly,
        lineEndings(text),
        Prec.high(
          keymap.of([
            { key: "Mod-s", run: () => (void save(), true) },
            { key: "F7", run: (v) => goToNextChunk(v) },
            { key: "Shift-F7", run: (v) => goToPreviousChunk(v) },
          ]),
        ),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            updateDiffBar();
            renderFiles();
          } else if (u.selectionSet) updateDiffBar();
        }),
      ],
    },
    parent: diffHost,
    // Arrows between the sides copy the committed text back over a change.
    revertControls: editable ? "a-to-b" : undefined,
    highlightChanges: true,
    gutter: true,
  });
  open = { path: f.path, view, editable, base, saved: text };
  updateDiffBar();
  // Start at the first change.
  if (view.chunks.length) goToNextChunk({ state: view.b.state, dispatch: view.b.dispatch });
}

dark.addEventListener("change", () => {
  if (!open) return;
  for (const v of [open.view.a, open.view.b]) v.dispatch({ effects: themeSlot.reconfigure(theme()) });
});

function updateDiffBar() {
  diffTitle.replaceChildren(current ? current.path : "");
  if (current?.origPath) diffTitle.prepend(`${current.origPath} → `);
  if (isDirty()) diffTitle.append(span("dirty", "●"));
  if (open && !open.editable) diffTitle.append(span("dirty", " (deleted)"));
  saveBtn.disabled = !isDirty();
  const chunks = open?.view.chunks ?? [];
  prevBtn.disabled = nextBtn.disabled = chunks.length === 0;
  if (!open) {
    changeCount.textContent = "";
    return;
  }
  const head = open.view.b.state.selection.main.head;
  const at = chunks.findIndex((c) => head >= c.fromB && head <= Math.max(c.fromB, c.toB));
  changeCount.textContent =
    chunks.length === 0 ? "No changes" : at >= 0 ? `Change ${at + 1} of ${chunks.length}` : `${chunks.length} change${chunks.length === 1 ? "" : "s"}`;
}

function step(dir: 1 | -1) {
  if (!open) return;
  const v = open.view.b;
  (dir > 0 ? goToNextChunk : goToPreviousChunk)({ state: v.state, dispatch: v.dispatch });
  v.focus();
}

prevBtn.addEventListener("click", () => step(-1));
nextBtn.addEventListener("click", () => step(1));

/** Writes the edited working copy to disk. Returns false if saving failed. */
async function save(): Promise<boolean> {
  if (!open || !isDirty()) return true;
  const { path } = open;
  const text = open.view.b.state.sliceDoc();
  try {
    await invoke("write_worktree_file", { repo, path, text });
  } catch (err) {
    setStatus(String(err), "error");
    return false;
  }
  if (open?.path === path) open.saved = text;
  updateDiffBar();
  announce();
  await refresh();
  return true;
}

saveBtn.addEventListener("click", () => void save());

async function selectFile(f: PendingFile) {
  if (f.path === current?.path) return;
  // Edits are saved when you move to another file, so nothing is lost.
  if (!(await save())) return;
  current = f;
  renderFiles();
  await loadDiff(f);
}

// ---- merge or cherry pick in progress -------------------------------------------------

/** Mirrors `Operation` in src-tauri/src/merge.rs. */
interface Operation {
  kind: "merge" | "cherry pick" | "subtractive merge";
  from: string | null;
  message: string | null;
}

let operation: Operation | null = null;
/** The prepared message we put in the box, so it is only filled in once and can be cleared on abort. */
let prefilled: string | null = null;

async function refreshOperation() {
  operation = await invoke<Operation | null>("operation_in_progress", { repo }).catch(() => null);
  const bar = $("operation");
  bar.hidden = !operation;
  if (!operation) return;
  const what = { merge: "Merging", "cherry pick": "Cherry picking", "subtractive merge": "Taking out the changes of" }[operation.kind];
  $("operation-text").textContent =
    `${what} ${operation.from?.slice(0, 8) ?? ""}. Resolve any conflicts, then commit; the commit includes every changed file. Or abort to put everything back as it was.`;
  if (operation.message && !messageBox.value.trim() && prefilled !== operation.message) {
    messageBox.value = prefilled = operation.message;
    updateCommitButton();
  }
}

$("abort").addEventListener("click", async () => {
  if (!operation) return;
  const ok = await ask(`Abort the ${operation.kind}? Its changes, including any conflict resolutions, are discarded.`, {
    title: `Abort ${operation.kind}`,
    kind: "warning",
    okLabel: "Abort",
    cancelLabel: "Keep Going",
  });
  if (!ok) return;
  open?.view.destroy();
  open = null;
  try {
    await invoke("abort_operation", { repo });
    setStatus(`Aborted the ${operation.kind}`, "ok");
    if (messageBox.value === prefilled) messageBox.value = "";
    prefilled = null;
    announce();
  } catch (err) {
    setStatus(String(err), "error");
  }
  current = null;
  await refresh();
});

// ---- refresh and commit --------------------------------------------------------------

async function refresh() {
  void refreshOperation();
  try {
    pending = await loadPendingChanges(tauriRunner(repo));
  } catch (err) {
    setStatus(`Could not read pending changes: ${err}`, "error");
    return;
  }
  const known = new Set(pending.files.map((f) => f.path));
  for (const p of excluded) if (!known.has(p)) excluded.delete(p);
  branchInfo.textContent = `${pending.branch ? `On ${pending.branch}` : pending.head ? "Detached HEAD" : "No changesets yet"}${
    pending.head ? ` · based on ${pending.head.slice(0, 8)}` : ""
  }`;

  const still = current && pending.files.find((f) => f.path === current!.path);
  if (still) {
    current = still;
    renderFiles();
    // Pick up edits made in another editor, unless there are unsaved edits here.
    if (!isDirty()) await loadDiff(still, true);
  } else if (!isDirty()) {
    current = pending.files[0] ?? null;
    renderFiles();
    if (current) await loadDiff(current);
    else showMessage("No pending changes.");
  } else {
    renderFiles();
  }
}

/** Commits the selected files; with `andPush`, then pushes the checked-out branch. */
async function commit(andPush = false) {
  const message = messageBox.value.trim();
  const files = selectedFiles();
  if (busy || !message || files.length === 0) return;
  if (!(await save())) return;
  // A rename commits both its new and its old path.
  const paths = files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));
  busy = true;
  updateCommitButton();
  setStatus("Committing…");
  try {
    const hash = await invoke<string>("commit_changes", { repo, message, paths });
    messageBox.value = "";
    setStatus(`Committed ${hash.slice(0, 8)}`, "ok");
    announce();
    if (andPush) {
      setStatus(`Committed ${hash.slice(0, 8)}. Pushing…`);
      try {
        const pushed = await invoke<string>("push_current_branch", { repo });
        setStatus(`Committed ${hash.slice(0, 8)}. ${pushed}.`, "ok");
      } catch (err) {
        // The commit stands; only the push needs another go.
        setStatus(`Committed ${hash.slice(0, 8)}, but the push failed: ${err}`, "error");
      }
      announce();
    }
  } catch (err) {
    setStatus(String(err), "error");
  }
  busy = false;
  await refresh();
}

/** True for files the checked-out changeset doesn't have: undoing them means removing them. */
const isNew = (f: PendingFile) => !!f.untracked || f.staged === "A" || f.staged === "C" || (f.staged === "R" && !!f.origPath) || !pending.head;

/** Puts the selected files back as they are in the checked-out changeset, after asking. */
async function undoChanges() {
  const files = selectedFiles();
  if (busy || files.length === 0) return;
  const created = files.filter(isNew).map((f) => f.path);
  // Tracked files go back to their committed content; a rename also restores its old path.
  const tracked = files.flatMap((f) => (isNew(f) ? (f.staged === "R" && f.origPath ? [f.origPath] : []) : [f.path]));
  const what = files.length === 1 ? files[0].path : `${files.length} files`;
  const ok = await ask(
    `Undo the changes to ${what}? Their content goes back to the checked-out changeset and your edits are lost.` +
      (created.length ? `

New files (${created.length}) are moved to the Trash.` : ""),
    { title: "Undo Changes", kind: "warning", okLabel: "Undo Changes", cancelLabel: "Cancel" },
  );
  if (!ok) return;
  // Unsaved edits to an undone file are dropped, not saved first.
  if (open && files.some((f) => f.path === open!.path)) {
    open.view.destroy();
    open = null;
  }
  busy = true;
  updateCommitButton();
  try {
    await invoke("undo_changes", { repo, tracked, created });
    setStatus(`Undid changes to ${what}`, "ok");
    announce();
  } catch (err) {
    setStatus(String(err), "error");
  }
  busy = false;
  if (current && files.some((f) => f.path === current!.path)) current = null;
  await refresh();
}

commitBtn.addEventListener("click", () => void commit());
commitMore.addEventListener("click", async () => {
  const left = commitBtn.getBoundingClientRect().left;
  const bottom = commitMore.getBoundingClientRect().bottom;
  const canCommit = !!messageBox.value.trim();
  const n = selectedFiles().length;
  const menu = await Menu.new({
    items: [
      { id: "commit", text: "Commit", accelerator: "CmdOrCtrl+Enter", enabled: canCommit, action: () => void commit() },
      { id: "commit-push", text: "Commit & Push", accelerator: "CmdOrCtrl+Shift+Enter", enabled: canCommit, action: () => void commit(true) },
      { item: "Separator" },
      { id: "undo", text: `Undo Changes${n === 1 ? "" : ` (${n} files)`}…`, action: () => void undoChanges() },
    ],
  });
  // Drop down under the split button, lined up with its left edge.
  await menu.popup(new LogicalPosition(left, bottom + 4));
});
messageBox.addEventListener("input", updateCommitButton);
messageBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void commit(e.shiftKey);
  }
});
$("refresh").addEventListener("click", () => void refresh());

window.addEventListener("keydown", (e) => {
  // The editor handles its own keys (and marks them handled).
  if (e.defaultPrevented || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
  if (e.key === "F7") {
    e.preventDefault();
    step(e.shiftKey ? -1 : 1);
  } else if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
    void save();
  }
});
window.addEventListener("focus", () => void refresh());

// ---- startup --------------------------------------------------------------------------

async function start() {
  const r = await invoke<string | null>("window_repo");
  if (!r) {
    showMessage("This window has no repository. Open Pending Changes from the branch explorer.");
    return;
  }
  repo = r;
  document.title = `Pending Changes · ${repo.split("/").pop()}`;
  // Unsaved edits are saved when the window closes.
  void getCurrentWindow().onCloseRequested(async (e) => {
    if (!(await save())) e.preventDefault();
  });
  await refresh();
  messageBox.focus();
}

void start();
