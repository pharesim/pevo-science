# Seven latest-op HAF lookups walk the whole blocks index when nothing matches

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Filed from the accreditation and Web of Trust audit. The learnings pass flagged the query shape;
the architect then measured it on the HAF node with the user's permission. Widened the same day
from three lookups to seven, after a plan-only `EXPLAIN` of the sibling reads (user decision).

## Why

Measured on the HAF node on 2026-10-05 with `EXPLAIN (ANALYZE, BUFFERS)`, appTag `pevotest`: the
query in `findExistingAccreditation` (`backend/src/lib/idempotency.ts`) took 19.75 s for an
account with no accredit or revoke op. The plan drives a nested loop from
`Index Only Scan Backward using pk_hive_blocks` (110,520,295 rows read) and probes the
`custom_id` candidate set, which is empty, once per block. The candidate scan itself took 0.2 ms.
With the candidates in an `AS MATERIALIZED` CTE and the `ORDER BY ... LIMIT 1` outside it, the
same lookup took 2.4 ms.

A plan-only `EXPLAIN` shows the same backward scan of `pk_hive_blocks`, as the outer side of
the nested loop, for six more lookups. None of the six was executed, so the 19.75 s is measured
for the gate only:

- `findAccreditationBroadcastByIdempotencyKey` (`backend/src/lib/idempotency.ts`);
- `getLatestAccreditOp` (`backend/src/accreditation.ts`);
- both reads in `findAccreditedAccountWithOrcid` (`backend/src/lib/orcid-binding.ts`): the latest
  accredit op that carries the ORCID, and the account's latest accredit or revoke op;
- `getExistingAccreditation` (`backend/src/routes/orcid.ts`);
- the custom_json arm of `findCustodyBroadcastByIdempotencyKey` (`backend/src/lib/idempotency.ts`).

What it costs today:

- `POST /api/accreditation/verify`. A first-time verifier has no accredit or revoke op, and a
  fresh token's idempotency key matches nothing. The route awaits `findExistingAccreditation` and
  then `lookupAccreditationBroadcastIdempotency`, which calls
  `findAccreditationBroadcastByIdempotencyKey` unless a cached hit exists, before it broadcasts.
  The SPA aborts a request after 30 s (`DEFAULT_TIMEOUT_MS` in `frontend/src/api.js`) while the
  handler keeps running, so the page can show a timeout for an accreditation that then lands. The
  HAF pool's `statement_timeout` is also 30 s (`getPool` in `backend/src/db.ts`); a gate lookup
  that runs past it answers 503 `ACCREDITATION_GATE_UNAVAILABLE`.
- `PATCH /api/accreditation/metadata`. `getLatestAccreditOp` is its first HAF read. A caller with
  no accredit op takes the no-match path.
- The ORCID flows. `findAccreditedAccountWithOrcid` runs in the ORCID accredit and link handlers
  (`backend/src/routes/orcid.ts`) and on the ORCID signup path
  (`backend/src/routes/signup-verify.ts`). For an ORCID no accredit op carries, its first read
  matches nothing. `getExistingAccreditation` runs in the link handler.
- The custody arm does not run today. `POST /api/custody/broadcast` calls the lookup only when
  the request body carries an `idempotency_key`, and nothing in `frontend/src` sends one.
- Each such query holds one of the HAF pool's three connections while it runs.

The fix pattern is the one `loadWotThreshold` (`backend/src/wot.ts`) and `aa_params_latest`
(`backend/src/hafsql.ts`) already use. It is written up in
`agents/docs/solutions/conventions/haf-custom-json-latest-op-materialized-fence-2026-06-14.md`.

## Scope

1. In each of the seven lookups, put the row match in an `AS MATERIALIZED` CTE that carries no
   `ORDER BY` and no `LIMIT`, and order and limit outside it. Keep every predicate of that lookup
   (`custom_id`, the action filter where there is one, the subject field,
   `required_posting_auths ?|`) inside the CTE. Keep each lookup's existing sort order. Do not
   add a `block_num >=` floor.

   The form that was measured for the gate (no-match input only):

   ```sql
   WITH candidates AS MATERIALIZED (
     SELECT cj.id, cj.block_num, cj.json::jsonb ->> 'action' AS action
     FROM hafsql.operation_custom_json_view cj
     WHERE cj.custom_id = $1
       AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
       AND cj.json::jsonb ->> 'account' = $2
       AND cj.required_posting_auths ?| $3::text[]
   )
   SELECT op.included_trx_id AS trx_id, c.block_num, c.action
   FROM candidates c
   JOIN hafsql.haf_operations op ON op.id = c.id
   ORDER BY c.block_num DESC, c.id DESC
   LIMIT 1
   ```

