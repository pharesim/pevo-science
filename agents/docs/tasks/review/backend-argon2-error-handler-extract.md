# BE-ARGON2-ERROR-HANDLER-EXTRACT — Consolidate argon2 error catch logic across 4 routes; eliminate 3-way instanceof drift

**Owner:** backend
**Created:** 2026-04-28 (surfaced by argon2 cluster re-review)
**Priority:** P2
**Blocked by:** `backend-argon2-jslevel-concurrency-cap.md` round-3 hold landing (avoids merge-conflict churn against the round-3 fix to auth.ts:401,407).

## Context

After the argon2 cluster (jslevel-concurrency-cap, shutdown-drain, abort-signal) landed, every route that calls `runWithArgon2Slot` must catch three distinct error classes:
- `ArgonQueueFullError` → 503 SERVICE_UNAVAILABLE
- `ShuttingDownError` → 503 SERVICE_UNAVAILABLE
- `ArgonAbortError` → silent return (client already disconnected)

`auth.ts:236-242` factored this into a `handleArgonQueueFull(res, err): boolean` helper but never exported it. The 3 sibling routes (`custody.ts`, `signup-verify.ts`, `settings.ts`) inline the same 3-way instanceof chain. Already drifted: maintainability reviewer noted custody.ts logs a `username` field in the error context that the others omit. A future 4th error class would require updates in 4 sites with no compiler enforcement.

Additional related items surfaced by the same review pass:
- The function name `handleArgonQueueFull` no longer matches scope (handles 3 error kinds).
- The boolean side-effect return contract (`if (handleArgonQueueFull(res, err)) return;`) is fragile — a caller that omits `return` falls through to a 500 with double-respond. No test catches this.
- The 3 error classes have no shared base; catch sites do 3 `instanceof` checks.
- `requestAbortSignal` helper duplicated verbatim across 4 route files (auth.ts, custody.ts, settings.ts, signup-verify.ts) per the abort-signal task's "no shared new file per the file-list scope" constraint. The duplication is intentional but needs to be resolved as part of consolidation.
- `argon2-semaphore.ts` has both `{ once: true }` AND explicit `removeEventListener` in finally on the abort listener — one is always a no-op. Reader confusion.

## Goal

Centralize argon2 error handling and cross-file helpers into the backend `lib/` module. Eliminate the 3-way inline instanceof checks and the requestAbortSignal duplication.

## Approach (suggested)

1. Add `ArgonSemaphoreError` abstract base class in `argon2-semaphore.ts`. Make `ArgonQueueFullError`, `ShuttingDownError`, `ArgonAbortError` extend it. Catch sites can then do a single `if (err instanceof ArgonSemaphoreError) ...` to identify any semaphore error.
2. Move `handleArgonQueueFull` to `backend/src/lib/argon2-error-handler.ts` (or export from `argon2-semaphore.ts`). Rename to `handleArgon2Error`. Reconsider the boolean side-effect contract — prefer one of:
   - `void` return that throws if it can't handle (forces caller to wrap in try/catch — discouraged given the catch is already inside try/catch).
   - Returning the same `boolean` but documenting the contract loudly with a JSDoc `@returns` and adding a route-level test (in `backend-argon2-error-routes-test-coverage.md`) that asserts double-respond doesn't happen if a future caller omits the `return`.
3. Move `requestAbortSignal` to `backend/src/lib/request-abort-signal.ts`. Replace the 4 inline copies with imports.
4. Pick one of `{ once: true }` OR explicit `removeEventListener` in argon2-semaphore.ts abort listener — drop the redundant one.

## Acceptance

- `ArgonSemaphoreError` base class exists; all 3 concrete errors extend it.
- `handleArgon2Error` (renamed) exported from a shared module; imported and used by all 4 affected routes (auth, custody, signup-verify, settings).
- `requestAbortSignal` lives in one shared module; all 4 routes import it.
- Inline 3-way instanceof checks removed from custody.ts, signup-verify.ts, settings.ts.
- argon2-semaphore.ts abort listener uses one cleanup mechanism, not both.
- `npx tsc --noEmit` clean; full backend test suite passes.

