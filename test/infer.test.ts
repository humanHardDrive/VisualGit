import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadRepo } from "../src/git/load.ts";
import { nodeRunner } from "../src/git/nodeRunner.ts";
import { branchNameFromMerge, inferModel, type Model } from "../src/model/infer.ts";
import { layoutModel } from "../src/model/layout.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A scratch repository with deterministic, strictly increasing commit dates. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "visualgit-test-"));
  dirs.push(dir);
  let clock = 1_700_000_000;
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        GIT_AUTHOR_DATE: `@${clock} +0000`,
        GIT_COMMITTER_DATE: `@${clock++} +0000`,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }).trim();
  git("init", "-q", "-b", "main");
  const commit = (msg: string) => {
    git("commit", "-q", "--allow-empty", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  const model = async (repo = dir) => inferModel(await loadRepo(nodeRunner(repo)));
  return { dir, git, commit, model };
}

const branch = (m: Model, name: string) => {
  const b = m.branches.find((x) => x.name === name);
  if (!b) throw new Error(`no branch ${name}; have ${m.branches.map((x) => x.name).join(", ")}`);
  return b;
};
const subjects = (m: Model, name: string) => branch(m, name).commits.map((h) => m.commits.get(h)!.subject);

describe("inferModel", () => {
  it("gives an empty branch its own lane anchored at its base", async () => {
    const { git, commit, model } = fixture();
    commit("m1");
    const m2 = commit("m2");
    git("branch", "empty");
    commit("m3");
    const m = await model();
    const empty = branch(m, "empty");
    expect(empty.commits).toEqual([]);
    expect(empty.base).toBe(m2);
    expect(empty.parent).toBe(branch(m, "main").id);
    expect(subjects(m, "main")).toEqual(["m1", "m2", "m3"]);

    const layout = layoutModel(m);
    expect(layout.spans[empty.id].row).toBeGreaterThan(layout.spans[branch(m, "main").id].row);
  });

  it("uses the reflog to parent an empty branch on another empty branch", async () => {
    const { git, commit, model } = fixture();
    commit("m1");
    git("branch", "a");
    git("branch", "b", "a");
    const m = await model();
    expect(branch(m, "b").parent).toBe(branch(m, "a").id);
    expect(branch(m, "a").parent).toBe(branch(m, "main").id);
  });

  it("keeps shared history on the branch a stacked branch was created from", async () => {
    const { git, commit, model } = fixture();
    commit("m1");
    git("checkout", "-q", "-b", "A");
    commit("a1");
    const a2 = commit("a2");
    git("branch", "B");
    commit("a3");
    commit("a4");
    commit("a5");
    git("checkout", "-q", "B");
    commit("b1");
    const m = await model();
    expect(subjects(m, "A")).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    expect(subjects(m, "B")).toEqual(["b1"]);
    expect(branch(m, "B").base).toBe(a2);
    expect(branch(m, "B").parent).toBe(branch(m, "A").id);
  });

  it("finds the parent of `checkout -b` branches through the HEAD reflog", async () => {
    const { git, commit, model } = fixture();
    commit("m1");
    git("checkout", "-q", "-b", "feature");
    commit("f1");
    git("checkout", "-q", "-b", "sub");
    const m = await model();
    expect(branch(m, "sub").createdFrom).toBe("feature");
    expect(branch(m, "sub").parent).toBe(branch(m, "feature").id);
  });

  it("recovers a deleted branch from its merge commit", async () => {
    const { git, commit, model } = fixture();
    commit("m1");
    git("checkout", "-q", "-b", "feature/login");
    commit("f1");
    commit("f2");
    git("checkout", "-q", "main");
    commit("m2");
    git("merge", "-q", "--no-ff", "feature/login", "-m", "Merge branch 'feature/login'");
    git("branch", "-q", "-D", "feature/login");
    const m = await model();
    const ghost = branch(m, "feature/login");
    expect(ghost.kind).toBe("deleted");
    expect(subjects(m, "feature/login")).toEqual(["f1", "f2"]);
    expect(ghost.parent).toBe(branch(m, "main").id);
    expect(subjects(m, "main")).toEqual(["m1", "m2", "Merge branch 'feature/login'"]);
    const edges = layoutModel(m).edges.filter((e) => e.kind === "merge");
    expect(edges).toHaveLength(1);
    expect(m.owner.get(edges[0].from)).toBe(ghost.id);
  });

  it("labels the other side of a `git pull` merge as upstream, not a deleted branch", async () => {
    const { git, commit, model } = fixture();
    commit("m1");
    git("checkout", "-q", "-b", "tmp");
    commit("upstream work");
    git("checkout", "-q", "main");
    commit("local work");
    git("merge", "-q", "--no-ff", "tmp", "-m", "Merge branch 'main' of github.com:org/repo");
    git("branch", "-q", "-D", "tmp");
    const m = await model();
    const up = branch(m, "main (upstream)");
    expect(up.kind).toBe("anonymous");
    expect(up.isHead).toBe(false);
    expect(m.branches.filter((b) => b.isHead).map((b) => b.name)).toEqual(["main"]);
  });

  it("keeps a branch's own commits when trunk is merged into it", async () => {
    const { git, commit, model } = fixture();
    commit("m1");
    git("checkout", "-q", "-b", "feature");
    commit("f1");
    git("checkout", "-q", "main");
    commit("m2");
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-ff", "main", "-m", "Merge branch 'main' into feature");
    commit("f2");
    const m = await model();
    expect(subjects(m, "feature")).toEqual(["f1", "Merge branch 'main' into feature", "f2"]);
    expect(subjects(m, "main")).toEqual(["m1", "m2"]);
    expect(m.branches).toHaveLength(2);
  });

  it("assigns fast-forwarded work to the branch it landed on", async () => {
    const { git, commit, model } = fixture();
    commit("m1");
    git("checkout", "-q", "-b", "quick");
    commit("q1");
    git("checkout", "-q", "main");
    git("merge", "-q", "--ff-only", "quick");
    git("branch", "-q", "-d", "quick");
    const m = await model();
    expect(m.branches.map((b) => b.name)).toEqual(["main"]);
    expect(subjects(m, "main")).toEqual(["m1", "q1"]);
  });

  it("groups remote-tracking refs with local branches of the same name", async () => {
    const origin = fixture();
    origin.commit("m1");
    origin.git("checkout", "-q", "-b", "remote-only");
    origin.commit("r1");
    origin.git("checkout", "-q", "main");

    const clone = fixture();
    rmSync(clone.dir, { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", origin.dir, clone.dir]);
    clone.commit("local1");
    const m = await clone.model();
    const main = branch(m, "main");
    expect(main.kind).toBe("trunk");
    expect(main.refs).toEqual(["refs/heads/main", "refs/remotes/origin/main"]);
    expect(branch(m, "remote-only").kind).toBe("remote");
    expect(subjects(m, "remote-only")).toEqual(["r1"]);
  });

  it("loads an empty repository", async () => {
    const { model } = fixture();
    const m = await model();
    expect(m.branches).toEqual([]);
    expect(layoutModel(m).rows).toBe(0);
  });
});

describe("layoutModel", () => {
  it("puts children below parents and reuses rows for non-overlapping lanes", async () => {
    const { git, commit, model } = fixture();
    commit("m1");
    git("checkout", "-q", "-b", "one");
    commit("o1");
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "one", "-m", "Merge branch 'one'");
    for (let i = 0; i < 12; i++) commit(`m${i + 2}`);
    git("checkout", "-q", "-b", "two");
    commit("t1");
    git("checkout", "-q", "-b", "nested");
    commit("n1");
    const m = await model();
    const l = layoutModel(m);
    const row = (n: string) => l.spans[branch(m, n).id].row;
    expect(row("main")).toBe(0);
    expect(row("one")).toBe(1);
    expect(row("two")).toBe(1);
    expect(row("nested")).toBe(2);
  });
});

describe("branchNameFromMerge", () => {
  it.each([
    ["Merge branch 'feature/x'", "feature/x"],
    ["Merge branch 'feature/x' into develop", "feature/x"],
    ["Merge branch 'fix' of github.com:org/repo", "fix"],
    ["Merge remote-tracking branch 'origin/topic'", "topic"],
    ["Merge pull request #42 from someone/feature/y", "feature/y"],
    ["Merged in bugfix/z (pull request #7)", "bugfix/z"],
    ["Fix the thing", undefined],
  ])("%s", (subject, expected) => {
    expect(branchNameFromMerge(subject, false)).toBe(expected);
  });
});
