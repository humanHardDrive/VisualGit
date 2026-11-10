# VisualGit

A free, open-source Git client built around a **Plastic SCM–style Branch Explorer**: every branch is its own horizontal lane, changesets sit on the lane they were made on, you can see where each branch was created and how branches merge back. Even a brand-new branch with no commits shows up as its own lane.

> Status: 1.0 is the branch explorer. Work in progress: committing from the Pending Changes view. Creating branches and merging come next.

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

**Workspaces.** Choose *File › Open Workspace…* (or *Open Workspace…* in the Workspace view) and pick the folder you keep your repositories in, e.g. `~/Documents/GitHub`.

- **Finding repositories:** VisualGit looks up to four levels down, skipping hidden folders and build folders such as `node_modules` and `target`.
- **The Workspace view:** one of the entries under *View*. It lists every repository with what it has checked out, its remote and its path, and you can search their names with ⌘F.
  - Click a repository to open it. Double-click it, or press Enter in the search box, to open it and go straight to the Branch Explorer.
  - *Rescan* looks for new repositories.
  - **Remote:** where the repository pushes to: the hosting service (*GitHub*, *GitLab*, …), or the server's name if it's self-hosted, or *Local folder* for a remote that's a path on disk. *Local only* means it has no remote. It's `origin` when there is one, otherwise the remote is named. Hover for the full URL (never including a password or token).
  - Right-click a repository for *Switch Active Repo* (the same as double-clicking it) and *Open on GitHub* (or GitLab, Bitbucket, Azure DevOps, Codeberg, SourceHut, or the server's name if it's self-hosted). The page comes from the repository's remote URL: `origin` first, then `upstream`, then any other. SSH host aliases from `~/.ssh/config` are followed to the real host, and any user name or token in the URL is left out of the address.
  - Right-click anywhere in the view and choose *Create New Repository…* to make one in the workspace. A name like `group/my-project` creates the folders too. You also choose the first branch (`main` unless you change it) and, optionally, a remote to push to, which becomes `origin`. Git can't create the repository on the server, so it must already exist there. The first *Commit & Push* publishes the branch to it and tracks it. Without a remote, the repository is local only. Only https://, http://, ssh://, git://, file:// and `git@host:path` remotes are accepted.
  - Right-click anywhere in the view and choose *Clone Repository…* to `git clone` a URL into the workspace. The folder name comes from the URL (you can change it, `group/name` works too). The dialog closes and git's progress shows in the corner; the clone is listed, and opened if you asked, when it's done. There's no terminal to type a password into, so private repositories need credentials Git already has: a credential helper (such as the macOS Keychain) for https://, or an SSH key in your agent. A folder that already exists but isn't a repository yet becomes one, and its files are left as they are. VisualGit won't create a repository inside another one, or anywhere the workspace scan wouldn't find it: in a hidden or build folder, or more than four levels down.
- **Remembered settings:** each repository keeps its own zoom, scroll position and selection while you switch. The workspace and the last repository reopen at the next launch.

*File › Open Repository…* opens a single repository from anywhere.

The app opens whatever repository you pass as `visualgit /path/to/repo` or in `VISUALGIT_REPO`, otherwise the last one you opened.

**Views.** The *View* pane in the sidebar switches between five views:

- **Workspace:** the repositories in the open workspace (see above).
- **Branch Explorer:** the lanes.
- **Branch List:** a table of every branch.
  - **What it shows:** each branch's lane colour, its badges (HEAD, empty, remote, deleted, not pushed), how many changesets it has, its latest changeset, and that changeset's author and date.
  - **Sorting:** branches are nested under their parent. Click *Branch* to sort them A–Z instead, or sort by *Changesets*, *Latest changeset* or *Date*.
  - **Using it:** click a row to select the branch (the Branch Explorer shows it when you go back), double-click it (or press Enter) for its changes, and right-click it for the branch menu. ↑/↓ move between rows. The list has its own search box for branch names (⌘F), with the same `*` / `?` wildcards; ↑/↓ and Enter work from inside the box too.

