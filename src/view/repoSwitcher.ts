/**
 * The repository menu: the open repository's name in the toolbar, which
 * drops down the stored list (see model/library.ts) grouped by workspace,
 * with a search box, a dot on repositories with uncommitted changes, and a
 * way back out of a submodule opened as a repository. ⌘P (File › Switch
 * Repository…) opens it too; ↑/↓ and Enter pick, Esc closes.
 */

import { compileQuery } from "../model/search.ts";
import type { LibraryGroup, ListedRepo } from "../model/library.ts";
import { shortcutText } from "../platform.ts";

export interface RepoSwitcherOptions {
  groups(): LibraryGroup[];
  /** The open repository. */
  current(): string | null;
  /** Repositories this one was opened from (a submodule opened as a repository), outermost first. */
  parents(): { path: string; name: string }[];
  /** How a folder is written for people (`~/code`). */
  shown(path: string): string;
  /** Whether a repository has uncommitted changes; asked in the background when the menu opens. */
  pending(path: string): Promise<boolean>;
  onPick(repo: ListedRepo): void;
  /** Back to a repository this one was opened from. */
  onBack(path: string): void;
  /** A workspace whose folder couldn't be read. */
  onMissingWorkspace(path: string): void;
  onManage(): void;
  onOpenRepository(): void;
  onAddWorkspace(): void;
}

/** Repositories asked about at once: each is a git process. */
const AT_ONCE = 4;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

export class RepoSwitcher {
  private readonly panel: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly label: HTMLElement;
  /** Rows that can be picked, in order, for ↑/↓. */
  private rows: { el: HTMLElement; pick(): void }[] = [];
  private active = -1;
  /** Dots found since the menu opened, and where each is drawn. */
  private dots = new Map<string, boolean>();
  private dotEls = new Map<string, HTMLElement>();
  /** Incremented per opening, so answers for an earlier one are dropped. */
  private session = 0;

  private readonly button: HTMLButtonElement;
  private readonly opts: RepoSwitcherOptions;

  constructor(button: HTMLButtonElement, opts: RepoSwitcherOptions) {
    this.button = button;
    this.opts = opts;
    this.label = el("span", "repo-switch-name");
    const caret = el("span", "repo-switch-caret");
    caret.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>';
    button.replaceChildren(this.label, caret);
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");

    this.panel = el("div", "repo-panel");
    this.panel.hidden = true;
    const box = el("div", "search repo-panel-search");
    box.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>';
    this.search = el("input");
    this.search.type = "search";
    this.search.placeholder = "Search repositories";
    this.search.spellcheck = false;
    this.search.autocomplete = "off";
    this.search.setAttribute("aria-label", "Search repositories");
    this.search.title = "* matches anything, ? matches one character";
    box.append(this.search);
    this.list = el("div", "repo-panel-list");
    this.list.setAttribute("role", "listbox");
    const foot = el("div", "repo-panel-foot");
    for (const [text, hint, act] of [
      ["Manage Repositories…", "", () => opts.onManage()],
      ["Open Repository…", "⌘O", () => opts.onOpenRepository()],
      ["Add Workspace…", "⇧⌘O", () => opts.onAddWorkspace()],
    ] as const) {
      const b = el("button", "repo-panel-action");
      b.append(el("span", "", text));
      if (hint) b.append(el("span", "repo-panel-hint", shortcutText(hint)));
      b.onclick = () => {
        this.close();
        act();
      };
      foot.append(b);
    }
    this.panel.append(box, this.list, foot);
    button.after(this.panel);

    button.addEventListener("click", () => this.toggle());
    this.search.addEventListener("input", () => this.render());
    this.search.addEventListener("keydown", (e) => this.onKey(e));
    // Anywhere else closes it.
    document.addEventListener("mousedown", (e) => {
      if (!this.panel.hidden && !this.panel.contains(e.target as Node) && !button.contains(e.target as Node)) this.close();
    });
  }

  /** The toolbar text: the open repository, after any it was opened from. */
  setLabel(name: string | null, title = "") {
    const parents = this.opts.parents().map((p) => p.name);
    this.label.textContent = name ? [...parents, name].join(" › ") : "Choose a repository";
    this.label.classList.toggle("none", !name);
    this.button.title = shortcutText(`${title ? `${title}\n` : ""}Switch repository (⌘P)`);
  }

  get isOpen() {
    return !this.panel.hidden;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    this.session++;
    this.dots.clear();
    this.search.value = "";
    this.panel.hidden = false;
    this.button.setAttribute("aria-expanded", "true");
    this.render();
    this.search.focus();
    void this.findDots(this.session);
  }

  close() {
    if (!this.isOpen) return;
    this.session++;
    this.panel.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
  }

