/**
 * A submodule's pending change, for Pending Changes' diff panes: the
 * changeset the checked-out changeset records for it, and the one committing
 * would record (the changeset checked out in it now), each described from
 * the submodule's own repository: id, author, date, branches that contain
 * it, and its message. The second also lists the changesets the move brings
 * in or leaves out.
 */

import type { GitRunner } from "./load.ts";

export interface SubmoduleChange {
  /** What the checked-out changeset records ("" when the submodule is new). */
  before: string;
  /** What committing would record ("" when the submodule is being removed). */
  after: string;
  /** Changeset ids, for the pane labels. */
  from: string | null;
  to: string | null;
  /** A one-line summary for the diff bar, e.g. "Moves forward 3 changesets". */
  summary: string;
}

const MAX_LISTED = 50;

/**
 * `path`'s change as a submodule, or null when it isn't one (in the
 * checked-out changeset or the index). `runner(dir)` runs git in `dir`.
 */
export async function submoduleChange(repo: string, path: string, runner: (dir: string) => GitRunner): Promise<SubmoduleChange | null> {
  const top = runner(repo);
  const [inHead, inIndex] = await Promise.all([
    top.run(["ls-tree", "HEAD", "--", path]).catch(() => ""),
    top.run(["ls-files", "--stage", "--", path]).catch(() => ""),
  ]);
  // "<mode> commit <id>\t<path>" and "<mode> <id> <stage>\t<path>": 160000 is a submodule.
  const recorded = inHead.startsWith("160000 ") ? inHead.split(/\s+/)[2] : null;
  const staged = inIndex.startsWith("160000 ") ? inIndex.split(/\s+/)[1] : null;
  if (!recorded && !staged) return null;

  // Its own repository, if it's checked out (an empty folder would find this repository instead).
  // Compared as git sees both, so a path through a link (like macOS's /var) still matches.
  const sub = runner(`${repo}/${path}`);
  const [outer, inner] = await Promise.all([top.run(["rev-parse", "--show-toplevel"]).catch(() => ""), sub.run(["rev-parse", "--show-toplevel"]).catch(() => "")]);
  const own = !!outer.trim() && inner.trim() === `${outer.trim()}/${path}`;
  const checkedOut = own ? (await sub.run(["rev-parse", "-q", "--verify", "HEAD"]).catch(() => "")).trim() || null : null;
  // Being removed (not in the index), or what committing records: the changeset checked out in it.
  const now = staged ? (checkedOut ?? staged) : null;

  const describe = (id: string) => describeChangeset(own ? sub : null, path, id);
  const before = recorded ? await describe(recorded) : "";
  let after = now ? await describe(now) : "";
  let summary: string;
  if (!recorded) summary = `New submodule, at ${now!.slice(0, 8)}`;
  else if (!now) summary = `Submodule removed (was at ${recorded.slice(0, 8)})`;
  else if (recorded === now) summary = "Same changeset";
  else summary = `Moves from ${recorded.slice(0, 8)} to ${now.slice(0, 8)}`;

  if (own && recorded && now && recorded !== now) {
    const [added, dropped] = await Promise.all([between(sub, recorded, now), between(sub, now, recorded)]);
    const section = (title: string, lines: string[]) =>
      `\n${title}\n` + lines.slice(0, MAX_LISTED).map((l) => `  ${l}`).join("\n") + (lines.length > MAX_LISTED ? `\n  … and ${lines.length - MAX_LISTED} more` : "") + "\n";
    const n = (k: number) => `${k} changeset${k === 1 ? "" : "s"}`;
    if (added && !dropped?.length) summary = `Moves forward ${n(added.length)}`;
    else if (dropped && !added?.length) summary = `Moves back ${n(dropped.length)}`;
    else if (added && dropped) summary = `Moves to another line: ${n(added.length)} in, ${n(dropped.length)} out`;
    if (added?.length) after += section(`Brings in ${n(added.length)}, newest first:`, added);
    if (dropped?.length) after += section(`Leaves out ${n(dropped.length)} the recorded one has, newest first:`, dropped);
    if (!added && !dropped) after += "\n(The submodule's repository doesn't have both changesets, so what's between them isn't known. Fetch in the submodule to see.)\n";
  }
  if (own && now) {
    const changes = (await sub.run(["status", "--porcelain", "--untracked-files=no"]).catch(() => "")).split("\n").filter(Boolean).length;
    if (changes) {
      after += `\nThe submodule also has ${changes} uncommitted change${changes === 1 ? "" : "s"} of its own. Committing here doesn't include ${changes === 1 ? "it" : "them"}: ${changes === 1 ? "it's" : "they're"} the submodule's to commit (right-click it in the Files view: Open Submodule as Repository).\n`;
    }
  }
  return { before, after, from: recorded, to: now, summary };
}

/** Changesets in `to` and not in `from`, "<id> <subject>", newest first; null if either isn't there. */
async function between(sub: GitRunner, from: string, to: string): Promise<string[] | null> {
  try {
    const out = await sub.run(["log", "--format=%h %s", `${from}..${to}`, "--"]);
    return out.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

/** A changeset of the submodule, as text: id, author, date, branches containing it, message. */
async function describeChangeset(sub: GitRunner | null, path: string, id: string): Promise<string> {
  const head = `Submodule  ${path}\nChangeset  ${id}\n`;
  if (!sub) return `${head}\n(The submodule isn't checked out, so this changeset's details aren't available.)\n`;
  try {
    const out = await sub.run(["log", "-1", "--format=%an <%ae>%x00%aI%x00%s%x00%b", id, "--"]);
    const [author, date, subject, body] = out.split("\0");
    const [branches, tags] = await Promise.all([
      sub.run(["for-each-ref", "--contains", id, "--format=%(refname:short)", "refs/heads", "refs/remotes"]).catch(() => ""),
      sub.run(["for-each-ref", "--points-at", id, "--format=%(refname:short)", "refs/tags"]).catch(() => ""),
    ]);
    const list = (s: string) => s.split("\n").filter((b) => b && !b.endsWith("/HEAD"));
    const on = list(branches);
    let text = head;
    text += `Author     ${author}\n`;
    text += `Date       ${new Date(date).toLocaleString()}\n`;
    text += `On         ${on.length ? on.slice(0, 8).join(", ") + (on.length > 8 ? `, and ${on.length - 8} more` : "") : "no branch (only reachable by its id)"}\n`;
    if (list(tags).length) text += `Release    ${list(tags).join(", ")}\n`;
    text += `\n${subject || "(no message)"}\n`;
    if (body.trim()) text += `\n${body.trim()}\n`;
    return text;
  } catch {
    return `${head}\n(The submodule's repository doesn't have this changeset. Fetch in the submodule to see its details.)\n`;
  }
}
