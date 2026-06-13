# BACKEND-REPUTATION-BATCH-SEAM-ESLINT-GUARD — add the missing no-restricted-imports entry for reputation-batch.ts's __test_seams

**Owner:** backend
**Created:** 2026-06-12 (architect, from the clean round-4 re-review of the redis-keys-scan task; pre-existing gap, corroborated against the seam convention by two reviewers; elected at triage)
**Priority:** P3 (convention completeness; no production import of the seam exists today)

## Problem

`backend/src/reputation-batch.ts` exports a `__test_seams` namespace, but `backend/eslint.config.mjs`'s `no-restricted-imports` seam catalog has no entry for it. The seam convention (`test-seams-two-shapes-direct-export-vs-deep-site-consumer-2026-06-09.md`, shared invariant: every `__test_seams` export site adds a matching guard entry) is satisfied for `routes/anonymousReview.ts`, `routes/signup-verify.ts`, and `reputation.ts` — `reputation-batch.ts` is the one registered-style seam without its guard. The eslint rule is the primary defense against production code importing a test seam; an unguarded seam relies on review alone.

## Goal

A production-side import of `reputation-batch.js`'s `__test_seams` turns lint red, like the three sibling seams.

### Suggested approach

Mirror the existing `reputation.js` patterns entry in `backend/eslint.config.mjs`: a `no-restricted-imports` patterns block scoped to `src/**/*.ts`, `importNames: ['__test_seams']`, with a guard message naming what the seam exposes (the staging/sentinel cleanup helpers and the Redis key constants including `REDIS_KEY_BATCH_MEMBERS`). Verify with a probe import in a `src/` file (eslint errors on exactly that site), then revert the probe.

## Acceptance

- A probe `import { __test_seams } from './reputation-batch.js'` in a `backend/src/` file fails `npx eslint src/`; the probe is reverted.
- Existing test imports of the seam stay legal (the guard is scoped to `src/`, not `tests/`).
- `npm run typecheck` + `npm run lint` clean; zero new suppressions.
- Comment anchors clean (anchor the entry's message on the seam contents, not on task/round state).

## Cross-references

- `backend/eslint.config.mjs` (the three existing seam entries — the shape to mirror).
- `agents/docs/solutions/conventions/test-seams-two-shapes-direct-export-vs-deep-site-consumer-2026-06-09.md` (shared invariants; its registered-seam catalog can be reconciled by the architect at archive if it enumerates sites).
- `agents/docs/solutions/conventions/test-seams-export-shape-as-const-2026-05-04.md`.
- Archived parent in `tasks-archive.md`: `BACKEND-REDIS-KEYS-SCAN-REPLACEMENT`.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Backend completion note (2026-06-14)

Added the missing `reputation-batch.js` `__test_seams` guard to `eslint.config.mjs`, mirroring the three sibling seam entries (anonymousReview, signup-verify, reputation). The new `no-restricted-imports` patterns entry scopes to `src/**/*.ts` with `importNames: ['__test_seams']` and `group: ['**/reputation-batch', '**/reputation-batch.js']`. Its message anchors on the seam contents (the cycle-swap Lua script and its staging/prod substrings, the batch Redis key constants, and the `clearStagingKeys`/`clearInProgressSentinels` cleanup helpers), not on task/round state. The seam-enumeration docblock above the rule gained a matching `reputation-batch` bullet.

The `**/reputation` glob does NOT match `reputation-batch` (exact segment, no trailing wildcard), so the new entry is genuinely distinct from the existing reputation entry.

Verification: a probe `import { __test_seams } from './reputation-batch.js'` in a `src/` file fails `npx eslint src/` on exactly that site with the new message; probe reverted. Existing test imports (`tests/routes/stats-profile-parity.test.ts`, `tests/routes/reputation-batch-internals.test.ts`) stay legal (guard scoped to `src/`; `npm run lint` lints `src/` only). `npm run typecheck` + `npm run lint` clean (zero new suppressions; one pre-existing `author-supersession.ts` warning, untouched); `tests/eslint/` 64/64 green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