  /** Re-draws an open menu, e.g. after a rescan. */
  refresh() {
    if (this.isOpen) this.render();
  }

  private render() {
    const re = compileQuery(this.search.value);
    const matches = (r: ListedRepo) => !re || re.test(r.name) || re.test(r.path);
    const current = this.opts.current();
    this.rows = [];
    this.dotEls.clear();
    const out: HTMLElement[] = [];

    const parents = this.opts.parents();
    if (parents.length && !re) {
      // Innermost first: the one it was opened from.
      for (const p of [...parents].reverse()) {
        const row = el("div", "repo-row back");
        row.append(el("span", "repo-back-arrow", "←"), el("span", "repo-row-name", `Back to ${p.name}`));
        out.push(row);
        this.addRow(row, () => this.opts.onBack(p.path));
      }
    }

    let shown = 0;
    for (const g of this.opts.groups()) {
      const repos = g.repos.filter(matches);
      if (re && !repos.length) continue;
      const head = el("div", "repo-group");
      head.textContent = g.kind === "workspace" ? this.opts.shown(g.path!) : "Repositories";
      if (g.path) head.title = this.opts.shown(g.path);
      if (g.missing) {
        head.classList.add("missing");
        head.append(el("span", "repo-missing", "folder not found"));
        head.title = `${this.opts.shown(g.path!)} couldn't be read: it may have moved, or be on a drive that isn't connected. Click to find it or forget it.`;
        head.onclick = () => {
          this.close();
          this.opts.onMissingWorkspace(g.path!);
        };
      } else if (!repos.length) {
        head.append(el("span", "repo-missing", "no repositories"));
      }
      out.push(head);
      for (const r of repos) {
        const row = el("div", "repo-row");
        row.setAttribute("role", "option");
        if (r.path === current) {
          row.classList.add("current");
          row.setAttribute("aria-selected", "true");
        }
        const name = el("span", "repo-row-name", r.name);
        row.append(el("span", "repo-row-mark", r.path === current ? "●" : ""), name);
        // While searching, the folder tells apart two repositories with the same name.
        if (re) row.append(el("span", "repo-row-path", this.opts.shown(r.path)));
        if (r.missing) {
          row.classList.add("missing");
          row.append(el("span", "repo-missing", "not found"));
          row.title = `${this.opts.shown(r.path)} isn't there any more. Click to find it or forget it.`;
        } else {
          row.title = this.opts.shown(r.path);
          const dot = el("span", "repo-row-dot");
          dot.title = "Uncommitted changes";
          dot.hidden = !this.dots.get(r.path);
          this.dotEls.set(r.path, dot);
          row.append(dot);
        }
        out.push(row);
        this.addRow(row, () => this.opts.onPick(r));
        shown++;
      }
    }
    if (!shown && !this.rows.length) {
      const none = el("div", "repo-empty");
      none.textContent = re
        ? "No repositories match."
        : "No repositories yet. Open one, or add the folder you keep them in as a workspace.";
      out.push(none);
    }
    this.list.replaceChildren(...out);
    // Start on the first match while searching, otherwise on the open repository.
    const at = re ? 0 : this.rows.findIndex((r) => r.el.classList.contains("current"));
    this.setActive(at);
  }

  private addRow(row: HTMLElement, pick: () => void) {
    const i = this.rows.length;
    this.rows.push({
      el: row,
      pick: () => {
        this.close();
        pick();
      },
    });
    row.onclick = () => this.rows[i].pick();
    row.onmousemove = () => this.setActive(i, false);
  }

  private setActive(i: number, scroll = true) {
    this.rows[this.active]?.el.classList.remove("active");
    this.active = this.rows.length ? Math.max(-1, Math.min(i, this.rows.length - 1)) : -1;
    const row = this.rows[this.active]?.el;
    row?.classList.add("active");
    if (scroll) row?.scrollIntoView({ block: "nearest" });
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = this.rows.length;
      if (n) this.setActive(this.active < 0 ? 0 : (this.active + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.rows[this.active]?.pick();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      this.button.focus();
    }
  }

  /** Asks each listed repository whether it has uncommitted changes, a few at a time. */
  private async findDots(session: number) {
    const todo = this.opts
      .groups()
      .flatMap((g) => g.repos)
      .filter((r) => !r.missing)
      .map((r) => r.path);
    const next = async () => {
      for (let path = todo.shift(); path !== undefined && session === this.session; path = todo.shift()) {
        const has = await this.opts.pending(path).catch(() => false);
        if (session !== this.session) return;
        this.dots.set(path, has);
        const dot = this.dotEls.get(path);
        if (dot) dot.hidden = !has;
      }
    };
    await Promise.all(Array.from({ length: AT_ONCE }, next));
  }
}
