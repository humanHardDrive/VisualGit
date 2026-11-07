/** Right-hand panel: details for the selected changeset or branch, or the pending changes. */

import type { GitRunner } from "../git/load.ts";
import { loadPendingChanges, type ChangeCode, type PendingFile } from "../git/status.ts";
import type { Model } from "../model/infer.ts";
import { branchColor, type Selection } from "./explorer.ts";

type Navigate = (sel: Selection) => void;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

const formatDate = (unix: number) => new Date(unix * 1000).toLocaleString();

/** Bumped whenever the panel changes, so a slow `git status` can't overwrite a newer panel. */
let pendingRequest = 0;

function commitLink(model: Model, hash: string, go: Navigate) {
  const c = model.commits.get(hash);
  return el("button", {
    className: "link",
    title: c?.subject ?? "",
    onclick: () => go({ kind: "commit", hash }),
  }, hash.slice(0, 8));
}

function branchLink(model: Model, id: number, go: Navigate) {
  const b = model.branches[id];
  const btn = el("button", { className: "link", onclick: () => go({ kind: "branch", id }) }, b.name);
  btn.style.color = branchColor(model, id);
  btn.style.fontFamily = "inherit";
  btn.style.fontSize = "13px";
  return btn;
}

function row(dl: HTMLElement, label: string, ...value: (Node | string)[]) {
  dl.append(el("dt", {}, label), el("dd", {}, ...value));
}

export function showCommit(panel: HTMLElement, model: Model, hash: string, go: Navigate) {
  pendingRequest++;
  const c = model.commits.get(hash)!;
  const ownerId = model.owner.get(hash)!;
  const dl = el("dl");
  row(dl, "Changeset", el("span", { className: "mono" }, hash));
  row(dl, "Branch", branchLink(model, ownerId, go));
  row(dl, "Author", `${c.author} <${c.email}>`);
  row(dl, "Date", formatDate(c.time));
  if (c.parents.length) {
    const parents = el("span");
    c.parents.forEach((p, i) => {
      if (i) parents.append(" ");
      parents.append(model.commits.has(p) ? commitLink(model, p, go) : el("span", { className: "mono" }, p.slice(0, 8)));
    });
    row(dl, c.parents.length > 1 ? "Merges" : "Parent", parents);
  }
  const tags = model.tags.get(hash);
  if (tags) row(dl, tags.length > 1 ? "Releases" : "Release", tags.join(", "));
  const refs = model.refsAt.get(hash);
  if (refs) row(dl, "Refs", refs.join(", "));

  const message = el("pre", {}, c.body ? `${c.subject}\n\n${c.body}` : c.subject);
  panel.replaceChildren(
    el("h2", {}, c.subject || "(no message)"),
    el("div", { className: "kind" }, c.parents.length > 1 ? "Merge changeset" : "Changeset"),
    dl,
    el("h3", {}, "Message"),
    message,
  );
}

export function showBranch(panel: HTMLElement, model: Model, id: number, go: Navigate) {
  pendingRequest++;
  const b = model.branches[id];
  const kind: Record<typeof b.kind, string> = {
    trunk: "Main branch",
    local: "Branch",
    remote: "Remote branch (no local copy)",
    deleted: "Deleted branch, recovered from its merge",
    detached: "Detached HEAD",
    anonymous: "Unnamed line of changesets",
  };
  const dl = el("dl");
  row(dl, "Changesets", String(b.commits.length));
  if (b.parent !== null) row(dl, "Parent", branchLink(model, b.parent, go));
  if (b.base) row(dl, b.commits.length ? "Created at" : "Points at", commitLink(model, b.base, go));
  if (b.createdFrom) row(dl, "Created from", b.createdFrom);
  if (b.createdAt) row(dl, "Created", formatDate(b.createdAt));
  if (b.commits.length) {
    const first = model.commits.get(b.commits[0])!;
    const last = model.commits.get(b.commits[b.commits.length - 1])!;
    row(dl, "First", commitLink(model, first.hash, go));
    row(dl, "Latest", commitLink(model, last.hash, go), ` · ${formatDate(last.time)}`);
  }
  if (b.refs.length) row(dl, "Refs", b.refs.join("\n"));
  if (b.children.length) {
    const kids = el("span");
    b.children.forEach((c, i) => {
      if (i) kids.append(", ");
      kids.append(branchLink(model, c, go));
    });
    row(dl, "Children", kids);
  }

  const children: (Node | string)[] = [el("h2", {}, b.name), el("div", { className: "kind" }, kind[b.kind] + (b.isHead ? " · checked out" : "")), dl];
  if (b.commits.length === 0 && b.kind !== "trunk") {
    children.push(el("p", { className: "kind" }, "This branch has no changesets of its own yet. It still gets its own lane, starting at the changeset it was created from."));
  }
  panel.replaceChildren(...children);
}

