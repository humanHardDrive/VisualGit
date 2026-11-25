/** CodeMirror setup shared by the Pending Changes and merge windows. */

import type { DiffConfig } from "@codemirror/merge";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isDark, onSettings, settings, type Settings } from "../settings/settings.ts";
import { ignoringWhitespace } from "./whitespaceDiff.ts";

/** What changes how an editor looks: the theme, accent, code font and size, and wrapping. */
const looks = (s: Settings) => JSON.stringify([s.theme, s.accent, s.codeFont, s.codeSize, s.diff.wrap]);

/**
 * Tells editors to restyle (`themeSlot.reconfigure(theme())`): when the theme turns light or
 * dark, or a setting that changes how they look does. Shaped like a media query's `change`.
 */
export const dark = {
  get matches() {
    return isDark();
  },
  addEventListener(_: "change", cb: () => void) {
    let wasDark = isDark();
    onSettings((s, before) => {
      if (looks(s) !== looks(before) || isDark() !== wasDark) cb();
      wasDark = isDark();
    });
  },
};

/** Holds the theme, so it can follow the light/dark setting and the code settings. */
export const themeSlot = new Compartment();

/** How diffs compare the two sides: ignoring whitespace, if Settings › Diffs says so. */
export function diffConfig(): DiffConfig {
  const mode = settings().diff.ignoreWhitespace;
  return mode === "none" ? {} : { override: ignoringWhitespace(mode) };
}

/** Calls `cb` when the way diffs compare changes, for a page to diff again. */
export function onDiffConfigChange(cb: () => void) {
  onSettings((s, before) => {
    if (s.diff.ignoreWhitespace !== before.diff.ignoreWhitespace) cb();
  });
}

/** Colours from the app's CSS variables, the code font and size, and wrapping (Settings); `dark` also picks the merge view's dark variant. */
export const theme = (): Extension => [
  settings().diff.wrap ? EditorView.lineWrapping : [],
  EditorView.theme(
    {
      "&": { backgroundColor: "var(--canvas)", color: "var(--text)", fontSize: "var(--code-size)" },
      ".cm-content": { fontFamily: "var(--code-font)", caretColor: "var(--text)" },
      ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--muted)", borderRight: "1px solid var(--border)" },
      ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--hover) 60%, transparent)" },
      ".cm-activeLineGutter": { backgroundColor: "var(--hover)" },
      "&.cm-focused .cm-cursor": { borderLeftColor: "var(--text)" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
      },
      "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": { backgroundColor: "rgba(238, 68, 51, 0.12)" },
      "&.cm-merge-b .cm-changedLine": { backgroundColor: "rgba(34, 187, 34, 0.12)" },
    },
    { dark: dark.matches },
  ),
];

/** Keep CRLF files CRLF: CodeMirror otherwise rejoins lines with "\n" on save. */
export const lineEndings = (text: string): Extension => (text.includes("\r\n") ? EditorState.lineSeparator.of("\r\n") : []);

export const readOnly: Extension = [EditorState.readOnly.of(true), EditorView.editable.of(false)];
