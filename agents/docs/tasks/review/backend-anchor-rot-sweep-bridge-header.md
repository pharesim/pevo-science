# BACKEND-ANCHOR-ROT-SWEEP-BRIDGE-HEADER — sweep cross-file line-number anchors + slug redirects in bridge-haf-lag-locks.test.ts header/docblocks

**Owner:** Backend Agent
**Created:** 2026-06-08 (architect, surfaced by `/ce-code-review` during the anchor-rot-sweep cluster review)
**Priority:** P3 (comment hygiene; no behavior change)

## Problem

The prior `backend-anchor-rot-sweep-bridge-tests` task (archived) scoped itself to describe/it **labels** + inline **round-N** comments, and met that scope. The architect review of that cluster found that the **same file's docblocks** still carry a *different* rot class the prior task did not enumerate: cross-file **line-number anchors** and **task-slug redirects**, both forbidden in test source per root `CLAUDE.md` "Comment anchors". Line-number anchors are the highest-drift class (any edit above the cited line stales them), and the slug redirect points into `tasks-archive.md`, which trims from the bottom at 250 lines, so the pointer is guaranteed to dangle.

## Sites — `backend/tests/routes/bridge-haf-lag-locks.test.ts` ONLY

1. **Header "Real-path companion" docblock — two cross-file line-number anchors.** `orcid.test.ts:1040` and `orcid.test.ts:1192` (the references to the orcid same-tick SETNX-lock suite and its stale-lock-expiry spec). Drop the `:1040`/`:1192` line numbers; re-anchor on the stable describe-block name and the spec's behavioral description (e.g., "the same-tick SETNX-lock contention `describe` block in `orcid.test.ts`" and "its stale-lock-expiry spec"), no line numbers.

2. **Same header — `SEC-002-TOCTOU-LOCK` slug citation.** The parenthetical `(SEC-002-TOCTOU-LOCK)` next to the "same-tick SETNX lock" description reproduces a task slug. Drop the parenthetical; the behavioral name already identifies the suite. (Note: `orcid.test.ts`'s own `describe` title still contains this slug — that is adjacent rot in `orcid.test.ts` and is OUT OF SCOPE here; this task is the bridge file only.)

3. **`waitForLockAcquired` docblock (~line 302) — task-slug redirect into the archive.** The trailing `See `backend-bridge-test-fence-replace-setTimeout` in tasks-archive.md.` is a dead-pointer-in-waiting (the archive trims at 250 lines). The docblock already explains the setTimeout-stagger replacement and CI-determinism rationale inline, so the redirect adds nothing durable — drop the redirect sentence (optionally restate the rationale inline if any context is lost).

## Acceptance

1. All three sites re-anchored on stable behavioral/symbol semantics; no line number, task slug, archive redirect, SHA, or `§ N.M` anchor remains.
2. **Audit-own-replacement** per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17`: the replacement text introduces no new rot class.
3. **Widened in-file grep returns zero hits** (the prior sweep's `BACKEND-[A-Z]` pattern missed the `BE-`/`SEC-` family; use the complete pattern):
   `grep -nE "BACKEND-[A-Z]|BE-[A-Z]|UI-[A-Z]|SEC-[0-9]|round-[0-9]|\.ts:[0-9]+|§ ?[0-9]+\.[0-9]+|project_[a-z_]+|see the task|task acceptance|tasks-archive" backend/tests/routes/bridge-haf-lag-locks.test.ts`
   (Positional `above`/`below` anchors that meet the stable-named-container carve-out, `positional-anchor-stable-named-container-carve-out-2026-05-20`, are acceptable and not in scope to remove.)
4. **Verification:** `npm run typecheck` + `npm run lint` clean; file green at parity before/after (comment-only, no behavior change).

## References

- Root `CLAUDE.md` "Comment anchors" section
- `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`
- `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Backend completion (2026-06-08, working tree):

All three sites in `bridge-haf-lag-locks.test.ts` re-anchored on stable behavioral/symbol semantics:
1. Header "Real-path companion" docblock — dropped the `orcid.test.ts:1040`/`:1192` line numbers; re-anchored on "the same-tick SETNX-lock contention `describe` block in `orcid.test.ts`" and its stale-lock-expiry spec.
2. Dropped the `(SEC-002-TOCTOU-LOCK)` slug parenthetical.
3. `waitForLockAcquired` docblock — dropped the `tasks-archive.md` redirect sentence (the setTimeout-stagger rationale is already inline).

Widened in-file grep (`BACKEND-[A-Z]|BE-[A-Z]|UI-[A-Z]|SEC-[0-9]|round-[0-9]|.ts:[0-9]+|§ ?[0-9]+.[0-9]+|project_[a-z_]+|see the task|task acceptance|tasks-archive`) returns zero hits. Audit-own-replacement: no new rot class. `npm run typecheck` + `npm run lint` clean (lone pre-existing `author-supersession.ts` unused-directive warning, not in scope); comment-only, behavior parity.
