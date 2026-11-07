# VisualGit

A free, open-source Git client built around a **Plastic SCM–style Branch Explorer**: every branch is its own horizontal lane, changesets sit on the lane they were made on, you can see where each branch was created and how branches merge back. Even a brand-new branch with no commits shows up as its own lane.

> Status: 1.0 is the branch explorer. Work in progress: committing from the Pending Changes window. Creating branches and merging come next.

## Why this is hard in Git

Plastic records which branch every changeset belongs to and which branch each branch was created from. Git records neither. A Git branch is just a pointer to a commit, so a branch you just created is indistinguishable from the commit it points at. After a merge, nothing says which side was "the branch".

VisualGit reconstructs that information ([src/model/infer.ts](src/model/infer.ts)):

1. **Every ref is a branch**, including empty ones. Local and remote-tracking refs with the same name are one branch.
2. **Branches claim commits** by walking their first-parent chain from the tip until they hit a commit someone else already claimed. The trunk (`origin/HEAD`, `main`, `master`, …) claims first. The order for the rest comes from the reflog, then from naming conventions (`develop`, `release/*`), then from the shortest walk.
3. **The reflog says where branches came from.** `branch: Created from X` and `checkout: moving from X to Y` give the parent branch, even for branches created with `checkout -b` and branches with no commits.
4. **Deleted branches are recovered from merges.** The second parent of a merge starts a lane named from the merge message (`Merge branch 'x'`, `Merge pull request #1 from user/x`, Bitbucket's `Merged in x`). `git pull` merges are labelled as the branch's upstream side.
5. **Layout** ([src/model/layout.ts](src/model/layout.ts)): time runs left to right with one column per changeset. Child branches sit below their parent, and lanes share a row when their time spans don't overlap.

The reflog is local and expires, so a fresh clone falls back to heuristics. The plan is to also record branch metadata in a pushable ref (see the roadmap).

## Running it

Requirements: [Node.js](https://nodejs.org) 22+, [Rust](https://rustup.rs) (stable), and Git. On Linux you also need the [Tauri system dependencies](https://tauri.app/start/prerequisites/).

```sh
npm install
npm run app                             # desktop app, hot reload
VISUALGIT_REPO=/path/to/repo npm run app  # open a repository straight away
```

**Workspaces.** Choose *File › Open Workspace…* and pick the folder you keep your repositories in (e.g. `~/Documents/GitHub`). VisualGit finds every repository up to four levels down, skipping hidden folders and `node_modules`/`target`-style build folders. They're listed in the sidebar with their checked-out branch, and one click switches between them. Each repository keeps its own zoom, scroll position and selection while you switch. The workspace and the last repository are reopened at the next launch. *File › Open Repository…* opens a single repository from anywhere.

The app opens whatever repository you pass as `visualgit /path/to/repo` or in `VISUALGIT_REPO`, otherwise the last one you opened.

The home symbol marks what's checked out. When you have uncommitted changes, an empty changeset is drawn at the end of the checked-out branch, after its latest changeset, with a hollow, dashed home symbol. A branch you've just created and switched to shows the same hollow home symbol in its empty slot. Right-click either one for *Pending Changes*.

**Creating branches.** Right-click any changeset and choose *Create Branch from This Changeset…*. Type a name and choose whether to switch to the new branch. Switching is ticked by default when you start from the checked-out changeset, so any work in progress comes along. The new branch shows up straight away as its own empty lane, starting at that changeset.

**Switching.** Right-click a branch and choose *Switch to This Branch* to move HEAD to its latest changeset. For a remote-only branch, this first creates a local branch that tracks it. For a deleted or unnamed lane, it checks out the lane's last changeset as a detached HEAD. You can also right-click a changeset and choose *Switch to This Changeset*. If it's the tip of a local branch, you switch to that branch (the menu names it). Otherwise the changeset is checked out on its own, as a detached HEAD: create a branch there before committing. If you have pending changes to tracked files, the switch waits: the Pending Changes window opens so you can commit them first. New, untracked files don't block a switch and stay where they are.

**What hasn't been pushed** is shown in orange, as of your last fetch:

- A changeset that no remote-tracking branch contains gets a small up-arrow.
- A branch shows ↑3 when three of its changesets aren't pushed, or *not pushed* if the branch itself has never been pushed. This appears on its lane, in the sidebar and in the details panel.
- The toolbar shows how many changesets are waiting to be pushed in total.

A repository with no remote-tracking branches shows none of this. To push a branch, right-click it (on its lane or in the sidebar) and choose *Push*. This is offered while the branch has changesets to push or has never been pushed. A branch with an upstream goes to it; a new branch is published to `origin` and tracks it from then on.

Using it: drag or scroll to pan, ⌘/Ctrl + scroll (or pinch) to zoom, click a changeset or branch for details.

**Pending Changes.** Double-click the checked-out changeset (the one with the home symbol), or right-click it or its branch and choose *Pending Changes*. This opens a window for that repository:

- **Files** on the left: every changed, new, deleted, renamed or conflicted file, each with a checkbox. Ticked files go into the next commit.
- **Diff** on the right: the checked-out changeset next to your working copy. ↑/↓ in the diff bar (or F7 / ⇧F7) move from change to change, and the arrows between the sides put the committed text back over a change.
- **Editing**: the working-copy side is an editor. ⌘S saves. Edits are also saved when you switch files, commit or close the window. Line endings (LF or CRLF) are kept as they were.
- **Commit** at the top: type a message and press *Commit* (or ⌘↩). The ▾ next to it offers *Commit & Push* (⇧⌘↩), which pushes the checked-out branch after committing. It pushes to the branch's upstream, or, for a branch that has never been pushed, publishes it to `origin` and tracks it from then on. Only the ticked files are committed, exactly as they are on disk; anything else you had staged stays staged. During a merge, git requires the whole merge to be committed at once.

The window refreshes when it regains focus, and the branch explorer reloads after each commit.

**Search.** The search box in the toolbar (⌘F) looks through branch names, changeset ids and commit messages (the full message, not just the first line), plus release names. Matching ignores case and finds the text anywhere, and two wildcards are supported: `*` matches any run of characters and `?` matches exactly one, so `feat*login` finds `feature/login-page` and `v1.?` finds `v1.2`. A changeset id matches from its start once you've typed four or more hex digits. Matches are highlighted in the explorer and everything else fades back. ↑/↓ steps through the results list, Enter jumps to one, Esc ends the search.

| Key | Action |
| --- | --- |
| `⇧⌘O` / `⌘O` | File › Open Workspace… / Open Repository… |
| `⌘[` / `⌘]` | Previous / next repository in the workspace |
| `⌘R` | Reload (also happens when the window regains focus, so terminal commits show up) |
| `←` / `→` | Previous / next changeset along the selected branch (also the toolbar arrows) |
| `Home` | Go to the checked-out changeset (HEAD) |
| `⌘F` | Search branches, changesets and commit messages |
| `+` / `-` / `0` / `L` | Zoom in / out / fit / jump to latest |

### Development

```sh
npm test                                # inference + layout tests against scripted git repos
npm run typecheck
npm run inspect -- /path/to/repo        # print the inferred branch tree in the terminal
scripts/make-demo-repo.sh /tmp/demo     # a repo exercising every explorer case
cd src-tauri && cargo test              # backend tests: command validation, workspace scan
```

### Layout of the code

| Path | What it does |
| --- | --- |
| [src/git/load.ts](src/git/load.ts) | Reads refs, history and reflogs with read-only git commands |
| [src/git/status.ts](src/git/status.ts) | Reads pending changes (`git status --porcelain=v2`) |
| [src/model/infer.ts](src/model/infer.ts) | Turns raw history into branches with parents, bases and owned changesets |
| [src/model/layout.ts](src/model/layout.ts) | Assigns lanes to rows and changesets to columns |
| [src/model/search.ts](src/model/search.ts) | Search with `*` / `?` wildcards |
| [src/view/explorer.ts](src/view/explorer.ts) | Canvas renderer, pan/zoom and hit testing |
| [src/view/details.ts](src/view/details.ts) | Changeset and branch details panel |
| [src-tauri/src/lib.rs](src-tauri/src/lib.rs) | Rust backend: one `git` command that only allows read-only subcommands |
| [src-tauri/src/pending.rs](src-tauri/src/pending.rs) | The commands that change things: open the Pending Changes window, read and save working-tree files (paths checked to stay inside the repository), commit selected files |
| [src/pending/main.ts](src/pending/main.ts) | Pending Changes window: file list, diff editor ([CodeMirror](https://codemirror.net) merge view), commit box |
| [src-tauri/src/workspace.rs](src-tauri/src/workspace.rs) | Finds the repositories inside a workspace folder |
| [src-tauri/src/menu.rs](src-tauri/src/menu.rs) | Native menu bar (File › Open Workspace…, Open Repository…) |

The About panel shows the version, author, copyright and the changeset the app was built from. The build stamps in the current `HEAD` ([src-tauri/build.rs](src-tauri/build.rs)). When building without a `.git` folder, set `VISUALGIT_CHANGESET` to provide it.

The model code is plain TypeScript with no Tauri dependency, so it runs under Node in tests and in `npm run inspect`.

## Roadmap

- **Branch metadata ref**: when you create a branch from VisualGit, record `{name, parent, base, created}` under `refs/visualgit/`. It can be pushed and fetched, so everyone sees the same branch tree, not just the machine where the reflog lives.
- Delete branches from the explorer.
- Merge from the explorer, with the merge arrow previewed before you commit.
- Diff viewer for changesets and for "what does this branch change".
- Filters: hide merged/deleted branches, date range, author.
- Performance for very large histories (incremental loading, a WebGL renderer).

## License

[MIT](LICENSE)
