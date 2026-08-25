# Windowed session-kind fresh-auth proofs

**Owner:** backend
**Created:** 2026-08-25

## Why

Light accounts currently cannot publish without being bounced to ORCID. `POST /api/custody/broadcast` requires a session-kind fresh-auth proof on the non-consent branch, that proof is single-use (`redis.getdel`) with a 5-minute TTL, and the SPA's only implemented mint factor is a full-page ORCID OAuth redirect. So every publish, vote, comment, review, and edit navigates the user out of the app. State A (light + password, no ORCID, accredited via institutional email, which does not require ORCID) cannot broadcast at all: `handleSessionAuth` 403s because no linked ORCID exists.

The fix is not simply "wire up the password mint". Minting a single-use proof per broadcast means a prompt per broadcast, and the only way to avoid that with single-use proofs is to hold the user's plaintext password in client memory for the duration, which is a worse place for a long-lived secret than the server. The decided design makes the session kind windowed instead.

Design and rationale: `agents/docs/ARCHITECTURE.md` § 6.4.1, § 6.4 (non-consent broadcast row, IPFS upload-token row), § 6.5 invariants #1 and #9. Those sections are authoritative; this file is the work order.

## Scope

Backend only. The UI task is `ui-light-account-reauth-window` and is blocked on this landing.

### 1. Session-kind proof becomes windowed and multi-use

- Sliding idle expiry of **15 minutes**: a successful consume slides the idle deadline forward.
- Absolute cap of **2 hours** from first mint, enforced server-side, not extendable by any client action.
- Consume validates and slides instead of deleting. Whichever deadline is reached first ends the window.
- Store both deadlines with the entry so the cap survives a slide.

The consent-op kind is **unchanged**: `getdel`, single-use, target-bound, 5-minute TTL. `FRESH_AUTH_TTL_SECONDS` currently serves both kinds; split the constants rather than moving the shared one.

### 2. Remove the double-spend lock for the session kind

`inFlightConsumes` in `backend/src/lib/fresh-auth.ts` exists to stop two concurrent consumes of a single-use token, and it returns `expired` to the loser. Once session proofs are multi-use that lock turns legitimate concurrency into spurious 401s: two votes fired in the same tick, or an upload-token mint racing a broadcast, would have one arm rejected with a reason the SPA reads as "re-auth needed". Scope the lock to the consent-op kind, which still needs it.

### 3. Redis and memStore fallback

The dual-write fallback exists so a Redis flap between issue and consume does not produce a spurious `expired` on a proof the user just minted. Keep that property. The "consumed exactly once across both tiers" reasoning no longer applies to the session kind, but the slide must not be lost when a consume is served from memStore, and a memStore-served slide must not resurrect an entry Redis has already expired.

### 4. `POST /api/ipfs/upload-token` accepts a session-kind proof

Accept **either** the existing `ipfs_upload`-targeted consent-op proof **or** a valid session-kind proof within its window. This is what makes inline upload reachable for passwordless state C, whose only factor is a page navigation that a selected `File` cannot survive.

The rationale for the widening is in § 6.4.1: a live session proof already authorizes arbitrary broadcasts for the rest of its window, so an upload is not a wider grant than the holder already has, and the per-file integrity binding lives in the returned upload token rather than in the fresh-auth proof. The consent-op kind stays accepted so the signature path and any non-SPA caller are unaffected.

### 5. Session invalidation must close open windows

`sessions_invalidated_at` (§ 6.7) currently revokes bearer JWTs only. A password reset or recovery that leaves a live broadcast window open has not actually cut off the compromised session. Invalidating a user's sessions MUST also invalidate their outstanding session-kind proofs. Logout should drop the proof server-side too, not just clear the client copy.

### 6. Invariant #9 holds

No login, token-refresh, or signup-finalization path may mint or extend a session-kind proof as a side effect. Only `POST /api/custody/session-auth` (password) and `POST /api/orcid/callback mode='session_auth'` (ORCID) open a window. This is the line that keeps the fresh-auth layer from collapsing into the session layer, and it is worth an explicit test rather than trusting that nobody adds it later.

### 7. Wire contract

Issuance responses need both deadlines so the SPA can decide when to re-auth ahead of a submit rather than discovering expiry mid-flow. Keep the existing ISO-8601 string convention. `expires_at` keeps its meaning as the deadline the client should treat as authoritative for "do I need to re-auth"; add the absolute cap alongside it.

Error codes and status discrimination are unchanged: 401 for `missing` / `expired` / `malformed`, 403 for `username_mismatch` / `kind_mismatch`. A window that hit either deadline reports `expired`.

## Acceptance criteria

1. A session proof minted by password or ORCID authorizes multiple broadcasts without re-minting.
2. Idle beyond 15 minutes between consumes ends the window, reported as `expired`.
3. The window ends at 2 hours after first mint regardless of how many consumes slid it. A test that slides repeatedly across the cap must fail closed.
4. Two concurrent consumes of the same valid session proof both succeed.
5. Consent-op proofs remain single-use, target-bound, 5-minute TTL. A session proof is still rejected on the consent surface with `kind_mismatch`, and a consent-op proof is still cross-kind-accepted on the session surface.
6. `POST /api/ipfs/upload-token` succeeds against a valid session proof and still succeeds against an `ipfs_upload`-targeted proof.
7. Invalidating a user's sessions invalidates their outstanding session proofs.
8. No login or signup-finalize response mints a session-kind proof.

## Testing notes

Per the root `CLAUDE.md` carve-out, TTL and cap behavior are the deterministic-edge-case class that justifies fake timers over real waits; document the justification in the test file header. Auth-focused specs must run the real `verifyHiveSignature`. The window-boundary tests are the ones most worth writing first, since the cap is the security-relevant half of the design and the easiest to implement in a way that silently never fires.

## Contract docs

`agents/docs/api-contracts/custody.md`, `ipfs.md`, and `orcid.md` all describe surfaces this changes: the session-auth issuance response gains a field, the broadcast consume stops being single-use, and upload-token acceptance widens. Those files are architect-owned and describe live wire behavior, so they are updated when this lands rather than ahead of it. Flag the wire-visible changes at review intake so the update is not missed. `settings.md` and `accreditation.md` use the consent-op kind and are unaffected.