2. `hafsql.ts` keeps `AS MATERIALIZED` inline in its SQL literals for the
   `pevo/no-custom-id-block-num-floor` lint canary (see the comment on `aa_vouch_ranked`). Check
   whether that rule reads these files before you move the CTE into a shared fragment.
3. Re-measure each of the seven after the change, for a no-match input and for a matching one, and
   put the numbers in the signal block. If you cannot run `EXPLAIN` against the HAF node, say so
   there and the architect measures at review.

## Out of scope

- The gate's semantics. `backend-verify-gate-treats-wot-enrollee-as-accredited` changes which
  rows count as a hit and lands after this task, because both edit the same query.
- The comment arm of `findCustodyBroadcastByIdempotencyKey`. Its plan-only `EXPLAIN` shows an
  index scan on the comment author with the block floor and no backward blocks scan. Leave it.
- The `update_weights` read in `reputation.ts`. It has the same `ORDER BY block_num DESC LIMIT 1`
  shape, runs under a 5 s `SET LOCAL statement_timeout`, and was not plan-checked. It belongs to
  `architect-audit-reputation`.

## Acceptance criteria

1. The seven lookups return what they returned before, for matching and non-matching inputs. Name
   the specs that cover each in the signal block.
2. The signal block carries the measured timings, or says they could not be taken.
3. A comment that states a timing cites only a number this task or its implementer measured, and
   says for which input. Comments follow root `CLAUDE.md` "Comment anchors".

## Backend implementation signal (2026-10-06, commits 3c76c235 and 10888287)

**Landed.** `3c76c235` (code and tests), `10888287` (learnings refresh, `[skip-zone-audit]`). Both
verified on main with `git merge-base --is-ancestor`.

- All seven lookups now put the row match in `WITH candidates AS MATERIALIZED (...)` and order and
  limit outside it: the custom_json arm of `findCustodyBroadcastByIdempotencyKey`,
  `findAccreditationBroadcastByIdempotencyKey`, `findExistingAccreditation`
  (`backend/src/lib/idempotency.ts`), `getLatestAccreditOp` (`backend/src/accreditation.ts`), both
  reads in `findAccreditedAccountWithOrcid` (`backend/src/lib/orcid-binding.ts`), and
  `getExistingAccreditation` (`backend/src/routes/orcid.ts`). Every predicate, the params array,
  the projected column names and each sort order are unchanged. The custody arm still orders by
  `block_num DESC` only. No `block_num >=` floor.
- Scope item 2: the CTE stays inline in each literal. Both SQL lint rules apply to every
  `**/*.ts` file (`files: ['**/*.ts', '**/*.tsx']` in `backend/eslint.config.mjs`).
  `pevo/no-accred-state-read-missing-id-tiebreaker` still fires on the new shape: a temp copy of
  `getLatestAccreditOp` with `, c.id DESC` removed failed lint, and the copy was deleted.
- Comments: each site has a short fence comment that points to `loadWotThreshold` for the planner
  shape. None states a timing (AC 3). Comments that quoted the old ORDER BY text now name the key
  without an alias (`block_num DESC, id DESC`). The `findCustodyBroadcastByIdempotencyKey`
  docblock sentence "the JOIN cost is negligible at LIMIT 1 because both sides have indexes on
  `id`" was deleted: the fenced arm joins the candidate set, which has no index. In
  `idempotency-real-haf.test.ts`, the `(lines ~282-345)` pointer became the function name, and
  "mirrors findExistingAccreditation's SQL shape" was narrowed to "reads ... view and join".
- Tests: the two shape pins in `backend/tests/lib/idempotency.test.ts` now expect
  `ORDER BY c.block_num DESC, c.id DESC`. Red observed first: 2 failed before the code change.

**AC 1: same results, matching and non-matching.** The user chose a one-off live comparison over
a new real-HAF spec file for the four lookups no spec runs for real. A scratchpad script took the
old SQL from HEAD and the new SQL from the working tree, byte for byte, and ran both read-only on
HAF (`BEGIN; SET LOCAL statement_timeout; ...; ROLLBACK`). appTag `pevotest` holds 22 custom_json
ops; 21 are authority-signed accredits, and none carries an `idempotency_key`.

