/**
 * Pushing a branch, from the Branch Explorer or Pending Changes' Commit and
 * Push. VisualGit checks the remote first; when its branch has changesets this
 * one doesn't (someone pushed since you last got them), nothing is pushed.
 * Instead it explains and offers to merge them: the branch moves to what the
 * remote has, and its own changesets are merged back in without committing,
 * so the result can be built and tested in Pending Changes before it's
 * committed and pushed. Conflicts open the merge window first. See
 * `sync_branch` in src-tauri/src/merge.rs.
 */

import { invoke } from "@tauri-apps/api/core";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { reportSubmoduleFailures, submodulesUpdated, type SubmoduleUpdate } from "./submoduleUpdate.ts";

/** Mirrors `Diverged` in src-tauri/src/merge.rs. */
export interface Diverged {
  branch: string;
  /** "origin/main". */
  remote: string;
  ahead: number;
  behind: number;
  checkedOut: boolean;
}

/** Mirrors `Pushed` in src-tauri/src/pending.rs. */
interface Pushed {
  message: string | null;
  diverged: Diverged | null;
}

const changesets = (n: number) => `${n} changeset${n === 1 ? "" : "s"}`;

/**
 * Pushes `branch` (null: the checked-out one). Resolves with a line saying
 * what happened, for the caller's status; rejects with git's error.
 */
export async function pushBranch(repo: string, branch: string | null): Promise<string> {
  const pushed = await invoke<Pushed>(branch ? "push_branch" : "push_current_branch", branch ? { repo, branch } : { repo });
  if (pushed.diverged) return offerMerge(repo, pushed.diverged);
  return `${pushed.message ?? "Pushed"}.`;
}

/** Explains why the push didn't happen and, for the checked-out branch, offers the merge. */
async function offerMerge(repo: string, d: Diverged): Promise<string> {
  const title = `${d.remote} has new changes`;
  const why =
    `${d.remote} has ${changesets(d.behind)} that ${d.branch} doesn't: someone pushed to it since you last got its changes. ` +
    `${d.branch} has ${changesets(d.ahead)} of its own, shown as ${d.branch} (local).\n\n` +
    `They need merging before ${d.branch} can be pushed. Merging moves ${d.branch} to ${d.remote} and merges your changesets into it. ` +
    `The result waits in Pending Changes, so you can build and test it before committing. Then push again.`;
  const notPushed = `Not pushed: ${d.remote} has new changes to merge first.`;
  if (!d.checkedOut) {
    await message(`${why}\n\nSwitch to ${d.branch} to merge: it happens in its working copy.`, { title, kind: "warning" });
    return notPushed;
  }
  const ok = await ask(`${why}\n\nIf any files conflict, the merge window opens to resolve them.`, {
    title,
    kind: "warning",
    okLabel: "Merge",
    cancelLabel: "Not Now",
  });
  if (!ok) return notPushed;

  const started = await invoke<{ local: string; conflicts: string[]; submodules: SubmoduleUpdate }>("sync_branch", { repo, branch: d.branch });
  if (started.conflicts.length) {
    await invoke("open_merge_window", { repo, from: started.local });
    const n = started.conflicts.length;
    return `Merging your changesets into ${d.remote}: ${n} conflicted file${n === 1 ? "" : "s"} to resolve in the merge window.`;
  }
  void reportSubmoduleFailures(started.submodules, "merge");
  void invoke("show_pending_changes", { repo });
  return `Merged your changesets into ${d.remote}.${submodulesUpdated(started.submodules)} Build and test, then commit in Pending Changes and push.`;
}
