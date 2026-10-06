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
- `/ce-compound-refresh` on `deferred-refund-gate-must-check-writableEnded-not-just-statusCode-2026-05-17.md`:
  it treats a client abort as an outcome to refund, which on `/request` was the abuse hole.

## Backend implementation signal (2026-10-06, commit f748b67c)

Landed in `f748b67c` (`git merge-base --is-ancestor f748b67c main` checked).

**Scope**
1. `/request`: `accreditationRequestLimiter` uses `refundStatusCodes: [422, 500]`.
2. `/verify`: `accreditationVerifyLimiter` uses `refundStatusCodes: [503, 504]`.
3. Both limiter comments are cut down to the new refund sets. The `/verify` "The 4xx refund is acceptable here because `BAD_REQUEST` is the only client-error path" sentence and the `/request` claim that a 400 validation refunds are deleted. The two route-site comments (`POST /api/accreditation/request`, `POST /api/accreditation/verify`) also lost their pointer to the `skipFailedRequests` layered-pattern obligation. That obligation applies to limiters that set `skipFailedRequests`, and these two no longer do.

**Acceptance criteria → specs**
- AC1: `accreditation.test.ts` "a client that disconnects while the mail is being sent consumes its slot; after three such requests the next answers 429". A real `http.request` is destroyed while `sendMail` is pending, so the token is stored and the mail is in flight.
- AC2: the existing "three SMTP-failure 500s ..." and "three 422 non-institutional-email responses ..." specs, now in the describe `accred-req limiter: 422 and 500 refund the slot, a client abort consumes it`.
- AC3, consume: `accreditation.test.ts` "a 400 invalid-token answer consumes a slot ..." and "the cap 502 BROADCAST_ATTEMPT_LIMIT_EXCEEDED consumes a slot", plus `accreditation-verify-sanctioned.test.ts` "the 403 consumes a /verify limiter slot".
- AC3, refund: "a 504 BROADCAST_TIMEOUT refunds its slot" in `accreditation.test.ts`. The 503 refund is pinned by the existing `accreditation-idempotency.test.ts` spec "503 ACCREDITATION_GATE_UNAVAILABLE refunds the per-IP limiter slot". A duplicate 503 spec in `accreditation.test.ts` was dropped at the simplify pass, because that file's header hands gate-throw coverage to the idempotency file.
- AC4: comments checked against root `CLAUDE.md` "Comment anchors". The pre-commit anchor gate passed.

**Verification**
- Red before the fix. Against the unchanged limiters, the four consume specs failed for the expected reason:
  - abort: 200, expected 429
  - 400: 400, expected 429
  - cap 502: 502, expected 429
  - sanctioned 403: 403, expected 429
- The refund specs (422, 500, 503, 504) passed before and after, as characterization.
- After the fix, each affected file was run alone: `accreditation.test.ts`, `accreditation-verify-sanctioned.test.ts`, `accreditation-idempotency.test.ts`, `misc.test.ts`, `bridge-register-rate-limit-skip-failed.test.ts`, `custody-limiter-cpu-amplification.test.ts`, `lib/logger-redact`, `lib/idempotency`, `lib/pending-decrement-queue`, `middleware/rateLimit`, `middleware/rateLimit-in-memory`.
  - The only failures are the clean-main ones, identical to a baseline run at `9f735dfd`: the two per-token cap specs in `accreditation.test.ts` and the six `accreditation-idempotency.test.ts` specs.
  - No existing spec started getting 429s now that 400s and 502s consume.
- `npm run typecheck` and eslint on the changed files are clean.
- Mutation matrix. Run in an isolated `git archive` copy on Redis DB 6, `--retry=0`. Each mutant is killed by the spec named for it, and the control is green:

  | Mutant | Killed by |
  |---|---|
  | `/request` [500] | the 422 spec |
  | `/request` [422] | the 500 spec |
  | `/request` reverted to `skipFailedRequests` | the abort spec |
  | `/verify` [504] | the 503 spec |
  | `/verify` [503] | the 504 spec |
  | `/verify` +400 | the 400 spec |
  | `/verify` +403 | the 403 spec |
  | `/verify` +502 | the cap spec |
  | `/verify` reverted to `skipFailedRequests` | the 400, 403 and cap specs |

  The abort spec was re-probed after the simplify pass: control green, the `skipFailedRequests` mutant red.

**Sibling-test prose this change made false, narrowed or deleted:**
- `accreditation-idempotency.test.ts`: the 503 canary's comment, title and inline note no longer say the limiter declares `skipFailedRequests`.
- `bridge-register-rate-limit-skip-failed.test.ts`: the header clause citing `accreditationVerifyLimiter` as its per-IP `skipFailedRequests` precedent is deleted.
- `custody-limiter-cpu-amplification.test.ts`: the carve-out (c) item pointed at the deleted "4xx-refund canaries". It is deleted; its (b) already names the real-path `verifyHiveSignature` companions.

