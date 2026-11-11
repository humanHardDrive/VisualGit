/**
 * Merge window: previews merging a changeset ("from") into the checked-out
 * changeset ("into"). Lists the files the merge changes, flags conflicts, and
 * shows each file's merge result next to either side; a conflicted file gets
 * Source, Destination and an editable Result. Nothing in the repository
 * changes until Merge is clicked, which always makes a merge changeset (never
 * a fast-forward), so the branch explorer keeps showing where the merged
 * changesets came from. Results edited here are written over git's when the
 * merge stops for those conflicts.
 */

import { goToNextChunk, goToPreviousChunk, MergeView } from "@codemirror/merge";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { emit } from "@tauri-apps/api/event";
import { Menu } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { basicSetup } from "codemirror";
import { stripConflicts, type ConflictRegion } from "../git/conflicts.ts";
import { loadRepo } from "../git/load.ts";
import { tauriRunner } from "../git/tauriRunner.ts";
import { inferModel, type Model } from "../model/infer.ts";
import { dark, lineEndings, readOnly, theme, themeSlot } from "../view/codemirror.ts";
import { conflictRegions, dropRegion, regionsField, setRegions, sideHighlights } from "../view/conflictPanes.ts";
import { branchColor } from "../view/explorer.ts";
import { reportSubmoduleFailures, submodulesUpdated, type SubmoduleUpdate } from "../view/submoduleUpdate.ts";

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
/** A conflicted file: Source, Destination and the merge Result side by side. */
let three: {
  path: string;
  key: string;
  source: EditorView;
  destination: EditorView;
  result: EditorView;
  host: HTMLElement;
  /** Each side's whole file, for a conflict with no blocks to choose between (one side deleted it); "" if deleted there. */
  sides: { source: string; destination: string };
} | null = null;

/** A conflicted file's Result: its text, markers taken out, and the conflicts in it not yet settled. */
interface ResultState {
  text: string;
  regions: ConflictRegion[];
}
/** Each conflicted file's Result as git leaves it (markers taken out), once loaded. */
const originals = new Map<string, ResultState>();
/**
 * Results changed here, by path: applied to the working copy when the merge
 * runs. Only for this pair of changesets (`resolvedFor`); a different
 * preview starts over.
 */
const results = new Map<string, ResultState>();
let resolvedFor = "";
const previewKey = (p: MergePreview) => `${p.to}:${p.from}`;
/**
 * Conflicted files that are resolved: each of their conflicts settled by
 * taking a side or marking it resolved (or, for a conflict with nothing to
 * choose between because one side deleted the file, a version chosen or the
 * file marked resolved). The merge needs all of them.
 */
const resolved = new Set<string>();
const isResolved = (path: string) => resolved.has(path);
/** Conflicted files that are binary: there's no text to resolve here, so they're left for Pending Changes. */
const binaryConflicts = new Set<string>();
/** The text conflicts still to resolve before Merge is allowed. */
const unresolved = (p: MergePreview) => p.files.filter((f) => f.conflict && !binaryConflicts.has(f.path) && !resolved.has(f.path));

