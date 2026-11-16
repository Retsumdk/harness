#!/usr/bin/env bash
# Fails if a source file exists on disk but would be left out of the commit, either
# because a .gitignore pattern swallows it or because it was never added.
# The failure this exists for: `.gitignore` held `demo/` for the built bundle, which
# also matched `src/demo/` — five sources silently never reached the repo, so a clean
# clone failed typecheck and two tests. Nothing local noticed; only a clone did.
#
# usage: bash bin/commit-check.sh [roots...]   (default: src tests scripts docs bin .github)

set -uo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "commit-check: not inside a git work tree"
  exit 2
fi

roots=("$@")
if [ ${#roots[@]} -eq 0 ]; then
  roots=(src tests scripts docs bin .github)
fi

ignored=()
untracked=()
total=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  total=$((total + 1))
  if git check-ignore -q "$f"; then
    ignored+=("$f")
  fi
  if ! git ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then
    untracked+=("$f")
  fi
done < <(find "${roots[@]}" -type f 2>/dev/null | sort)

if [ ${#ignored[@]} -gt 0 ]; then
  echo "commit-check: source files are gitignored and will not be committed:"
  printf '  %s\n' "${ignored[@]}"
fi
if [ ${#untracked[@]} -gt 0 ]; then
  echo "commit-check: source files are not tracked:"
  printf '  %s\n' "${untracked[@]}"
fi
if [ $((${#ignored[@]} + ${#untracked[@]})) -gt 0 ]; then
  echo "RESULT: FAIL"
  exit 1
fi

echo "RESULT: PASS ($total source files tracked)"
