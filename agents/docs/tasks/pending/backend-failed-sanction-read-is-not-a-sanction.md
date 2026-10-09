# A failed sanction read answers a retriable 503, not a sanction refusal

**Owner:** backend
**Created:** 2026-10-06
**Priority:** high

Filed from the architect review of `ui-accreditation-binding-refusal-states` (finding #1, P1,
decided with the user 2026-10-06). Rule: `ARCHITECTURE.md` "Data Source Policy", item 1: when HAF
cannot answer a read, the request fails with a retriable 503 and never a substitute answer.

## Why

`hasUnliftedSanction` (`backend/src/accreditation.ts`) returns `true` when `getPool()` is null or
the query throws, the same value it returns for a real sanction, and every HTTP caller answers
that with 403 `ACCREDITATION_SANCTIONED`. At signup finalize the SPA routes that 403 to a final
"not eligible for accreditation" screen with no retry (`_handleFinalizeRefusal` in
`frontend/src/pages/signup-verify.js`), so a HAF outage tells a new user their account is not
eligible. On `/confirm` the account is minutes old and cannot carry a sanction. Before that SPA
change, re-submitting reached the 1-hour stuck-resume branch and recovered. The comment in
`backend/src/routes/accreditation-metadata.ts` accepts the misleading 403 because it resolves on
the client's next retry; at finalize there is no longer a next retry.

## Scope

1. Give the sanction read an outcome that tells "sanctioned", "not sanctioned" and "could not
   read" apart (a tri-state return or a throwing variant, your choice). `backend/src/wot.ts` keeps
   refusing the auto-accreditation on a failed read.
2. The HTTP callers answer a 503 with `details.retriable: true` on "could not read", broadcast
   nothing, and keep 403 `ACCREDITATION_SANCTIONED` for a real sanction:
   - `broadcastAccreditationAndSeed` in `backend/src/routes/signup-verify.ts` (`POST /api/auth/confirm`,
     `POST /api/auth/link`);
   - `POST /api/accreditation/verify` in `backend/src/routes/accreditation.ts`;
   - the ORCID callback in `backend/src/routes/orcid.ts`;
   - `PATCH /api/accreditation/metadata` in `backend/src/routes/accreditation-metadata.ts`.
3. Rewrite or delete the accepted-tradeoff comment in `accreditation-metadata.ts` so it says what
   the handler then does. The `getAccreditedSet` safe-fail it also names is out of scope here (see
   below).
4. Comments follow root `CLAUDE.md` "Comment anchors".

## SPA consumers

Each route's SPA consumer must show an error with a retry for the 503. Known today: the verify page
routes `details.retriable: true` to its retry state (`_isRetriable` in
`frontend/src/pages/accreditation-verify.js`); on `/confirm` and `/link` the signup-verify page
falls to its generic failure, where submitting again retries. Check the ORCID callback page and the
metadata edit consumer (`frontend/src/api.js` `/accreditation/metadata`) and name any that offer no
retry in the signal block, for a ui task.

## Out of scope

- Other HAF reads that substitute an answer on failure, `getAccreditedSet`'s empty set among them:
  `architect-haf-outage-sweep`.

## Acceptance criteria

1. With the HAF pool absent, or the sanction query failing, each of the five endpoints answers a
   503 with `details.retriable: true` and broadcasts nothing.
2. A real sanction still answers 403 `ACCREDITATION_SANCTIONED` on each.
3. The wot path still refuses on a failed read.
4. After the 503 on `/confirm` and on `/link`, submitting again once HAF answers finalizes the
   accreditation and issues the session.
5. Tests on the real app database and real HAF; the failure path may mock the HAF pool under the
   root `CLAUDE.md` carve-out, with the header justification.

## [TODO Architect] at archive

- The 503 on each endpoint in `api-contracts/auth.md`, `api-contracts/accreditation.md` and
  `api-contracts/orcid.md`, and in `common.md`'s list of `details.retriable` emitters.

