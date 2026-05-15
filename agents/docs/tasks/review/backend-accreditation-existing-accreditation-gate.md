# BACKEND-ACCREDITATION-EXISTING-ACCREDITATION-GATE — Add HAF gate for prior accredit op on /verify

**Owner:** Backend Agent
**Created:** 2026-05-11 (architect, filed at re-review of `backend-broadcast-idempotency-cluster-followup` commit `c8153e3` — finding F7)
**Priority:** P2 (structural gap; bounded duplicate-op class)

## Why now

The `/api/accreditation/verify` route has no "is this user already accredited" gate before broadcasting. The only dedup is the new Option A.4 `idempotency_key` match (deterministic per token: `sha256(token:hive_username)`). This per-token dedup is correct for token-scoped retries but cannot prevent multi-token coexistence from producing duplicate accredit ops.

Reproducer:
1. User submits `POST /api/accreditation/request` at t=0 → token T1 issued, 24h TTL.
2. T1's email is delayed (greylist, spam filter).
3. User submits `/request` again at t=10min → token T2 issued (rate limiter allows 3/24h `byAccount`); both T1 and T2 are valid pending tokens.
4. Both emails arrive eventually. User clicks T2's link first → `/verify(T2)` computes `K2 = sha256(T2:hive_username)`, HAF miss (no prior K2 op), broadcasts accredit op signed by `accreditationAuthorities`, lands `tx=Tx2`, `deleteToken(T2)`.
5. User later clicks T1's link → `/verify(T1)` computes `K1 = sha256(T1:hive_username)` — **different from K2 because token is part of the hash**. HAF miss on K1 (chain only has K2). Broadcasts a **second accredit op**, lands `tx=Tx1`.

