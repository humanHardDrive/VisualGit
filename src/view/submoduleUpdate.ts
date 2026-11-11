/**
 * Reporting what happened to the submodules after a switch, merge, cherry
 * pick, subtractive merge, or a commit that finished one: they're brought to
 * the changesets the new HEAD records, and the folders of ones it doesn't
 * have are put away (see `update_all` in src-tauri/src/submodule.rs).
 */

import { message } from "@tauri-apps/plugin-dialog";

/** Mirrors `SubmoduleUpdate` in src-tauri/src/submodule.rs. */
export interface SubmoduleUpdate {
  updated: string[];
  failed: { path: string; error: string }[];
  /** Not in the new changeset: their folders were removed (git can restore them) or moved to the Trash. */
  putAway: string[];
  /** Not in the new changeset, but left on disk (uncommitted changes in them, say). */
  kept: { path: string; error: string }[];
}

const list = (paths: string[]) => (paths.length === 1 ? `the submodule ${paths[0]}` : `${paths.length} submodules (${paths.join(", ")})`);

/** " Updated the submodule libs/x." to add to a confirmation; "" when nothing changed. */
export function submodulesUpdated(u: SubmoduleUpdate | undefined): string {
  if (!u) return "";
  let text = "";
  if (u.updated.length) text += u.updated.length === 1 ? ` Updated the submodule ${u.updated[0]}.` : ` Updated ${u.updated.length} submodules: ${u.updated.join(", ")}.`;
  if (u.putAway.length) text += ` Put away ${list(u.putAway)}, which this changeset doesn't have; switching back brings ${u.putAway.length === 1 ? "it" : "them"} back.`;
  return text;
}

/**
 * Submodules that didn't follow, or whose folders were left behind: git's
 * reasons, in full, in a message box. `what` is "switch", "merge"…
 */
export async function reportSubmoduleFailures(u: SubmoduleUpdate | undefined, what: string) {
  if (!u || (u.failed.length === 0 && u.kept.length === 0)) return;
  const parts: string[] = [];
  if (u.failed.length) {
    parts.push(
      `${u.failed.length === 1 ? `The submodule ${u.failed[0].path}` : `${u.failed.length} submodules`} couldn't be brought to the changeset it records:\n\n` +
        u.failed.map((f) => `${f.path}:\n${f.error}`).join("\n\n") +
        `\n\nYou can try again from a terminal with: git submodule update --init --recursive`,
    );
  }
  if (u.kept.length) {
    parts.push(
      `${u.kept.length === 1 ? `The submodule ${u.kept[0].path} isn't` : `${u.kept.length} submodules aren't`} in this changeset, but ${u.kept.length === 1 ? "its folder was" : "their folders were"} left on disk:\n\n` +
        u.kept.map((k) => `${k.path}:\n${k.error}`).join("\n\n") +
        `\n\nUntil then ${u.kept.length === 1 ? "it shows" : "they show"} as a new folder in Pending Changes, which won't commit ${u.kept.length === 1 ? "it" : "them"}.`,
    );
  }
  await message(`The ${what} worked.\n\n${parts.join("\n\n")}`, { title: "Some submodules need a look", kind: "warning" });
}
