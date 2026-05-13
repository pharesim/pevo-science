# Signup-verify `/confirm` and `/link`: recovery path for the stuck-account state

**Owner:** Backend Agent
**Created:** 2026-05-13
**Origin:** Spun off from SSoT round-2 architect re-review (commit `4d9d15b`); adversarial finding that the round-2 PostBroadcastWriteError discrimination at signup-verify produced a correct *refusal* but no *recovery path*.

## Problem

After SSoT round-2 (commit `f746375`), `backend/src/routes/signup-verify.ts` `/confirm` and `/link` now discriminate broadcast failure into `502 BROADCAST_FAILED` / `504 BROADCAST_TIMEOUT` / `502 POST_BROADCAST_FAILED`. This correctly refuses to issue a JWT for an account not on chain. The fix closed the dangling-JWT class.

It opened a new class: the **stuck-account** state.

For `/confirm`, the sequence is:

1. `createClaimedAccount(...)` lands on chain (`signup-verify.ts:287`). The Hive account exists.
2. pg UPDATE clears `verify_token` and persists `hive_username` etc. (`:300-312`). The token is now consumed.
3. `broadcastJsonWithTimeout(accreditationCustomJson)` is attempted (`:365`).
4. Broadcast throws → catch returns 502 `BROADCAST_FAILED` or 504 `BROADCAST_TIMEOUT`. No JWT issued.

The user now has:

- A real Hive account on chain (step 1 is irreversible — the claimed-account token has been spent).
- Encrypted keys in pg (for the light-account path).
- A consumed verify_token (step 2 cannot be replayed).
- No session.
- No accreditation custom_json on chain.

A second `/confirm` attempt fails immediately: the token is consumed, the route returns `400 Invalid or expired`. The user is locked out of an account they technically own on chain.

`/link` has a symmetric stuck state — `link_token` consumed at pg-update, broadcast fails, user has a linked-but-not-attested account.

## Why this is not just an extension of round-2's fix

Round-2 (`f746375`) closed the *authorization* gap (no JWT for off-chain accounts). The user-experience gap is structurally separate: even if the chain operation eventually succeeds via a future retry, the route has no mechanism to detect "the user already completed step 1 and step 2; resume from step 3."

`/api/accreditation/verify` (the email-verify path) already solves a similar problem via the `idempotency_key` retry pattern — a second request with the same key is recognized and resumed. `/confirm` and `/link` have no equivalent.

The ORCID flow has its own retry surface (`orcid.ts`) that handles `POST_BROADCAST_FAILED` differently because ORCID's auto-accreditation is a separate code path with its own resume semantics. Neither pattern transplants cleanly to the signup-verify routes without deliberate design.

## Design space (for the brainstorm or implementation pass)

The architect is not pre-deciding. Three reasonable shapes the implementer should consider and pick one (or motivate a fourth) before writing code:

**Option A — `idempotency_key` retry on `/confirm` / `/link`.**
Mirror `/api/accreditation/verify`'s pattern: pg stores a stable retry key keyed off the consumed token (or a fresh server-generated id returned in the 502 response body). A second `/confirm` with the same idempotency key checks pg for "claimed-account already exists for this user, accreditation_custom_json absent" and resumes from the broadcast step. Pros: matches existing convention, single endpoint. Cons: requires pg schema extension; key lifetime / cleanup policy must be designed; the response body of the failure needs to carry the key.

**Option B — `/retry-broadcast` endpoint scoped to stuck signups.**
A new endpoint (`POST /api/signup-verify/retry-broadcast` or similar) that takes a server-issued recovery token returned in the 502 body. Inspects pg for the stuck state, re-attempts the broadcast, issues the JWT on success. Pros: separation of concerns; doesn't complicate the happy-path of `/confirm`. Cons: extra surface area; auth model for the recovery token must be designed (can't reuse the consumed verify_token).

**Option C — `/confirm` detects existing-claimed-account state and resumes.**
On `/confirm` request, before consuming the verify_token, check pg for "user has a hive_username, encrypted keys, no accreditation_custom_json on chain." If so, don't run steps 1-2 (chain already done) — go directly to step 3. Pros: no new endpoint, no new schema. Cons: changes the meaning of `/confirm` (it's now both "create + accredit" and "resume accreditation"); the detection-condition logic adds complexity; subtle race if the user re-clicks the verify link while the original broadcast is in flight.

Worth verifying before designing:
- Does pg already persist enough state to detect "stuck" from any one of A/B/C? If not, what's the minimum schema delta?
- Does `accreditation_custom_json absent on chain` have a cheap probe (HAF query? in-memory check against last-known accreditation state?)
- What's the user's surface for recovery — a CTA on the 502 response page in the SPA, an email retry link, both?

This task is the *spec* for the recovery design. The implementer should land a brainstorm-then-implement, NOT jump straight to code.

## Acceptance criteria

1. A `/confirm` (or `/link`) attempt that lands chain step 1, clears pg state, then fails broadcast MUST leave the user with a documented, reachable recovery path back to a fully-accredited session. "Documented" means at minimum: the 502 response body includes the recovery mechanism (an idempotency_key, recovery token, retry URL, or a documented "please retry /confirm with the same input" semantics).

2. The recovery path MUST NOT issue a JWT for an account whose accreditation_custom_json never lands on chain. The dangling-JWT class closed by round-2 stays closed.

3. A retry that follows a partial-success state (chain step 1 succeeded, broadcast failed) MUST NOT re-issue step 1. Hive `create_claimed_account` is single-use per token; replay raises HAFSQL-side error.

4. The recovery path MUST handle the `BroadcastTimeoutError` ambiguous case correctly: a retry must not double-broadcast if the original broadcast actually landed (per `chain-write-timeout-ambiguous-outcome-2026-04-22` convention). The retry MUST probe HAF for the existence of the accreditation_custom_json before re-broadcasting.

5. The `/link` symmetric stuck state has equivalent recovery.

6. Tests cover at minimum:
   - Stuck `/confirm` → recovery via the chosen mechanism → successful session.
   - Stuck `/confirm` → broadcast actually-landed-during-timeout → retry probes HAF, finds the custom_json, issues JWT without re-broadcasting.
   - Stuck `/confirm` → permanent error class (TypeError from seed) → recovery surfaces the operator-required code path, no auto-retry loop.

Real-HAF + real-Redis where applicable. Carve-out clause-C with header justification for the specific broadcast-outcome simulation (broadcast outcomes are non-deterministic at unit test scope and impractical to seed real per-test; mock the broadcast wrapper, leave everything else real).

## Implementation notes

- Sibling convention: `chain-write-timeout-ambiguous-outcome-2026-04-22` is the canonical reference for the ambiguous-broadcast handling that the retry probe must respect.
- ORCID's `POST_BROADCAST_FAILED` handling at `orcid.ts:886` is NOT the right template — ORCID's flow has different prerequisites (no token consumption, no claimed-account creation).
- `/api/accreditation/verify`'s idempotency_key pattern IS a candidate template if Option A is chosen.
- Consult the architect via `[BLOCKED by Architect]` if a design question arises during brainstorm. Don't guess the recovery shape; pick one and motivate it before coding.

## Coordination

- This task is structurally independent of the SSoT and validity-gate tasks.
- The SSoT round-2 task's hold block (item 1 in the round-2 architect re-review) closes the *authorization* side of this gap. This task closes the *recovery* side.
- No expected overlap with other in-flight tasks; if a conflict surfaces during implementation, flag via the standard `[BLOCKED]` mechanism.