- **Files:** the repository's working copy as a folder tree. That's every tracked file, plus new files git isn't ignoring.
  - **Pending changes:** files with pending changes show their status letter (M, A, D, ?, U), and each folder shows how many changed files it holds.
  - **Submodules** open like folders, onto their own files: listed from the submodule's repository, with its pending changes and its own last-modified details (and any submodules inside it, which open the same way). They're listed when you first open them, and *Expand All* leaves them closed. Inside one, *View History*, *Ignore* (its `.gitignore`), *Delete…* and *Add Submodule…* act on the submodule's repository, and double-clicking a changed file opens the submodule as the repository, at its Pending Changes. Right-click the submodule itself for *Open Submodule as Repository*. One that hasn't been checked out shows as *Submodule (not checked out)*, with nothing inside.
  - **Type:** what each entry is: *Folder*, *Submodule* (with its own icon), *Repository (not a submodule)* for a repository inside this one that hasn't been added, *Symbolic link*, or the kind of file from its name or extension (*TypeScript*, *PNG image*, *Shell script (executable)*…).
  - **Last modified / Modified by:** when and by whom each file was last changed in a changeset. A folder shows its most recently changed file, and new files show *Not committed*. This takes one pass over the history, made after the tree appears and redone only when HEAD moves.
  - **Opening:** double-click a changed file, or press Enter on it, to open Pending Changes.
  - **Keys:** ↑/↓ move, ←/→ close and open folders, and ⌘F searches file paths (with `*` / `?`) as a flat list.
  - *Expand All* and *Collapse All* do what they say.
  - **Staying up to date:** while the Files view is showing, it checks every few seconds whether files were added or removed, pending changes changed, or HEAD moved (less often in a repository that's slow to list, and not while the window is hidden), and refreshes when they did. *Refresh* (or ⌘R) does it straight away.
  - **Right-click a file:**
    - *Open* uses the default app. *Open With…* lets you pick an application on macOS; Windows shows its own chooser.
    - *View History* opens every changeset that changed the file, newest first and following renames, with the file's diff at each one. ↑/↓ step through them, and double-clicking one shows everything else that changeset changed.
    - *Ignore* adds the file's name (any folder), its extension (`*.ext`) or its exact path (`/path/to/file`) to the repository's `.gitignore`. Git keeps tracking a file that's already in source control until it's removed.
    - *Delete…* asks whether to *Remove from Source Control*, which keeps the file on disk as a new, untracked file, or *Remove from Source Control and Disk*, which also moves it to the Trash. Either way it's a pending change for you to commit. A file that isn't in source control is just moved to the Trash, after asking.
  - **Add Submodule…** is in the right-click menu for a file (the submodule goes in the same folder), a folder (it goes inside) and the empty space below the tree (it goes at the top). It opens a window to choose the repository:
    - *On this computer*: a folder (*Browse…*), or one of the workspace's repositories from the list. `.gitmodules` records the folder's location.
    - *Remote*: a URL. VisualGit fetches its history first (into its cache, removed afterwards), showing git's progress.
    - *Path in this repository*: where it goes, filled in from the repository's name.

    *Choose Changeset…* opens that repository's Branch Explorer in a new window. Its search box (⌘F) works like the main Branch Explorer's: branch names, changeset ids and commit messages, with `*` / `?` wildcards; ↑/↓ browse the results and Enter goes to one. The panel on the right shows the selected changeset or branch, as in the main window, with a *Use This Changeset* button. ←/→ move along a branch, ↑/↓ to the nearest changeset on the lane above or below, and Home goes to the repository's checked-out changeset. Double-click a changeset (or right-click it and choose *Use This Changeset*, use the button, or select it and press Enter) to add the submodule checked out there, and initialised (`git submodule init`), so it's registered in this repository's `.git/config`. It's staged, with `.gitmodules`, for your next commit, and Pending Changes shows which changeset it records.
- **Pending Changes:** what you'd commit, and the commit box (see *Pending Changes* below). A dot next to it in the *View* pane means there are uncommitted changes.

The details panel on the right, for the selected changeset or branch, belongs to the Branch Explorer and only shows there. The Branch Explorer also has its own bar along the top, with *Reload*, the changeset arrows and search. In the Branch List, that bar is replaced by the list's own search. VisualGit remembers which view you were using.

The home symbol marks what's checked out. When you have uncommitted changes, an empty changeset is drawn at the end of the checked-out branch, after its latest changeset, with a hollow, dashed home symbol. A branch you've just created and switched to shows the same hollow home symbol in its empty slot. So does the first branch of a new repository, before its first commit (Git has no ref for it until then). Right-click either one for *Pending Changes*.

**Creating branches.** Right-click any changeset and choose *Create Branch from This Changeset…*. Type a name and choose whether to switch to the new branch. Switching is ticked by default when you start from the checked-out changeset, so any work in progress comes along. The new branch shows up straight away as its own empty lane, starting at that changeset.

**Switching.** Right-click a branch and choose *Switch to This Branch* to move HEAD to its latest changeset. For a remote-only branch, this first creates a local branch that tracks it. For a deleted or unnamed lane, it checks out the lane's last changeset as a detached HEAD. You can also right-click a changeset and choose *Switch to This Changeset*. If it's the tip of a local branch, you switch to that branch (the menu names it). Otherwise the changeset is checked out on its own, as a detached HEAD: create a branch there before committing. If you have pending changes to tracked files, the switch waits: the Pending Changes view opens so you can commit them first. New, untracked files don't block a switch and stay where they are.

**Merging.** Right-click a changeset and choose *Merge from This Changeset…* to see what merging it into the checked-out changeset would do. Nothing changes until you press *Merge*.

- **The window:** shows *From* → *Into*, how many files change, and whether it merges cleanly or has conflicts. Git's own messages are there too, if you want them.
- **The file list:** every file the merge changes, with conflicts listed first.
- **The diff:** each file's merge result next to either *Into* (what you have now) or *From* (what's coming in). ↑/↓ or F7 / ⇧F7 step through the changes.
- **Conflicts:** a conflicted file shows three panes side by side instead.
  - **Source:** what's coming in. **Destination:** what's checked out. Each is coloured where it differs from the other.
  - **Result:** the file as the merge would leave it, without git's conflict markers. Each conflict shows its Destination lines, then its Source lines, in each side's colour. A faint *← Destination* / *← Source* after a side's first line says where it came from, and *nothing from Source* (or Destination) marks a side with no lines. VisualGit keeps track of where each conflict is as you edit.
  - **Resolving:** every conflicted file has to be resolved before *Merge* is allowed. The split button in the diff bar works like *Commit*'s: its main part is *Use Source*, and its ▾ offers:
    - *Use Source:* takes the Source's changes over the Destination's for the conflict at the cursor: the Destination's lines go.
    - *Use Destination:* takes the Destination's changes over the Source's.
    - *Mark as Resolved:* keeps the conflict's lines as they stand, for when you've edited them into what you want.
    - *Reset to Git's Result:* starts the file over.

    A file is resolved once every conflict in it is settled one of those ways. For a conflict where one side deleted the file, there's nothing to choose line by line: take a side's whole file, or mark it resolved to keep the Result. ↑/↓ or F7 / ⇧F7 step from conflict to conflict.
  - **Tracking it:** the file list marks each conflicted file *conflict*, *conflict · edited* or *resolved*, and the summary counts what's left.
  - **Merging:** *Merge* runs `git merge --no-ff`, writes your results over git's, and commits the merge with git's message (`Merge branch 'x' into y`), all in one go. A binary file in conflict can't be resolved here. It doesn't block the merge, but the merge then stops in Pending Changes so you can choose its version there.
  - **Closing:** edits only live in this window until you merge, so closing it asks first.

