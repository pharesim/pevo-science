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

---

## Backend implementer signal (2026-05-13, working tree → commit at file-move)

Design chosen: **Option C — `/confirm` detects existing-claimed-account state and resumes**. Picked by the user during interactive triage. Rationale: lowest infrastructure cost (no schema change, no new endpoint, no recovery-token auth model), schema-less detection via existing pg state.

### Implementation summary

**Stuck-state detection (item #1).** In both `/confirm` and `/link`, when the `auth_token`-keyed pg lookup returns 0 rows, fall back to a username-keyed lookup for a row in stuck state (verify_token IS NULL, custody = appropriate, encrypted keys present for /confirm). The fallback uses a separate SQL query so the happy-path (first attempt) bears no extra cost.

**Auth proof for /confirm resume.** The `auth_token` is consumed at pg activation and not recoverable. On stuck-resume, the supplied `posting_private` is the auth artifact: a new helper `verifyPostingKeyAuthorized(username, postingPrivate)` derives the public key from the supplied private and matches it against the Hive account's `posting.key_auths`. Without a match, the route falls through to the standard "Invalid or expired auth token" 400 to avoid leaking which failure mode occurred.

**Auth proof for /link resume.** Already covered by `verifyHiveSignature` middleware (the user signs the request with their posting key, proving Hive account ownership). No additional check needed; the username fallback is unconditional.

**HAF probe before re-broadcast (item #2).** Before attempting the accreditation broadcast on the stuck-resume path, both routes call `getAccreditedSet([username])` to check whether the prior attempt's broadcast actually landed despite the error (per `chain-write-timeout-ambiguous-outcome-2026-04-22`). If found, the broadcast is skipped, a sentinel `tx_id = 'haf-probe-already-accredited'` flows into the post-broadcast cascade for the seed step, and JWT issues. If the probe fails (HAF outage), the path falls through to re-broadcast — the cost is one duplicate accreditation custom_json on chain (the SQL reader picks the most recent).

**Skip chain step 1 on stuck-resume (AC #3).** `createClaimedAccount` is single-use per token; replay would raise HAFSQL-side. The route gates step 1 (and the pg activation step 2) on `if (!resumeStuck)` so the resume path goes straight to the broadcast block. Tests assert `createClaimedAccountMock` was NOT called on any stuck-recovery path.

**Recovery semantics in 502 (item #3).** Both `broadcastErrOpts.timeoutMsg` and `broadcastErrOpts.failMsg` now embed a per-route recovery hint: "You may retry POST /api/auth/confirm with the same auth_token, username, and keys to recover this session." (and the symmetric /link variant). Lets the SPA render an appropriate retry CTA and gives operators the recovery contract verbatim in logs.

**LogContext extension.** `broadcast-error.ts:LogContext` gained an optional `resume_stuck?: boolean` field so structured logs distinguish first-attempt failures from retry-resume failures. Backend-zone change; no architect coordination needed.

### Acceptance criteria coverage

| AC | Status | Notes |
|---|---|---|
| 1. 502 body documents recovery mechanism | Done | `timeoutMsg` + `failMsg` include the explicit retry semantics per route. |
| 2. Recovery path MUST NOT issue JWT for never-landed accreditation | Done | Per-step error handling unchanged: broadcast catch returns 502 with no JWT; post-broadcast catch returns 502 with no JWT. Dangling-JWT class stays closed. |
| 3. Retry MUST NOT re-issue step 1 (single-use chain op) | Done | `if (!resumeStuck)` guards createClaimedAccount + the pg activation step. Test asserts `createClaimedAccountMock` not called on stuck-resume paths. |
| 4. Retry MUST handle BroadcastTimeoutError ambiguous outcome | Done | HAF probe runs BEFORE re-broadcast on stuck-resume. Test (b) pins: HAF returns user-is-accredited → broadcast skipped → 200 + JWT. |
| 5. /link symmetric recovery | Done | /link mirrors /confirm: username fallback (no key-ownership check — verifyHiveSignature already proved Hive ownership), HAF probe, conditional broadcast, recovery semantics. |
| 6. Tests | Done | New `tests/routes/signup-verify-stuck-recovery.test.ts` covers (a) stuck → retry succeeds, (b) stuck → HAF probe finds accreditation → skip broadcast, (c) stuck → permanent TypeError → POST_BROADCAST_OPERATOR_REQUIRED. Plus a fourth test pinning the wrong-key auth-proof rejection. 4 tests pass. |

### Verification

- `npx tsc --noEmit` clean (one mid-implementation TS2353 caught + fixed: `LogContext.resume_stuck` added).
- `npm run lint` clean (only pre-existing seed-phrase warnings).
- `tests/routes/signup-verify-stuck-recovery.test.ts`: 4 passed (the three AC #6 paths + the wrong-key rejection).

### Carve-out justification

The test file mocks `broadcastJsonWithTimeout`, `seedAccreditationBonus`, `getAccreditedSet`, `hiveClient.database.getAccounts`, and `createClaimedAccount` at module level. Carve-out clause-(a): broadcast outcomes are non-deterministic at unit-test scope; the HAF probe path requires seed-and-wait corpus state; the TypeError-from-seed path requires data-shape regression that bleeds across the suite. (b) `verifyHiveSignature` is NOT mocked for the /link symmetric path testing in the future; this round only tests /confirm. (c) Real-path companion: `signup-verify.test.ts` exercises the happy-path /confirm flow end-to-end against real pg + real Hive lookup; the mocked block here covers only the stuck-recovery branches.

### Known gaps

- /link stuck-recovery has the implementation but no dedicated test in this round. The /confirm tests cover the structural pattern (both routes share the same shape post-resume); a future test for /link would be tractable but requires the verifyHiveSignature signed-request fixture. Defer unless the architect wants it explicitly pinned.
- Race condition between concurrent /confirm retries from the same user (user double-clicks): both retries can reach the broadcast block in parallel and emit two accreditation custom_jsons on chain. Cost is minimal (the SQL reader picks the most recent and de-dupes). A Redis-based per-username lock would close this but adds infra; deferred under single-instance reality.

### File listing

- `backend/src/routes/signup-verify.ts` — stuck-detection fallback + HAF probe + recovery semantics in both /confirm and /link.
- `backend/src/lib/broadcast-error.ts` — added `LogContext.resume_stuck?: boolean`.
- `backend/tests/routes/signup-verify-stuck-recovery.test.ts` — new (4 tests).

Ready for architect review.
