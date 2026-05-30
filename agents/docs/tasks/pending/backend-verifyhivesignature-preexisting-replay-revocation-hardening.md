# BACKEND-VERIFYHIVESIGNATURE-PREEXISTING-REPLAY-REVOCATION-HARDENING — three pre-existing edge cases surfaced during the replay/session review

**Owner:** Backend Agent
**Created:** 2026-05-30 (architect review of `backend-replay-and-timestamp-window-hardening` + `backend-session-invalidation-fail-closed`)
**Priority:** P2 (all three are pre-existing, bounded, and not introduced by the reviewed commits; grouped here so they are not lost)

## Context

The replay/timestamp and session-invalidation hardening commits (`0d264ff3`, `acd0f8bf`) correctly closed their stated windows. Adversarial/correctness review surfaced three deeper, pre-existing edge cases in `verifyHiveSignature.ts`. None block the reviewed commits' archive; this task tracks them.

## Items

### 1. Concurrent-replay TOCTOU (record-after-await)
`isReplaySignature` reads/claims at the start of the request, but `recordSignatureInMemory` runs at the END, after the `await getAccounts` (and ECDSA) round-trip. When Redis SETNX is throwing (ready-but-throwing flap) or Redis is down, N concurrent identical replays all pass the start-of-request check before any reaches the record step, so all are accepted. Impact is bounded: identical signature ⇒ same canonical operation ⇒ idempotent sinks (vote/comment) are deduped by Hive; only non-idempotent PEvO sinks (vouch, accreditation request) double-fire, and only during a Redis flap + sub-second concurrent burst within the 60s timestamp window. On single-instance topology three reviewers recommend documenting as accepted residual unless a non-idempotent sink is confirmed double-fire-sensitive.
- **Fix option:** on the Redis-failure branch inside `isReplaySignature`, do a synchronous check-and-set on `seenSignatures` (has → return true; else add) BEFORE the await, so the in-memory claim is atomic within the event loop. Tradeoff: records a structurally-valid-but-not-yet-crypto-verified signature (cap map size / record only after a cheap structural check). Or accept + document.

### 2. Same-second revocation off-by-one
`payload.iat < invalidatedAt` with both floored to integer seconds. A to-be-revoked JWT minted in the SAME integer second as the password reset survives (`T < T` is false). `<` cannot simply become `<=` because the freshly-minted post-reset token shares that second and must survive. Needs sub-second discrimination (e.g. compare against the post-reset token's exact iat as the boundary, exempting the new token by identity) — a design fix, not a one-liner.

### 3. iat-absent JWT skips the invalidation check
`if (payload.iat)` gates the entire `sessions_invalidated_at` lookup. A JWT without `iat` is never revocable. Not currently exploitable (every server mint path sets `iat`; an attacker cannot forge a token signed with `config.sessionSecret`), but it is a latent trap: any future mint that adds `{ noTimestamp: true }` silently punches a permanent hole in revocation.
- **Fix option:** fail closed on the JWT path when `iat` is absent (`if (typeof payload.iat !== 'number') return 401`), so revocation completeness no longer rides on an unenforced cross-file invariant.

## Acceptance

Per item, either land the fix with a test (concurrent-replay test under a SETNX-throw stub; same-second iat boundary test; iat-absent rejection test) OR record an explicit accepted-residual decision with rationale. The user/architect triages which of the three to fix vs accept.

## References

- `backend/src/middleware/verifyHiveSignature.ts` — `isReplaySignature`, `recordSignatureInMemory`, the `if (payload.iat)` gate, the `iat < invalidatedAt` comparison.
- `backend/src/routes/auth.ts` / `recover.ts` — same-second mint-and-invalidate sites (the fresh post-reset token that must survive).
- `agents/docs/solutions/conventions/redis-multi-rejection-retry-precondition-isredisavailable-2026-05-19.md` — the in-memory-fallback test discipline.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
