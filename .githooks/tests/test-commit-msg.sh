#!/usr/bin/env bash
# Test suite for .githooks/commit-msg.
#
# Self-contained: creates a temp git repo per test, stages files via real
# `git add`/`git mv`, writes a commit-message file, invokes the hook, asserts
# exit code and (where relevant) stderr substring. No external dependencies.
#
# Run after editing the hook:  bash .githooks/tests/test-commit-msg.sh
# Exits 0 on all-pass, non-zero on any failure.

set -u

HOOK_PATH="$(cd "$(dirname "$0")/.." && pwd)/commit-msg"
[ -x "$HOOK_PATH" ] || { echo "FAIL: hook not found or not executable at $HOOK_PATH"; exit 2; }

PASS=0
FAIL=0
FAILURES=()

# run_case <name> <expected-exit> <subject> -- <staged paths...>
# Optional: stage real fs operations via inline shell after `--shell:` separator.
run_case() {
  local name="$1" expected_exit="$2" subject="$3"
  shift 3
  # Collect paths until we hit `--shell:` or end-of-args.
  local paths=()
  local shell_cmd=""
  local in_shell=0
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--shell:" ]; then in_shell=1; shift; continue; fi
    if [ "$in_shell" -eq 1 ]; then shell_cmd="$shell_cmd $1"; shift; continue; fi
    paths+=("$1"); shift
  done

  local sandbox; sandbox=$(mktemp -d)
  (
    cd "$sandbox"
    git init -q
    git config user.email t@t
    git config user.name t
    # Always create an initial commit so HEAD exists for diff tooling.
    : > .gitkeep
    git add .gitkeep
    git -c core.hooksPath=/dev/null commit -q -m "init" 2>/dev/null

    # Stage requested paths.
    for p in "${paths[@]}"; do
      mkdir -p "$(dirname "$p")"
      echo placeholder > "$p"
      git add -- "$p" >/dev/null
    done

    # Run any custom shell setup (e.g., git mv for rename detection).
    if [ -n "$shell_cmd" ]; then
      eval "$shell_cmd" >/dev/null 2>&1 || true
    fi

    local msg="$sandbox/msg"
    printf '%s\n' "$subject" > "$msg"
    "$HOOK_PATH" "$msg" >/dev/null 2>&1
    echo $?
  ) > "$sandbox/exit_code"
  local actual; actual=$(tail -n1 "$sandbox/exit_code")
  rm -rf "$sandbox"

  if [ "$actual" = "$expected_exit" ]; then
    PASS=$((PASS+1))
    printf "  PASS [%s]  exit=%s\n" "$name" "$actual"
  else
    FAIL=$((FAIL+1))
    FAILURES+=("$name (expected=$expected_exit got=$actual)")
    printf "  FAIL [%s]  expected=%s got=%s\n" "$name" "$expected_exit" "$actual"
  fi
}

echo "=== Spec §4 acceptance cases ==="
run_case "S1 backend stages ARCHITECTURE.md → reject" 1 "backend(auth): tweak"     "agents/docs/ARCHITECTURE.md"
run_case "S2 backend stages frontend/ → reject"        1 "backend: stuff"           "frontend/src/main.js"
run_case "S3 architect stages backend/ → reject"       1 "architect: doc"           "backend/src/routes/auth.ts"
run_case "S4 backend mv own task → accept"             0 "backend: round-2 fixes"   "agents/docs/tasks/pending/backend-foo.md" "agents/docs/tasks/review/backend-foo.md"
run_case "S5 chore: prefix → skip (accept)"            0 "chore: bump deps"         "anywhere/at/all.txt"
run_case "S6 [skip-zone-audit] → skip (accept)"        0 "backend: cross [skip-zone-audit]" "frontend/src/x.js" "agents/docs/ARCHITECTURE.md"

echo
echo "=== F1 architect bypass + non-architect review→pending block ==="
run_case "F1a architect appends to backend task → accept"      0 "architect: hold block" "agents/docs/tasks/review/backend-foo.md"
run_case "F1b architect appends to ui task → accept"           0 "architect: hold block" "agents/docs/tasks/review/ui-bar.md"
run_case "F1c architect mvs backend task review→pending → accept"  0 \
  "architect: mv backend task" \
  --shell: 'mkdir -p agents/docs/tasks/review agents/docs/tasks/pending; echo x > agents/docs/tasks/review/backend-foo.md; git add agents/docs/tasks/review/backend-foo.md; git -c core.hooksPath=/dev/null commit -q -m precursor; git mv agents/docs/tasks/review/backend-foo.md agents/docs/tasks/pending/backend-foo.md'
run_case "F1d backend cannot mv backend task review→pending → reject" 1 \
  "backend: try to mv task" \
  --shell: 'mkdir -p agents/docs/tasks/review agents/docs/tasks/pending; echo x > agents/docs/tasks/review/backend-foo.md; git add agents/docs/tasks/review/backend-foo.md; git -c core.hooksPath=/dev/null commit -q -m precursor; git mv agents/docs/tasks/review/backend-foo.md agents/docs/tasks/pending/backend-foo.md'
