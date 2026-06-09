# BACKEND-ADMIN-BROADCAST-HELPER-EXTRACTION — duplicate admin-broadcast envelope construction at 5 call sites

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #31 low severity, simplification)
**Priority:** P3

## Problem

Identical envelope construction repeated at 5 admin-broadcast call sites:
- [wot.ts:210-234](backend/src/wot.ts#L210-L234)
- [wot.ts:365-373](backend/src/wot.ts#L365-L373)
- [routes/claims.ts:348-358](backend/src/routes/claims.ts#L348-L358)
- [routes/orcid.ts:866-872](backend/src/routes/orcid.ts#L866-L872)
- [routes/orcid.ts:1067-1071](backend/src/routes/orcid.ts#L1067-L1071)

Shape: `id: appTag, required_auths: [], required_posting_auths: [hiveAdminAccount], json: stringify(payload)` + `PrivateKey.fromString(pevoAdminPostingKey)` + not-configured guard.

`wot.ts` also uses `await import('@hiveio/dhive')` (dynamic) while every other file imports it statically — arbitrary divergence.

## Goal

Extract one `broadcastAdminCustomJson(payload)` helper in [hive.ts](backend/src/hive.ts) next to `broadcastJsonWithTimeout`.

### Suggested approach

- Helper owns the missing-key guard (throw `AdminKeyNotConfiguredError` for per-site response shapes), `PrivateKey.fromString`, and envelope.
- Keep per-site error handling (each route returns its own response shape on broadcast failure).
- Switch `wot.ts` to static `dhive` import.
- `config.hiveAdminAccount` is singular by design — do not introduce a plural authorities array.

## Acceptance

- 5 call sites use the shared helper; envelope construction lives in one place.
- Each call site's response-on-failure shape is preserved (the helper's error is unwrapped per site).
- `wot.ts` no longer uses dynamic dhive import.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Pure simplification; no behavior change for legitimate broadcasts.

## Cross-references

- [backend/src/hive.ts](backend/src/hive.ts) — destination for the helper.
- 5 call sites listed above.
- HAF-query review run `w274tijk0` rank #31.

## Backend note (2026-06-01) — 3 of 5 sites landed; orcid descoped, needs architect decision

Helper `broadcastAdminCustomJson` + `AdminKeyNotConfiguredError` created in `hive.ts`.
Adopted at **3 of the 5** enumerated sites, all tested green against real Postgres/Redis:

- `wot.ts` `broadcastWotAccreditation` and `cascadeRevocation` (the two dynamic
  `await import('@hiveio/dhive')` sites are gone; wot.ts no longer imports dhive at all).
- `routes/claims.ts` admin-native revoke.
- Test mock factories updated: `claims.test.ts`, `wot-broadcast-timeout.test.ts`
  (claims 23 pass, wot-broadcast-timeout 10 pass). `wot-vouch-broadcast-outcomes.test.ts`
  needs no change (it stubs `broadcastWotAccreditation` itself).

**The two `routes/orcid.ts` sites (handleAccredit, handleLink) are intentionally left
inline.** Reason: in both, `PrivateKey.fromString(config.pevoAdminPostingKey)` sits
OUTSIDE the inner `try`, so a key-construction throw escapes synchronously to the
`withOrcidBindingLock` wrapper, which maps it to a 504 ambiguous-outcome + lock release.
The `SEC-002-TOCTOU-LOCK` describe block pins exactly this ("pre-broadcast SYNC throw
inside fn on the lock-acquired branch -> 504 ... lock released for retry", x4 specs).
Folding the async helper in moves key construction INSIDE the `try`, converting that
synchronous throw into a rejection caught by the inner catch -> 502 BROADCAST_FAILED on
the lock-acquired branch. That changes a security-tested failure shape, which this
task's acceptance ("response-on-failure shape is preserved") forbids changing silently.

Architect decision requested: (a) accept 3/5 here, keep orcid inline, and close; or
(b) accept 3/5 and file a follow-up that migrates orcid with the boundary preserved
(e.g. validate/parse the admin key OUTSIDE the inner try before the helper call, or
re-map `AdminKeyNotConfiguredError`/key-parse errors to the wrapper-escape path) plus
the matching `SEC-002-TOCTOU-LOCK` test updates; or (c) hold this task for that work.

Also surfaced (not in the task's 5): four more sites build the identical admin envelope
with `pevoAdminPostingKey` and could fold into the same helper in a follow-up —
`routes/signup-verify.ts` (x2, but inside the active signup-activation redesign and
Task `backend-anchor-rot-sweep-signup-verify`'s comment sweep), `routes/papers.ts`
(retraction), and `routes/accreditation.ts`. Left untouched to keep this change scoped.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Architect re-review (2026-06-09) — HELD PENDING FIXES (1 item)

`/ce-code-review` fan-out on commit `e60ec2c1` (10 personas; correctness/security/adversarial on Opus). The extraction is verified **behavior-preserving**: the envelope is field-identical at all 3 adopted sites (the claims.ts object-literal key-order change is inert — dhive serializes by field name), default `timeoutMs` resolves to the same effective timeout, `BroadcastTimeoutError` discrimination is intact, and `AdminKeyNotConfiguredError` is structurally unreachable at every adopted site because each pre-guards `config.pevoAdminPostingKey` before reaching the helper. An exhaustive grep confirmed the implementer's residual-site enumeration is accurate (only `orcid.ts`×2 + `papers.ts`/`accreditation.ts`/`signup-verify.ts` remain inline). No live defect.

**Architect decision on the orcid descoping (the a/b/c question above): option (b) — ACCEPTED.** Keep the 3/5 adoption; the two orcid sites stay inline (their pre-broadcast `PrivateKey.fromString` outside the inner `try` preserves the SEC-002-TOCTOU-LOCK 504+lock-release boundary, which folding the async helper in would break — confirmed by the security + correctness reviewers). A follow-up task `backend-admin-broadcast-envelope-sweep-remaining-sites` is filed in `pending/` to finish the dedup (papers/accreditation/signup-verify straightforwardly, orcid×2 via a key-validate-outside-`try` shim). This decision is RESOLVED and is **not** the hold item.

**The real-envelope test gap (review finding #2)** — all call-site tests mock `broadcastAdminCustomJson` and rebuild the envelope in-test, so a regression in the real helper's `required_posting_auths` would pass green — is folded into the consolidated follow-up `backend-pin-shared-broadcast-values` (`pending/`). Also **not** a hold item here.

### Item held (must fix before archive)

1. **(P3, maintainability + kieran-typescript, corroborated) `broadcastAdminCustomJson` docblock overclaims a per-caller mapping that no current caller exercises.** The docblock says "Each admin-broadcast caller maps this onto its own not-configured / broadcast-failure response shape." In fact all three adopters pre-guard `config.pevoAdminPostingKey` and short-circuit *before* reaching the helper (claims.ts via `if (isAdmin && config.pevoAdminPostingKey)`; both wot.ts paths via an early return), so `AdminKeyNotConfiguredError` is thrown on **no** current path — the per-caller-mapping claim is currently false. Reword the docblock so it is honest: the guard + error class are a **forward-looking** safety net; all *current* callers pre-check the key and skip before the helper, so the throw is unreachable today; a *future* caller that omits the pre-check would surface it (a WoT-style caller catches it; a route caller routes it through `handleBroadcastError` → generic 502). Keep the guard and the exported class (the `…-envelope-sweep-…` follow-up makes them live the moment a non-pre-guarded site like papers/accreditation adopts the helper). Comment-only, no behavior change; anchor on stable symbols (no slug/line/SHA/§).

When the reword lands, `git mv` this file back to `tasks/review/`; the move is the re-review signal (the next pass scopes to the reword commit only).

## Backend re-review signal (2026-06-09)

Reworded the `AdminKeyNotConfiguredError` docblock in `hive.ts` (round-1 hold item 1). It no longer claims a per-caller mapping that no current path exercises. The guard + error class are now described as a forward-looking safety net: every current adopter pre-checks `config.pevoAdminPostingKey` and short-circuits before reaching the helper (the WoT paths return a `skipped` result; `claims.ts` is gated by an `isAdmin && config.pevoAdminPostingKey` branch), so the throw is unreachable on every present call path; a future non-pre-guarded adopter would surface it (a WoT-style caller catches it inline, a route caller routes it through `handleBroadcastError` to a generic 502). Comment-only, no behavior change; anchored on stable symbols (no slug/line/SHA/§). `npm run typecheck` + `npm run lint` clean (the lone pre-existing `author-supersession.ts` unused-directive warning is untouched).

