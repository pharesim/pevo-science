#!/usr/bin/env bash
# check-bridge-paper-discipline.sh
#
# Enforces the convention documented in
#   agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md
# and its meta-rule
#   agents/docs/solutions/conventions/enumerated-exemption-lists-are-drift-vectors-2026-04-28.md
#
# Rule: any expression that branches on the literal 'bridge_paper' (single-quoted)
# in backend/src/ MUST go through the validPevoPaperWhere() SQL helper or the
# isPevoBridgePaper(meta, author) JS helper. Direct literals are forbidden
# outside a small allowlist of canonical identity-bound files.
#
# Allowlist (must already enforce author-pinning at the file/line level):
#   - backend/src/hafsql.ts          The helper itself + its JSDoc.
#   - backend/src/helpers.ts          isPevoBridgePaper(meta, author) helper.
#   - backend/src/types/hive.ts       The TypeScript type literal.
#   - backend/src/bridge.ts           Bridge-paper construction for broadcast
#                                     (line 499 area, hardcoded by the bridge
#                                     account, not a query filter).
#
# Files NOT in the allowlist that mention 'bridge_paper' (single-quoted) are
# violations; the script exits 1.
#
# Test files under backend/tests/ are exempt by virtue of this script's
# search root being src/ only; canary tests under backend/tests/ that assert
# SQL shape (e.g. tests/routes/bridge-paper-author-gate.test.ts and
# tests/hafsql.test.ts) naturally include the literal and are not scanned.
#
# Exit codes:
#   0  no violations
#   1  one or more violations found

set -euo pipefail

# Run from the backend directory regardless of caller's cwd.
cd "$(dirname "$0")/.."

ALLOWLIST=(
  "src/hafsql.ts"
  "src/helpers.ts"
  "src/types/hive.ts"
  "src/bridge.ts"
)

# Build a `grep -v` filter from the allowlist.
filter_pattern=""
for path in "${ALLOWLIST[@]}"; do
  if [ -z "$filter_pattern" ]; then
    filter_pattern="$path"
  else
    filter_pattern="${filter_pattern}|${path}"
  fi
done

# Find single-quoted 'bridge_paper' literals in backend/src/. Use grep -E with
# the allowlist filter. The literal we look for is "'bridge_paper'" — quote-
# escaped — so JSDoc backtick examples (`type = 'bridge_paper'` inside a
# comment block) DO match if they include the single quotes; the convention
# doc explicitly lists hafsql.ts as allowlisted to cover its own JSDoc.
matches=$(grep -rn --include="*.ts" "'bridge_paper'" src/ 2>/dev/null | grep -Ev "^(${filter_pattern}):" || true)

if [ -n "$matches" ]; then
  echo "ERROR: bridge-paper discipline violation."
  echo ""
  echo "Direct 'bridge_paper' literals are forbidden outside the allowlist."
  echo "Use validPevoPaperWhere() (SQL) or isPevoBridgePaper(meta, author) (JS)"
  echo "instead. See:"
  echo "  agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md"
  echo ""
  echo "Violations:"
  echo "$matches"
  echo ""
  echo "Allowlist (canonical identity-bound files):"
  for path in "${ALLOWLIST[@]}"; do
    echo "  - $path"
  done
  exit 1
fi

echo "bridge-paper discipline OK (no direct literals outside allowlist)"
exit 0
