/** Right-hand panel: details for the selected changeset or branch. */

import type { Model } from "../model/infer.ts";
import { branchColor, pushLabel, type Selection } from "./explorer.ts";

type Navigate = (sel: Selection) => void;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

const formatDate = (unix: number) => new Date(unix * 1000).toLocaleString();

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
  if (model.unpushed.has(hash)) row(dl, "Pushed", el("span", { className: "unpushed" }, "No, not on any remote branch yet"));

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
  const push = pushLabel(model, b);
  const n = (k: number) => `${k} changeset${k === 1 ? "" : "s"}`;
  if (push && !b.remote) {
    row(dl, "Pushed", el("span", { className: "unpushed" }, `Never pushed${b.unpushed ? `; ${n(b.unpushed)} only here` : ""}`));
  } else if (push) {
    const lines: string[] = [];
    if (b.ahead) {
      // Some or all may already be on the remote under another branch (one created from this one, say).
      const elsewhere = b.ahead - b.unpushed;
      let text = `${n(b.ahead)} not on ${b.remote} yet`;
      if (b.unpushed === 0) text += `. ${b.ahead === 1 ? "It's" : "They're"} on the remote under other branches, so pushing only moves ${b.remote} here`;
      else if (elsewhere > 0) text += ` (${n(b.unpushed)} on no remote at all)`;
      lines.push(text);
    }
    if (b.behind) lines.push(`${b.remote} has ${n(b.behind)} this branch doesn't, as of the last fetch`);
    row(dl, "Pushed", el("span", { className: "unpushed" }, lines.join(". ") + "."));
  } else if (model.hasRemotes && b.remote) {
    row(dl, "Pushed", `Up to date with ${b.remote} (as of the last fetch)`);
  }
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

export function clearDetails(panel: HTMLElement) {
  panel.replaceChildren(el("div", { className: "placeholder" }, "Select a changeset or branch"));
}
