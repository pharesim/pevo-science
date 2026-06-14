# Signup duplicate-ORCID 409 burns the ORCID nonce, blocking retry (backend)

**Owner:** backend
**Created:** 2026-06-14 (architect, from the `/ce-code-review` of `backend-signup-orcid-duplicate-409`, commit `edd35067`)
**Priority:** P3 (UX papercut; no security impact, no data corruption)

## Problem

`POST /api/signup` consumes (del-on-read) the single-use ORCID verification nonce
(`${appTag}:orcid_verified:<nonce>`) **before** it runs the account INSERT. When the
INSERT trips the `accounts_orcid_unique` partial index (duplicate ORCID on a new row),
the handler now correctly returns `409 ORCID_ALREADY_LINKED` (landed in
`backend-signup-orcid-duplicate-409`). But because the nonce is already burned, the
rejected user cannot simply resubmit: a same-`orcid_token` retry no longer resolves a
verified ORCID and falls through to the missing/invalid-token `422`, not the clean
`409`. The only recovery is re-running the entire ORCID OAuth round-trip from `/start`.

This is **pre-existing** — the nonce-del-before-INSERT ordering predates the 409 mapping;
that commit only changed the failing-path error code from `500` to `409`. It surfaced
during the 409 review as the adversarial reviewer's P2 (downgraded here: real but a
narrow UX papercut, not a correctness/security defect — the duplicate is correctly
rejected either way).

## Options (implementer's call — surface the decision)

1. **Make the nonce survive a duplicate-ORCID rejection.** Re-seed (or skip the
   del-on-read for) the `orcid_verified` entry on the `23505 / accounts_orcid_unique`
   path so a same-token resubmit deterministically reproduces the `409` within the
   nonce TTL. Keeps the nonce single-use for the success path; only the
   already-rejected-duplicate path gets a bounded reuse window. Verify this cannot be
   abused to extend the nonce lifetime for a *non*-duplicate signup.
2. **Treat the 409 as terminal-restart at the SPA.** Leave the backend as-is and make
   the frontend re-initiate ORCID OAuth on this 409 (it already restarts OAuth on the
   `/orcid/callback` durable-binding 409). Document the contract: the `/signup`
   `ORCID_ALREADY_LINKED` 409 is terminal; clients restart the flow. This is the
   cheaper option and mirrors the existing callback-409 client behavior.

Option 2 is likely sufficient and consistent with the callback-409 precedent; pick it
unless option 1's deterministic-retry is judged worth the nonce-lifecycle complexity.

## Acceptance criteria

1. A user who hits the duplicate-ORCID `409` on `/signup` has a defined, non-confusing
   recovery path (either a deterministic same-token retry that reproduces the `409`, or
   a documented SPA restart-OAuth behavior — whichever option is chosen).
2. If option 1: a test that a same-`orcid_token` resubmit after the duplicate-ORCID
   `409` returns `409` again (not `422`), within the nonce TTL; plus a test that the
   nonce is still single-use on the success path.
3. If option 2: the SPA restarts the ORCID flow on the `/signup` `ORCID_ALREADY_LINKED`
   409 (a UI task may be split off), and the contract note in `api-contracts/auth.md`
   states the 409 is terminal. (The `auth.md` 409 entry already exists from the
   signup-409 archive; extend it if option 2 is chosen.)

## Out of scope

- The duplicate-ORCID rejection itself (already correct and archived).
- The deeper sole-guard / chain-binding gaps tracked under
  `backend-orcid-unique-index-boot-assertion` and
  `backend-signup-confirm-orcid-binding-guard`.

## Backend resolution — Option 2 chosen (2026-06-14, user decision)

The user selected **Option 2 (terminal 409)** over Option 1 (re-seed nonce for
deterministic retry). Rationale confirmed against the code: a `/signup`
`ORCID_ALREADY_LINKED` 409 means the supplied ORCID is already bound to another
account row (the `accounts_orcid_unique` partial index). That ORCID is genuinely
taken, so a same-ORCID resubmit can **never** succeed regardless of nonce state —
the real recovery is for the user to log into the existing account, not to retry
signup. Option 1's deterministic-409-on-retry would therefore re-seed a nonce only
to reproduce a rejection that can never become a success: cosmetic, and not worth
the nonce-lifecycle complexity. Option 2 also mirrors the existing
`/orcid/callback` durable-binding 409 client behavior.

**Backend code change: none.** The 23505 / `accounts_orcid_unique` → 409
`ORCID_ALREADY_LINKED` mapping already lands correctly in the `/signup` handler
(`backend/src/routes/auth.ts`, in the catch block that gates on the constraint
name). The nonce-del-before-INSERT ordering is left as-is by design: the SPA owns
recovery, so the backend deliberately does not extend the single-use nonce's
lifetime. AC1 is satisfied by the SPA behavior below plus the already-terminal 409;
AC2 (Option 1 tests) does not apply; AC3 is the architect/UI handoff below.

## [TODO Architect] — Option 2 contract + UI-task split

Two architect-owned deliverables remain before archive (backend cannot edit
`api-contracts/*.md`, and the `tasks/` tree + UI-task creation are architect-owned):

1. **Contract (extend, do not duplicate).** `api-contracts/auth.md` already
   documents the `/signup` `ORCID_ALREADY_LINKED` (409) entry with its terminal
   *wire shape* (no `retriable`, no `Retry-After`, same as the callback durable-bind
   409). What it does NOT yet state is the *recovery contract*: the 409 is terminal,
   a same-`orcid_token` resubmit will not reproduce it (the verification nonce is
   single-use and already consumed, so a resubmit falls through to the
   missing/invalid-token 422), and clients must restart the ORCID OAuth flow from
   `/api/orcid/start` (or route the user to log into the existing account, since the
   ORCID is already linked). Extend the existing entry with that recovery semantics.

2. **UI task split.** Spawn a `ui-*` task so the SPA treats the `/signup`
   `ORCID_ALREADY_LINKED` 409 as terminal: surface a clear "this ORCID is already
   linked to a PEvO account — log in instead" path (and/or restart the ORCID OAuth
   flow), mirroring how the SPA already handles the `/orcid/callback`
   durable-binding 409. The SPA must not blindly resubmit the same `orcid_token`
   (that yields the confusing 422 this task is about).
