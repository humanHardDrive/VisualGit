/**
 * VisualGit's settings: what they are, their defaults, and applying them to
 * the page. Every window calls `initSettings()` at start; a change saved
 * anywhere (the Settings window) reaches every window through
 * `settings-changed` (see src-tauri/src/settings.rs) and is applied at once.
 *
 * Settings are stored as `settings.json` in VisualGit's settings folder.
 * Anything missing or not understood in it reads as the default.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export type Theme = "system" | "light" | "dark";
export type IgnoreWhitespace = "none" | "trailing" | "all";
/** Built-in (VisualGit's own view), git's tool (git difftool / mergetool), or a command of your own. */
export type ToolKind = "builtin" | "git" | "custom";

export interface ExternalTool {
  kind: ToolKind;
  /** For "custom": the command, with $LOCAL, $REMOTE (and $BASE, $MERGED for merging). */
  command: string;
}

/** A tool to open files with from the Files view: $FILE, $DIR and $REPO in its command. */
export interface OpenTool {
  name: string;
  command: string;
}

export interface Settings {
  /** System follows the computer's light or dark setting. */
  theme: Theme;
  /** The colour of selections, the current view's box, buttons and dots; null: the theme's own blue. */
  accent: string | null;
  /** The size of everything, as a zoom: 1 is 100%. */
  interfaceScale: number;
  /** The font for code in diffs and editors; "" is the system's monospaced font. */
  codeFont: string;
  /** Its size, in pixels at 100%. */
  codeSize: number;
  /** The Branch Explorer's lane colours: the trunk's, and the palette other branches take in turn. */
  trunkColor: string;
  branchColors: string[];
  diff: {
    /** Changes that only differ in whitespace don't count: none, at the ends of lines, or anywhere. */
    ignoreWhitespace: IgnoreWhitespace;
    /** Wrap long lines in diffs instead of scrolling sideways. */
    wrap: boolean;
  };
  /** External tools (run by src-tauri/src/tools.rs, which reads them from the stored settings). */
  tools: {
    diff: ExternalTool;
    merge: ExternalTool;
    open: OpenTool[];
  };
}

export const DEFAULT_TRUNK = "#2f81f7";
export const DEFAULT_BRANCHES = ["#a371f7", "#e3a008", "#f0603c", "#1fb5d4", "#e85aad", "#f08c2e", "#6e7bf2", "#b0882f", "#0ea5e9", "#cf5be0"];
export const SCALES = [0.85, 0.9, 1, 1.1, 1.25, 1.4];
export const CODE_SIZES = [10, 11, 12, 13, 14, 15, 16, 18];

export const defaults = (): Settings => ({
  theme: "system",
  accent: null,
  interfaceScale: 1,
  codeFont: "",
  codeSize: 12,
  trunkColor: DEFAULT_TRUNK,
  branchColors: [...DEFAULT_BRANCHES],
  diff: { ignoreWhitespace: "none", wrap: false },
  tools: { diff: { kind: "builtin", command: "" }, merge: { kind: "builtin", command: "" }, open: [] },
});

const COLOR = /^#[0-9a-f]{6}$/i;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);
const color = (v: unknown, fallback: string) => (typeof v === "string" && COLOR.test(v) ? v.toLowerCase() : fallback);
const num = (v: unknown, min: number, max: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback);

/** Settings from what was stored: each one checked, anything missing or odd its default. */
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const tool = (v: unknown): ExternalTool => {
  const t = obj(v);
  return { kind: oneOf(t.kind, ["builtin", "git", "custom"] as const, "builtin"), command: text(t.command, 1000) };
};

export function normalize(raw: unknown): Settings {
  const d = defaults();
  const r = obj(raw);
  const diff = obj(r.diff);
  const tools = obj(r.tools);
  const branches = Array.isArray(r.branchColors) ? r.branchColors.filter((c): c is string => typeof c === "string" && COLOR.test(c)) : [];
  return {
    theme: oneOf(r.theme, ["system", "light", "dark"] as const, d.theme),
    accent: r.accent === null ? null : typeof r.accent === "string" && COLOR.test(r.accent) ? r.accent.toLowerCase() : d.accent,
    interfaceScale: num(r.interfaceScale, 0.5, 2, d.interfaceScale),
    // A font name, never CSS: no quotes, semicolons or braces.
    codeFont: typeof r.codeFont === "string" && !/[;{}"'\\<>]/.test(r.codeFont) ? r.codeFont.trim().slice(0, 80) : d.codeFont,
    codeSize: num(r.codeSize, 8, 32, d.codeSize),
    trunkColor: color(r.trunkColor, d.trunkColor),
    branchColors: branches.length ? branches.map((c) => c.toLowerCase()) : d.branchColors,
    diff: {
      ignoreWhitespace: oneOf(diff.ignoreWhitespace, ["none", "trailing", "all"] as const, d.diff.ignoreWhitespace),
      wrap: typeof diff.wrap === "boolean" ? diff.wrap : d.diff.wrap,
    },
    tools: {
      diff: tool(tools.diff),
      merge: tool(tools.merge),
      open: (Array.isArray(tools.open) ? tools.open : []).slice(0, 20).map((t) => ({ name: text(obj(t).name, 60), command: text(obj(t).command, 1000) })),
    },
  };
}

let current: Settings = defaults();
const listeners = new Set<(s: Settings, before: Settings) => void>();
// Not in tests, which have no page.
const system = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

export const settings = (): Settings => current;

/** Called after every change, with the settings before it. */
export function onSettings(cb: (s: Settings, before: Settings) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Whether the page is dark: the theme setting, or the computer's for System. */
export const isDark = () => (current.theme === "system" ? !!system?.matches : current.theme === "dark");

/** The code font, as CSS. */
export function codeFontFamily(s: Settings = current): string {
  const base = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  return s.codeFont ? `"${s.codeFont}", ${base}` : base;
}

function apply(s: Settings) {
  const root = document.documentElement;
  if (s.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = s.theme;
  if (s.accent) root.style.setProperty("--accent", s.accent);
  else root.style.removeProperty("--accent");
  root.style.setProperty("--code-font", codeFontFamily(s));
  root.style.setProperty("--code-size", `${s.codeSize}px`);
  if ("__TAURI_INTERNALS__" in window) void getCurrentWebview().setZoom(s.interfaceScale).catch(() => {});
}

function set(next: Settings) {
  const before = current;
  current = next;
  apply(next);
  for (const cb of listeners) cb(next, before);
}

/** Loads the settings and applies them, and keeps them up to date. Call once per window, at start. */
export async function initSettings(): Promise<Settings> {
  // The computer switching between light and dark only matters for System.
  system?.addEventListener("change", () => {
    if (current.theme === "system") set(current);
  });
  if (!("__TAURI_INTERNALS__" in window)) {
    apply(current);
    return current;
  }
  void listen<unknown>("settings-changed", (e) => set(normalize(e.payload)));
  const stored = await invoke<unknown>("load_settings").catch(() => null);
  set(normalize(stored));
  return current;
}

/** Saves a change; every window (this one too) applies it when it's stored. */
export async function saveSettings(next: Settings): Promise<void> {
  await invoke("save_settings", { settings: next });
}
