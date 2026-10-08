# /verify tells a WoT enrollee below the threshold that they are accredited

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Filed from the accreditation and Web of Trust audit (finding 1). Seven reviewers reported it and
the validator confirmed it from the code. Incidence was not measured.

**Sequencing:** `backend-latest-op-haf-lookups-walk-the-blocks-index` rewrites the same query.
Take that task first. If it is not archived when you pick this one up, stop and say so.

## Why

`POST /api/accreditation/verify` calls `findExistingAccreditation`
(`backend/src/lib/idempotency.ts`) before anything else that reads the chain. That helper returns
a hit whenever the account's latest authority-signed op among `accredit` and `revoke` is an
`accredit`, whatever its `method`. On a hit the route writes the completion record, which deletes
the pending token, and answers 200 "Accreditation confirmed" with `outcome: 'already_accredited'`.
It broadcasts nothing.

For an account in the "Below-threshold (WoT)" state of `ARCHITECTURE.md` § 2, the latest op is a
`method: 'wot'` accredit and the account is not accredited: `active_accreditations` drops a `wot`
row that does not meet the live vouch threshold. A user in that state who verifies an
institutional email is told they are accredited, loses the token, and stays unaccredited.
`POST /api/wot/retract` broadcasts no revoke, so ordinary retractions lead there.

**Decision (user, 2026-10-05):** an email verification makes any WoT enrollee authority-pinned,
whether or not the account currently meets the threshold.

## Scope

1. The gate short-circuits only when the latest op is an `accredit` whose method is not `wot`.
   Use `IS DISTINCT FROM 'wot'`, the test `auth_accredit` applies in `activeAccreditationsCteBody`
   (`backend/src/hafsql.ts`). When the latest op is a `wot` accredit, `/verify` goes on to the
   sanction guard, the per-token lookup and the broadcast, so the `method: 'email'` op becomes the
   account's latest accredit op.

   What stays as it is: a latest `revoke` is still a miss, and `hasUnliftedSanction` still refuses
   a sanctioned account after the gate. Once the email op is indexed, a second pending token for
   the same account sees an `email` accredit as the latest op and hits the gate.
2. Two comments in the `/verify` handler equate a gate hit with "currently accredited": the one
   at the gate ("is this account already accredited?") and the opening of the "Ever-sanctioned
   guard" comment ("reaching here means the account is NOT currently accredited (latest op is a
   revoke or there is no accredit)"). Cut each to what the gate checks.
3. The `findExistingAccreditation` docblock says "The WoT cleanup path in routes/wot.ts is a live
   producer of revoke ops" and "Scope per the filing task". No WoT path broadcasts a revoke, and
   the second is a task redirect. Delete both while you are in that docblock.

## Out of scope

- The per-token idempotency branch (`already_landed`). It stays.
- The limiters, the session requirement and the mail text. Each has its own task.

## Acceptance criteria

1. A `/verify` spec for an account whose latest op is a `wot` accredit below the live threshold:
   the route broadcasts an accredit op with `method: 'email'` and answers 200 with no `outcome`.
2. An account whose latest op is an `email`, `orcid` or `manual` accredit still answers
   `already_accredited` and broadcasts nothing.
3. A sanctioned account whose latest op is a `wot` accredit is refused with 403
   `ACCREDITATION_SANCTIONED`.
4. Comments follow root `CLAUDE.md` "Comment anchors".

## [TODO Architect] at archive

- Update the `already_accredited` paragraph of `api-contracts/accreditation.md`, and say in
  `ARCHITECTURE.md` § 2 that an email verification pins a WoT enrollee.
- `/ce-compound-refresh` on `accreditation-state-read-latest-action-wins-2026-05-15.md`.
  The same refresh deletes the entry's claim that `backend/src/wot.ts:347` produces revoke ops,
  in its sibling-site list and in "The bug is reachable, not theoretical". `wot.ts` broadcasts no
  revoke op; the admin sanction route (`/accreditation/sanction` in `routes/admin.ts`) does.
  (Added 2026-10-07 from the review of `backend-latest-op-haf-lookups-walk-the-blocks-index`.)