## Architect note (2026-10-08): a clause (c) companion for the WoT sanction mock

From the architect review of `backend-wot-auto-accredit-reads-stale-membership`.
`backend/tests/wot-broadcast-timeout.test.ts` mocks `hasUnliftedSanction`, and no test runs that
function's query unmocked. Root `CLAUDE.md` "Running Tests" clause (c) asks for a real-path test of
the same risk class, or a filed task. The real-sanction spec AC2 and AC5 ask for is that test if it
reaches `hasUnliftedSanction` unmocked. When it lands, add a second `Real-path companion:` line
naming it to the header of `wot-broadcast-timeout.test.ts`, in the form of the line already there,
and run `tests/eslint` alone.

## Backend implementation signal (2026-10-09, commits 4ccf730e, 74c796e8, f227f2e5)

All three are on main (`git merge-base --is-ancestor`) and carry this task's work: 4ccf730e the
change and its specs, 74c796e8 the token-limiter refund and a missing real-Postgres case (both from
the verification pass below), f227f2e5 a simplify pass (comments and test tidying, no behaviour
change).

**What landed.** `hasUnliftedSanction` (boolean, fail-closed) is now `readSanctionState`
(`backend/src/accreditation.ts`), answering `sanctioned`, `not_sanctioned` or `haf_unavailable` (no
HAF pool, or the query throws). New export `SANCTION_READ_UNAVAILABLE_MESSAGE`. Scope 1: a tri-state
return, not a throwing variant. Scope 2: on `haf_unavailable`, `broadcastAccreditationAndSeed`
(`/confirm`, `/link`), `POST /api/accreditation/verify`, ORCID `handleAccredit` and
`PATCH /api/accreditation/metadata` answer 503 `SERVICE_UNAVAILABLE`, `details.retriable: true`,
`Retry-After: 30`, and broadcast nothing; `sanctioned` still answers 403 `ACCREDITATION_SANCTIONED`.
`broadcastWotAccreditation` returns `reason: 'skipped'` on `haf_unavailable` (the outcome a failed
vouch-status read already gets there; its only consumer collapses both into the generic `/vouch`
200). Scope 3: the metadata tradeoff comment now confines the accepted 403 to `getAccreditedSet` and
says the sanction read answers the 503.

**Acceptance criteria.**
1. 503 + retriable + no broadcast on each endpoint, failed query and absent pool:
   - `/confirm`, `/link`: `tests/routes/signup-verify-sanction-read-unavailable.test.ts` (new; real
     app DB, real HAF, `getPool` wrapped so only the `acct_ops` query rejects, or returns null).
   - `/verify`: 'sanction read throws → retriable 503 SERVICE_UNAVAILABLE, token kept, no broadcast,
     no cap INCR' and the reworked 'HAF unconfigured — retriable 503, ...'
     (`accreditation-idempotency.test.ts`, real function over the mocked pool).
   - ORCID: the 'answers a retriable 503 when %s (no broadcast)' pair in `orcid.test.ts` (real
     function, failing query and null pool).
   - Metadata: 'JWT path: a sanction read that cannot be made returns a retriable 503 (not 403)
     WITHOUT burning the proof'. With no pool the earlier `getLatestAccreditOp` gate already
     answers its retriable 503, pinned by the existing op-read specs.
2. Real sanction 403 on each: existing specs, now on `'sanctioned'`; `/link` had none, added
   ('refuses the accreditation broadcast for a sanctioned account ...' in
   `signup-verify-stuck-recovery.test.ts`).
3. WoT: 'skips (no broadcast) when the sanction read cannot be made' (`wot-broadcast-timeout.test.ts`,
   real function).
4. After the 503 the account is finalized; resubmitting reaches the stuck-resume lookup and gets
   200 + JWT with one accredit broadcast, on `/confirm` (posting-key proof) and `/link` (fresh
   signature). Pinned in the new route file, including six 503s on one `auth_token` followed by the
   successful retry.
