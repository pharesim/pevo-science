# BACKEND-ANCHOR-ROT-RESIDUAL-IDEMPOTENCY-CLAIMS-SEC-ID — clear 2 pre-existing comment-anchor residuals the src/ sweep canary doesn't catch

**Owner:** backend
**Created:** 2026-06-14 (architect, surfaced during the round-2 re-review of `backend-haf-query-comment-anchor-sweep`)
**Priority:** P3 (documented Comment-Anchors convention; pre-existing, no behavioral defect)

## Problem

The `backend/src/` comment-anchor sweep and its standing canary (`no-stale-comment-anchors.test.ts`,
which checks `round-N hold` / `Option X.N` / `(backend|ui|architect)-<kebab>` slug classes) left two
pre-existing rot sites uncovered, surfaced by reviewers during the sweep's round-2 re-review. Neither was
introduced by the sweep; both are out of that task's scope.

1. **`backend/src/lib/idempotency.ts` — a line-number cross-reference anchor in a comment** (a `src/db.ts`
   location-style cite). Line-number anchors are a rot class per `docblock-anchor-stable-symbols-not-line-numbers`,
   but the canary only covers slug/round/Option classes, not line-number cites — so it slips through. This
   one dates to the round-1 sweep commit (`324ca283`), not a later change.
2. **`backend/src/routes/claims.ts` — a `SEC-003-BE` identifier in a comment.** This superficially resembles
   an uppercase task-slug but is NOT a PEvO task slug (the canary's `SLUG_RE` correctly requires a
   `backend|ui|architect` role prefix, so `SEC-` is excluded by design). It appears to be an id from a
   different tracking system. Decide whether it is a live, resolvable reference worth keeping or a dead
   pointer to drop / re-anchor on behavior.

## Goal

Both sites either re-anchored on a stable symbol / behavior, or (for the `SEC-003-BE` id) confirmed as a
live external reference and left intentionally with a clarifying note. No new rot class substituted in.

## Acceptance

- **Re-verify both sites still exist** before editing (a sibling sweep may have cleaned them; line/anchor
  snapshots drift). Grep `backend/src/lib/idempotency.ts` for the line-number cite and `backend/src/routes/claims.ts`
  for `SEC-003-BE`.
- The `idempotency.ts` line-number anchor is replaced with a stable-symbol / behavioral anchor (per the
  Comment-Anchors convention); the surrounding WHY prose is preserved.
- The `claims.ts` `SEC-003-BE` id is either confirmed a live external reference (left with a one-word note
  on what system it points to) or re-anchored on behavior if it is a dead pointer. Implementer's call after
  checking whether it resolves.
- Per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`, audit the replacement text for
  any new rot class (do NOT swap a line-number for a slug or vice versa).
- `npm run typecheck` + `npm run lint` clean. The `no-stale-comment-anchors` canary stays green.
- Optional: if the canary is extended to cover line-number cites (the gap that let #1 through), that
  belongs here or in a follow-up, not silently — coordinate with the sweep task's round-3 canary hardening.

## Cross-references

- `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`
- Parent sweep: `backend-haf-query-comment-anchor-sweep` (in `tasks/pending/` at filing time, round-3 hold).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
