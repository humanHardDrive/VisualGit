/**
 * The checked-out branch's remote branch has moved on while there are pending
 * changes (see `remote_moved` in src-tauri/src/merge.rs). Committing still
 * works, but the commit lands on a branch that needs merging with the remote
 * before it can be pushed, so the user is told before committing: once when a
 * fetch brings the changes in, and in a banner over Pending Changes.
 */

import { invoke } from "@tauri-apps/api/core";

/** Mirrors `RemoteMoved` in src-tauri/src/merge.rs. */
export interface RemoteMoved {
  branch: string;
  /** "origin/main". */
  remote: string;
  behind: number;
  /** Pending files the remote's changesets also change. */
  overlap: string[];
}

export const remoteMoved = (repo: string) => invoke<RemoteMoved | null>("remote_moved", { repo }).catch(() => null);

const changesets = (n: number) => `${n} changeset${n === 1 ? "" : "s"}`;

function files(paths: string[], max = 8): string {
  const shown = paths.slice(0, max).join(", ");
  return paths.length > max ? `${shown} and ${paths.length - max} more` : shown;
}

/** What committing now means, and where conflicts are likely. */
function consequence(r: RemoteMoved): string {
  const next =
    `You can still commit. When you push, VisualGit offers to merge ${r.remote}'s changesets in first, ` +
    `and the result waits in Pending Changes to build and test before it's committed.`;
  if (!r.overlap.length) return next;
  const one = r.overlap.length === 1;
  return `${next}\n\n${one ? "This file is" : "These files are"} changed both here and on ${r.remote}, so expect conflicts to resolve: ${files(r.overlap)}.`;
}

/** The message box after a fetch. */
export function remoteMovedAlert(r: RemoteMoved): { title: string; text: string } {
  return {
    title: `${r.remote} has new changes`,
    text: `The fetch brought ${changesets(r.behind)} on ${r.remote} that ${r.branch} doesn't have, and you have pending changes on ${r.branch}.\n\n${consequence(r)}`,
  };
}

/** The banner over Pending Changes. */
export function remoteMovedBanner(r: RemoteMoved): string {
  const conflicts = r.overlap.length ? ` Also changed there: ${files(r.overlap, 4)}.` : "";
  return `${r.remote} has ${changesets(r.behind)} that ${r.branch} doesn't (as of the last fetch). Committing still works; pushing then offers to merge them in first.${conflicts}`;
}
