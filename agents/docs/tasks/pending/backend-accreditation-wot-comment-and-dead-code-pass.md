# Accreditation and WoT source comments describe removed or different behaviour

**Owner:** backend
**Created:** 2026-10-05
**Priority:** deferred (until every other backend task filed from the accreditation and WoT audit on 2026-10-05 is archived)

Filed from the accreditation and Web of Trust audit (findings 11, 12, 13, 14, 16, 17, 19, 21, 22
and 23). These were not in the validator batch; the report writer re-read every cited line.

The tasks this one waits for edit the same files and rewrite some of the neighbouring comments:
`backend-accreditation-limiters-refund-work-already-done`,
`backend-accreditation-mail-names-the-account`,
`backend-accreditation-verify-requires-the-account-session`,
`backend-latest-op-haf-lookups-walk-the-blocks-index`,
`backend-verify-gate-treats-wot-enrollee-as-accredited`,
`backend-verify-cap-keeps-a-refused-claim`,
`backend-accreditation-request-stores-unread-fields`,
`backend-wot-auto-accredit-reads-stale-membership` and
`backend-wot-enrollment-has-a-single-trigger`.

## How to work this task

- Every item below was true of commit `9d4325fc`. Re-check each against the code when you pick
  the task up. Skip an item an earlier task already fixed, and list it as skipped in the signal
  block.
- Delete or narrow. Add no sentence beyond what an item names. Do not change behaviour: the only
  code this task removes is the one unused export in item 10.

## Items

### `backend/src/routes/wot.ts` and `backend/src/wot.ts` (finding 19)

No WoT path broadcasts a revoke any more: `/retract` broadcasts nothing.

1. The comment on `wotWriteLimiter` says "Both trigger an admin broadcast (auto-accredit /
   revoke)" and ends "defense-in-depth around the retraction-verification gate". Only `/vouch`
   can trigger an admin broadcast. Say that, and delete the retraction clause.
2. The `pollForRetraction` docblock: delete from "The caller treats" through "never broadcast."
3. The `/retract` handler's gate comment: delete "Gating the signer also narrows who can reach
   the revocation path."
4. In `getVouchStatus`, the comment on the combined read ends "(see that builder's docblock for
   the single-snapshot / aggregate-over-empty-set invariants the retract path depends on)".
   Delete the parenthesis.

### `backend/src/routes/accreditation.ts`

5. **Token store (finding 17).** The section header says "Token store: app database with
   in-memory fallback" and the `memoryTokens` comment says "In-memory fallback when
   APP_DATABASE_URL is not configured". The store is Redis, this file never touches the app
   database, and `storeToken` writes the map on every request. Name Redis in the header and
   delete the `APP_DATABASE_URL` clause.
6. **Retry envelope (finding 17).** Two comments, on the gate-hit branch and on the per-token
   idempotency-hit branch, say a retry returns "the identical 200 envelope". The completion
   record stores `username` and `tx_id` only, so the retry's 200 has no `outcome`. Replace
   "identical 200 envelope" with wording that names those two fields, or delete the claim. The
   third use of the phrase, on the fresh-broadcast path, is correct: that first response has no
   `outcome` either.
7. **Removed things still cited (finding 16).**
   - The comment above `ACCREDITATION_COMPLETED_TTL_SECONDS` says "WoT-revoke is an
     operator-only-reversible action". There is no WoT revoke. Drop "WoT-".
   - The `/verify` handler's grace-period comment sends the reader to "the
     `memoryAccreditationCompletions` declaration block" for the trade-off rationale. That
     rationale is in the comment above `ACCREDITATION_COMPLETED_TTL_SECONDS`.
   - The gate-hit comment says the gate "preserves the re-accreditation path after a revoke: that
     flow DOES rebroadcast". A sanction revoke is refused by the guard that follows. Narrow "a
     revoke" to a legacy (non-sanction) revoke.
   - In `decrementBroadcastAttempts`, "the hit-branch caller (and any future caller)": the only
     caller is the timeout branch. Say "the caller".
   - Delete the line "Inlined from the prior `logIdempotencySkip` helper." No such symbol exists.
   - The cap-exceeded comment lists event anchors "in routes/orcid.ts and lib/broadcast-error.ts".
     `routes/orcid.ts` emits none of the events it names. Drop "routes/orcid.ts and".
8. **Coordination anchor (finding 22).** The `recordAccreditationCompletion` docblock says
   "returns 400 same as today (the pre-task baseline)". Cut it to "returns 400".
9. **Best-effort wrappers (finding 23).**
   - The `deleteTokenBestEffort` docblock says it serves the "200 success and idempotency-hit
     paths on /verify". Its `/verify` callers are the idempotency-hit branch's seed-error path and
     the `post_broadcast` branch, each after a 502 has been written. Correct the caller list and
     drop the "on the success branches" clause.
   - The `recordAccreditationCompletionBestEffort` docblock says a throw would reach Express's
     async-error handler and surface as `ERR_HTTP_HEADERS_SENT`. Each of its three calls is
     awaited before `sendOk`, inside a `try` whose `catch` would take the throw. Delete those
     sentences. Keep "The wrapper always returns; failures emit a structured warn".
   - Two inline comments repeat the claim. The success-path comment says a Redis hiccup "must
     NOT propagate to Express's async-error handler over the in-flight 200 envelope". The
     idempotency-hit branch's seed-error comment says re-throwing "would propagate to the Express
     async-error handler"; a throw there is inside the `try` whose `catch (lookupErr)` would take
     it. Delete both clauses.

### `backend/src/email-validator.ts`

10. **Unused export (finding 14).** `_resetRulesCache` in `backend/src/email-validator.ts` is
    documented as "for testing", and no source or test file references it. Re-run the grep, then
    delete the function and its one-line docblock.
### `backend/src/accreditation.ts`

11. **`getAccreditedSet` docblock (finding 12).** It says the helper "feeds per-request display
    enrichment (stats.ts, papers.ts, profile.ts, comments.ts, reviews.ts)". Write gates read it
    too (the WoT, bridge, claims, ORCID and metadata-edit routes), and `stats.ts` does not call
    it. Delete the file list and the display-only framing. Its "Strategy: HAF SQL batch query"
    line leaves out the cached fast path; narrow it to name both.
12. **`getAllAccreditedAccounts` docblock (finding 13).** It names "the expensive
    ACTIVE_ACCREDITATIONS_CTE". No such symbol exists. Name `activeAccreditationsCteBody`.
13. **`getAllEverAccreditedOrcidsWithStatus` docblock (finding 21).** Delete the parenthesis
    "(existing rule #3 behavior)". Nothing numbered 3 in the ARCHITECTURE section the docblock
    names is about the ORCID override.
14. **`hasUnliftedSanction` docblock (finding 11).** It says "This is the same suppression
    predicate `activeAccreditationsCteBody` applies, scoped to one account." The CTE compares
    `(block_num, op_id)` pairs; this helper compares block numbers only and reads a same-block
    sanction and grant as sanctioned. Delete the sentence. Leave the SQL comment about the
    non-`wot` filter: that part does match the CTE. No code change is asked for here.

## Acceptance criteria

1. Each item is done, or listed in the signal block as already fixed by an earlier task.
2. Apart from item 10, the diff changes comments only.
3. `backend/tests/eslint/no-stale-comment-anchors.test.ts` is green, and comments follow root
   `CLAUDE.md` "Comment anchors".
