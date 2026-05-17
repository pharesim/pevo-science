# BACKEND-BUILD-CUSTODY-UPGRADE-CHALLENGE-EXPORT — expose `buildCustodyUpgradeChallenge` for cross-source byte-equality test

**Owner:** Backend
**Created:** 2026-05-17 (architect, surfaced by `/ce-code-review` re-review of `ui-custody-upgrade-seed-phrase-derive-flow` round-2 — adv-9 P2 carry-forward blocker confirmed)
**Priority:** P2 (test-coverage support, not deploy-blocker)

## Problem

The custody-upgrade flow's canonical challenge format is duplicated in two places: the backend at `backend/src/routes/custody.ts:984` (`buildCustodyUpgradeChallenge`) and the frontend at `frontend/src/pages/settings.js` (inside `_signUpgradeProof`). The round-1 adversarial review for `ui-custody-upgrade-seed-phrase-derive-flow` (adv-9, P2/90) called for a byte-equality test asserting both sites produce identical output for a fixed `(appTag, username, signed_at)` fixture — mirroring `sec-001-equivalence.test.js`'s cross-source-import shape.

The round-2 implementer confirmed the test is blocked: `buildCustodyUpgradeChallenge` is declared with a bare `function` keyword and is not exported from `custody.ts` (verified `previous-comments` PC-4 conf 90).

## Goal

Export `buildCustodyUpgradeChallenge` from `backend/src/routes/custody.ts` so the frontend test can import it cross-source and assert byte-equality.

## Acceptance

1. Add `export` to the `buildCustodyUpgradeChallenge` declaration in `backend/src/routes/custody.ts:984`.
2. No other change to the function body or call sites.
3. Brief inline comment at the export site stating the export is test-support only (the function remains an internal route helper, not a stable contract).

## Out of scope

- Writing the frontend byte-equality test itself (that follows once the export lands; it will be filed as a UI task under `tasks/pending/ui-custody-upgrade-challenge-byte-equality-test.md` after this task archives).
- Refactoring the challenge format into a shared module. The export-only approach keeps the function co-located with its consumers in custody.ts and mirrors the `sec-001-equivalence.test.js` cross-source pattern.

## Cross-references

- `agents/docs/tasks/review/ui-custody-upgrade-seed-phrase-derive-flow.md` — round-2 carry-forward blocker, surfaced in the round-3 architect hold block.
- `agents/docs/solutions/conventions/hive-signature-request-binding-shape-2026-04-21.md` — the canonical-challenge convention this byte-equality test exercises.
- `frontend/tests/unit/sec-001-equivalence.test.js` — template for the cross-source byte-equality pattern the follow-up UI task will adopt.
