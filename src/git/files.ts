/** The repository's files as they are in the working copy, with pending-change status. */

import type { GitRunner } from "./load.ts";
import { loadPendingChanges, type PendingFile } from "./status.ts";

export interface FileStatus {
  /** One letter, as in Pending Changes: M, A, D, R, T, ?, U. */
  letter: string;
  title: string;
}

export interface LastChange {
  hash: string;
  author: string;
  /** Unix seconds (author time). */
  time: number;
}

export interface FileList {
  /** Tracked files plus new files git isn't ignoring, sorted. */
  paths: string[];
  /** Files with pending changes. */
  status: Map<string, FileStatus>;
  /** The changeset that last changed each file, once loaded (see `loadLastChanges`). */
  last?: Map<string, LastChange>;
}

/**
 * The last committed change to every file in history: one pass over
 * `git log --name-only`, newest first, keeping each file's first appearance.
 * Merges are skipped, so a change is credited to the changeset that made it.
 */
export async function loadLastChanges(git: GitRunner): Promise<Map<string, LastChange>> {
  const out = await git.run(["log", "-z", "--no-merges", "--format=%x01%H%x00%an%x00%at", "--name-only", "HEAD"]);
  return parseLastChanges(out);
}

export function parseLastChanges(out: string): Map<string, LastChange> {
  const last = new Map<string, LastChange>();
  for (const record of out.split("\x01")) {
    if (!record) continue;
    const [hash, author, time, ...names] = record.split("\0");
    const change = { hash, author, time: Number(time) };
    for (const raw of names) {
      const name = raw.replace(/^\n+/, "");
      if (name && !last.has(name)) last.set(name, change);
    }
  }
  return last;
}

const NAMES: Record<string, string> = { M: "Modified", T: "Type changed", A: "Added", D: "Deleted", R: "Renamed", C: "Copied" };

/** The change a pending file shows against the checked-out changeset. */
export function statusOf(f: PendingFile): FileStatus {
  if (f.conflict) return { letter: "U", title: "Conflict" };
  if (f.untracked) return { letter: "?", title: "New file (untracked)" };
  const c = f.staged === "A" || f.staged === "R" || f.staged === "C" || f.staged === "D" ? f.staged : (f.unstaged ?? f.staged ?? "M");
  return { letter: c, title: NAMES[c] };
}

export async function loadFiles(git: GitRunner): Promise<FileList> {
  const [tracked, untracked, pending] = await Promise.all([
    git.run(["ls-files", "-z"]),
    git.run(["ls-files", "-z", "--others", "--exclude-standard"]),
    loadPendingChanges(git),
  ]);
  const paths = new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean));
  const status = new Map<string, FileStatus>();
  for (const f of pending.files) {
    status.set(f.path, statusOf(f));
    // Deleted with `git rm` (no longer in the index): still worth listing.
    paths.add(f.path);
  }
  return { paths: [...paths].sort(), status };
}

export interface Folder {
  name: string;
  /** Repository-relative path, "" for the root. */
  path: string;
  folders: Folder[];
  files: string[];
  /** Files with pending changes anywhere below. */
  changed: number;
  /** The most recent last change of any file below, once known. */
  latest?: LastChange;
}

/** Turns a flat path list into folders (sorted, folders before files). */
export function buildTree(list: FileList): Folder {
  const root: Folder = { name: "", path: "", folders: [], files: [], changed: 0 };
  const byPath = new Map<string, Folder>([["", root]]);
  const folderOf = (dir: string): Folder => {
    let f = byPath.get(dir);
    if (f) return f;
    const slash = dir.lastIndexOf("/");
    const parent = folderOf(slash < 0 ? "" : dir.slice(0, slash));
    f = { name: dir.slice(slash + 1), path: dir, folders: [], files: [], changed: 0 };
    parent.folders.push(f);
    byPath.set(dir, f);
    return f;
  };
  for (const p of list.paths) {
    const slash = p.lastIndexOf("/");
    const folder = folderOf(slash < 0 ? "" : p.slice(0, slash));
    folder.files.push(p);
    const change = list.last?.get(p);
    if (change) {
      // A folder was last modified when anything inside it was.
      let dir = folder.path;
      for (;;) {
        const f = byPath.get(dir)!;
        if (!f.latest || change.time > f.latest.time) f.latest = change;
        if (dir === "") break;
        const i = dir.lastIndexOf("/");
        dir = i < 0 ? "" : dir.slice(0, i);
      }
    }
    if (list.status.has(p)) {
      // Count the change in every folder up to the root.
      let dir = folder.path;
      for (;;) {
        byPath.get(dir)!.changed++;
        if (dir === "") break;
        const i = dir.lastIndexOf("/");
        dir = i < 0 ? "" : dir.slice(0, i);
      }
    }
  }
  const sort = (f: Folder) => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name));
    f.files.sort((a, b) => a.localeCompare(b));
    f.folders.forEach(sort);
  };
  sort(root);
  return root;
}