5. Real app DB and real HAF; the failure paths mock the pool, except the metadata file, whose
   carve-out already stubs every HAF read and now stubs the outcome. `readSanctionState`'s own SQL
   runs unmocked in `tests/sanction-read-real-postgres.test.ts` (new): synthetic ops on real
   Postgres (no ops, sanction alone, accredit then later sanction, sanction lifted by a later
   authority accredit, wot accredit does not lift) plus one live-HAF read, and both failure paths.
6. Architect note: `wot-broadcast-timeout.test.ts` carries the second line
   'Real-path companion: `backend/tests/sanction-read-real-postgres.test.ts` [readSanctionState]';
   `tests/eslint` 146/146 green. The false header claim in `accreditation-verify-sanctioned.test.ts`
   (SQL covered in `accreditation-membership-cte.test.ts`) now points at the new file.

**Decided with the user (2026-10-08 and 2026-10-09).**
- `/verify` with no HAF pool configured answers the same 503 instead of broadcasting with no gate
  and no sanction read. The spec that pinned the old broadcast now pins the 503, and the warn event
  `accreditation.verify.idempotency_haf_unconfigured` is now `accreditation.verify.haf_unconfigured`.
- The ORCID callback's 503 carries `retriable: true`, as the task and the Data Source Policy say,
  although the OAuth state is already spent: there the retry is a new ORCID flow (the callback
  page's Try Again link).
- `confirmTokenLimiter` and `linkTokenLimiter` now refund 503 (`refundStatusCodes: [409, 503]`).
  Without it a user retrying through an outage spent the 5-per-hour bucket (each counted request
  renews the hour) and stayed locked out past `STUCK_RECOVERY_WINDOW`, which broke AC4 in practice.
  The per-IP limiters keep counting.

**Choices within the task's latitude.** Code `SERVICE_UNAVAILABLE` on all five: the verify page
retries on `details.retriable`, and the ORCID callback page maps `INTERNAL_ERROR` to a state with no
button, so that code was avoided. `Retry-After: 30` everywhere, as `/verify`'s and the metadata
edit's sibling 503s send.

**SPA consumers.** Every consumer offers a retry for the 503: the verify page (retriable state with
cooldown); `/confirm` and `/link` on the signup-verify page (generic failure, and submitting again
resends the same username and keys, or signs again); the ORCID callback page (Try Again restarts the
flow); the settings metadata edit (generic error, Save resubmits, proof not burned). Weaker spots,
for a ui task:
- `frontend/src/pages/signup-verify.js` `submitCreateAccount`: after the 503 the copy says the
  account could not be created although it exists; editing the username re-runs `_checkUsername`,
  which now reports the name taken, and a reload loses the mnemonic. Only an unchanged resubmit
  recovers.
- `frontend/src/pages/orcid-callback.js` `_verify`: a HAF outage shows the same "ORCID verification
  failed" copy as a sanction; a comment there says a refresh can retry after a 503, but the state is
  spent and the refresh gets a 400.
- `frontend/src/pages/settings.js` `handleMetadataSubmit`: the same generic copy for a sanction and
  an outage.

**Verification.**
- Baseline before the change and runs after, each file alone (16 backend files plus the signup
  suites and `tests/eslint`): all green except `accreditation-idempotency.test.ts`, whose same six
  specs fail before and after (`backend-accreditation-idempotency-specs-skip-the-sanction-guard-read`);
  'HAF lookup throw degrades gracefully' now gets a 503 where it got a 403. Final run at f227f2e5,
  19 targets each alone: the same result. Typecheck clean; lint 0 errors (the one warning is in
  `src/lib/author-supersession.ts`, untouched).
- Adversarial pass on 4ccf730e (workflow, one refuter per lens): 14 mutants applied in a scratchpad
  copy, every one killed (each `haf_unavailable` branch deleted, the 503 turned back into a 403,
  `readSanctionState`'s failure mapping and SQL broken, `Retry-After` dropped, the metadata read moved
  after the proof). Two confirmed findings were fixed in 74c796e8 (the limiter refund above, and the
  missing accredit-then-sanction case, without which dropping the block comparison passed every
  test), and three re-probes on 74c796e8 killed (each limiter's refund reverted, the comparison
  dropped).
- Simplify pass (reuse, quality, efficiency reviewers): 9 applied in f227f2e5, 4 skipped
  (`redirectHafViews` in the real-Postgres file, whose in-query `expect` would be swallowed by the
  function's catch; the guard-clause re-indent of the `/verify` handler; moving the no-HAF spec to
  another describe; merging the one-503 and six-503 specs).
- Code review: the architect's intake review (backend `CLAUDE.md`); not run here.

**Out of scope, for filing.**
- `/verify`'s gate catch comment and its warn message say `SERVICE_UNAVAILABLE`; the wire code is
  `ACCREDITATION_GATE_UNAVAILABLE`. Pre-existing.
- `readSanctionState`'s docblock keeps "This is the same suppression predicate
  `activeAccreditationsCteBody` applies": item 14 of
  `backend-accreditation-wot-comment-and-dead-code-pass` now targets that docblock. The same-block
  (`>=`) boundary has no spec; `backend-accreditation-release-op` changes that comparison.
- In the metadata edit, the sanctioned 403's place before the proof consume is pinned only on the
  signature path (a probe moving the read after the consume left the 403 spec green). Pre-existing.
- `CONCEPTS.md` "HAF SQL" ("fail closed or return empty") contradicts the Data Source Policy.
- Pending tasks that name the old function or its fail-closed contract: notes appended to
  `backend-sanction-holds-before-haf-indexes` (its scope 2 and AC2 make a failed read "return true",
  which this task removed; needs restating), `backend-accreditation-idempotency-specs-skip-the-sanction-guard-read`,
  `backend-accreditation-release-op` and `backend-orcid-binding-sanction-sticky`. Name-only:
  `backend-wot-enrollment-has-a-single-trigger` (scope 3) and the comment pass's item 14.

**Learnings checkpoint.** No `agents/docs/solutions/` entry names `hasUnliftedSanction`, the signup
token limiters or the retired event, and the nearest entries (`fail-closed-vs-degrade-accepted-haf-error-boundary`,
`new-fail-closed-outcome-must-not-reuse-an-existing-sentinel`, the skip-failed-requests carve-out)
stay true; nothing for `/ce-compound-refresh`. No new entry: the sentinel lesson is
`new-fail-closed-outcome-must-not-reuse-an-existing-sentinel`'s, the refund rationale is in the
`confirmTokenLimiter` comment, and the one near miss (a spec's fake keyed on `sanction_block`, which
`activeAccreditationsCteBody` also emits) was caught by the spec's own call assertion, the shape
`mock-guard-assertion-must-verify-call-shape` prescribes.

**[TODO Architect] at archive, in addition to the list above.**
- `api-contracts/accreditation.md`, `PATCH /api/accreditation/metadata` `SERVICE_UNAVAILABLE`: "A
  HAF blip striking the downstream membership/sanction reads ... fails closed to a `403`" now holds
  for the membership read only.
- `api-contracts/accreditation.md`, `/verify`: the 503 also answers when no HAF pool is configured.
- `api-contracts/auth.md`, `/confirm` and `/link` "Stuck-account recovery": the stuck state also
  follows a 503 at the sanction read, where no broadcast was attempted; the per-token limiter
  refunds 503.
- `api-contracts/orcid.md`, callback: the 503's retry is a new ORCID flow.

## Architect re-review (2026-10-09) — HELD PENDING FIXES:

`/ce-code-review` of 4ccf730e, 74c796e8 and f227f2e5 (eight reviewers; 13 of 14 mutants killed,
the survivor is the known same-block `>=` gap). Triaged with the user 2026-10-09.

1. **The per-IP signup limiters refund 503 too.** `confirmLimiter` and `linkLimiter`
   (`backend/src/routes/signup-verify.ts`, 10 per hour per IP) count the sanction-read 503. A user
   retrying through a HAF outage from one IP, or several signups behind one campus NAT, reach the
   cap; each counted request re-arms the hour, so the 429 lasts past `STUCK_RECOVERY_WINDOW`,
   after which `/confirm` and `/link` answer 400 and the finalized account stays unaccredited.
   Decided with the user 2026-10-09, replacing "the per-IP limiters keep counting": both refund
   503, as `confirmTokenLimiter` and `linkTokenLimiter` do. Add one spec per route: from one IP,
   more than ten sanction-read 503s, then the retry once HAF answers issues the session. Architect
   plant test on `/confirm` at f227f2e5: after ten 503s from one IP, the retry answered 429 with
   `Retry-After` >= 3590; with `refundStatusCodes: [503]` on both IP limiters it answered 200 with
   a session. Specs in one file share the per-IP bucket unless they set `X-Forwarded-For`, as
   `signup-verify-resume-argon-error-translation.test.ts` does. Keep the limiter comments true
   against the resulting code (intent only: write them against the code). Run `tests/eslint`
   alone.
2. **`backend/tests/sanction-read-real-postgres.test.ts` header, clause (a).** Delete "the
   function's SQL runs verbatim and". The wrapper prepends a `synthetic_cj` CTE and replaces the
   custom_json view name before forwarding the query, so the text does not run verbatim; the
   sentence left ("... forwards the query to a real Postgres on APP_DATABASE_URL, so only the op
   rows are synthetic.") is true. Run `tests/eslint` alone.

Dispositions of the rest of the review (no action on this task):
- Dismissed: the `wot-broadcast-timeout.test.ts` header listing `readSanctionState` as mocked
  (true: the module export is mocked, and one spec points the mock at the real function); no
  `assertNever` at the five callers; the per-token refund invariant held only by its comment; an
  outage longer than `STUCK_RECOVERY_WINDOW` (the same trap as after a 502/504 on base); the
  surviving `>=` mutant (owned by `backend-accreditation-release-op`); no live-HAF sanctioned case.
- Filed: `ui-sanction-read-503-copy-and-retry` (the three SPA spots this signal block names).
- Noted on other tasks: `architect-haf-outage-sweep` (the 500 when `findAccreditedAccountWithOrcid`
  throws at signup finalize; custody's broadcast with HAF unconfigured);
  `backend-password-proven-orcid-link-completes-from-current-mailbox` (its sanction gate branches
  on all three `SanctionState` values).

### [TODO Architect] at archive, additions from the 2026-10-09 review

- `api-contracts/accreditation.md`, `/verify`: the `ACCREDITATION_GATE_UNAVAILABLE` entry's "both
  retriable 503 branches on /verify share one floor" and its contrast with `SERVICE_UNAVAILABLE`;
  `SERVICE_UNAVAILABLE` on `/verify` now has three causes (Redis counter, failed sanction read, no
  HAF pool).
- `api-contracts/common.md`: the `details.retriable` emitter list gains the metadata PATCH,
  `/confirm`, `/link` and the ORCID callback; the 503 row's retriable-HAF class.
- `api-contracts/auth.md`: the per-auth_token and per-IP limiters on `/confirm` and `/link` refund
  503 (no line documents the per-token limiter yet); the 403 `ACCREDITATION_SANCTIONED` on both
  routes is undocumented (pre-existing). `api-contracts/orcid.md`: the same 403 on the callback.
- `CONCEPTS.md` "HAF SQL": "fail closed or return empty" contradicts the Data Source Policy.
- Learnings checkpoint: `/ce-compound` on a status refunded at one limiter layer while a sibling
  limiter on the same route still counts it (no entry covers it).
