# UI-ISRETRIABLE503-HELPER-ADOPTION-SWEEP — Extract `isRetriable503(err)` helper and replace 17 inline predicates

**Owner:** UI Agent
**Created:** 2026-05-20 (architect, surfaced by `/ce-code-review` triage of `ui-paper-detail-retriable-503-handling` round-1 commit `a99ef990`)
**Priority:** P3 (maintainability / forward-compatibility; no behavioral change)

## Problem

The predicate `err?.code === 'SERVICE_UNAVAILABLE' && err?.details?.retriable === true` is duplicated **17 times across `frontend/src`** (paper-detail.js, profile.js, threaded-comments.js, and adjacent call sites from the HAF-outage-cluster work). `frontend/src/lib/api.js` already documents the HAF-outage envelope as a forward contract via the `ApiError` shape, but does not surface a typed predicate for the retriable-503 check.

Two concrete risks from the duplication:

1. **Forward-incompatibility.** If the backend ever shifts the envelope (e.g., `details.retry_after_ms` instead of `details.retriable: true`, or a new `details.recoverable` flag for a wider class of transient failures), every one of 17 call sites needs grep-and-edit — and inevitably one will be missed.
2. **Grep-ability.** "Show me all retriable-503 consumers" today requires either grepping for the full predicate string (brittle to minor formatting variations) or grepping for the looser `'SERVICE_UNAVAILABLE'` literal (matches non-retriable contexts too). A single helper name (`isRetriable503`) gives one clean grep target.

Adjacent to the in-flight `ui-frontend-retry-timer-guard-sweep` task (which addresses the timer-guard primitive adoption); both share the "wrapping primitive at the helper layer to centralize a convention" shape. Two separate tasks because the blast radii differ — that task touches 4 sites, this one touches 17.

## Goal

Extract a single-purpose predicate helper to `api.js` (co-located with the `ApiError` definition and the envelope docblock) and migrate all 17 inline call sites.

## Acceptance

1. **Helper definition.** Add `export function isRetriable503(err) { return err?.code === 'SERVICE_UNAVAILABLE' && err?.details?.retriable === true; }` (or equivalent) to `frontend/src/lib/api.js`, co-located with the `ApiError` definition / envelope docblock. JSDoc the helper to point at `agents/docs/api-contracts/common.md` § 503 SERVICE_UNAVAILABLE.

2. **Call-site migration.** Run the canonical grep recipe per `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`:

   ```
   grep -rnE "err\??\.code === 'SERVICE_UNAVAILABLE'" frontend/src/
   grep -rn isRetriable503 frontend/src/
   ```

   Replace every match of the first grep with a call to `isRetriable503(err)`. After migration, the first grep should return zero matches outside of `api.js` itself; the second should account for every call site that previously had the inline predicate.

3. **No semantic change.** Each migration is a pure refactor — no policy changes, no severity changes, no error-handling restructure. The migration MUST produce zero changes in vitest output.

4. **Test (minimal).** Add a vitest unit test for `isRetriable503`. At minimum: returns `true` for `{code: 'SERVICE_UNAVAILABLE', details: {retriable: true}}`; returns `false` for `{code: 'SERVICE_UNAVAILABLE', details: {retriable: false}}`, `{code: 'NOT_FOUND', details: {retriable: true}}`, `null`, `undefined`, `{}`, `{code: 'SERVICE_UNAVAILABLE'}` (no details). Tiny test, ~10 cases.

## Out of scope

- Restructuring the `ApiError` class or the envelope-handling code in `api.js`. Helper is additive.
- Centralizing other repeated predicates (e.g., `err?.code === 'NOT_FOUND'` checks). Stay narrow.
- Renaming or refactoring any of the 17 call sites' surrounding code. Pure substitution only.
- Backend envelope changes. This task assumes the current contract is stable.

## Cross-references

- `frontend/src/lib/api.js` — destination for the helper.
- `agents/docs/api-contracts/common.md` — the cross-cutting 503 SERVICE_UNAVAILABLE + `details.retriable` documentation.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — the grep-recipe convention for this kind of migration.
- 17 inline predicates as of 2026-05-20; verify the count at task-start with the grep recipe above.