- The same refresh also covers, in that entry: guidance step 4 ("'accredit' means currently
  accredited"), the canonical SQL (no `method` projection), the caller branching snippet (no
  `wot` check), the route example's null comment, and the task-file citation in Related.
  (Added 2026-10-08 from the intake review of `31994b09`.)
- `ARCHITECTURE.md` "Credential Bindings", the `/verify` paragraph: "An already-accredited
  account verifying a mailbox claims the row as `bound` at once, with no second `accredit` op."
  An account whose latest op is a `wot` accredit now gets a `method: 'email'` op. Narrow it.
  (Added 2026-10-08 from the intake review of `31994b09`.)

## Backend implementation signal (2026-10-07, commit 31994b09)

31994b09 verified as an ancestor of HEAD with `git merge-base --is-ancestor`. The sequencing
precondition held: `backend-latest-op-haf-lookups-walk-the-blocks-index` was archived in dd4aea20.

**Per scope item:**
1. **Gate predicate.** `findExistingAccreditation` projects `cj.json::jsonb ->> 'method' AS method`
   and returns null unless the latest op is an `accredit` whose method is not `'wot'`. The test sits
   in JS next to the existing action check (`row.action !== 'accredit' || row.method === 'wot'`), not
   as a literal `IS DISTINCT FROM 'wot'` in the SQL. It is equivalent for everything `->>` returns:
   an absent key and a JSON null both arrive as null and count as non-wot, as under `IS DISTINCT
   FROM`. Keeping it in JS lets the mocked-pool specs feed raw op rows rather than a precomputed
   verdict. The real-Postgres file pins the no-method case end to end. A latest `revoke` still
   misses, and the sanction guard still runs after the gate (AC3 spec).
2. **Handler comments.** The gate comment and the opening of the "Ever-sanctioned guard" comment
   now say what the gate checks. A third sentence became false with the change and is narrowed the
   same way: "Metadata-update routing" said "a re-confirm of an already-accredited account returns
   the prior tx_id"; an at-threshold WoT enrollee is accredited and now misses.
3. **Docblock.** Both items deleted. In the same docblock, also cut by deletion:
   - the opening "is this account currently accredited?";
   - the claim that every other accreditation-state read uses latest-action-wins, with its file
     list (`activeAccreditationsCteBody` ignores a legacy revoke);
   - the "(the gate is 'what is the account's current accreditation status?' ...)" parenthetical;
   - ", and silently lock the user out of re-accreditation" (no state reaches it after this change).

   Added: a "WoT handling" paragraph, and the sanction guard in the fall-through order.

   The same false WoT-revoke-producer claim sat in two test files, and is deleted there too:
   `tests/lib/idempotency.test.ts` (with its `wot.ts:347`-style line anchors) and the revoke spec
   in `tests/routes/accreditation-idempotency.test.ts`.

**Acceptance criteria:**
1. Route spec 'latest op is a wot accredit → gate falls through, a method:email accredit is
   broadcast'. It queues the gate, the sanction guard and the per-token read, and asserts 200 with
   no `outcome`, a payload `{ action: 'accredit', account, method: 'email' }` and 3 HAF reads. The
   route reads no threshold, so "below the live threshold" is modelled only as the latest op.
2. Route `it.each` over `email`, `orcid`, `manual`: `already_accredited`, no broadcast, 1 HAF
   read. Unit `it.each` adds a null method, and the real-Postgres file adds a missing method.
3. Route spec 'sanctioned account whose latest op is a wot accredit → 403
   ACCREDITATION_SANCTIONED, no broadcast' (2 HAF reads).
4. The pre-commit `anchor_violation` over every added line: 0 hits, control line fires.

