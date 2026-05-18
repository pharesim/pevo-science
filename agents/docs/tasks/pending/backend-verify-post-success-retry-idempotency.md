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
