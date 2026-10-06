# The real-HAF idempotency test's fixture discovery walks every custom_json op since genesis and times out

**Owner:** backend
**Created:** 2026-10-06
**Priority:** low

Filed at the user's request after a root-cause pass on 2026-10-06. Each of the seven backend files
that fail when run alone on clean main was diagnosed by one agent and re-checked by a second; the
failing spec sets were identical at 342f2820 and 74488ad5. Low because the change is test-only and
the production author filter that one failing spec guards was verified on real HAF (see Why).

## Why

`backend/tests/lib/idempotency-real-haf.test.ts` run alone: 2 failed, 8 passed, 1 skipped
(measured at both commits). Both failures are in the
`findCustodyBroadcastByIdempotencyKey` describe:

- `positive hit returns IdempotencyHit with matching tx_id and block_num`
- `per-route scoping: another username with the same key returns null`

**Root cause: the test's own discovery query.** Both specs first call the file's
`findKnownCustodyIdempotencyOp`, and both die in its custom_json query with
`canceling statement due to statement timeout` (57014) from `queryWithRetry`. Neither reaches the
production `findCustodyBroadcastByIdempotencyKey`. The query:

```sql
WHERE cj.custom_id = $1
  AND (cj.json::jsonb ->> 'idempotency_key') IS NOT NULL
  AND cj.block_num >= $2          -- getCachedGenesisBlock()
ORDER BY cj.block_num ASC
LIMIT 1
```

- Plan-only `EXPLAIN` on the HAF node (measured): `Index Scan using
  hive_operations_block_num_trx_in_block_idx`, `Index Cond: (operation_id_to_block_num(id) >=
  105078443 AND op_type_id = 18)`, with `body_value->>'id' = 'pevotest'` as a per-row Filter. That
  is a forward walk of every custom_json op since genesis.
- The planner estimates 13.3M appTag rows. There are 22, and none carries `idempotency_key`
  (measured), so `LIMIT 1` never ends the walk early.
- Dropping only the floor gives the same walk from block 0 (plan-only, measured). The floor-only
  remediation that the `pevo/no-custom-id-block-num-floor` message recommends does not fix this
  shape. The pathology is the one in
  `agents/docs/solutions/conventions/haf-custom-json-latest-op-materialized-fence-2026-06-14.md`.
- Each attempt hits the HAF pool's 30 s `statement_timeout` (`getPool` in `src/db.ts`).
  `queryWithRetry` (`tests/support/haf-query.ts`) retries only ECONNRESET, ETIMEDOUT, EPIPE and
  ECONNREFUSED, so 57014 throws at once, and the specs' `retry: 5` makes six attempts: 185 to
  214 s per spec (measured).
- The helper's comment fallback would fail the same way once the custom_json query returns:
  plan-only `EXPLAIN` shows a forward walk of the same index over every comment op
  (`op_type_id = 1`) since genesis, with `json_metadata` as a per-row filter and no author bound.
  It was not executed.

**Fenced form (measured).** With the match in an `AS MATERIALIZED` CTE and no floor, `EXPLAIN
ANALYZE` uses `hafsql_id_opid_idx`: 22 rows removed by the filter, 0 returned, about 0.15 ms, the
blocks lookups never executed. A patched copy (fenced custody discovery, comment arm deleted) ran
the file at 8 passed, 3 skipped, exit 0, in two runs (107 s and 114 s). The two custody specs then
skip with their no-fixture message.

**History.**
- 42ac79ca "backend(idempotency): real-HAF lookup integration test" (2026-05-15) added the
  discovery with the floor and the ASC `LIMIT 1` shape inside a try/catch, so a timeout would have
  read as a skip.
- 05e62105 "backend(idempotency-haf-test): round-1 hold fixes (1 P0 + 2 P1)" (2026-05-16) removed
  the catch so that schema errors fail loudly, and recorded 8 passed, 3 skipped: the walk still
  finished then.
- The SQL has not changed since. The trigger is chain growth past genesis (about 28,800 blocks a
  day; genesis 105,078,443 and head 110,532,859 at measurement).
- The earliest record of the timeout is in 1ab97151 "backend(custom-id-block-num-floor-sweep):
  drop inert block_num>=$genesis floor at all 16 sites" (2026-06-04), which called it
  environmental. That sweep cleaned `src/` only: `npm run lint` is `eslint src/`. Run on this file,
  the rule reports 5 errors (measured).

**The production behavior still holds (measured).** No live op carries an `idempotency_key`, so
the re-check called the production `findCustodyBroadcastByIdempotencyKey` through a pool wrapper
that swapped only the matched field name and kept the author predicates and bound params:

