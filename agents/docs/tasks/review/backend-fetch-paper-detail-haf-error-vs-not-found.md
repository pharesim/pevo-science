# BACKEND-FETCH-PAPER-DETAIL-HAF-ERROR-VS-NOT-FOUND — Distinguish HAF errors from data-not-found at the route layer

**Owner:** Backend
**Created:** 2026-05-17 (architect, surfaced by `/ce-code-review` cluster pass on `backend-orcid-claim-mismatch-post-revocation-audit`)
**Priority:** P1 (architect's loud-fail design intent on the audit-visibility helpers is mechanically defeated; HAF outage indistinguishable from data-not-found in HTTP traffic)

## Problem

`backend-orcid-claim-mismatch-post-revocation-audit` (commit `0e648b6`) ratified Alt 2 with explicit "loud-fail parity" framing on `getAccreditationOrcidsWithStatus`: per the helper's docstring, audit emission silently degrading to no rows on HAF outage would mask the visibility the task exists to preserve. The helper correctly throws on HAF outage.

But `fetchPaperDetailFromHaf` at `backend/src/routes/papers.ts:862-1169` wraps its entire body (including the `Promise.all` calling both accreditation helpers + the canonical-root walker + the cumulative-authors build) in a try whose catch at lines 1166-1169 logs and returns `null`. The route handler at lines 2349-2384 then treats `null` as **404 NOT_FOUND**.

**Two consequences:**

1. HAF outage during paper-detail load returns 404 indistinguishably from "paper does not exist." Operators cannot tell from HTTP traffic whether HAF is down or papers are missing.
2. The loud-fail design intent (preserve audit visibility on HAF outage) is structurally unrealized: the throw from `getAccreditationOrcidsWithStatus` (and the sibling `getAccreditedOrcidsByAccount`) never reaches the response or any operator-observable surface beyond the swallowed `logger.error` inside the catch.

**Same pattern in sibling handlers:**

The enrichment route catch (around `papers.ts:2678`), retract handler (around `papers.ts:2758`), and cite handler (around `papers.ts:2922`) all use the same swallow-and-return-null pattern. This task's fix should sweep all four (or at minimum audit them and document deferrals).

**The pre-existing nature of the gap:** `getAccreditedOrcidsByAccount` has carried the same docstring "loud-fail" claim since its introduction. The new helper inherits the gap rather than introduces it. Round-2 architect re-review on `orcid-claim-mismatch-post-revocation-audit` made the call: the audit code itself is correct given the throw propagates to the helper, even if downstream eats it. The fix is at the route layer, not in that task's scope.

## Goal

At the `fetchPaperDetailFromHaf` route layer (and sibling handlers), distinguish "HAF-class error" from "data-not-found" so the route emits 503 SERVICE_UNAVAILABLE on the former and continues to emit 404 NOT_FOUND on the latter.

## Suggested approach (implementer to confirm during design pass)

Two shapes are defensible:

### Option A: discriminated return type

Change `fetchPaperDetailFromHaf` (and siblings) to return a discriminated union:

```ts
type FetchResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'not_found' }
  | { kind: 'haf_unavailable'; cause?: unknown };
```

Route handler branches: `not_found` → 404; `haf_unavailable` → 503 SERVICE_UNAVAILABLE with `details.retriable: true`; `ok` → 200. Closes the conflation at the type system level.

### Option B: re-throw HAF-class errors from the catch

Tag HAF-pool errors with an identifiable class (e.g., the existing `getPool()` returns a typed pool; HAF-pool query failures could be wrapped in a `HafQueryError`). The catch at `fetchPaperDetailFromHaf:1166-1169` selectively re-throws errors of that class instead of returning `null`. The route handler catches the re-thrown error and emits 503. Other errors continue to log + return null + 404.

**Implementer's call between A and B.** A is cleaner but touches more sites; B is narrower but relies on disciplined error tagging across helpers.

## Acceptance

### 1. HAF-outage paths emit 503 SERVICE_UNAVAILABLE, not 404

For all four affected handlers (paper detail, enrichment, retract, cite — at minimum), a HAF-pool query throw on any of the accreditation helpers (or sibling helpers like `getAllAccreditedAccounts`) surfaces at the route as 503 with `details.retriable: true`. A reasonable response message: "Paper detail temporarily unavailable. Please retry shortly."

### 2. Data-not-found paths continue to emit 404

A request for a paper that genuinely doesn't exist (no row in HAF for the author/permlink) continues to emit 404 NOT_FOUND. The acceptance test must include both paths.

### 3. Tests

- New spec: `fetchPaperDetailFromHaf` returns 503 when `getAccreditationOrcidsWithStatus` throws. Mock the helper to throw, assert the route response is 503 + stable error code + retriable hint.
- New spec: same for `getAccreditedOrcidsByAccount`.
- Sibling specs for the same shape on enrichment, retract, cite handlers (or document deferrals in the signal block).
- Regression: paper-not-found continues to emit 404.

### 4. Documentation

`agents/docs/api-contracts/papers.md` (or wherever the GET /api/papers/:author/:permlink contract lives) gains a new 503 error code entry per `api-contracts/common.md` shape. The architect handles the doc edit at archive time; flag via `[TODO Architect]` in the implementer signal block.

### 5. Helper-side docstring honesty

Once the route layer surfaces the loud-fail correctly, update the `getAccreditationOrcidsWithStatus` and `getAccreditedOrcidsByAccount` docstrings to drop the "loud-fail parity" framing as aspirational and replace with the now-realized contract: "throws on HAF unavailable; the route layer translates to 503."

## Out of scope

- Refactoring the accreditation helpers themselves (architect's YAGNI dismissal on the optional shared-CTE refactor stands).
- Adding `Retry-After` headers to the new 503 responses (defer; the same convention question being worked through for `ACCREDITATION_GATE_UNAVAILABLE` applies here).
- Sibling routes outside paper-detail (e.g., profile, search) that may have similar swallow patterns — out of scope unless trivially in-the-area; file separate tasks if material.

## Source

- `/ce-code-review` cluster pass on Accreditation/ORCID review, 2026-05-17.
- Reliability reviewer (orcid-claim-mismatch-post-revocation-audit, REL-001), confidence 90, P1: "Architect's loud-fail intent on `getAccreditationOrcidsWithStatus` is mechanically defeated by outer try/catch in `fetchPaperDetailFromHaf`."

## Cross-references

- `backend/src/routes/papers.ts:862-1169` — `fetchPaperDetailFromHaf` outer try/catch.
- `backend/src/routes/papers.ts:2349-2384` — route handler treating null as 404.
- `backend/src/routes/papers.ts:2678, 2758, 2922` — sibling enrichment / retract / cite handlers with the same pattern.
- `backend/src/accreditation.ts:101-140` — `getAccreditedOrcidsByAccount` docstring with the "loud-fail" claim.
- `backend/src/accreditation.ts:206-249` — `getAccreditationOrcidsWithStatus` (new helper, same docstring claim).
- `agents/docs/api-contracts/common.md` — shared 503 envelope shape (`details.retriable`, `Retry-After` conventions).

## Implementation signal (Backend, 2026-05-17)

**Decision: Option B (`HafQueryError` tagging).** Rationale:

- Narrower change. Only the two fetcher catch blocks + the four route handlers need touching; the `null`-means-data-missing contract that downstream callers rely on (`metadata_restored` fallback, retract authorization gate, cite generator dispatch) stays intact at the post-fetcher boundary.
- Reuses the throw-path the three accreditation helpers already established (`getAllAccreditedAccounts`, `getAccreditedOrcidsByAccount`, `getAllEverAccreditedOrcidsWithStatus`). Their loud-fail contract becomes meaningful end-to-end rather than aspirational: a thrown error from any of them inside `fetchPaperDetailFromHaf`'s `Promise.all` now propagates through the rewritten catch as `HafQueryError` and the route emits 503.
- Option A would require touching every call site of `fetchPaperDetailFromHaf` (4 route handlers + the metadata-restored fallback construction) plus rewriting the cache-poisoning `return null` defense around `signal.aborted`. The structural change pays for a single new differentiating signal and obscures the existing four cases the helper's `null` already covers (paper missing, non-PEvO meta, walker-abort cache bypass, pool-null startup).

**Files touched:**

- `backend/src/db.ts`: new `HafQueryError` class. Tags HAF-pool query failures route handlers translate to 503. Stores `operation` + uses `Error.cause` for upstream chaining.
- `backend/src/routes/papers.ts`:
  - Import `HafQueryError` from `../db.js`.
  - `fetchPaperDetailFromHaf` catch: re-throw as `new HafQueryError('fetchPaperDetailFromHaf', { cause: err })`. Comment block explains the walker-abort `return null` cache-poisoning defense remains intact (the abort returns before the catch).
  - `fetchEnrichmentFromHaf` catch: re-throw as `new HafQueryError('fetchEnrichmentFromHaf', { cause: err })`. Same shape.
  - Primary `GET /api/papers/:author/:permlink` handler: added a catch between the existing `try` and `finally` — `if (err instanceof HafQueryError)` returns 503 SERVICE_UNAVAILABLE with `details.retriable: true`, message "Paper detail temporarily unavailable. Please retry shortly." Non-HafQueryError errors re-throw (errorHandler → 500, unchanged).
  - `/enrichment` handler: same catch shape. Message "Paper enrichment temporarily unavailable. Please retry shortly."
  - `/retract` handler: catch around the `fetchPaperDetailFromHaf` call. Same 503 envelope, message "Paper detail temporarily unavailable. Please retry shortly." `clearTimeout` lives in `finally` only (idempotent) so the budget timer is cleared on every exit path including the new 503 surface.
  - `/cite` handler: same catch shape as `/retract`.
- `backend/src/accreditation.ts`:
  - `getAccreditedOrcidsByAccount` docstring: dropped the "Distinguishes ... re-thrown so callers can fail loudly instead of caching an empty map on outage" aspirational framing. Replaced with **"Throws on HAF unavailable; the route layer translates to 503 SERVICE_UNAVAILABLE with `details.retriable: true`"** plus explicit reference to `fetchPaperDetailFromHaf` and sibling enrichment/retract/cite handlers so a future reader follows the contract end-to-end.
  - `getAllEverAccreditedOrcidsWithStatus` docstring: same edit. Dropped "Loud-fail parity with `getAccreditedOrcidsByAccount`". Replaced with the same explicit-translation language.
- `backend/tests/routes/papers-haf-error-vs-not-found.test.ts` (new, 8 specs): mocked-pool coverage pinning 503-vs-404 at all four routes. Mock exposes `HafQueryError` so the route's `instanceof` gate matches against the (mocked) `db.js` module identity. Header documents the carve-out justification (clauses a, b, c) per `CLAUDE.md`'s "Running Tests" mock-carve-out.
- `backend/tests/support/argon2-error-mocks.ts` `dbStubFactory`: added `HafQueryError` class to the stub return so typecheck against the full `typeof import('../../src/db.js')` surface passes.

**Sibling-handler coverage status:**

- Primary detail (`GET /:author/:permlink`): 503 mocked-throw + 404 0-rows. Both pass.
- Enrichment (`GET /:author/:permlink/enrichment`): 503 mocked-throw passes. The 404 path needed a different trigger: `fetchEnrichmentFromHaf` always returns a possibly-empty envelope on 0-rows, so an empty-row response never reaches the route's `!cached → 404` check. The only data-missing surface that actually reaches 404 today is `pool === null` (HAF not configured). Test asserts that path. No behavioral change here — documenting pre-existing route shape.
- Retract: 503 mocked-throw + 404 0-rows. Broadcast mock asserted NOT called when HAF throws (defense against premature broadcast).
- Cite: 503 mocked-throw + 404 0-rows.

**Validation:**

- `npm run typecheck` — clean.
- `npm run lint` — clean (2 `@typescript-eslint/no-explicit-any` warnings on `vi.hoisted` are pre-existing pattern in 30+ test files, not introduced).
- Targeted vitest: new file's 8 specs all pass. `tests/routes/retract.test.ts` (9 specs) + `tests/routes/canonical-root-walker.test.ts` + `tests/routes/continuation-author-gate.test.ts` (81 specs total across walker-related) still pass.
- Pre-existing real-HAF flake: `tests/routes/cite.test.ts > "returns citation in all formats when paper exists"` returns 503 instead of 200 under slow testnet HAF (walker-budget trips). Reproduces on `main` (verified via `git stash` of my changes), NOT introduced here. The existing `papers.test.ts` works around the same flake by bumping `hafWalkerWallClockMs` to 60s; `cite.test.ts` doesn't have that bump.

**Acceptance vs items:**

- (1) HAF-outage → 503 + `details.retriable: true` at all four handlers: **landed**.
- (2) Data-not-found → 404 unchanged: **landed** (with enrichment caveat above).
- (3) Tests for both 503 + 404 + sibling coverage: **landed** (8 specs total).
- (4) **[TODO Architect]** — update `agents/docs/api-contracts/papers.md`: add 503 SERVICE_UNAVAILABLE entry to:
  - `GET /api/papers/:author/:permlink`
  - `GET /api/papers/:author/:permlink/enrichment`
  - `POST /api/papers/:author/:permlink/retract`
  - `GET /api/papers/:author/:permlink/cite`

  Envelope: `{ status: "error", error: { code: "SERVICE_UNAVAILABLE", message: <string>, details: { retriable: true } } }`. Trigger: HAF outage (pg pool exhaustion, statement_timeout, network failure). Land at archive.
- (5) Helper docstring honesty: **landed** in `accreditation.ts`.

Out-of-scope items (Retry-After header, accreditation-helper CTE refactor, profile/search sibling-route sweep) deferred per task spec.

Commit SHA: pending (this file lands in the same commit).

## Architect re-review (2026-05-20) — HELD PENDING FIXES

`/ce-code-review` ran on round-1 commit `b427a70` with 9 reviewer personas (correctness on Opus; testing, maintainability, project-standards, learnings-researcher, api-contract, reliability, kieran-typescript at Sonnet; adversarial on Opus; `ce-agent-native-reviewer` skipped per project CLAUDE.md). HafQueryError class, fetcher re-throw, 4 route discriminators, accreditation.ts docstring rewrites, and 8 mocked-pool specs all land structurally correctly. Cross-task review with `d6a1eff` (haf-outage-translation-audit round-2, same review session) surfaced the highest-priority finding: the `isRetriableHafError` cause-discriminator that landed in `db.ts` as part of `d6a1eff` is applied to its 4 routes (comments, profile-papers, profile-reviews, single-review) but NOT to the 4 routes touched here.

[TODO Architect] item (4) — `papers.md` 503 enumeration — landed in architect-zone commit `66b213ac` as part of the same review session. Implementer signal's [TODO] is resolved.

### Items to address (bundle into one round-2 commit)

**1. (P1, anchor 100, 6-reviewer cross-corroboration: correctness + maintainability + reliability + adversarial + kieran-typescript + learnings-researcher) `papers.ts` catch arms skip `isRetriableHafError` discrimination — deterministic pg failures emit 503 retriable, inducing SPA retry storm on dead queries.** `backend/src/routes/papers.ts:2694` (primary GET), `:3005` (/enrichment), `:3095` (/retract), `:3275` (/cite). Each site reads `if (err instanceof HafQueryError) { return sendError(res, 503, ..., { retriable: true }) } throw err;` — bare instanceof, no cause-code discrimination. The sibling routes touched by `d6a1eff` (`comments.ts:229`, `profile.ts:447`, `profile.ts:636`, `reviews.ts:159`) all gate on `instanceof HafQueryError && isRetriableHafError(err)`, falling through deterministic pg codes (`42601` syntax, `42501` permission, `22P02` type) to the central 500 handler. A deploy-time SQL bug in `fetchPaperDetailFromHaf` / `fetchEnrichmentFromHaf` throws → wrapped in `HafQueryError` → all 4 routes emit `503 retriable:true` → SPA retry loop hammers the dead query until its cap.

   Fix: import `isRetriableHafError` from `'../db.js'` alongside `HafQueryError`, then change each of the four `if (err instanceof HafQueryError)` guards to `if (err instanceof HafQueryError && isRetriableHafError(err))`. Mirror the comment shape from `reviews.ts:159` so future maintainers know why the conjunction exists.

   **Add deterministic-pg canary coverage:** the existing `papers-haf-error-vs-not-found.test.ts` mocks throw bare `new Error('connection refused')` with no pg `code` field, so `isRetriableHafError` defaults to retriable and the canaries pass either way. Add 4 new specs (one per route) seeding a pg-shaped error with `code: '42601'` and asserting the response is `500 INTERNAL_ERROR` (status 500 + code INTERNAL_ERROR + `details.retriable !== true`), mutation-killing a regression that classifies all `HafQueryError`s as retriable.

**2. (P1, anchor 85, kieran-typescript KT-002) `dbStubFactory` stub missing `isRetriableHafError` — diverges from `typeof import('../../src/db.js')` surface.** `backend/tests/support/argon2-error-mocks.ts` `dbStubFactory`. The stub is typed `() => typeof import('../../src/db.js')`. Production `db.ts` exports `HafQueryError`, `isRetriableHafError`, `getPool`, `isHafConfigured`, `closeHafPool`. The updated `dbStubFactory` (from this task) adds `HafQueryError` but omits `isRetriableHafError`. Any test using `dbStubFactory` that later exercises a route (`reviews`, `comments`, `profile`, OR — post round-2 of THIS task — `papers`) calling `isRetriableHafError(err)` receives `undefined` at runtime and the call throws, silently bypassing the 503 branch.

   Fix: add `isRetriableHafError` to the `dbStubFactory` return object. Match the production helper's behavioral shape (or import the real implementation if the surrounding test mock pattern permits).

**3. (P2, anchor 100, cross-reviewer project-standards + maintainability + learnings-researcher) Task-slug comment anchors in 2 catch-block comments.** `backend/src/routes/papers.ts:1474` (in `fetchPaperDetailFromHaf` catch) and `:2974` (in `fetchEnrichmentFromHaf` catch). Both comments end with `See \`backend-fetch-paper-detail-haf-error-vs-not-found.md\``. CLAUDE.md "Comment anchors" + `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` explicitly prohibit task-slug citations in production/test code (the slug archives into `tasks-archive.md` which trims at 250 lines, becoming a dead pointer). The behavioral framing above each `See` line is already the correct stable anchor; drop the slug citation entirely. Convention-enforcing-fix per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`: the replacement text MUST also not violate any anchor convention.

**4. (P2, anchor 90, cross-reviewer testing + learnings-researcher + api-contract + kieran-typescript) `details.retriable: true` not asserted on walker-abort 503 specs.** `backend/tests/routes/canonical-root-walker.test.ts:591`, `backend/tests/routes/retract.test.ts:370`, `backend/tests/routes/continuation-author-gate.test.ts:1928`. Existing walker-abort 503 specs assert `res.status === 503` only — none inspects `res.body.error.details?.retriable`. A regression dropping the 5th `sendError` arg from `{ retriable: true }` silently passes every existing spec. (This is implementer's own flagged gap from the 94bf294 round-3 signal block; the assertion is one expression per site.) Implementer choice: land in this task's round-2 (touches walker-task test files, but co-located with the canary additions for item 1) OR land in 94bf294 round-4. Architect-recommended: land here so the cross-task review's hold blocks converge.

   Fix: add `expect(res.body.error.details?.retriable).toBe(true);` to each existing walker-abort 503 spec assertion block. ~6 LOC across 3 files.

**5. (P3, anchor 85, maintainability M3) `HafQueryError.operation` field dead — exported public surface with no readers.** `backend/src/db.ts`. The `operation: string` field is declared `public readonly` and exported but nothing in the codebase reads it. Content duplicates `err.message` (which already reads `'HAF query failed: <operation>'`). `Error.cause` earns its place (read by `isRetriableHafError`, walked by pino's serializer). `operation` is YAGNI-prune candidate per project bias.

   Fix: remove the `operation` constructor parameter and field. Adjust the `HafQueryError` instantiations at the 2 fetcher catch sites accordingly (the message construction will need a small refactor to embed the operation name in the message string at construction time, OR keep operation as a constructor argument that ONLY composes the message and is not stored).

**6. (P3, anchor 75, maintainability M4) `/retract` and `/cite` catch arms reuse primary-detail message string verbatim — undermines documented per-route rationale.** `backend/src/routes/papers.ts:3094` (/retract) and `:3274` (/cite). Both emit `"Paper detail temporarily unavailable. Please retry shortly."` — identical to the primary detail GET. The `db.ts` `HafQueryError` docstring's stated rationale for keeping the discriminator per-route is "per-route message control"; for 2 of 4 handlers, that rationale isn't delivered.

   Fix: change `/retract` message to `"Retraction temporarily unavailable. Please retry shortly."` and `/cite` to `"Citation export temporarily unavailable. Please retry shortly."`. ~2 LOC.

**7. (P3, anchor 100, correctness finding #2) Stale mutation-kill comment in `papers-canonical-orcid-resolution.test.ts:178-183`.** Comment still describes the pre-fix path: `query throws → fetchPaperDetailFromHaf returns null → route returns 404`. Actual post-fix path is `query throws → fetchPaperDetailFromHaf throws HafQueryError → route returns 503 SERVICE_UNAVAILABLE`. Pure-comment update; no assertion change required.

### Items dismissed during architect triage

- **(api-contract AC-2 SPA loadPaper UX regression, P2 conf 75)** Filed as a new `ui-paper-detail-retriable-503-handling` task in `tasks/pending/` per cluster triage. Out-of-scope for this backend task; the sibling `ui-haf-outage-503-retry-affordance` task in `tasks/pending/` covers profile.js + threaded-comments.js but explicitly does NOT cover `paper-detail.js`.
- **(adversarial /retract rate-limit burn cascade, P2 conf 80)** Filed as new `backend-retract-rate-limit-haf-503-burn` task in `tasks/pending/` per cluster triage. Cross-route audit (publish, reviews, etc.) included in that task's scope; deliberately not bundled into this round-2 because skipFailed-vs-refund design question is a deliberate threat-model choice.
- **(kieran-typescript KT-003 `as ErrorOptions` cast in HafQueryError constructor, P2 conf 75)** Triaged into the d6a1eff round-3 hold (same `db.ts` file as #5/#7 items there). Not bundled here.
- **(test-only `HafQueryError` and `isRetriableHafError` mock-copy drift)** Acknowledged residual risk across multiple reviewers. Not actionable absent observed real-vs-mock divergence; addressed structurally by the dbStubFactory completeness fix (item 2).
- **(testing T-01 enrichment 404 spec tests pre-existing pool === null path)** Genuine code path, spec is non-vacuous; reviewer self-recommended accept per `feedback_dismiss_preemptive_test_hardening`.

### Architect followups (no implementer action)

- [TODO Architect] item (4) — already landed in architect-zone commit `66b213ac` (papers.md + common.md 503-retriable note refresh). Architect closed this in the same review session.

### Re-review signal

When items 1-7 land in a single round-2 commit, `git mv` this file back to `tasks/review/`. The mv itself is the re-review signal. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only. Items 1+2 are the security/correctness-critical ones; 3+7 are pure-comment rot; 4 is test-assertion additive; 5+6 are mechanical-source refactors.

---

## Backend re-review signal (2026-05-20, round-2 hold-fixes)

All seven round-2 hold items landed in this commit. Scoped vitest 137/137 green; full `npm run typecheck` clean (the pre-existing dbStubFactory failure is now resolved by item 2).

### Item 1 — Cause-discriminated retriable gate at 4 papers.ts catch arms + 4 new deterministic-pg canaries

`backend/src/routes/papers.ts` — added `isRetriableHafError` to the `db.js` import; updated all 4 catch arms (primary GET, /enrichment, /retract, /cite) to gate on `instanceof HafQueryError && isRetriableHafError(err)`. Mirrors the shape already in `comments.ts`, `reviews.ts`, and `profile.ts`. Inline comment explains the threat model (deterministic pg failures must fall through to 500 so SPA retry loop doesn't hammer dead queries).

`backend/tests/routes/papers-haf-error-vs-not-found.test.ts` — added 4 deterministic-pg canaries (one per route) seeding a `code: '42601'` (syntax error) pg-shaped error. Each asserts `status: 500`, `code: 'INTERNAL_ERROR'`, and `details?.retriable !== true`. The /retract canary additionally asserts `broadcastJsonMock` was NOT called. Mutation-kill: a regression to bare `instanceof HafQueryError` (no cause discrimination) emits 503 retriable on these pg-coded errors and fails red on every canary.

The existing bare-Error 503 canaries above (which seed `new Error('connection refused')` with no pg code) continue to pass because the discriminator defaults to retriable when `code` is not a string.

### Item 2 — `isRetriableHafError` added to `dbStubFactory`

`backend/tests/support/argon2-error-mocks.ts` — `dbStubFactory` now exports `isRetriableHafError` matching the production behavioral shape (handles the full `08*` / 57014 / 57P03 / 53300 retriable set already extended by round-3 of `backend-haf-outage-translation-audit-across-routes`). Resolves the pre-existing `tsc --noEmit -p tests/tsconfig.json` failure (`Property 'isRetriableHafError' is missing in type ...`).

### Item 3 — Drop task-slug citations from `papers.ts` catch comments

`backend/src/routes/papers.ts:~1469-1473` (fetchPaperDetailFromHaf catch) and `:~2974-2977` (fetchEnrichmentFromHaf catch) — removed the `See \`backend-fetch-paper-detail-haf-error-vs-not-found.md\`` line from both. Behavioral framing above the dropped citation ("Tag the error class so the route layer can translate to `503 SERVICE_UNAVAILABLE`") is preserved unchanged; the slug is the only rot.

### Item 4 — `details.retriable === true` assertions on walker-abort 503 specs

Three test files updated with one assertion each (after the existing `expect(res.status).toBe(503)`):
- `backend/tests/routes/canonical-root-walker.test.ts` (wall-clock budget canary)
- `backend/tests/routes/retract.test.ts` (/retract wall-clock abort canary)
- `backend/tests/routes/continuation-author-gate.test.ts` (forward walker wall-clock canary)

Each new assertion is `expect(res.body.error.details?.retriable).toBe(true)`. Mutation-kill: a regression dropping the 5th `sendError` argument silently emits a non-retriable 503; the new assertions catch it.

### Item 5 — Drop dead `operation` field from `HafQueryError`

`backend/src/db.ts` — removed `public readonly operation: string;` field and the `this.operation = operation;` assignment. Constructor still takes `operation: string` as an argument; it now composes the message at construction time (`HAF query failed: ${operation}`) but isn't stored as a field. The 8 production instantiation sites (`papers.ts` × 2, `profile.ts` × 4, `reviews.ts`, `comments.ts` × 2) are unchanged — they pass the operation label and the class shape from outside is identical. Added a comment block explaining the "argument-only, not field" choice. Mirrored in the 3 test-only HafQueryError shape copies (`tests/support/argon2-error-mocks.ts`, `tests/routes/papers-haf-error-vs-not-found.test.ts`, `tests/routes/haf-outage-translation-canaries.test.ts`).

### Item 6 — Per-route error messages on /retract and /cite

`backend/src/routes/papers.ts` — /retract message now reads "Retraction temporarily unavailable. Please retry shortly." and /cite reads "Citation export temporarily unavailable. Please retry shortly." Primary GET keeps "Paper detail temporarily unavailable..." and /enrichment keeps "Paper enrichment temporarily unavailable...". Delivers the `HafQueryError` docstring's "per-route message control" rationale that the prior copy-paste messages undermined.

### Item 7 — Stale mutation-kill comment in papers-canonical-orcid-resolution.test.ts

`backend/tests/routes/papers-canonical-orcid-resolution.test.ts:178-183` — comment updated from "fetchPaperDetailFromHaf returns null → route returns 404" to "fetchPaperDetailFromHaf throws HafQueryError → route returns 503 SERVICE_UNAVAILABLE". Pure-comment edit; no assertion change.

### Verification

Scoped vitest (6 files): `papers-haf-error-vs-not-found.test.ts` + `haf-outage-translation-canaries.test.ts` + `canonical-root-walker.test.ts` + `continuation-author-gate.test.ts` + `retract.test.ts` + `papers-canonical-orcid-resolution.test.ts` — 137 specs green.

Broader sweep (reviews + profile + papers + cite + profile-papers-supersession): 40 passed, 1 skipped, 1 pre-existing flake. The flake is `cite.test.ts > returns citation in all formats when paper exists` returning 503 instead of 200 — this is the testnet real-HAF walker-budget trip already documented in this task's round-1 signal block ("`cite.test.ts` doesn't have that bump" referring to `papers.test.ts`'s 60s budget override). The flake fires from the post-try `walkerAbort.signal.aborted` check, NOT from the HafQueryError catch arm this round modified. Verified by inspection: the 503 the test observes is from the walker-budget event, not from my `instanceof HafQueryError && isRetriableHafError(err)` gate (which would emit 503 with the per-route "Citation export..." message; the budget path emits "HAF walker budget exceeded; please retry").

`npm run typecheck`: clean (both src and tests). `npm run lint`: clean for this change (preexisting `seed-phrase.ts` / `author-supersession.ts` warnings unchanged).

