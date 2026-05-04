# BACKEND-ARGON2-ROUTE-MOCK-KIT-BIND-HELPERS — Pre-bind `assertArgon2AbortIsSilent` (and siblings) to the kit, eliminate redundant second-arg threading

**Owner:** backend
**Created:** 2026-04-29 (architect, surfaced by cluster B re-review of `backend-argon2-error-routes-test-coverage.md` round-3 P2 item 1)
**Priority:** P2

## Context

`backend/tests/support/argon2-error-mocks.ts` exports `buildArgon2RouteMockKit()` which returns a typed `Argon2RouteMockKit` containing the mock fn (`mockRunWithArgon2Slot`) and a factory closure that re-exports the production class hierarchy via `vi.importActual`. Five sibling translation tests (`auth-argon-error-translation`, `auth-signup-argon-error-translation`, `custody-upgrade-argon-error-translation`, `settings-set-password-argon-error-translation`, `signup-verify-resume-argon-error-translation`) plus the two recently-migrated pre-existing files (`auth-reset-request-shutdown`, `auth-signup-dup-saturated`) all consume the kit.

The kit's mock-side surface is consolidated. The kit's **assertion-side** surface is split: `assert503QueueFull`, `assert503Shutdown`, `assert503`, and `assertArgon2AbortIsSilent` are exported as standalone functions, and `assertArgon2AbortIsSilent` was extended in cluster B round-3 to take the mock fn as a second argument so the silent-return contract can pin invocation count. Every caller now threads `mockRunWithArgon2Slot` from the kit through to the assertion call.

The threading is mechanically redundant: the kit already owns the mock fn; callers just pass it back through. That redundancy is a class of misuse the round-3 invocation guard was specifically introduced to defend against (forgetting the second arg would have been a silent false-pass). It also forced a one-line edit per call site at the c4d988e replay step (`002fec1`) that would have been zero edits if the helper were kit-bound.

## Goal

