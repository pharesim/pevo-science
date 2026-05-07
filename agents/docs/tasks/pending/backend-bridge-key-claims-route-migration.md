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

## Architect re-review (2026-05-06, round-1) — HELD PENDING FIXES

`/ce-code-review` ran on commit `83c6a28` with 9 reviewers (correctness + security + adversarial at opus; testing/maintainability/project-standards/learnings/reliability/kieran-typescript at sonnet). Migration is structurally complete — `grep` audit confirms no remaining `PrivateKey.fromString(config.pevoBridgePostingKey)` per-request sites in `routes/`, `BridgeKeyCacheUnpopulated` is verified redact-safe (Error subclass with no Buffer-derived properties, ASCII message, deterministic name), and async error propagation through Express 5's errorHandler is correct. Six findings plus one pre-existing surface; three become hold items.

### Items to address

**1. (P1) Negative-invariant test depends on cache-state inheritance from sibling tests.** `backend/tests/routes/claims.test.ts:481-516` — the new describe block uses `vi.spyOn(dhive.PrivateKey, 'fromString')` to assert the bridge WIF is NOT parsed per-request, but the assertion only holds because some earlier describe block populates the cache before the spy is installed. Run in isolation, the lazy-fallback at `startup-checks.ts:296` fires `PrivateKey.fromString(source)` on the request hot path, the spy records it, and `expect(calledWithBridgeWif).toBe(false)` fails. Cross-reviewer corroboration: adversarial (P1, conf 75) + testing (P2, conf 75) + project-standards (residual risk). Promoted to conf 100.

   Fix: add a `beforeAll` inside the new describe block that deterministically populates the cache before any spy is installed:

   ```ts
   import {
     _resetBridgePostingKeyCacheForTests,
     _initBridgePostingKeyCacheForTests,
   } from '../../src/startup-checks.js';

   describe('BACKEND-BRIDGE-KEY-CLAIMS-ROUTE-MIGRATION — handlers no longer parse the bridge WIF per-request', () => {
     beforeAll(() => {
       _resetBridgePostingKeyCacheForTests();
       _initBridgePostingKeyCacheForTests();
     });
     // ...existing it() blocks unchanged
   });
   ```

   Hook names depend on what `startup-checks.ts` actually exposes; pick the right test-only hook(s). The point is: the test must not depend on test-execution order to hold its assertion. Verify by running just this describe block in isolation (`vitest -t 'PrivateKey.fromString NOT called'`) — it should pass post-fix.

**2. (P2) Acceptance criterion #3 not met — `getRequiredBridgePostingKey()` docstring is stale.** `backend/src/startup-checks.ts:256-274` — task acceptance criterion #3 explicitly says "The cache accessor's docstring (parent-task hold item 11) is widened to cover claims.ts when this task lands." But commit `83c6a28` only touches `routes/claims.ts` and `tests/routes/claims.test.ts`. The helper docstring still says claims.ts:214,:311 are unmigrated and that "the throw-site guarantee scopes to `bridge.ts` call sites only". Both claims are now false.

   Fix: edit lines 256-274 to:
   - Widen the "must not call" guidance from `bridge.ts`-specific to all production bridge-WIF callers (or generalize to "all bridge-WIF call sites in `routes/`").
   - Update the throw-site guarantee to cover both `bridge.ts` and `claims.ts`.
   - Delete or rewrite the round-3-hold-#11 paragraph (lines 269-274) — the round-3 hold is now resolved and the temporary "until that lands" note is obsolete. Lean toward delete; git history captures the trail.

**3. (P3) Inline comments at `routes/claims.ts:215-224` and `:322-324` duplicate the helper JSDoc.** Both inline rationale blocks reproduce content already covered (post-Item 2) by `getRequiredBridgePostingKey()`'s JSDoc. The "see comment at the approve handler" cross-reference at `:322-324` compounds the rot risk if the approve handler moves or restructures.

   Fix: replace both inline blocks with a one-liner pointing at the helper docstring:

   ```ts
   // Boot-cached key; see getRequiredBridgePostingKey() docstring in startup-checks.ts.
   const key = getRequiredBridgePostingKey();
   ```

   Order matters: Item 2 (widening the docstring) MUST land before or with Item 3 (collapsing inline comments). Otherwise future readers hit a docstring that says "claims.ts isn't migrated yet" while reading code in claims.ts that IS migrated. `routes/bridge.ts:379-390` has the same 10-line pattern (parent-task scope) — explicitly out of THIS task's scope to avoid scope drift; consistency-sweep across both files would be a separate task if desired.

