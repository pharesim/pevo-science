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
