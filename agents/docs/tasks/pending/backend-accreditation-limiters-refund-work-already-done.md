# The two accreditation limiters refund requests that already did their work

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Filed from the accreditation and Web of Trust audit (findings 2 and 8). The validator confirmed
both from the code. Incidence was not measured.

## Why

Both accreditation limiters in `backend/src/routes/accreditation.ts` set
`skipFailedRequests: true`. `shouldRefund` in `backend/src/middleware/rateLimit.ts` then gives the
slot back for every response that is not a finished success: any status of 400 or above, and a
connection that closed before the response ended.

1. `accreditationRequestLimiter` (`/request`, 3 per 24 h per account). A client that closes the
   connection before the response ends gets its slot back, while the handler keeps running: it
   stores the token and sends the mail. `/api/accreditation` is mounted without another limiter
   (`backend/src/app.ts`). So one signed-in account can send verification mails without limit, to
   any institutional address, each carrying the `full_name` text it chose. Whether this
   deployment's reverse proxy passes a client abort on to the backend socket was not checked.
2. `accreditationVerifyLimiter` (`/verify`, 5 per minute per IP). The 403
   `ACCREDITATION_SANCTIONED` answer comes after two HAF reads (`findExistingAccreditation`,
   `hasUnliftedSanction`), and the 502 `BROADCAST_ATTEMPT_LIMIT_EXCEEDED` answer after the
   per-token lookup as well. Both leave the token alive and both are refunded, so a caller holding
   such a token is not throttled. The limiter's comment says `BAD_REQUEST` is the only
   client-error path and that it returns before the HAF probes. A closed connection is refunded
   here as well, and the handler still runs on to the broadcast.

`refundStatusCodes` on the same limiter refunds only the listed statuses. A request that closes
before any status is set keeps the default 200 and is not refunded.

## Scope

1. `/request`: replace `skipFailedRequests` with `refundStatusCodes: [422, 500]`.
   - 422 is the non-institutional-address refusal, returned before the token is stored.
   - 500 is the answer of the two SMTP branches (send failed, SMTP host not configured), each
     after a best-effort delete of the token.
   - An aborted request consumes its slot.
2. `/verify`: replace `skipFailedRequests` with `refundStatusCodes: [503, 504]`.
   - The two 503 answers (`ACCREDITATION_GATE_UNAVAILABLE`, and `SERVICE_UNAVAILABLE` from the
     counter claim) return before any broadcast.
   - 504 is the broadcast timeout, after which the route keeps the token for a retry.
   - 400, 403, 500 and 502 consume a slot.
3. Cut both limiter comments down to the new refund sets. Delete in particular the `/verify`
   sentence that begins "The 4xx refund is acceptable here because `BAD_REQUEST` is the only
   client-error path", and the `/request` claim that a 400 validation refunds the slot:
   `validate` runs ahead of the limiter in the middleware chain, so a 400 never reaches it.

## Out of scope

- `rateLimit.ts` itself, and other routes that use `skipFailedRequests`.
- Requiring a session on `/verify` (`backend-accreditation-verify-requires-the-account-session`).

## Acceptance criteria

1. A `/request` whose client aborts before the response has consumed a slot: after three such
   requests in the window, the next answers 429.
2. A `/request` that answers 422 or 500 leaves the slot free.
3. On `/verify`, a 400, the sanctioned 403 and the cap 502 each consume a slot; a 503 and a 504
   leave it free.
4. Comments follow root `CLAUDE.md` "Comment anchors".

## [TODO Architect] at archive

- `/ce-compound-refresh` on `skip-failed-requests-jwt-required-credential-verify-carve-out-2026-05-17.md`:
  its audit grid lists both limiters as correct adoptions.