| Lookup | Matching inputs, old = new rows | Non-matching (new returns no row) | Specs |
|---|---|---|---|
| custody custom_json arm | 1 of 1 (swapped field, see below) | yes | `tests/lib/idempotency.test.ts`, `tests/routes/custody-idempotency.test.ts` (mocked); `tests/lib/idempotency-real-haf.test.ts`: negative miss, opType `comment`, opType `custom_json` (real HAF, pass) |
| `findAccreditationBroadcastByIdempotencyKey` | 1 of 1 (swapped field) | yes | `tests/lib/idempotency.test.ts` (mocked); real-HAF negative miss and non-authority scoping (pass); positive hit skips, no fixture |
| `findExistingAccreditation` | 11 of 11 accounts | yes | `tests/lib/idempotency.test.ts`, `tests/routes/accreditation-idempotency.test.ts` (mocked); real-HAF negative miss, positive hit, non-authority scoping (pass) |
| `getLatestAccreditOp` | 11 of 11 | yes | none run its SQL (`tests/routes/accreditation-metadata-edit.test.ts` mocks the function); one-off check only |
| `findAccreditedAccountWithOrcid`, ORCID read | 4 of 4 ORCIDs | yes | `tests/routes/orcid.test.ts` (mocked pool, dispatches on predicate text the CTE keeps verbatim); one-off check |
| `findAccreditedAccountWithOrcid`, status read | 11 of 11 | yes | same as the ORCID read |
| `getExistingAccreditation` | 11 of 11 | yes | `tests/routes/orcid.test.ts` (mocked pool, `/link`); one-off check |

"Swapped field": with no live `idempotency_key`, the two key lookups were compared and timed with
`'idempotency_key'` replaced by `'action'` and the key set to `accredit` (custody signer
`pevotest.admin`), which matches 21 rows. The old form was never executed on a non-matching input;
plan-only `EXPLAIN` showed `Index Only Scan Backward using pk_hive_blocks` as the outer side of the
nested loop for all seven.

**AC 2: timings.** `EXPLAIN (ANALYZE, BUFFERS)` execution time on the HAF node; new form median of
3 runs; old form executed only on matching inputs.

| Lookup | New, no match | New, match | Old, match |
|---|---|---|---|
| custody custom_json arm | 0.137 ms | 1.065 ms (swapped) | 1,044 ms, 564,137 backward block rows (swapped) |
| `findAccreditationBroadcastByIdempotencyKey` | 0.211 ms | 0.630 ms (swapped) | 1,023 ms (swapped) |
| `findExistingAccreditation` | 0.217 ms | 0.388 ms gijo.george; 0.69 to 0.94 ms pevo.science | 261 ms gijo.george; 26,215 ms pevo.science |
| `getLatestAccreditOp` | 12.9 ms | 15.1 ms gijo.george; 12.1 to 12.8 ms pevo.science | 259 ms; 26,715 ms |
| ORCID read | 13.2 ms | 12.7 ms 0000-0002-7487-7441; 12.1 to 17.7 ms 0000-0001-2345-6789 | 211 ms; 26,100 ms |
| status read | 13.0 ms | 13.8 ms; 12.7 to 13.4 ms | 259 ms; 25,940 ms |
| `getExistingAccreditation` | 12.7 ms | 13.2 ms; 12.2 to 12.4 ms | 262 ms; 26,081 ms |

- New plans: `pk_hive_blocks` runs only as a forward probe per candidate (0 loops on a no-match
  input), and the backward scan is gone. The 12 to 13 ms floor on the four lookups without a
  `haf_operations` join is a `Gather` (parallel) node over the candidate index scan. The three
  join plans have no Gather.
- Beyond the task's Why: the old form was slow on matching inputs too. pevo.science has one
  accredit op (block 105,078,443), and its old plan read 110,548,040 backward block rows: the
  whole index. gijo.george has three ops, the newest at block 109,983,748, and its old plan read
  564,212 rows. Old-form wall clock was 12 to 14 s for each of the seven single-op accounts on
  every account-keyed lookup, and 0.2 to 1.7 s for the multi-op accounts. The old account-keyed
  plans have an `Incremental Sort` over the backward walk. My reading, not verified, is that it
  keeps reading until it finds an older match to close the `block_num` group.

**Runs.**