### Items dismissed during architect triage

- **(P2) Cache-desync error contract divergence at `routes/claims.ts:225, :325`** — `BridgeKeyCacheUnpopulated` lands as 500 INTERNAL_ERROR; same root state via `assertBridgeKeyConfigured` returns 503 SERVICE_UNAVAILABLE. Adversarial flagged the inconsistency. Dismissed: the divergence is intentional design. `BridgeKeyCacheUnpopulated` is a platform-invariant violation (cache-null-but-config-truthy means boot validation was skipped or the cache was nulled mid-process — neither should happen in production); surfacing it as 500 prompts on-call investigation rather than naive client retry. A 503-wrapper at every call site couples handlers to a defensive structural error class — the kind of premature defensive coupling root CLAUDE.md warns against ("Don't add error handling, fallbacks, or validation for scenarios that can't happen"). The maintainability cost (try/catch boilerplate at 4 sites) outweighs the operator-clarity gain for a path that should never fire.

- **(P2) Lazy fallback at `startup-checks.ts:289-298` re-introduces a per-request `PrivateKey.fromString` throw site on cache desync.** Filed as a separate follow-up task `backend-bridge-key-lazy-fallback-throw-site-closure.md` rather than held on this task. Reasons: the lazy fallback is part of the parent task's design surface (`getCachedBridgePostingKey` was authored under round-3 of `backend-bridge-key-startup-validation-and-pino-redact`); pulling it into this task's hold confuses owner-scope. The follow-up task can choose between minimal fixes (replace lazy parse with structured throw) and deeper ones (delegate to redact serializer) without competing pressure to land claims-migration round-2.

- **(P3) errorHandler drops `err.name`/`err.constructor.name` at `backend/src/middleware/errorHandler.ts:10`.** Reliability flagged that `BridgeKeyCacheUnpopulated`'s docstring claim ("Operator alerts and log greps can key on `err.type === 'BridgeKeyCacheUnpopulated'`") doesn't hold for the errorHandler path because the manual `{ message, stack }` projection drops `err.name`. Dismissed: keyability claim is wrong-but-survivable. Stack traces still contain the class name on line 1; a real cache-desync incident would surface the gap and we can fix then. Project-wide; affects every custom error class. If this becomes load-bearing in operator workflows, file `backend-error-handler-include-err-name-in-log-projection`.

- **(P2 pre-existing) Approved-co-author authority elevation at `routes/claims.ts:208`.** Adversarial flagged that any approved co-author of a bridge paper can call this endpoint and trigger a broadcast under `config.hiveBridgeAccount` identity. Dismissed as intentional bridge-paper trust model: PEvO's bridge-paper feature exists specifically to let real authors (after claim approval) take ownership of bridge-ingested papers, including approving subsequent claims. The platform admin is the bootstrap authority for the first approval; validated co-authors continue the chain. Feature, not bug.

- **(anchor 50, suppressed by gate) `vi.spyOn` test-mock carve-out header note.** Project-standards flagged that the test file header doesn't document justification for the new `vi.spyOn(dhive.PrivateKey, 'fromString')` instrumentation. Below confidence gate; the spy is passthrough (original still executes), so it's borderline whether the carve-out's clause-(a) header-justification requirement applies to instrumentation as opposed to behavior-replacement mocks.

### Re-review signal

When items 1-3 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only.

## Backend re-review signal (2026-05-06, round-1 hold-fixes — commit `83031c4` on `main`, originally `103e21d` on `worktree-agent-a0ef875f8f9169812`)

Round-1 hold items 1-3 landed.

