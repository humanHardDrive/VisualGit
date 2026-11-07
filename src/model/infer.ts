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
}

const TRUNK_NAMES = ["main", "master", "trunk", "develop"];

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

  for (const ref of raw.refs) {
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
      isHead: cand.kind === "detached" || (cand.kind === "local" && cand.name === raw.headBranch),
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
      const b = newBranch({
        name: pulled ? `${name} (upstream)` : (name ?? "(merged)"),
        kind: name && !pulled ? "deleted" : "anonymous",
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
  };
}

/**
 * The checked-out branch when it has no changesets of its own yet (just
 * created, or HEAD detached on another branch's changeset). HEAD is then shown
 * on that branch's empty lane rather than on the changeset it points at.
 */
export function uncommittedHead(model: Model): Branch | undefined {
  return model.branches.find((b) => b.isHead && b.commits.length === 0);
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
