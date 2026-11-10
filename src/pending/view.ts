/**
 * Pending Changes view (in the main window): pick files to commit, see each
 * one's diff against the checked-out changeset, step from change to change,
 * edit the working copy, and commit the selected files with a message.
 *
 * Its markup is in index.html (ids prefixed `pc-`). The main window tells it
 * which repository is open and when it is shown or hidden; it reports back
 * through `onChanged` whenever it changes the repository.
 */

import { goToNextChunk, goToPreviousChunk, MergeView } from "@codemirror/merge";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu } from "@tauri-apps/api/menu";
import { ask } from "@tauri-apps/plugin-dialog";
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
  /** A submodule: the changeset it has checked out ("" if none). */
  submodule: string | null;
}

/** Mirrors `Operation` in src-tauri/src/merge.rs. */
interface Operation {
  kind: "merge" | "cherry pick" | "subtractive merge";
  from: string | null;
  message: string | null;
}

export interface PendingViewOptions {
  /** Called after a commit, push, save, undo or abort, so the rest of the window can reload. */
  onChanged(): void;
}

export interface PendingView {
  /** The open repository changed (null: none). Saves unsaved edits to the previous one first. */
  setRepo(repo: string | null): Promise<void>;
  /** The view is now showing; `path` selects that file if it has pending changes. */
  show(path?: string): Promise<void>;
  /** The view is being left: saves unsaved edits. False if that failed (the edits stay in the editor). */
  hide(): Promise<boolean>;
  /** Re-reads the pending changes, if the view is showing. */
  refresh(): Promise<void>;
}

const span = (cls: string, text: string) => Object.assign(document.createElement("span"), { className: cls, textContent: text });

type ChangeKind = "added" | "removed" | "modified" | "renamed" | "conflict";

const KIND_LABELS: Record<ChangeKind, { label: string; cls: string }> = {
  added: { label: "Added", cls: "st-A" },
  removed: { label: "Removed", cls: "st-D" },
  modified: { label: "Modified", cls: "st-M" },
  renamed: { label: "Renamed", cls: "st-R" },
  conflict: { label: "Conflict", cls: "st-U" },
};

/**
 * How a file differs from the checked-out changeset, all changes combined: an
 * added file stays added even if edited since. `hasHead` is false before the
 * first commit, when every file is new.
 */
function kindOf(f: PendingFile, hasHead: boolean): { kind: ChangeKind; title: string } {
  if (f.conflict) return { kind: "conflict", title: "Conflict: resolve it, then commit" };
  if (f.untracked) return { kind: "added", title: "Added (new file, not yet tracked)" };
  const c = f.staged === "A" || f.staged === "R" || f.staged === "C" || f.staged === "D" ? f.staged : (f.unstaged ?? f.staged ?? "M");
  if (c === "R") return { kind: "renamed", title: "Renamed" };
  if (c === "A" || c === "C" || !hasHead) return { kind: "added", title: c === "C" ? "Added (a copy)" : "Added" };
  if (c === "D") return { kind: "removed", title: "Removed" };
  return { kind: "modified", title: c === "T" ? "Modified (file type changed)" : "Modified" };
}

function pathParts(path: string) {
  const slash = path.lastIndexOf("/");
  const el = document.createElement("span");
  el.className = "file-path";
  if (slash >= 0) el.append(span("file-dir", path.slice(0, slash + 1)));
  el.append(span("file-name", path.slice(slash + 1)));
  return el;
}

