#!/usr/bin/env bash
# check-bridge-paper-discipline.sh
#
# Lint discipline tripwire (NOT an adversarial security boundary): catches
# accidental drift toward direct `bridge_paper` literal use, surfaced at
# `npm run lint` time. Mechanical pipeline integration (AST-based discipline
# rule) is the structural follow-up — filed as
# `agents/docs/tasks/.../backend-discipline-guard-pipeline-integration.md`.
#
# Enforces the convention documented in
#   agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md
# and its meta-rule
#   agents/docs/solutions/conventions/enumerated-exemption-lists-are-drift-vectors-2026-04-28.md
#
# Rule: any expression that branches on the literal `bridge_paper` (single-,
# double-, OR backtick-quoted) in backend/src/ MUST go through the
# validPevoPaperWhere() SQL helper or the isPevoBridgePaper(meta, author) JS
# helper. Direct literals are forbidden outside a small allowlist of canonical
# identity-bound files.
#
# Allowlist (must already enforce author-pinning at the file/line level):
#   - backend/src/hafsql.ts          The helper itself + its JSDoc.
#   - backend/src/helpers.ts          isPevoBridgePaper(meta, author) helper.
#   - backend/src/types/hive.ts       The TypeScript type literal
#                                     (`type: "bridge_paper"` — double-quoted).
#   - backend/src/bridge.ts           Bridge-paper construction for broadcast
#                                     (line 499 area, hardcoded by the bridge
#                                     account, not a query filter).
#
# Quote-form coverage: the grep matches single-quoted, double-quoted, AND
# backtick-quoted `bridge_paper` literals. Without all three forms, an attacker
# could rewrite `'bridge_paper'` → `"bridge_paper"` and slip past the guard
# while still branching on the same metadata claim. The convention ("any direct
# literal branching") is quote-agnostic; the guard must be too.
#
# Concatenation bypass forms like `'bridge_' + 'paper'` are NOT detected by
# this grep — they are out of scope for a regex-based guard. The discipline
# is a tripwire for accidental drift, not an adversarial sandbox.
#
# Files NOT in the allowlist that mention `bridge_paper` in any of the three
# quote forms (single-quoted, double-quoted, or backtick-quoted, per the
# round-3 grep extension) are violations; the script exits 1.
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

# Run from the backend directory regardless of caller's cwd. A test-only env
# override (`BRIDGE_PAPER_DISCIPLINE_ROOT`) is honored so the negative-coverage
# tests in `tests/scripts/check-bridge-paper-discipline.test.ts` can drive the
# script against an `os.tmpdir()` scratch root without leaking `bridge_paper`
# artifacts into `backend/src/` (a SIGKILL there would break subsequent
# `npm run lint`). The override is unset in normal usage; production CI always
# scans `backend/src/`.
if [ -n "${BRIDGE_PAPER_DISCIPLINE_ROOT:-}" ]; then
  cd "$BRIDGE_PAPER_DISCIPLINE_ROOT"
else
  cd "$(dirname "$0")/.."
fi

ALLOWLIST=(
  "src/hafsql.ts"
  "src/helpers.ts"
  "src/types/hive.ts"
  "src/bridge.ts"
)

# Build a `grep -v` filter from the allowlist. Escape `.` characters in each
# path so the dots are treated as literal periods in the regex below, not
# wildcards. Without escaping, `src/hafsql.ts` (regex) would match any path
# matching `src/hafsqlXts` byte-for-byte. The trailing `:` in the grep pattern
# combined with the `*.ts` glob saves us from false negatives in practice, but
# being explicit prevents drift.
filter_pattern=""
for path in "${ALLOWLIST[@]}"; do
  escaped="${path//./\\.}"
  if [ -z "$filter_pattern" ]; then
    filter_pattern="$escaped"
  else
    filter_pattern="${filter_pattern}|${escaped}"
  fi
done

# Find single-, double-, OR backtick-quoted bridge_paper literals in
# backend/src/. Use grep -E to match all three quote forms in one pass.
# JSDoc examples that quote the literal (in any form) inside an allowlisted
# file are accepted; allowlisted files cover their own commentary by entry.
#
# A path-allowlisted scratch dir (`src/__discipline_test_scratch__/`) used to
# live under src/ for negative-coverage tests; it has been moved to os.tmpdir()
# (see tests/scripts/check-bridge-paper-discipline.test.ts) so SIGKILL leaks
# can no longer pollute the live src/ tree.
matches=$(grep -rEn --include="*.ts" "('bridge_paper'|\"bridge_paper\"|\`bridge_paper\`)" src/ 2>/dev/null | grep -Ev "^(${filter_pattern}):" || true)

if [ -n "$matches" ]; then
  echo "ERROR: bridge-paper discipline violation."
  echo ""
  echo "Direct bridge_paper literals (single-, double-, or backtick-quoted)"
  echo "are forbidden outside the allowlist. Use validPevoPaperWhere() (SQL)"
  echo "or isPevoBridgePaper(meta, author) (JS) instead. See:"
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
