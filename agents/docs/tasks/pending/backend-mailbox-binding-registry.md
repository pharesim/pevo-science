# A verified mailbox backs at most one accredited account: the registry and the email accreditation flow

**Owner:** backend
**Created:** 2026-10-06
**Priority:** high

Filed from `architect-accreditation-mailbox-binding-design` (decisions with the user, 2026-10-06; the
schema change is approved). Design: `ARCHITECTURE.md` § 2 "Credential Bindings". Vocabulary:
`CONCEPTS.md` "Credential Binding", "Release".

## Why

`POST /api/accreditation/verify` keys every gate on the Hive account or the token, none on the
address, and `/request` stores the address only in Redis for 24 h. One mailbox can therefore
accredit any number of accounts, and three accredited accounts enrol anyone into the Web of Trust.
This task adds the mailbox registry and makes the email accreditation flow enforce it.

## Scope

1. **Migration** `backend/migrations/018_mailbox_bindings.sql` (expand-only, per § 1 "Schema
   Migrations"): table `mailbox_bindings` with one row per (mailbox, account) binding: the keyed
   hash of the canonical address, the canonicalisation version, `username`, a `state` in
   `('pending', 'bound', 'released')`, `created_at`, `bound_at`, `released_at`, `released_by`
   (`'holder'` or the acting admin's account). A partial unique index on the hash
   `WHERE state IN ('pending', 'bound')` is the race arbiter: at most one live row per mailbox.
   No plaintext address column.
2. **Canonical form and key**, one shared module (`backend/src/lib/mailbox-binding.ts`) used by
   every caller: trim; lowercase the whole address; strip the local part from its first `+` to the
   end; keep dots; local part ASCII only (refuse otherwise); domain converted to its lowercased
   ASCII (punycode) form. Key = HMAC-SHA256 of the canonical form under a dedicated secret from a
   new env variable `MAILBOX_BINDING_KEY` (the `.env.example` entry is already in place, architect
   zone); the module exports the current canonicalisation version and stores it on each row. The
   startup checks refuse to boot without the key when `APP_DATABASE_URL` is set.
3. **`POST /api/accreditation/verify`.** After the session gate the sibling task adds
   (`backend-accreditation-verify-requires-the-account-session`), after the existing-accreditation
   and sanction gates (a refused attempt leaves no row) and before any chain write: claim the row
   for (key, `pending.hive_username`).
   - A live row for another account: 409 `MAILBOX_ALREADY_BOUND`, no retry hint, token kept (the
     same link works once that row is no longer live), counter untouched. Response
     `details.bound_to` names the holding account (the verifier has proven mailbox control at this
     point). Message (user-facing, no emdash): "This mailbox already backs another account. Sign in
     to that account and release its accreditation, or contact PEvO."
   - A live row for the same account: proceed (idempotent); a `pending` row is resumed.
   - No live row: insert `pending`. The row exists before the broadcast; it becomes `bound` when
     the broadcast returns. It is deleted only when the node refused the transaction before
     accepting it (a dhive `RPCError`; today `handleBroadcastError` maps every non-timeout throw to
     `'failure'`, so the claim code must tell an `RPCError` from a transport error itself); on a
     timeout or any transport error after the request was sent it stays `pending` and the next
     verification for the same account and mailbox resumes it. 24 h after its latest claim a
     `pending` row becomes `bound` if its account is accredited then (membership rule) and is
     deleted otherwise (sweep in the existing hourly job cadence; the row carries its latest claim
     time).
   - The gate runs against the app database regardless of `isHafConfigured()`; it must not sit
     inside the `if (hafPool)` block. Database unavailable: 503 `SERVICE_UNAVAILABLE`, token kept.
   - The `already_accredited` outcome (account already pinned, no broadcast) claims the row as
     `bound` at once: an already-accredited account verifying a mailbox binds it without a second
     accredit op.
4. **`POST /api/accreditation/request`.** The response is identical whether or not the key is
   live-bound to another account (same 200, same masked address and `expires_at` shape). When it
   is, no token is issued and no pending record is stored; the mail carries the notice instead
   of a verification link: it names the account that holds the mailbox and the ways through (sign
   in to that account and release its accreditation, or contact PEvO), in the same words whether
   or not that account is sanctioned. The limiter counts the request like any other. Builds on the mail body `backend-accreditation-mail-names-the-account` introduces.
5. **Release hooks.** Export a helper that moves every live row of a username to `released`
   (`released_at`, `released_by`); `backend-accreditation-release-op` calls it. A sanction does not
   touch the rows.
6. Comments follow root `CLAUDE.md` "Comment anchors". The stale section header "Token store: app
   database with in-memory fallback" in `routes/accreditation.ts` and the
   `pending_accreditations.email` citation in `lib/log-pii.ts` describe a store that does not
   exist; delete or narrow them while in these files.

## Out of scope

- The release endpoints and the `type: "release"` revoke (`backend-accreditation-release-op`).
- The signup finalize path and `/signup` (`backend-signup-finalize-claims-mailbox-binding`).
- The backfill script and the admin bindings view (`backend-mailbox-binding-backfill-script`,
  `backend-mailbox-binding-history-and-admin-view`).
- ORCID stickiness (`backend-orcid-binding-sanction-sticky`).
- Frontend states (`ui-accreditation-binding-refusal-states`).

## Sequencing

After `backend-accreditation-verify-requires-the-account-session` (the gate order it fixes is the
one this task inserts into) and `backend-accreditation-mail-names-the-account` (the mail body).
`backend-accreditation-limiters-refund-work-already-done` touches the same limiters; if it has not
landed, the new 403 is refunded by `skipFailedRequests` like every 4xx today and that is
acceptable.

## Acceptance criteria

1. Two verifications of one mailbox (any case or `+tag` variant) for two accounts: the first binds,
   the second answers 409 `MAILBOX_ALREADY_BOUND` and the second account is not accredited.
   Concurrent attempts: exactly one row ends `bound`; the partial unique index, not a Redis lock,
   decides.
2. The same account verifying the same mailbox twice answers as today (`already_accredited` or
   `already_landed`) and leaves one `bound` row.
3. A broadcast timeout leaves the row `pending`; a later verification for the same account and
   mailbox completes it; 24 h after its latest claim a `pending` row is `bound` when the account
   is accredited and gone when it is not. A node rejection deletes the row.
4. With the app database down, `/verify` answers 503 and broadcasts nothing; with HAF
   unconfigured the binding gate still runs.
5. `/request` for a bound mailbox returns the same body shape as for an unbound one and sends the
   notice mail; no token is issued and no pending record is stored.
6. Canonicalisation: `A.B+tag@Uni.EDU` and `a.b@uni.edu` map to one key; `a.b@uni.edu` and
   `ab@uni.edu` do not; the shared function refuses what `accreditationRequestSchema`'s email
   rule refuses (non-ASCII, quoted local part, comment); the mail recipient is never derived from
   the folded form.
7. Tests run against the real app database and real HAF (root `CLAUDE.md` "Running Tests"); the
   specs whose focus is the verify gate run the real `verifyHiveSignature`.
8. No emdash in response or mail text.

## [TODO Architect] at archive

- `api-contracts/accreditation.md`: `/verify` gains 409 `MAILBOX_ALREADY_BOUND` with
  `details.bound_to`; `/request` documents the uniform answer and the notice mail; the
  canonicalisation rule; the `/verify` outcome paragraph on legacy revokes gains the binding step.
