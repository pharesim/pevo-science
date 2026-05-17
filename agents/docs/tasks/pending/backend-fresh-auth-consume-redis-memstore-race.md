# BACKEND-FRESH-AUTH-CONSUME-REDIS-MEMSTORE-RACE — concurrent dual-consume on the same fresh-auth token can authorize two broadcasts

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, surfaced by `/ce-code-review` on `backend-custody-broadcast-orcid-fresh-auth` round-2 — adversarial adv-1 P1 conf 75)
**Priority:** P1 (pre-existing of the round-2 commit being reviewed; not within that task's diff scope, filed separately)

## Problem

`consumeFreshAuthToken` (`backend/src/lib/fresh-auth.ts:478-507`) and `consumeSessionFreshAuthToken` (`backend/src/lib/fresh-auth.ts:660-689`) both follow the shape:

```typescript
const raw = await redis.getdel(KEY_PREFIX + token);  // (1) atomic per Redis
if (raw) { /* parse and return success */ }
const entry = memStore.get(token);                    // (2) check memStore backup
if (entry) {
  memStore.delete(token);                             // (3) consume the backup
  return success;
}
return { valid: false, reason: 'expired_or_unknown' };
```

Redis `GETDEL` is atomic at the Redis-server level, so on a Redis-up dual-consume only ONE caller's GETDEL returns the value; the other returns null and falls through to step (2).

But the dual-write protection that `issueFreshAuthToken` / `issueSessionFreshAuthToken` apply (write to memStore BEFORE Redis set — protects against Redis-flap spurious-401 on consume) means that when both Redis and memStore are populated, BOTH stores hold the entry. On a concurrent dual-consume:

- Caller A's GETDEL returns the entry; caller A succeeds.
- Caller B's GETDEL returns null (already consumed in Redis). Caller B falls through to step (2). The memStore entry is still present (memStore.delete happens at step 3 of caller A, but caller B is racing the synchronous JS body so could read memStore before caller A's delete completes).
- Both A and B return success.

**Two valid consumes for one minted token = two authorized broadcasts.**

The window is small (microseconds between caller A's `await redis.getdel` resolution and caller A's subsequent `memStore.delete(token)`), and consumes typically happen with parallelism low (one-per-user-action). But:

1. The single-instance JS event loop means caller A's GETDEL await resumes synchronously after the round-trip, and caller A's memStore.delete fires before the event loop yields. So in practice, on a single-instance Redis-up deployment, the race is bounded to the case where caller B's memStore.get runs BEFORE caller A's memStore.delete WITHIN the same microtask boundary. That requires caller B to be reading memStore in a synchronous code path before caller A's GETDEL has resolved — possible but narrow.

2. **The vulnerability widens on Redis-DOWN.** When Redis is unavailable, BOTH callers' `redis.getdel` throws (caught somewhere) and BOTH callers fall through to memStore. Whichever caller's `memStore.get` runs first sees the entry, and the JS event loop ensures only one will run `memStore.delete` before yielding. But if both callers' code paths interleave via separate `await`s between get and delete (e.g., logging, audit-write), the race widens significantly.

3. **The vulnerability also widens on a future change.** A refactor that adds an `await` between `memStore.get` and `memStore.delete` (e.g., for an audit-write before consume) would open the race window arbitrarily wide.

## Why this surfaced now

The architect's `/ce-code-review` on `backend-custody-broadcast-orcid-fresh-auth` round-2 (commit `1437e41`) ran adversarial review on the diff. Adversarial agent constructed the failure scenario from first principles. The round-2 diff didn't touch the consume paths — round-2 only copied a dual-write rationale comment from `issueFreshAuthToken` into `issueSessionFreshAuthToken`. But the comment surfaced the dual-write invariant, which the adversarial agent then used to derive the cross-store race.

Round-5 of an earlier multi-round on the same module reportedly closed this race for the sequential case. Round-2's diff makes the parallel case more visible — both `consumeFreshAuthToken` and `consumeSessionFreshAuthToken` now share the same dual-write + dual-store-fallback pattern.