function closeView() {
  view?.destroy();
  view = null;
  if (three) {
    for (const v of [three.source, three.destination, three.result]) v.destroy();
    three.host.remove();
    three = null;
  }
}
/** A merge, cherry pick or subtractive merge stopped for conflicts, if any. */
let operation: { kind: string; from: string | null } | null = null;
/** The merge changeset this window made, once it has. */
let mergedAs: string | null = null;
/** What the merge did to the submodules: brought to the changesets it records. */
let mergedSubmodules: SubmoduleUpdate | undefined;
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
      ? `Merged as ${mergedAs.slice(0, 8)}.${submodulesUpdated(mergedSubmodules)}`
      : "Already merged: everything in this changeset is already in the checked-out changeset.";
    summary.className = "clean";
  } else if (operation) {
    summary.textContent =
      operation.kind === "merge" && operation.from === p.from
        ? (applied ? `This merge is in progress, with your result for ${applied} file${applied === 1 ? "" : "s"} in place. ` : "This merge is in progress. ") +
          "Finish it in Pending Changes and commit, or abort it there." +
          (appliedError ? ` ${appliedError}` : "")
        : `A ${operation.kind} is in progress. Finish or abort it in Pending Changes before merging.`;
    summary.className = "conflicts";
  } else if (conflicts) {
    const left = unresolved(p).length;
    const plural = (n: number) => `${n} conflicted file${n === 1 ? "" : "s"}`;
    summary.textContent =
      left === 0
        ? `${files} change · ${plural(conflicts)}, all resolved: ready to merge`
        : `${files} change · ${plural(conflicts)} · ${left} to resolve before merging`;
    summary.className = left === 0 ? "clean" : "conflicts";
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

/** After a merge that stopped for conflicts: how many results edited here were written, and any failure. */
let applied = 0;
let appliedError = "";

function updateMergeButton(p: MergePreview, conflicts: number) {
  const left = unresolved(p).length;
  // Every conflict has to be resolved first.
  mergeBtn.disabled = merging || p.kind === "up-to-date" || !!operation || left > 0;
  mergeBtn.textContent = merging ? "Merging…" : "Merge";
  const into = p.toBranch ?? p.to.slice(0, 8);
  mergeBtn.title = left
    ? `Resolve ${left === conflicts ? "every conflict" : `the ${left} conflicted file${left === 1 ? "" : "s"} left`} first`
    : conflicts
      ? `Merge into ${into} with the conflicts resolved as you chose`
      : `Merge into ${into} as a new merge changeset`;
}

async function runMerge() {
  const p = preview;
  if (!p || merging) return;
  const summary = $("summary");
  applied = 0;
  appliedError = "";
  // Pending changes would be mixed into the merge (or block it): commit or undo them first.
  const status = await git().run(["status", "--porcelain", "-z", "--untracked-files=no"]).catch(() => "");
  if (status) {
    summary.textContent = "There are pending changes. Commit or undo them in Pending Changes (in the main window), then merge.";
    summary.className = "conflicts";
    void invoke("show_pending_changes", { repo });
    return;
  }
  merging = true;
  updateMergeButton(p, p.files.filter((f) => f.conflict).length);
  try {
    const result = await invoke<{ committed: string | null; conflicts: string[]; submodules: SubmoduleUpdate }>("merge", {
      repo,
      from: p.from,
      branch: mergedBranch(p.from) ?? null,
    });
    void emit("repo-changed", { repo });
    if (result.committed) {
      mergedAs = result.committed;
      mergedSubmodules = result.submodules;
      void reportSubmoduleFailures(result.submodules, "merge");
    } else {
      // Stopped for the conflicts: write the results resolved here over git's,
      // then finish the merge with git's message. Anything left over (a binary
      // file, or a conflict git found that the preview didn't) goes to Pending Changes.
      const failed: string[] = [];
      for (const path of result.conflicts) {
        if (!resolved.has(path)) continue;
        const text = (results.get(path) ?? originals.get(path))?.text;
        if (text === undefined) continue;
        await invoke("write_worktree_file", { repo, path, text }).catch(() => failed.push(path));
      }
      applied = result.conflicts.filter((path) => resolved.has(path) && !failed.includes(path)).length;
      if (failed.length) appliedError = `Could not write your result for ${failed.join(", ")}.`;
      const leftOver = result.conflicts.filter((path) => !resolved.has(path) || failed.includes(path));
      if (leftOver.length === 0) {
        try {
          const op = await invoke<{ message: string | null } | null>("operation_in_progress", { repo });
          const message = op?.message ?? `Merge ${mergedBranch(p.from) ? `branch '${mergedBranch(p.from)}'` : `changeset ${p.from.slice(0, 8)}`} into ${p.toBranch ?? p.to.slice(0, 8)}`;
          const done = await invoke<{ hash: string; submodules: SubmoduleUpdate }>("commit_changes", { repo, message, paths: result.conflicts });
          mergedAs = done.hash;
          mergedSubmodules = done.submodules;
          void reportSubmoduleFailures(done.submodules, "merge");
        } catch (err) {
          appliedError = `Your results are in place, but the merge couldn't be committed: ${err}`;
        }
      }
      void emit("repo-changed", { repo });
      if (!mergedAs) void invoke("show_pending_changes", { repo });
      else {
        results.clear();
        resolved.clear();
      }
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
    if (f.conflict) {
      // Resolved here (nothing left to choose), edited but not finished, or untouched.
      const done = isResolved(f.path);
      const binary = binaryConflicts.has(f.path);
      const badge = span(`conflict-badge${done ? " resolved" : ""}`, done ? "resolved" : binary ? "binary" : results.has(f.path) ? "conflict · edited" : "conflict");
      badge.title = done ? "Resolved; your result is used when you merge" : binary ? "A binary file: choose a version in Pending Changes after merging" : "";
      row.append(badge);
    }
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
  closeView();
  diffHost.hidden = true;
  diffMessage.hidden = false;
  diffMessage.textContent = text;
  updateDiffBar();
}

async function loadDiff() {
  const f = current;
  const p = preview;
  if (!f || !p) return showMessage(p?.kind === "up-to-date" ? "Nothing to merge." : "Select a file.");
  if (f.conflict) return loadConflict(f, p);
  const sidePath = f.origPath ?? f.path;
  const [side, result] = await Promise.all([
    // The destination has the file under its old name if the merge renames it.
    textAt(compareWith === "to" ? p.to : p.from, compareWith === "to" ? sidePath : f.path),
    textAt(p.tree, f.path),
  ]);
  if (current !== f || preview !== p) return; // moved on meanwhile
  if (side === null || result === null) return showMessage("Binary file. There is no text to compare.");

  closeView();
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

/**
 * A conflicted file, in three panes side by side: Source (what's being
 * merged in) and Destination (what's checked out), coloured where they
 * differ, and the Result: git's merge of the file with the conflict markers
 * taken out, each conflict's two sides tagged. The Result is editable: what
 * you make of it here is written to the working copy when you merge (see
 * `runMerge`).
 */
async function loadConflict(f: MergeFile, p: MergePreview) {
  // Already showing (a refresh on focus): keep the editor, with its cursor and scroll position.
  if (three?.path === f.path && three.key === previewKey(p)) return updateDiffBar();
  const [src, dest, merged] = await Promise.all([
    textAt(p.from, f.path),
    // The destination has the file under its old name if the merge renames it.
    textAt(p.to, f.origPath ?? f.path),
    textAt(p.tree, f.path),
  ]);
  if (current !== f || preview !== p) return; // moved on meanwhile
  if (src === null || dest === null || merged === null) {
    return showMessage("Binary file in conflict. There is no text to resolve here: after merging, choose a version in Pending Changes.");
  }
  // The Result shows just the code: each conflict's Destination lines, then its Source lines, tagged.
  const original = stripConflicts(merged);
  originals.set(f.path, original);
  const start = results.get(f.path) ?? original;

  closeView();
  diffMessage.hidden = true;
  diffHost.hidden = false;
  const host = document.createElement("div");
  host.className = "three-way";
  const pane = (cls: string, label: string, title: string) => {
    const box = document.createElement("div");
    box.className = "tw-editor";
    const paneEl = document.createElement("div");
    paneEl.className = `tw-pane ${cls}`;
    const labelEl = span("tw-label", label);
    labelEl.title = title;
    paneEl.append(labelEl, box);
    host.append(paneEl);
    return box;
  };
  const srcName = laneOf(p.from)?.name ?? p.from.slice(0, 8);
  const destName = p.toBranch ?? p.to.slice(0, 8);
  const srcBox = pane("tw-source", `Source · ${srcName}${src ? "" : " (deleted)"}`, `What's coming in: ${p.from.slice(0, 8)}`);
  const destBox = pane("tw-dest", `Destination · ${destName}${dest ? "" : " (deleted)"}`, `What's checked out: ${p.to.slice(0, 8)}`);
  const resultBox = pane("tw-result", "Result · editable", "The file as it will be merged. Settle each conflict by using a side or editing it and marking it resolved.");
  diffHost.append(host);

  const marks = sideHighlights(dest, src);
  const editor = (doc: string, parent: HTMLElement, extra: unknown, editable = false) =>
    new EditorView({ doc, parent, extensions: [basicSetup, themeSlot.of(theme()), editable ? [] : readOnly, lineEndings(doc), extra as never] });
  const path = f.path;
  three = {
    path,
    key: previewKey(p),
    source: editor(src, srcBox, marks.source),
    destination: editor(dest, destBox, marks.destination),
    result: editor(start.text, resultBox, [
      conflictRegions(start.regions),
      EditorView.updateListener.of((u) => {
        const regions = u.state.field(regionsField);
        if (!u.docChanged && regions === u.startState.field(regionsField)) return;
        // sliceDoc keeps the file's own line endings (CRLF stays CRLF).
        const text = u.state.sliceDoc();
        if (text === original.text && regions.length === original.regions.length) results.delete(path);
        else results.set(path, { text, regions });
        // A file with conflicts is resolved once none are left to settle.
        if (original.regions.length) {
          if (regions.length) resolved.delete(path);
          else resolved.add(path);
        }
        renderFiles();
        renderHeader(p);
      }),
      Prec.high(
        keymap.of([
          { key: "F7", run: () => (step(1), true) },
          { key: "Shift-F7", run: () => (step(-1), true) },
        ]),
      ),
      EditorView.updateListener.of((u) => {
        if (u.selectionSet || u.docChanged || u.state.field(regionsField) !== u.startState.field(regionsField)) updateDiffBar();
      }),
    ], true),
    host,
    sides: { source: src, destination: dest },
  };
  updateDiffBar();
  step(1); // to the first conflict
}

function updateDiffBar() {
  diffTitle.replaceChildren(current ? current.path : "");
  if (current?.origPath) diffTitle.prepend(`${current.origPath} → `);
  // A conflict labels its own three panes; the Into/From comparison is for the two-pane view.
  document.querySelector<HTMLElement>(".segmented")!.hidden = !!three;
  document.querySelector<HTMLElement>(".diff-sides")!.hidden = !!three;
  $("take").hidden = !three;
  if (three) {
    const regions = three.result.state.field(regionsField);
    const at = regionAtCursor(false)?.index ?? -1;
    prevBtn.disabled = nextBtn.disabled = regions.length === 0;
    const done = resolved.has(three.path);
    takeMain.disabled = !canTake("source");
    changeCount.textContent = done
      ? "Resolved"
      : regions.length === 0
        ? "Choose a version, or mark it resolved"
        : at >= 0
          ? `Conflict ${at + 1} of ${regions.length}`
          : `${regions.length} conflict${regions.length === 1 ? "" : "s"} to settle`;
    return;
  }
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
  if (three) {
    // From conflict to conflict in the Result.
    const v = three.result;
    const starts = v.state.field(regionsField).map((r) => r.destination.from);
    if (!starts.length) return;
    const head = v.state.selection.main.head;
    const inside = regionAtCursor(false)?.index ?? -1;
    const next = starts.find((s, i) => s > head && i !== inside) ?? starts[0];
    const prev = [...starts].reverse().find((s, i) => s < head && starts.length - 1 - i !== inside) ?? starts[starts.length - 1];
    const target = dir > 0 ? next : prev;
    v.dispatch({ selection: { anchor: target }, effects: EditorView.scrollIntoView(target, { y: "center" }) });
    v.focus();
    return;
  }
  if (!view) return;
  (dir > 0 ? goToNextChunk : goToPreviousChunk)({ state: view.b.state, dispatch: view.b.dispatch });
  view.b.focus();
}

/**
 * The conflict the cursor is in, or with `orNext`, else the next one after
 * it, else the first. A conflict spans its Destination lines then its Source lines.
 */
function regionAtCursor(orNext = true): { index: number; region: ConflictRegion } | null {
  if (!three) return null;
  const regions = three.result.state.field(regionsField);
  const head = three.result.state.selection.main.head;
  const inside = (r: ConflictRegion) => head >= r.destination.from && (head < r.source.to || (head === r.source.to && r.source.to === three!.result.state.doc.length));
  let index = regions.findIndex(inside);
  if (index < 0 && orNext) index = regions.findIndex((r) => r.destination.from >= head);
  if (index < 0 && orNext && regions.length) index = 0;
  return index < 0 ? null : { index, region: regions[index] };
}

/**
 * Whether taking `side` does anything: there's a conflict to settle, or (a
 * conflict with nothing to choose between, where one side deleted the file)
 * that side still has the file.
 */
function canTake(side: "source" | "destination"): boolean {
  if (!three || resolved.has(three.path)) return false;
  if (three.result.state.field(regionsField).length) return true;
  return three.sides[side] !== "" && three.result.state.sliceDoc() !== three.sides[side];
}

/**
 * Settles the conflict at the cursor by taking one side's changes over the
 * other's: the other side's lines go. Then on to the next. Without conflicts
 * to settle, takes that side's whole file.
 */
function take(side: "source" | "destination") {
  if (!three || !preview || !canTake(side)) return;
  const v = three.result;
  const at = regionAtCursor();
  if (at) {
    const drop = side === "source" ? at.region.destination : at.region.source;
    v.dispatch({ changes: { from: drop.from, to: drop.to }, effects: dropRegion.of(at.index), selection: { anchor: at.region.destination.from } });
    if (v.state.field(regionsField).length) step(1);
  } else {
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: three.sides[side] } });
    resolved.add(three.path);
    renderFiles();
    renderHeader(preview);
    updateDiffBar();
  }
  v.focus();
}

/**
 * The user says the conflict at the cursor is right as it stands (both sides'
 * lines as edited); or, for a file with nothing to choose between, the whole file.
 */
function markResolved() {
  if (!three || !preview) return;
  const at = regionAtCursor();
  if (at) {
    three.result.dispatch({ effects: dropRegion.of(at.index) });
    if (three.result.state.field(regionsField).length) step(1);
  } else {
    resolved.add(three.path);
    renderFiles();
    renderHeader(preview);
    updateDiffBar();
  }
  three.result.focus();
}

/** Puts the Result back as git would leave it, unresolved. */
function resetResult() {
  if (!three || !preview) return;
  const original = originals.get(three.path);
  if (!original) return;
  const v = three.result;
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: original.text }, effects: setRegions.of(original.regions) });
  results.delete(three.path);
  resolved.delete(three.path);
  renderFiles();
  renderHeader(preview);
  updateDiffBar();
}