**Tests:**
- `tests/lib/idempotency.test.ts`: wot → null; email/orcid/manual/null → hit; SQL regex
  `'method' AS method`; a structured forward citation of the new file, token
  `[findExistingAccreditation]`.
- `tests/lib/existing-accreditation-gate-real-postgres.test.ts` (new, 8 specs): the production
  function against synthetic `hafsql` views in a rolled-back transaction, with the reverse
  declaration back to `idempotency.test.ts`. Real HAF has no `wot` accredit under `pevotest`
  (read-only query, 2026-10-07: 20 `email` and 1 `manual` accredits, no revoke).
- `tests/routes/accreditation-idempotency.test.ts`: the 5 specs above.
- `tests/lib/idempotency-real-haf.test.ts`: the positive-hit spec now projects `method` and expects
  a miss when the namespace's latest authority op is a `wot` accredit. It would have gone red for
  good once a WoT auto-accreditation became the newest op. Its `lines 340-343` anchor is gone.

**Evidence:**
- Red before the fix: the unit wot and SQL-shape specs, both real-Postgres wot specs, and route
  AC1 and AC3. The hit specs were green throughout (characterization).
- Each file alone after the fix: `idempotency` 34/34, the real-Postgres file 8/8,
  `accreditation-verify-sanctioned` 2/2, `accreditation-membership-cte` 11/11,
  `idempotency-real-haf -t findExistingAccreditation` 3/3. `accreditation-idempotency`: 21 passed,
  6 failed, exactly the clean-main six that
  `backend-accreditation-idempotency-specs-skip-the-sanction-guard-read` fixes; the 5 new specs
  pass. `tests/eslint` 146/146, `tsc` clean, lint 0 errors (1 warning, in
  `author-supersession.ts`).
- Mutation probes on a copy, all 7 killed: the pre-fix predicate, no `method` projection, the
  wrong JSON key, a null method treated as non-pinning, an allowlist, the sanction guard disabled,
  a `'WOT'` literal. The two SQL-side mutants die only in the real-Postgres file and the SQL regex;
  the route specs take `method` from mocked rows.

**Sibling tasks:**
- The new route specs already queue all three HAF reads, so they need nothing from the
  sanction-guard-read task, which still owns the 11 existing sequences and the header paragraph.
- `backend-accreditation-release-op` changes `hasUnliftedSanction`'s comparison. If its result
  columns change, the guard rows queued in the AC1 and AC3 specs change with them.

**For triage (not acted on):**
- `ARCHITECTURE.md` "Credential Bindings", the `/verify` claim paragraph, ends "An
  already-accredited account verifying a mailbox claims the row as `bound` at once, with no second
  `accredit` op." An at-threshold WoT enrollee now gets a second (`email`) op. It could ride the § 2
  edit in the TODO at archive; `backend-mailbox-binding-registry` builds that claim.
- UI: `frontend/src/pages/accreditation.js` shows the request form only when `!isAccredited`, so
  only a below-threshold enrollee can ask for the pin. The 2026-10-05 decision covers at-threshold
  enrollees too.
- The pin holds while the email op is the latest accredit. A `wot` accredit landing after it makes
  the account threshold-dependent again, and `broadcastWotAccreditation` can still broadcast one
  from its cached membership read. `backend-wot-auto-accredit-reads-stale-membership` covers that
  read.

**Learnings checkpoint:** `accreditation-state-read-latest-action-wins-2026-05-15.md` is
contradicted (its canonical SQL lacks `method`, its caller rule reads any `'accredit'` as
accredited). Its refresh is already in the TODO at archive, so it was not run here. The fence and
grace-period entries that name the gate still hold. No new entry: the rationale is in the code.