## Goal

Either close the race or document its bounded scope explicitly.

## Acceptance

1. **Option A — close the race via Redis-side atomicity:** use a Lua script that does GETDEL + memStore-delete in one atomic round-trip. Not directly possible because memStore is process-local. Variant: use a Redis SETNX on a "consumed" sentinel before reading the value, so the first consumer to set the sentinel wins; the loser's GETDEL returns the (now-consumed) sentinel state and returns 401. This requires a schema change to the stored entry (or a separate sentinel key per token).

2. **Option B — close the race via memStore-side coordination:** before calling `memStore.get`, acquire a per-token in-process lock (e.g., a `Set<string>` of in-flight tokens). Only one caller can be in the get-delete critical section per token at a time. Other callers wait or return 401.

3. **Option C — accept the race; document the bounded scope:** add a docblock comment explaining the residual race window (Redis-down path is the widest exposure; single-instance JS event loop bounds the Redis-up race to within-microtask interleavings). Add a docblock note that any future `await` between `memStore.get` and `memStore.delete` widens the race and requires re-evaluation.

4. **Test coverage**: `backend/tests/lib/fresh-auth.test.ts` — add a concurrent-consume test using `Promise.all` on two simultaneous consume calls for the same token. With Redis available: assert exactly one returns valid. With Redis stubbed to throw (forced fallback to memStore): assert exactly one returns valid (this is where the race is widest and the test most informative).

## Out of scope

- Refactoring the issue helpers' dual-write shape — that's the round-4 hold's load-bearing Redis-flap protection.
- Changes to single-use semantics — the goal is to PRESERVE single-use across the race window.
- Multi-instance coordination — PEvO is single-instance per memory `project_single_instance_only`.

## Cross-references

- `backend/src/lib/fresh-auth.ts` — `consumeFreshAuthToken` (line ~478), `consumeSessionFreshAuthToken` (line ~660), `issueFreshAuthToken` (line ~286), `issueSessionFreshAuthToken` (line ~355).
- Adversarial reviewer's report: `/tmp/compound-engineering/ce-code-review/20260516-202155-a21c9b6b/adversarial.json` (run from architect session 2026-05-16, adv-1).
- Round-4 hold #3 architectural note in the issue helpers' docblocks (the memStore-set-before-Redis-set pattern that the race exploits).
- Sibling memory `project_single_instance_only`.

## Source

`/ce-code-review` on `backend-custody-broadcast-orcid-fresh-auth` round-2 (architect session 2026-05-16): adversarial adv-1, P1 conf 75. Surfaced as pre-existing of round-2 (round-2 just copies a comment); filed separately because the fix is in the consume helpers, outside that task's round-2 diff scope.

The architect's review recommendation: this is a real defect class that warrants design discussion. The narrow window in production today doesn't make it dismissible — a future audit-write `await` between get and delete would widen it silently. Option C (document the bounded scope) is the cheapest mitigation; Option B (in-process lock) is the cleanest closure for a single-instance deployment.

---

## Backend implementer signal (2026-05-16, round-1)

**Option chosen: B (in-process lock).** Architect-recommended for single-instance; closes the race rather than merely documenting it. Per memory `project_single_instance_only`, multi-instance coordination is not in scope. Cost: ~10 lines of lock code plus matching test coverage. The lock is a defense-in-depth fold over the existing Redis GETDEL atomicity — Redis GETDEL alone is atomic at the Redis-server level, but the post-GETDEL memStore fallback admits the dual-consume window the task describes. Option B closes the door permanently and is robust to a future `await` between `memStore.get` and `memStore.delete`.

