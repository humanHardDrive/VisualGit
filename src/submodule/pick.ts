/**
 * The Choose Changeset window: the Branch Explorer of the repository being
 * added as a submodule. Double-click a changeset (or right-click it and
 * choose Use This Changeset) to add the submodule checked out there. The
 * search box finds changesets by id or message, and branches by name; the
 * panel on the right shows the selected one. ←/→ move along a branch, ↑/↓
 * between lanes, Home goes to the repository's checked-out changeset.
 */

import { invoke } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { loadRepo } from "../git/load.ts";
import { tauriRunner } from "../git/tauriRunner.ts";
import { inferModel, type Model } from "../model/infer.ts";
import { layoutModel, type Layout } from "../model/layout.ts";
import { laneNeighbour, nextOf, previousOf } from "../model/navigate.ts";
import { clearDetails, showBranch, showCommit } from "../view/details.ts";
import { Explorer, type Selection } from "../view/explorer.ts";
import { createSearchBox } from "../view/searchBox.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("pick-status");
const searchInput = $<HTMLInputElement>("search");
const details = $("details");

interface Info {
  repo: string;
  path: string;
  source: string;
  history: string;
  remote: boolean;
}

let info: Info | null = null;
let model: Model | null = null;
let layout: Layout | null = null;
let adding = false;
/** The selected changeset or branch: Enter uses it, the arrow keys move from it. */
let current: Selection | null = null;

const HINT = "Double-click a changeset to use it for the submodule";

function say(text: string, isError = false) {
  status.textContent = text;
  status.classList.toggle("error", isError);
}

/** The panel on the right: the selected changeset or branch, with a button to use it. */
function showDetails(sel: Selection | null) {
  if (!model || !sel) return clearDetails(details);
  if (sel.kind === "commit") showCommit(details, model, sel.hash, go);
  else showBranch(details, model, sel.id, go);
  const hash = sel.kind === "commit" ? sel.hash : model.branches[sel.id].commits.at(-1);
  if (!hash) return;
  const button = Object.assign(document.createElement("button"), {
    className: "primary pick-use",
    textContent: sel.kind === "commit" ? "Use This Changeset" : "Use Its Latest Changeset",
    title: `Add the submodule checked out at ${hash.slice(0, 8)}`,
    onclick: () => void use(hash),
  });
  // Above the message, so it's in view without scrolling.
  const message = details.querySelector("h3");
  if (message) message.before(button);
  else details.append(button);
}

function describe(sel: Selection | null) {
  showDetails(sel);
  current = sel;
  if (!model || sel?.kind !== "commit") return say(HINT);
  const c = model.commits.get(sel.hash);
  const lane = model.branches[model.owner.get(sel.hash)!];
  say(`${sel.hash.slice(0, 8)} · ${lane?.name ?? ""} · ${c?.subject || "(no message)"} · double-click to use it`);
}

/** Goes to a changeset or branch: from the details panel's links, search and the arrow menu. */
const go = (sel: Selection) => {
  explorer.select(sel, true);
  describe(sel);
};
const goTo = (hash: string) => go({ kind: "commit", hash });

const explorer = new Explorer($<HTMLCanvasElement>("explorer"), $("tooltip"), {
  onSelect: describe,
  onContextMenu: (sel) => void showMenu(sel),
  onOpenPending: () => {},
  onOpenChangeset: (hash) => void use(hash),
  onOpenBranch: () => {},
  onArrowMenu: (edge) =>
    void Menu.new({
      items: [
        { id: "arrow-source", text: "Source", action: () => goTo(edge.from) },
        { id: "arrow-destination", text: "Destination", action: () => goTo(edge.to) },
      ],
    }).then((m) => m.popup()),
});

const search = createSearchBox({
  input: searchInput,
  panel: $("search-results"),
  model: () => model,
  onResults: (results) => explorer.setMatches(results && { commits: new Set(results.commits), branches: new Set(results.branches) }),
  onChoose: go,
});

async function showMenu(sel: Selection) {
  if (!model) return;
  const items =
    sel.kind === "commit"
      ? [{ id: "use", text: "Use This Changeset", action: () => void use(sel.hash) }]
      : (() => {
          // A branch: its latest changeset.
          const tip = model.branches[sel.id].commits.at(-1);
          return [{ id: "use-tip", text: "Use Its Latest Changeset", enabled: !!tip, action: () => tip && void use(tip) }];
        })();
  const menu = await Menu.new({ items });
  await menu.popup();
}