- Item 1: added `beforeAll` inside the new describe block in `backend/tests/routes/claims.test.ts` that calls `_resetBridgePostingKeyCacheForTests()` then `_initBridgePostingKeyCacheForTests()` (both already exported from `startup-checks.ts`); also added `beforeAll` to the `vitest` import. The cache is now deterministically populated before any spy is installed, so the negative-invariant assertion holds when this describe runs in isolation.
- Item 2: widened the `getCachedBridgePostingKey()` JSDoc to cover all production bridge-WIF callers (both `routes/bridge.ts` and `routes/claims.ts`), updated the throw-site guarantee to span both files, deleted the round-3-hold-#11 paragraph (no longer accurate post-83c6a28), and added a `grep` cross-reference. Also refreshed the `getRequiredBridgePostingKey()` tail paragraph from "sets the convention for the claims.ts follow-up" to "adopted by bridge.ts and claims.ts:225, :325". Hold block cited lines 256-274 / 269-274; actual lines were 285-318 / 308-313 (the docstring at 256-274 is `validatePostingKeyFormat`'s, unrelated). Honored intent.
- Item 3: collapsed the 10-line inline rationale at `claims.ts:215-224` and the 3-line cross-ref at `:322-324` into the one-liner the hold block specified (`// Boot-cached key; see getRequiredBridgePostingKey() docstring in startup-checks.ts.`). Item 2 landed first so the docstring the comments now point at is accurate.

`tsc --noEmit` clean. `npm run lint` clean (only 2 pre-existing `seed-phrase.ts` warnings, unrelated). Targeted test passes in isolation: `npx vitest run tests/routes/claims.test.ts -t 'PrivateKey.fromString NOT called'` → 2 passed | 21 skipped.

## Architect re-review (2026-05-07, round-2) — HELD PENDING FIXES

`/ce-code-review` ran on commit `83031c4` (round-1 hold-fix landing) with 8 reviewers (correctness + security + adversarial at opus; testing/maintainability/project-standards/learnings/kieran-typescript at sonnet; ce-agent-native-reviewer skipped per project CLAUDE.md). Round-1 hold items 1-3 land structurally correctly. Two doc-only divergences surfaced — both introduced BY this commit (not pre-existing), both mechanical 1-token edits. Two reviewers cross-corroborate item 1; correctness + adversarial cross-corroborate item 2.

### Items to address

**1. (P2, anchor 100, 4-reviewer corroboration: correctness, adversarial, maintainability, kieran-typescript) Stale line numbers in `getRequiredBridgePostingKey()` JSDoc.** `backend/src/startup-checks.ts` — the docstring paragraph that reads `Adopted by routes/bridge.ts (rounds 3-4 of the parent task) and routes/claims.ts:225, :325 (BACKEND-BRIDGE-KEY-CLAIMS-ROUTE-MIGRATION, commit 83c6a28)`. The cited lines `:225, :325` are pre-collapse positions; actual `getRequiredBridgePostingKey()` call sites in the post-collapse tree are `claims.ts:216` (approve handler) and `:314` (revoke handler). Item 3's comment collapse shifted the calls up by 9 and 11 lines respectively; the docstring was authored against the pre-collapse positions and not updated in the same commit.

   Verify by `sed -n '216p;314p' backend/src/routes/claims.ts` — both lines should return `    const key = getRequiredBridgePostingKey();` (or its current form).

   Fix: edit the docstring paragraph to read `routes/claims.ts:216, :314` instead of `:225, :325`. Single 2-token swap.

**2. (P3, anchor 100, cross-corroborated correctness + adversarial) Docstring grep claim "expected zero" yields 2 hits on the post-migration tree.** `backend/src/startup-checks.ts` — the operator-facing diagnostic command in `getCachedBridgePostingKey()`'s JSDoc (the paragraph instructing operators to re-derive the call-site map via grep). The docstring says: ``Re-derive the call-site map via `grep -rn "PrivateKey\.fromString(config.pevoBridgePostingKey" backend/src/` — the expected hit count is zero.``

   Running that exact grep on the post-migration tree returns **2 hits**: one at `startup-checks.ts:226` (the boot validator's parse — INTENDED, must remain) and one at `startup-checks.ts:296` (the docstring's own self-match). A future operator following the doc at face value reads "2 hits" as either a regression panic or as guidance to edit `routes/` (no code is broken; the edit would be destructive).

   Fix: scope the grep to `backend/src/routes/` so the claim is true. Single edit: change `backend/src/` to `backend/src/routes/` in the grep command. The narrowed grep yields 0 hits cleanly. Alternative phrasing (`grep -v startup-checks.ts`) is also acceptable; the architect's mild preference is the path-narrowing form because it's terser and more obvious to a future reader.

### Items dismissed during architect triage

(None this round — all surfaced findings either hold or are below the confidence gate.)

### Re-review signal

When items 1-2 land, `git mv` this file back to `tasks/review/`. Round-3 architect review scopes `/ce-code-review` to the round-3 commit only.
