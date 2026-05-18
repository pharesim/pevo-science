# BACKEND-VERIFY-POST-SUCCESS-RETRY-IDEMPOTENCY — Grace-period idempotency on `/api/accreditation/verify` across the AbortError-after-success window

**Owner:** Backend
**Created:** 2026-05-18 (architect, from `/ce-brainstorm` on the round-1 review of `ui-accreditation-verify-network-error-retriable` — adversarial reviewer surfaced the cascade)
**Priority:** P2 (UX cascade real but rare; not deploy-blocking)

## Summary

Make `POST /api/accreditation/verify` idempotent across the AbortError-after-success window. After a successful on-chain broadcast, write a short-lived grace-period record keyed by `sha256(token)` to Redis just before `deleteToken`; a subsequent `/verify` with the same token returns the same 200 success envelope as the original flight instead of falling through to `400 BAD_REQUEST`. SPA needs zero changes.

## Problem Frame

The cascade — discovered during architect review of `ui-accreditation-verify-network-error-retriable`:

1. User clicks `/verify` with token T. Backend receives request, completes on-chain accreditation broadcast, deletes token T from Redis.
2. SPA's 30s `AbortSignal.timeout` fires before the response body lands at the client. Fetch throws `AbortError`.
3. SPA's just-landed `_isNetworkError` discriminator catches `AbortError` → routes to the `retriable_error` state with 5s cooldown → Retry CTA. (Working as designed for offline / DNS / network-drop.)
4. User clicks Retry → SPA sends token T again → backend's `getToken(T)` returns null (deleted in step 1) → emits `400 BAD_REQUEST "Invalid or expired token"`.
5. `400` is not `_isNetworkError` and not `_isRetriable` (no `code: ACCREDITATION_GATE_UNAVAILABLE`, no `details.retriable`). Falls through to generic error state with "Request New" CTA.
6. User clicks "Request New" → burns 1 of 3/24h `/api/accreditation/request` slots → re-enters email-link flow → eventually hits the existing-accreditation gate (503 ACCREDITATION_GATE_UNAVAILABLE) on the new token → SPA shows retriable → confused.

The user's accreditation actually succeeded on chain in step 1. The UI puts them through 5+ confused clicks before they can verify success via their profile.

**Why narrow today:** requires (AbortError at ~30s) AND (broadcast committed before timeout) AND (`deleteToken` completed) AND (user clicks Retry then Request New). PEvO single-instance scale, low traffic. But the cascade exists by design — the `_isNetworkError` work handles "fetch never reached server", NOT "fetch reached server and succeeded but response was lost".

## Goal

Make `/verify` idempotent across the 24h grace period for any token whose original flight already broadcast successfully. The SPA's Retry CTA on the AbortError path then resolves to the same success state the user would have seen had the original response landed.

## Acceptance

### 1. Grace-period record written before `deleteToken`

On the successful-broadcast path in `POST /api/accreditation/verify` (after `seedAccreditationBonus` and any other post-broadcast bookkeeping, immediately before `deleteToken(token)`), write a Redis record:

- **Key:** `accreditation-completed:<sha256(token)>` (prefixed per [[reference_redis_app_tag]] — `${config.appTag}:accreditation-completed:<hash>`).
- **Value:** JSON-serialized `{ username, broadcast_id, accredited_at }` (or whatever fields the existing fresh-success 200 envelope needs to reconstruct; implementer derives exact field set from the current /verify success path).
- **TTL:** 24h, matching the original token's TTL. Symmetric, no Redis-cost concern at PEvO scale, covers retries across the day. Tightening to 30-60 min is acceptable if the implementer judges the URL-as-replay window warrants it — flag the choice in the signal block.

The write and `deleteToken` MUST commit atomically — ideally in the same Redis MULTI/pipeline. If atomic commit isn't trivially available against the existing helpers, document the chosen ordering and the failure-window semantics in the signal block (the failure modes are mild: grace-period without token-delete = next /verify still finds the pending token; token-delete without grace-period = next /verify returns 400 same as today).

### 2. Idempotent 200 on token-not-found + grace-period hit

In the `/verify` handler, when `getToken(token)` returns `null` (currently the 400 BAD_REQUEST path), check `accreditation-completed:<sha256(token)>` BEFORE returning 400:

- **Grace-period record present** → return 200 with the **identical envelope shape** the original fresh-success path would have emitted. Same `username`, `broadcast_id`, `accredited_at`, and any other fields. The SPA's existing success-state handler must render the response without any SPA branching.
- **Grace-period record absent** → fall through to the existing 400 BAD_REQUEST "Invalid or expired token" path. No change.

### 3. No SPA changes

The envelope is byte-identical to the fresh-success 200 by design (this is the load-bearing constraint per the brainstorm). Verify that the SPA's existing success handler renders without modification. If a discrepancy surfaces during implementation (e.g., the fresh-success path includes a field that's hard to reconstruct from the grace-period record), revisit envelope identicality vs SPA branching as a `[BLOCKED by Architect]` re-decision.

### 4. Tests

Per PEvO test conventions:

- **Real-path spec** in `backend/tests/routes/accreditation-idempotency.test.ts` (or a sibling) exercising the full sequence: /verify(token T) → broadcast succeeds → token deleted → grace-period record written → /verify(token T) again → 200 success envelope. Asserts the second response body matches the first (deep equality on the rendered envelope, modulo any timing fields like `accredited_at`).
- **Mocked-pool spec** in a sibling file if needed to deterministically pin the grace-period-record presence/absence branches (clauses (a)/(b)/(c) per root CLAUDE.md "Running Tests"). Clause (b) is N/A — route is unauthenticated, no `verifyHiveSignature` middleware to mock.
- **Negative spec:** token-not-found + no grace-period record → 400 BAD_REQUEST envelope unchanged from today.

### 5. No contract change visible to consumers

The 200 envelope is identical. The new path is observable only via Redis state (`accreditation-completed:*` keys) and via the fact that retried-token /verify no longer 400s. Update `agents/docs/api-contracts/accreditation.md` with one sentence under the 200-success row noting idempotency across the 24h grace-period window. **Architect-owned at archive time** — flag via `[TODO Architect]` in the implementer signal block.

## Out of scope

- **Frontend changes.** Envelope is identical to fresh-success; SPA's existing success-state handler renders it. The just-landed `_isNetworkError` discriminator's behavior is unchanged.
- **The TypeError + 0s cooldown loop** on the sibling task (`ui-accreditation-verify-network-error-retriable`) — dismissed at architect triage.
- **New auth/identity layer on /verify.** Route stays unauthenticated, `byIp`-limited as today.
- **The broader "user is already accredited and visits /verify with a NEW token T2" cascade** — covered by the existing-accreditation gate emitting 503 ACCREDITATION_GATE_UNAVAILABLE (already shipped via the round-3 / α-disposition work on `backend-accreditation-existing-accreditation-gate`).
- **Chain-side mutations.** No new fields in the broadcast `custom_json`.
- **Explicit cleanup of grace-period records.** Redis TTL expiry is sufficient — no sweep job.
- **URL-as-success oracle defense.** During the 24h window, anyone with the token URL hitting /verify gets a 200 with the user's accreditation envelope. The chain itself is already public (accreditation events are visible on-chain), so the URL is not a net-new disclosure surface. If this turns out to be a real concern in production, the mitigation is a tighter TTL (already an implementer-judged knob in §1).

## Key decisions (recorded from `/ce-brainstorm`)