const CHANGE_NAMES: Record<ChangeCode, string> = {
  M: "Modified",
  T: "Type changed",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
};

function fileRow(path: string, letter: string, title: string, cls: string, from?: string) {
  const slash = path.lastIndexOf("/", path.endsWith("/") ? path.length - 2 : path.length);
  const name = el("span", { className: "file-name" }, path.slice(slash + 1));
  const dir = slash >= 0 ? el("span", { className: "file-dir" }, path.slice(0, slash + 1)) : "";
  return el(
    "div",
    { className: "file", title: from ? `${title}: ${from} → ${path}` : `${title}: ${path}` },
    el("span", { className: `file-status ${cls}` }, letter),
    el("span", { className: "file-path" }, dir, name),
  );
}

function fileGroup(title: string, rows: HTMLElement[]) {
  return rows.length ? [el("h3", {}, `${title} (${rows.length})`), el("div", { className: "files" }, ...rows)] : [];
}

const changeRow = (f: PendingFile, c: ChangeCode) => fileRow(f.path, c, CHANGE_NAMES[c], `st-${c}`, f.origPath);

/**
 * The working tree compared with the checked-out changeset: staged and
 * unstaged changes, untracked files and merge conflicts.
 */
export async function showPendingChanges(panel: HTMLElement, model: Model, git: GitRunner, go: Navigate, onRefresh: () => void) {
  const id = ++pendingRequest;
  const refresh = el("button", { className: "icon", title: "Refresh", onclick: onRefresh }, "↻");
  const head = el("div", { className: "details-head" }, el("h2", {}, "Pending Changes"), refresh);
  if (!panel.querySelector(".pending")) panel.replaceChildren(head, el("div", { className: "kind" }, "Reading the working tree…"));

  let pending;
  try {
    pending = await loadPendingChanges(git);
  } catch (err) {
    if (id === pendingRequest) panel.replaceChildren(head, el("p", { className: "kind" }, `Could not read pending changes: ${err}`));
    return;
  }
  if (id !== pendingRequest) return;

  const base: (Node | string)[] = [];
  if (pending.branch) {
    const b = model.branches.find((x) => x.name === pending.branch && x.kind === "local");
    base.push("On ", b ? branchLink(model, b.id, go) : pending.branch);
  } else base.push(pending.head ? "Detached HEAD" : "No changesets yet");
  if (pending.head) base.push(" · based on ", model.commits.has(pending.head) ? commitLink(model, pending.head, go) : pending.head.slice(0, 8));

  const { files } = pending;
  const conflicts = files.filter((f) => f.conflict).map((f) => fileRow(f.path, "U", "Conflict", "st-U"));
  const staged = files.filter((f) => f.staged).map((f) => changeRow(f, f.staged!));
  const unstaged = files.filter((f) => f.unstaged).map((f) => changeRow(f, f.unstaged!));
  const untracked = files.filter((f) => f.untracked).map((f) => fileRow(f.path, "?", "Untracked", "st-untracked"));

  const body: (Node | string)[] = files.length
    ? [
        ...fileGroup("Conflicts", conflicts),
        ...fileGroup("Staged", staged),
        ...fileGroup("Changes", unstaged),
        ...fileGroup("Untracked", untracked),
      ]
    : [el("p", { className: "kind" }, "No pending changes. The working tree matches the checked-out changeset.")];
  panel.replaceChildren(head, el("div", { className: "kind pending" }, ...base), ...body);
}

export function clearDetails(panel: HTMLElement) {
  pendingRequest++;
  panel.replaceChildren(el("div", { className: "placeholder" }, "Select a changeset or branch"));
}
