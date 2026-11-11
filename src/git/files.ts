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

/**
 * What a listed path is when it isn't a plain file: a submodule (in the index
 * as a link to another repository's changeset), a repository inside this one
 * that isn't a submodule yet, a symbolic link, or an executable file.
 */
export type FileKind = "submodule" | "repository" | "symlink" | "executable";

export interface FileList {
  /** Tracked files plus new files git isn't ignoring, sorted. */
  paths: string[];
  /** The paths that aren't plain files. */
  kinds: Map<string, FileKind>;
  /** Files with pending changes. */
  status: Map<string, FileStatus>;
  /** The changeset that last changed each file, once loaded (see `loadLastChanges`). */
  last?: Map<string, LastChange>;
  /**
   * Submodules (and repositories inside) whose own files have been listed in
   * here too, by repository-relative path. Their files' paths, statuses and
   * last changes are prefixed with that path (see `nestList`).
   */
  nested?: Map<string, NestedRepo>;
  /** Last changes of files inside `nested` repositories, from their own histories. */
  nestedLast?: Map<string, LastChange>;
}

export interface NestedRepo {
  /** Its folder on disk. */
  root: string;
  /** False for a submodule that hasn't been checked out (an empty folder): nothing to list. */
  checkedOut: boolean;
}

/** A submodule, or a repository inside this one: shown as a folder that opens onto its own files. */
export const isRepoKind = (kind: FileKind | undefined): kind is "submodule" | "repository" => kind === "submodule" || kind === "repository";

/**
 * Adds the files of the repository at `at` (listed on its own, with paths
 * relative to it) to `parent`, under `at/`.
 */
export function nestList(parent: FileList, at: string, root: string, sub: FileList) {
  const under = (p: string) => `${at}/${p}`;
  const paths = new Set(parent.paths);
  for (const p of sub.paths) paths.add(under(p));
  parent.paths = [...paths].sort();
  for (const [p, k] of sub.kinds) parent.kinds.set(under(p), k);
  for (const [p, s] of sub.status) parent.status.set(under(p), s);
  parent.nestedLast ??= new Map();
  for (const m of [sub.last, sub.nestedLast]) for (const [p, c] of m ?? []) parent.nestedLast.set(under(p), c);
  parent.nested ??= new Map();
  parent.nested.set(at, { root, checkedOut: true });
  for (const [p, r] of sub.nested ?? []) parent.nested.set(under(p), r);
}

/** The last change to `path`, from this repository's history or (inside a submodule) the submodule's. */
export const lastChangeOf = (list: FileList, path: string) => list.last?.get(path) ?? list.nestedLast?.get(path);

/**
 * Which listed repository `path` belongs to: the innermost submodule it's
 * in (or is), with the path relative to it; null for this repository's own.
 */