run_case "F1e backend pending→review own task → accept"        0 "backend: ship task" \
  --shell: 'mkdir -p agents/docs/tasks/pending agents/docs/tasks/review; echo x > agents/docs/tasks/pending/backend-foo.md; git add agents/docs/tasks/pending/backend-foo.md; git -c core.hooksPath=/dev/null commit -q -m precursor; git mv agents/docs/tasks/pending/backend-foo.md agents/docs/tasks/review/backend-foo.md'
run_case "F1f backend mv ui task → reject"                     1 "backend: stray" "agents/docs/tasks/review/ui-thing.md"

echo
echo "=== F5 architect root-meta files ==="
run_case "F5a architect stages .gitignore → accept"        0 "architect: ignore tweak" ".gitignore"
run_case "F5b architect stages .dockerignore → accept"     0 "architect: docker meta"  ".dockerignore"
run_case "F5c architect stages .env.example → accept"      0 "architect: env tmpl"     ".env.example"
run_case "F5d architect stages deploy.sh → accept"         0 "architect: deploy tweak" "deploy.sh"
run_case "F5e architect stages LICENSE → accept"           0 "architect: license bump" "LICENSE"

echo
echo "=== F6 set -euo pipefail edge cases ==="
# Comment-only message file: handled via /tmp written with only `#` lines.
COMMENT_TMP=$(mktemp)
printf '# only comment\n# another comment\n' > "$COMMENT_TMP"
"$HOOK_PATH" "$COMMENT_TMP" >/dev/null 2>&1
ec=$?; rm -f "$COMMENT_TMP"
if [ "$ec" = "0" ]; then PASS=$((PASS+1)); printf "  PASS [F6a comment-only msg → exit 0]  exit=%s\n" "$ec"
else FAIL=$((FAIL+1)); FAILURES+=("F6a comment-only msg (expected=0 got=$ec)"); printf "  FAIL [F6a comment-only msg]  got=%s\n" "$ec"; fi

# Empty message file
EMPTY_TMP=$(mktemp); : > "$EMPTY_TMP"
"$HOOK_PATH" "$EMPTY_TMP" >/dev/null 2>&1
ec=$?; rm -f "$EMPTY_TMP"
if [ "$ec" = "0" ]; then PASS=$((PASS+1)); printf "  PASS [F6b empty msg → exit 0]  exit=%s\n" "$ec"
else FAIL=$((FAIL+1)); FAILURES+=("F6b empty msg (expected=0 got=$ec)"); printf "  FAIL [F6b empty msg]  got=%s\n" "$ec"; fi

# Missing message file
"$HOOK_PATH" /nonexistent/path >/dev/null 2>&1
ec=$?
if [ "$ec" = "0" ]; then PASS=$((PASS+1)); printf "  PASS [F6c missing msg file → exit 0]  exit=%s\n" "$ec"
else FAIL=$((FAIL+1)); FAILURES+=("F6c missing msg file (expected=0 got=$ec)"); printf "  FAIL [F6c missing msg file]  got=%s\n" "$ec"; fi

# Empty staged set with valid prefix (no files staged)
SAND2=$(mktemp -d)
(cd "$SAND2" && git init -q && git config user.email t@t && git config user.name t \
  && : > .gitkeep && git add .gitkeep && git -c core.hooksPath=/dev/null commit -q -m init)
M2=$(mktemp); echo "architect: empty" > "$M2"
(cd "$SAND2" && "$HOOK_PATH" "$M2" >/dev/null 2>&1; echo $?) > "$SAND2/ec"
ec=$(tail -n1 "$SAND2/ec"); rm -rf "$SAND2"; rm -f "$M2"
if [ "$ec" = "0" ]; then PASS=$((PASS+1)); printf "  PASS [F6d empty staged set → exit 0]  exit=%s\n" "$ec"
else FAIL=$((FAIL+1)); FAILURES+=("F6d empty staged (expected=0 got=$ec)"); printf "  FAIL [F6d empty staged]  got=%s\n" "$ec"; fi

echo
echo "=== F18 parenthetical-scope variants ==="
run_case "F18a backend(auth) stages backend/ → accept"     0 "backend(auth): login" "backend/src/routes/auth.ts"
run_case "F18b architect(compound) stages backend/ → reject" 1 "architect(compound): note" "backend/src/foo.ts"

echo
echo "=== Other coverage ==="
run_case "T9 ui stages frontend/ → accept"                 0 "ui: tweak"             "frontend/src/main.js"
run_case "T10 pinner stages pinner/ → accept"              0 "pinner: gc fix"        "pinner/foo.go"
run_case "T11 architect stages root CLAUDE.md → accept"    0 "architect: tweak"      "CLAUDE.md"
run_case "T12 architect stages backend CLAUDE.md → accept" 0 "architect: per-agent"  "agents/backend/CLAUDE.md"
run_case "T13 architect stages .githooks → accept"         0 "architect: hook"       ".githooks/commit-msg"
run_case "T14 architect mv own task → accept"              0 "architect: archive"    "agents/docs/tasks/review/architect-foo.md"
run_case "T15 Merge prefix → skip"                         0 "Merge pull request #123" "anywhere/whatever.txt"
run_case "T16 capitalized Architect: → skip (unrecognized)" 0 "Architect: bad case"  "anywhere/x.txt"
run_case "T17 fix(backend): → skip (conventional-commit form not supported)" 0 "fix(backend): wrap" "frontend/src/x.js"

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