**Code review:** not run on the backend side (the architect's `/ce-code-review` at intake). A
verification workflow (comment claims, acceptance, mutation; one refuter per finding) confirmed 5
findings, all fixed before 31994b09, and refuted 5.

## Architect re-review (2026-10-08) — HELD PENDING FIXES:

Reviewed `31994b09` with `/ce-code-review` (correctness, security, adversarial in-process,
testing, project-standards, learnings, then an independent validator). Reviewers read
`git show 31994b09` snapshots. Scope 1 to 3 and AC1 to AC4 are met. The testing reviewer
reproduced the signal's counts in a scratchpad copy (`idempotency` 34/34, the real-Postgres file
8/8, `idempotency-real-haf -t findExistingAccreditation` 3/3, `tests/eslint` 146/146, each exit 0;
`accreditation-idempotency` 21 passed and 6 failed, the same six failing on base) and re-planted
six mutants, each going red where the signal says. The anchor gate finds nothing in the added
lines, and every new comment sentence checked true. One item holds the archive:

1. **The email pin drops a linked ORCID (`/verify` in `routes/accreditation.ts`,
   `customJsonPayload`).** The ORCID binding is the account's latest authority accredit op:
   `findAccreditedAccountWithOrcid` (`lib/orcid-binding.ts`) returns the account only while its
   latest accredit/revoke op is an accredit carrying that ORCID, and `accred_latest` in
   `activeAccreditationsCteBody` takes `orcid` from the latest accredit. `handleLink`
   (`routes/orcid.ts`) re-broadcasts a WoT member's accredit with `method: existing.method`
   (`'wot'`) and the linked `orcid`. Before this commit `/verify` hit the gate for that account
   and broadcast nothing. Now it broadcasts a `method: 'email'` accredit with no `orcid` field,
   which becomes the latest accredit, so the account's ORCID drops out of `active_accreditations`
   and `findAccreditedAccountWithOrcid` no longer returns the account for it. `ARCHITECTURE.md`
   § 2 "Credential Bindings": an authority op that drops the `orcid` field must carry the attested
   ORCID forward, or the read loses the binding.

   Fix: when the gate misses because the latest op is a `wot` accredit carrying an `orcid`, the
   `method: 'email'` accredit that `/verify` broadcasts carries that `orcid`. Take it from the
   chain op, never from the self-asserted `pending.orcid`. `PATCH /api/accreditation/metadata`
   (`orcid: prior.orcid`) is the precedent. Add a route spec: the latest op is a `wot` accredit
   with an ORCID, and the broadcast payload carries it. Run `tests/eslint` alone as well as the
   touched files, since comment prose in tests feeds its citation canaries.

Triage dispositions (2026-10-08, approved by the user):

- Sanction self-lift during HAF indexing lag: filed as `backend-sanction-holds-before-haf-indexes`
  (high). Not a hold item: the validator found the same window on `PATCH /metadata`, ORCID
  `handleAccredit` and `/verify` for revoked accounts, and the fix sits in the sanction route and
  `hasUnliftedSanction`.
- An at-threshold WoT member has no UI route to the pin: filed as
  `ui-offer-email-pin-to-wot-members` (normal).
- The `ARCHITECTURE.md` "Credential Bindings" sentence and the wider staleness of the
  latest-action-wins entry: added to the TODO at archive.
- Re-running the live-HAF EXPLAIN for the added `method` projection: dismissed. It is one projected
  column inside an unchanged `AS MATERIALIZED` fence.
- Auditing the sibling "latest op = accredit" readers: dismissed. The diff changes only the gate,
  and item 1 is the harm that `getExistingAccreditation` accepting a WoT member reaches.

## Backend re-review signal (2026-10-08, commits 925024f7 and 851fe922)

925024f7 and 851fe922 verified as ancestors of HEAD with `git merge-base --is-ancestor`.

