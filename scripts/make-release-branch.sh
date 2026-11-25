#!/usr/bin/env bash
# Builds a branch "release" with ONE commit of the current tree and no history, for the first push to a new (private) remote.
# The old history contains owner-specific files (earlier seeds, memory notes, screenshots of the test instance) that the current tree no longer has.
#   scripts/make-release-branch.sh && git push <remote> release:main
set -euo pipefail
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain)" ] || { echo "commit or stash your changes first"; exit 1; }
cur="$(git rev-parse --abbrev-ref HEAD)"
git checkout --orphan release
git add -A
git -c user.name=mesimot -c user.email=mesimot@localhost commit -q -m "Mesimot: initial release"
git checkout -q "$cur"
echo "branch 'release' created (one commit). Push it with: git push <remote> release:main"