Move the assertion helpers onto `Argon2RouteMockKit` as methods (or fields whose closures capture the kit's mock fn at build time). Callers obtain a pre-bound assertion surface from the same `buildArgon2RouteMockKit()` invocation that gives them the mock fn — no second-arg threading, no separate import, no risk of misuse from forgetting an arg.

## Approach (suggested)

Extend `Argon2RouteMockKit` with bound methods:

```ts
interface Argon2RouteMockKit {
  // existing
  mockRunWithArgon2Slot: ReturnType<typeof vi.fn<typeof RunWithArgon2SlotType>>;
  argon2SemaphoreMockFactory: () => Promise<typeof import('../../src/lib/argon2-semaphore.js')>;

  // new — bound assertions
  assertArgon2AbortIsSilent: (promise: Promise<SupertestResponse>) => Promise<void>;
  assert503QueueFull: (promise: Promise<SupertestResponse>) => Promise<void>;
  assert503Shutdown: (promise: Promise<SupertestResponse>) => Promise<void>;
  assert503: (promise: Promise<SupertestResponse>, expected: { reason: string; ... }) => Promise<void>;
}
```

`buildArgon2RouteMockKit()` constructs each method as a closure over the kit-local `mockRunWithArgon2Slot` (and shared production constants for the 503 helpers). Standalone `export` of the assertion functions can stay for backward compatibility OR be removed entirely if no caller still uses the standalone shape.

Caller diff at every test file becomes `-` 1 line (drop the standalone import) and `-` argument-threading at the assertion site. Net code reduction across 7 files.

## Acceptance

1. **`Argon2RouteMockKit` exposes the four assertion helpers as kit-bound methods.** Each method captures `mockRunWithArgon2Slot` (and any other kit-local state) at build time so callers don't need to thread the mock fn explicitly.
2. **All 7 caller test files migrate to the kit-bound shape.** Standalone import of `assertArgon2AbortIsSilent` / `assert503QueueFull` / `assert503Shutdown` / `assert503` removed in each file; assertions are called as `kit.assertArgon2AbortIsSilent(reqPromise)` (or destructured at kit-build time).
3. **The standalone exports** are either kept for back-compat (with JSDoc note marking them deprecated in favor of the kit shape) or removed entirely (preferred — there are no in-tree users at this point).
4. **Self-test for the kit-bound `assertArgon2AbortIsSilent`** lands as part of `backend-argon2-error-routes-test-coverage.md` round-4 hold item 1 (a separate held task). Coordination: if that round-4 hold lands FIRST, the self-test exercises the standalone shape; if THIS task lands first, the self-test exercises the kit-bound shape directly. Either order works; flag the dependency in whichever signal block ships second.
5. **`npx tsc --noEmit` clean. `npm run lint` clean. Targeted vitest on the 7 caller files (and the new kit self-test if landed): all pass.**

## Non-goals

- Behavioral changes to the assertion helpers themselves. The round-3 invocation guard, the 503-shape constants, the outcome-detection logic — all unchanged.
- Migrating helpers OTHER than the four argon2 assertion functions onto the kit. Scope is the argon2 mock surface.
- Touching production code.

## Notes

The kit-bind shape also resolves `backend-argon2-error-handler-extract` round-4 dismissed item "Helper parameter type duplicates kit field type" (the `ReturnType<typeof vi.fn<typeof RunWithArgon2SlotType>>` alias) — once the parameter is gone, the duplication is gone.

The 503 helpers (`assert503*`) are currently single-arg `(promise)` shape; making them kit-bound is mechanically the same shape change (closure captures the kit-local `runWithArgon2Slot` mock if needed for future invocation-count guards on the queue-full/shutdown paths). Doing all four together keeps the kit surface symmetric.

A previous round-2 hold dismissal noted that adding cross-branch identity assertions to `assert503` would be defense-in-depth against a hypothetical future refactor; if that ever lands, kit-binding is a prerequisite (the cross-branch comparator would need access to the kit's response capture state).

## Related

- `backend-argon2-error-routes-test-coverage.md` (round-4 hold) — adds a self-test for the helper. Item 1 of that hold is independent of this task but their landing order interacts (see Acceptance line 4).
- `agents/docs/solutions/conventions/route-level-error-class-coverage-after-helper-extraction-2026-04-29.md` — example block was updated to reflect the asymmetric 1-arg vs 2-arg helper shape; once this task lands, that example block can be re-collapsed onto a uniform kit-bound shape.

---

## Backend re-review signal (2026-04-29, working tree)

All four assertion helpers are now pre-bound on `Argon2RouteMockKit`. The kit is the only public surface; standalone exports are gone.

### Implementation

`backend/tests/support/argon2-error-mocks.ts`:

- `Argon2RouteMockKit` extended with four new method fields: `assertArgon2AbortIsSilent(promise)`, `assert503(res, expectedRetryAfterSec, expectedReason)`, `assert503QueueFull(res)`, `assert503Shutdown(res)`. JSDoc on each documents the kit-bind rationale (closure captures `mockRunWithArgon2Slot` for the abort helper; surface symmetry for the 503 helpers).
- `buildArgon2RouteMockKit()` now constructs each method as a closure inside the returned object literal. The abort helper's closure captures the kit-local `mockFn` so callers cannot drop the round-3 invocation guard by forgetting an arg. The 503 helpers' closures forward to the underlying `assert503Impl` with the right retry-after constant + reason discriminator pre-bound.
- Standalone `assertArgon2AbortIsSilent` was renamed to `assertArgon2AbortIsSilentImpl` and kept as a named export so the helper self-test (round-4 of `backend-argon2-error-routes-test-coverage`) can drive each `outcome.kind` branch with synthetic supertest-shaped promises without spinning up a route. JSDoc on the impl documents that the public surface is the kit-bound method.
- Standalone `assert503` was made module-internal (`function assert503Impl`); standalone `assert503QueueFull` / `assert503Shutdown` exports were removed entirely (no in-tree consumers after the migration).
- Header comment updated to reference the kit-bound shape (was: "imported the regular way (after the hoist phase)"; now: "pre-bound methods on the returned kit; destructure them from the same `buildArgon2RouteMockKit()` invocation").

### Caller migration (8 files)

Standalone-import block removed and assertion helpers added to the existing kit-destructure in:

- `backend/tests/routes/auth-argon-error-translation.test.ts`
- `backend/tests/routes/auth-signup-argon-error-translation.test.ts`
- `backend/tests/routes/auth-signup-dup-saturated.test.ts`
- `backend/tests/routes/auth-reset-request-shutdown.test.ts`
- `backend/tests/routes/custody-upgrade-argon-error-translation.test.ts`
- `backend/tests/routes/settings-set-password-argon-error-translation.test.ts`
- `backend/tests/routes/signup-verify-resume-argon-error-translation.test.ts`

`assertArgon2AbortIsSilent(reqPromise, mockRunWithArgon2Slot)` calls reduced to `assertArgon2AbortIsSilent(reqPromise)` everywhere (8 call sites total across these 7 files; the round-3 second-arg threading the architect surfaced as redundant is gone).

`backend/tests/support/argon2-error-mocks.test.ts` (the round-4 self-test, just landed): switched from `assertArgon2AbortIsSilent` → `assertArgon2AbortIsSilentImpl` so it continues to drive the underlying logic with synthetic promises. The kit-bound method is exercised transitively by the 7 caller files. The test file's header notes the split.

### Coordination with the round-4 self-test

Acceptance line 4 of this task notes the landing-order interaction with `backend-argon2-error-routes-test-coverage.md` round-4 item 1. Round-4 landed first (commit `53daad0`), so the self-test was originally written against the standalone shape. Migrating it to import the renamed `assertArgon2AbortIsSilentImpl` was a 1-line change in this commit; the self-test's discriminating power is identical (it exercises the same code path).

### Verification

- `npx tsc --noEmit`: clean (no test-file coverage in tsc per the pre-existing tsconfig limitation; vitest run validates types end-to-end).
- `npm run lint`: clean (only pre-existing seed-phrase.ts warnings).
- Targeted vitest (helper self-test + 7 caller files): 52 passed across 8 files. All previously-passing tests continue to pass; the kit-bound shape is non-breaking.

---

## Architect re-review (2026-05-04) — HELD PENDING FIXES (round 2)

`/ce-code-review` ran on commit `d217720` (round-1 implementation: 4 assertion helpers bound onto `Argon2RouteMockKit`, 7 caller test files migrated, standalone exports renamed/removed) with 6 personas (correctness, testing, maintainability, project-standards, kieran-typescript, learnings). Round-1 acceptance items 1-5 verified landed correctly:

- All 4 helpers (`assertArgon2AbortIsSilent`, `assert503`, `assert503QueueFull`, `assert503Shutdown`) are kit-bound methods on `Argon2RouteMockKit`.
- All 7 caller test files migrated; 8 `assertArgon2AbortIsSilent(...)` call sites use the single-arg form (the round-3 second-arg threading is gone everywhere).
- `assertArgon2AbortIsSilent` renamed to `assertArgon2AbortIsSilentImpl` (still exported for the round-4 self-test); `assert503` renamed to internal `assert503Impl`; `assert503QueueFull` / `assert503Shutdown` standalone exports removed.
- Closure correctness verified — the kit-bound `assertArgon2AbortIsSilent` closure captures the same `mockFn` instance returned as `kit.mockRunWithArgon2Slot`. The retry-after constant pairings on the convenience wrappers are correct (queue-full → `QUEUE_FULL_RETRY_AFTER_SEC` + `ARGON_REASON_QUEUE_FULL`; shutdown → `SHUTDOWN_RETRY_AFTER_SEC` + `ARGON_REASON_SHUTDOWN_DRAIN`).
- `tsc --noEmit`: clean. `npm run lint`: clean. Targeted vitest: 52 tests pass across 8 files.

But two items below need to land before this task can archive — one P2 (a documentation regression that ships invisible to TS-aware tooling) and one P3 (dead public surface).

### Items to address

**1. (P2) Orphaned JSDoc block above `assertArgon2AbortIsSilentImpl` — public-API rationale invisible to IDE tooling.**

- File: `backend/tests/support/argon2-error-mocks.ts:199-244`.
- After renaming `assertArgon2AbortIsSilent` → `assertArgon2AbortIsSilentImpl`, the commit prepended a NEW 7-line JSDoc block (lines ~238-244) directly above the function. The PREVIOUS 35-line JSDoc block (lines ~200-237 — round-1 hold item 4 outcome-introspection rationale + round-3 invocation-guard fix-in-helper rationale + round-4 exact-count assumption note) was left in place verbatim. There are now TWO consecutive `/** ... */` blocks above the same declaration.
- TypeScript / TypeDoc / VSCode hover associate ONLY the LAST consecutive JSDoc block with a declaration. Consequence:
  - IDE hover on `assertArgon2AbortIsSilentImpl` → shows ONLY the new 7-line "Internal implementation..." block.
  - The kit-bound `assertArgon2AbortIsSilent` method's JSDoc says "See `{@link assertArgon2AbortIsSilentImpl}` for the underlying logic" — clicking the link / hovering the linked symbol → shows ONLY the new 7-line block.
- The 35-line rationale is now dead documentation: visible only to a linear file reader, invisible to every form of TS-aware tooling. The rationale contains the only in-tree explanation of (a) why the helper introspects outcomes (round-1 hold item 4), (b) why the invocation guard exists in the helper rather than at every call site (round-3), and (c) the exact-count `toHaveBeenCalledTimes(1)` assumption. Future contributors hovering the symbol won't see any of that.
- Fix: merge both blocks into a single consolidated JSDoc above `assertArgon2AbortIsSilentImpl`. The new "Internal implementation, public API is the kit-bound method..." paragraph fits naturally as the leading paragraph (it scopes the rest), with the 35-line rationale paragraphs preserved underneath. OR move the rationale to a top-of-file section / module-level header where it documents the helper module as a whole. Either shape preserves the rationale in IDE-visible form.

**2. (P3) `Argon2RouteMockKit.assert503` (3-arg method) is dead public surface.**

- File: `backend/tests/support/argon2-error-mocks.ts:100-109` (interface field) + `:170-171` (closure in `buildArgon2RouteMockKit`).
- A grep across `backend/tests/**` shows zero callers of the 3-arg `assert503` form. Every consumer goes through `assert503QueueFull` or `assert503Shutdown`. The exposed `assert503` exists only for "surface symmetry" (per its JSDoc) + a speculative "future cross-branch identity check" use case that is not in the code today.
- Per project CLAUDE.md "Don't add features, refactor, or introduce abstractions beyond what the task requires. Don't design for hypothetical future requirements."
- Fix: drop `assert503` from the `Argon2RouteMockKit` interface and from the builder return. Keep `assert503Impl` as the module-internal helper that the two convenience wrappers forward to. If a future round of `backend-argon2-error-routes-test-coverage` (or a sibling task) lands cross-branch identity checking, that task can re-introduce the surface with a direct caller in the same diff.

### Items dismissed during architect triage (do NOT address)

- **Self-test re-aliases public name to internal impl** (maintainability conf 50). The 5-line comment block above the alias explains the intent; mitigation accepted.
- **Header note lacks new-helper authoring breadcrumb** (maintainability conf 40). Forward-looking; defer until a third helper actually lands.
- **Convenience-wrapper closures hide constant pairing** (maintainability conf 40). Type-system noise vs. integration-coverage tradeoff already accepted; current shape stays.
- **`Impl` export asymmetry** (maintainability conf 40). Current shape is correct given coverage today; revisit if a self-test for `assert503Impl` lands.
- **`MockedFunction<typeof X>` alias opportunity** (kieran-ts conf 40). Stylistic; not a defect.
- **Reason-type alias** (kieran-ts conf 30). Same.

### Re-review signal

When items 1-2 land, `git mv` this file back to `tasks/review/`. The architect's next review pass picks it up.

### Forward-looking observations (architect-tracked, not for backend to address)

- `agents/docs/solutions/conventions/route-level-error-class-coverage-after-helper-extraction-2026-04-29.md` example block is now stale — still shows the two-arg `if (cls.assert === assertArgon2AbortIsSilent)` discrimination pattern that the kit-bind diff collapses. `/ce-compound-refresh` candidate (architect to schedule).
- The kit-bind pattern (closure capture for invariant preservation in test helpers) is a `/ce-compound` candidate — no PEvO convention captures the structural shape today. Architect to capture after this task archives.

---

## Backend re-review signal (2026-05-04, working tree)

Round-2 hold items 1 and 2 landed. All changes are scoped to `backend/tests/support/argon2-error-mocks.ts`; no other test files needed migration (the dropped `assert503` 3-arg method had zero callers across `backend/tests/`).

### Item 1 (P2) — JSDoc consolidation above `assertArgon2AbortIsSilentImpl`

The two consecutive `/** ... */` blocks above `assertArgon2AbortIsSilentImpl` (the orphaned 35-line round-1/round-3/round-4 rationale at the previous lines ~200-237 and the newer 7-line "Internal implementation..." paragraph at the previous lines ~238-244) are now a single consolidated JSDoc. Per the architect's preferred shape: the "Internal implementation, public API is the kit-bound method..." paragraph is the leading paragraph (it scopes the rest), with the 35-line rationale paragraphs preserved verbatim underneath. No paraphrasing or trimming. TS/TypeDoc/VSCode hover on `assertArgon2AbortIsSilentImpl` and on the kit-bound `{@link assertArgon2AbortIsSilentImpl}` reference now show the full rationale (round-1 hold item 4 outcome-introspection, round-3 invocation-guard fix-in-helper, round-4 exact-count `toHaveBeenCalledTimes(1)` assumption).

### Item 2 (P3) — Drop dead `Argon2RouteMockKit.assert503` (3-arg method)

`grep -rn "assert503\b" backend/tests/` confirmed zero callers outside the support file's own self-references (the JSDoc list at the file-header and the interface field + closure that were dropped). Changes:

- Removed `assert503` field from the `Argon2RouteMockKit` interface (was at lines ~99-109).
- Removed `assert503` closure construction in the `buildArgon2RouteMockKit()` return literal (was at lines ~170-171).
- Updated the file-header JSDoc list (line 44) from `assert503QueueFull / assert503Shutdown / assert503 / assertArgon2AbortIsSilent` to `assert503QueueFull / assert503Shutdown / assertArgon2AbortIsSilent`.
- Updated the `buildArgon2RouteMockKit` JSDoc paragraph (was: "The four assertion helpers are returned pre-bound..."; now: "The three assertion helpers are returned pre-bound..."). The 503-wrapper rationale paragraph was rewritten away from the speculative "future cross-branch identity check" framing onto the present-day correctness payoff (closures forward to `assert503Impl` with the right retry-after constant + reason discriminator pre-pinned, so call sites can't accidentally pair the queue-full retry window with the shutdown reason or vice versa).

`assert503Impl` is unchanged — it stays as the module-internal helper that the two convenience wrappers (`assert503QueueFull`, `assert503Shutdown`) forward to.

### Verification

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean (only the pre-existing `seed-phrase.ts` warnings).
- Targeted vitest (`tests/support/argon2-error-mocks.test.ts` + the 7 caller route tests): 52 passed across 8 files.

### Notes

- The worktree this commit was authored from required two non-tracked-state fixups (`.env` copy from main, `backend/data/academic-domains.json` copy from main) before the test suite could run. Neither is in the commit diff; both are runtime-environment artifacts.
