/**
 * Turns raw git data into Plastic-style branches.
 *
 * Git does not record which branch a commit was made on, or which branch a
 * branch was created from. This module reconstructs both:
 *
 *  1. Every ref (local + remote-tracking, grouped by name) becomes a branch,
 *     even when it has no commits of its own. An empty branch still gets a
 *     lane, anchored at the commit it points to.
 *  2. Branches claim commits by walking their first-parent chain from the tip
 *     until they hit a commit someone else already claimed. Claim order
 *     decides ownership of shared history: trunk first, then branches whose
 *     parent is known from the reflog, then the shortest walk first (a branch
 *     whose tip is in another branch's history is processed before it).
 *  3. Commits nobody claimed are recovered from merges: the non-first parent
 *     of a merge starts a "deleted" branch, named from the merge message.
 *  4. Each branch's base is the first parent of its oldest commit (or its tip
 *     when empty); the owner of the base is its parent. The reflog
 *     ("branch: Created from X", "checkout: moving from X to Y") overrides the
 *     parent when it is consistent with the history.
 */

import type { RawCommit, RawRepo } from "../git/load.ts";

export type BranchKind = "trunk" | "local" | "remote" | "deleted" | "detached" | "anonymous";

export interface Branch {
  id: number;
  name: string;
  kind: BranchKind;
  /** Full ref names pointing at this branch's tips. */
  refs: string[];
  /** Tip commit hashes (local tip first). */
  tips: string[];
  /** Owned commits, oldest first. */
  commits: string[];
  /** Commit this branch forked from (not owned by it); its tip if the branch is empty. */
  base: string | null;
  parent: number | null;
  children: number[];
  /** Source named by the reflog, when known. */
  createdFrom?: string;
  /** Unix seconds, from the reflog. */
  createdAt?: number;
  isHead: boolean;
  /** Has a remote-tracking ref, i.e. has been pushed (or fetched) at some point. */
  published: boolean;
  /** Changesets reachable from the local branch that are on no remote-tracking branch. */
  unpushed: number;
  /**
   * The remote-tracking branch a local branch is compared with: its upstream,
   * else the one of the same name (`origin/main`). Unset for a branch never pushed.
   */
  remote?: string;
  /** Changesets the local branch has that `remote` doesn't (some may be on other remote branches). */
  ahead: number;
  /** Changesets `remote` has that the local branch doesn't, as of the last fetch. */
  behind: number;
}

export interface Model {
  commits: Map<string, RawCommit>;
  /** Commit hashes oldest first; parents always come before children. */
  order: string[];
  index: Map<string, number>;
  owner: Map<string, number>;
  branches: Branch[];
  trunk: number | null;
  tags: Map<string, string[]>;
  /** Short branch ref names (`main`, `origin/main`) per commit. */
  refsAt: Map<string, string[]>;
  headHash?: string;
  headBranch?: string;
  truncated: boolean;
  /** The working tree has uncommitted changes. */
  pendingChanges: boolean;
  /** The repository has remote-tracking branches, so pushed/unpushed is meaningful. */
  hasRemotes: boolean;
  /** Changesets on local branches (or a detached HEAD) that no remote-tracking branch contains. */
  unpushed: Set<string>;
}

const TRUNK_NAMES = ["main", "master", "trunk", "develop"];
/** Where VisualGit keeps a branch's own changesets while merging them with its remote branch's. */
const SYNC_REFS = "refs/visualgit/sync/";

interface Candidate {
  name: string;
  kind: BranchKind;
  refs: string[];
  tips: string[];
  /** Lower runs earlier among branches with no ordering constraint. */
  priority: number;
  hintParent?: string;
  createdFrom?: string;
  createdAt?: number;
}

