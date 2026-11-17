#!/usr/bin/env bash
# Print the release note for the tag checked out in the current directory.
#
#   .github/scripts/release-notes.sh <owner/repo>   (needs GH_TOKEN, fetch-depth 2)
#
# A release body of nothing but install instructions says nothing about what
# is being installed. The PR that produced the tag already says it, in prose,
# so take that rather than asking anyone to write the same thing twice.
set -uo pipefail
repo="$1"

# The tag sits on the "chore: bump version" commit whose parent is the squash
# merge carrying the PR. Try the tag's own commit first so a hand-cut tag still
# works, then fall back to the parent.
body=""
for sha in "$(git rev-parse HEAD)" "$(git rev-parse HEAD^ 2>/dev/null)"; do
  if [ -n "$sha" ]; then
    body=$(gh api "repos/$repo/commits/$sha/pulls" --jq '.[0].body // ""' 2>/dev/null)
    if [ -n "$body" ]; then break; fi
  fi
done

# The PR template's guidance lives in HTML comments that span several lines
# each, so they are stripped as blocks before anything else — matching per
# line would leak the middle of every one.
body=$(printf '%s\n' "$body" | awk '
  {
    line = $0; out = ""
    while (1) {
      if (in_comment) {
        p = index(line, "-->")
        if (p == 0) { line = ""; break }
        line = substr(line, p + 3); in_comment = 0
      } else {
        p = index(line, "<!--")
        if (p == 0) { out = out line; break }
        out = out substr(line, 1, p - 1)
        line = substr(line, p + 4); in_comment = 1
      }
    }
    print out
  }
')

# Everything under a heading, up to the next one.
section() {
  printf '%s\n' "$body" | awk -v want="$1" '
    /^## / { keep = (substr($0, 4) == want); next }
    keep { print }
  '
}
# "Release note" is the section the PR template asks for; the other two are
# what a PR opens with when nobody filled it in.
note=$(section "Release note")
if [ -z "${note//[[:space:]]/}" ]; then note=$(section "Summary"); fi
if [ -z "${note//[[:space:]]/}" ]; then note=$(section "What does this PR do?"); fi

if [ -n "${note//[[:space:]]/}" ]; then
  printf '%s\n' "$note"
else
  # No usable section: say so plainly rather than shipping a release that
  # silently looks like it contains nothing.
  echo "See the commit history for what changed in this release."
fi
# Blank line first: the note usually ends in a bullet, and Markdown lazy
# continuation would otherwise fold the install note's first line into it.
echo
cat "$(dirname "$0")/../release-install-note.md"
