/**
 * The Choose Changeset window: the Branch Explorer of the repository being
 * added as a submodule, or of a submodule being edited. Double-click a
 * changeset (or right-click it and choose Use This Changeset) to add the
 * submodule checked out there, or to move the edited one there. The
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
import { localizeShortcuts, shownPath } from "../platform.ts";
import { clearDetails, showBranch, showCommit } from "../view/details.ts";
import { Explorer, type Selection } from "../view/explorer.ts";
import { createSearchBox } from "../view/searchBox.ts";

localizeShortcuts();
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
  /** Editing a submodule that's already there: the changeset it's at now. */
  current: string | null;
}

let info: Info | null = null;
let model: Model | null = null;
let layout: Layout | null = null;
let adding = false;
/** The selected changeset or branch: Enter uses it, the arrow keys move from it. */
let current: Selection | null = null;

let HINT = "Double-click a changeset to use it for the submodule";
/** Editing an existing submodule (moving it), rather than adding one. */
const editing = () => !!info?.current;

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
  const here = editing() && hash === info?.current;
  const button = Object.assign(document.createElement("button"), {
    className: "primary pick-use",
    textContent: here ? "The Submodule Is Here" : editing() ? (sel.kind === "commit" ? "Move to This Changeset" : "Move to Its Latest Changeset") : sel.kind === "commit" ? "Use This Changeset" : "Use Its Latest Changeset",
    title: editing() ? `Move the submodule to ${hash.slice(0, 8)}` : `Add the submodule checked out at ${hash.slice(0, 8)}`,
    disabled: here,
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
  const what = editing() ? (sel.hash === info?.current ? "the submodule is here now" : "double-click to move it here") : "double-click to use it";
  say(`${sel.hash.slice(0, 8)} · ${lane?.name ?? ""} · ${c?.subject || "(no message)"} · ${what}`);
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
      ? [{ id: "use", text: editing() ? "Move to This Changeset" : "Use This Changeset", enabled: sel.hash !== info?.current, action: () => void use(sel.hash) }]
      : (() => {
          // A branch: its latest changeset.
          const tip = model.branches[sel.id].commits.at(-1);
          const text = editing() ? "Move to Its Latest Changeset" : "Use Its Latest Changeset";
          return [{ id: "use-tip", text, enabled: !!tip && tip !== info?.current, action: () => tip && void use(tip) }];
        })();
  const menu = await Menu.new({ items });
  await menu.popup();
}

async function use(hash: string) {
  if (!info || !model || adding || !hash) return;
  if (editing()) return moveTo(hash);
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

/** Editing: moves the submodule to `hash`, staged in its repository for the next commit. */
async function moveTo(hash: string) {
  if (!info?.current || !model || adding) return;
  if (hash === info.current) return say(`The submodule is already at ${hash.slice(0, 8)}.`);
  const subject = (h: string) => `${h.slice(0, 8)} “${model!.commits.get(h)?.subject || "(no message)"}”`;
  const ok = await ask(`Move the submodule ${info.path} from ${subject(info.current)} to ${subject(hash)}?\n\nThe move is staged for your next commit, in the repository that has the submodule.`, {
    title: "Edit Submodule",
    kind: "info",
    okLabel: "Move Submodule",
    cancelLabel: "Cancel",
  });
  if (!ok) return;
  adding = true;
  say("Moving the submodule…");
  try {
    // On success the main window is told and this window closes.
    await invoke("move_submodule", { at: hash });
  } catch (err) {
    adding = false;
    say("The submodule wasn't moved. See the message for why.", true);
    await message(String(err), { title: "Could not move the submodule", kind: "error" });
  }
}

/** Editing: gets the remote's newer changesets, then shows them. */
async function fetchRemote() {
  const btn = $<HTMLButtonElement>("pick-fetch");
  btn.disabled = true;
  say("Fetching from its remote…");
  try {
    await invoke("fetch_submodule");
    await loadHistory();
    say("Fetched. " + HINT);
  } catch (err) {
    say("Couldn't fetch. See the message for why.", true);
    await message(String(err), { title: "Could not fetch", kind: "error" });
  }
  btn.disabled = false;
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
$("pick-fetch").addEventListener("click", () => void fetchRemote());
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
  const sub = $("pick-sub");
  if (info.current) {
    HINT = "Double-click a changeset to move the submodule there";
    $("pick-title").textContent = `Edit the submodule ${info.path}`;
    sub.textContent = `Now at ${info.current.slice(0, 8)} · from ${shownPath(info.source)}`;
    $("pick-fetch").hidden = false;
    document.title = `Edit Submodule ${info.path}`;
  } else {
    $("pick-title").textContent = `Choose the changeset of ${name.replace(/\.git$/i, "")} for ${info.path}`;
    sub.textContent = `From ${shownPath(info.source)}`;
  }
  sub.title = shownPath(info.source);
  say("Reading its history…");
  if (!(await loadHistory())) return;
  say(HINT);
  // Editing: start where the submodule is now.
  if (info.current && model?.commits.has(info.current)) go({ kind: "commit", hash: info.current });
}

/** Reads (or re-reads, after a fetch) the repository's history into the explorer. */
async function loadHistory(): Promise<boolean> {
  if (!info) return false;
  const first = !model;
  try {
    model = inferModel(await loadRepo(tauriRunner(info.history)));
  } catch (err) {
    say("Could not read the repository.", true);
    await message(String(err), { title: "Could not read the repository", kind: "error" });
    return false;
  }
  layout = layoutModel(model);
  explorer.setData(model, layout, first ? "latest" : "keep");
  searchInput.disabled = false;
  search.refresh();
  if (current) {
    const gone = current.kind === "commit" ? !model.commits.has(current.hash) : !model.branches[current.id];
    describe(gone ? null : current);
  }
  return true;
}

void start();