**Hold item 1 (925024f7).** `findExistingAccreditation` now returns `ExistingAccreditationGate`,
`{ kind: 'hit', tx_id, block_num } | { kind: 'miss', wot_orcid }`, in place of
`IdempotencyHit | null`. Its fenced query also projects `->> 'orcid'`. A miss on a latest `wot`
accredit carries that op's non-empty `orcid` as `wot_orcid`. A miss on a latest revoke, on no op,
or on a wot op with an empty or absent `orcid` carries null. `/verify` stores it in `wotOrcid` and
spreads `orcid` onto the `method: 'email'` payload only when it is non-empty. The value comes from
the same chain row the gate reads, so there is no second HAF read. `pending.orcid` never reaches
the op. The one other consumer, the gate mock in `tests/routes/accreditation.test.ts`, returns the
miss shape.

**Tests (925024f7).**
- `tests/routes/accreditation-idempotency.test.ts`: the hold's spec, 'latest op is a wot accredit
  holding an ORCID → the method:email accredit carries that ORCID'. Its pending row holds a
  different, self-asserted ORCID. The existing wot spec now seeds a self-asserted pending ORCID and
  asserts the payload has no `orcid`. New 'latest op is a revoke → the method:email accredit
  carries no ORCID'.
- `tests/lib/idempotency.test.ts`: all gate specs move to the union. New specs cover the carry, an
  empty `orcid`, and a revoke whose payload holds an `orcid`. The SQL regex now includes
  `'orcid' AS orcid`.
- `tests/lib/existing-accreditation-gate-real-postgres.test.ts` (11 specs): the union, plus the
  carry, an empty `orcid` and a revoke after an ORCID-holding wot accredit, against the real SQL.
- `tests/lib/idempotency-real-haf.test.ts`: the fixture probe projects `orcid`, the positive-hit
  spec expects the carry when the namespace's latest authority op is a wot accredit, and the other
  two specs expect the miss shape.

**Evidence.**
- Red before the fix: the route carry spec failed with the payload missing `"orcid"`. The unit and
  real-Postgres specs failed with `null` where a miss was expected.
- Each file alone after the fix:
  - `idempotency` 37/37 and the real-Postgres file 11/11.
  - `accreditation` 41/41, `accreditation-verify-sanctioned` 2/2, `pending-decrement-queue` 9/9,
    `misc` 16/16.
  - `idempotency-real-haf -t findExistingAccreditation` 3/3, `tests/eslint` 146/146.
  - `accreditation-idempotency`: 23 passed, 6 failed. A base copy (5184c970) fails the same six
    by name, owned by `backend-accreditation-idempotency-specs-skip-the-sanction-guard-read`.
- `npm run typecheck` is clean. Lint: 0 errors, 1 warning, the existing one in
  `author-supersession.ts`. The anchor gate over every added line in both commits finds 0 hits,
  and its control line fires.

**Verification workflow on 925024f7.** Five lenses (comment claims, mutation, base comparison,
adversarial, docs), one refuter per finding, all probes in `git archive` copies.
- Mutation: 11 of 11 mutants killed, each restore checked with `cmp`. The mutants were: no `orcid`
  projection; a `'ORCID'` key; a carry on every miss; '' carried; the pre-fix null; an
  ORCID-holding wot op hitting the gate; the route assignment deleted; `pending.orcid` used;
  `orcid` written unconditionally; `??` and `||` fallbacks to `pending.orcid`. The two SQL mutants
  die only in the real-Postgres file and the SQL regex.
- No blocker or should-fix in the fix. 851fe922 lands the four comment and name defects the claims
  and docs lenses confirmed:
  - The real-HAF forged-signer spec name said the gate "returns null". It now says "misses".
  - That spec's comment said a dropped authority filter allows "a self-bootstrap accreditation",
    but a gate hit broadcasts nothing. The clause is deleted.
  - A stale unit-spec comment ("gates only on accredit-tail", "mirrors every sibling read") is
    deleted.
  - The `/verify` gate-hit comment said metadata edits never flow through a second
    `/request` → `/verify`. It now speaks only of an account whose latest op is a non-wot accredit.
  
  After 851fe922: `idempotency` 37/37, real-HAF gate 3/3, `tests/eslint` 146/146.

