/**
 * A diff that doesn't count whitespace-only changes (Settings › Diffs ›
 * Ignore whitespace), for CodeMirror's diff views (`diffConfig.override`).
 *
 * Lines are compared with their whitespace taken out (or just the trailing
 * whitespace): lines that then match are unchanged, however their spacing
 * differs. Only the runs of lines that really changed are diffed as usual,
 * so the changes inside them are still highlighted exactly.
 */

import { Change, diff } from "@codemirror/merge";

export type WhitespaceMode = "trailing" | "all";

/** Where each line starts in `text`, plus the end: line i is [starts[i], starts[i + 1]), its line break included. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  if (starts[starts.length - 1] !== text.length) starts.push(text.length);
  return starts;
}

export function ignoringWhitespace(mode: WhitespaceMode): (a: string, b: string) => readonly Change[] {
  const norm = mode === "all" ? (t: string) => t.replace(/\s+/g, "") : (t: string) => t.replace(/\s+$/, "");
  const blank = (t: string) => /^[^\S\n]*$/.test(t);
  const atLineEnd = (text: string, at: number) => at === text.length || text[at] === "\n" || text[at] === "\r";
  /**
   * Inside a line that did change, a change that's only spaces or tabs (anywhere with all, at the
   * end of the line with trailing) isn't one either. Line breaks always count, so lines stay lined up.
   */
  const ignored = (a: string, b: string, c: Change) => {
    const removed = a.slice(c.fromA, c.toA);
    const added = b.slice(c.fromB, c.toB);
    if (!blank(removed) || !blank(added)) return false;
    return mode === "all" || (atLineEnd(a, c.toA) && atLineEnd(b, c.toB));
  };
  return (a, b) => {
    const sa = lineStarts(a);
    const sb = lineStarts(b);
    // Each distinct line (as compared) becomes one character, so the library's diff compares lines.
    const codes = new Map<string, string>();
    let next = 0x100;
    const encode = (text: string, starts: number[]): string | null => {
      let out = "";
      for (let i = 0; i + 1 < starts.length; i++) {
        const key = norm(text.slice(starts[i], starts[i + 1]));
        let c = codes.get(key);
        if (c === undefined) {
          if (next === 0xd800) next = 0xe000; // never half a surrogate pair
          if (next > 0xffff) return null;
          c = String.fromCharCode(next++);
          codes.set(key, c);
        }
        out += c;
      }
      return out;
    };
    const la = encode(a, sa);
    const lb = encode(b, sb);
    // More distinct lines than there are characters for: diff as usual.
    if (la === null || lb === null) return diff(a, b);
    const out: Change[] = [];
    for (const lines of diff(la, lb)) {
      const fromA = sa[lines.fromA];
      const toA = sa[lines.toA];
      const fromB = sb[lines.fromB];
      const toB = sb[lines.toB];
      for (const c of diff(a.slice(fromA, toA), b.slice(fromB, toB))) {
        const change = new Change(c.fromA + fromA, c.toA + fromA, c.fromB + fromB, c.toB + fromB);
        if (!ignored(a, b, change)) out.push(change);
      }
    }
    return out;
  };
}
