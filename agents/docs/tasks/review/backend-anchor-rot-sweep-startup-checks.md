# BACKEND-ANCHOR-ROT-SWEEP-STARTUP-CHECKS — sweep round-N / hold / task-slug anchors from startup-checks.{ts,test.ts}

**Owner:** Backend Agent
**Created:** 2026-05-26 (architect, surfaced by `/ce-code-review` of commit `ceb90317` during the schema-authority review batch)
**Priority:** P3

## Problem

`backend/src/startup-checks.ts` and `backend/tests/startup-checks.test.ts` carry
~20 comment-anchor-rot markers (`round-N`, `hold #N`, and
`BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT` task-slug citations) left
over from the bridge-key-startup-validation work. These violate the root
`CLAUDE.md` "Comment anchors" rules and the
`task-slug-citations-in-comments-go-stale-on-archive-2026-05-15` +
`docblock-anchor-stable-symbols-not-line-numbers-2026-05-15` conventions: the
task has long since archived, so the round numbers and slug have no live
referent.

These are **pre-existing** — not introduced by `ceb90317` (which only incidentally
touched a couple of comments in these files while migrating `initAppDb` callers)
— and they fall **outside** the scope of `backend-anchor-rot-sweep-2026-05-21`
(that task covers migrations 005/006/007 + `hafsql.test.ts`, and its own "Out of
scope" explicitly says other test files with sibling rot should be "filed
separately"). This task is that separate filing.

## Known sites (verify in-place; the list is a starting point, not exhaustive)

`backend/src/startup-checks.ts`:
- lines ~26, ~60, ~234, ~261, ~378, ~435 — `round-3`/`round-4` + `hold #N` +
  the `BACKEND-BRIDGE-KEY-...` slug in docblocks and inline comments.

`backend/tests/startup-checks.test.ts`:
- ~15 sites, including many `it('… (round-N …)')` / `it('… hold #N')` titles
  and the `describe('validateConfig / initBridgePostingKeyCache — BootFatalError
  throw (round-5 hold #3)')` block title (~line 557), plus inline
  `// Round-N …` comments (e.g., ~339, ~396, ~468) and `round-4` references in
  prose (~585, ~613).

## Goal

Rewrite each anchor to describe the behavioral invariant being explained
(validator semantics, boot-fatal throw shape, cache-population contract, etc.)
rather than the coordination round/hold/slug it came from. The test titles
should describe what is being asserted, not which review round added them.

## Acceptance

1. `grep -nE "[Rr]ound-[0-9]|hold #|BACKEND-BRIDGE-KEY" backend/src/startup-checks.ts backend/tests/startup-checks.test.ts` returns zero hits after the sweep.
2. **Audit own replacement** (per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17`): no rewrite introduces a new task slug, SHA, line-number anchor, or round-N marker. Anchor on stable symbols (exported function names, `BootFatalError`, binding/env-var names).
3. Comment-only change — no behavior change. `npx tsc --noEmit` clean, `npm run lint` clean, and the `startup-checks.test.ts` suite passes at parity with HEAD before the sweep.

## Out of scope

- Other files with sibling rot beyond these two (file separately if surfaced).
- Any production-logic change to `validateConfig` / `initBridgePostingKeyCache` /
  `verifyAppDbMigrations`.

## References

- Root `CLAUDE.md` "Comment anchors" section.
- `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`
- `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Backend implementer signal (2026-05-26, commit 5c8b9b39)

Sweep complete. Every `round-N` / `hold #N` prefix and every
`BACKEND-BRIDGE-KEY-*` task-slug citation in `backend/src/startup-checks.ts`
and `backend/tests/startup-checks.test.ts` is rewritten to describe the
behavioral invariant it explains (validator semantics, `BootFatalError` throw
shape, lazy-fallback cache contract). Test `it`/`describe` titles now describe
the assertion, not the review round.

Scope note for the architect: while sweeping I also removed the pre-existing
`.ts:NN` line-number anchors in these two files (`startup-checks.ts`'s
`routes/bridge.ts:33` / `routes/claims.ts:203`, plus the test's
`anonymousReview.ts:174` and `startup-checks.ts:175`). These are a different
rot class than the task's round/hold/slug grep target, but leaving
line-number anchors in a file being explicitly de-rotted would contradict the
`docblock-anchor-stable-symbols-not-line-numbers` convention. They are now
anchored on stable symbols / file names. One vaguer audit-cluster reference
(`(cluster B α)` in a test comment) was left as-is: it is outside both the
task grep and the line-number/SHA/slug classes; flagging it here in case you
want it filed separately.

Acceptance verified:
- `grep -nE "[Rr]ound-[0-9]|hold #|BACKEND-BRIDGE-KEY"` over both files: 0 hits.
- Audit-own-replacement: no new task slug, SHA, line-number anchor, or round-N
  marker introduced (`.ts:NN` and `commit <sha>` greps both clean). The
  legitimate word "round-trip" / "round-tripping" remains (no digit after
  `round-`, so outside the grep).
- Comment-only change: `npm run typecheck` pass (src + tests); `npm run lint`
  pass (one pre-existing unrelated warning in `author-supersession.ts`);
  `tests/startup-checks.test.ts` 42/42 pass at parity.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
