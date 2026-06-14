---
title: "bash `set -e` is suppressed inside a function called in a tested context — propagate failure explicitly"
date: 2026-06-14
category: conventions
module: deploy.sh
problem_type: convention
component: development_workflow
severity: high
applies_when:
  - "A bash function relies on `set -e` (errexit) to abort on a failed command rather than checking each command's status"
  - "That function is, or might later be, called in a tested context: `if fn` / `if ! fn`, `fn && ...`, `fn || ...`, `! fn`, `while fn`, or `$(fn)` whose result is tested"
  - "Writing or reviewing shell in `deploy.sh` or `.githooks/tests/*.sh`"
  - "A wrapper that checks a function's exit status appears to always succeed even when a command inside the function failed"
tags:
  - bash
  - shell
  - deploy.sh
  - errexit
  - set-e
  - error-handling
  - silent-failure
  - conditional-context
---

# bash `set -e` is suppressed inside a function called in a tested context — propagate failure explicitly

## Context

`deploy.sh` runs under `set -euo pipefail`. `migrate_db` applied each `backend/migrations/*.sql` file in a `for` loop via `psql -v ON_ERROR_STOP=1`, relying on `set -e` to abort the script if any migration failed — it had no explicit per-migration status check.

The near-zero-downtime `cmd_restart` rewrite added a destructive-migration brief-stop carve-out that needs to restart the **old** backend if the migration fails (otherwise the host port is left with no listener):

```bash
if ! cmd_migrate; then
  err "Migration failed during the brief-stop carve-out — restarting the previous backend."
  $COMPOSE start backend || warn "..."
  exit 1
fi
```

Wrapping `cmd_migrate` (→ `migrate_db`) in `if ! ...` silently disabled `set -e` inside the whole call tree. A failing `psql` no longer aborted; the loop continued to the next file, and `migrate_db` returned `0` (its last command was `log "Migrations complete"`). The rollback guard would have observed **success on a failed migration** — a silent failure that proceeds with the deploy while the database is half-applied.

## Guidance

In bash, `set -e` (errexit) is suppressed for a function **and its entire call tree** whenever that function is invoked in a context whose exit status is being tested: `if fn`, `if ! fn`, `fn && ...`, `fn || ...`, `! fn`, `while fn; do`, and command substitution `$(fn)` whose result feeds a test. This is standard POSIX/bash behaviour, not a bug — inside such a call a failing command does not abort the function; execution continues and the function returns the status of its **last executed command**.

Therefore: any bash function that relies on `set -e` to propagate errors **and** might be called in a tested context must check failure explicitly and `return 1`. Do not assume `set -e` will abort it.

```bash
for f in backend/migrations/*.sql; do
  log "  Applying $(basename "$f")..."
  # Explicit return is REQUIRED, not redundant: set -e is suppressed when this
  # function is called under `if !`, `fn ||`, `while fn`, or `$(fn)` (POSIX errexit
  # conditional suppression). Without it, a psql failure silently continues the loop
  # and the function still returns 0.
  if ! $COMPOSE exec -T postgres psql ... -v ON_ERROR_STOP=1 -f "...$(basename "$f")"; then
    err "Migration $(basename "$f") failed"
    return 1
  fi
done
log "Migrations complete"
```

The comment is part of the fix. The explicit `return 1` sits right next to `set -euo pipefail` and `ON_ERROR_STOP=1`, so a future cleanup that reads those as already-covering will delete it as "redundant" and reintroduce the silent failure. Anchor the comment on the behaviour (`set -e` suppression in tested contexts), not on the call site.

## Why This Matters

The failure mode emits no error at the point of failure and reports green to any caller that tests the function's exit status — a rollback guard, a health gate, or a CI step all see success while the underlying operation partially failed. In the migration case the database can be left half-applied while the deploy proceeds. "Fail loudly, not silently" is a standing PEvO stance (single-instance, no replicated logging), and this is the shell-layer instance of it.

## When to Apply

Apply to any bash function in the repo (`deploy.sh`, `.githooks/tests/*.sh`) that:

1. Contains a command (or loop of commands) whose failure should abort the function, AND
2. Is — or might later be — called in a tested context: `if fn` / `if ! fn`, `fn && ...`, `fn || ...`, `! fn`, `while fn`, or `$(fn)` whose result is tested.

Function call sites change over time, so prefer explicit `return 1` on failure for any function doing meaningful work, as a defence against a future caller wrapping it in a condition. If a function is only ever called bare, `set -e` propagates normally — but that is a property of every current call site, not of the function.

Detection: `shellcheck`'s SC2310/SC2311 family warns when a function invoked in a condition has internal commands whose failure would be suppressed. A pure-bash test (in the style of `.githooks/tests/`) can assert the wrapped function returns non-zero when an injected inner command fails.

## Examples

Symptom to recognise: a wrapper that tests a function's exit status always sees success even though an inner command failed.

```bash
# WRONG — silent under `if ! migrate_db`
migrate_db() {
  for f in migrations/*.sql; do
    psql -v ON_ERROR_STOP=1 -f "$f"   # set -e suppressed here; failure continues the loop
  done
  log "done"                          # returns 0 even after a psql failure
}

# CORRECT — propagates failure in both bare and tested contexts
migrate_db() {
  for f in migrations/*.sql; do
    if ! psql -v ON_ERROR_STOP=1 -f "$f"; then
      err "Failed on $(basename "$f")"
      return 1
    fi
  done
  log "done"
}
```

Find candidate call sites to audit:

```bash
grep -nE 'if !|\|\| |&& |while ' deploy.sh .githooks/tests/*.sh
```

## Related

- `agents/docs/solutions/conventions/cascade-fns-rethrow-permanent-errors-2026-05-16.md` — closest sibling in the other language: errors silently misclassified because the call context changes propagation semantics.
- `agents/docs/solutions/conventions/boot-fatal-flush-watchdog-pattern-2026-05-11.md` and `boot-fatal-call-stack-unwind-and-rethrow-trap-2026-05-11.md` — the TypeScript/Node side of "a fatal failure that does not actually abort the process"; same fail-loudly stance, different layer.
