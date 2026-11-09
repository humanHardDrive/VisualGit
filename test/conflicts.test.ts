import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseConflicts, stripConflicts } from "../src/git/conflicts.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A real conflict from git: `main` (destination) and `feature` (source) both change line 2. */
function conflicted(style: "merge" | "diff3") {
  const dir = mkdtempSync(join(tmpdir(), "visualgit-conflict-"));
  dirs.push(dir);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => {
    try {
      return execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@e", "-c", `merge.conflictStyle=${style}`, ...args], { encoding: "utf8", env, stdio: "pipe" });
    } catch (e) {
      return (e as { stdout?: string }).stdout ?? ""; // the merge "fails" with conflicts
    }
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "f.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "f.txt"), "one\nTWO from feature\nthree\nfour\nfive\nsix\nSEVEN from feature\n");
  git("commit", "-q", "-am", "feature");
  git("checkout", "-q", "main");
  writeFileSync(join(dir, "f.txt"), "one\ntwo on main\nthree\nfour\nfive\nsix\nseven on main\n");
  git("commit", "-q", "-am", "main");
  git("merge", "feature");
  return { text: readFileSync(join(dir, "f.txt"), "utf8"), show: (rev: string) => git("show", rev), git };
}

describe("parseConflicts", () => {
  it("finds each block and its two sides in git's markers", () => {
    const { text, show } = conflicted("merge");
    const blocks = parseConflicts(text);
    expect(blocks).toHaveLength(2);
    const [first, second] = blocks;
    expect(text.slice(first.destination.from, first.destination.to)).toBe("two on main\n");
    expect(text.slice(first.source.from, first.source.to)).toBe("TWO from feature\n");
    expect(first.base).toBeNull();
    expect(text.slice(first.from, first.to)).toMatch(/^<<<<<<< HEAD\n[\s\S]*\n>>>>>>> feature\n$/);
    expect(text.slice(second.source.from, second.source.to)).toBe("SEVEN from feature\n");
    expect(first.markers).toHaveLength(3);

    // The panes come from the index: stage 2 is the destination, stage 3 the source.
    expect(show(":2:f.txt")).toContain("two on main");
    expect(show(":3:f.txt")).toContain("TWO from feature");

    // The Result pane shows it with the markers taken out: each conflict's Destination lines, then its Source lines.
    const { text: plain, regions } = stripConflicts(text);
    expect(plain).toBe("one\ntwo on main\nTWO from feature\nthree\nfour\nfive\nsix\nseven on main\nSEVEN from feature\n");
    const sides = regions.map((r) => [plain.slice(r.destination.from, r.destination.to), plain.slice(r.source.from, r.source.to)]);
    expect(sides).toEqual([
      ["two on main\n", "TWO from feature\n"],
      ["seven on main\n", "SEVEN from feature\n"],
    ]);
    // Taking the Source for the first conflict drops the Destination's lines, and so on.
    const r = regions[0];
    expect(plain.slice(0, r.destination.from) + plain.slice(r.destination.to)).toBe("one\nTWO from feature\nthree\nfour\nfive\nsix\nseven on main\nSEVEN from feature\n");
  });

  it("reads the markers in git merge-tree's result, which the merge window shows", () => {
    const { git } = conflicted("merge");
    git("merge", "--abort");
    const tree = git("merge-tree", "--write-tree", "main", "feature").split("\n")[0].trim();
    const text = git("show", `${tree}:f.txt`);
    const blocks = parseConflicts(text);
    expect(blocks).toHaveLength(2);
    expect(text.slice(blocks[0].destination.from, blocks[0].destination.to)).toBe("two on main\n");
    expect(text.slice(blocks[0].source.from, blocks[0].source.to)).toBe("TWO from feature\n");

    expect(stripConflicts(text).regions).toHaveLength(2);
  });

  it("reads diff3-style blocks, with the common ancestor in the middle", () => {
    const { text } = conflicted("diff3");
    const [first] = parseConflicts(text);
    expect(first.base).not.toBeNull();
    expect(text.slice(first.base!.from, first.base!.to)).toBe("two\n");
    expect(text.slice(first.destination.from, first.destination.to)).toBe("two on main\n");
    expect(text.slice(first.source.from, first.source.to)).toBe("TWO from feature\n");
    expect(first.markers).toHaveLength(4);
    // The common ancestor's lines don't go into the Result.
    const { text: plain, regions } = stripConflicts(text);
    expect(plain).not.toMatch(/^two$/m);
    expect(plain.slice(regions[0].destination.from, regions[0].source.to)).toBe("two on main\nTWO from feature\n");
  });

  it("counts a CRLF line break as one position, as the editor does", () => {
    const { text, regions } = stripConflicts("a\r\n<<<<<<< x\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> y\r\nb\r\n");
    expect(text).toBe("a\r\nours\r\ntheirs\r\nb\r\n");
    // In the editor: "a\nours\ntheirs\nb\n".
    expect(regions).toEqual([{ destination: { from: 2, to: 7 }, source: { from: 7, to: 14 } }]);
  });

  it("keeps an empty side as an empty range, and a block at the very end", () => {
    const { text, regions } = stripConflicts("x\n<<<<<<< a\n=======\nadded\n>>>>>>> b");
    expect(text).toBe("x\nadded");
    expect(regions).toEqual([{ destination: { from: 2, to: 2 }, source: { from: 2, to: 7 } }]);
    expect(stripConflicts("no conflicts\n")).toEqual({ text: "no conflicts\n", regions: [] });
  });

  it("ignores unfinished blocks and look-alike lines", () => {
    expect(parseConflicts("a\n<<<<<<< HEAD\nb\n=======\nc\n")).toEqual([]);
    expect(parseConflicts("<<<<<<<<<< not a marker\n=======\n>>>>>>> x\n")).toEqual([]);
    // No line break at the very end.
    const text = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> x";
    const [c] = parseConflicts(text);
    expect(c.to).toBe(text.length);
    expect(text.slice(c.source.from, c.source.to)).toBe("theirs\n");
  });
});
