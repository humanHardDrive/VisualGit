#!/usr/bin/env bash
# Creates a demo repository that exercises every branch-explorer case:
# empty branches, stacked branches, merges both ways, a deleted-but-merged
# branch, a fast-forward, and tags.
#
#   scripts/make-demo-repo.sh /tmp/visualgit-demo
set -euo pipefail

dir="${1:?usage: make-demo-repo.sh <new-directory>}"
if [ -e "$dir" ]; then
  echo "refusing to overwrite existing path: $dir" >&2
  exit 1
fi

t=1767225600 # 2026-01-01, advanced one hour per git call for a readable timeline
g() {
  GIT_AUTHOR_DATE="@$t +0000" GIT_COMMITTER_DATE="@$t +0000" git -C "$dir" "$@"
  t=$((t + 3600))
}
c() { g commit -q --allow-empty -m "$1"; }

mkdir -p "$dir"
git -C "$dir" init -q -b main
git -C "$dir" config user.name "Demo"
git -C "$dir" config user.email "demo@example.com"

c "Initial project skeleton"
c "Add build scripts"
g tag v0.1
g branch release/0.x        # empty branch: still gets its own lane
c "Add settings screen"

g checkout -q -b feature/login
c "Login form"
c "Validate credentials"
g checkout -q -b feature/login-oauth   # stacked on feature/login
c "OAuth provider list"
g checkout -q feature/login
c "Remember me checkbox"

g checkout -q main
c "Fix crash on startup"
g checkout -q feature/login
g merge -q --no-ff main -m "Merge branch 'main' into feature/login"
c "Polish login errors"
g checkout -q main
g merge -q --no-ff feature/login -m "Merge branch 'feature/login'"
g tag v0.2

g checkout -q -b bugfix/typo
c "Fix typo in About dialog"
g checkout -q main
g merge -q --no-ff bugfix/typo -m "Merge branch 'bugfix/typo'"
g branch -q -D bugfix/typo   # deleted after merge: recovered from the merge message

g checkout -q -b quick-fix
c "Bump version"
g checkout -q main
g merge -q --ff-only quick-fix  # fast-forward: work lands on main
g branch -q -d quick-fix

g checkout -q feature/login-oauth
c "GitHub sign-in"
c "Token refresh"
g branch experiment/spike    # another empty branch, created from a feature branch

g checkout -q main
c "Update dependencies"
g checkout -q -b task/1234-dark-mode
g checkout -q main
c "Release notes for 0.3"

echo "Demo repository created at $dir"