export function inferModel(raw: RawRepo): Model {
  const commits = new Map<string, RawCommit>();
  for (const c of raw.commits) commits.set(c.hash, c);
  const order = raw.commits.map((c) => c.hash).reverse();
  const index = new Map<string, number>();
  order.forEach((h, i) => index.set(h, i));

  // ---- 1. Group refs into named branch candidates -------------------------
  const byName = new Map<string, Candidate>();
  const tags = new Map<string, string[]>();
  const refsAt = new Map<string, string[]>();
  const remoteRefs: { name: string; ref: string; hash: string }[] = [];

  const LOCAL = " (local)";
  for (const ref of raw.refs) {
    if (ref.name.startsWith(SYNC_REFS)) {
      // A branch's own changesets while they're merged with its remote branch's (see `sync_branch`).
      const name = ref.name.slice(SYNC_REFS.length);
      if (commits.has(ref.hash)) byName.set(name + LOCAL, { name: name + LOCAL, kind: "local", refs: [ref.name], tips: [ref.hash], priority: 0, hintParent: name });
      continue;
    }
    if (!ref.name.startsWith("refs/tags/") && commits.has(ref.hash)) {
      const short = ref.name.replace(/^refs\/(heads|remotes)\//, "");
      refsAt.set(ref.hash, [...(refsAt.get(ref.hash) ?? []), short]);
    }
    if (ref.name.startsWith("refs/tags/")) {
      const tag = ref.name.slice("refs/tags/".length);
      if (commits.has(ref.hash)) tags.set(ref.hash, [...(tags.get(ref.hash) ?? []), tag]);
    } else if (ref.name.startsWith("refs/heads/")) {
      const name = ref.name.slice("refs/heads/".length);
      byName.set(name, { name, kind: "local", refs: [ref.name], tips: [ref.hash], priority: 0 });
    } else if (ref.name.startsWith("refs/remotes/")) {
      const rest = ref.name.slice("refs/remotes/".length);
      const slash = rest.indexOf("/");
      if (slash < 0) continue;
      remoteRefs.push({ name: rest.slice(slash + 1), ref: ref.name, hash: ref.hash });
    }
  }
  // Remote-tracking refs join the local branch of the same name; origin first.
  remoteRefs.sort((a, b) => Number(!a.ref.startsWith("refs/remotes/origin/")) - Number(!b.ref.startsWith("refs/remotes/origin/")));
  for (const r of remoteRefs) {
    const existing = byName.get(r.name);
    if (existing) {
      existing.refs.push(r.ref);
      if (!existing.tips.includes(r.hash)) existing.tips.push(r.hash);
    } else {
      byName.set(r.name, { name: r.name, kind: "remote", refs: [r.ref], tips: [r.hash], priority: 0 });
    }
  }
  for (const c of byName.values()) c.tips = c.tips.filter((t) => commits.has(t));
  // A local branch and its remote branch that have each moved on: the lane is
  // what the remote has, and the branch's own changesets get a lane of their
  // own, "main (local)", until they're merged in (and pushed).
  for (const c of [...byName.values()]) {
    const local = c.refs.find((r) => r.startsWith("refs/heads/"));
    const remote = c.refs.find((r) => r.startsWith("refs/remotes/"));
    if (!local || !remote || byName.has(c.name + LOCAL)) continue;
    const mine = raw.refs.find((r) => r.name === local)?.hash;
    const theirs = raw.refs.find((r) => r.name === remote)?.hash;
    if (!mine || !theirs || !commits.has(mine) || !commits.has(theirs)) continue;
    const [ahead, behind] = aheadBehind(commits, index, mine, theirs);
    if (ahead === 0 || behind === 0) continue;
    c.refs = c.refs.filter((r) => r !== local);
    c.tips = [...new Set(c.refs.map((r) => raw.refs.find((x) => x.name === r)!.hash))].filter((t) => commits.has(t));
    if (c.kind === "local") c.kind = "remote";
    byName.set(c.name + LOCAL, { name: c.name + LOCAL, kind: "local", refs: [local], tips: [mine], priority: 0, hintParent: c.name, createdAt: c.createdAt });
  }
  // A checked-out branch with nothing committed yet (a new repository, or
  // `git switch --orphan`): HEAD names it, but git has no ref for it until its
  // first commit. It still gets its own, empty lane, where HEAD is shown.
  if (raw.headBranch && !raw.headHash && !byName.has(raw.headBranch)) {
    byName.set(raw.headBranch, { name: raw.headBranch, kind: "local", refs: [], tips: [], priority: 0 });
  }

  // ---- 2. Pick the trunk -------------------------------------------------
  let trunkName: string | undefined;
  if (raw.remoteDefault && byName.has(raw.remoteDefault)) trunkName = raw.remoteDefault;
  trunkName ??= TRUNK_NAMES.find((n) => byName.has(n));
  trunkName ??= raw.headBranch && byName.has(raw.headBranch) ? raw.headBranch : undefined;
  trunkName ??= byName.keys().next().value;

  // ---- 3. Reflog hints ---------------------------------------------------
  const headLog = raw.reflogs.get("HEAD") ?? [];
  for (const cand of byName.values()) {
    const log = raw.reflogs.get(`refs/heads/${cand.name}`);
    const first = log?.[log.length - 1];
    if (!first) continue;
    const created = /^branch: Created from (.+)$/.exec(first.message);
    if (!created) continue;
    cand.createdAt = first.time;
    let source = created[1];
    if (source === "HEAD") {
      // `git checkout -b x` / `git switch -c x`: the HEAD reflog says where we came from.
      const move = findLast(headLog, (e) => e.message.endsWith(` to ${cand.name}`) && e.message.startsWith("checkout: moving from "));
      const from = move?.message.slice("checkout: moving from ".length, -(` to ${cand.name}`.length));
      if (from) source = from;
    }
    cand.createdFrom = source;
    const resolved = resolveBranchName(source, byName);
    if (resolved && resolved !== cand.name) cand.hintParent = resolved;
  }

  // Branch-name conventions as a tiebreak: long-lived branches claim first.
  for (const cand of byName.values()) {
    if (/^(develop|dev|development)$/.test(cand.name)) cand.priority = -2;
    else if (/^(release|hotfix|support)[/-]/.test(cand.name)) cand.priority = -1;
  }

  // Detached HEAD gets a lane only if it ends up owning commits.
  const candidates = [...byName.values()];
  if (!raw.headBranch && raw.headHash && commits.has(raw.headHash)) {
    candidates.push({ name: "HEAD (detached)", kind: "detached", refs: ["HEAD"], tips: [raw.headHash], priority: 10 });
  }

  // ---- 4. Claim commits ----------------------------------------------------
  const owner = new Map<string, number>();
  const branches: Branch[] = [];
  const nameToId = new Map<string, number>();

  const newBranch = (cand: Candidate): Branch => {
    const b: Branch = {
      id: branches.length,
      name: cand.name,
      kind: cand.kind,
      refs: cand.refs,
      tips: cand.tips,
      commits: [],
      base: null,
      parent: null,
      children: [],
      createdFrom: cand.createdFrom,
      createdAt: cand.createdAt,
      isHead:
        cand.kind === "detached" ||
        (raw.headBranch !== undefined && cand.refs.includes(`refs/heads/${raw.headBranch}`)) ||
        (cand.kind === "local" && cand.refs.length === 0 && cand.name === raw.headBranch),
      published: cand.refs.some((r) => r.startsWith("refs/remotes/")),
      unpushed: 0,
      ahead: 0,
      behind: 0,
    };
    branches.push(b);
    return b;
  };

  const claim = (b: Branch, tip: string) => {
    let c: string | undefined = tip;
    while (c && commits.has(c) && !owner.has(c)) {
      owner.set(c, b.id);
      b.commits.push(c);
      c = commits.get(c)!.parents[0];
    }
  };

  const walkLength = (tips: string[]) => {
    let n = 0;
    const seen = new Set<string>();
    for (const tip of tips) {
      let c: string | undefined = tip;
      while (c && commits.has(c) && !owner.has(c) && !seen.has(c)) {
        seen.add(c);
        n++;
        c = commits.get(c)!.parents[0];
      }
    }
    return n;
  };

  const pending = new Set(candidates);
  const takeCandidate = (cand: Candidate) => {
    pending.delete(cand);
    const b = newBranch(cand);
    if (cand.name === trunkName) b.kind = "trunk";
    for (const tip of cand.tips) claim(b, tip);
    nameToId.set(cand.name, b.id);
  };

  const trunkCand = candidates.find((c) => c.name === trunkName && c.kind !== "detached");
  if (trunkCand) takeCandidate(trunkCand);

  while (pending.size > 0) {
    // A branch is ready once its reflog parent (if any, and if it exists) has claimed.
    const ready = [...pending].filter(
      (c) => !c.hintParent || nameToId.has(c.hintParent) || ![...pending].some((p) => p.name === c.hintParent),
    );
    // Hint cycles: fall back to everything pending.
    const pool = ready.length > 0 ? ready : [...pending];
    let best: Candidate | undefined;
    let bestKey: [number, number, string] | undefined;
    for (const c of pool) {
      const key: [number, number, string] = [c.priority, walkLength(c.tips), c.name];
      if (!bestKey || compareKey(key, bestKey) < 0) {
        best = c;
        bestKey = key;
      }
    }
    takeCandidate(best!);
  }

  // ---- 5. Recover deleted / anonymous branches ------------------------------
  // Newest first, so a merge is always seen before the commits it merged.
  for (let i = order.length - 1; i >= 0; i--) {
    const h = order[i];
    if (!owner.has(h)) {
      const tagNames = tags.get(h);
      const b = newBranch({
        name: tagNames ? `(tag ${tagNames[0]})` : "(unnamed)",
        kind: "anonymous",
        refs: [],
        tips: [h],
        priority: 0,
      });
      claim(b, h);
    }
    const c = commits.get(h)!;
    for (let p = 1; p < c.parents.length; p++) {
      const ph = c.parents[p];
      if (!commits.has(ph) || owner.has(ph)) continue;
      const name = branchNameFromMerge(c.subject, c.parents.length > 2);
      // `git pull` merges "branch 'main' of <url>" into main: the other side is
      // upstream work on the same branch, not a deleted branch.
      const pulled = name !== undefined && name === branches[owner.get(h)!].name;
      // VisualGit's sync merge: the other side is the branch's own changesets, made before it was level with its remote.
      const synced = /^Merge local changes into (\S+)$/.exec(c.subject)?.[1];
      const b = newBranch({
        name: synced ? `${synced}${LOCAL}` : pulled ? `${name} (upstream)` : (name ?? "(merged)"),
        kind: name && !pulled && !synced ? "deleted" : "anonymous",
        refs: [],
        tips: [ph],
        priority: 0,
      });
      claim(b, ph);
    }
  }

  // Drop a detached HEAD that owns nothing (HEAD sits on some branch's history).
  const kept = branches.filter((b) => !(b.kind === "detached" && b.commits.length === 0));
  if (kept.length !== branches.length) {
    const remap = new Map<number, number>();
    kept.forEach((b, i) => {
      remap.set(b.id, i);
      b.id = i;
    });
    for (const [h, id] of owner) owner.set(h, remap.get(id)!);
    branches.length = 0;
    branches.push(...kept);
  }

  // ---- 6. Bases and parents ------------------------------------------------
  for (const b of branches) {
    b.commits.sort((x, y) => index.get(x)! - index.get(y)!);
    if (b.commits.length > 0) {
      const firstParent = commits.get(b.commits[0])!.parents[0];
      b.base = firstParent && commits.has(firstParent) ? firstParent : null;
    } else {
      b.base = b.tips[0] ?? null;
    }
    b.parent = b.base !== null ? (owner.get(b.base) ?? null) : null;
  }

  // Reflog override: accept "created from P" when P plausibly sits at our base.
  const byId = (id: number) => branches[id];
  for (const b of branches) {
    const cand = byName.get(b.name);
    if (!cand?.hintParent || b.kind === "deleted" || b.kind === "anonymous") continue;
    const p = branches.find((x) => x.name === cand.hintParent && x.kind !== "deleted" && x.kind !== "anonymous");
    if (!p || p.id === b.parent || b.base === null) continue;
    const plausible = owner.get(b.base) === p.id || p.tips.includes(b.base) || p.base === b.base;
    if (!plausible || createsCycle(b.id, p.id, byId)) continue;
    b.parent = p.id;
  }

  for (const b of branches) if (b.parent !== null) branches[b.parent].children.push(b.id);

  const { hasRemotes, unpushed } = findUnpushed(raw, commits, branches);
  compareWithRemotes(raw, commits, index, branches);

  return {
    commits,
    order,
    index,
    owner,
    branches,
    trunk: trunkCand ? (nameToId.get(trunkCand.name) ?? null) : null,
    tags,
    refsAt,
    headHash: raw.headHash,
    headBranch: raw.headBranch,
    truncated: raw.truncated,
    pendingChanges: raw.pendingChanges,
    hasRemotes,
    unpushed,
  };
}

/**
 * The checked-out branch when it has no changesets of its own yet (just
 * created, or the first branch of a new repository). HEAD is then shown on
 * that branch's empty lane rather than on the changeset it points at.
 */
export function uncommittedHead(model: Model): Branch | undefined {
  return model.branches.find((b) => b.isHead && b.commits.length === 0);
}

/**
 * What hasn't been pushed, as of the last fetch: changesets reachable from a
 * local branch (or a detached HEAD) but from no remote-tracking ref. Also sets
 * each local branch's `unpushed` count. Nothing is marked in a repository with
 * no remote-tracking refs, where everything would be.
 */
function findUnpushed(raw: RawRepo, commits: Map<string, RawCommit>, branches: Branch[]) {
  const remoteTips = raw.refs.filter((r) => r.name.startsWith("refs/remotes/") && commits.has(r.hash)).map((r) => r.hash);
  const unpushed = new Set<string>();
  if (remoteTips.length === 0) return { hasRemotes: false, unpushed };

  const pushed = new Set<string>();
  const stack = [...remoteTips];
  while (stack.length) {
    const h = stack.pop()!;
    if (pushed.has(h)) continue;
    pushed.add(h);
    for (const p of commits.get(h)!.parents) if (commits.has(p) && !pushed.has(p)) stack.push(p);
  }
  /** Walks back from `tip` through changesets no remote has; returns how many. */
  const walk = (tip: string) => {
    const seen = new Set<string>();
    const todo = [tip];
    while (todo.length) {
      const h = todo.pop()!;
      if (seen.has(h) || pushed.has(h) || !commits.has(h)) continue;
      seen.add(h);
      unpushed.add(h);
      todo.push(...commits.get(h)!.parents);
    }
    return seen.size;
  };
  const byRef = new Map(branches.flatMap((b) => b.refs.map((r) => [r, b] as const)));
  for (const ref of raw.refs) {
    if (!ref.name.startsWith("refs/heads/")) continue;
    const n = walk(ref.hash);
    const b = byRef.get(ref.name);
    if (b) b.unpushed = n;
  }
  if (!raw.headBranch && raw.headHash) walk(raw.headHash);
  return { hasRemotes: true, unpushed };
}

/**
 * Sets each local branch's `remote`, `ahead` and `behind`: how it compares
 * with its own remote-tracking branch, which `unpushed` doesn't tell. A
 * branch whose changesets were pushed under another branch's name (a branch
 * created from it, say) has nothing unpushed, but its own remote branch is
 * still behind until the branch itself is pushed.
 */
function compareWithRemotes(raw: RawRepo, commits: Map<string, RawCommit>, index: Map<string, number>, branches: Branch[]) {
  const hashOf = new Map(raw.refs.map((r) => [r.name, r.hash] as const));
  const upstreamOf = new Map(raw.refs.filter((r) => r.upstream).map((r) => [r.name, r.upstream!] as const));
  for (const b of branches) {
    const local = b.refs.find((r) => r.startsWith("refs/heads/"));
    if (!local) continue;
    const configured = upstreamOf.get(local);
    const short = local.slice("refs/heads/".length);
    // Its upstream, else a remote branch of the same name (origin first); the lane may not hold it ("main (local)").
    const sameName = raw.refs
      .map((r) => r.name)
      .filter((r) => r.startsWith("refs/remotes/") && r.slice("refs/remotes/".length).split("/").slice(1).join("/") === short)
      .sort((x, y) => Number(!x.startsWith("refs/remotes/origin/")) - Number(!y.startsWith("refs/remotes/origin/")));
    const remote = configured?.startsWith("refs/remotes/") && hashOf.has(configured) ? configured : sameName[0];
    if (!remote) continue;
    b.remote = remote.slice("refs/remotes/".length);
    const [ahead, behind] = aheadBehind(commits, index, hashOf.get(local)!, hashOf.get(remote)!);
    b.ahead = ahead;
    b.behind = behind;
  }
}

/**
 * Changesets reachable from `a` and not `b`, and from `b` and not `a`. Walks
 * newest first (parents always have a lower index) and stops once every
 * changeset still to visit is reachable from both.
 */
function aheadBehind(commits: Map<string, RawCommit>, index: Map<string, number>, a: string, b: string): [number, number] {
  if (a === b) return [0, 0];
  const flags = new Map<string, number>();
  const heap: string[] = []; // max-heap by index: a changeset comes off only after everything above it
  const at = (k: number) => index.get(heap[k])!;
  const push = (h: string) => {
    heap.push(h);
    for (let k = heap.length - 1; k > 0; ) {
      const up = (k - 1) >> 1;
      if (at(up) >= at(k)) break;
      [heap[up], heap[k]] = [heap[k], heap[up]];
      k = up;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let k = 0; ; ) {
        const l = 2 * k + 1;
        const r = l + 1;
        let big = k;
        if (l < heap.length && at(l) > at(big)) big = l;
        if (r < heap.length && at(r) > at(big)) big = r;
        if (big === k) break;
        [heap[big], heap[k]] = [heap[k], heap[big]];
        k = big;
      }
    }
    return top;
  };
  let open = 0; // queued changesets reachable from only one side
  const mark = (h: string, f: number) => {
    if (!index.has(h)) return; // beyond a truncated history
    const before = flags.get(h) ?? 0;
    const after = before | f;
    if (after === before) return;
    flags.set(h, after);
    if (before === 0) push(h);
    if (before === 0 && after !== 3) open++;
    else if (before !== 0 && after === 3) open--;
  };
  mark(a, 1);
  mark(b, 2);
  let ahead = 0;
  let behind = 0;
  while (open > 0 && heap.length) {
    const h = pop();
    const f = flags.get(h)!;
    if (f === 1) ahead++;
    else if (f === 2) behind++;
    if (f !== 3) open--;
    for (const p of commits.get(h)?.parents ?? []) mark(p, f);
  }
  return [ahead, behind];
}