The preview comes from `git merge-tree`, which computes the merge without touching your files, the index or any branch.

- **Merge:** always makes a merge changeset (`git merge --no-ff`), even when git could fast-forward, and even if `merge.ff` is set otherwise. A fast-forward leaves no trace of the merge, so the merged branch's changesets would move onto the destination's lane and the source branch would look empty. The message is `Merge branch 'x' into y` when you merge a branch's latest changeset, and `Merge changeset abc12345 into y` otherwise.
- **Before merging:** commit or undo pending changes to tracked files first. If there are any, Pending Changes opens.
- **Conflicts:** the merge stops and Pending Changes opens, as for a cherry pick (below).

**Cherry picking.** Right-click a changeset and choose *Cherry Pick This Changeset* to copy its changes onto the checked-out changeset, as a new changeset with the same message.

- **Merge changesets:** these are picked as the change they made to their first parent.
- **Already included:** a changeset that's already part of what's checked out is refused.
- **Pending changes:** if you have any, Pending Changes opens first so you can commit them.
- **Conflicts:** the cherry pick stops and Pending Changes opens. A banner explains what's happening, and git's message is already filled in. Resolve the conflicts and commit, or *Abort* to put everything back. A merge that stops with conflicts works the same way.

**Subtractive merge.** Right-click a changeset that's part of what's checked out and choose *Subtractive Merge* to take its changes back out, as a new "Revert …" changeset (`git revert`). It works like cherry picking, in reverse:

- **Merge changesets:** these are undone relative to their first parent.
- **Pending changes:** if you have any, Pending Changes opens first.
- **Conflicts:** Pending Changes opens with the banner, git's message filled in, and *Abort*.
- **Already taken out:** if the changes have already been taken out, it says so.

Cherry Pick is only offered on changesets that *aren't* part of what's checked out, and Subtractive Merge only on those that are.

**What hasn't been pushed** is shown in orange, as of your last fetch:

- A changeset that no remote-tracking branch contains gets a small up-arrow.
- A branch shows ↑3 when three of its changesets aren't pushed, or *not pushed* if the branch itself has never been pushed. This appears on its lane, in the Branch List and in the details panel.
- The toolbar shows how many changesets are waiting to be pushed in total.

A repository with no remote-tracking branches shows none of this. To push a branch, right-click it (on its lane in the Branch Explorer, or its row in the Branch List) and choose *Push*. This is offered while the branch has changesets to push or has never been pushed. A branch with an upstream goes to it; a new branch is published to `origin` and tracks it from then on.

**Changeset diffs.** Double-click any committed changeset (or right-click it and choose *View Changes*) to open a window showing what it changed.

- **Header:** its message, id, branch, author, date and release.
- **Files:** the files it added, modified, deleted or renamed.
- **Diff:** each file before (in the parent) and after (in the changeset). F7 / ⇧F7, or the arrows in the diff bar, step through the changes. The arrows above the file list, or ↑/↓ when you're not in the editor, move to the previous or next file.
- **Merge changesets:** these can be compared with either parent.

**Branch changes.** Double-click a branch, on its lane or its row in the Branch List, or right-click it and choose *View Changes*, to see everything it changed in one diff. That's from the changeset it was created from to its latest changeset. A root branch such as `main` is compared with nothing, so every file shows as added.

**Comparing two changesets.** Select a changeset, then Ctrl+click (or ⌘+click) another, so both have a halo. Right-click either one and choose *Diff Selected Changesets* to see everything that differs between them, the older one as *before*. Ctrl+click either of the two again to drop it, and a plain click goes back to a single selection.

Using it: drag or scroll to pan, ⌘/Ctrl + scroll (or pinch) to zoom, click a changeset or branch for details.

**Merge arrows.** Right-click a merge arrow (it thickens under the pointer) and choose *Source* to jump to the changeset that was merged, or *Destination* for the merge changeset it went into. The other links between lanes work the same way.

**Pending Changes.** Choose *Pending Changes* in the *View* pane, double-click the hollow home symbol (uncommitted work), or right-click the checked-out changeset or its branch and choose *Pending Changes*. It's a view in the main window, for the open repository:

- **Files** on the left: every changed, new, deleted, renamed or conflicted file, each with a checkbox and labelled *Added*, *Removed*, *Modified*, *Renamed* or *Conflict*. Ticked files go into the next commit.
- **Diff** on the right: the checked-out changeset next to your working copy. An added file has nothing to compare with, so it gets a single pane with its contents (still editable). ↑/↓ in the diff bar (or F7 / ⇧F7) move from change to change, and the arrows between the sides put the committed text back over a change.
- **Editing**: the working-copy side is an editor. ⌘S saves. Edits are also saved when you switch files, commit, go to another view or repository, or close the window. Line endings (LF or CRLF) are kept as they were.
- **Commit** at the top: type a message and press *Commit* (or ⌘↩). The ▾ next to it offers *Commit & Push* (⇧⌘↩), which pushes the checked-out branch after committing. It pushes to the branch's upstream, or, for a branch that has never been pushed, publishes it to `origin` and tracks it from then on. The drop-down also has *Undo Changes…*: after you confirm, the ticked files go back to how they are in the checked-out changeset. New files are moved to the Trash, so they can still be recovered. Only the ticked files are committed, exactly as they are on disk; anything else you had staged stays staged. During a merge, git requires the whole merge to be committed at once.

