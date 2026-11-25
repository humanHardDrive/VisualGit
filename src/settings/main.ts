/**
 * The Settings window (settings.html). Every change is saved at once and
 * shows in every window (see settings.ts): there's no Save button.
 */

import { invoke } from "@tauri-apps/api/core";
import { CODE_SIZES, DEFAULT_BRANCHES, DEFAULT_TRUNK, initSettings, onSettings, saveSettings, SCALES, settings, type Settings, type ToolKind } from "./settings.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const errorEl = $("settings-error");

/** Saves `change` applied to the current settings; says why if it couldn't be saved. */
async function change(edit: (s: Settings) => void) {
  const next = structuredClone(settings());
  edit(next);
  try {
    await saveSettings(next);
    errorEl.textContent = "";
  } catch (err) {
    errorEl.textContent = String(err);
  }
}

/** Colour inputs report every step while dragging; save once it settles. */
function debounced(fn: () => void, ms = 150) {
  let t = 0;
  return () => {
    clearTimeout(t);
    t = window.setTimeout(fn, ms);
  };
}

// ---- sections -------------------------------------------------------------------

for (const item of document.querySelectorAll<HTMLButtonElement>(".settings-nav .view-item")) {
  item.addEventListener("click", () => {
    for (const other of document.querySelectorAll<HTMLButtonElement>(".settings-nav .view-item")) {
      other.setAttribute("aria-pressed", String(other === item));
      $(`section-${other.dataset.section}`).hidden = other !== item;
    }
  });
}

// ---- color and style -------------------------------------------------------------

const theme = $("theme");
for (const b of theme.querySelectorAll<HTMLButtonElement>("button")) {
  b.addEventListener("click", () => void change((s) => (s.theme = b.dataset.value as Settings["theme"])));
}

const accent = $<HTMLInputElement>("accent");
const saveAccent = debounced(() => void change((s) => (s.accent = accent.value)));
accent.addEventListener("input", saveAccent);
$("accent-reset").addEventListener("click", () => void change((s) => (s.accent = null)));

const scale = $<HTMLSelectElement>("scale");
scale.replaceChildren(...SCALES.map((v) => new Option(`${Math.round(v * 100)}%`, String(v))));
scale.addEventListener("change", () => void change((s) => (s.interfaceScale = Number(scale.value))));

const codeFont = $<HTMLInputElement>("code-font");
const saveFont = debounced(() => void change((s) => (s.codeFont = codeFont.value.trim())), 400);
codeFont.addEventListener("input", saveFont);
const codeSize = $<HTMLSelectElement>("code-size");
codeSize.replaceChildren(...CODE_SIZES.map((v) => new Option(`${v} px`, String(v))));
codeSize.addEventListener("change", () => void change((s) => (s.codeSize = Number(codeSize.value))));

const trunk = $<HTMLInputElement>("trunk-color");
trunk.addEventListener("input", debounced(() => void change((s) => (s.trunkColor = trunk.value))));
const swatches = $("branch-colors");

function renderSwatches(colors: string[]) {
  swatches.replaceChildren(
    ...colors.map((c, i) => {
      const wrap = document.createElement("div");
      wrap.className = "swatch";
      const input = document.createElement("input");
      input.type = "color";
      input.value = c;
      input.setAttribute("aria-label", `Branch color ${i + 1}`);
      input.addEventListener("input", debounced(() => void change((s) => (s.branchColors[i] = input.value))));
      wrap.append(input);
      // Keep at least one.
      if (colors.length > 1) {
        const remove = document.createElement("button");
        remove.className = "remove";
        remove.type = "button";
        remove.textContent = "×";
        remove.title = "Remove this color";
        remove.addEventListener("click", () => void change((s) => s.branchColors.splice(i, 1)));
        wrap.append(remove);
      }
      return wrap;
    }),
  );
}
$("branch-add").addEventListener("click", () => void change((s) => s.branchColors.push(DEFAULT_BRANCHES[s.branchColors.length % DEFAULT_BRANCHES.length])));
$("branch-reset").addEventListener("click", () =>
  void change((s) => {
    s.trunkColor = DEFAULT_TRUNK;
    s.branchColors = [...DEFAULT_BRANCHES];
  }),
);

// ---- diffs --------------------------------------------------------------------------

for (const r of document.querySelectorAll<HTMLInputElement>('input[name="whitespace"]')) {
  r.addEventListener("change", () => void change((s) => (s.diff.ignoreWhitespace = r.value as Settings["diff"]["ignoreWhitespace"])));
}
const wrap = $<HTMLInputElement>("wrap");
wrap.addEventListener("change", () => void change((s) => (s.diff.wrap = wrap.checked)));

// ---- committing ---------------------------------------------------------------------------

const pushOnCommit = $<HTMLInputElement>("push-on-commit");
pushOnCommit.addEventListener("change", () => void change((s) => (s.commit.push = pushOnCommit.checked)));

// ---- external tools ---------------------------------------------------------------------

/** Mirrors `GitTools` in src-tauri/src/tools.rs. */
interface GitTools {
  available: [string, string][];
  current: string | null;
}

