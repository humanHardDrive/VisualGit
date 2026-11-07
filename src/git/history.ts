/** A file's history: the changesets that changed it, following renames. */

import type { GitRunner } from "./load.ts";

export interface HistoryEntry {
  hash: string;
  /** First parent, or null for the repository's first changeset. */
  parent: string | null;
  author: string;
  /** Unix seconds. */
  time: number;
  subject: string;
  /** The file's path in this changeset. */
  path: string;
  /** Its path in the parent, when this changeset renamed it. */
  oldPath?: string;
  /** A, M, D, R, C or T. */
  status: string;
}

/** Newest first. Merges are left out, as elsewhere: a change belongs to the changeset that made it. */
export async function loadFileHistory(git: GitRunner, path: string): Promise<HistoryEntry[]> {
  const out = await git.run([
    "log",
    "--follow",
    "--no-merges",
    "-z",
    "--name-status",
    "--format=%x01%H%x00%P%x00%an%x00%at%x00%s",
    "--",
    path,
  ]);
  return parseFileHistory(out);
}

export function parseFileHistory(out: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const record of out.split("\x01")) {
    if (!record) continue;
    const [hash, parents, author, time, subject, ...rest] = record.split("\0");
    const tokens = rest.map((t) => t.replace(/^\n+/, "")).filter(Boolean);
    const status = tokens[0]?.[0];
    if (!status) continue;
    const renamed = status === "R" || status === "C";
    entries.push({
      hash,
      parent: parents.split(" ")[0] || null,
      author,
      time: Number(time),
      subject,
      status,
      path: renamed ? tokens[2] : tokens[1],
      oldPath: renamed ? tokens[1] : undefined,
    });
  }
  return entries;
}
