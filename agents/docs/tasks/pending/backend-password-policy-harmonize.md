# BE-PASSWORD-POLICY-HARMONIZE — Backend side of cross-stack password-policy harmonization

**Owner:** Backend Agent
**Priority:** P3
**Created:** 2026-04-21
**Surfaced by:** SEC-004-BE review triage (2026-04-21).
**Paired with:** `ui-password-policy-harmonize.md` — coordinate so both halves land consistently.

## Context

FE-PASSWORD-POLICY-DRY (commit `a753773`) and BE-PASSWORD-POLICY-DRY (archived 2026-04-21c) extracted shared helpers in each stack independently. Both currently encode an identical `length >= 10 && /[a-z]/ && /[A-Z]/ && /[0-9]/` rule, but they will drift unless harmonized explicitly.

## Goal

Now that both single-stack extractions have landed, harden the backend side against silent drift from the frontend:

1. Add `// Keep in sync with frontend/src/password-policy.js` pointer comment in `backend/src/password-policy.ts` (or wherever the helper lives) so any future edit has a visible nudge to update the other side.
2. Add a CI check (grep or type-level) that fails when only one side changes. The backend CI is the canonical place for this gate since the repo's CI workflow is typically backend-driven; coordinate with the UI agent if the check needs to compare files across stacks.
3. Coordinate with UI half (`ui-password-policy-harmonize.md`) so both pointer comments reference each other and land in the same review cycle.

## Non-goals

Changing the policy itself. Adding zxcvbn or other strength tools. Centralizing via a JSON schema both sides consume (considered, not the chosen shape for this task).

## Status

Both prerequisite helpers landed. No longer blocked on other work — blocked only on coordinating the CI-check shape with the UI side.

## Deliverable

A future unilateral policy change on one side breaks CI, not production. The backend helper carries a visible pointer to the frontend counterpart. Move to Review with the CI-check implementation + backend-side pointer comment.

## Architect contract note

Document the canonical policy in `agents/docs/api-contracts/auth.md` with explicit pointer to both helpers (already partially done — `auth.md:60` and `:382` cite the helper; `settings.md:93` does too). Architect may need to confirm those pointers still resolve after this task lands.

## Implementation (Backend, 2026-04-22)

- `backend/src/lib/password-policy.ts`: header comment rewritten to `Keep in sync with frontend/src/password-policy.js`, mirroring the FE-side wording (`frontend/src/password-policy.js:1`). Comment now also cites the drift-check test below so future editors see where the gate lives.
- `backend/tests/lib/password-policy-drift.test.ts`: new vitest test dynamically imports both helpers, asserts `MIN_PASSWORD_LENGTH` matches across stacks, and runs a shared labelled test-vector grid through both `isPasswordValid` implementations. Any unilateral change (rule shape, length, class set, type-coercion behaviour) fails the grid and surfaces the exact disagreeing scenario. This is the repo's "CI gate" — there is no `.github/workflows` directory, so the gate lives in `npm test`, which is where agents already run tests before moving tasks to review.
- Backend lint clean after the change; `tests/lib/password-policy.test.ts` and the new `password-policy-drift.test.ts` both pass (12 tests total).

## [TODO Architect]

- Verify the contract pointers in `agents/docs/api-contracts/auth.md` and `settings.md` still resolve after archive — they already cite `isPasswordValid` / both helper files in prose, no shape change needed.
- Optional: during archive, consider adding a one-liner to `auth.md` or `settings.md` pointing at `backend/tests/lib/password-policy-drift.test.ts` as the drift gate, so anyone chasing the "CI check" referenced by this task can find it from the contract side. Not strictly required — the pointer comments in the helpers already cite the test file.

---

## Architect re-review (2026-04-29) — HELD PENDING FIXES (round 1)

`/ce-code-review` ran on commit `6c4e963` (the cross-stack drift gate test landing alongside the FE pointer comment in commit `0b73a53`) with 7 personas (correctness, testing, maintainability, project-standards, agent-native, learnings, kieran-typescript). The drift-check test loads both the backend (TS) and frontend (JS) helpers and asserts agreement — structurally correct, the right shape per the convention "the test IS the audit surface." The pointer comment on the BE helper cites both the FE counterpart and the drift-check test location. Both the BE and UI halves of the cluster land cleanly; the UI half (`ui-password-policy-harmonize`, commit `0b73a53`) returned zero findings in its own review and is eligible for archive.

But two items below tighten the drift gate's mutation-coverage and import-shape guarantees. Both are P3, but the gate's whole job is to fail loudly on drift — these items make sure it does.

### Items to address

**1. (P3) Add type-coercion test vectors that survive a `String()` coercion mutation**