- custom_json arm, key field swapped to `'action'`: own signer `pevotest.admin` with `'accredit'`
  hit (block 109983748), and a foreign author returned null. A mutant with
  `required_posting_auths ?| $2::text[]` replaced by `$2::text[] IS NOT NULL` returned that hit
  under the foreign author.
- comment arm, matched on `json_metadata -> appTag ->> 'type' = 'review'`: own author
  `pevotest.anon` hit (block 105489422), and a foreign author returned null.

No production change is needed.

**Same shape in four sibling queries of this file.** The lint rule also flags
`findKnownAccreditationIdempotencyOp`, `findKnownExistingAccreditationFixture`, the forged-accredit
probe in `per-route scoping: non-authority self-broadcast carrying the same key returns null`, and
the forged-account probe in `per-route scoping: non-authority self-broadcast accredit for an
account returns null`. Each pairs `custom_id = $1` with a `block_num >=` floor under
`ORDER BY ... LIMIT 1`. They pass today. In the patched runs the accreditation per-route spec took
29.6 s and 30.0 s (one production lookup plus the forged probe; the split was not measured), and
the accreditation positive-hit discovery alone took 11.3 s on its skip path. Their plans were not
checked. Same defect class and same fix, so they are in scope.

## Scope

1. In `findKnownCustodyIdempotencyOp`, replace the custom_json discovery with the fenced form, no
   floor, params `[config.appTag]`. The measured form:

   ```sql
   WITH candidates AS MATERIALIZED (
     SELECT cj.id, cj.block_num,
            cj.required_posting_auths ->> 0 AS author,
            cj.json::jsonb ->> 'idempotency_key' AS key
     FROM ${T.customJson} cj
     WHERE cj.custom_id = $1
       AND (cj.json::jsonb ->> 'idempotency_key') IS NOT NULL
   )
   SELECT c.author, c.key, op.included_trx_id AS trx_id, c.block_num
   FROM candidates c
   JOIN hafsql.haf_operations op ON op.id = c.id
   ORDER BY c.block_num ASC
   LIMIT 1
   ```

2. Delete the helper's comment-op fallback and its `genesis` local. It has no bounded index path
   (see Why), and nothing writes a comment-surface key today: only `POST /api/custody/broadcast`
   embeds one (`embedIdempotencyKey`), and only when the request carries `idempotency_key`, which
   nothing in `frontend/src` sends (from the code). Whether `CustodyFixture.surface` stays is your
   call.
3. Fence the four sibling queries the same way: every predicate inside an `AS MATERIALIZED` CTE
   with no `ORDER BY` or `LIMIT`, sort and `LIMIT 1` outside, floor and its param dropped, each
   query's sort order kept. `findKnownExistingAccreditationFixture` keeps
   `block_num DESC, id DESC`, which `pevo/no-accred-state-read-missing-id-tiebreaker` checks, so its
   CTE selects `cj.id`. Drop the `getCachedGenesisBlock` import once unused. Dropping the floor
   should change no result: genesis is the block of the appTag's first `accredit` op
   (`getGenesisBlock` in `src/hafsql.ts`), and the custody discovery matches nothing with or
   without it. Confirm this.
4. Keep the no-try/catch rationale in `findKnownCustodyIdempotencyOp`, which
   `findKnownAccreditationIdempotencyOp` points to. Delete or narrow what the change makes false:
   - in the helper's docblock, "then falls through to comment ops";
   - the inline "custom_json arm — required_posting_auths ?| ARRAY[required]." (the discovery has
     no signer filter, which is already false at HEAD);
   - the file header's fixture paragraph, which says discovery scans for any op carrying the key
     and that the per-route-scoping assertions "exercise unconditionally". After the change only
     custom_json ops are scanned, and the custody per-route spec uses the fixture's key and skips;
   - the two custody specs' skip messages. Both say HAF has no op carrying `idempotency_key`,
     and after the change only custom_json ops are scanned. The positive-hit one also says the
     assertion activates once "/broadcast traffic" populates the field. After the change only a
     custom_json op does that. A `/verify`
     accredit op also counts, because the custody custom_json arm has no action filter.

   Any line the change adds or rewrites must not carry `Round-1 hold item N`, `Option A.4` or a
   line-number cite. The file has all three today, and the pre-commit anchor gate checks added
   lines.

## Acceptance criteria

1. The file has no `block_num >=` predicate and no comment-op discovery.
   `npx eslint tests/lib/idempotency-real-haf.test.ts` (from `backend/`) reports 0 errors, against
   5 today. `npm run typecheck:tests` is clean.
2. Run alone on the committed tree, the file exits 0 with no Errors line. At today's chain state,
   expect 8 passed and 3 skipped (the two custody fixture specs and the accreditation positive
   hit). If a keyed op has landed since, say so and give the counts. Put per-spec durations in
   the signal block.
