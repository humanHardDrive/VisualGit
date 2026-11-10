/**
 * The Branch Explorer's search box: branch names, changeset ids and commit
 * messages (see `searchModel`), with a drop-down list of results. ↑/↓ browse
 * the results, Enter goes to one, Escape clears. Used by the main window and
 * the Choose Changeset window. Styles: `.search` and `.result*` in styles.css.
 */

import type { Model } from "../model/infer.ts";
import { searchModel, type SearchResults } from "../model/search.ts";
import { branchColor, type Selection } from "./explorer.ts";

const MAX_BRANCH_RESULTS = 50;
const MAX_COMMIT_RESULTS = 200;

export interface SearchBoxOptions {
  input: HTMLInputElement;
  /** The drop-down list, shown under the input. */
  panel: HTMLElement;
  model(): Model | null;
  /** The matches changed: highlight them (null: no search). */
  onResults(results: SearchResults | null): void;
  /** A result was browsed to or chosen: show it. */
  onChoose(sel: Selection): void;
}

export interface SearchBox {
  /** Re-runs the query against the current model; `open` shows the results list. */
  run(open: boolean): void;
  /** After a reload or repository switch: same query, new history. */
  refresh(): void;
  clear(): void;
}

export function createSearchBox(o: SearchBoxOptions): SearchBox {
  const { input, panel } = o;
  let results: SearchResults | null = null;
  /** Result rows in display order, for keyboard navigation. */
  let rows: { sel: Selection; el: HTMLElement }[] = [];
  let active = -1;

  function run(open: boolean) {
    const model = o.model();
    results = model ? searchModel(model, input.value) : null;
    o.onResults(results);
    active = -1;
    render(model);
    panel.hidden = !open || !results;
  }

  function clear() {
    input.value = "";
    run(false);
  }

  function render(m: Model | null) {
    if (!results || !m) {
      rows = [];
      panel.replaceChildren();
      return;
    }
    const next: { sel: Selection; el: HTMLElement }[] = [];
    const nodes: HTMLElement[] = [];
    const div = (cls: string, text = "") => {
      const d = document.createElement("div");
      d.className = cls;
      d.textContent = text;
      return d;
    };
    const addRow = (sel: Selection, ...kids: HTMLElement[]) => {
      const el = div("result");
      el.setAttribute("role", "option");
      el.append(...kids);
      const i = next.length;
      // Keep focus in the search box, so the list doesn't close before the click lands.
      el.onmousedown = (e) => e.preventDefault();
      el.onclick = () => choose(i, true);
      next.push({ sel, el });
      nodes.push(el);
    };
    const more = (n: number, what: string) => {
      if (n > 0) nodes.push(div("result-more", `and ${n.toLocaleString()} more ${what}; refine the search to see them`));
    };

    const { branches, commits } = results;
    const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
    nodes.push(
      div(
        "result-summary",
        branches.length || commits.length
          ? `${plural(branches.length, "branch", "branches")} · ${plural(commits.length, "changeset", "changesets")}`
          : "No matches",
      ),
    );

    if (branches.length) {
      nodes.push(div("result-head", "Branches"));
      for (const id of branches.slice(0, MAX_BRANCH_RESULTS)) {
        const b = m.branches[id];
        const swatch = div("swatch");
        swatch.style.background = branchColor(m, id);
        addRow({ kind: "branch", id }, swatch, div("result-text", b.name));
      }
      more(branches.length - MAX_BRANCH_RESULTS, "branches");
    }
    if (commits.length) {
      nodes.push(div("result-head", "Changesets"));
      for (const hash of commits.slice(0, MAX_COMMIT_RESULTS)) {
        const c = m.commits.get(hash)!;
        const owner = m.owner.get(hash)!;
        const branch = div("result-meta", m.branches[owner].name);
        branch.style.color = branchColor(m, owner);
        addRow({ kind: "commit", hash }, div("result-id", hash.slice(0, 8)), div("result-text", c.subject || "(no message)"), branch);
      }
      more(commits.length - MAX_COMMIT_RESULTS, "changesets");
    }
    nodes.push(div("result-hint", "* matches anything · ? matches one character · ↑↓ to browse · Enter to go"));
    rows = next;
    panel.replaceChildren(...nodes);
  }

  function setActive(i: number) {
    rows[active]?.el.classList.remove("active");
    active = i;
    const row = rows[i];
    if (!row) return;
    row.el.classList.add("active");
    row.el.scrollIntoView({ block: "nearest" });
  }

  /** Shows a result; `close` also hands the keyboard back to the explorer. */
  function choose(i: number, close: boolean) {
    const row = rows[i];
    if (!row) return;
    setActive(i);
    o.onChoose(row.sel);
    if (close) {
      panel.hidden = true;
      input.blur();
    }
  }

  input.addEventListener("input", () => run(true));
  input.addEventListener("focus", () => {
    if (results) panel.hidden = false;
  });
  input.addEventListener("blur", () => {
    panel.hidden = true;
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!results) return;
      panel.hidden = false;
      const n = rows.length;
      if (n) choose(e.key === "ArrowDown" ? (active + 1) % n : (active - 1 + n) % n, false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(Math.max(active, 0), true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      clear();
      input.blur();
    }
  });

  return { run, refresh: () => run(!panel.hidden), clear };
}