- **Backend-only fix, not SPA-only soft-nudge.** A soft-nudge ("your accreditation may have already succeeded — check your profile") doesn't recover certainty; user has to verify on their own. The backend grace-period record makes /verify idempotent so the SPA renders concrete success. Worth the small backend cost.
- **Envelope identical to fresh-success.** Cleanest user experience; no SPA branching; backend-only task scope. Trade-off: backend logs can't distinguish fresh vs replayed without inspecting Redis state. At PEvO scale this is acceptable; ops visibility via Redis key counts is sufficient.
- **Key on `sha256(token)`, not raw token.** Mirrors existing `hashTokenForLogs` convention; log/metric strings never leak live token values.
- **TTL = 24h** (default; implementer may tighten to 30-60 min if URL-as-replay window warrants).
- **Architect creates this task; Backend implements.** Per PEvO architect protocol (root CLAUDE.md rule #2 + agents/architect/CLAUDE.md "architect-self-task creation" rule), this task is filed under `tasks/pending/` for the Backend agent to pick up.

## Source

- `/ce-code-review` cluster pass on `ui-accreditation-verify-network-error-retriable` round-1 (commit `a6fc5d4`), 2026-05-18. Adversarial reviewer finding `adversarial-1` (P2, conf 75).
- `/ce-brainstorm` design session 2026-05-18 narrowed the design space from three proposed shapes (backend grace-period / SPA soft-nudge / chain-only) to backend grace-period + identical envelope.

## Cross-references

- `backend/src/routes/accreditation.ts` — `/verify` handler (around the successful-broadcast path that calls `seedAccreditationBonus` and `deleteToken`).
- `backend/src/routes/accreditation.ts` — token-not-found 400 BAD_REQUEST emit site (currently right after `getToken(token)` returns null).
- `backend/src/lib/idempotency.ts` — `findExistingAccreditation` (the existing-accreditation gate that handles the separate "already accredited with a new token" cascade).
- Sibling task in flight: `ui-accreditation-verify-network-error-retriable` (in `tasks/pending/` with round-2 hold for citation hygiene) — has a sibling-architect-task note referencing this work.
- Related convention: [[reference_redis_app_tag]] for the `${config.appTag}:` Redis key prefix.
- Related convention: [[skip-failed-requests-jwt-required-credential-verify-carve-out-2026-05-17]] — establishes that `/verify` is unauthenticated by-IP; the grace-period record is NOT a credential-probe surface (token is the secret).

## Implementation hints (non-binding; ce-plan can refine)

- Existing `deleteToken` likely uses a single `redis.del`. To make the write + delete atomic, wrap both in a `redis.multi()` pipeline. If the existing helper structure makes this awkward, splitting `deleteToken` into a `deleteTokenAndRecordCompletion(token, payload)` variant is reasonable.
- The grace-period record's payload should be small enough that it doesn't grow Redis memory materially even with the 24h TTL. A `{username, broadcast_id, accredited_at}` JSON blob is well under 200 bytes per record.
- For the response-envelope reconstruction: read the current fresh-success 200 path's `sendSuccess(...)` (or equivalent) arguments and mirror them. If any field is derived from in-handler state that isn't preserved in the grace-period record, either extend the record or derive the field deterministically from the stored fields.

---

## Implementer signal (Backend, 2026-05-18) — round 1

Landed the grace-period idempotency machinery in `backend/src/routes/accreditation.ts` and three new specs in `backend/tests/routes/accreditation-idempotency.test.ts`. All five task acceptance items satisfied.

### Implementation choices

- **Record payload shape:** `{username, tx_id}` (NOT `{username, broadcast_id, accredited_at}` per the task's tentative hint). The fresh-success 200 envelope is `sendOk(res, {message: 'Accreditation confirmed', username, tx_id})` — `message` is a literal, `tx_id` carries the broadcast id, and no `accredited_at` field exists in the live envelope. Storing only the fields needed for envelope identicality keeps the record small (~80 bytes per entry).
- **Atomicity:** used `redis.multi()` pipeline — `SET completion-record EX 24h` + `DEL pending-accred-token` execute serially without interleaving with other clients. The counter-side-key DEL (`pending_accred_broadcast_attempts:*`) is sequential after the pipeline; its TTL is bounded by the token TTL so brief drift between pipeline and counter DEL is harmless.
- **Best-effort posture:** the success-path call wraps `recordAccreditationCompletion` in try/catch + structured warn (`event: 'accreditation.verify.completion_record_failed_post_success'`). A Redis flap post-broadcast must NOT propagate to Express's async-error handler over the in-flight 200 envelope (closes `helper-extraction-express5-response-ordering-2026-04-28.md` for this site). The pre-task `deleteTokenBestEffort` log discriminator was renamed (`delete_token_failed_post_success` → `completion_record_failed_post_success`) to reflect the broader scope; net log volume change is zero (one warn site → one warn site).
- **In-memory fallback:** added a sibling `memoryAccreditationCompletions` Map alongside the existing `memoryTokens`. Mirrors the existing token-store fallback shape so a Redis-less deployment still gets the grace-period idempotency. The Map enforces its own TTL via the `expires_at` field on the cached entry.
- **TTL:** kept at the task's default 24h. PEvO single-instance scale means the URL-as-replay defense is bounded by entropy (the 256-bit token is the secret); tightening to 30-60 min would not materially change the threat model and would shorten the user's natural retry window. Architect can revisit if traffic patterns change.
- **Scope:** scoped to the fresh broadcast success path (the path explicitly named in the task Goal). The existing-accreditation gate-hit and per-token idempotency-hit branches also call `deleteTokenBestEffort` and are subject to the same AbortError-after-success cascade shape, but the task's Goal scopes this to "the original flight already broadcast successfully" — only the broadcast path. If the architect wants the two hit branches covered too, that is a round-N expansion (the helpers are already in place; the change is a one-line replacement at each hit-branch deleteTokenBestEffort site).

### Code changes

- `backend/src/routes/accreditation.ts`:
  - New module-scope constants/types/helpers near the existing token-store helpers: `ACCREDITATION_COMPLETED_TTL_SECONDS`, `AccreditationCompletionRecord` interface, `memoryAccreditationCompletions` Map, `accreditationCompletedKey(token)` (full sha256 digest, not the truncated `hashTokenForLogs` form), `recordAccreditationCompletion(token, username, txId)` (MULTI pipeline + in-memory fallback), `readAccreditationCompletion(token)` (Redis-first with silent fall-through to in-memory on Redis flap).
  - `/verify` handler at the `!pending` 400 branch: added a grace-period read before the 400 emit. On hit, returns the identical fresh-success envelope. On miss, falls through to the existing 400 BAD_REQUEST emit.
  - `/verify` handler at the broadcast-success site: replaced the prior `deleteTokenBestEffort` call with a try/catch around `recordAccreditationCompletion`. The new helper handles BOTH the completion-record write and the pending-token delete atomically.

### Test changes

- `backend/tests/routes/accreditation-idempotency.test.ts`: appended a new top-level `describe('accreditation /verify — grace-period idempotency (AbortError-after-success)', …)` block with its own `beforeEach`/`afterEach` (the afterEach also cleans `${appTag}:accreditation-completed:*` keys; without the cleanup the 24h-TTL records pile up across test runs).
  - **Spec 1 (acceptance §4 real-path):** drives the full sequence — seed pending token → mock gate miss + idempotency miss → broadcast returns `{id: 'tx-grace-canary-1'}` → first /verify returns 200 with the fresh-success envelope → verify pending token is gone AND the `accreditation-completed:<sha256>` record carries the matching `{username, tx_id}` JSON → second /verify on the SAME token → 200 with envelope deep-equal to the first (`expect(retryRes.body.data).toEqual(firstRes.body.data)`) → assert `broadcastJsonMock.mock.calls.length` did NOT increment (the retry uses the grace-period record, NOT a re-broadcast).
  - **Spec 2 (acceptance §4 negative):** /verify on a fresh random token with NO pending row AND NO grace-period record → 400 BAD_REQUEST with `code: 'BAD_REQUEST'` and `message: /invalid or expired token/i`. Pins the pre-task baseline so a regression that always returns 200 on token-not-found (turning /verify into a 400-vs-200 existence oracle) would surface here.
  - **Spec 3 (envelope/tx_id sanity):** drives the success flight with a unique broadcast id, then asserts the stored grace-period record's `tx_id` matches the BROADCAST id — guards a future refactor that confuses the broadcast-result id with a cached gate-existing id.
- Carve-out note: this file already mocks dhive broadcast + HAF (existing posture documented at the file header). The new specs reuse that mock surface; no new mock target introduced. Real Redis stores the pending row AND the grace-period record (the load-bearing infrastructure under test).

### Verification

- `npm run typecheck` (backend, both `:src` and `:tests`): clean.
- `npm run lint` (backend): clean.
- Targeted vitest (`-t "grace-period idempotency"`): 3/3 new specs pass.
- Full `accreditation-idempotency.test.ts` (with Docker IP env overrides): 16/16 pass — 13 pre-existing + 3 new. No regression on the pre-existing idempotency-hit, cascade-error, broadcast-failure, or other specs.
- Full `accreditation.test.ts` (with Docker IP env overrides): 32 passed / 1 failed. The single failure (`round-4 hold #2: pre-INCR redis.eval rejection surfaces 503 SERVICE_UNAVAILABLE`, 502-vs-503 mismatch) is the documented pre-existing flake — flagged in the round-2 signal blocks of both sibling tasks (`backend-accreditation-limiter-skip-failed` and `backend-accreditation-verify-limiter-skip-failed`). Not caused by this task's changes.

### [TODO Architect] — contract update at archive time

`agents/docs/api-contracts/accreditation.md` — under the `POST /api/accreditation/verify` 200-success row, add one sentence noting the 24h grace-period idempotency: a retried /verify on the same token whose original flight already broadcast successfully returns the identical 200 envelope (no re-broadcast). Observable only via Redis state (`${appTag}:accreditation-completed:<sha256(token)>` keys) and the fact that retried-token /verify no longer 400s.

### Files for review

- `backend/src/routes/accreditation.ts` — module-scope helpers + two call-site edits (`!pending` branch + broadcast-success site).
- `backend/tests/routes/accreditation-idempotency.test.ts` — three new specs in a new describe block at end of file.
- This task file (round-1 signal block).

---

## Architect re-review (2026-05-18, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` on the round-1 implementation commit (10 reviewers — correctness + security + adversarial on Opus; testing/reliability/api-contract/maintainability/project-standards/kieran-typescript/learnings-researcher on Sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). The five acceptance items land in intent: grace-period record at `${appTag}:accreditation-completed:<sha256(token)>`, MULTI pipeline atomicity for the SET + DEL pair, in-memory fallback Map, best-effort wrap around the post-broadcast cleanup, and the three new specs in the grace-period describe block.

Nine items held — two are P1 structural concerns on the load-bearing failure modes (record-vs-seed-bonus ordering + MULTI/EXEC rejection skipping in-memory writes), one is a P1 type-safety hole on the new JSON.parse path, and six are P2/lower observability + symmetry + comment + test-gap fixes. The fixes cluster naturally onto `accreditation.ts` + the new test specs.

### Items held (must fix before archive)

**1. (P1, conf 85, adversarial) Completion record written BEFORE the `seedAccreditationBonus` rethrow lets retry bypass 502 POST_BROADCAST_OPERATOR_REQUIRED.** Current order on the broadcast-success path: (a) `recordAccreditationCompletion` writes grace-period record + deletes pending token; (b) `seedAccreditationBonus` throws `PostBroadcastWriteError` with severity `'permanent'` on a permanent failure (e.g., `getReputationWeights()` shape regression); (c) outer catch returns 502 POST_BROADCAST_OPERATOR_REQUIRED to the user. On retry, the pending token is gone but the completion record exists → grace-period read returns 200 with the original envelope. The 502's operator-actionable signal is silently masked; the user sees inconsistent UX (first call 502 "contact support", retry 200 "Accreditation confirmed"). `PostBroadcastWriteError` with severity `'permanent'` exists specifically because the next batch cycle will NOT self-heal a `getReputationWeights()` shape regression; the grace-period record must not hide it.

  Suggested fix: reorder so `recordAccreditationCompletion` is called AFTER `seedAccreditationBonus` succeeds. Retain the inline try/catch + warn for the Redis-flap class on the record write — extracted to a `recordAccreditationCompletionBestEffort` helper per item 4. The retry's 400 BAD_REQUEST on a seed-bonus-permanent-failure path restores the operator's incident signal (first call 502 + subsequent 400 → user reports → operator triages).

**2. (P1, conf 90, reliability R1) MULTI/EXEC rejection skips in-memory fallback writes.** The `redis.multi().set(...).del(...).exec()` call in `recordAccreditationCompletion` is not wrapped in an inner try/catch. If the pipeline rejects (Redis-down mid-pipeline, connection drop, ioredis internal error), the exception propagates out of the function. The in-memory writes that follow the Redis block never execute. The outer call-site try/catch at the broadcast-success site logs a warn and sends 200 (broadcast did happen), but `memoryTokens` still has the pending row, `memoryAccreditationCompletions` has no entry, and the counter side-key is not cleared. The implementer's signal-block contract `"a Redis-less deployment still gets the grace-period idempotency"` holds for Redis-absent-at-write-call but FAILS for Redis-present-but-pipeline-throws.

  Suggested fix: wrap the `redis.multi().exec()` block in an inner try/catch inside `recordAccreditationCompletion`. On pipeline failure, emit a structured warn (e.g., `event: 'accreditation.verify.completion_record_pipeline_failed'`) with `token_hash` + `err` discriminator and fall through to the in-memory writes regardless. The outer call-site try/catch remains as the catch-all for any other failure mode (e.g., the in-memory write itself throwing). Pipeline failure becomes the helper's dedicated log signal; the call-site warn covers everything else.

**3. (P1, conf 90, kieran-typescript KT-1) Unsafe `JSON.parse(raw) as AccreditationCompletionRecord` cast in `readAccreditationCompletion`.** `JSON.parse` returns `any`; the cast silently accepts whatever shape Redis returns. A corrupt write or future schema-drift produces an object with `undefined` fields → 200 envelope sent with `username: undefined` and/or `tx_id: undefined`. The SPA's success UI then renders empty fields. The in-memory branch (`return cached.record`) is safe (write-site is typed), so only the Redis-read path is exposed.

  Suggested fix: add a runtime shape guard before the cast in `readAccreditationCompletion`:
  ```
  const parsed = JSON.parse(raw);
  if (
    typeof parsed !== 'object' || parsed === null ||
    typeof parsed.username !== 'string' ||
    typeof parsed.tx_id !== 'string'
  ) {
    logger.warn({ event: 'accreditation.verify.completion_record_invalid_shape', token_hash: hashTokenForLogs(token) }, 'completion record shape invalid; falling through to 400');
    return null;
  }
  return parsed as AccreditationCompletionRecord;
  ```
  Returning `null` on shape mismatch falls through to the existing 400 BAD_REQUEST path — better than serving a malformed 200.

**4. (P2, conf 75, maintainability M1) Best-effort cleanup pattern duplicated: inline try/catch at the broadcast-success site instead of a `recordAccreditationCompletionBestEffort` helper sibling.** The module already exposes `deleteTokenBestEffort` (3 call sites) — a named helper wrapping `deleteToken` in try/catch + structured warn. The round-1 broadcast-success site inlines an identical 14-line try/catch + warn structure rather than extracting the parallel helper. Coexisting forms create drift hazard.

  Suggested fix: extract `recordAccreditationCompletionBestEffort(token, username, txId, pending)` adjacent to `deleteTokenBestEffort`. Wrap the call to `recordAccreditationCompletion` in the same try/catch + warn shape (`event: 'accreditation.verify.completion_record_failed_post_success'`, `route`, `username`, `email_hash`, `token_hash`, `err`). The broadcast-success call site collapses to a single line: `await recordAccreditationCompletionBestEffort(token, pending.hive_username, result.id, pending);`. Land this alongside the reorder from item 1.

**5. (P2, conf 75, maintainability M2) Asymmetric key strategy between Redis and in-memory store for the grace-period record.** Redis side uses `accreditationCompletedKey(token)` = `${config.appTag}:accreditation-completed:${sha256(token)}` (hashed); in-memory `memoryAccreditationCompletions.set(token, ...)` keys on the raw token string. Every other sibling Map/Redis pair in this module is symmetric (`memoryTokens` ↔ `pending_accred:${token}`, `memoryBroadcastAttempts` ↔ `pending_accred_broadcast_attempts:${token}` — both raw). The asymmetry is intentional (Redis logs may surface keys via MONITOR/slow-log; the hash provides defense-in-depth that the other older pairs don't have), but it's silently asymmetric and a future refactor unifying the stores would hit a behavioral change.

  Suggested fix: add a 2-3-line comment at the `memoryAccreditationCompletions` declaration site explaining the intentional asymmetry — Redis side hashes for log-defense-in-depth; in-memory side keys raw because process memory already exposes the token, so hashing inside the process buys nothing.

**6. (P2, conf 80, adversarial) Process restart drops the `memoryAccreditationCompletions` Map → recreates the AbortError-after-success cascade for Redis-less or Redis-flap-at-write-time scenarios.** The in-memory fallback is a flap-resilience mechanism, not a sustained Redis-less deployment mode. The contract `"a Redis-less deployment still gets the grace-period idempotency"` holds within a single process lifetime, NOT across restarts. Implicit in the design but not documented.

  Suggested fix: add a code comment at the `memoryAccreditationCompletions` declaration explaining the limitation (in-memory fallback is flap-resilience, not sustained Redis-less mode; restart-induced loss is the accepted trade-off). Bundle with item 5's comment if convenient. Update the task signal block at re-review time to acknowledge this design contract.

**7. (P2, conf 80, kieran-typescript KT-2) Test spec 3 reads `JSON.parse(stored as string).tx_id` with no preceding null guard.** Spec 1 (in the same test file) does the same pattern correctly with `expect(stored).not.toBeNull()` before the parse. Spec 3 omits the guard. If `redis.get()` returns `null`, the assertion fails as `undefined !== 'tx-fresh-id-only'` with no indication that the real problem is a missing record.

  Suggested fix: add `expect(stored).not.toBeNull();` before the `JSON.parse` line in spec 3. One-line addition for symmetry with spec 1.

**8. (low, conf 75, correctness + reliability R2) `memoryAccreditationCompletions` excluded from the hourly `cleanupExpiredTokens()` sweep.** The hourly sweep iterates `memoryTokens` for expired entries but does not sweep `memoryAccreditationCompletions`. Entries are evicted only lazily on `readAccreditationCompletion` access — under normal Redis-up operation, stale 24h-TTL entries accumulate until process restart. Bounded by 24h × write-rate, but the asymmetry with the sibling `memoryTokens` cleanup is unmotivated.

  Suggested fix: add a sweep loop for `memoryAccreditationCompletions` inside `cleanupExpiredTokens()`, mirroring the existing `memoryTokens` sweep. Iterate entries, delete those whose `expires_at < Date.now()`. No new logging.

**9. (low, residual + learnings-researcher) Grace-period hit for revoked users returns 200 even if a WoT-revoke landed on-chain after the original broadcast.** The completion record carries `{username, tx_id}` only; it does not re-verify current chain state on retry. A user revoked between the original successful broadcast and the retry receives a cached "Accreditation confirmed" 200, even though their on-chain accreditation has been revoked. Out of scope per the task Goal ("scoped to the fresh broadcast success path"), but a future reader could mistake the absence of a chain re-check for a correctness gap.

  Suggested fix: add a 2-line comment at the grace-period read site documenting that the record does NOT re-verify current chain state — revoke events after the original broadcast are not visible from the cached envelope, and this is the accepted trade-off for the idempotency-record approach.

### Items dismissed during architect triage

- **(P1, conf 90, api-contract AC-01) `agents/docs/api-contracts/accreditation.md` does not document the 400→200 grace-period conversion.** Architect-zone; landed at cluster archive time as part of the api-contracts sweep (implementer filed [TODO Architect] block above).
- **(low, conf 85, api-contract AC-02) Grace-period 200 indistinguishable from fresh broadcast (no `outcome` discriminator field).** Architect resolves at contract-update time: either add `outcome: 'grace_period_replay'` to the response and document, or explicitly document the case as opaque. Not held against this task.
- **(low, residual) Sibling branches (existing-accreditation gate-hit, per-token idempotency-hit) NOT scoped to this task; AbortError-after-success cascade survives there.** Explicitly out-of-scope per task Goal; filed as a separate follow-up task `tasks/pending/backend-verify-grace-period-sibling-branch-coverage.md`.
- **(P2, conf 50-75, adversarial) Drainer break-on-first-fail / unbounded growth concerns.** Speculative; bounded blast radius. Default-recommend dismiss per `feedback_dismiss_preemptive_test_hardening`.

### Re-review signal

When items 1-9 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only.

Items 1-9 touch `backend/src/routes/accreditation.ts` (helper extraction + reorder + shape guard + Map sweep + comments) and `backend/tests/routes/accreditation-idempotency.test.ts` (null guard). Implementer's call whether one focused commit or two (`reorder + helper-extract + reliability fixes` first, then `tests + comments`); either works.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

