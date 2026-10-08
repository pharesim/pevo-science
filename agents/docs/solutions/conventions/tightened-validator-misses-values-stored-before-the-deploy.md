---
title: A tightened request validator does not reach values stored under the old rule; enumerate the stores a later consumer reads, not only the routes
date: 2026-10-08
category: conventions
module: backend/src/routes
problem_type: convention
component: authentication
severity: medium
root_cause: incomplete_enumeration
applies_when:
  - A validator, gate or normalisation step is added or tightened on a route whose value is stored and consumed by a later request
  - The later consumer writes somewhere expensive or impossible to correct, such as a chain broadcast, an outbound mail or a signed attestation
  - A fix or a review claims that every write path is covered by a new request-time rule
tags:
  - validator-tightening
  - persisted-state
  - deploy-window
  - pending-token
  - writer-completeness
  - redis-ttl
  - accreditation
  - custom-json
---

# A tightened request validator does not reach values stored under the old rule; enumerate the stores a later consumer reads, not only the routes

## Context

A fix tightened the character rule on the request schemas whose values end up in an admin-signed accreditation grant (the `accredit` custom_json): `accreditOpText` in `backend/src/validation.ts`, applied to `accreditationRequestSchema` and `adminAccreditationGrantSchema` there and to `SignupBodySchema` in `backend/src/routes/auth.ts`. It rejects control characters, bidi embedding/override/isolate characters and unpaired surrogates. The implementer enumerated every live write path that takes the text from a request or an ORCID profile and closed each one, and the specs proved that every new request carrying such a character is refused.

An adversarial path-completeness review still found a gap. Three of those write paths do not broadcast the request body. They broadcast a value that an earlier request stored, and nothing checks it again at broadcast time:

- `POST /api/accreditation/verify` broadcasts `pending.full_name`, `pending.institution` and `pending.field` from the token that `/request` wrote with `storeToken` (Redis key `${appTag}:pending_accred:<token>`, TTL from `TOKEN_EXPIRY_MS`, 24 hours) and reads back with `getToken`.
- `broadcastAccreditationAndSeed` in `backend/src/routes/signup-verify.ts` (`/confirm`, `/link`) broadcasts `account.full_name`, `institution` and `field` from the pending `accounts` row `/signup` wrote. `ABANDONED_ACCOUNT_ROWS` in `backend/src/signup-cleanup.ts` deletes an unverified row after its 24-hour expiry, and keeps a verified-but-incomplete row for 30 days.
- The ORCID callback stores the profile name under `${appTag}:orcid_verified:<nonce>` (`ORCID_VERIFIED_TTL`, 30 minutes), and `/api/auth/signup` reads it back as the fallback `full_name`. The callback now stores the rewritten name; entries stored before the deploy hold the raw one.

`./deploy.sh restart` swaps only the backend container; Redis and Postgres keep running. Every value stored under the old rule therefore survives the deploy and reaches the new code's broadcast unchecked, until its TTL or the cleanup job removes it. The implementer's path enumeration missed this because it traced write paths back to the route that receives the text, not to the store the broadcasting route actually reads.

The same class has come up before (session history). A change that made reset tokens die with the address and password they were mailed for left tokens mailed before the deploy uncleared, and a reviewer logged that only as a residual risk. A change that made signup verification require the signup password met pending rows whose password hash was NULL; no live writer produced that shape any more, so the guard at the consuming route protected only rows already stored, and it was written as a fail-closed branch there rather than as a data migration.

## Guidance

When a change tightens what a request may carry, and the validated value is persisted before a later step consumes it (a Redis token, a pending DB row, a mailed link), enumerate the stores as well as the routes:

1. For each consumer of the tightened value, ask where it reads the value from. If the answer is a store a previous request wrote, values written under the old rule are still there after the deploy.
2. Bound the window: the store's TTL, or the cleanup job's retention, starting at the moment the new code is live (not at the commit).
3. Decide what a stored old-rule value can do in the consumer. Check what each store can physically hold. In this case the `pending_accred` token in Redis held the raw JSON, so a `\u0000` or lone-surrogate escape round-tripped intact and `/verify` broadcasts it directly. Postgres `TEXT` rejects NUL (`invalid byte sequence for encoding "UTF8": 0x00`), and UTF-8 encoding turns a lone surrogate into U+FFFD, so the pending `accounts` rows, and a stored ORCID name, which reaches the grant only through such a row, could carry only control characters other than NUL, line or paragraph separators and bidi controls, none of which breaks jsonb.
4. Then pick one of:
   - **Accept the window.** Check the live stores read-only before deciding (a `redis-cli --scan --pattern '<appTag>:pending_accred:*'` and a `GET` per key, and a read-only `SELECT count(*) ... WHERE <rule violated>` on the pending rows), and redeploy promptly so the window closes on schedule.
   - **Re-check at consumption.** Run the same rule on the stored value right before the consumer uses it, and on failure refuse and discard the stored value (the user starts the flow again). This is permanent defense in depth, and it also covers any future writer of the store that skips the request schema.

Whichever is chosen, say so where the reviewer will look (the task's signal block), because neither the final code nor the specs show that the stored-value window was considered.

## Why This Matters

The tightened rule exists because the consumer's output is hard to undo. Here it is an authority-signed custom_json: PostgreSQL's jsonb input refuses the `\u0000` and lone-surrogate escapes `JSON.stringify` writes, so one such op on chain makes every HAF query that casts that row throw, and the op cannot be removed. A request-time rule that passes every spec still lets that op through from a token stored an hour before the deploy. The gap is invisible to specs written against the new code, because those specs create their input through the new schema.

## When to Apply

- A validator, gate or normalisation step is added or tightened on a route whose value is stored and consumed by a later request.
- The consumer writes somewhere that is expensive or impossible to correct: a chain broadcast, an outbound mail, a signed attestation.
- A review claims that every write path is covered. Ask whether the enumeration followed the value back to its store or only to the route that first received it.

## Examples

Enumeration that misses the stored-value path:

```
accredit name  <-  /verify handler  <-  POST /request body  (now validated)
```

Enumeration that finds it:

```
accredit name  <-  /verify handler  <-  getToken()  <-  Redis pending_accred:<token>
                                                         <-  storeToken() at /request
                                                              (old rule until the deploy, TTL 24h)
```

A broadcast-time re-check, if the window is not accepted, reuses the same rule the request schema applies:

```ts
const opText = accreditOpText(z.string());
if (![pending.full_name, pending.institution, pending.field].every((v) => opText.safeParse(v).success)) {
  await deleteToken(pending.token);
  return sendError(res, 400, 'BAD_REQUEST', 'Please request accreditation again.');
}
```

## Related

- [reputation-scores-frozen-after-calc-deploy-reset-cycle-last-2026-06-15.md](reputation-scores-frozen-after-calc-deploy-reset-cycle-last-2026-06-15.md): the same deploy-versus-stored-state class for the reputation batch, also triaged with read-only `redis-cli` reads before touching code.
- [mailed-credential-token-dies-with-its-address-and-credential.md](mailed-credential-token-dies-with-its-address-and-credential.md): a stored token redeemed later outlives the conditions it was issued under.
- [normalize-before-hash-gate-admits-denormalized-payloads-2026-06-10.md](normalize-before-hash-gate-admits-denormalized-payloads-2026-06-10.md): a gate that checks at issuance while the stored raw value is what gets broadcast.
- [sidecar-index-writer-completeness-2026-06-12.md](sidecar-index-writer-completeness-2026-06-12.md): an invariant holds only if every writer keeps it, or the read path heals divergence; values written before the deploy are writers that never ran the new rule.
- [helper-contract-flip-untouched-adopter-audit-2026-05-16.md](helper-contract-flip-untouched-adopter-audit-2026-05-16.md): a contract change reaches adopters the diff never touched, including stale values persisted in a store.
- [completeness-claim-tasks-need-independent-re-enumeration-2026-06-14.md](completeness-claim-tasks-need-independent-re-enumeration-2026-06-14.md): the review-side rule for re-enumerating an "every writer" claim.