## Non-goals

- Behavioral changes to error handling. This is a structural consolidation only — same status codes, same response shapes, same logs.
- Changes to the underlying semaphore or argon2 invariants.

---

## Implementation notes (backend, 2026-04-28)

### Shape decisions

- **Base class**: `ArgonSemaphoreError` is `abstract` in `argon2-semaphore.ts`. The three concrete errors (`ArgonQueueFullError`, `ShuttingDownError`, `ArgonAbortError`) extend it. Catch sites do one `instanceof ArgonSemaphoreError` check; the helper does the per-subclass dispatch.
- **Helper location**: `backend/src/lib/argon-error-handler.ts` (new file). Mirrors `lib/broadcast-error.ts`'s shape and conventions. Renamed from `handleArgonQueueFull` to `handleArgonError`.
- **Return-shape footgun fix**: helper returns `'handled' | 'unhandled'` (string-literal union) matching the convention `handleBroadcastError` already uses (`'timeout' | 'failure'`). Call sites read:
  ```ts
  if (handleArgonError(res, err, { logContext: { username } }) === 'handled') return;
  ```
  The `=== 'handled'` comparison is harder to typo than a bare `if (helper(...))` boolean, and forgetting the comparison still produces an obvious truthy short-circuit (`if ('unhandled') return`) that surfaces in any path-level test rather than silently double-responding.
- **Custody username field**: kept on the custody catch site via the new `opts.logContext` parameter. Other sites pass nothing (default `{}`). No widening of the function signature; per-route extra log fields go through `logContext`.
- **`requestAbortSignal`**: extracted to `backend/src/lib/request-abort-signal.ts`. All four routes import it from one place.
- **`{ once: true }` vs explicit `removeEventListener`**: kept the explicit `removeEventListener` (covers BOTH the abort-fires path AND the resolved-normally path, so it is load-bearing on the resolved-without-abort branch); dropped `{ once: true }` (which would only matter when abort fires, where the explicit cleanup also runs). Inline comment in `argon2-semaphore.ts` documents the choice.
- **`burnSentinel` re-throw**: previously did three explicit `instanceof` checks before the warn-and-swallow path. Collapsed to one `instanceof ArgonSemaphoreError` re-throw using the new base class. Same behavior, narrower to read, and any future fourth subclass propagates automatically.
- **`/signup` 409 dup `.catch`**: structural collapse, behavior unchanged. The two inline `.catch` blocks at the duplicate-email burn sites previously enumerated all three concrete subclasses (`ArgonQueueFullError || ShuttingDownError || ArgonAbortError`) and re-threw each. They now collapse to one `instanceof ArgonSemaphoreError` re-throw via the shared abstract base. Same set of errors propagates to the outer catch as before; the prior earlier wording in this note ("re-threw any `ArgonSemaphoreError`" framed as a behavior widening) was incorrect — verified by the architect against `git show 497795e:backend/src/routes/auth.ts:425-455` during the round-2 hold pass.

### Extension points for downstream tasks

The helper is the choke point for every 503 the auth surface emits, so:

- **`backend-503-message-genericize.md`**: change the `message` field in the two 503 branches inside `handleArgonError`. One-place edit.
- **`backend-503-retry-after.md`**: read `opts.retryAfterSec` and call `res.set('Retry-After', String(opts.retryAfterSec))` before `sendError` in the two 503 branches. The `retryAfterSec` field is already declared in `HandleArgonErrorOpts` but currently unused — wire its consumer when that task lands.
- **`backend-argon2-error-routes-test-coverage.md`**: route-level coverage that asserts each catch site does NOT double-respond if a future caller forgets the early return. The string-literal sentinel makes the failure mode noisier (truthy short-circuit on `'unhandled'`) but a positive test is still warranted.

### Files touched

