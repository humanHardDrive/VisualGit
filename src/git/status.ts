/**
 * Pending changes: the working tree and index compared with the checked-out
 * changeset, read with `git status --porcelain=v2`.
 */

import type { GitRunner } from "./load.ts";

/** Status letters as git prints them: Modified, Type changed, Added, Deleted, Renamed, Copied. */
export type ChangeCode = "M" | "T" | "A" | "D" | "R" | "C";

export interface PendingFile {
  path: string;
  /** Where a renamed or copied file came from. */
  origPath?: string;
  /** Change recorded in the index (staged), if any. */
  staged?: ChangeCode;
  /** Change in the working tree not yet staged, if any. */
  unstaged?: ChangeCode;
  untracked?: boolean;
  /** Unmerged path from a merge, rebase or cherry-pick in progress. */
  conflict?: boolean;
}

export interface PendingChanges {
  /** Checked-out branch, or undefined when HEAD is detached. */
  branch?: string;
  /** The changeset the working tree is based on; undefined in an empty repository. */
  head?: string;
  files: PendingFile[];
}

export const STATUS_ARGS = ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"];

export async function loadPendingChanges(git: GitRunner): Promise<PendingChanges> {
  return parseStatus(await git.run(STATUS_ARGS));
}

const code = (c: string): ChangeCode | undefined => (c.length === 1 && "MTADRC".includes(c) ? (c as ChangeCode) : undefined);

/** Parses `git status --porcelain=v2 -z --branch`. */
export function parseStatus(out: string): PendingChanges {
  const result: PendingChanges = { files: [] };
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.startsWith("# branch.oid ")) {
      const oid = t.slice("# branch.oid ".length);
      if (oid !== "(initial)") result.head = oid;
    } else if (t.startsWith("# branch.head ")) {
      const head = t.slice("# branch.head ".length);
      if (head !== "(detached)") result.branch = head;
    } else if (t.startsWith("1 ") || t.startsWith("2 ")) {
      // 1 XY sub mH mI mW hH hI path
      // 2 XY sub mH mI mW hH hI Xscore path, then the original path as the next token
      const fields = t.split(" ");
      const pathStart = t.startsWith("1 ") ? 8 : 9;
      const file: PendingFile = {
        path: fields.slice(pathStart).join(" "),
        staged: code(fields[1][0]),
        unstaged: code(fields[1][1]),
      };
      if (t.startsWith("2 ")) file.origPath = tokens[++i];
      result.files.push(file);
    } else if (t.startsWith("u ")) {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      result.files.push({ path: t.split(" ").slice(10).join(" "), conflict: true });
    } else if (t.startsWith("? ")) {
      result.files.push({ path: t.slice(2), untracked: true });
    }
  }
  result.files.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}
