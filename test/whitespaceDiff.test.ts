import { diff } from "@codemirror/merge";
import { describe, expect, it } from "vitest";
import { ignoringWhitespace } from "../src/view/whitespaceDiff.ts";

/** What each change replaces, as text: [removed, added]. */
const texts = (a: string, b: string, changes: readonly { fromA: number; toA: number; fromB: number; toB: number }[]) =>
  changes.map((c) => [a.slice(c.fromA, c.toA), b.slice(c.fromB, c.toB)]);

describe("diffs ignoring whitespace", () => {
  const a = "function f() {\n  return 1;\n}\nconst x = 1;   \n";
  const b = "function f() {\n    return 1;\n}\nconst x = 2;\n";

  it("ignores changed indentation and trailing spaces anywhere, only with all", () => {
    // Only the real change is left, highlighted exactly: not the re-indented line, nor the trailing spaces.
    expect(texts(a, b, ignoringWhitespace("all")(a, b))).toEqual([["1", "2"]]);
  });

  it("ignores only trailing whitespace with trailing", () => {
    const changes = texts(a, b, ignoringWhitespace("trailing")(a, b)).flat().join("|");
    // The indentation change still counts; the trailing spaces alone wouldn't have.
    expect(changes).toContain("  ");
    const c = "x = 1;  \ny = 2;\n";
    const d = "x = 1;\ny = 2;\n";
    expect(ignoringWhitespace("trailing")(c, d)).toEqual([]);
  });

  it("finds nothing when only whitespace differs, and diffs as usual otherwise", () => {
    expect(ignoringWhitespace("all")("a b\n\tc\n", "ab\nc\n")).toEqual([]);
    const e = "one\ntwo\nthree";
    const f = "one\nTWO\nthree\nfour";
    const all = texts(e, f, ignoringWhitespace("all")(e, f)).flat().join("");
    expect(all.replace(/\s/g, "")).toBe(texts(e, f, diff(e, f)).flat().join("").replace(/\s/g, ""));
    // A new line still counts, line break and all.
    expect(ignoringWhitespace("all")("a\n", "a\n\n").length).toBe(1);
  });
});
