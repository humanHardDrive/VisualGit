import { describe, expect, it } from "vitest";
import type { GitRunner } from "../src/git/load.ts";
import { loadWithSubmodules, parseStatus } from "../src/git/status.ts";

const HASH = "0".repeat(40);
/** A `git status --porcelain=v2 -z` entry for a changed tracked path. */
const changed = (path: string, sub = "N...") => `1 .M ${sub} 100644 100644 100644 ${HASH} ${HASH} ${path}`;
const runner = (out: string[]): GitRunner => ({ run: async () => out.join("\0") + "\0" });

describe("pending changes", () => {
  it("says what changed in a submodule", () => {
    const { files } = parseStatus([changed("lib", "SCM."), changed("vendor", "S..U"), changed("a.txt")].join("\0"));
    expect(files.map((f) => [f.path, f.submodule])).toEqual([
      ["a.txt", undefined],
      ["lib", { commit: true, tracked: true, untracked: false }],
      ["vendor", { commit: false, tracked: false, untracked: true }],
    ]);
  });

  it("lists the files changed inside submodules with the containing repository's", async () => {
    const top = runner(["# branch.head feature-x", changed("app.c"), changed("lib", "S.M."), changed("moved", "SCM."), changed("broken", "S.M.")]);
    const inside: Record<string, GitRunner> = {
      lib: runner(["# branch.head (detached)", changed("parse.c"), "? new.h"]),
      moved: runner([changed("x.c")]),
      broken: { run: async () => Promise.reject(new Error("no repository")) },
    };
    const { branch, files } = await loadWithSubmodules(top, (folder) => inside[folder]);
    expect(branch).toBe("feature-x");
    expect(files.map((f) => [f.path, f.sub])).toEqual([
      ["app.c", undefined],
      // Couldn't be read: its own row stays.
      ["broken", undefined],
      // Its files stand in for a submodule whose changeset hasn't moved...
      ["lib/new.h", "lib"],
      ["lib/parse.c", "lib"],
      // ...but one that moved keeps its row too.
      ["moved", undefined],
      ["moved/x.c", "moved"],
    ]);
  });
});
