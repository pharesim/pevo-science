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

## Architect addition (2026-10-06): two more stale store comments

From the credential-binding grounding (triage "as recommended"):

15. **`routes/accreditation.ts` section header** "Token store: app database with in-memory
    fallback" and the clause "when APP_DATABASE_URL is not configured": the pending record lives in
    Redis (`storeToken`) with an in-process Map, and the file issues no SQL. Delete or narrow.
16. **`lib/log-pii.ts`** cites `pending_accreditations.email NOT NULL`; no such table exists (grep
    over `backend/src` and `backend/migrations`). Delete the citation.

If `backend-mailbox-binding-registry` lands first, its scope item 6 removes both; list them as
already fixed in the signal block.

## Architect addition (2026-10-06): the accreditation test file header

From the re-review of `backend-accreditation-limiters-refund-work-already-done` (user triage: fold
in here).

17. **`backend/tests/routes/accreditation.test.ts` file header, "Mocking justification"
    paragraph.**
    - "The carve-out covers only broadcast error staging" is false. The file also mocks
      `verifyHiveSignature` file-wide through `MOCK_VERIFY_SIGNATURE`, and `findExistingAccreditation`
      through its `lib/idempotency.js` mock, and its `src/hive.js` mock stubs
      `hiveClient.database.getAccounts`. Delete "The carve-out covers only broadcast error staging;".
    - Root `CLAUDE.md` carve-out clause (b): a file that uses `MOCK_VERIFY_SIGNATURE` says in its
      header that cryptographic verification is bypassed and why the focus permits it. Three
      describe-level carve-out blocks further down name the file-level mock (verification mail,
      structured-log emissions, the `accred-req` limiter). The file header and the first
      `describe('POST /api/accreditation/request')` block do not. Add one sentence to the header
      paragraph that says it. Intent only: write the sentence against the specs the file runs.
    - This edits test prose: run `backend/tests/eslint/` alone afterwards and give the result in
      the signal block.

## Architect addition (2026-10-06): three more test-prose items

From the review of `backend-accreditation-verify-requires-the-account-session` (user triage: fold
in here). All three edit test prose: run `backend/tests/eslint/` alone afterwards and give the
result in the signal block.

18. **`backend/tests/routes/accreditation.test.ts`, "INTENTIONAL RED".** The file header has a
    paragraph starting "INTENTIONAL RED in this file", and the redaction-negative assertion in the
    cleanup-failure spec carries "INTENTIONAL RED until pino redact covers `err.command.args`
    (deferred follow-up)." Both specs the paragraph names pass at `ef1cbdbd` (the review ran the
    file; only the two cap specs fail). Delete the paragraph and that sentence.
19. **`backend/tests/routes/accreditation-idempotency.test.ts`, the comment above `fakePipeline`.**
    Delete the sentence starting "Typed as `ChainableCommander` so a future pipeline step". The
    stub is cast with `as unknown as ChainableCommander`, so the compiler checks no method on it,
    and the route's `try` catches a missing method's TypeError the same way it catches the
    stub's rejection.
20. **`backend/tests/routes/misc.test.ts` has no carve-out header.** The file mocks
    `verifyHiveSignature` with `MOCK_VERIFY_SIGNATURE` for every spec. Root `CLAUDE.md` "Running
    Tests" clause (b) requires a header that says cryptographic verification is bypassed, why the
    focus permits it, and the real-path companion (clause (c)). For the `/verify` specs the
    companion is `accreditation-idempotency.test.ts`. Intent only: write the header against the
    specs the file runs.

## Architect addition (2026-10-08): the `accreditation_method` docblock

Filed from the architect review of `backend-wot-auto-accredit-reads-stale-membership`.

21. **`VouchStatus.accreditation_method` docblock (`backend/src/wot.ts`).** It says the field is
    "`null` if the account has no current, not-sanctioned `accredit` op". The field is also null
    when that op carries no `method`: it is the `method` column of the `accred_pinned` row, as the
    `VouchSnapshot` docblock and the method-less spec in
    `backend/tests/wot-vouch-status-select-real-postgres.test.ts` show. Add "or that op carries no
    `method`" to the end of that clause. Change nothing else in the docblock.