The view refreshes when the window regains focus (or on ⌘R), and the other views reload after each commit. An unsent commit message is kept per repository while you switch between them. A merge window that stops for conflicts brings the main window forward on this view.

**Search.** The search box in the Branch Explorer's bar (⌘F) looks through branch names, changeset ids and commit messages (the full message, not just the first line), plus release names. Matching ignores case and finds the text anywhere, and two wildcards are supported: `*` matches any run of characters and `?` matches exactly one, so `feat*login` finds `feature/login-page` and `v1.?` finds `v1.2`. A changeset id matches from its start once you've typed four or more hex digits. Matches are highlighted in the explorer and everything else fades back. ↑/↓ steps through the results list, Enter jumps to one, Esc ends the search.

| Key | Action |
| --- | --- |
| `⇧⌘O` / `⌘O` | File › Open Workspace… / Open Repository… |
| `⌘[` / `⌘]` | Previous / next repository in the workspace |
| `⌘R` | Reload, in either view (it also happens when the window regains focus, so terminal commits show up) |
| `←` / `→` | Previous / next changeset along the selected branch (Branch Explorer; also its bar's arrows) |
| `Home` | Go to the checked-out changeset, HEAD (Branch Explorer) |
| Ctrl / ⌘ + click | Select a second changeset, to compare the two (Branch Explorer) |
| `⌘F` | Search: branches, changesets and messages in the Branch Explorer; branch names in the Branch List |
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
| [src-tauri/src/pending.rs](src-tauri/src/pending.rs) | The commands that change things: read and save working-tree files (paths checked to stay inside the repository), commit selected files |
| [src/pending/view.ts](src/pending/view.ts) | Pending Changes view: file list, diff editor ([CodeMirror](https://codemirror.net) merge view), commit box |
| [src/merge/main.ts](src/merge/main.ts), [src-tauri/src/merge.rs](src-tauri/src/merge.rs) | Merge window: previews merging a changeset into the checked-out one (`git merge-tree`), then merges it (`--no-ff`) |
| [src-tauri/src/workspace.rs](src-tauri/src/workspace.rs) | Finds the repositories inside a workspace folder, and creates new ones there |
| [src-tauri/src/hosting.rs](src-tauri/src/hosting.rs) | Where a repository is hosted, from its remote URL, and opening its page there |
| [src-tauri/src/menu.rs](src-tauri/src/menu.rs) | Native menu bar (File › Open Workspace…, Open Repository…) |

The About panel shows the version as major.minor.changeset, using the last 5 characters of the changeset the app was built from (for example `1.0.0bd3f`). It also shows the build date, the author and the copyright. The build stamps in the current `HEAD` ([src-tauri/build.rs](src-tauri/build.rs)). When building without a `.git` folder, set `VISUALGIT_CHANGESET` to provide it. The build date is in UTC; set `SOURCE_DATE_EPOCH` to fix it for a reproducible build.

The model code is plain TypeScript with no Tauri dependency, so it runs under Node in tests and in `npm run inspect`.

## Roadmap

- **Branch metadata ref**: when you create a branch from VisualGit, record `{name, parent, base, created}` under `refs/visualgit/`. It can be pushed and fetched, so everyone sees the same branch tree, not just the machine where the reflog lives.
- Delete branches from the explorer.
- Resolve merge conflicts in the merge window itself.
- Diff viewer for changesets and for "what does this branch change".
- Filters: hide merged/deleted branches, date range, author.
- Performance for very large histories (incremental loading, a WebGL renderer).

### After 1.0

- **Action system:** user-defined actions that run at points in VisualGit's operations, so it can do things Git itself can't while staying independent of any hosting service. The motivating case: creating a repository runs a custom action that creates the repository on the remote (for example a script calling `gh repo create`, `glab`, or a self-hosted server's API), then sets it as `origin`. To work out:
  - **Hooks:** where actions can run, such as after creating, cloning, committing, pushing or creating a branch.
  - **Inputs:** what an action gets, e.g. the repository path, its name, the branch and the remote URL, as environment variables or arguments.
  - **Results:** what it can hand back, e.g. a remote URL to add.
  - **Configuration:** where actions are defined, per workspace or per user, and how they appear in menus.
  - **Trust:** since an action runs a command, VisualGit should show what will run and ask before running a newly added action.

## License

[MIT](LICENSE)
