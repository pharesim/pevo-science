# BE-ORCID-NO-ACCOUNT-ERROR-SHAPE-ALIGN — Align NO_ACCOUNT 409 response shape across contract, implementation, and frontend consumer

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-ORCID-TOCTOU-LOCK round-2 review 2026-04-22)
**Priority:** P3

## Context

The BE-ORCID-TOCTOU-LOCK round-2 re-review surfaced a pre-existing three-way mismatch on the `NO_ACCOUNT` error response, unrelated to the task being reviewed but worth tracking now that the orcid.md file has been touched:

- **Contract** (`agents/docs/api-contracts/orcid.md:128-135`) shows:
  ```json
  { "status": "error", "error": { "code": "NO_ACCOUNT", "message": "..." }, "orcid_id": "0000-..." }
  ```
  `orcid_id` is documented as a top-level sibling of `error`.

- **Implementation** (`backend/src/routes/orcid.ts:332`) calls `sendError(res, 409, 'NO_ACCOUNT', '...', { orcid_id })`. `sendError` places the fourth arg inside `error.details`, so the actual wire response is:
  ```json
  { "status": "error", "error": { "code": "NO_ACCOUNT", "message": "...", "details": { "orcid_id": "0000-..." } } }
  ```
  `orcid_id` is inside `error.details`, not at top level.

- **Frontend consumer** (`frontend/src/api.js:36`) constructs `ApiRequestError` with `errorBody.data` as the third arg. Errors don't have a top-level `data` field; `err.data` is always `null`. The frontend cannot reach `orcid_id` via either the documented top-level position (which doesn't exist in the wire response) or the actual `error.details` position (which api.js doesn't expose — see `ui-orcid-retriable-discriminator-plumbing.md` for the plumbing fix).

All three are wrong in different ways. The contract is aspirational; the implementation is correct relative to `sendError`'s envelope convention; the frontend is blind regardless.

## Why this matters

Low active impact — no current frontend handler reads `orcid_id` from a NO_ACCOUNT error (the information is redundant; the user submitted the ORCID in the request, so the server echoing it back is belt-and-suspenders). The concern is audit hygiene: a future agent or new frontend handler wiring up "show which ORCID triggered NO_ACCOUNT" would consult the contract, write `err.orcid_id`, and silently get `undefined`.

## Goal

1. Verify whether any caller needs `orcid_id` on NO_ACCOUNT at all. If not, drop it from both the contract and the `sendError` call — the response becomes a plain `NO_ACCOUNT` 409 with no payload.
2. If some caller does need it, standardize on the `error.details.orcid_id` shape that matches the wire reality, update the contract to show that shape, and wait for `ui-orcid-retriable-discriminator-plumbing.md` to ship so the frontend can read `err.details.orcid_id`.

Preferred outcome (per the "no current caller needs it" inspection): drop `orcid_id` from the NO_ACCOUNT response entirely.

## Non-goals

- Touching any other ORCID error codes. Only `NO_ACCOUNT`.
- Fixing `frontend/src/api.js` error-details plumbing — that's covered by `ui-orcid-retriable-discriminator-plumbing.md`.

## Acceptance

- Contract at `api-contracts/orcid.md` matches the implementation's wire response.
- Frontend consumer-side expectation (even if unused) is consistent with contract.
- Test at `backend/tests/routes/orcid.test.ts` asserts the NO_ACCOUNT 409 response shape explicitly (add/extend a spec if none exists).

## [TODO Architect]

Architect decides whether to drop `orcid_id` or preserve it under `error.details`. Contract edits happen architect-side per the new `backend/CLAUDE.md` boundary rule.
