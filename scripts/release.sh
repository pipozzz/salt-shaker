#!/usr/bin/env bash
# Cuts a release: npm run release -- X.Y.Z
#
#   1. Write the notes first, at the top of CHANGELOG.md, under "## X.Y.Z" (or "## Unreleased",
#      which gets renamed). They may stay uncommitted on main.
#   2. The script puts the notes and the version bump on a release/X.Y.Z branch, opens the
#      "Release X.Y.Z" pull request, waits for its required checks and squash-merges it.
#   3. It tags the merge commit vX.Y.Z and creates the GitHub release with the same notes;
#      the tag's CI run publishes ghcr.io images :X.Y.Z and :X.Y.
#
# main is protected, so the release goes through a pull request like any change. If a step
# fails or you stop it, run the same command again: it picks up where it left off.
set -euo pipefail

die() { echo "release: $*" >&2; exit 1; }
step() { echo "==> $*"; }

[ $# -eq 1 ] || die "usage: npm run release -- X.Y.Z"
version=$1
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "'$version' isn't X.Y.Z"
tag=v$version
branch=release/$version
title="Release $version"

cd "$(git rev-parse --show-toplevel)"
gh auth status >/dev/null 2>&1 || die "gh isn't signed in (gh auth login)"
git fetch -q --tags origin

# The notes for $version from a CHANGELOG.md, without the heading and surrounding blank lines.
notes_of() {
  awk -v v="$version" '
    /^## / { if (found) exit; found = ($2 == v); next }
    found { print }
  ' "$1" | awk 'NF { started = 1 } started' | awk '{ lines[NR] = $0 } NF { last = NR } END { for (i = 1; i <= last; i++) print lines[i] }'
}

if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null; then
  gh release view "$tag" >/dev/null 2>&1 && die "$tag is already released"
fi

pr=$(gh pr list --state all --head "$branch" --json number,state --jq '[.[] | select(.state != "CLOSED")][0].number // empty')

# 1. The release pull request
if [ -z "$pr" ]; then
  [ "$(git branch --show-current)" = main ] || die "switch to main first"
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main isn't at origin/main (git pull --ff-only)"
  [ -z "$(git status --porcelain -- . ':!CHANGELOG.md')" ] || die "commit or stash your changes first; only CHANGELOG.md may be uncommitted"
  current=$(node -p 'require("./package.json").version')
  node -e '
    const [a, b] = process.argv.slice(1).map(v => v.split(".").map(Number))
    const diff = a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
    process.exit(diff > 0 ? 0 : 1)
  ' "$version" "$current" || die "$version isn't newer than $current"

  top=$(awk '/^## / { print $2; exit }' CHANGELOG.md)
  if [ "$top" = Unreleased ]; then
    awk -v v="$version" '!done && /^## Unreleased/ { print "## " v; done = 1; next } { print }' CHANGELOG.md > CHANGELOG.md.tmp
    mv CHANGELOG.md.tmp CHANGELOG.md
  elif [ "$top" != "$version" ]; then
    die "write the notes at the top of CHANGELOG.md under '## $version' (or '## Unreleased') first"
  fi
  [ -n "$(notes_of CHANGELOG.md)" ] || die "the '## $version' section of CHANGELOG.md is empty"

  step "Branch $branch with the notes and version $version"
  git switch -q -c "$branch"
  npm version "$version" --no-git-tag-version >/dev/null
  git add CHANGELOG.md package.json package-lock.json
  git commit -q -m "$title"
  git push -q -u origin "$branch"
  notes_of CHANGELOG.md | gh pr create --base main --head "$branch" --title "$title" --body-file - >/dev/null
  git switch -q main
  pr=$(gh pr view "$branch" --json number --jq .number)
  echo "    $(gh pr view "$pr" --json url --jq .url)"
fi

# 2. Merge it once the required checks pass
if [ "$(gh pr view "$pr" --json state --jq .state)" = OPEN ]; then
  head=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
  step "Waiting for the checks on #$pr"
  sleep 10 # the checks need a moment to register after a push
  gh pr checks "$pr" --watch --required --fail-fast --interval 20 >/dev/null || die "a check failed on #$pr; fix it on $branch and run this again"
  step "Squash-merging #$pr"
  # pinned to the commit that passed, so nothing pushed meanwhile slips in
  gh pr merge "$pr" --squash --delete-branch --match-head-commit "$head" >/dev/null
fi

merge=$(gh pr view "$pr" --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')
[ -n "$merge" ] || die "#$pr isn't merged"
git fetch -q origin main
git merge-base --is-ancestor "$merge" origin/main || die "the merge commit $merge isn't on main"
[ "$(git show "$merge:package.json" | node -p 'JSON.parse(require("fs").readFileSync(0)).version')" = "$version" ] \
  || die "package.json at $merge isn't $version"
if [ "$(git branch --show-current)" = main ] && [ -z "$(git status --porcelain)" ]; then
  git merge -q --ff-only origin/main
fi

# 3. Tag the merge commit and publish the release
notes=$(mktemp)
trap 'rm -f "$notes"' EXIT
git show "$merge:CHANGELOG.md" > "$notes.changelog"
notes_of "$notes.changelog" > "$notes"
rm -f "$notes.changelog"

if ! git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null; then
  step "Tagging $tag on $(git rev-parse --short "$merge")"
  git tag -a "$tag" -m "$title" "$merge"
  git push -q origin "$tag"
fi
step "GitHub release $version"
gh release create "$tag" --verify-tag --title "$version" --notes-file "$notes"

echo "Done. The images are published by the tag's CI run:"
echo "    gh run watch \$(gh run list --workflow ci.yml --branch $tag --limit 1 --json databaseId --jq '.[0].databaseId')"