- `npm run typecheck`: exit 0. `npm run lint`: 0 errors. One warning, in
  `src/lib/author-supersession.ts`, predates this work and is not in this diff.
- `tests/eslint` + `tests/lib/idempotency.test.ts`: 10 files, 175 passed.
- `idempotency.test.ts`, `accreditation-idempotency`, `accreditation-metadata-edit`,
  `accreditation`, `custody-idempotency`, `orcid`, `signup-verify-orcid-binding-guard`,
  `window-cte-deterministic-tiebreaker`, `lib/accreditation-orcid-cache` and `tests/eslint`:
  378 passed, 6 failed. All six are in `accreditation-idempotency.test.ts`: the six specs that
  `backend-accreditation-idempotency-specs-skip-the-sanction-guard-read` documents as failing on
  clean main (FIFO mock queue, not SQL text).
- `tests/lib/idempotency-real-haf.test.ts`, whole file: 2 failed, 8 passed, 1 skipped (488 s).
  This matches the baseline in `backend-idempotency-real-haf-discovery-walks-the-chain`. Both
  failures die in the test's own `findKnownCustodyIdempotencyOp` with `canceling statement due to
  statement timeout`, before the production call.
- Verbose re-run without those two specs: 8 passed, 3 skipped. The negative-miss specs, which run
  the fenced lookups on a no-match input, took 73 to 149 ms.

**Review passes.**

- `/ce-code-review` was not run (backend role; the architect reviews at intake). A read-only
  verification workflow ran three lenses (SQL equivalence and caller contracts, comment truth,
  system-wide impact), each finding checked by a refuter. SQL lens: no defects. Impact lens: no
  breakage. Every mocked dispatcher still matches. 3 P3 comment findings were confirmed and fixed
  (listed under Comments); 6 were refuted as pre-existing text the diff left true.
- `/ce-simplify-code`: reuse 0, efficiency 0, quality 2 applied (the alias-free tiebreaker
  wording; a garbled clause in the `recent` read comment). Skipped: fusing the two
  `findAccreditedAccountWithOrcid` reads into one statement (saves one round trip on infrequent
  paths, harder to read).

**Learnings checkpoint.** `/ce-compound-refresh` on two entries, committed as `10888287`:

- `haf-custom-json-latest-op-materialized-fence-2026-06-14.md`: its carve-out said an account with
  matching ops lets the backward scan stop early. The single-op measurement contradicts that, so
  the carve-out is replaced by the numbers. The verified-sites list now names the seven lookups,
  and the snippets match current code.
- `accreditation-state-read-latest-action-wins-2026-05-15.md`: the canonical and example SQL showed
  an unfenced shape with a `block_num >=` floor and `op.trx_id`. They now show the fenced shape
  with `included_trx_id` and no floor. The `/verify` caller snippet matches the helper.
- No new entry: the single-op finding sits in the fence entry. CONCEPTS.md: scanned, no qualifying
  terms.

**Out of scope, noticed (for triage).**

1. `accreditation-state-read-latest-action-wins-2026-05-15.md` is partly superseded.
   `getAccreditationFromHaf` (`routes/profile.ts`) and `routes/accreditations.ts` now answer
   "currently accredited" through `activeAccreditationsCteBody` (sanctions, WoT threshold,
   legacy revoke). Its site list (line numbers) and its "any state read must use bare
   latest-action-wins" guidance no longer describe them. Recommend a `/ce-compound-refresh`
   Replace after `backend-verify-gate-treats-wot-enrollee-as-accredited` lands, since that task
   changes `findExistingAccreditation`'s semantics. Its Related list also cites a task file that
   no longer exists, which falls under `architect-solutions-entries-carry-coordination-context`.
2. Two more unfenced probes in `tests/lib/idempotency-real-haf.test.ts`, both test-only and with
   a genesis floor: `findKnownExistingAccreditationFixture` and the forged-accredit probe in
   `findExistingAccreditation`'s per-route scoping spec. They pass but take 11 to 22 s per spec.
   They fit `backend-idempotency-real-haf-discovery-walks-the-chain`, if that task does not
   already cover them. The same file's "findExistingAccreditation lines 340-343" cite was already
   wrong at HEAD.
3. The `update_weights` read in `loadReputationWeights` (`reputation.ts`) stays out of scope per
   this task (`architect-audit-reputation`). The single-op finding means a non-empty match set
   does not protect it.
4. Scaling note: the fenced form reads every appTag candidate before it sorts. That is trivial at
   22 ops. Re-measure if appTag custom_json volume grows by orders of magnitude.

## Architect re-review (2026-10-07) — HELD PENDING FIXES:

Reviewed `3c76c235` and `10888287` via `/ce-code-review` (full: correctness, security,
adversarial in-process, performance, testing, project-standards, learnings; one validator).
Reviewers read a `git archive` copy of `10888287`. The SQL change is correct: four reviewers
compared all seven literals with `52ad6a26` and found the same predicates, `$N` positions,
params, projected column names, sort keys and directions, the authority filter inside every
CTE, and no `block_num` floor. Caller branches and the 503 and throw paths are unchanged. Scope
1 to 3 and AC 1 to 3 are met. Two items hold the task.

1. **No test fails if the fence is removed.** The testing reviewer replaced `AS MATERIALIZED`
   with `AS` in a scratch copy: `tests/lib/idempotency.test.ts` stayed green for all three
   `idempotency.ts` lookups, and no `pevo/*` lint rule fired in any of the four source files.
   The edited shape pins match only the `ORDER BY` text. `backend-verify-gate-treats-wot-enrollee-as-accredited`
   rewrites `findExistingAccreditation`'s SQL next.
   Fix: in `backend/tests/lib/idempotency.test.ts`, add `toMatch(/\bAS\s+MATERIALIZED\b/i)` on the
   captured SQL in the three specs that capture these lookups' SQL: "scopes the custom_json query
   by required_posting_auths containing username and joins haf_operations", "filters by
   accreditationAuthorities + appTag + accredit action and joins haf_operations; orders by
   (block_num, id) DESC", and "filters by appTag + action IN (accredit,revoke) +
   account=$username + accreditationAuthorities; orders by (block_num, id) DESC".
   `wot-threshold-signer-gate.test.ts` makes the same assertion for `loadWotThreshold`. Red
   first: each new assertion fails when its lookup's `AS MATERIALIZED` is replaced by `AS`. No
   new spec for the other four lookups.

2. **The fence entry's text, via `/ce-compound-refresh` scoped to
   `haf-custom-json-latest-op-materialized-fence-2026-06-14.md`:**
   - The SQL snippet under "Wrap the row match in a `WITH candidates AS MATERIALIZED (...)`
     optimization fence" still selects `json, block_num` and orders by `block_num DESC` alone.
     Give it the shape of the entry's own Examples "After" block: `id` in the CTE's select list
     and `ORDER BY block_num DESC, id DESC`.
   - In the paragraph "A non-empty match set does not make the unfenced form safe", delete "and
     returned identical rows" from the last sentence. The unfenced form never ran on a
     non-matching input.
   - In the sentence "The fence is verified on live HAF for `loadWotThreshold` and, on
     2026-10-06, for ...", delete `findCustodyBroadcastByIdempotencyKey` (custom_json arm) and
     `findAccreditationBroadcastByIdempotencyKey`. Their match path ran only with `'action'` in
     place of `'idempotency_key'`.
   Delete or narrow only; add no qualifying sentences.

Triage of the rest (user, 2026-10-07, as recommended):

- The latest-action-wins entry's claim that `wot.ts:347` produces revoke ops (false; the admin
  sanction route broadcasts them): folded into the `/ce-compound-refresh` already listed under
  "[TODO Architect] at archive" in `backend-verify-gate-treats-wot-enrollee-as-accredited`.
- Pre-existing: `accreditationRequestSchema.field` has no character check, and a `\u0000` or
  lone-surrogate escape in an on-chain op makes every `cj.json::jsonb` cast of that row throw.
  Folded into `backend-accreditation-character-rule-on-other-chain-writes`, raised to high, with
  lone surrogates added. The read side (any Hive account can broadcast under the app tag's
  custom_json id) is filed as `backend-custom-json-unicode-escape-breaks-jsonb-casts`.
- Signal note 3 (`update_weights`): one line added to `architect-audit-reputation`.
- `fetchConsentOpsForPaper` and the `revoteResult` read in `routes/papers.ts` were never
  plan-checked: noted in `architect-audit-paper-routes-and-consent`.
- Dismissed: SQL-shape specs for the other four lookups and for the custody arm's sort order (no
  consequence today); signal note 4 (scaling, 22 ops). Signal notes 1 and 2 are already covered
  by `backend-verify-gate-treats-wot-enrollee-as-accredited` and
  `backend-idempotency-real-haf-discovery-walks-the-chain`.

## Backend re-review signal (2026-10-07, commits 8fccf4f0, 35e4cac3 and d442a4b7)

**Landed.** Three commits, each checked with `git merge-base --is-ancestor <sha> main`:
`8fccf4f0` (hold item 1, `backend/tests/lib/idempotency.test.ts` only, +3 lines), `35e4cac3`
(hold item 2, `[skip-zone-audit]`), and `d442a4b7` (two user-approved follow-ups on the same
entry, `[skip-zone-audit]`; item 3 below).

1. **Hold item 1.** `toMatch(/\bAS\s+MATERIALIZED\b/i)` on the captured SQL in exactly the three
   specs the hold names, one line each, with no comment:
   - custody custom_json arm (asserted on the second query call): "scopes the custom_json query by
     required_posting_auths containing username and joins haf_operations";
   - `findAccreditationBroadcastByIdempotencyKey`: "filters by accreditationAuthorities + appTag +
     accredit action and joins haf_operations; orders by (block_num, id) DESC";
   - `findExistingAccreditation`: "filters by appTag + action IN (accredit,revoke) +
     account=$username + accreditationAuthorities; orders by (block_num, id) DESC".

   No new spec and no other edit in the file. Red first, in a scratchpad `git archive` copy with
   `tests/setup.ts` stubbed: replacing one site's `AS MATERIALIZED` with `AS` fails exactly that
   site's spec, on the new assertion (1 failed, 28 passed, exit 1, at each of the three sites).
   The HEAD test file stays green under the same three mutants (29 passed, exit 0). An independent
   verifier replicated both in its own copy.

2. **Hold item 2.** `/ce-compound-refresh` scoped to
   `haf-custom-json-latest-op-materialized-fence-2026-06-14.md`, classified Update, with the three
   prescribed edits and no sentence added:
   - the Guidance snippet projects `json, block_num, id` and orders by `block_num DESC, id DESC`,
     the shape of the entry's Examples "After" block and of `loadWotThreshold`;
   - "and returned identical rows" is deleted;
   - `findCustodyBroadcastByIdempotencyKey` (custom_json arm) and
     `findAccreditationBroadcastByIdempotencyKey` are deleted from the verified-on-live-HAF sentence.

   CONCEPTS.md: scanned, no qualifying terms. Discoverability: root `CLAUDE.md` already covers the
   store.

3. **Beyond the hold (`d442a4b7`).** The verification pass below raised two points on the entry,
   and the user chose to fix both:
   - The Guidance sentence "Verified against live HAF: ~15ms vs ~18s, and the blocks index scan
     reports `(never executed)`" sits under the edited snippet, which now projects `id`. The 15 ms
     was measured on the two-column CTE before `id` was added, and nothing re-measured it. The
     timing is deleted; the `(never executed)` observation stays. The Examples block's "~15ms"
     line is unchanged, because it already says current code also projects `id`.
   - `35e4cac3` had left the verified-sites paragraph on one 112-character line. It is re-wrapped,
     with no word changed.

**Runs.**

- `npm run typecheck`: exit 0. `npx eslint tests/lib/idempotency.test.ts`: exit 0.
- `tests/lib/idempotency.test.ts` and `tests/eslint`, shared checkout, root `CLAUDE.md` recipe:
  10 files, 175 passed, exit 0.

**Review passes.** `/ce-code-review` was not run (backend role). A read-only verification workflow
ran three lenses (red-first replication, entry truth against the code and this task's AC 2 table,
hold completeness), with two refuters per finding. One P3 survived, the 112-character line, fixed
in `d442a4b7`. Residual notes, no action taken:

- A mutant that keeps `AS MATERIALIZED` but moves `ORDER BY ... LIMIT 1` inside the CTE passes the
  custody custom_json spec, which has no ORDER BY pin. At the two accreditation lookups only the
  existing ORDER BY pin catches it. This is outside the hold's red-first criterion, and the
  2026-10-07 triage dismissed a custody sort-order spec. `AS NOT MATERIALIZED` and an inlined
  subquery both fail the new assertion at all three sites.
- The new assertions pin SQL text against a mocked pool, not the live plan.

**Learnings checkpoint.** `/ce-compound-refresh` on the fence entry (`35e4cac3`, `d442a4b7`). A
grep of `agents/docs/solutions/` for the two dropped lookups and for fence-pinning claims found no
other entry contradicted. No new entry: the commits and this block carry everything this round
established.