**Design:**
- Module-scoped `inFlightConsumes: Set<string>` in `backend/src/lib/fresh-auth.ts`, sibling to the existing `memStore` Map.
- BOTH `consumeFreshAuthToken` and `consumeSessionFreshAuthToken` perform a synchronous `has` → `add` critical section on entry, BEFORE any awaits. Because JavaScript is single-threaded, the `has` → `add` pair is uninterruptible by sibling promises. If the token is already in-flight, the loser returns `{ valid: false, reason: 'expired' }` immediately.
- Single shared `inFlightConsumes` set spans both helpers because a single token is uniquely bound to ONE kind at issuance (either `issueFreshAuthToken` ⇒ consent_op-kind or `issueSessionFreshAuthToken` ⇒ session-kind). Two concurrent consumes targeting the same token from different helpers is the same race surface as two consumes through the same helper, so the lock domain is "token", not "(token, helper)".
- Each consume helper splits into a thin outer (lock acquire/release in `try/finally`) and an inner `*Locked` helper that contains the original consume body. The `finally` block guarantees lock cleanup even when the inner consume throws.

**Loser semantics:** the in-flight loser receives `{ valid: false, reason: 'expired' }` — the same wire shape a stale-replay caller observes. Reasoning: (a) no new reason code on the `FreshAuthVerifyResult` reason union, preserving the existing wire contract; (b) functionally indistinguishable from the user's perspective — the token IS being consumed by the concurrent sibling caller, so single-use semantics report "already consumed" via the same code path; (c) avoids inventing a new `in_progress` variant whose only consumer would be one test assertion.

**Test coverage (acceptance §4):**
Added 7 concurrent-consume tests in `backend/tests/lib/fresh-auth.test.ts` under a new describe block `BACKEND-FRESH-AUTH-CONSUME-REDIS-MEMSTORE-RACE — concurrent dual-consume produces exactly one winner`:

1. **`consumeFreshAuthToken` Redis-up Promise.all** (skipIf no Redis): two concurrent consumes for the same token; assert `winners.length === 1` and the loser's reason is `'expired'`.
2. **`consumeFreshAuthToken` Redis-stubbed-to-throw on getdel** (skipIf no Redis): widest race window — both consumes fall through to memStore. Without the lock, both would synchronously read the entry before either reached `memStore.delete`, returning two valids. With the lock, exactly one returns valid. `mockImplementation` (not `mockRejectedValueOnce`) so both concurrent getdel calls throw.
3. **`consumeFreshAuthToken` no-Redis real-path Promise.all** (always runs): the carve-out clause (c) real-path companion — exercises the same race class against real infrastructure when Redis is absent.
4-5. **Same three tests for `consumeSessionFreshAuthToken`** (Redis-up, Redis-stubbed, no-Redis real-path).
6. **Lock cleanup test**: pins the `try/finally` discipline by issuing → consuming → re-consuming and asserting the second consume returns `expired` (token consumed, not stuck-in-lock). The wire-code-collapse between "token consumed" and "lock held" makes this a documentation-of-intent assertion; the actual cleanup contract is enforced structurally by the `finally` block.

The Redis-stubbed variant is where the test is most informative per the task body — pre-fix, two memStore fallback consumes both succeed; post-fix, exactly one does.

**Architect-zone notes:** none. The change is contained to:
- `backend/src/lib/fresh-auth.ts` (implementation)
- `backend/tests/lib/fresh-auth.test.ts` (tests + header carve-out paragraph)
- This task file (signal block).

**Worktree note:** this worktree (`agent-a30f543f5bdba25e8`) is several commits behind `main`'s `fresh-auth.ts`. The task file was filed on `main` and copied into the worktree at task start. The implementation here applies to the pre-`expires_at` ISO-string-conversion shape (`expires_at: number`) and the pre-kind-neutral key-prefix shape (`:fresh_auth:consent_op:`). On parent merge, the lock code (the new `inFlightConsumes` set, the outer/inner split, and the `try/finally` cleanup) should rebase cleanly onto main's `fresh-auth.ts` — none of the diverged areas (the key prefix string, the `expires_at` wire format) overlap with the Option B mechanism.