- Created: `backend/src/lib/argon-error-handler.ts`, `backend/src/lib/request-abort-signal.ts`
- Modified: `backend/src/lib/argon2-semaphore.ts` (base class + listener cleanup), `backend/src/routes/auth.ts` (catch-site collapse + burnSentinel base-class re-throw + signup-dup catch), `backend/src/routes/custody.ts`, `backend/src/routes/settings.ts`, `backend/src/routes/signup-verify.ts`

### Verification

- `npx tsc --noEmit` clean.
- `npm run lint` clean (only pre-existing `seed-phrase.ts` `no-explicit-any` warnings unrelated to this task).
- Scoped tests pass: `tests/lib/argon2-semaphore.test.ts` (15/15), `tests/lib/broadcast-error.test.ts`, `tests/routes/auth.test.ts` (20/20), `tests/routes/auth-concurrency.test.ts`, `tests/routes/custody.test.ts`, `tests/routes/settings.test.ts`, `tests/routes/settings-set-password.test.ts`. Pre-existing failures in `tests/routes/recover.test.ts` (4) and `tests/routes/signup-verify.test.ts` (2) reproduce on the unmodified HEAD and are unrelated to this refactor — verified by stashing the changes and re-running.

---

## Architect re-review (2026-04-28) — HELD PENDING FIXES

`/ce-code-review` ran on commits 73b6d76 + 46676ef with 11 reviewers (correctness, security, adversarial, reliability, api-contract, testing, maintainability, project-standards, kieran-typescript, agent-native, learnings). Backend refactor lands cleanly: timing-oracle invariant verified closed, listener cleanup sound across resolve/abort/shutdown paths, `logContext` propagates `username` structurally equivalently to the prior inline log, all four routes use `=== 'handled'`, no `await` runs after `handleArgonError` at any of the 9 catch sites (Express 5 response-ordering risk from `helper-extraction-express5-response-ordering-2026-04-28.md` does not apply).

Doc-side fixes (auth.md /signup + /resend-verification + /resume-signup + /login + /reset-request + /reset + /recover, custody.md /upgrade, settings.md /set-password, common.md error-code table + AbortError silent-return note) were applied in the same architect commit that produced this hold block. Six backend follow-up items below need to land before this task can archive.

### Items to address

**1. `opts.logContext` open record + logger merge order (CNPD/PII risk)**
- File: `backend/src/lib/argon-error-handler.ts:78-90,142`.
- Narrow the type from `Record<string, unknown>` to a closed allowlist (e.g., `opts.logContext?: { username?: string }`). Today only custody passes `{ username }`, so the change is non-disruptive. The open record invites a future caller to pass `{ email }`, bypassing the project-wide `hashEmailForLogs` convention. Portugal/CNPD jurisdiction makes raw emails in operator logs a real compliance risk.
- Reorder the spread inside the logger calls from `{ err, ...ctx }` to `{ ...ctx, err }` so a caller-supplied `ctx.err` cannot clobber the structured error field.
- Three reviewers flagged this (adversarial, kieran-typescript, maintainability).

**2. Stale comment at `auth.ts:373` references the old helper name `handleArgonQueueFull`**
- File: `backend/src/routes/auth.ts:373`.
- Update to reference `handleArgonError` (the renamed helper).

**3. Filename: rename `argon-error-handler.ts` → `argon2-error-handler.ts`**
- File: `backend/src/lib/argon-error-handler.ts` → `backend/src/lib/argon2-error-handler.ts`.
- Sibling files use the `argon2-` prefix (`argon2-semaphore.ts`, `argon2-options.ts`). The current name means `grep argon2-` misses the helper. Update the 4 import paths in `routes/{auth,custody,settings,signup-verify}.ts`.

**4. Export `ARGON_HANDLED` / `ARGON_UNHANDLED` constants and `isArgonSemaphoreError` type guard**
- File: `backend/src/lib/argon2-error-handler.ts` (post-rename).
- Add `export const ARGON_HANDLED = 'handled' as const;` and `export const ARGON_UNHANDLED = 'unhandled' as const;`. Update the 9 call sites to `=== ARGON_HANDLED`. Removes magic strings.
- Add `export function isArgonSemaphoreError(err: unknown): err is ArgonSemaphoreError` in `argon2-semaphore.ts`. Keeps `instanceof` narrowing colocated with the class.