// The Resolve split button, like Commit's: the main part takes the Source; the ▾ has the rest.
const takeMain = $<HTMLButtonElement>("take-main");
const takeMore = $<HTMLButtonElement>("take-more");
takeMain.addEventListener("click", () => take("source"));
takeMore.addEventListener("click", async () => {
  if (!three) return;
  const path = three.path;
  const left = takeMain.getBoundingClientRect().left;
  const bottom = takeMore.getBoundingClientRect().bottom;
  const done = resolved.has(path);
  const menu = await Menu.new({
    items: [
      { id: "source", text: "Use Source", enabled: canTake("source"), action: () => take("source") },
      { id: "destination", text: "Use Destination", enabled: canTake("destination"), action: () => take("destination") },
      { id: "resolved", text: "Mark as Resolved", enabled: !done, action: markResolved },
      { item: "Separator" },
      { id: "reset", text: "Reset to Git's Result", enabled: results.has(path) || done, action: resetResult },
    ],
  });
  await menu.popup(new LogicalPosition(left, bottom + 4));
});

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
  const all = view ? [view.a, view.b] : three ? [three.source, three.destination, three.result] : [];
  for (const v of all) v.dispatch({ effects: themeSlot.reconfigure(theme()) });
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
    if (previewKey(p) !== resolvedFor) {
      // Different changesets on either side: edits made for the old ones don't apply.
      results.clear();
      originals.clear();
      resolved.clear();
      binaryConflicts.clear();
      resolvedFor = previewKey(p);
    }
    // Binary conflicts can't be resolved here; knowing them up front keeps them from blocking the merge.
    const conflicted = p.files.filter((f) => f.conflict);
    const texts = await Promise.all(conflicted.map((f) => textAt(p.tree, f.path)));
    conflicted.forEach((f, i) => texts[i] === null && binaryConflicts.add(f.path));
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
  // Results edited here only reach the working copy by merging.
  void getCurrentWindow().onCloseRequested(async (e) => {
    if (results.size === 0) return;
    const n = results.size;
    const ok = await ask(`Close without merging? Your edits to ${n} file${n === 1 ? "" : "s"} here are only used when you merge, so they'll be lost.`, {
      title: "Unmerged Edits",
      kind: "warning",
      okLabel: "Close",
      cancelLabel: "Keep Editing",
    });
    if (!ok) e.preventDefault();
  });
  await refresh();
}

void start();
