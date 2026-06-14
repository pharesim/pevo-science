# Signup duplicate-ORCID surfaces as 500 instead of 409 (backend)

**Owner:** backend
**Created:** 2026-06-14

A `/signup` attempt that would bind an already-used ORCID to a new account row is
correctly rejected by the `accounts_orcid_unique` index (`migrations/007`), but the
resulting Postgres `23505` falls through to the generic catch and returns
`500 INTERNAL_ERROR "Registration failed"`. It should return the clean
`409 ORCID_ALREADY_LINKED` that the `/orcid/callback` accredit/link paths already
use. The invariant holds (no duplicate row persists) — this is a UX/contract
correctness fix, not a security hole.

From a 2026-06-14 adversarial audit of the ORCID-uniqueness invariant.

## Root cause

In the `POST /api/signup` handler (`backend/src/routes/auth.ts`):

- The ORCID+email branch uses `INSERT ... ON CONFLICT (email)` (conflict target is
  `email`, not `orcid`), and the ORCID-only branch is a plain `INSERT`. A
  same-ORCID-different-email (or ORCID-only) write therefore hits
  `accounts_orcid_unique` and raises `23505`.
- The outer `catch` calls `handleArgonError`, which returns `ARGON_UNHANDLED` for a
  non-argon error, so control falls through to
  `sendError(res, 500, 'INTERNAL_ERROR', 'Registration failed')`. There is no
  `23505` / constraint-name handling anywhere in `auth.ts`.

## Acceptance criteria

1. In the `/signup` handler's error handling (`backend/src/routes/auth.ts`), detect
   a Postgres unique-violation (`err.code === '23505'`) on the
   `accounts_orcid_unique` constraint and map it to
   `409 ORCID_ALREADY_LINKED`, matching the `orcid.ts` callback wire shape (status
   `409`, code `ORCID_ALREADY_LINKED`, no `retriable` / `Retry-After`). Match on the
   constraint name so an unrelated unique violation (e.g. a future constraint) does
   not get mislabeled as an ORCID collision.
2. Do not change the behavior of the email-duplicate path (it already returns
   `409 DUPLICATE` before the INSERT) — this is specifically the orcid-uniqueness
   collision that currently leaks as a 500.
3. Test coverage: a `/signup` attempt with an ORCID already present on another row
   returns `409 ORCID_ALREADY_LINKED` (not `500`), for both the ORCID+email and
   ORCID-only branches. Real-path against the actual index per project test policy;
   a mocked-pool variant is acceptable only under the `CLAUDE.md` carve-out with the
   real-path companion.

## Context / out of scope

- Keep the user-facing message free of emdashes (HTTP response strings are
  user-facing text per `CLAUDE.md`).
- The deeper sole-guard / chain-binding gaps are tracked separately
  (`backend-orcid-unique-index-boot-assertion`,
  `backend-signup-confirm-orcid-binding-guard`). This task is the narrow error-code
  fix only.
- The `ORCID_ALREADY_LINKED` code already exists in the `ErrorCode` union and the
  `orcid.md` contract; reuse it rather than introducing a new code.

## Backend implementation note (2026-06-14, working tree)

- **Mapping (item 1).** The `/signup` catch in `backend/src/routes/auth.ts` now
  detects `err.code === '23505'` AND `err.constraint === 'accounts_orcid_unique'`
  and returns `409 ORCID_ALREADY_LINKED` ("This ORCID is already linked to another
  account", the exact string the `/orcid/callback` accredit/link 409s use), before
  the generic 500. Verified empirically against the live index that a partial-index
  violation populates `err.constraint = 'accounts_orcid_unique'` (not only the
  message), so the constraint-name gate is reliable and an unrelated future unique
  violation will not be mislabeled.
- **Email path unchanged (item 2).** The email-duplicate path still returns
  `409 DUPLICATE` before the INSERT; the new branch only fires on the orcid-index
  collision, which `ON CONFLICT (email)` does not intercept.
- **Coverage (item 3).** Real-path tests added to `backend/tests/routes/auth.test.ts`
  ("duplicate ORCID maps 23505 to 409") under the existing `dbReachable` skip-guard.
  A prior row holds the ORCID; the second `/signup` (ORCID-only and ORCID+email
  branches) reaches the real index, raises 23505, and asserts `409`,
  `ORCID_ALREADY_LINKED`, and the terminal shape (no `retriable`, no `Retry-After`).
  Real argon/index path; only the upstream ORCID-verification nonce is seeded
  directly. No mocked-pool variant was needed.
- Full `auth.test.ts` green (23). `npm run typecheck` + `npm run lint` clean (the
  lone lint warning is a pre-existing unused-eslint-disable in
  `src/lib/author-supersession.ts`, untouched).