**5. Reframe inline comment at `auth.ts:401-422` to say "structural collapse, behavior unchanged" and correct the existing implementation note above this hold block**
- File: `backend/src/routes/auth.ts:401-422` and the "Implementation notes → /signup 409 dup `.catch`" bullet earlier in this task file (line 68 in the version that landed).
- The current comment block names the three subclasses but reads as if it documents a behavior change (and the implementation note in this task file claims a "widening"). **Verified false** by the architect against `git show 497795e:backend/src/routes/auth.ts:425-455`: pre-refactor code already enumerated all three subclasses with three explicit `instanceof` checks and re-threw all three. The refactor is purely structural collapse from `(A || B || C)` to `instanceof base class`. The `burnSentinel` body sentence ("matches what the `burnSentinel` body already did") in the existing note is also misleading: `burnSentinel` had three explicit checks too; the collapse is structural in both places.
- Reframe the inline comment so a future bisector understands the intent without thinking they are reading a behavior change. Rewrite the implementation note to describe what actually changed (structural collapse via the new abstract base class, not a behavioral widening).

**6. JSDoc cross-references on `ArgonSemaphoreError` base class**
- File: `backend/src/lib/argon2-semaphore.ts:71-91`.
- Base-class JSDoc describes the propagation invariant but doesn't point at the two consumers (`burnSentinel` re-throw in `auth.ts`, `handleArgonError` dispatch in `argon2-error-handler.ts`) that depend on it. A future contributor adding a 4th subclass needs to know both consumers assume 503-able-or-silent semantics. Two-line addition.

**7. Validate `opts.retryAfterSec` at the helper boundary (added 2026-04-28 from 503-bundle review)**
- File: `backend/src/lib/argon2-error-handler.ts` (post-rename), where `opts.retryAfterSec` is consumed before `res.set('Retry-After', String(...))`.
- Field is currently typed `number | undefined` and passed straight through. NaN, Infinity, negative values, and non-integer fractions all flow to the wire as malformed `Retry-After` headers. No production caller passes the field today, so this is latent; closing it before a future caller derives it from user input avoids a Retry-After-injection or ill-formed-header oracle.
- Implementation: clamp to a positive integer (`Math.max(0, Math.floor(opts.retryAfterSec))`), or reject non-finite values with a `logger.warn` + per-branch-default fallback. Keep the per-branch defaults as the floor.
- Add test cases in `tests/lib/argon-error-handler.test.ts` for `retryAfterSec: 0`, negative, `NaN`, `Infinity`, fractional. Both branches (queue-full + shutdown).
- Two reviewers flagged this (reliability, kieran-typescript).

### Items dismissed during architect triage (do NOT address)

