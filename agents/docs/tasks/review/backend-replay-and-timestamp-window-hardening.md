# BACKEND-REPLAY-AND-TIMESTAMP-WINDOW-HARDENING — close ready-but-throwing Redis flap + future-dating timestamp gap

**Owner:** Backend Agent
**Created:** 2026-05-30 (security audit workflow)
**Priority:** P3 (low individually; compose to ~120s replay window during Redis flaps)

## Problem

Two defects in `backend/src/middleware/verifyHiveSignature.ts` that compose. Land as one PR — both edit the same file and the timestamp fix doubles the impact of leaving the replay gap unfixed.

### (1) Replay-protection fails open when Redis is `ready` but SETNX throws

The replay-detection helper:

```ts
async function isReplaySignature(signature: string): Promise<boolean> {
  if (isRedisAvailable()) {
    try {
      const redis = getRedis()!;
      const result = await redis.set(`${config.appTag}:replay:${signature}`, '1', 'EX', SEEN_SIGNATURES_TTL_SEC, 'NX');
      return result === null;
    } catch (err) {
      logger.warn({ err }, 'Redis replay check failed, falling back to in-memory');
    }
  }
  if (seenSignatures.has(signature)) return true;
  return false;
}
```

And the recording side (further down):

```ts
if (!isRedisAvailable()) recordSignatureInMemory(signature);
```

When `isRedisAvailable()` is true (status === 'ready') but the SETNX call itself throws (network blip, ioredis commandTimeout=5000ms, MaxRetriesPerRequest=3 rejection, OOM eviction, READONLY during topology change), the catch logs and falls through to `seenSignatures.has(signature)` — which returns false on miss (no record was ever stored). Verification proceeds. Then on the recording side, `!isRedisAvailable()` is still false (status hasn't transitioned), so `recordSignatureInMemory` is also skipped. The signature is never recorded anywhere. A captured signed request can be replayed every time Redis throws on the SETNX call, bounded only by the timestamp window.

ioredis status transitions are driven by connection events, not per-command failures, so `ready-but-throwing` is the standard flap pattern, not an edge case.

### (2) Timestamp window allows future-dating, doubling effective signature usability

```ts
const ts = new Date(timestamp).getTime();
if (isNaN(ts) || Math.abs(Date.now() - ts) > MAX_SIGNATURE_AGE_MS) {
  return sendError(res, 401, 'UNAUTHORIZED', 'Request timestamp expired or invalid (must be within 60 seconds)');
}
```

The absolute-value form accepts timestamps up to 60s in the FUTURE as well as 60s in the past. A signer can sign a request dated `Date.now() + 60_000`. The server then accepts the signature from server-time T (|diff|=60) through T+120s (|diff|=60 on the other side), effectively doubling the unique-signature usability window beyond the documented 60s. The user-facing error message claims "60 seconds" while the code permits 120.

The project's own `backend/src/routes/custody.ts` `/upgrade` handler uses a past-biased form (60s past + small forward skew tolerance) — the same code base internally documents the anti-pattern in a parallel auth path. Mirror it.

### Composition

A future-dated signature replayed during a Redis flap stays valid for ~120 seconds instead of 60. Affected critical routes when replay fails open include `/auth/session`, `/wot/vouch`, `/accreditation/request`, `/reviews/anonymous`, `/papers/:permlink/retract`, `/papers/:permlink/invalidate`, `/ipfs/upload`. `/custody/broadcast` is partially mitigated by its fresh-auth-proof requirement (single-use), but the surrounding signature still replays.

## Goal

(1) Make the in-memory store the unconditional backstop — always populate it after a successful verification, regardless of Redis state. (2) Switch the timestamp check to past-biased with a small forward skew, mirroring the existing `custody.ts /upgrade` form.

## Fix sketch

```ts
// (1) Always record in memory after successful verification.
// Either: drop the Redis-availability check at the record site:
recordSignatureInMemory(signature);
// Or: have isReplaySignature do an in-memory add-if-absent in its Redis-throw catch:
} catch (err) {
  logger.warn({ err }, 'Redis replay check failed, falling back to in-memory');
  if (seenSignatures.has(signature)) return true;
  seenSignatures.add(signature); // recorded here so future replays in this window are detected
  return false;
}
```

```ts
// (2) Past-biased timestamp check with small forward skew.
const FORWARD_SKEW_MS = 5_000;
const ts = new Date(timestamp).getTime();
if (isNaN(ts) || ts > Date.now() + FORWARD_SKEW_MS || Date.now() - ts > MAX_SIGNATURE_AGE_MS) {
  return sendError(res, 401, 'UNAUTHORIZED', 'Request timestamp expired or invalid (must be within 60 seconds).');
}
```

User-facing error message updated to use period (CLAUDE.md: no emdashes in user-facing text).

## Acceptance

1. **Redis-throw replay defeated.** Test: stub the ioredis SET call to throw on the second invocation (first invocation succeeds and verifies a signature; second invocation re-presents the same signature and throws). Expected: the second request is rejected as a replay, because the in-memory store was populated either by the first verification or by the catch in `isReplaySignature`.
2. **In-memory store size bounded.** Existing TTL/cleanup behavior preserved (the in-memory map should already cycle on its own interval). No memory leak introduced.
3. **Future-dating rejected.** Test: a signed request with `timestamp = Date.now() + 30_000` (more than 5s forward skew, less than 60s) returns 401 `UNAUTHORIZED`. Existing tests for past-window (timestamp 30s in the past = accepted; timestamp 90s in the past = rejected) continue to pass.
4. **Small forward skew tolerated.** Test: a signed request with `timestamp = Date.now() + 3_000` (within the 5s forward skew) is accepted. Pins the legitimate clock-drift carve-out.
5. **Error message accuracy.** The user-facing message says "60 seconds" and is honest — the code's accepted window is now strictly `Date.now() - 60_000 .. Date.now() + 5_000`.
6. **Mutation-kills:** revert (1) the catch-side record OR (2) the past-biased check → respective tests go RED.

## Out of scope

- Adopting a cryptographic nonce-bound replay scheme (overkill for the threat model; existing signature-based detection is the right primitive).
- Migrating `seenSignatures` to a different data structure or moving cleanup interval changes.
- Other `verifyHiveSignature` defects (covered in separate tasks).

## References

- `backend/src/middleware/verifyHiveSignature.ts` — `isReplaySignature`, `recordSignatureInMemory`, timestamp validation, `MAX_SIGNATURE_AGE_MS`.
- `backend/src/routes/custody.ts` — `/upgrade` handler's past-biased timestamp form to mirror.
- ioredis docs on the `ready` status / per-command error semantics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