**Accepted residual (user decision, 2026-10-08).** The carry reads indexed HAF only, as the hold
prescribes and as `PATCH /api/accreditation/metadata` does. A WoT member who links or rebinds an
ORCID and opens the email link before HAF indexes the link op (seconds, 120 s ceiling) gets an
email op carrying the ORCID the gate saw, or none. A re-link repairs it.

**[TODO Architect] additions:**
- The latest-action-wins refresh already in the TODO at archive should also cover the hit/miss
  union. The entry's helper snippet returns `null` and a bare `{ tx_id, block_num }`. Its route
  example says the helper "returns null when the latest op is a revoke" and branches on
  `if (existingForUser)`. Its canonical SQL lacks the `orcid` projection.
- `api-contracts/accreditation.md`, PATCH /metadata intro: "The `/verify` email-confirm path stays
  idempotent and does NOT update metadata; all metadata changes route through here." A latest `wot`
  accredit now misses the gate, and `/verify` broadcasts the `/request` metadata. Narrow it to the
  gate hit. This dates from 31994b09.
- `ARCHITECTURE.md` § 2, the "Released" sentence: "Every reader that answers 'is this account
  accredited now' must follow this rule, including the self-service gates that decide whether to
  broadcast a new `accredit` op". The `/verify` gate misses on a latest `wot` accredit by design,
  even for an at-threshold member. This dates from 31994b09.
- `backend-idempotency-real-haf-discovery-walks-the-chain` quotes the old spec name
  "non-authority self-broadcast accredit for an account returns null" twice. It is now
  "... misses".

**For triage (not acted on):**
- `broadcastWotAccreditation` (`wot.ts`), in HAF lag: an account whose first ORCID-carrying
  authority accredit is not yet indexed reads as unpinned. If a vouch brings it to threshold in
  that window, a wot accredit without `orcid` goes out, which unbinds the ORCID and unpins the
  account. No pending task covers it. It needs an in-flight-accredit record like
  `backend-sanction-holds-before-haf-indexes`, not a carry.
- `handleLink` re-broadcasts `method: existing.method`, and `PATCH /metadata` does the same with
  `prior.method`. If either runs before the email pin is indexed, it writes `method: 'wot'` again,
  which undoes the pin. No pending task covers it. Recommended: dismiss as narrow to HAF lag.
- The admin grant drops `orcid`: `backend-orcid-binding-sanction-sticky` scope 3 covers it.
- The revoke spec's "Both layers ran" comment and its call count of 2 are still wrong (there are
  three reads). `backend-accreditation-idempotency-specs-skip-the-sanction-guard-read` scope 2
  owns that. 925024f7 changed only the gate half of the sentence.
- Older "Round-1 hold item N" prefixes in `idempotency-real-haf.test.ts` and the task-slug label
  above the unit `findExistingAccreditation` describe were left alone; this round added none.
- Considered, not filed: a latest typeless revoke after an ORCID-holding accredit. `/verify`
  carries nothing past it, but no backend writer emits a typeless revoke, and a `release` revoke
  frees the ORCID by design.

**Learnings checkpoint:** `accreditation-state-read-latest-action-wins-2026-05-15.md` is further
contradicted by the hit/miss union. Its refresh stays in the TODO at archive, extended above, so it
was not run here. Grepping `agents/docs/solutions/` for `findExistingAccreditation`,
`IdempotencyHit` and `wot_orcid` turns up no other entry that names the gate's return. No new entry:
the carry-forward rule is in `ARCHITECTURE.md` "Credential Bindings", and the rationale is in the
code.

**Code review:** not run on the backend side (the architect's `/ce-code-review` at intake).
`ce-simplify-code` was skipped: the change has about 20 substantive `src` lines, under its 30-line
threshold.
