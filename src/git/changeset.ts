/** The files one changeset changed, read with `git diff-tree --name-status`. */

import type { GitRunner } from "./load.ts";

export type FileStatus = "A" | "M" | "D" | "R" | "C" | "T";

export interface ChangedFile {
  path: string;
  /** The path before a rename or copy. */
  origPath?: string;
  status: FileStatus;
}

/**
 * Files changed between `parent` and `changeset`; with no parent (the first
 * changeset in the repository), everything it added.
 */
export async function loadChangesetFiles(git: GitRunner, changeset: string, parent: string | null): Promise<ChangedFile[]> {
  const args = ["diff-tree", "-r", "-z", "--no-commit-id", "--name-status", "-M"];
  return parseNameStatus(await git.run(parent ? [...args, parent, changeset] : [...args, "--root", changeset]));
}

/** Parses `--name-status -z`: a status (R/C with a score) then one path, or two for renames and copies. */
export function parseNameStatus(out: string): ChangedFile[] {
  const tokens = out.split("\0").filter((t) => t !== "");
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const letter = tokens[i][0] as FileStatus | "U" | "X";
    if (letter === "R" || letter === "C") {
      files.push({ status: letter, origPath: tokens[i + 1], path: tokens[i + 2] });
      i += 2;
    } else {
      files.push({ status: "AMDT".includes(letter) ? (letter as FileStatus) : "M", path: tokens[i + 1] });
      i += 1;
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