- **Truthy short-circuit footgun on `'unhandled'`** — covered by `backend-argon2-error-routes-test-coverage.md` (also in cluster A's review queue). The exported constants in item 4 also help.
- **`ArgonAbortError.name = 'AbortError'` asymmetry** — intentional DOMException compat for code that does `err.name === 'AbortError'`. Comment in argon2-semaphore.ts already explains it.
- **`HandleArgonErrorOpts.retryAfterSec` declared-but-unused** — `backend-503-retry-after.md` (also in cluster A's review queue) wires it.
- **`handleArgonError` lacks `writableEnded` guard** — YAGNI today (no streaming endpoints); loud failure mode (`ERR_HTTP_HEADERS_SENT`) if ever triggered.
- **Per-route log correlation enrichment, saturation log volume** — advisory ops items, not tracked.

### Re-review signal

When items 1-6 above land, `git mv` this file back to `tasks/review/`. The architect's next review pass picks it up; the move itself is the re-review signal (no need to edit this hold block).

---

## Backend re-review signal (2026-04-28, working tree)

All 7 hold-block items addressed (item 7 was appended later by the architect from a 503-bundle review pass; landed alongside 1-6).

**Item 1 — `opts.logContext` allowlist + logger merge order**
- `backend/src/lib/argon2-error-handler.ts`: narrowed `logContext?: Record<string, unknown>` → `logContext?: { username?: string }` with JSDoc explaining the CNPD/PII rationale.
- Reordered the spread inside all 4 logger calls (warn/info/debug/error) from `{ err, ...ctx }` to `{ ...ctx, err }`. Added an inline comment on the warn branch explaining the ordering invariant once; the other branches reference it.

**Item 2 — stale `auth.ts:373` comment**
- Replaced `handleArgonQueueFull` reference with `handleArgonError` (matches the renamed helper at HEAD).

**Item 3 — file rename + import updates**
- `git mv backend/src/lib/argon-error-handler.ts → argon2-error-handler.ts`. Sibling test renamed too: `backend/tests/lib/argon-error-handler.test.ts → argon2-error-handler.test.ts`. Updated import paths in `routes/{auth,custody,settings,signup-verify}.ts` and the 4 route-translation tests under `backend/tests/routes/*-argon-error-translation.test.ts` (static import + dynamic-import path string), plus the docblock cross-reference at `tests/routes/auth-argon-error-translation.test.ts:39`.

**Item 4 — exported sentinel constants + type guard**
- `argon2-error-handler.ts`: added `ARGON_HANDLED = 'handled' as const` and `ARGON_UNHANDLED = 'unhandled' as const`; `HandleArgonErrorResult` now references the constants. Updated all 9 call sites (6 in `auth.ts`, 1 each in `custody.ts`, `settings.ts`, `signup-verify.ts`) from `=== 'handled'` to `=== ARGON_HANDLED`. Updated the JSDoc example, the file's preamble, and the catch-block call-shape comment block in `auth.ts:238-250`.
- `argon2-semaphore.ts`: added `isArgonSemaphoreError` type guard colocated with the abstract base class.

**Item 5 — reframed inline comment + corrected implementation note**
- `auth.ts:401-422`: the two `.catch` blocks at the duplicate-email burn sites now read "Structural collapse, behavior unchanged" with the architect's git-archaeology rationale. The second branch references the first to avoid duplication.
- Implementation note at line 68 of this task file rewritten to reflect structural collapse rather than a behavior widening; the note explicitly flags the prior wording as incorrect with a pointer to the `git show 497795e` evidence.

**Item 6 — `ArgonSemaphoreError` JSDoc cross-references**
- `argon2-semaphore.ts:71-91`: extended the base-class JSDoc to name the two consumers (`burnSentinel` re-throw in `auth.ts`, `handleArgonError` dispatch in `argon2-error-handler.ts`) and the "503-able-or-silent" propagation invariant a future 4th subclass must honor.

**Item 7 — `retryAfterSec` perimeter validation**
- `argon2-error-handler.ts`: added private `resolveRetryAfterSec(override, defaultSec)` helper consumed by both 503 branches. Accepts only finite non-negative values, floors fractional values to integer, and on invalid input emits a `logger.warn` and falls back to the per-branch default (5 / 30). Zero remains valid (HTTP allows `Retry-After: 0`).
- New tests in `tests/lib/argon2-error-handler.test.ts` under `describe('opts.retryAfterSec validation (perimeter check)')` exercise both branches × {negative, NaN, +Infinity, -Infinity, fractional, zero}. Existing happy-path overrides (`17`, `90`) still pass — the helper is identity for finite non-negative integers.

### Verification

- `npx tsc --noEmit` clean.
- `npm run lint` clean (only the pre-existing `seed-phrase.ts` no-explicit-any warnings, unrelated to this task).
- Targeted vitest suites pass (12 files, 113 tests, 13.27s):
  - `tests/lib/argon2-semaphore.test.ts` (15)
  - `tests/lib/argon2-error-handler.test.ts` (22 — was 14 before item 7's 8 new validation cases)
  - `tests/routes/auth-argon-error-translation.test.ts` + custody/settings/signup-verify variants (24 across 4 files)
  - `tests/routes/auth.test.ts`, `auth-concurrency.test.ts`, `auth-signup-dup-saturated.test.ts`, `custody.test.ts`, `settings.test.ts`, `settings-set-password.test.ts` (52 across 6 files).
- Full backend suite is the architect's call (per CLAUDE.md run-tests guidance + the implementer-side note about pre-existing unrelated failures).

## [BLOCKED by Backend] (architect 2026-04-28)

Self-declared `**Blocked by:** backend-argon2-jslevel-concurrency-cap.md round-3 hold landing` (file:13). The round-3 fix has not landed yet, so the catch-site refactor cannot be reviewed without merge-conflict churn. Moving to `blocked/`. Backend agent: move back to `review/` once jslevel-concurrency-cap round-3 lands and this task's diff has been rebased on top.

(Architect 2026-04-29: prerequisite landed; file moved back to `review/` via commit `7c448d3`. The architect re-review block below picks up from that signal.)

---

## Architect re-review (2026-04-29) — HELD PENDING FIXES (round 3)

`/ce-code-review` ran on commit `38c1ff1` (the round-2 hold-fix commit landing items 1-7) with 11 personas (correctness, testing, maintainability, project-standards, agent-native, learnings, security, reliability, api-contract, kieran-typescript, adversarial). All 7 round-2 hold-block items verified landed correctly:

- **Item 1** — `logContext` narrowed to `{ username?: string }`; logger spread reordered to `{ ...ctx, err }` across all 4 logger calls. Type narrowing makes a `ctx.err` clobber structurally impossible through the typed surface; the spread reorder is defense-in-depth against an `as any` bypass. CNPD/PII rationale recorded inline.
- **Item 2** — stale `handleArgonQueueFull` reference at `auth.ts:373` updated to `handleArgonError`.
- **Item 3** — file rename `argon-error-handler.ts` → `argon2-error-handler.ts` complete; src + test + 4 route imports + 4 test dynamic-import path strings + 1 docblock cross-reference all migrated. `grep -r "argon-error-handler" backend/` returns zero hits.
- **Item 4** — `ARGON_HANDLED = 'handled' as const` and `ARGON_UNHANDLED = 'unhandled' as const` exported with `HandleArgonErrorResult = typeof ARGON_HANDLED | typeof ARGON_UNHANDLED`. All 9 production call sites updated to `=== ARGON_HANDLED`. `isArgonSemaphoreError(err: unknown): err is ArgonSemaphoreError` exported as a true type predicate, colocated with the abstract base.
- **Item 5** — inline comment at `auth.ts:401-422` reframed to "Structural collapse, behavior unchanged." Implementation note in this task file rewritten with the architect's `git show 497795e` evidence pointer; the prior "behavior widening" framing flagged as incorrect.
- **Item 6** — `ArgonSemaphoreError` JSDoc cross-references at `argon2-semaphore.ts:71-91` extended to name the two consumers (`burnSentinel` re-throw + `handleArgonError` dispatch) and the 503-able-or-silent propagation invariant a future 4th subclass must honor.
- **Item 7** — `resolveRetryAfterSec(override, defaultSec)` validates at the helper boundary: `Number.isFinite` short-circuits NaN / ±Infinity / non-finite inputs, `< 0` rejects negatives, `Math.floor` integerizes fractions, zero remains valid (HTTP allows `Retry-After: 0`). Fallback path emits a `logger.warn` and returns the per-branch default (5 / 30). Tests cover both branches × {negative, NaN, +Infinity, -Infinity, fractional, zero}.

Doc-side: prior architect commit landed contract-doc updates in `agents/docs/api-contracts/{auth,custody,settings,common}.md` covering /signup, /resend-verification, /resume-signup, /login, /reset-request, /reset, /recover, /upgrade, /set-password, plus the SERVICE_UNAVAILABLE error-code row and the AbortError silent-return note. (Verified untouched in this re-review.)

One round-3 hold item below.

### Items to address

**1. (P3) Migrate the 4 raw `instanceof ArgonSemaphoreError` sites to the exported `isArgonSemaphoreError` type guard**

Item 4 added `isArgonSemaphoreError` "colocated with the class" with JSDoc claiming it's the preferred form. But the four production sites that already check `instanceof ArgonSemaphoreError` were not migrated:
- `backend/src/routes/auth.ts:233` (burnSentinel re-throw)
- `backend/src/routes/auth.ts:410` (`/signup` dup-burn `.catch`)
- `backend/src/routes/auth.ts:419` (second `/signup` dup-burn `.catch`)
- `backend/src/lib/argon2-error-handler.ts:244` (helper's own fast-path)

The only consumer is the test mock factory at `tests/support/argon2-error-mocks.ts:128`, which is a mechanical re-export. A type guard with zero production callers promises an abstraction it does not enforce — the next contributor either copies the unmigrated `instanceof` form (defeating the guard's purpose) or migrates ad-hoc (further fragmenting). Two reviewers (maintainability + kieran-typescript) flagged it independently.

Fix: replace the 4 raw `err instanceof ArgonSemaphoreError` checks with `isArgonSemaphoreError(err)`. Mechanical edit; type narrowing is identical (the guard is a true type predicate). ~4 line-edits.

### Items dismissed during architect triage (do NOT address)

- **Sibling task files cite old `argon-error-handler.ts` filename** (maintainability conf 55). Architect-side doc cleanup, fixed in-place during this review pass — see the corrections at `tasks/pending/backend-argon2-error-routes-test-coverage.md` lines 99, 107, 112 and the now-archived `backend-503-reason-discrimination.md` lines 60, 63 (in `tasks-archive.md`).
- **`resolveRetryAfterSec` warn line lacks `event:` tag for log aggregators** (agent-native ops conf 50). Pre-existing pattern (other helper log lines also use message-only); revisit when ops-side dashboard work surfaces the asymmetry.
- **Spread-order `{ ...ctx, err }` invariant comment-only, not pinned by test** (testing + kieran-typescript residual). Narrow `{ username?: string }` type makes the clobber structurally unreachable through the typed surface; a runtime test would have to bypass types via `as any`, which doesn't represent a reachable production path.
- **`HandleArgonErrorResult` 3rd-outcome silent-fallthrough risk** (kieran-typescript residual). YAGNI today; closed binary outcome.
- **`writableEnded` guard absence on the helper** (adversarial residual). Architect already YAGNI-triaged in the round-2 hold block; loud failure mode (`ERR_HTTP_HEADERS_SENT`) would surface immediately if a future caller violated the contract.

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. The architect's next review pass picks it up; the move itself is the re-review signal (no need to edit this hold block).

---

## Backend re-review signal (2026-04-29, commit ada6814 → merged via 9a811b9)

Round-3 hold-block item 1 (P3, the only round-3 item) landed.

**Item 1 — migrate 4 raw `instanceof ArgonSemaphoreError` sites to `isArgonSemaphoreError(err)`**

- `backend/src/routes/auth.ts:233` (burnSentinel re-throw) — migrated.
- `backend/src/routes/auth.ts:410` (first `/signup` dup-burn `.catch`) — migrated.
- `backend/src/routes/auth.ts:419` (second `/signup` dup-burn `.catch`) — migrated.
- `backend/src/lib/argon2-error-handler.ts:244` (helper's own fast-path) — migrated.
- Removed the now-unused `ArgonSemaphoreError` import from both files (kept `isArgonSemaphoreError`).
- `tests/support/argon2-error-mocks.ts:128` left untouched per the hold block (mechanical re-export).

`grep -n "instanceof ArgonSemaphoreError" backend/src/` returns only the type guard's own implementation body at `argon2-semaphore.ts:114` plus jsdoc/comments — zero raw production-side checks remain.

### Verification

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean (only pre-existing seed-phrase.ts warnings).
- Targeted vitest (7 suites: argon2-semaphore + argon2-error-handler + 5 route translation files): 76 passed (76).
- Full backend vitest after merge: 615 passed | 4 skipped (619) across 67 files.