async function use(hash: string) {
  if (!info || !model || adding || !hash) return;
  const c = model.commits.get(hash);
  const ok = await ask(`Add ${info.source} as a submodule in ${info.path}, checked out at ${hash.slice(0, 8)} “${c?.subject || "(no message)"}”?\n\nIt's staged, with .gitmodules, for your next commit.`, {
    title: "Add Submodule",
    kind: "info",
    okLabel: "Add Submodule",
    cancelLabel: "Cancel",
  });
  if (!ok) return;
  adding = true;
  say(info.remote ? "Adding the submodule (fetching from the remote)…" : "Adding the submodule…");
  try {
    // On success the main window is told and this window closes.
    await invoke("add_submodule", { at: hash });
  } catch (err) {
    adding = false;
    // git's errors can run to several lines: show them whole, in a message box (the status line is one line).
    say("The submodule wasn't added. See the message for why.", true);
    await message(String(err), { title: "Could not add the submodule", kind: "error" });
  }
}

const ARROWS: Record<string, "left" | "right" | "up" | "down"> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

/**
 * Where an arrow key goes: ←/→ the previous/next changeset along the branch,
 * ↑/↓ the nearest changeset on the lane above/below. From a branch, or
 * nothing, the first press lands on the branch's latest changeset (or HEAD).
 */
function arrowTarget(dir: "left" | "right" | "up" | "down"): string | null {
  if (!model || !layout) return null;
  if (current?.kind !== "commit") {
    const lane = current?.kind === "branch" ? model.branches[current.id] : null;
    const start = lane ? (lane.commits.at(-1) ?? lane.base) : model.headHash;
    return start && model.commits.has(start) ? start : null;
  }
  const hash = current.hash;
  if (dir === "left") return previousOf(model, hash);
  if (dir === "right") return nextOf(model, hash);
  return laneNeighbour(model, layout, hash, dir === "up" ? -1 : 1);
}

$("pick-cancel").addEventListener("click", () => void getCurrentWindow().destroy());
$("zoom-in").addEventListener("click", () => explorer.zoomBy(1.25));
$("zoom-out").addEventListener("click", () => explorer.zoomBy(0.8));
$("zoom-fit").addEventListener("click", () => explorer.fit());
$("zoom-latest").addEventListener("click", () => explorer.latest());
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }
  // Typing in the search box (which handles its own ↑/↓, Enter and Escape).
  if (e.metaKey || e.ctrlKey || e.altKey || e.target === searchInput) return;
  if (e.key === "Escape" && searchInput.value) search.clear();
  else if (e.key === "Escape" && !adding) void getCurrentWindow().destroy();
  else if (e.key === "+" || e.key === "=") explorer.zoomBy(1.25);
  else if (e.key === "-") explorer.zoomBy(0.8);
  else if (e.key === "0") explorer.fit();
  else if (e.key === "l" || e.key === "L") explorer.latest();
  // A focused button (Use This Changeset, Cancel) handles Enter itself.
  else if (e.key === "Enter" && current && !(e.target instanceof HTMLButtonElement)) void use(current.kind === "commit" ? current.hash : (model?.branches[current.id].commits.at(-1) ?? ""));
  else if (e.key in ARROWS) {
    e.preventDefault();
    const target = arrowTarget(ARROWS[e.key]);
    if (target) goTo(target);
  } else if (e.key === "Home" && model?.headHash && model.commits.has(model.headHash)) goTo(model.headHash);
});

async function start() {
  info = await invoke<Info | null>("pick_changeset_info");
  if (!info) {
    say("This window has no repository to show. Use Add Submodule… in the Files view.", true);
    return;
  }
  const name = info.source.replace(/[/\\]+$/, "").split(/[/:\\]/).pop() ?? info.source;
  $("pick-title").textContent = `Choose the changeset of ${name.replace(/\.git$/i, "")} for ${info.path}`;
  const sub = $("pick-sub");
  sub.textContent = `From ${info.source}`;
  sub.title = info.source;
  say("Reading its history…");
  try {
    model = inferModel(await loadRepo(tauriRunner(info.history)));
  } catch (err) {
    say("Could not read the repository.", true);
    await message(String(err), { title: "Could not read the repository", kind: "error" });
    return;
  }
  layout = layoutModel(model);
  explorer.setData(model, layout, "latest");
  searchInput.disabled = false;
  say(HINT);
}

void start();
