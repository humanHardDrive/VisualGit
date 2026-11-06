/**
 * Reads everything the branch explorer needs from a repository using
 * read-only git commands. Works with any `GitRunner` (Tauri in the app,
 * child_process in tests and the CLI).
 */

export interface GitRunner {
  /** Runs `git <args>` in the repository and resolves with stdout. Rejects on non-zero exit. */
  run(args: string[]): Promise<string>;
}

export interface RawCommit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  /** Author time, unix seconds. */
  time: number;
  subject: string;
  /** Message after the subject line, trimmed; empty when there is none. */
  body: string;
}

export interface RawRef {
  /** Full ref name, e.g. `refs/heads/main`, `refs/remotes/origin/main`, `refs/tags/v1`. */
  name: string;
  /** The commit the ref points at (annotated tags are peeled). */
  hash: string;
}

export interface ReflogEntry {
  hash: string;
  message: string;
  /** Unix seconds. */
  time: number;
}

export interface RawRepo {
  /** Newest first, parents always after their children (`git log --date-order`). */
  commits: RawCommit[];
  refs: RawRef[];
  /** Branch name HEAD points at (`main`), or undefined when detached or unborn. */
  headBranch?: string;
  headHash?: string;
  /** Default branch name from `refs/remotes/origin/HEAD`, if known. */
  remoteDefault?: string;
  /** Reflog per full ref name (plus `HEAD`), newest entry first. */
  reflogs: Map<string, ReflogEntry[]>;
  /** True when history was cut off at `maxCommits`. */
  truncated: boolean;
}

const NUL = "\x00";
/** Ends each log record, since message bodies span several lines. */
const RS = "\x1e";

async function tryRun(git: GitRunner, args: string[]): Promise<string | undefined> {
  try {
    return await git.run(args);
  } catch {
    return undefined;
  }
}

export async function loadRepo(git: GitRunner, opts: { maxCommits?: number } = {}): Promise<RawRepo> {
  const maxCommits = opts.maxCommits ?? 20000;

  const [headHashOut, headRefOut, remoteHeadOut, refsOut, reflogOut] = await Promise.all([
    tryRun(git, ["rev-parse", "--verify", "-q", "HEAD"]),
    tryRun(git, ["symbolic-ref", "-q", "HEAD"]),
    tryRun(git, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]),
    git.run([
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(*objectname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]),
    tryRun(git, ["reflog", "show", "--all", "--date=unix", "--format=%gD%x00%H%x00%gs"]),
  ]);

  const headHash = headHashOut?.trim() || undefined;
  const headRef = headRefOut?.trim();
  const headBranch = headRef?.startsWith("refs/heads/") ? headRef.slice("refs/heads/".length) : undefined;
  const remoteHead = remoteHeadOut?.trim();
  const remoteDefault = remoteHead?.startsWith("refs/remotes/origin/")
    ? remoteHead.slice("refs/remotes/origin/".length)
    : undefined;

  const refs: RawRef[] = [];
  for (const line of refsOut.split("\n")) {
    if (!line) continue;
    const [name, object, peeled] = line.split(NUL);
    if (name.startsWith("refs/remotes/") && name.endsWith("/HEAD")) continue;
    refs.push({ name, hash: peeled || object });
  }

  let commits: RawCommit[] = [];
  let truncated = false;
  if (refs.length > 0 || headHash) {
    const args = [
      "log",
      "--branches",
      "--remotes",
      "--tags",
      "--date-order",
      `--max-count=${maxCommits + 1}`,
      "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b%x1e",
    ];
    // Include a detached HEAD; on a branch it adds nothing.
    if (headHash && !headBranch) args.push("HEAD");
    const out = await git.run(args);
    commits = parseLog(out);
    if (commits.length > maxCommits) {
      commits = commits.slice(0, maxCommits);
      truncated = true;
    }
  }

  return {
    commits,
    refs,
    headBranch,
    headHash,
    remoteDefault,
    reflogs: parseReflog(reflogOut ?? ""),
    truncated,
  };
}

export function parseLog(out: string): RawCommit[] {
  const commits: RawCommit[] = [];
  for (const record of out.split(RS)) {
    const line = record.replace(/^\n+/, "");
    if (!line) continue;
    const [hash, parents, author, email, time, subject, ...body] = line.split(NUL);
    commits.push({
      hash,
      parents: parents ? parents.split(" ") : [],
      author,
      email,
      time: Number(time),
      subject,
      body: body.join(NUL).trim(),
    });
  }
  return commits;
}

/**
 * Parses `reflog show --all --date=unix --format=%gD%x00%H%x00%gs`.
 * With `--date`, `%gD` is `refs/heads/x@{<unix time>}`. Entries are newest first per ref.
 */
export function parseReflog(out: string): Map<string, ReflogEntry[]> {
  const logs = new Map<string, ReflogEntry[]>();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [selector, hash, ...message] = line.split(NUL);
    const at = selector.lastIndexOf("@{");
    if (at < 0) continue;
    const ref = selector.slice(0, at);
    const timeMatch = /@\{(\d+)\}$/.exec(selector);
    let list = logs.get(ref);
    if (!list) logs.set(ref, (list = []));
    list.push({ hash, message: message.join(NUL), time: timeMatch ? Number(timeMatch[1]) : 0 });
  }
  return logs;
}
