#!/usr/bin/env bash
# Test suite for .githooks/pre-commit (the comment-anchor diff gate).
#
# Self-contained: a fresh temp git repo per case, real `git add`/`git commit` to
# build the staged diff, then the hook is invoked with CWD = sandbox so its
# `git diff --cached` sees that index. Asserts exit code (0 accept / 1 reject).
# No external dependencies.
#
# Run after editing the hook:  bash .githooks/tests/test-pre-commit.sh
# Exits 0 on all-pass, non-zero on any failure.

set -u

HOOK_PATH="$(cd "$(dirname "$0")/.." && pwd)/pre-commit"
[ -x "$HOOK_PATH" ] || { echo "FAIL: hook not found or not executable at $HOOK_PATH"; exit 2; }

PASS=0
FAIL=0
FAILURES=()

# run_case <name> <expected-exit> <env-prefix> <setup-snippet>
#   setup-snippet runs inside a fresh sandbox repo (an initial commit already
#   exists) and must stage whatever it wants the hook to see.
#   env-prefix is passed to `env` before the hook (e.g. "PEVO_ANCHOR_GATE=off"
#   or "" for none).
run_case() {
  local name="$1" expected="$2" envp="$3" setup="$4"
  local sandbox; sandbox=$(mktemp -d)
  (
    cd "$sandbox"
    git init -q
    git config user.email t@t
    git config user.name t
    : > .gitkeep
    git add .gitkeep
    git -c core.hooksPath=/dev/null commit -q -m init
    eval "$setup" >/dev/null 2>&1
    # shellcheck disable=SC2086
    env $envp "$HOOK_PATH" >/dev/null 2>&1
    echo $?
  ) > "$sandbox/ec"
  local actual; actual=$(tail -n1 "$sandbox/ec")
  rm -rf "$sandbox"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS+1))
    printf "  PASS [%s]  exit=%s\n" "$name" "$actual"
  else
    FAIL=$((FAIL+1))
    FAILURES+=("$name (expected=$expected got=$actual)")
    printf "  FAIL [%s]  expected=%s got=%s\n" "$name" "$expected" "$actual"
  fi
}

echo "=== Rot forms in scope → reject (exit 1) ==="
run_case "R1 lowercase slug in backend/tests" 1 "" \
  'mkdir -p backend/tests; printf "// fixed per backend-foo-bar (since archived)\n" > backend/tests/a.test.ts; git add backend/tests/a.test.ts'
run_case "R2 round-N hold in frontend/src" 1 "" \
  'mkdir -p frontend/src; printf "// round-2 hold #6 contract\n" > frontend/src/a.js; git add frontend/src/a.js'
run_case "R3 line-cite .ts:NNN in backend/src" 1 "" \
  'mkdir -p backend/src; printf "// see hafsql.ts:371 for the loop\n" > backend/src/a.ts; git add backend/src/a.ts'
run_case "R4 SEC-NNN-X slug in backend/tests" 1 "" \
  "mkdir -p backend/tests; printf \"describe('SEC-004-BE: x', () => {});\n\" > backend/tests/a.test.ts; git add backend/tests/a.test.ts"
run_case "R5 BE- shout slug in backend/tests" 1 "" \
  'mkdir -p backend/tests; printf "// BE-AUTH-SMTP-STATUS-CODE-ORACLE guard\n" > backend/tests/a.test.ts; git add backend/tests/a.test.ts'
run_case "R6 JFR-001 single-segment in frontend/src" 1 "" \
  'mkdir -p frontend/src; printf "// search.js JFR-001 race guard\n" > frontend/src/a.js; git add frontend/src/a.js'
run_case "R7 bridge.js L66 line-form in frontend/tests" 1 "" \
  'mkdir -p frontend/tests; printf "// see bridge.js L66 for the lock\n" > frontend/tests/a.spec.js; git add frontend/tests/a.spec.js'
run_case "R8 tasks-archive redirect" 1 "" \
  'mkdir -p frontend/tests; printf "// resolved in tasks-archive under that slug\n" > frontend/tests/a.test.js; git add frontend/tests/a.test.js'
run_case "R9 AC #N acceptance cite" 1 "" \
  'mkdir -p backend/tests; printf "// per AC #3 replay is single-use\n" > backend/tests/a.test.ts; git add backend/tests/a.test.ts'
run_case "R10 Option X.N label" 1 "" \
  'mkdir -p backend/src; printf "// Option A.1 design alternative\n" > backend/src/a.ts; git add backend/src/a.ts'
run_case "R11 lines NNN-NNN reference" 1 "" \
  'mkdir -p backend/src; printf "// see lines 555-560 of the handler\n" > backend/src/a.ts; git add backend/src/a.ts'