/**
 * The checked-out branch, when it has changesets and the working tree has
 * uncommitted changes: it gets an empty "pending changes" changeset after its
 * latest one, which carries the HEAD marker.
 */
export function pendingChangesOn(model: Model): Branch | undefined {
  if (!model.pendingChanges) return undefined;
  return model.branches.find((b) => b.isHead && b.commits.length > 0 && b.commits[b.commits.length - 1] === model.headHash);
}

function compareKey(a: [number, number, string], b: [number, number, string]) {
  return a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
}

function createsCycle(child: number, parent: number, get: (id: number) => Branch) {
  for (let p: number | null = parent, steps = 0; p !== null && steps < 10000; p = get(p).parent, steps++) {
    if (p === child) return true;
  }
  return false;
}

function findLast<T>(list: T[], pred: (t: T) => boolean): T | undefined {
  // Reflogs are newest first, so the last match is the oldest.
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) return list[i];
  return undefined;
}

function resolveBranchName(source: string, byName: Map<string, Candidate>): string | undefined {
  const candidates = [source];
  if (source.startsWith("refs/heads/")) candidates.push(source.slice("refs/heads/".length));
  const remote = /^(?:refs\/remotes\/)?[^/]+\/(.+)$/.exec(source);
  if (remote) candidates.push(remote[1]);
  return candidates.find((n) => byName.has(n));
}

/** Recovers the merged branch's name from common merge-commit messages. */
export function branchNameFromMerge(subject: string, octopus: boolean): string | undefined {
  if (octopus) return undefined;
  let m = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject);
  if (m) return subject.includes("remote-tracking") ? stripRemote(m[1]) : m[1];
  m = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/.exec(subject);
  if (m) return m[2];
  m = /^Merged in (\S+)/.exec(subject); // Bitbucket
  if (m) return m[1];
  m = /^Merge (?:remote-tracking )?branch "([^"]+)"/.exec(subject);
  if (m) return m[1];
  return undefined;
}

function stripRemote(name: string) {
  const i = name.indexOf("/");
  return i >= 0 ? name.slice(i + 1) : name;
}