3. Loud-failure check, in a scratch copy: misspell a column in the fenced custody discovery (for
   example `cj.custom_idx`). The custody positive-hit spec fails with 42703 and does not skip. A
   re-added catch would turn the file green and every schema regression into a skip.
4. Non-vacuity control, in a scratch copy: each fenced query that returns no row on today's chain
   returns one once its sparse predicate is relaxed. For example, swap `'idempotency_key'` for
   `'action'` in the two discovery helpers. For the forged probes, drop the `NOT`, and in the
   accredit-key probe also swap the key. Record each control and its result. Otherwise a fenced
   query that returns nothing for a wrong reason reads as the documented skip.
5. The `findExistingAccreditation` positive-hit spec still asserts (it does not skip) and passes.
6. No file under `backend/src/` changes. No emdash.

## Notes

- Overlap:
  - `backend-latest-op-haf-lookups-walk-the-blocks-index` (high) fences the production lookups in
    `src/lib/idempotency.ts`, including the custody custom_json arm (7.6 to 9.3 s on the no-match
    negative-miss specs in the patched runs) and `findAccreditationBroadcastByIdempotencyKey`. The
    two tasks edit different files. Its AC 1 asks which specs cover each lookup. After this task,
    the custody positive-hit and per-route specs and the accreditation positive-hit spec skip, so
    they cover no matching input. The comment arm that task leaves alone is the production one,
    not this helper.
  - `backend-verify-gate-treats-wot-enrollee-as-accredited` (high) makes a latest `method: 'wot'`
    accredit a miss in `findExistingAccreditation`. `findKnownExistingAccreditationFixture`
    predicts a hit for any latest authority-signed accredit, and WoT accredits are admin-signed.
    If the chain-wide latest op is a `wot` accredit, the positive-hit spec fails once that task
    lands. Whichever task lands second makes the fixture mirror the gate.
  - `backend-accreditation-release-op` Scope item 3 asks for tests showing that
    `findExistingAccreditation` and its siblings treat a latest release revoke as not accredited.
    Any such specs added to this file follow the fenced form.
  - `architect-audit-broadcast-idempotency-ipfs` (low) audits `src/lib/idempotency.ts`, not this
    file.
  - `backend-state-g-unverified-row-lifecycle` names this file in its verification note as part
    of the known clean-main red bar. Nothing to change there.
- Residuals for triage, not proposed:
  - Activation. HAF holds 22 appTag custom_json ops: 21 accredit ops by `pevotest.admin` and 1
    anon_review by `pevotest.anon`. None carries a key (measured). Only `POST
    /api/accreditation/verify` writes `idempotency_key` into its payload (`customJsonPayload` in
    `routes/accreditation.ts`). The signup-verify, ORCID and WoT accredit payloads carry none
    (from the code). The recent accredit ops match the signup-verify payload, which carries
    `orcid`, and the last `/verify`-shaped op is from 2026-05-12 (measured). The three
    fixture-gated specs will skip for as long as there is no `/verify` traffic.
  - With the custody per-route spec skipping, the custody author filter is pinned only by the
    mocked sibling `tests/lib/idempotency.test.ts`. Its checks are text regexes
    (`/ocv\.author = \$1/`, `/required_posting_auths/`) plus bound params, so they catch a deleted
    predicate but not a neutered one. `(cj.required_posting_auths ?| $2::text[] OR TRUE)` and
    `(ocv.author = $1 OR TRUE)` each left that file at 29/29 (measured).
  - `per-route scoping: non-authority self-broadcast accredit for an account returns null`
    asserts nothing today. Its forged probe finds no row, because every appTag accredit op is
    signed by `pevotest.admin`, the only configured authority. Its comment says the assertion is
    then vacuously true. For the same reason, the accreditation per-route spec asserts only its
    random-key miss.
  - Deleting the comment discovery means a keyed comment op would never activate the custody
    specs. Keeping it would need an author bound (the production comment arm plans on the
    `hive_operations_comment_search_permlink` author index), fed by an author set that is not
    itself a chain-wide scan. Not measured.
  - Tooling and doc follow-ups: `npm run lint` covers `src/` only, so the floor rule never runs on
    tests. The rule's message and description in `eslint.config.mjs` recommend dropping the floor
    alone, which the plan check showed is not enough for a sparse `ORDER BY ... LIMIT` over
    `custom_id`. The materialized-fence convention entry has the working form. The rule text is
    backend zone, and the convention entries are the architect's.
  - The file's header cites a task slug and carries round/hold labels, and two comments cite
    `idempotency.ts` line numbers. They are out of scope unless the change rewrites those lines.
  - The planner's 13.3M-row estimate for `custom_id = 'pevotest'` (22 actual) drives the walk
    shape for every unfenced sparse custom_json read, `src/` included. The `src/` reads belong to
    the latest-op task.
