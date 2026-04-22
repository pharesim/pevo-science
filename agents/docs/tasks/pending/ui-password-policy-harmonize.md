# FE-PASSWORD-POLICY-HARMONIZE — UI side of cross-stack password-policy harmonization

**Owner:** UI Agent
**Priority:** P3
**Created:** 2026-04-21
**Surfaced by:** SEC-004-BE review triage (2026-04-21).
**Paired with:** `backend-password-policy-harmonize.md` — coordinate so both halves land consistently.

## Context

FE-PASSWORD-POLICY-DRY (commit `a753773`) and BE-PASSWORD-POLICY-DRY (archived 2026-04-21c) extracted shared helpers in each stack independently. Both currently encode an identical `length >= 10 && /[a-z]/ && /[A-Z]/ && /[0-9]/` rule, but they will drift unless harmonized explicitly.

## Goal

Harden the frontend side against silent drift from the backend:

1. Add `// Keep in sync with backend/src/password-policy.ts` pointer comment in `frontend/src/password-policy.js` so any future edit has a visible nudge to update the other side.
2. Coordinate with the backend half (`backend-password-policy-harmonize.md`) so both pointer comments reference each other and the CI drift-check (owned by the backend half) picks up the frontend helper's canonical path.

## Non-goals

Changing the policy itself. Adding zxcvbn or other strength tools. Implementing the CI check (backend half owns that).

## Status

Both prerequisite helpers landed. No longer blocked on other work — blocked only on coordinating with the backend side on the pointer-comment shape.

## Deliverable

Frontend helper carries a visible pointer to the backend counterpart. Move to Review together with the backend half so the CI drift-check can reference both files.
