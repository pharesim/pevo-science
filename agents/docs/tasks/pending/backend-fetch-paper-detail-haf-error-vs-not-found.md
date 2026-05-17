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