**User decision (2026-10-06).** Three of the new consume specs hold a nearly full `/verify` bucket in Redis while one request runs a slow real-HAF lookup (about 7-18 s): the 400-prefilled cap 502, the sanctioned 403, and to a lesser degree the 400. In the full suite, a concurrent file's `tests/setup.ts` flush, or `accreditation-idempotency.test.ts` deleting `rl:accred-verify:*`, can wipe that bucket mid-spec. vitest retries 3 times with a fresh IP each time. The user chose to accept the exposure and note it here. `backend-latest-op-haf-lookups-walk-the-blocks-index` shortens the window to about 0.1 s.

**Out-of-scope observations, for follow-up filing if wanted**
1. The SPA aborts every fetch at 30 s (`DEFAULT_TIMEOUT_MS` in `frontend/src/api.js`). The `/verify` broadcast timer (`DEFAULT_BROADCAST_TIMEOUT_MS`, 30 s) only starts after the HAF reads. So when a slow `/verify` reaches the 504, the SPA has usually aborted already, and the abort consumes the slot. The 504 refund therefore helps SPA traffic only when the reverse proxy does not pass the client abort on to the backend, which was not checked, as in the task. One tab cannot reach the 5-per-minute cap alone: 30 s timeout plus a 5 s cooldown is about 2 requests a minute. Reloads, repeated link opens or a shared IP can.
2. `frontend/src/pages/accreditation-verify.js` shows a 429 `RATE_LIMITED` as the terminal `error` state with "Request new", because the 429 carries no `details.retriable`. Clicking "Request new" spends a `/request` slot although the token is still valid. This is ui zone.
3. Pre-existing and left alone: the `accreditation.test.ts` file header says "verifyHiveSignature is NOT involved here", but the file mocks it through `MOCK_VERIFY_SIGNATURE` for `/request`.

**[TODO Architect] addition.** The same solutions entry, `skip-failed-requests-jwt-required-credential-verify-carve-out-2026-05-17.md`, also names `accreditation-request` in its triage list ("No (one-shot ceremony like upgrade, accreditation-request) → adopting `skipFailedRequests` is non-controversial"), not only in its audit grid. No api-contracts change is needed: `accreditation.md` states no refund policy.

## Architect re-review (2026-10-06) — HELD PENDING FIXES:

Reviewed `f748b67c` with `/ce-code-review` (correctness, security, adversarial, testing, reliability, project-standards, learnings; the one finding was confirmed by an independent validator). Scope 1-3 and AC1-AC4 are met. The testing reviewer re-measured four of the nine mutant kills (`/request` back to `skipFailedRequests`, `/verify` +403, `/verify` +502, `/verify` [503] only), and each was killed by its named spec. Three items:

1. **The backend suite is red: lower the canary pin.** Deleting the clause-(c) `Real-path companion:` claim from the `custody-limiter-cpu-amplification.test.ts` header was right, but `tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts` pins each file's count of unstructured companion claims and still pins that file at 2. Its spec "every file-naming prose claim is in the backlog at exactly its pin, bounded by the landing snapshot" fails at `f748b67c` and on `main` ("1 unstructured companion claim(s) remain, pinned at 2"); it passes 12/12 at the base `278b6490`. In `DEFERRED_FREE_PROSE`, change `'backend/tests/routes/custody-limiter-cpu-amplification.test.ts': 2,` to `'backend/tests/routes/custody-limiter-cpu-amplification.test.ts': 1,`. Leave that file's entry in `LANDING_FREE_PROSE` at 2. The signal's per-file runs did not include `tests/eslint/`: run that directory alone too, and give its result in the signal block.
2. **Narrow the `accreditationRequestLimiter` comment.** Replace "the handler still stores the token and sends the mail" with "the handler keeps running", and change nothing else in that comment. When the client closes first and `sendMail` then fails, the slot was already settled as consumed at the `close` event (status still 200) and no mail goes out, so the current clause also claims that case.
3. **Delete one false sentence from the `accreditation.test.ts` file header** (your out-of-scope observation 3). In the "Mocking justification" paragraph, delete "verifyHiveSignature is NOT involved here (the /verify route is rate-limited but not auth-gated)." and change nothing else. The paragraph then reads "...reproduced against real Hive). The carve-out covers only broadcast error staging; ...". The file does mock `verifyHiveSignature`, through `MOCK_VERIFY_SIGNATURE` on `/request`.

The three edits together were planted on a `git archive` copy of `main`'s backend at `64bca0fb`: `tests/eslint/` passes 146/146 with them. Items 2 and 3 are comment-only and need no new spec.

Triage of the rest (user, 2026-10-06):
- Accepted, not fixed here: `/verify` is keyed by IP and now counts junk-token 400s, so a client that shares an IP with the user (behind a NAT, for example) can keep that IP at 429. AC3 asks for the 400 to consume. A note on `backend-accreditation-verify-requires-the-account-session` asks for the limiter to be keyed by account once that route requires a session.
- Dismissed: no spec runs the real `verifyHiveSignature` on `/request` (true before this commit too); the verify page's "Request new" after a 429 spends a `/request` slot on a token that is still valid (your observation 2); the 504 refund on a broadcast whose outcome is uncertain (the task prescribed it, and the base behaved the same way); your observation 1.