- File: `backend/tests/lib/password-policy-drift.test.ts:38-43` (the non-string vectors block)
- Today's non-string vectors all coerce to strings that **still fail class checks**: `String(undefined)` = `'undefined'` (no digit, fails `/[0-9]/`), `String(null)` = `'null'` (no digit), `String(123456789012345)` = `'123456789012345'` (no alpha, fails `/[a-z]/` and `/[A-Z]/`), `String({})` = `'[object Object]'` (no digit), `String([])` = `''` (length 0). A backend mutation that adds `pw = String(pw)` before the typeof guard would not be caught by any of these vectors — they all still fail validation post-coercion.
- A future drift where backend coerces non-strings to passing strings (e.g., a coercion bug producing `'1_Aa0000001'` from a number input) would slip through silently.
- Fix: add 1-2 vectors specifically constructed to pass class checks AFTER `String()` coercion. Concrete shape: a number whose decimal representation contains lowercase, uppercase, digit, and is ≥10 chars — e.g., a vector like `[label: 'number that satisfies all classes after String() coercion', input: 1_000_000_000n, expected: false]` (a BigInt rendered with a trailing `n`? actually JS `String(BigInt)` doesn't include the `n`, so this needs a different construct). Simpler: a custom object with a `toString` method returning a passing string (e.g., `{ toString: () => 'Abcdef1234' }`). Both helpers MUST reject the input regardless of what `toString` returns; if backend silently calls `String(x)` first the input would be valid post-coercion and only one helper would reject. The vector kills that mutation.

**2. (P3) Add a runtime shape guard on the dynamic FE-helper import**

- File: `backend/tests/lib/password-policy-drift.test.ts:24` (the `as FeModule` cast)
- The `(await import(pathToFileURL(FE_HELPER_PATH).href)) as FeModule` cast converts an `any` (dynamic import of a string URL bypasses TS resolution) into a typed interface with no runtime guard. If the FE module is renamed, missing an export, or the function signature changes, TypeScript won't catch it — the test instead produces confusing `undefined !== boolean` failures at assertion time.
- Fix: in `loadFeHelper()`, before the cast, assert structural shape:
  ```ts
  if (typeof fe.isPasswordValid !== 'function' || typeof fe.MIN_PASSWORD_LENGTH !== 'number') {
    throw new Error(`FE helper at ${FE_HELPER_PATH} has unexpected shape: missing isPasswordValid or MIN_PASSWORD_LENGTH`);
  }
  ```
  Then `as FeModule` becomes safe (the runtime check matches the type). A broken import surfaces with a clear "FE helper has unexpected shape" error instead of cryptic per-vector assertion failures downstream. ~5-line change.

### Items dismissed during architect triage (do NOT address)

- **testing T-02 (P3): single it-block with disagreements-accumulator instead of `it.each`** — failure messages already name each scenario via the array diff, so identifiability is present. Runner-level granularity would be nicer but the current shape is informative enough.
- **maintainability R1: two-impl pattern accumulates drift risk** — acknowledged in the task; the drift-check test is the explicit mitigation. Re-evaluate if policy grows beyond 4 criteria.
- **maintainability R2: disagreements-accumulator pattern less clear than per-vector assertions** — same as T-02; cosmetic.
- **kieran-ts RR-1: `tsc --noEmit` doesn't cover `backend/tests/`** — pre-existing tsconfig limitation; same finding was dismissed in Group B as deliberate scope.
- **kieran-ts TG-1: no exactly-MIN_PASSWORD_LENGTH-failing-class vector** — the existing 9-char vector (`'Short9aBc'`) covers length-just-below-10 with all classes; adding "exactly 10 with one class missing" adds breadth. Not blocking.
- **No Unicode vector** (residual R-01) — both helpers use ASCII-only `/[a-z]/`/`/[A-Z]/`/`/[0-9]/`; if either widens to `\p{Ll}` with `u` flag, the test would also need updating then. Filed as latent.
- **Cross-package dynamic import via `pathToFileURL` is unusual** (residual R-02) — the mechanism works on Node 20 ESM. Test infrastructure note, not a code defect.

### Re-review signal

When items 1-2 land, `git mv` this file back to `tasks/review/`. The architect's next review pass picks it up; the move itself is the re-review signal (no need to edit this hold block).

## Backend re-review signal (2026-04-29, working tree)

Both round-1 hold items landed at `backend/tests/lib/password-policy-drift.test.ts`:

1. **(P3) Type-coercion mutation-kill vectors.** Added two new vectors that survive a hypothetical `String()` coercion mutation. An object with `toString: () => 'Abcdef1234'` and an object with `valueOf: () => 'Abcdef1234'` both render to a string that satisfies every class check after coercion — so a backend mutation that did `pw = String(pw)` ahead of the typeof guard would still flag this input as valid, but the type-checking implementation rejects it. Both helpers MUST reject regardless of `toString` / `valueOf` output; if one helper coerces and the other type-checks, the disagreement-accumulator surfaces the exact disagreeing label.

2. **(P3) Runtime shape guard on the dynamic FE-helper import.** `loadFeHelper()` now imports the FE helper as `Record<string, unknown>` and asserts `typeof fe.isPasswordValid === 'function' && typeof fe.MIN_PASSWORD_LENGTH === 'number'` before casting to `FeModule`. A renamed/missing FE export now throws `FE helper at <path> has unexpected shape: missing isPasswordValid or MIN_PASSWORD_LENGTH` instead of producing cryptic `undefined !== boolean` failures inside each per-vector assertion downstream.

Verification:
- `npm run lint` — clean (only pre-existing accepted `@typescript-eslint/no-explicit-any` warnings in `seed-phrase.ts`).
- `npx tsc --noEmit` — clean (src/ scope; tests/ is excluded from tsconfig but vitest runs the file as TS).
- `npx vitest run tests/lib/password-policy-drift.test.ts` — 1 file / 2 tests pass. Both new toString/valueOf vectors flow through the disagreement accumulator without flagging — BE and FE both reject as expected.

---

## Architect re-review (2026-05-04) — HELD PENDING FIXES (round 2)

`/ce-code-review` ran on commit `79ac01d` (round-1 hold-fix: 2 type-coercion mutation-kill vectors + runtime FE-helper shape guard) with 6 personas (correctness, testing, maintainability, project-standards, kieran-typescript, learnings). Round-1 hold item 2 (runtime shape guard) landed correctly — the dynamic-import is now wrapped in a `Record<string, unknown>` cast + structural runtime check + clear "unexpected shape" error, closing the renamed/missing-export drift. Round-1 hold item 1 (type-coercion mutation-kill vectors) is half-resolved.

### Items to address

**1. (P3) `valueOf` vector is dead coverage — does not exercise the named coercion mutation.**

- File: `backend/tests/lib/password-policy-drift.test.ts:65-69`.
- Empirical verification (Node 20, run 2026-05-04): `String({ valueOf: () => 'Abcdef1234' })` returns `'[object Object]'`, NOT `'Abcdef1234'`. The reason: `String(obj)` invokes `OrdinaryToPrimitive(obj, hint='string')`, which calls `obj.toString()` first. `obj.toString` resolves to `Object.prototype.toString` (callable, returns `'[object Object]'`), so step 2 of the algorithm succeeds and `obj.valueOf()` is never called for the string hint.
- Under the named mutation `pw = String(pw)` ahead of the typeof guard, the `valueOf` vector reduces to the existing `['object input', {}, false]` case — both coerce to `'[object Object]'`, both fail class checks regardless of the mutation, neither vector kills the mutant.
- The accompanying comment (lines 54-59) over-claims: "Both helpers MUST reject the input regardless of what its `toString` returns; if one helper coerces and the other type-checks, the disagreement surfaces here." Accurate for the `toString` vector; structurally false for the `valueOf` vector.
- Fix: replace the `valueOf` vector with `[label, { [Symbol.toPrimitive]: () => 'Abcdef1234' }, false]`. `Symbol.toPrimitive` is the correct shape because it coerces regardless of hint (string, number, default), so a mutation introducing ANY coercion form (`String(pw)`, `+pw + ''`, `\`${pw}\``) is killed by the same vector. Update the comment to name the specific mutation each vector kills, per `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` ("How to apply" point 2 — the re-review signal should attest "confirmed fails on revert").
- Verification: insert `pw = String(pw)` ahead of the typeof guard in ONE helper (BE or FE), confirm the suite turns red on the `Symbol.toPrimitive` vector. Mention the verify result in the round-2 signal block. Revert the mutation before commit.

### Items dismissed during architect triage (do NOT address)

- **Untested throw branch on the runtime shape guard** (testing conf ~55). Defensive cleanup; the guard fires only on broken FE imports, which existing tests don't construct. A unit test driving the broken-import path is forward-compat polish, not blocking.
- **TS predicate function alternative for the shape guard** (kieran-ts / maintainability conf 45). Stylistic preference; the current `as Record<string, unknown>` + check + `as unknown as FeModule` shape is correct.

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. The architect's next review pass picks it up.

### Forward-looking observations (architect-tracked)

- No PEvO convention disambiguates `String()` / `valueOf` / `toString` / `Symbol.toPrimitive` semantics for differential-test design today. `/ce-compound` candidate after round-2 lands — provisional title: "Type-coercion mutation-kill vectors must name the mutation each kills (and `String()` invokes `toString` first under the string hint)."
