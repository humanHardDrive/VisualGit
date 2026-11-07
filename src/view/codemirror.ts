/** CodeMirror setup shared by the Pending Changes and merge windows. */

import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export const dark = matchMedia("(prefers-color-scheme: dark)");

/** Holds the theme, so it can follow the system's light/dark setting. */
export const themeSlot = new Compartment();

/** Colours from the app's CSS variables; `dark` also picks the merge view's dark variant. */
export const theme = (): Extension =>
  EditorView.theme(
    {
      "&": { backgroundColor: "var(--canvas)", color: "var(--text)", fontSize: "12px" },
      ".cm-content": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", caretColor: "var(--text)" },
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
  );

/** Keep CRLF files CRLF: CodeMirror otherwise rejoins lines with "\n" on save. */
export const lineEndings = (text: string): Extension => (text.includes("\r\n") ? EditorState.lineSeparator.of("\r\n") : []);

export const readOnly: Extension = [EditorState.readOnly.of(true), EditorView.editable.of(false)];