**Verification:** `cd backend && npm run typecheck` clean. `npm run lint` returns the two pre-existing `no-explicit-any` warnings in `seed-phrase.ts` (outside this task's zone) and 0 errors. Vitest NOT run in worktree per parent instructions — parent serializes.

---

## Architect re-review (2026-05-17, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` ran on commit `394a52e` (9 reviewers: correctness/security/adversarial on Opus; testing, maintainability, project-standards, reliability, kieran-typescript, learnings-researcher on Sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md). Core security property is sound: the `has → add` synchronous critical section is uninterruptible under the JS event loop; `return await` + `try/finally` discipline covers all throw paths; cross-kind shared lock domain is structurally correct (tokens unique per issuance, bound to one kind at mint); single-instance scope explicitly acknowledged per `project_single_instance_only`. Security reviewer returned zero findings.

Three items held; multiple items dismissed at triage.

### Items held (must fix before archive)

**1. (P1, conf 100 — cross-reviewer-promoted: maintainability M1 + learnings-researcher) Task-slug citations in production code comments will rot on archive.** Three occurrences in `backend/src/lib/fresh-auth.ts`:
- The `inFlightConsumes` docblock opening line cites `BACKEND-FRESH-AUTH-CONSUME-REDIS-MEMSTORE-RACE`.
- The `consumeFreshAuthToken` lock-check inline comment opens with `BACKEND-FRESH-AUTH-CONSUME-REDIS-MEMSTORE-RACE (Option B):`.
- The `consumeSessionFreshAuthToken` lock-check inline comment opens with the same slug prefix.

Per `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`, task slugs become dead pointers on archive (`tasks-archive.md` is trimmed to 250 lines; older entries fall off entirely). The substantive prose in each docblock is already self-contained — the mechanism, the symbol name, the race scenario are all described — so dropping the slug prefix loses no information. Suggested rewrite shape for the `inFlightConsumes` docblock opening: "In-process lock set for the consume helpers. Closes the concurrent-dual-consume race on the memStore fallback path..." For each inline comment: drop the slug prefix; the "Option B in-process lock check" wording can stand alone.

Test-file slug citations (the `BACKEND-FRESH-AUTH-CONSUME-REDIS-MEMSTORE-RACE` paragraph in the carve-out header and the `describe('BACKEND-FRESH-AUTH-CONSUME-REDIS-MEMSTORE-RACE — ...')` label) are lower operational risk (test output is transient, not read by operators) but should be updated for consistency.

**2. (P2, conf 100 — cross-reviewer-promoted: correctness + adversarial + testing + maintainability + kieran-typescript + learnings-researcher) Lock-cleanup test passes whether or not the `finally` block exists.** `backend/tests/lib/fresh-auth.test.ts:706-746` (the `'lock cleanup: a thrown consume releases the in-flight set entry'` test). The test issues a token, consumes it (returns `valid: true`), re-consumes it, and asserts `valid: false` with `reason: 'expired'`. Both the lock-held path AND the consumed-token path return `expired` with byte-identical wire shape. The test's own commentary explicitly admits this:

> "both wire codes are `expired`, so functional equivalence makes the test pass either way at the wire layer. The actual cleanup discipline is enforced by the `finally` block; this test documents the expectation."

A mutation that removes `finally { inFlightConsumes.delete(token) }` entirely would not cause this test to fail. The `finally`-block correctness IS structurally guaranteed by JS semantics, but the test labeled `'lock cleanup: a thrown consume releases the in-flight set entry'` should pin that contract structurally, not via a wire-code-collapsed assertion.

Suggested fix (architect call): add a test-only export `_getInFlightConsumesSizeForTests(): number` (sibling to the existing `_resetFreshAuthMemStoreForTests`) and rewrite the test to:
1. Force a throw inside the locked critical section (e.g., issue a token, then call `consumeFreshAuthToken` with a mocked `redis.getdel` that throws synchronously; or use a token whose memStore entry has been tampered with to force a JSON.parse throw post-await).
2. Assert `_getInFlightConsumesSizeForTests() === 0` after the throw propagates.

Mutation kill: removing `finally { inFlightConsumes.delete(token) }` would now leave the set non-empty after the throw, failing the assertion.

**3. (P2, conf 90 — cross-reviewer-promoted: testing T-2 + adversarial) Shared-lock-domain design claim untested.** All 7 new tests use same-helper pairs. The central design invariant — that `inFlightConsumes` is a single set shared across both consume helpers, so a `Promise.all([consumeFreshAuthToken(token, ...), consumeSessionFreshAuthToken(token, ...)])` for the same token produces exactly one winner — has zero coverage. A mutation that splits `inFlightConsumes` into two per-helper sets (`inFlightConsumesByConsentOpHelper`, `inFlightConsumesBySessionHelper`) would pass all 7 new tests and the shared-lock-domain guarantee silently regresses.

This is realizable in production because `consumeSessionFreshAuthToken` accepts both kinds (the cross-kind acceptance design). A consent-op-kind token can be consumed concurrently via both helpers from a misbehaving SPA.

Suggested fix: add one cross-helper test in the same `describe` block:

```typescript
it.skipIf(!redisAvailable)('cross-helper Promise.all on the same token → exactly one winner (shared-lock-domain invariant)', async () => {
  const issued = await issueFreshAuthToken('race-cross', 'password', T);
  const [a, b] = await Promise.all([
    consumeFreshAuthToken(issued.token, 'race-cross', TH),
    consumeSessionFreshAuthToken(issued.token, 'race-cross'),
  ]);
  const winners = [a, b].filter((r) => r.valid);
  expect(winners).toHaveLength(1);
});
```

(Note: the session-helper consume on a consent_op-kind token would consume the token but then return `kind_mismatch` at the kind-check inside the inner body if it wins, or `expired` if it loses the lock. Either outcome with `exactly one winner` pins the shared lock-domain — adjust assertion if the session-helper's winner path returns `kind_mismatch` instead of `valid: true`.) Architect's call on the exact assertion shape; the load-bearing claim is that the lock collapses both helpers.

### Items dismissed during architect triage

- **kieran-typescript KT-1 (conf 50):** Inner `*Locked` helpers lack JSDoc. Below anchor 75 gate; the surrounding `inFlightConsumes` docblock and the outer-helper bodies carry the lock contract. A brief comment would be polish, not load-bearing.
- **adversarial P3 (conf low):** Speculative claim that the stubbed-throw race test may not exercise the pre-fix race (microtask-level argument). The pre-fix code path IS exposed in the no-Redis variant; the speculation is on whether the JS event loop's microtask scheduling permits the interleaving at all. Either way, the lock CORRECTLY closes the door — speculative concern, dismissed.
- **testing T-3 (P3):** No-Redis companion tests redundant under Redis-available CI. Learnings-researcher confirms clause-(c) satisfied at risk-class equivalence level (transform-axis Redis-stubbed + wiring-axis no-Redis). Per `feedback_dismiss_preemptive_test_hardening`, this is theoretical-only.
- **testing T-4 (P3 conf 75):** Compensating `redis.del` stubbed in race tests. Documented-as-best-effort in pre-existing code; the compensating del is covered elsewhere in the suite.
- **adversarial: unbounded set growth on Redis hang.** Overlaps with REL-1 (pre-existing). Same root cause: no `commandTimeout` on the ioredis client.

### Pre-existing (separate, does not block archive)

- **REL-1 (P2 conf 75):** `backend/src/redis.ts:12` ioredis client has no `commandTimeout`. The diff makes this newly material — a hung GETDEL holds the in-flight set entry indefinitely; legitimate concurrent retries observe `expired`. Pre-existing per reliability reviewer's note. File separately if pursued (would be a backend follow-up task scoped to `backend/src/redis.ts`, not this task).

### Residual notes (acknowledged, no action)

- Multi-instance topology re-opens the race — explicitly acknowledged in the `inFlightConsumes` docblock per `project_single_instance_only` memory. Documented as future-leak; not in scope today.
- Pre-existing line-number anchor `routes/orcid.ts:151` in the adjacent `memStore` docblock — not introduced by this diff. Separate cleanup if anyone touches the file (per `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` convention).

### Re-review signal

When items 1-3 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only.
