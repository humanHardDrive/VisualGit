/**
 * The Settings window (settings.html). Every change is saved at once and
 * shows in every window (see settings.ts): there's no Save button.
 */

import { CODE_SIZES, DEFAULT_BRANCHES, DEFAULT_TRUNK, initSettings, onSettings, saveSettings, SCALES, settings, type Settings } from "./settings.ts";

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
}

onSettings((s) => requestAnimationFrame(() => render(s)));
void initSettings().then(render);
