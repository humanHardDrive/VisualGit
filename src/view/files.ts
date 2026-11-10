/** Files view: the repository's working copy as a folder tree. */

import { fileType, type FileList, type Folder, type LastChange } from "../git/files.ts";
import { compileQuery } from "../model/search.ts";

export type FileRow = { kind: "folder"; folder: Folder; depth: number } | { kind: "file"; path: string; depth: number };

export interface FilesOptions {
  expanded: Set<string>;
  /** File-name search (`*` and `?` wildcards): matching files as a flat list. */
  query: string;
  selected: string | null;
  onSelect(row: FileRow): void;
  onOpen(row: FileRow): void;
  /** Right-click, after the row has been selected. */
  onContextMenu(row: FileRow): void;
}

/** The visible rows: expanded folders' contents, or while searching, every matching file. */
export function fileRows(tree: Folder, list: FileList, expanded: Set<string>, query: string): FileRow[] {
  const re = compileQuery(query);
  if (re) return list.paths.filter((p) => re.test(p)).map((path) => ({ kind: "file" as const, path, depth: 0 }));
  const rows: FileRow[] = [];
  const walk = (f: Folder, depth: number) => {
    for (const sub of f.folders) {
      rows.push({ kind: "folder", folder: sub, depth });
      if (expanded.has(sub.path)) walk(sub, depth + 1);
    }
    for (const path of f.files) rows.push({ kind: "file", path, depth });
  };
  walk(tree, 0);
  return rows;
}

export const rowKey = (r: FileRow) => (r.kind === "folder" ? `${r.folder.path}/` : r.path);

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

const ICON_FOLDER = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3A1 1 0 0 0 2 4.5Z" /></svg>';
/** A package: another repository inside this one. */
const ICON_REPO = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 13.5 4.6v6.8L8 14.2 2.5 11.4V4.6Z M2.5 4.6 8 7.4l5.5-2.8 M8 7.4v6.8" /></svg>';
const ICON_FILE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2h5l3 3v9H4z M9 2v3h3" /></svg>';

/** The date and author columns: blank until history has loaded, "Not committed" for new files. */
function changeCells(change: LastChange | undefined, loaded: boolean, isNew: boolean): HTMLElement[] {
  if (change) {
    const date = el("span", "tree-col tree-date", new Date(change.time * 1000).toLocaleString());
    date.title = `Changeset ${change.hash.slice(0, 8)}`;
    return [date, el("span", "tree-col tree-author", change.author)];
  }
  const text = loaded && isNew ? "Not committed" : "";
  return [el("span", "tree-col tree-date muted", text), el("span", "tree-col tree-author")];
}

export function renderFiles(host: HTMLElement, tree: Folder, list: FileList, opts: FilesOptions) {
  const rows = fileRows(tree, list, opts.expanded, opts.query);
  const loaded = !!list.last;
  const box = el("div", "file-tree");
  box.setAttribute("role", "tree");
  const header = el("div", "tree-row tree-head");
  header.append(el("span", "tree-main", "Name"), el("span", "tree-col", "Type"), el("span", "tree-col", "Last modified"), el("span", "tree-col", "Modified by"));
  box.append(header);
  for (const r of rows) {
    const row = el("div", "tree-row");
    row.setAttribute("role", "treeitem");
    const main = el("span", "tree-main");
    main.style.paddingLeft = `${r.depth * 16}px`;
    if (rowKey(r) === opts.selected) row.classList.add("selected");
    if (r.kind === "folder") {
      const open = opts.expanded.has(r.folder.path);
      row.setAttribute("aria-expanded", String(open));
      const twisty = el("span", "twisty", open ? "▾" : "▸");
      const icon = el("span", "tree-icon folder");
      icon.innerHTML = ICON_FOLDER;
      main.append(twisty, icon, el("span", "tree-name", r.folder.name));
      if (r.folder.changed) {
        const badge = el("span", "tree-changed", `${r.folder.changed}`);
        badge.title = `${r.folder.changed} file${r.folder.changed === 1 ? "" : "s"} with pending changes`;
        main.append(badge);
      }
      row.append(main, el("span", "tree-col tree-type", "Folder"), ...changeCells(r.folder.latest, loaded, false));
    } else {
      const status = list.status.get(r.path);
      const kind = list.kinds.get(r.path);
      const repo = kind === "submodule" || kind === "repository";
      const icon = el("span", kind === "submodule" ? "tree-icon submodule" : "tree-icon");
      icon.innerHTML = repo ? ICON_REPO : ICON_FILE;
      // While searching the rows are flat, so show the whole path.
      const name = opts.query.trim() ? r.path : r.path.slice(r.path.lastIndexOf("/") + 1);
      main.append(el("span", "twisty"), icon, el("span", "tree-name", name));
      if (status) {
        const st = el("span", `tree-status st-${status.letter === "?" ? "untracked" : status.letter}`, status.letter);
        st.title = status.title;
        main.append(st);
        row.classList.add("changed");
      }
      const type = fileType(r.path, kind);
      row.append(main, el("span", "tree-col tree-type", type), ...changeCells(list.last?.get(r.path), loaded, status?.letter === "?" || status?.letter === "A"));
      row.title = `${r.path} · ${type}`;
    }
    row.onclick = () => opts.onSelect(r);
    row.ondblclick = () => opts.onOpen(r);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      opts.onContextMenu(r);
    };
    box.append(row);
  }
  if (rows.length === 0) {
    box.append(el("div", "tree-empty", opts.query.trim() ? `No files match “${opts.query.trim()}”` : "This repository has no files yet."));
  }
  const scroll = host.scrollTop;
  host.replaceChildren(box);
  host.scrollTop = scroll;
  host.querySelector(".tree-row.selected")?.scrollIntoView({ block: "nearest" });
}