for (const which of ["diff", "merge"] as const) {
  for (const r of document.querySelectorAll<HTMLInputElement>(`input[name="${which}-kind"]`)) {
    r.addEventListener("change", () => void change((s) => (s.tools[which].kind = r.value as ToolKind)));
  }
  const cmd = $<HTMLInputElement>(`${which}-command`);
  cmd.addEventListener("input", debounced(() => void change((s) => (s.tools[which].command = cmd.value.trim())), 400));
  const pick = $<HTMLSelectElement>(`${which}-git`);
  const note = $(`${which}-git-note`);
  // git's choice is git's own config (diff.tool / merge.tool), so command-line git uses it too.
  pick.addEventListener("change", async () => {
    try {
      await invoke("set_git_tool", { which, name: pick.value });
      note.textContent = `Saved in your git config as ${which}.tool = ${pick.value}.`;
      if (settings().tools[which].kind !== "git") await change((s) => (s.tools[which].kind = "git"));
    } catch (err) {
      note.textContent = String(err);
    }
  });
  void loadGitTools(which);
}

async function loadGitTools(which: "diff" | "merge") {
  const pick = $<HTMLSelectElement>(`${which}-git`);
  const note = $(`${which}-git-note`);
  const tools = await invoke<GitTools>("git_tools", { which }).catch(() => null);
  if (!tools) {
    pick.disabled = true;
    note.textContent = "Couldn't ask git which tools it has.";
    return;
  }
  const options = tools.available.map(([name, desc]) => new Option(desc ? `${name}: ${desc}` : name, name));
  // One chosen in git's config that isn't installed (or is a terminal tool) is still shown.
  if (tools.current && !tools.available.some(([n]) => n === tools.current)) options.unshift(new Option(`${tools.current} (from your git config)`, tools.current));
  if (!tools.current) options.unshift(new Option("Choose…", ""));
  pick.replaceChildren(...options);
  pick.value = tools.current ?? "";
  pick.disabled = options.length <= 1 && !tools.current;
  note.textContent = !tools.available.length
    ? `git finds no ${which} tool installed that opens a window of its own.`
    : tools.current
      ? `git's ${which}.tool is ${tools.current}.`
      : `git has no ${which}.tool set yet: choose one to use it.`;
}

const openTools = $("open-tools");
function renderOpenTools(list: Settings["tools"]["open"]) {
  openTools.replaceChildren(
    ...list.map((t, i) => {
      const row = document.createElement("div");
      row.className = "open-tool";
      const name = Object.assign(document.createElement("input"), { type: "text", value: t.name, placeholder: "Name", spellcheck: false, className: "tool-name" });
      name.setAttribute("aria-label", `Tool ${i + 1} name`);
      const cmd = Object.assign(document.createElement("input"), { type: "text", value: t.command, placeholder: "code $FILE", spellcheck: false, className: "tool-command" });
      cmd.setAttribute("aria-label", `Tool ${i + 1} command`);
      const save = debounced(() => void change((s) => (s.tools.open[i] = { name: name.value.trim(), command: cmd.value.trim() })), 400);
      name.addEventListener("input", save);
      cmd.addEventListener("input", save);
      const remove = Object.assign(document.createElement("button"), { type: "button", textContent: "Remove" });
      remove.addEventListener("click", () => {
        remove.blur(); // so the list redraws without it
        void change((s) => s.tools.open.splice(i, 1));
      });
      row.append(name, cmd, remove);
      return row;
    }),
  );
}
$("open-add").addEventListener("click", () => void change((s) => s.tools.open.push({ name: "", command: "" })));

// ---- showing the settings ---------------------------------------------------------------

/** The accent colour in use, for the colour picker when it's the theme's own. */
const accentInUse = () => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();

function render(s: Settings) {
  for (const b of theme.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-checked", String(b.dataset.value === s.theme));
  // A picker being dragged keeps its own value.
  if (document.activeElement !== accent) accent.value = s.accent ?? (accentInUse() || "#2563eb");
  ($("accent-reset") as HTMLButtonElement).disabled = s.accent === null;
  scale.value = String(s.interfaceScale);
  if (!SCALES.includes(s.interfaceScale)) scale.append(new Option(`${Math.round(s.interfaceScale * 100)}%`, String(s.interfaceScale), true, true));
  if (document.activeElement !== codeFont) codeFont.value = s.codeFont;
  codeSize.value = String(s.codeSize);
  if (document.activeElement !== trunk) trunk.value = s.trunkColor;
  if (!swatches.contains(document.activeElement)) renderSwatches(s.branchColors);
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="whitespace"]')) r.checked = r.value === s.diff.ignoreWhitespace;
  wrap.checked = s.diff.wrap;
  pushOnCommit.checked = s.commit.push;
  for (const which of ["diff", "merge"] as const) {
    const t = s.tools[which];
    for (const r of document.querySelectorAll<HTMLInputElement>(`input[name="${which}-kind"]`)) r.checked = r.value === t.kind;
    const cmd = $<HTMLInputElement>(`${which}-command`);
    if (document.activeElement !== cmd) cmd.value = t.command;
    cmd.hidden = t.kind !== "custom";
  }
  if (!openTools.contains(document.activeElement)) renderOpenTools(s.tools.open);
}

onSettings((s) => requestAnimationFrame(() => render(s)));
void initSettings().then(render);
