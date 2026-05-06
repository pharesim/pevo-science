# BACKEND-BRIDGE-KEY-CLAIMS-ROUTE-MIGRATION — Migrate `routes/claims.ts:214, :311` to the bridge-key cache accessor

**Owner:** Backend Agent
**Created:** 2026-05-06 (architect, surfaced by `/ce-code-review` triage on `backend-bridge-key-startup-validation-and-pino-redact`)
**Priority:** P2 (sibling-route consistency; redact-policy SSoT)

## Why now

`backend-bridge-key-startup-validation-and-pino-redact` migrated `routes/bridge.ts:237, :370` to use the cached parsed admin posting key (`getCachedBridgePostingKey()`) so the per-request `PrivateKey.fromString(config.pevoBridgePostingKey)` throw site (and its `AssertionError` `.actual` / `.expected` buffer-slice leak surface) is eliminated for those routes. The cache accessor's docstring implies project-wide coverage, but `routes/claims.ts:214` (`/papers/:author/:permlink/claims/approve`) and `routes/claims.ts:311` (`/revoke`) still parse the WIF on every request inside try/catch.

3-reviewer cross-corroboration in the parent task's `/ce-code-review` pass:

- correctness (P2, conf 100, marked pre-existing relative to parent task scope but flagged as docstring-claim violation)
- maintainability (P2, conf 90 — argues in-scope due to docstring claim)
- reliability (P2, conf 80)

Net cross-reviewer anchor: 100 (3 agreeing reviewers).

The redact policy (Layer-B `serializers.err`) still strips the `AssertionError` if it does fire, so this is not an active leak — but the structural-defense narrative the parent task set up is half-true until claims.ts catches up.

## Acceptance

- `routes/claims.ts:214` and `:311` use the bridge-key accessor exposed by `startup-checks.ts` instead of `PrivateKey.fromString(config.pevoBridgePostingKey)`. If the parent task's hold round lands `getRequiredBridgePostingKey()` (item 6 in that hold block), use that helper here for the same null-safe semantics. Otherwise fall back to `getCachedBridgePostingKey()` paired with the `assertBridgeKeyConfigured` chain that bridge.ts uses.
- The migration is mechanical: replace the parse call, remove the per-request try/catch around it (the parse no longer throws at request time), keep the rest of the broadcast flow intact.
- The cache accessor's docstring (parent-task hold item 11) is widened to cover claims.ts when this task lands. Coordinate with parent task if both hold rounds happen in close succession.

## Out of scope

- Other routes that call `PrivateKey.fromString` on a non-bridge key (e.g., `custody.ts:177` which parses a user's decrypted posting key) — those have a different threat model and a different leak shape (user's WIF, not admin WIF).
- Restructuring the bridge admin custom_json broadcast pattern.
- The error classification path — `errorHandler.ts` already manually redacts on the rare AssertionError fall-through; this task only removes the throw site.

## Dependencies

- Parent task `backend-bridge-key-startup-validation-and-pino-redact` should archive (or at minimum land its hold round) first. If `getRequiredBridgePostingKey()` lands there, this task uses it. Otherwise this task uses the existing `getCachedBridgePostingKey()` + `assertBridgeKeyConfigured` middleware chain.

## Testing

- Existing `tests/routes/claims.test.ts` should pass unchanged — the migration is behavior-preserving on the happy path.
- Add a coverage check that `claims.ts` no longer reaches `PrivateKey.fromString` per-request on a happy-path approve/revoke. Approach: spy on `dhive.PrivateKey.fromString` at the module level via `vi.spyOn`, run a happy-path approve broadcast through the route, assert the spy was NOT called with `config.pevoBridgePostingKey` during the request handler.