End state: two accredit ops on chain for the same user, both signed by admin authority, paying admin-key RC for the duplicate. The reputation cycle is unaffected (user is accredited; the duplicate doesn't change the score), but the on-chain row count grows + operator log noise + admin-key RC waste.

The class is bounded: at most 3 duplicate accredit ops per user per 24h (`/request` rate limiter cap). Not exploitable beyond auth boundaries (admin-key RC has high headroom). But the absence of an existing-accreditation gate is structurally surprising — every other state-mutating route in PEvO has an "is this already done" check before broadcasting.

Filed as a separate task from the parent because:
1. **Pre-existing structural gap** — would be a defect regardless of whether Option A.4 landed. Idempotency exposed it via the multi-token edge.
2. The fix is route-shape (HAF query) + new response value, deserving its own design pass.
3. The parent task is already carrying 19 hold items; bundling further bloats it.

## Goal

Add an existing-accreditation HAF gate to `/api/accreditation/verify` that fires **before** the broadcast step (and before the idempotency-key HAF lookup). On gate-hit, return 200 with a NEW `outcome: 'already_accredited'` value distinguishing it from `outcome: 'already_landed'` (which means same-key dedup).

## Acceptance

1. **New helper or extended lookup in `backend/src/lib/idempotency.ts`** (or co-located lib): `findExistingAccreditation(hiveUsername: string): Promise<{ tx_id: string; block_num: number | null } | null>`. Queries HAF for any prior `accredit` op scoped by:
   - `cj.custom_id = '${appTag}'`
   - `cj.required_posting_auths ?| $accreditationAuthorities::text[]`
   - The accredit payload's `account` field equals the input `hiveUsername` (extracted via the same JSONB operator pattern the rest of the module uses).
   - `cj.block_num >= getCachedGenesisBlock()`
   - `ORDER BY block_num DESC, trx_in_block DESC LIMIT 1` (per `hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md` Rule 2).
2. **`routes/accreditation.ts /verify` integration:** the gate runs **before** the idempotency-key check (which itself runs before broadcast). Order: per-op validation → existing-accreditation gate → idempotency check → broadcast. On gate-hit: return 200 `{ message, username, tx_id, outcome: 'already_accredited' }`. Best-effort `deleteToken(token)` per the same wrap pattern as the idempotency-hit path.
3. **New `outcome` value documented:** `outcome: 'already_accredited'` is distinct from `outcome: 'already_landed'` (same-key dedup). The former means "this user has a prior accredit op from a DIFFERENT key (e.g., different token)"; the latter means "this exact key has been seen."
4. **Tests:** real-path or mocked (per carve-out) for: (a) gate-hit returns `'already_accredited'` with existing tx_id; (b) gate-miss flows to the idempotency-key check; (c) HAF-throw on the gate query degrades gracefully (broadcast proceeds with a warn).
5. **Architect at archive:** new `outcome` value documented in `agents/docs/api-contracts/accreditation.md` success-response shape extension. Add structured log event `accreditation.verify.existing_accreditation_hit`.

## Out of scope

- Generalizing to other routes (custody, claims, papers). Custody is intrinsically per-op so the analogous concept doesn't apply; claims/papers may have their own equivalent gates already.
- Refactoring the broader idempotency module structure.
- Changing the `idempotency_key` derivation. Keeping `sha256(token:hive_username)` because it's correct for the per-token retry case; this task adds the user-level gate ABOVE the token-level gate.

## Source

- `backend-broadcast-idempotency-cluster-followup.md` architect re-review 2026-05-11, finding F7.
- Adversarial reviewer "Multi-token coexistence breaks deterministic accreditation idempotency key" (anchor 90).

## Cross-references

- `agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md` Rule 2 (per-op ordering tiebreaker).
- `agents/docs/solutions/conventions/caching-wrapper-discriminated-union-poisoning-2026-05-11.md` (apply if extending F5's Redis layer to cache this gate's result).
- `backend/src/routes/accreditation.ts` — `/verify` handler integration site.
- `agents/docs/hive-schemas.md` section 2.1 — accredit custom_json schema.

## Backend implementation signal (2026-05-15)

Landed on working tree (pre-commit, to be committed before move to review/):

1. **New helper:** `findExistingAccreditation(pool, hiveUsername)` in `backend/src/lib/idempotency.ts`. Query shape mirrors `findAccreditationBroadcastByIdempotencyKey` and adds the `account = $username` payload-binding filter. ORDER BY uses `(cj.block_num DESC, cj.id DESC)` — `cj.id` substitutes for `trx_in_block` per the column-omission note in `backend/src/consent-ops.ts:14-23` (the convention's tiebreaker intent preserved via the monotonic HAF op-id).

2. **Route wire:** `backend/src/routes/accreditation.ts /verify` runs the gate inside the existing `if (hafPool)` block, BEFORE the per-token `lookupAccreditationBroadcastIdempotency` call. Order is now: validation → existing-accreditation gate → per-token idempotency check → pre-INCR → broadcast. Both lookup layers fire before the cap pre-INCR so a hit consumes zero cap slots. Token cleanup on gate-hit uses `deleteTokenBestEffort` with distinct discriminators (`existing_accreditation_hit_token_cleanup_failed`). Gate HAF-throw degrades to a structured warn (`existing_accreditation_lookup_failed`) and falls through to the per-token check. `seedAccreditationBonus` is NOT re-invoked on gate-hit (the prior /verify call that produced the on-chain accredit op seeded the bonus; the periodic reputation batch and boot-time `backfillAccreditationSeeds` reconcile if it somehow didn't).

3. **Structured log events added** (inline in route; for operator dashboards):
   - `accreditation.verify.existing_accreditation_hit` (info) — gate hit, prior tx_id returned.
   - `accreditation.verify.existing_accreditation_lookup_failed` (warn) — gate HAF query threw.
   - `accreditation.verify.existing_accreditation_hit_token_cleanup_failed` (warn) — orphan-cleanup signal on gate-hit branch.

4. **Tests:**
   - `backend/tests/lib/idempotency.test.ts` → new `describe('findExistingAccreditation')` block (3 specs: hit, miss, SQL shape).
   - `backend/tests/routes/accreditation-idempotency.test.ts` → new `describe('… existing-accreditation gate (user-level)')` block (4 specs: gate-hit happy path, gate-hit while counter at cap, gate HAF throw falls through, gate-hit token cleanup failure). Existing per-token specs in the same file have been updated to chain `hafQueryMock.mockResolvedValueOnce({rows: []})` for the gate preamble before their existing mocks.

5. **Carve-out clause (c) hook:** real-path coverage for `findExistingAccreditation` joins the `backend-idempotency-haf-integration-test.md` scope (sibling helper, same risk class — HAF schema / operator / JSONB-extraction change silently breaking the SQL). See [TODO Architect] item below; the existing follow-up task should explicitly enumerate the new helper alongside the two prior helpers it already covers.

## [TODO Architect] — contract + cross-task scope updates at archive time

1. **`agents/docs/api-contracts/accreditation.md`** — extend the `POST /api/accreditation/verify` success-response shape to document the new `outcome` enum value `'already_accredited'` alongside the existing `'already_landed'`. Suggested prose distinction:
   - `outcome: 'already_landed'` (existing): "the same per-token retry has already produced a chain op — same `idempotency_key` already on chain."
   - `outcome: 'already_accredited'` (new): "this Hive account has a prior `accredit` op on chain from a DIFFERENT verification flow (e.g., a sibling pending token). No broadcast was attempted."

   Both branches return the same envelope shape (`{ message, username, tx_id, outcome }`); only the discriminator differs. The `tx_id` references the relevant prior chain op in each case.

2. **`backend-idempotency-haf-integration-test.md`** — append `findExistingAccreditation` to the helper list under "Why now" and "Goal" so the integration spec covers all three sibling helpers (the existing two + this new one). The risk class is identical (HAF JSONB extraction / schema-rename regression silently breaking the lookup), and the gate's correctness is load-bearing for closing the multi-token coexistence class.

## Architect re-review (2026-05-15) — HELD PENDING FIXES

`/ce-code-review` run id `20260515-123246-1289ca32`. 11 reviewer personas dispatched (always-on + security + performance + api-contract + reliability + adversarial + kieran-typescript; ce-agent-native-reviewer skipped per root CLAUDE.md). 11 findings surfaced; user triage:

5 items held (1 P1, 3 P2, 1 P3). 2 archive-time follow-ups. 4 dismissals.

### Hold items

1. **[P1] Revoke-handling alignment — `findExistingAccreditation` ignores subsequent revoke ops.** The new gate filters strictly on `action = 'accredit'` (idempotency.ts:299-319). Every sibling accreditation-state read in PEvO uses `action IN ('accredit','revoke') ORDER BY block_num DESC` and treats latest=revoke as not-accredited:
   - `backend/src/routes/profile.ts:37`
   - `backend/src/routes/orcid.ts:1756`
   - `backend/src/routes/accreditations.ts:59`
   - `backend/src/hafsql.ts:79`
   - `backend/src/wot.ts:347` — **live producer of revoke ops** via the WoT cleanup path.

   A revoked user's `/verify` retry hits the gate on the old accredit op, gets `200 outcome='already_accredited'` with the stale tx_id, has their fresh token deleted by cleanup, and is silently locked out of re-accreditation. The gate's "has prior accredit" semantics structurally diverge from the codebase's "current accreditation state" semantics.

   Fix shape (defensible from sibling patterns):
   - Change the `WHERE` clause in `findExistingAccreditation` to `cj.json::jsonb ->> 'action' IN ('accredit','revoke')`, keep the same `ORDER BY (cj.block_num DESC, cj.id DESC) LIMIT 1`, return the row.
   - Inspect `row.action` in the caller (or in the helper before return); gate-hits only when `row.action === 'accredit'`. When the latest is `'revoke'`, return `null` so /verify falls through to the per-token check + broadcast path (same as gate-miss).
   - Add a route-level test for the revoke→re-accredit flow: prior accredit (block N) then revoke (block N+M) → /verify on a fresh token broadcasts the new accredit op (no gate-hit).
   - Helper signature may need to widen the result type to include `action` (or just return `null` for revoke-tail and keep the existing `{ tx_id; block_num }` shape).

   Surfaced by cross-reviewer corroboration (correctness + adversarial, merged confidence 100). This is the structural blocker.

2. **[P2] Carve-out clause (c) follow-up scope update.** The pending task `backend-idempotency-haf-integration-test.md` names the two prior HAF helpers in Goal and Acceptance but does NOT name `findExistingAccreditation`. Edit that task file to add the new helper to its "Why now" and "Goal" sections (risk class identical: HAF JSONB extraction / operator / schema-rename regression silently breaking the lookup). This was queued as `[TODO Architect]` item 2 for archive-time; landing it as a hold-block item closes the carve-out clause (c) loop in the same round as #1.

3. **[P2] Carve-out clause (a) header acknowledgment.** `backend/tests/lib/idempotency.test.ts` header at lines 13-15 names the two prior helpers as having deferred real-path coverage but omits `findExistingAccreditation`. Append `findExistingAccreditation` to the same acknowledgment line so clause (a) — "test file header documents the justification explicitly" — is satisfied per-file. (The route test header at `accreditation-idempotency.test.ts` already names it; only the lib unit test header is missing it.)

4. **[P2] Metadata-update path on gate-hit (design-call linked to #1).** Gate-hit short-circuits before profile metadata (name, institution, field) submitted in the fresh `/request` would be written. After #1's revoke-handling fix lands, verify the current product flow:
   - **If profile metadata is one-shot at first `/request` (not updateable thereafter):** the gate-hit metadata discard is moot — the new `/request` carries identical metadata to the prior — and a short comment near the gate-hit branch documenting the invariant closes this item. Backend can resolve in this round.
   - **If profile metadata is intended to be updateable post-accreditation:** the gate currently silently eats updates. This is a design pass (broadcast a fresh accredit op carrying new metadata? A distinct `update_accreditation` custom_op? Reject metadata changes at `/request` when an accreditation exists?). In that case, do NOT resolve in this round — `git mv` the task to `blocked/` with `[BLOCKED by Architect]` and a one-paragraph statement of the design question.

5. **[P3] Sibling helper ORDER BY tiebreaker alignment.** `findAccreditationBroadcastByIdempotencyKey` (idempotency.ts:253) sorts by `cj.block_num DESC` only. The new helper at line 312 sorts by `(block_num DESC, cj.id DESC)` with JSDoc citing the uniform PEvO tiebreaker convention (`hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md` Rule 2). Add `cj.id DESC` to the sibling's ORDER BY so the new convention anchor is upheld across both helpers. Mechanical edit. Under LIMIT 1 the practical impact is bounded but the convention-alignment signal matters.

### Archive-time follow-ups (architect, on next clean review)

A. **Update `agents/docs/api-contracts/accreditation.md`** per the existing `[TODO Architect]` item 1, AND rewrite the binary-prose paragraph at line 130 to enumerate all three outcome states (absent | `'already_landed'` | `'already_accredited'`) rather than appending a bullet. The `BROADCAST_ATTEMPT_LIMIT_EXCEEDED` ordering-guarantee paragraph at line 137 also needs a one-line extension naming both short-circuit outcomes, not just `'already_landed'`. Distinguish `tx_id` semantics across the three states (fresh broadcast = this call's tx; `'already_landed'` = prior broadcast of same token; `'already_accredited'` = prior accredit op from a different flow, potentially older). If #1's fix changes the `'already_accredited'` semantic ("prior accredit op" → "current active accreditation"), reflect that wording shift.

B. **Verify `backend-idempotency-haf-integration-test.md` was updated by backend in this round** (hold item #2). The `[TODO Architect]` item 2 in this task's signal block can then be marked done.

### Dismissed (with reasons)

- **HAF-throw fallthrough reopens duplicate class during HAF outage** (adversarial, P3 conf 100) — by design and documented in this task's "Why now" section as a bounded class (≤3 duplicates/user/24h via `/request` rate limiter). The gate is best-effort dedup; the HAF-throw try/catch preserves pre-gate baseline behavior.
- **Cleanup-failure feedback loop** (adversarial, P3 conf 75) — requires both consistent Redis del flapping AND client retry; bounded by token's 24h TTL and operator dashboard rate-limiting. No concrete production scenario.
- **Multi-token concurrent burst** (adversarial, P3 conf 75) and **same-token concurrent retry** (adversarial, P3 conf 75) — both are the bounded duplicate-broadcast classes the task explicitly accepts. Same disposition as the HAF-throw window above.

### Convention compliance (verified by `ce-learnings-researcher`)

Applied correctly in this diff:
- `hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md` Rule 2 (block_num + cj.id DESC tiebreaker in the new helper) and Rule 5 (signer-subject binding via `required_posting_auths ?| $accreditationAuthorities::text[]`).
- `typescript-template-literal-sql-backtick-pitfall-2026-05-15.md` — no SQL block comments inside backticks.
- `caching-wrapper-discriminated-union-poisoning-2026-05-11.md` — uncached path taken; no poisoning vector.
- `test-mock-carve-out-clause-c-2026-05-04.md` — follow-up task deferral mechanic used correctly; hold items #2 and #3 close the residual gaps.

### Clean dimensions (no findings)

`security`, `performance`, `reliability`, `kieran-typescript` returned zero findings each. SQL parameterization, JSONB extraction operator usage, async/await placement, error-handling typing, and HAF-throw fallthrough preservation are all clean.

## Backend re-review signal (2026-05-15, commit `61ae0da` on `main`)

**Worker:** Backend worktree subagent (rebased onto main `b71e3c6` before editing).

**Round-1 hold-block items addressed:** all 5 (1 P1, 3 P2, 1 P3).

### Item 1 [P1] — revoke-handling alignment in `findExistingAccreditation`

File: `backend/src/lib/idempotency.ts:299-321` (`findExistingAccreditation` helper).

- `WHERE` clause now selects `cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')`. Mirrors the sibling reads at `profile.ts:37`, `orcid.ts:1756`, `accreditations.ts:59`, `hafsql.ts:79`, `wot.ts:347`.
- `SELECT` projects the `action` column alongside `trx_id` and `block_num`. Row type widened to `{ trx_id: string; block_num: number | null; action: string }`.
- Latest-action-wins applied in the helper (not the caller): when `row.action !== 'accredit'` (i.e., latest op is revoke), return `null`. Helper signature is unchanged from the caller's perspective (still returns `IdempotencyHit | null`); the revoke-tail branch returns `null` exactly like the gate-miss branch, so the /verify route falls through to the per-token check + broadcast path without any callsite change.
- ORDER BY remains `(cj.block_num DESC, cj.id DESC) LIMIT 1` (convention Rule 2). JSDoc updated to note tiebreaker determinism matters MORE here than under the prior strict-accredit shape, because picking the wrong same-block row can now flip between accredit/revoke actions and change the gate-hit/gate-miss outcome.

Route-level regression guard: new spec at `backend/tests/routes/accreditation-idempotency.test.ts` inside the `accreditation /verify — existing-accreditation gate (user-level)` describe block, titled `revoke→re-accredit flow: latest action is revoke → gate falls through, fresh broadcast fires`. Mocks the gate query to return `{ trx_id: 'tx-revoke-after-accredit', block_num: 99999, action: 'revoke' }`, then the per-token check empty, asserts the broadcast fires and the response is the fresh-accred-tx-id envelope (no `outcome` field). Pre-fix this test would have failed: the gate would have hit on the revoke row's trx_id and returned `outcome:'already_accredited'` with the stale tx_id.

Lib unit-test coverage: new spec at `backend/tests/lib/idempotency.test.ts` inside the `findExistingAccreditation` describe block, titled `returns null when latest action is revoke (revoke→re-accredit flow falls through to broadcast)`. Pins the helper-level behavior directly with a mocked pool row carrying `action: 'revoke'`.

### Item 5 [P3] — sibling helper ORDER BY tiebreaker alignment

File: `backend/src/lib/idempotency.ts:240-260` (`findAccreditationBroadcastByIdempotencyKey`).

ORDER BY now `cj.block_num DESC, cj.id DESC` matching the new helper. JSDoc added inline explaining convention Rule 2 anchor + bounded practical impact under LIMIT 1 (idempotency_key collisions are vanishingly unlikely). SQL-shape test in `tests/lib/idempotency.test.ts` updated to assert the tiebreaker pin.

### Item 2 [P2] — integration-task scope update

File: `agents/docs/tasks/review/backend-idempotency-haf-integration-test.md` (task lives in `review/` on main as of `b71e3c6`; the architect will move it back to `pending/` if a fresh round is needed, but the edit applies in place).

- "Why now" paragraph rewritten to enumerate all three sibling helpers (`findCustodyBroadcastByIdempotencyKey`, `findAccreditationBroadcastByIdempotencyKey`, `findExistingAccreditation`) and the shared risk class.
- "Goal" sentence amended to list all three helpers as integration-test scope.

### Item 3 [P2] — carve-out clause (a) header acknowledgment

File: `backend/tests/lib/idempotency.test.ts:1-21` (file header JSDoc).

Real-path companion attribution line now lists all three helpers (`findCustodyBroadcastByIdempotencyKey`, `findAccreditationBroadcastByIdempotencyKey`, `findExistingAccreditation`) alongside the schema-regression risk-class statement.

### Item 4 [P2] — metadata-update path on gate-hit (one-shot disposition resolved in-round)

File: `backend/src/routes/accreditation.ts:478-498` (gate-hit branch in `/verify`).

Verified the product flow: there is no `update_accreditation` custom_op (`grep update_accreditation` in `backend/src/` finds only the notification type, not a broadcast helper); the only path that captures `full_name`/`institution`/`field` is `POST /api/accreditation/request`, which feeds the metadata into the pending row and then into the `accredit` custom_json at `/verify`. The product model is one-shot at first /verify; there is no UI affordance for editing accreditation metadata post-verification. Inline comment added near the gate-hit `return sendOk(...)` documenting this invariant and the future-design hook (broadcast fresh accredit op, distinct `update_accreditation` op type, or reject metadata changes at /request) if updateable-metadata is later introduced. Item resolved in this round per the hold-block's "one-shot branch" disposition; no `blocked/` move required.

### Verification

- `npx vitest run tests/lib/idempotency.test.ts` → 29 passed.
- `npx vitest run tests/routes/accreditation-idempotency.test.ts` → 12 passed.
- `npm run lint` → 0 errors (2 pre-existing warnings in unrelated `seed-phrase.ts`).
- `npx tsc --noEmit -p tsconfig.json` → clean.

### Files staged for this round

- `backend/src/lib/idempotency.ts` (item 1 + item 5)
- `backend/src/routes/accreditation.ts` (item 4 comment)
- `backend/tests/lib/idempotency.test.ts` (item 3 header + item 1 + item 5 lib-level coverage)
- `backend/tests/routes/accreditation-idempotency.test.ts` (item 1 route-level revoke→re-accredit spec + mock-shape updates)
- `agents/docs/tasks/review/backend-idempotency-haf-integration-test.md` (item 2)
- `agents/docs/tasks/pending/backend-accreditation-existing-accreditation-gate.md` (this signal block, separate commit)

**Architect: please mv to `review/` on intake.**