run_case "R12 see task ITEM N redirect" 1 "" \
  'mkdir -p frontend/src; printf "// See task ITEM 3 for the contract\n" > frontend/src/a.js; git add frontend/src/a.js'

echo
echo "=== Legitimate / out-of-scope → accept (exit 0) ==="
run_case "A1 crypto + SQL + base58 + latency tokens" 0 "" \
  'mkdir -p backend/src; printf "// SHA-256 AES-256-GCM HMAC-SHA512 ISO-8601 CASE-WHEN LIMIT-1 SET-NX\n// base58 class [1-9A-HJ-NP-Za-km-z]; ~50ms; ~28,800 blocks; ~3.5 days\n" > backend/src/a.ts; git add backend/src/a.ts'
run_case "A2 URL host:port (no source-ext path)" 0 "" \
  'mkdir -p frontend/src; printf "await fetch(\"http://localhost:3001/api/health\");\n" > frontend/src/a.js; git add frontend/src/a.js'
run_case "A3 prose: first 3 lines / optional / next round / L2 cache" 0 "" \
  'mkdir -p backend/src; printf "// the first 3 lines of output; an optional value; the next round of work; L1/L2 cache\n" > backend/src/a.ts; git add backend/src/a.ts'
run_case "A4 bare SEC-NNN security-requirement IDs" 0 "" \
  'mkdir -p backend/src; printf "// security requirement SEC-001 and SEC-004 header IDs; E2E-AUTH-2 matrix\n" > backend/src/a.ts; git add backend/src/a.ts'
run_case "A5 single-segment slug-shaped token (ui-button)" 0 "" \
  'mkdir -p frontend/src; printf "// the ui-button component class\n" > frontend/src/a.js; git add frontend/src/a.js'
run_case "A6 durable-path slug reference (solutions/)" 0 "" \
  'mkdir -p backend/src; printf "// see agents/docs/solutions/conventions/backend-foo-bar-2026-01-01.md\n" > backend/src/a.ts; git add backend/src/a.ts'
run_case "A7 per-line anchor-allow exemption" 0 "" \
  'mkdir -p backend/tests; printf "// fixture string see auth.ts:401 — anchor-allow\n" > backend/tests/a.test.ts; git add backend/tests/a.test.ts'
run_case "A8 see task queue (not a redirect)" 0 "" \
  'mkdir -p backend/src; printf "// see task queue runner and scheduler\n" > backend/src/a.ts; git add backend/src/a.ts'
run_case "A9 out-of-scope dir (scripts/)" 0 "" \
  'mkdir -p scripts; printf "// fixed per backend-foo-bar archived\n" > scripts/a.js; git add scripts/a.js'
run_case "A10 in-scope dir but non-source ext (.md)" 0 "" \
  'mkdir -p backend/src; printf "fixed per backend-foo-bar archived\n" > backend/src/a.md; git add backend/src/a.md'
run_case "A11 empty staged set" 0 "" \
  'true'

echo
echo "=== Diff-gate semantics ==="
# Removing an existing rot line is a deletion (a `-` line), not an addition, so
# the gate must NOT fire — it only flags rot that the diff ADDS.
run_case "D1 deleting a rot line → accept" 0 "" \
  'mkdir -p backend/src; printf "const x=1;\n// see auth.ts:401\nconst y=2;\n" > backend/src/a.ts; git add backend/src/a.ts; git -c core.hooksPath=/dev/null commit -q -m base; printf "const x=1;\nconst y=2;\n" > backend/src/a.ts; git add backend/src/a.ts'
# Adding a CLEAN line to a file that already contains pre-existing rot must NOT
# fire (only the added line is judged, and it is clean).
run_case "D2 adding a clean line beside pre-existing rot → accept" 0 "" \
  'mkdir -p backend/tests; printf "// pre-existing see auth.ts:401 rot\nconst a=1;\n" > backend/tests/a.test.ts; git add backend/tests/a.test.ts; git -c core.hooksPath=/dev/null commit -q -m base; printf "// pre-existing see auth.ts:401 rot\nconst a=1;\nconst b=2; // clean addition\n" > backend/tests/a.test.ts; git add backend/tests/a.test.ts'

echo
echo "=== Skip mechanism ==="
run_case "S1 PEVO_ANCHOR_GATE=off bypasses a real violation" 0 "PEVO_ANCHOR_GATE=off" \
  'mkdir -p backend/tests; printf "// fixed per backend-foo-bar archived\n" > backend/tests/a.test.ts; git add backend/tests/a.test.ts'

echo
echo "=== Summary ==="
echo "  passed: $PASS"
echo "  failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo
  echo "  Failures:"
  for f in "${FAILURES[@]}"; do echo "    - $f"; done
  exit 1
fi
exit 0
