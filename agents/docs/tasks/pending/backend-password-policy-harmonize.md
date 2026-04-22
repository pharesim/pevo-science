# BE-PASSWORD-POLICY-HARMONIZE — Backend side of cross-stack password-policy harmonization

**Owner:** Backend Agent
**Priority:** P3
**Created:** 2026-04-21
**Surfaced by:** SEC-004-BE review triage (2026-04-21).
**Paired with:** `ui-password-policy-harmonize.md` — coordinate so both halves land consistently.

## Context

FE-PASSWORD-POLICY-DRY (commit `a753773`) and BE-PASSWORD-POLICY-DRY (archived 2026-04-21c) extracted shared helpers in each stack independently. Both currently encode an identical `length >= 10 && /[a-z]/ && /[A-Z]/ && /[0-9]/` rule, but they will drift unless harmonized explicitly.

## Goal

Now that both single-stack extractions have landed, harden the backend side against silent drift from the frontend:

1. Add `// Keep in sync with frontend/src/password-policy.js` pointer comment in `backend/src/password-policy.ts` (or wherever the helper lives) so any future edit has a visible nudge to update the other side.
2. Add a CI check (grep or type-level) that fails when only one side changes. The backend CI is the canonical place for this gate since the repo's CI workflow is typically backend-driven; coordinate with the UI agent if the check needs to compare files across stacks.
3. Coordinate with UI half (`ui-password-policy-harmonize.md`) so both pointer comments reference each other and land in the same review cycle.

## Non-goals

Changing the policy itself. Adding zxcvbn or other strength tools. Centralizing via a JSON schema both sides consume (considered, not the chosen shape for this task).

## Status

Both prerequisite helpers landed. No longer blocked on other work — blocked only on coordinating the CI-check shape with the UI side.

## Deliverable

A future unilateral policy change on one side breaks CI, not production. The backend helper carries a visible pointer to the frontend counterpart. Move to Review with the CI-check implementation + backend-side pointer comment.

## Architect contract note

Document the canonical policy in `agents/docs/api-contracts/auth.md` with explicit pointer to both helpers (already partially done — `auth.md:60` and `:382` cite the helper; `settings.md:93` does too). Architect may need to confirm those pointers still resolve after this task lands.