export function createPendingView(opts: PendingViewOptions): PendingView {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(`pc-${id}`) as T;
  const root = $("view");
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
  const diffSides = $("diff-sides");
  const sideA = $("side-a");
  const sideB = $("side-b");

  let repo = "";
  let visible = false;
  let pending: PendingChanges = { files: [] };
  /** Files the user unticked; everything else is committed. Kept by path across refreshes. */
  const excluded = new Set<string>();
  /** Unsent commit messages of other repositories, so switching back finds them again. */
  const drafts = new Map<string, string>();
  /** The file shown in the diff. */
  let current: PendingFile | null = null;
  let busy = false;

  interface Open {
    path: string;
    /** The working-copy editor: the right side of the diff, or the only pane for an added file. */
    editor: EditorView;
    /** The side-by-side diff; null for an added file, which has nothing to compare with. */
    merge: MergeView | null;
    editable: boolean;
    base: string;
    /** Working-copy text as last loaded or saved; the editor is dirty when it differs. */
    saved: string;
  }
  let open: Open | null = null;

  const isDirty = () => !!open && open.editable && open.editor.state.sliceDoc() !== open.saved;
  const selectedFiles = () => pending.files.filter((f) => !excluded.has(f.path));

  function setStatus(text: string, kind: "" | "ok" | "error" = "") {
    commitStatus.textContent = text;
    commitStatus.className = `commit-status ${kind}`;
  }

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
      const { kind, title } = kindOf(f, !!pending.head);
      row.title = f.origPath ? `${title}: ${f.origPath} → ${f.path}` : `${title}: ${f.path}`;
      row.append(box, pathParts(f.path));
      if (f.path === open?.path && isDirty()) row.append(span("dirty", "●"));
      row.append(span(`file-kind ${KIND_LABELS[kind].cls}`, KIND_LABELS[kind].label));
      row.onclick = () => void selectFile(f);
      return row;
    });
    if (rows.length === 0) {
      const none = document.createElement("div");
      none.className = "file-empty";
      none.textContent = repo ? "The working tree matches the checked-out changeset." : "No repository is open.";
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

  function updateCommitButton() {
    const files = selectedFiles().length;
    commitBtn.disabled = busy || !repo || !messageBox.value.trim() || files === 0;
    // The drop-down also offers Undo Changes, which needs files but no message.
    commitMore.disabled = busy || !repo || files === 0;
  }

  // ---- diff -------------------------------------------------------------------------------

  function closeEditor() {
    (open?.merge ?? open?.editor)?.destroy();
    open = null;
  }

  function showMessage(text: string) {
    closeEditor();
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
    const at = repo;
    const [base, work] = await Promise.all([baseText(f), invoke<FileText>("read_worktree_file", { repo, path: f.path })]);
    if (current?.path !== f.path || repo !== at) return; // the user moved on meanwhile
    if (work.tooLarge) return showMessage("This file is too large to show.");
    if (work.submodule !== null) {
      return showMessage(
        work.submodule
          ? `A submodule, checked out at ${work.submodule.slice(0, 8)}. Committing records that changeset.`
          : "A submodule, with nothing checked out yet.",
      );
    }
    if (base === null || work.binary) return showMessage("Binary file. There is no text to compare.");

    const text = work.text ?? "";
    const editable = !work.missing;
    // An added file has nothing to compare with: just its contents, in one pane.
    const single = kindOf(f, !!pending.head).kind === "added";
    if (keepIfSame && open?.path === f.path && open.base === base && open.saved === text && !open.merge === single) return;

    closeEditor();
    diffMessage.hidden = true;
    diffHost.hidden = false;
    const common = [basicSetup, themeSlot.of(theme())];
    const working = [
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
    ];
    if (single) {
      const editor = new EditorView({ doc: text, extensions: working, parent: diffHost });
      open = { path: f.path, editor, merge: null, editable, base, saved: text };
      updateDiffBar();
      return;
    }
    const merge = new MergeView({
      a: { doc: base, extensions: [common, readOnly, lineEndings(base)] },
      b: { doc: text, extensions: working },
      parent: diffHost,
      // Arrows between the sides copy the committed text back over a change.
      revertControls: editable ? "a-to-b" : undefined,
      highlightChanges: true,
      gutter: true,
    });
    open = { path: f.path, editor: merge.b, merge, editable, base, saved: text };
    updateDiffBar();
    // Start at the first change.
    if (merge.chunks.length) goToNextChunk({ state: merge.b.state, dispatch: merge.b.dispatch });
  }

  dark.addEventListener("change", () => {
    if (!open) return;
    for (const v of open.merge ? [open.merge.a, open.merge.b] : [open.editor]) v.dispatch({ effects: themeSlot.reconfigure(theme()) });
  });

  function updateDiffBar() {
    diffTitle.replaceChildren(current ? current.path : "");
    if (current?.origPath) diffTitle.prepend(`${current.origPath} → `);
    if (isDirty()) diffTitle.append(span("dirty", "●"));
    if (open && !open.editable) diffTitle.append(span("dirty", " (deleted)"));
    saveBtn.disabled = !isDirty();
    const chunks = open?.merge?.chunks ?? [];
    prevBtn.disabled = nextBtn.disabled = chunks.length === 0;
    // One pane for an added file, labelled as such; otherwise the two sides of the diff.
    const single = !!open && !open.merge;
    diffSides.classList.toggle("single", single);
    sideA.hidden = single;
    sideB.textContent = single ? "Added file" : "Working copy";
    if (!open) {
      changeCount.textContent = "";
      return;
    }
    if (single) {
      const lines = open.editor.state.doc.lines;
      changeCount.textContent = `New file · ${lines} line${lines === 1 ? "" : "s"}`;
      return;
    }
    const head = open.editor.state.selection.main.head;
    const at = chunks.findIndex((c) => head >= c.fromB && head <= Math.max(c.fromB, c.toB));
    changeCount.textContent =
      chunks.length === 0 ? "No changes" : at >= 0 ? `Change ${at + 1} of ${chunks.length}` : `${chunks.length} change${chunks.length === 1 ? "" : "s"}`;
  }

  function step(dir: 1 | -1) {
    if (!open?.merge) return;
    const v = open.editor;
    (dir > 0 ? goToNextChunk : goToPreviousChunk)({ state: v.state, dispatch: v.dispatch });
    v.focus();
  }

  prevBtn.addEventListener("click", () => step(-1));
  nextBtn.addEventListener("click", () => step(1));

  /** Writes the edited working copy to disk. Returns false if saving failed. */
  async function save(): Promise<boolean> {
    if (!open || !isDirty()) return true;
    const { path } = open;
    const at = repo;
    const text = open.editor.state.sliceDoc();
    try {
      await invoke("write_worktree_file", { repo: at, path, text });
    } catch (err) {
      setStatus(String(err), "error");
      return false;
    }
    if (open?.path === path && repo === at) open.saved = text;
    updateDiffBar();
    opts.onChanged();
    if (visible && repo === at) await refresh();
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

  let operation: Operation | null = null;
  /** The prepared message we put in the box, so it is only filled in once and can be cleared on abort. */
  let prefilled: string | null = null;

  async function refreshOperation() {
    const at = repo;
    operation = at ? await invoke<Operation | null>("operation_in_progress", { repo: at }).catch(() => null) : null;
    if (repo !== at) return;
    $("operation").hidden = !operation;
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
    closeEditor();
    try {
      await invoke("abort_operation", { repo });
      setStatus(`Aborted the ${operation.kind}`, "ok");
      if (messageBox.value === prefilled) messageBox.value = "";
      prefilled = null;
      opts.onChanged();
    } catch (err) {
      setStatus(String(err), "error");
    }
    current = null;
    await refresh();
  });

  // ---- refresh and commit --------------------------------------------------------------

  async function refresh() {
    if (!visible) return;
    if (!repo) {
      pending = { files: [] };
      current = null;
      $("operation").hidden = true;
      branchInfo.textContent = "";
      renderFiles();
      showMessage("Open a repository to see its pending changes.");
      return;
    }
    const at = repo;
    void refreshOperation();
    let next: PendingChanges;
    try {
      next = await loadPendingChanges(tauriRunner(at));
    } catch (err) {
      if (repo === at) setStatus(`Could not read pending changes: ${err}`, "error");
      return;
    }
    if (repo !== at) return; // switched repositories meanwhile
    pending = next;
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
    if (busy || !repo || !message || files.length === 0) return;
    if (!(await save())) return;
    const at = repo;
    // A rename commits both its new and its old path.
    const paths = files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));
    busy = true;
    updateCommitButton();
    setStatus("Committing…");
    try {
      const hash = await invoke<string>("commit_changes", { repo: at, message, paths });
      messageBox.value = "";
      setStatus(`Committed ${hash.slice(0, 8)}`, "ok");
      opts.onChanged();
      if (andPush) {
        setStatus(`Committed ${hash.slice(0, 8)}. Pushing…`);
        try {
          const pushed = await invoke<string>("push_current_branch", { repo: at });
          setStatus(`Committed ${hash.slice(0, 8)}. ${pushed}.`, "ok");
        } catch (err) {
          // The commit stands; only the push needs another go.
          setStatus(`Committed ${hash.slice(0, 8)}, but the push failed: ${err}`, "error");
        }
        opts.onChanged();
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
    if (busy || !repo || files.length === 0) return;
    const created = files.filter(isNew).map((f) => f.path);
    // Tracked files go back to their committed content; a rename also restores its old path.
    const tracked = files.flatMap((f) => (isNew(f) ? (f.staged === "R" && f.origPath ? [f.origPath] : []) : [f.path]));
    const what = files.length === 1 ? files[0].path : `${files.length} files`;
    const ok = await ask(
      `Undo the changes to ${what}? Their content goes back to the checked-out changeset and your edits are lost.` +
        (created.length ? `\n\nNew files (${created.length}) are moved to the Trash.` : ""),
      { title: "Undo Changes", kind: "warning", okLabel: "Undo Changes", cancelLabel: "Cancel" },
    );
    if (!ok) return;
    // Unsaved edits to an undone file are dropped, not saved first.
    if (open && files.some((f) => f.path === open!.path)) closeEditor();
    busy = true;
    updateCommitButton();
    try {
      await invoke("undo_changes", { repo, tracked, created });
      setStatus(`Undid changes to ${what}`, "ok");
      opts.onChanged();
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

  root.addEventListener("keydown", (e) => {
    // The editor handles its own keys (and marks them handled).
    if (e.defaultPrevented || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
    if (e.key === "F7") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  });
  window.addEventListener("keydown", (e) => {
    // ⌘S saves wherever the focus is while the view is showing.
    if (visible && !e.defaultPrevented && (e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      void save();
    }
  });
  // Refreshing on window focus comes from the main window's reload, which calls `refresh`.

  return {
    async setRepo(next) {
      const to = next ?? "";
      if (to === repo) return;
      if (!(await save())) setStatus("Your edits could not be saved before switching repositories, so they were dropped.", "error");
      else setStatus("");
      if (repo) drafts.set(repo, messageBox.value);
      closeEditor();
      repo = to;
      pending = { files: [] };
      excluded.clear();
      current = null;
      operation = null;
      prefilled = null;
      messageBox.value = drafts.get(repo) ?? "";
      updateDiffBar();
      if (visible) await refresh();
    },
    async show(path) {
      visible = true;
      if (path && current?.path !== path && (await save())) current = { path } as PendingFile; // refresh picks the real entry
      await refresh();
      if (!messageBox.value.trim() || document.activeElement === document.body) messageBox.focus();
    },
    async hide() {
      const ok = await save();
      visible = false;
      return ok;
    },
    refresh,
  };
}
