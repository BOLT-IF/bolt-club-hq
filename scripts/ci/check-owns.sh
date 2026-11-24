#!/usr/bin/env bash
# Owns-path check (docs/STORIES.md, Definition of done and DP framing).
#
# Usage: check-owns.sh <stories.md> <story-id> <changed-files.txt>
#
# Reads the story's "**Owns:**" list from the stories file, then fails if any
# changed path falls outside it. A story whose Owns is "the whole repo" is unrestricted.
#
# Shared allow-list: every story may touch docs/DECISIONS.md (the additive ambiguity log,
# AGENTS.md rule 4), its area doc under docs/areas/ (DoD 6) and its Playwright spec under
# tests/e2e/ (DECISIONS 2026-11-24). Anything else needs its own Owns entry.
#
# Exit codes: 0 pass, 1 out-of-scope path found, 2 usage or unknown story.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: check-owns.sh <stories.md> <story-id> <changed-files.txt>" >&2
  exit 2
fi
STORIES="$1"
STORY="$2"
CHANGED="$3"

SHARED_ALLOW=("docs/DECISIONS.md" "docs/areas/" "tests/e2e/")

# Pull the **Owns:** line that belongs to the "### <story-id> " heading.
owns_line="$(awk -v head="### $STORY " '
  index($0, head) == 1 { inside = 1; next }
  inside && /^### / { inside = 0 }
  inside && /\*\*Owns:\*\*/ { print; exit }
' "$STORIES")"

if [ -z "$owns_line" ]; then
  echo "check-owns: no **Owns:** entry for story '$STORY' in $STORIES" >&2
  exit 2
fi

owns_text="${owns_line#*\*\*Owns:\*\*}"

if printf '%s' "$owns_text" | grep -q "the whole repo"; then
  echo "check-owns: story $STORY owns the whole repo; no path restriction."
  exit 0
fi

# Backtick-quoted paths are the Owns entries. Trailing "/" means a folder prefix.
owns_paths=()
while IFS= read -r p; do
  [ -n "$p" ] && owns_paths+=("$p")
done < <(printf '%s' "$owns_text" | grep -o '`[^`]*`' | tr -d '`')

if [ "${#owns_paths[@]}" -eq 0 ]; then
  echo "check-owns: story $STORY has an Owns entry with no paths." >&2
  exit 2
fi

allowed() {
  local path="$1" entry
  for entry in "${owns_paths[@]}" "${SHARED_ALLOW[@]}"; do
    case "$entry" in
      */) case "$path" in "$entry"*) return 0 ;; esac ;;
      # Trailing "*" (e.g. `src/worker/rsvp/close*`) is a prefix: close.ts, close/x.ts, close.test.ts.
      *\*) case "$path" in "${entry%\*}"*) return 0 ;; esac ;;
      *) [ "$path" = "$entry" ] && return 0 ;;
    esac
  done
  return 1
}

violations=()
while IFS= read -r file; do
  [ -z "$file" ] && continue
  if ! allowed "$file"; then
    violations+=("$file")
  fi
done < "$CHANGED"

if [ "${#violations[@]}" -gt 0 ]; then
  echo "check-owns: story $STORY changed paths outside its Owns list:" >&2
  for v in "${violations[@]}"; do echo "  - $v" >&2; done
  echo "Owns: ${owns_paths[*]}" >&2
  echo "Need a contract-change PR, or a new Owns entry agreed with the integrator." >&2
  exit 1
fi

echo "check-owns: story $STORY stays within its Owns list (${#owns_paths[@]} entries)."