export function ownerOf(list: FileList, path: string): { at: string; root: string; path: string } | null {
  let best: string | null = null;
  for (const at of list.nested?.keys() ?? []) {
    if ((path === at || path.startsWith(`${at}/`)) && at.length > (best?.length ?? -1)) best = at;
  }
  if (best === null) return null;
  return { at: best, root: list.nested!.get(best)!.root, path: path === best ? "" : path.slice(best.length + 1) };
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

/** Index modes that aren't plain files. */
const MODES: Record<string, FileKind> = { "160000": "submodule", "120000": "symlink", "100755": "executable" };

export async function loadFiles(git: GitRunner): Promise<FileList> {
  const [tracked, untracked, pending] = await Promise.all([
    // With modes: "<mode> <id> <stage>\t<path>".
    git.run(["ls-files", "-z", "--stage"]),
    git.run(["ls-files", "-z", "--others", "--exclude-standard"]),
    loadPendingChanges(git),
  ]);
  const paths = new Set<string>();
  const kinds = new Map<string, FileKind>();
  for (const entry of tracked.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const path = entry.slice(tab + 1);
    paths.add(path);
    const kind = MODES[entry.slice(0, entry.indexOf(" "))];
    if (kind) kinds.set(path, kind);
  }
  for (const path of untracked.split("\0")) {
    if (!path) continue;
    // git lists a repository inside this one (not a submodule yet) as its folder, with a trailing slash.
    if (path.endsWith("/")) {
      paths.add(path.slice(0, -1));
      kinds.set(path.slice(0, -1), "repository");
    } else paths.add(path);
  }
  const status = new Map<string, FileStatus>();
  for (const f of pending.files) {
    // A repository inside this one is listed as its folder ("vendor/"); the tree shows it as "vendor".
    const path = f.path.endsWith("/") ? f.path.slice(0, -1) : f.path;
    status.set(path, statusOf(f));
    // Deleted with `git rm` (no longer in the index): still worth listing.
    paths.add(path);
  }
  return { paths: [...paths].sort(), kinds, status };
}

/** Names for common extensions; anything else is "<EXT> file". */
const TYPES: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript (JSX)", js: "JavaScript", mjs: "JavaScript module", cjs: "JavaScript (CommonJS)", jsx: "JavaScript (JSX)",
  json: "JSON", jsonc: "JSON with comments", html: "HTML", htm: "HTML", css: "CSS", scss: "Sass", less: "Less",
  md: "Markdown", mdx: "MDX", txt: "Text", rst: "reStructuredText", csv: "CSV", tsv: "TSV", xml: "XML", svg: "SVG image",
  yml: "YAML", yaml: "YAML", toml: "TOML", ini: "INI", cfg: "Config", conf: "Config", env: "Environment",
  rs: "Rust", go: "Go", py: "Python", rb: "Ruby", java: "Java", kt: "Kotlin", swift: "Swift", m: "Objective-C",
  c: "C", h: "C header", cpp: "C++", cc: "C++", cxx: "C++", hpp: "C++ header", cs: "C#", fs: "F#", php: "PHP",
  lua: "Lua", dart: "Dart", scala: "Scala", ex: "Elixir", exs: "Elixir script", erl: "Erlang", hs: "Haskell",
  sh: "Shell script", bash: "Shell script", zsh: "Shell script", ps1: "PowerShell", bat: "Batch file", cmd: "Batch file",
  sql: "SQL", graphql: "GraphQL", proto: "Protocol Buffers", vue: "Vue", svelte: "Svelte",
  png: "PNG image", jpg: "JPEG image", jpeg: "JPEG image", gif: "GIF image", webp: "WebP image", ico: "Icon", icns: "Icon", bmp: "Bitmap image",
  pdf: "PDF", zip: "ZIP archive", gz: "Gzip archive", tar: "Tar archive", lock: "Lock file", log: "Log",
  woff: "Font", woff2: "Font", ttf: "Font", otf: "Font", mp3: "Audio", wav: "Audio", mp4: "Video", mov: "Video",
};
/** Well-known files by name. */
const NAMED: Record<string, string> = {
  ".gitignore": "Git ignore rules", ".gitmodules": "Git submodules", ".gitattributes": "Git attributes", ".gitkeep": "Placeholder",
  dockerfile: "Dockerfile", makefile: "Makefile", license: "License", "license.md": "License", readme: "Text",
  "cargo.toml": "Cargo manifest", "cargo.lock": "Cargo lock file", "package.json": "npm package", "package-lock.json": "npm lock file",
};

/** What a file is, for the Files view's Type column: "Submodule", "TypeScript", "PNG image", "File"… */
export function fileType(path: string, kind: FileKind | undefined): string {
  if (kind === "submodule") return "Submodule";
  if (kind === "repository") return "Repository (not a submodule)";
  if (kind === "symlink") return "Symbolic link";
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const named = NAMED[name];
  if (named) return named;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  const type = ext ? (TYPES[ext] ?? `${ext.toUpperCase()} file`) : kind === "executable" ? "Program" : "File";
  return kind === "executable" && ext ? `${type} (executable)` : type;
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
  /** Set when this folder is a submodule or another repository inside this one. */
  repo?: "submodule" | "repository";
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
    const kind = list.kinds.get(p);
    // A submodule (or repository inside) is a folder, which opens onto its own files once they're listed.
    const folder = isRepoKind(kind) ? folderOf(p) : folderOf(slash < 0 ? "" : p.slice(0, slash));
    if (isRepoKind(kind)) folder.repo = kind;
    else folder.files.push(p);
    const change = lastChangeOf(list, p);
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
