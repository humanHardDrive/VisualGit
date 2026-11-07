/**
 * Branch List view: every branch as a table row, an alternative to the
 * branch explorer's lanes. Rows nest under their parent branch by default and
 * can be sorted by name, size or latest change.
 */

import type { Branch, Model } from "../model/infer.ts";
import { compileQuery } from "../model/search.ts";
import { branchColor, pushLabel } from "./explorer.ts";

export type BranchSort = "tree" | "name" | "changesets" | "latest";

export interface BranchListOptions {
  /** The branch to highlight: the selected one, or the owner of the selected changeset. */
  selected?: number;
  sort: BranchSort;
  /** Branch-name search (`*` and `?` wildcards); empty shows every branch. */
  query: string;
  onSelect(id: number): void;
  onOpen(id: number): void;
  onContextMenu(id: number): void;
  onSort(sort: BranchSort): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

const latestOf = (m: Model, b: Branch) => {
  const hash = b.commits[b.commits.length - 1];
  return hash ? m.commits.get(hash) : undefined;
};

/**
 * Branches in display order, each with its nesting depth (0 unless sorted as a
 * tree). With a `query`, only branches whose name matches.
 */
export function branchRows(m: Model, sort: BranchSort, query = ""): { id: number; depth: number }[] {
  const re = compileQuery(query);
  const shown = (b: Branch) => !re || re.test(b.name);
  if (sort === "tree") {
    const rows: { id: number; depth: number }[] = [];
    const add = (id: number, depth: number) => {
      // While searching, matches keep their tree order but not the indent their hidden parents gave them.
      if (shown(m.branches[id])) rows.push({ id, depth: re ? 0 : depth });
      for (const c of m.branches[id].children) add(c, depth + 1);
    };
    for (const b of m.branches) if (b.parent === null) add(b.id, 0);
    return rows;
  }
  const list = m.branches.filter(shown);
  const time = (b: Branch) => latestOf(m, b)?.time ?? 0;
  if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === "changesets") list.sort((a, b) => b.commits.length - a.commits.length || a.name.localeCompare(b.name));
  if (sort === "latest") list.sort((a, b) => time(b) - time(a) || a.name.localeCompare(b.name));
  return list.map((b) => ({ id: b.id, depth: 0 }));
}

export function renderBranchList(host: HTMLElement, m: Model, opts: BranchListOptions) {
  const table = el("table", "branch-table");
  const head = el("tr");
  const column = (label: string, sort: BranchSort, cls = "") => {
    const th = el("th", cls);
    const btn = el("button", `sort${opts.sort === sort || (sort === "name" && opts.sort === "tree") ? " on" : ""}`, label);
    // Branch toggles between the parent/child tree and A–Z.
    btn.title = sort === "name" ? (opts.sort === "tree" ? "Sort A–Z" : "Show as a tree, children under their parent") : `Sort by ${label.toLowerCase()}`;
    btn.onclick = () => opts.onSort(sort === "name" && opts.sort === "name" ? "tree" : sort);
    th.append(btn);
    head.append(th);
  };
  column(opts.sort === "name" ? "Branch (A–Z)" : "Branch", "name", "col-name");
  column("Changesets", "changesets", "col-count");
  column("Latest changeset", "latest", "col-latest");
  const authorTh = el("th", "col-author", "Author");
  head.append(authorTh);
  column("Date", "latest", "col-date");
  const thead = el("thead");
  thead.append(head);

  const tbody = el("tbody");
  const rows = branchRows(m, opts.sort, opts.query);
  for (const { id, depth } of rows) {
    const b = m.branches[id];
    const tr = el("tr", "branch-row");
    tr.dataset.id = String(id);
    if (id === opts.selected) tr.classList.add("selected");
    if (b.kind === "deleted" || b.kind === "anonymous") tr.classList.add("dim");

    const name = el("td", "col-name");
    const inner = el("div", "name-cell");
    inner.style.paddingLeft = `${depth * 16}px`;
    const swatch = el("span", "swatch");
    swatch.style.background = branchColor(m, id);
    const label = el("span", "name", b.name);
    label.title = b.name;
    inner.append(swatch, label);
    const badge = (text: string, cls = "") => inner.append(el("span", `badge ${cls}`, text));
    if (b.isHead) badge("HEAD", "head");
    if (b.commits.length === 0 && b.kind !== "trunk") badge("empty");
    if (b.kind === "remote") badge("remote");
    if (b.kind === "deleted") badge("deleted");
    const push = pushLabel(m, b);
    if (push) badge(push.replace("not pushed · ", "local · "), "unpushed");
    name.append(inner);

    const latest = latestOf(m, b);
    const latestCell = el("td", "col-latest");
    if (latest) {
      latestCell.append(el("span", "mono", latest.hash.slice(0, 8)), " ", el("span", "subject", latest.subject || "(no message)"));
      latestCell.title = latest.subject;
    } else {
      latestCell.append(el("span", "muted", b.base ? `created at ${b.base.slice(0, 8)}` : ""));
    }
    tr.append(
      name,
      el("td", "col-count", String(b.commits.length)),
      latestCell,
      el("td", "col-author", latest?.author ?? ""),
      el("td", "col-date", latest ? new Date(latest.time * 1000).toLocaleString() : ""),
    );
    tr.onclick = () => opts.onSelect(id);
    tr.ondblclick = () => opts.onOpen(id);
    tr.oncontextmenu = (e) => {
      e.preventDefault();
      opts.onContextMenu(id);
    };
    tbody.append(tr);
  }
  table.append(thead, tbody);

  const scroll = host.scrollTop;
  if (rows.length === 0) {
    const tr = el("tr");
    const td = el("td", "branch-table-empty", opts.query.trim() ? `No branch names match “${opts.query.trim()}”` : "No branches");
    td.colSpan = 5;
    tr.append(td);
    tbody.append(tr);
  }
  host.replaceChildren(table);
  host.scrollTop = scroll;
  host.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}
