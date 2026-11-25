/**
 * The list of repositories VisualGit keeps: workspaces (folders whose
 * repositories are all listed) and repositories added on their own, plus the
 * one last opened. Stored by `library.rs` in VisualGit's settings folder.
 *
 * These functions never touch disk: changing the list returns a new one, and
 * `groupLibrary` turns it, with what scanning found, into what the repository
 * menu and the Workspace view show.
 */

import type { RepoInfo } from "../view/workspaceList.ts";

/** Mirrors `Library` in src-tauri/src/library.rs. */
export interface Library {
  workspaces: string[];
  repositories: string[];
  last: string | null;
}

export const emptyLibrary = (): Library => ({ workspaces: [], repositories: [], last: null });

export interface LibraryGroup {
  kind: "workspace" | "repositories";
  /** The workspace's folder; undefined for the repositories added on their own. */
  path?: string;
  /** The workspace folder couldn't be read (moved, deleted, or a drive not connected). */
  missing: boolean;
  repos: ListedRepo[];
}

export interface ListedRepo extends RepoInfo {
  /** Added on its own and gone from where it was: shown so it can be found again or forgotten. */
  missing?: boolean;
  /** Added on its own (not found by scanning a workspace), so it can be taken off the list. */
  own?: boolean;
}

const sameAs = (a: string) => (b: string) => a === b;

export function addWorkspace(lib: Library, path: string): Library {
  return lib.workspaces.some(sameAs(path)) ? lib : { ...lib, workspaces: [...lib.workspaces, path] };
}

/** Adds a repository opened from outside the list; one a workspace already lists isn't added again. */
export function addRepository(lib: Library, path: string, listed: (path: string) => boolean): Library {
  if (lib.repositories.some(sameAs(path)) || listed(path)) return lib;
  return { ...lib, repositories: [...lib.repositories, path] };
}

/** Forgets a workspace. Nothing on disk is touched. */
export function removeWorkspace(lib: Library, path: string): Library {
  return { ...lib, workspaces: lib.workspaces.filter((w) => w !== path) };
}

/** Forgets a repository added on its own. Nothing on disk is touched. */
export function removeRepository(lib: Library, path: string): Library {
  return { ...lib, repositories: lib.repositories.filter((r) => r !== path), last: lib.last === path ? null : lib.last };
}

/** The list for someone who used VisualGit before it kept one: their workspace and last repository. */
export function carriedOver(workspace: string | null, last: string | null, inside: (path: string, root: string) => boolean): Library {
  const lib = emptyLibrary();
  if (workspace) lib.workspaces.push(workspace);
  if (last && !(workspace && inside(last, workspace))) lib.repositories.push(last);
  lib.last = last;
  return lib;
}

/**
 * What to show: each workspace's repositories (`scans`: what scanning it
 * found, null if its folder couldn't be read, undefined if not scanned yet),
 * then the repositories added on their own (`singles`: null for one that's
 * gone). A repository a workspace lists appears there only, never twice.
 */
export function groupLibrary(
  lib: Library,
  scans: Map<string, RepoInfo[] | null>,
  singles: Map<string, RepoInfo | null>,
): LibraryGroup[] {
  const seen = new Set<string>();
  const groups: LibraryGroup[] = lib.workspaces.map((path) => {
    const scan = scans.get(path);
    const repos = (scan ?? []).filter((r) => !seen.has(r.path));
    for (const r of repos) seen.add(r.path);
    return { kind: "workspace", path, missing: scan === null, repos };
  });
  const own: ListedRepo[] = [];
  for (const path of lib.repositories) {
    if (seen.has(path)) continue;
    seen.add(path);
    const info = singles.get(path);
    const name = path.split("/").pop() || path;
    own.push(info ? { ...info, own: true } : { path, name, head: null, detached: false, own: true, missing: info === null });
  }
  if (own.length) groups.push({ kind: "repositories", missing: false, repos: own });
  return groups;
}
