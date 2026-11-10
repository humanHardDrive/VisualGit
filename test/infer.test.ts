import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadChangesetFiles } from "../src/git/changeset.ts";
import { buildTree, loadFiles, loadLastChanges } from "../src/git/files.ts";
import { loadFileHistory } from "../src/git/history.ts";
import { ignorePatterns } from "../src/git/ignore.ts";
import { loadRepo } from "../src/git/load.ts";
import { loadPendingChanges } from "../src/git/status.ts";
import { nodeRunner } from "../src/git/nodeRunner.ts";
import { branchNameFromMerge, inferModel, pendingChangesOn, uncommittedHead, type Model } from "../src/model/infer.ts";
import { layoutModel } from "../src/model/layout.ts";
import { laneNeighbour, nextOf, previousOf } from "../src/model/navigate.ts";
import { compileQuery, searchModel } from "../src/model/search.ts";
import { branchRows } from "../src/view/branchList.ts";
import { fileRows, rowKey, type FileRow } from "../src/view/files.ts";

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
    // Just the first branch, waiting for its first changeset (see uncommittedHead).
    expect(m.branches.map((b) => b.name)).toEqual(["main"]);
    expect(layoutModel(m).rows).toBe(1);
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

describe("keyboard navigation", () => {
  it("steps along a branch with ←/→ and between lanes with ↑/↓", async () => {
    const { git, commit, model } = fixture();
    const m1 = commit("m1");
    git("checkout", "-q", "-b", "one");
    const o1 = commit("o1");
    const o2 = commit("o2");
    git("checkout", "-q", "main");
    const m2 = commit("m2");
    git("checkout", "-q", "-b", "deep", "one");
    const d1 = commit("d1");
    const m = await model();
    const l = layoutModel(m);

    expect(previousOf(m, o1)).toBe(m1); // off the start of a branch: where it was created
    expect(nextOf(m, o1)).toBe(o2);
    expect(nextOf(m, o2)).toBeNull();
    expect(previousOf(m, m1)).toBeNull();

    // Down from main's m2 to the lane below, then further down, and back up.
    const below = laneNeighbour(m, l, m2, 1);
    expect([o1, o2]).toContain(below);
    expect(laneNeighbour(m, l, o2, 1)).toBe(d1);
    expect(laneNeighbour(m, l, d1, -1)).toBe(o2);
    expect(laneNeighbour(m, l, m1, -1)).toBeNull();
    expect(laneNeighbour(m, l, d1, 1)).toBeNull();
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

describe("search", () => {
  it("loads full multi-line messages", async () => {
    const { git, model } = fixture();
    git("commit", "-q", "--allow-empty", "-m", "Subject line", "-m", "Body paragraph\nwith two lines");
    const m = await model();
    const c = m.commits.get(m.order[0])!;
    expect(c.subject).toBe("Subject line");
    expect(c.body).toBe("Body paragraph\nwith two lines");
  });

  it("finds branch names, messages and changeset ids, with wildcards", async () => {
    const { git, commit, model } = fixture();
    commit("Initial import");
    const login = commit("Add login form");
    git("checkout", "-q", "-b", "feature/login-page");
    commit("Style the login page");
    git("branch", "release/1.2");
    git("commit", "-q", "--allow-empty", "-m", "Tidy up", "-m", "Fixes the crash on logout");
    const m = await model();
    const names = (q: string) => searchModel(m, q)!.branches.map((id) => m.branches[id].name);
    const messages = (q: string) => searchModel(m, q)!.commits.map((h) => m.commits.get(h)!.subject);

    expect(searchModel(m, "   ")).toBeNull();
    expect(names("LOGIN")).toEqual(["feature/login-page"]);
    expect(names("feat*page")).toEqual(["feature/login-page"]);
    expect(names("release/1.?")).toEqual(["release/1.2"]);
    expect(names("release/1.?3")).toEqual([]);
    // Newest first; the body is searched too.
    expect(messages("log*")).toEqual(["Tidy up", "Style the login page", "Add login form"]);
    expect(messages("crash on")).toEqual(["Tidy up"]);
    expect(searchModel(m, login.slice(0, 7))!.commits).toEqual([login]);
    // Regex characters are literal.
    expect(messages("(")).toEqual([]);
    expect(compileQuery("a.b")!.test("axb")).toBe(false);
  });
});

describe("pending changes", () => {
  it("reads staged, unstaged, untracked, renamed and conflicted files", async () => {
    const { dir, git, commit } = fixture();
    const write = (path: string, text: string) => writeFileSync(join(dir, path), text);
    write("a.txt", "a\n");
    write("old name.txt", "o\n");
    write("gone.txt", "g\n");
    git("add", ".");
    const base = commit("base");
    write("a.txt", "a2\n"); // unstaged edit
    git("mv", "old name.txt", "new name.txt"); // staged rename, with spaces
    git("rm", "-q", "gone.txt"); // staged delete
    write("new.txt", "n\n"); // untracked
    write("b.txt", "b\n");
    git("add", "b.txt");
    write("b.txt", "b2\n"); // staged add, then edited again

    const p = await loadPendingChanges(nodeRunner(dir));
    expect(p.branch).toBe("main");
    expect(p.head).toBe(base);
    expect(p.files).toEqual([
      { path: "a.txt", staged: undefined, unstaged: "M" },
      { path: "b.txt", staged: "A", unstaged: "M" },
      { path: "gone.txt", staged: "D", unstaged: undefined },
      { path: "new name.txt", staged: "R", unstaged: undefined, origPath: "old name.txt" },
      { path: "new.txt", untracked: true },
    ]);
  });

  it("reports merge conflicts and a clean tree", async () => {
    const { dir, git, commit } = fixture();
    const write = (text: string) => writeFileSync(join(dir, "f.txt"), text);
    write("1\n");
    git("add", ".");
    commit("base");
    expect((await loadPendingChanges(nodeRunner(dir))).files).toEqual([]);
    git("checkout", "-q", "-b", "other");
    write("2\n");
    git("commit", "-q", "-am", "other");
    git("checkout", "-q", "main");
    write("3\n");
    git("commit", "-q", "-am", "main");
    try {
      git("merge", "-q", "other");
    } catch {
      // Conflict expected.
    }
    expect((await loadPendingChanges(nodeRunner(dir))).files).toEqual([{ path: "f.txt", conflict: true }]);
  });
});

describe("uncommittedHead", () => {
  it("is the checked-out branch while it has no changesets of its own", async () => {
    const { git, commit, model } = fixture();
    commit("m1");
    expect(uncommittedHead(await model())).toBeUndefined();
    git("checkout", "-q", "-b", "fresh");
    const m = await model();
    expect(uncommittedHead(m)?.name).toBe("fresh");
    commit("f1");
    expect(uncommittedHead(await model())).toBeUndefined();
  });

  it("gives a new repository's first branch an empty lane with HEAD on it", async () => {
    const { dir, git, commit, model } = fixture();
    let m = await model();
    expect(m.headHash).toBeUndefined();
    expect(m.branches.map((b) => [b.name, b.kind, b.isHead, b.commits.length, b.base])).toEqual([["main", "trunk", true, 0, null]]);
    expect(uncommittedHead(m)?.name).toBe("main");
    const l = layoutModel(m);
    expect(l.spans[0]).toMatchObject({ row: 0, firstCol: null, pendingCol: null });
    expect(l.cols).toBeGreaterThan(0);

    // New files are still pending on that empty lane, not a separate bubble.
    writeFileSync(join(dir, "a.txt"), "a\n");
    m = await model();
    expect(uncommittedHead(m)?.name).toBe("main");
    expect(pendingChangesOn(m)).toBeUndefined();

    // An orphan branch in a repository with history works the same way.
    commit("m1");
    git("switch", "-q", "--orphan", "fresh");
    m = await model();
    expect(uncommittedHead(m)?.name).toBe("fresh");
    expect(branch(m, "fresh").parent).toBeNull();
    expect(branch(m, "main").isHead).toBe(false);
  });
});

describe("pendingChangesOn", () => {
  it("adds a pending-changes changeset after HEAD when the working tree is dirty", async () => {
    const { dir, git, commit, model } = fixture();
    commit("m1");
    git("checkout", "-q", "-b", "work");
    const w1 = commit("w1");
    let m = await model();
    expect(m.pendingChanges).toBe(false);
    expect(pendingChangesOn(m)).toBeUndefined();
    expect(layoutModel(m).spans[branch(m, "work").id].pendingCol).toBeNull();

    writeFileSync(join(dir, "new.txt"), "x\n");
    m = await model();
    expect(m.pendingChanges).toBe(true);
    expect(pendingChangesOn(m)?.name).toBe("work");
    const l = layoutModel(m);
    const span = l.spans[branch(m, "work").id];
    expect(span.pendingCol).toBe(m.index.get(w1)! + 1);
    expect(span.endCol).toBeGreaterThanOrEqual(span.pendingCol!);
    expect(l.cols).toBe(m.order.length + 1);

    // A just-created branch already shows HEAD in its empty slot instead.
    git("checkout", "-q", "-b", "fresh");
    m = await model();
    expect(uncommittedHead(m)?.name).toBe("fresh");
    expect(pendingChangesOn(m)).toBeUndefined();
  });
});

describe("unpushed", () => {
  it("marks changesets and branches no remote-tracking branch has", async () => {
    const { git, commit, model } = fixture();
    const m1 = commit("m1");
    // No remote yet: nothing is marked.
    let m = await model();
    expect(m.hasRemotes).toBe(false);
    expect(m.unpushed.size).toBe(0);

    const remote = mkdtempSync(join(tmpdir(), "visualgit-remote-"));
    dirs.push(remote);
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git("remote", "add", "origin", remote);
    git("push", "-q", "-u", "origin", "main");
    const m2 = commit("m2");
    git("checkout", "-q", "-b", "local-only");
    const l1 = commit("l1");
    git("branch", "empty-local");

    m = await model();
    expect(m.hasRemotes).toBe(true);
    expect([...m.unpushed].sort()).toEqual([m2, l1].sort());
    expect(m.unpushed.has(m1)).toBe(false);
    const main = branch(m, "main");
    expect(main.published).toBe(true);
    expect(main.unpushed).toBe(1);
    const local = branch(m, "local-only");
    expect(local.published).toBe(false);
    expect(local.unpushed).toBe(2); // m2 and l1
    expect(branch(m, "empty-local").published).toBe(false);

    git("push", "-q", "origin", "main", "local-only");
    m = await model();
    expect(m.unpushed.size).toBe(0);
    expect(branch(m, "local-only").published).toBe(true);
    expect(branch(m, "local-only").unpushed).toBe(0);
  });
});

describe("changeset files", () => {
  it("lists what a changeset added, changed, deleted and renamed", async () => {
    const { dir, git, commit } = fixture();
    const write = (p: string, t: string) => writeFileSync(join(dir, p), t);
    write("a.txt", "a\n");
    write("old name.txt", "same content for rename detection\n");
    write("gone.txt", "g\n");
    git("add", ".");
    const first = commit("first");
    write("a.txt", "a2\n");
    write("new.txt", "n\n");
    git("rm", "-q", "gone.txt");
    git("mv", "old name.txt", "new name.txt");
    git("add", ".");
    const second = commit("second");
    const runner = nodeRunner(dir);

    expect(await loadChangesetFiles(runner, second, first)).toEqual([
      { status: "M", path: "a.txt" },
      { status: "D", path: "gone.txt" },
      { status: "R", origPath: "old name.txt", path: "new name.txt" },
      { status: "A", path: "new.txt" },
    ]);
    // The first changeset: everything is added.
    expect((await loadChangesetFiles(runner, first, null)).map((f) => `${f.status} ${f.path}`)).toEqual([
      "A a.txt",
      "A gone.txt",
      "A old name.txt",
    ]);
  });
});

describe("branchRows", () => {
  it("nests by parent, sorts, and filters by name with wildcards", async () => {
    const { git, commit, model } = fixture();
    commit("m1");
    git("checkout", "-q", "-b", "feature/login");
    commit("f1");
    git("checkout", "-q", "-b", "feature/login-tests");
    commit("t1");
    git("checkout", "-q", "main");
    git("checkout", "-q", "-b", "bugfix/crash");
    commit("b1");
    const m = await model();
    const names = (rows: { id: number; depth: number }[]) => rows.map((r) => `${"  ".repeat(r.depth)}${m.branches[r.id].name}`);

    expect(names(branchRows(m, "tree"))).toEqual(["main", "  bugfix/crash", "  feature/login", "    feature/login-tests"]);
    expect(names(branchRows(m, "name"))).toEqual(["bugfix/crash", "feature/login", "feature/login-tests", "main"]);
    // Matches lose the indent their hidden parents gave them.
    expect(names(branchRows(m, "tree", "LOGIN"))).toEqual(["feature/login", "feature/login-tests"]);
    expect(names(branchRows(m, "tree", "feat*tests"))).toEqual(["feature/login-tests"]);
    expect(names(branchRows(m, "name", "?ugfix"))).toEqual(["bugfix/crash"]);
    expect(branchRows(m, "tree", "nothing-like-this")).toEqual([]);
  });
});

describe("files", () => {
  it("lists tracked and new files as a tree, with pending changes counted per folder", async () => {
    const { dir, git, commit } = fixture();
    const write = (p: string, t: string) => {
      mkdirSync(join(dir, p, ".."), { recursive: true });
      writeFileSync(join(dir, p), t);
    };
    write("README.md", "r\n");
    write("src/a.ts", "a\n");
    write("src/view/b.ts", "b\n");
    write(".gitignore", "build/\n");
    git("add", ".");
    commit("base");
    write("src/view/b.ts", "b2\n"); // modified
    write("src/new.ts", "n\n"); // untracked
    write("build/out.js", "ignored\n"); // ignored: not listed
    git("rm", "-q", "README.md"); // deleted, no longer in the index

    const list = await loadFiles(nodeRunner(dir));
    expect(list.paths).toEqual([".gitignore", "README.md", "src/a.ts", "src/new.ts", "src/view/b.ts"]);
    expect(list.status.get("src/view/b.ts")?.letter).toBe("M");
    expect(list.status.get("src/new.ts")?.letter).toBe("?");
    expect(list.status.get("README.md")?.letter).toBe("D");
    expect(list.status.has("src/a.ts")).toBe(false);

    const tree = buildTree(list);
    expect(tree.files).toEqual([".gitignore", "README.md"]);
    expect(tree.folders.map((f) => f.name)).toEqual(["src"]);
    const src = tree.folders[0];
    expect(src.files).toEqual(["src/a.ts", "src/new.ts"]);
    expect(src.folders[0].path).toBe("src/view");
    expect([tree.changed, src.changed, src.folders[0].changed]).toEqual([3, 2, 1]);

    // Rows: folders first; only expanded folders show their contents; a search flattens.
    const keys = (rows: FileRow[]) => rows.map((r) => `${"  ".repeat(r.depth)}${rowKey(r)}`);
    expect(keys(fileRows(tree, list, new Set(), ""))).toEqual(["src/", ".gitignore", "README.md"]);
    expect(keys(fileRows(tree, list, new Set(["src"]), ""))).toEqual(["src/", "  src/view/", "  src/a.ts", "  src/new.ts", ".gitignore", "README.md"]);
    expect(keys(fileRows(tree, list, new Set(), "*.ts"))).toEqual(["src/a.ts", "src/new.ts", "src/view/b.ts"]);
  });

  it("finds who last changed each file, and when, with folders taking their newest file", async () => {
    const { dir, git, commit } = fixture();
    const write = (p: string, t: string) => {
      mkdirSync(join(dir, p, ".."), { recursive: true });
      writeFileSync(join(dir, p), t);
    };
    write("old.txt", "o\n");
    write("src/a.ts", "a\n");
    git("add", ".");
    const first = commit("first");
    write("src/a.ts", "a2\n");
    git("add", ".");
    const second = commit("second");
    write("src/new.ts", "n\n"); // never committed

    const runner = nodeRunner(dir);
    const list = await loadFiles(runner);
    list.last = await loadLastChanges(runner);
    expect(list.last.get("old.txt")?.hash).toBe(first);
    expect(list.last.get("src/a.ts")?.hash).toBe(second);
    expect(list.last.get("src/a.ts")?.author).toBe("Test");
    expect(list.last.has("src/new.ts")).toBe(false);
    const tree = buildTree(list);
    expect(tree.folders[0].latest?.hash).toBe(second);
    expect(tree.latest?.hash).toBe(second);
  });
});

describe("file history and ignore patterns", () => {
  it("lists the changesets that changed a file, following a rename", async () => {
    const { dir, git, commit } = fixture();
    writeFileSync(join(dir, "old.txt"), "one\ntwo\nthree\nfour\n");
    git("add", ".");
    const created = commit("create");
    writeFileSync(join(dir, "other.txt"), "x\n");
    git("add", ".");
    commit("unrelated");
    git("mv", "old.txt", "new.txt");
    const renamed = commit("rename");
    writeFileSync(join(dir, "new.txt"), "one\ntwo\nthree\nfive\n");
    git("add", ".");
    const edited = commit("edit");

    const h = await loadFileHistory(nodeRunner(dir), "new.txt");
    expect(h.map((e) => [e.hash, e.status, e.path, e.oldPath])).toEqual([
      [edited, "M", "new.txt", undefined],
      [renamed, "R", "new.txt", "old.txt"],
      [created, "A", "old.txt", undefined],
    ]);
    expect(h[2].parent).toBeNull();
    expect(h[0].subject).toBe("edit");
  });

  it("builds ignore patterns by name, extension and path", () => {
    expect(ignorePatterns("src/config/local.json")).toEqual({ name: "local.json", extension: "*.json", path: "/src/config/local.json" });
    expect(ignorePatterns("archive.tar.gz").extension).toBe("*.gz");
    expect(ignorePatterns(".env").extension).toBeNull();
    expect(ignorePatterns("Makefile").extension).toBeNull();
    // Pattern characters are escaped so only this file's name matches.
    expect(ignorePatterns("notes/#todo [draft]*.md")).toEqual({ name: "\\#todo \\[draft]\\*.md", extension: "*.md", path: "/notes/\\#todo \\[draft]\\*.md" });
  });
});
