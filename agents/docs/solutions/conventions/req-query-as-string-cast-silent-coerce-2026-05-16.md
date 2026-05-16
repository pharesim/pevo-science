---
title: "The `req.query.<field> as string` cast is a silent-coerce trap; typeof-narrow inside a validator helper instead"
date: 2026-05-16
category: conventions
module: backend/src/routes + backend/src/types
problem_type: convention
component: route input validation
severity: high
applies_when:
  - "writing or reviewing an Express route handler that reads `req.query.<field>` and passes it to a validator, SQL bind, or branch"
  - "reviewing a diff that contains `req.query.<field> as string` or `req.query.<field> as string | undefined` (any direct `as` cast on a `req.query.*` read)"
  - "adding a new optional or required query-string filter to a list or search route in `backend/src/routes/`"
  - "reviewing a route that calls `String(req.query.<field>)` or interpolates `req.query.<field>` into a string template (`String([...])` silently joins arrays to `'a,b'`)"
  - "refactoring a route that already typeof-narrows one query field but still casts a sibling field (partial-adoption audit gap)"
  - "implementing a new validator helper under `backend/src/types/` for a route-input filter; the typeof-string guard belongs INSIDE the helper, not at the call site only"
  - "auditing existing routes via `grep -rn 'req\\.query\\.[a-zA-Z_]* as ' backend/src/routes/`; every hit is a candidate"
related_components:
  - testing_framework
  - tooling
tags:
  - typescript
  - express
  - req-query
  - type-cast
  - input-validation
  - silent-coerce
  - route-handler
  - discriminated-union-result
---

# The `req.query.<field> as string` cast is a silent-coerce trap

## Context

Express + the `qs` query parser types `req.query.<field>` as `string | string[] | ParsedQs | ParsedQs[] | undefined`. The union exists because the query string is wire-level untrusted input: `?language=en` parses to a string, `?language=en&language=fr` parses to a `string[]`, and `?language[foo]=bar` parses to a nested `ParsedQs` object. The first form is what every implementer mentally models when writing a handler; the other three are what an attacker, a buggy client, or a misbehaving proxy actually sends.

The trap is that TypeScript permits the wide-to-narrow cast `req.query.language as string | undefined` with no compile error and no lint diagnostic. The cast is a lie the type system has been told to accept. Downstream the value is treated as a string: pushed into `filterParams` for a pg bind, stringified into an ILIKE pattern, checked against an enum, gated by truthiness. When the runtime value is actually an array, `pg` serializes it as `'en,fr'` at bind time; when it is a nested object, `String({foo: 'bar'})` produces `'[object Object]'`. The SQL equality never matches a stored row and the route returns silent zero results. An enum ternary falls through to a default branch. None of this surfaces in tests written against the implementer's mental model, because those tests only pass single-string params.

Cumulative PEvO evidence on `/api/search`:

- `BE-DISCIPLINE-LENGTH-CAP` (commit `602214f`, follow-up `36f5570`) closed the trap on `?discipline=` via `validateDisciplineFilter` in `backend/src/types/disciplines.ts`.
- `BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP` (commit `869fea4`, round-2 fix `aea0396`) closed it on `?q=` via `validateSearchQuery` in `backend/src/types/search-filters.ts`.
- `BE-SEARCH-QUERY-PARAM-TYPEOF-NARROW-SWEEP` (commit `a26c9c5` for `?type=`, then `e7a495f` for `?source=` / `?sort=` / `?language=`) closed four more on the same route via type-guards in the same `search-filters.ts` module.

The security review on 2026-05-16 (SEC-001 during the cluster-3 architect `/ce-code-review` pass) found the same anti-pattern still resident on `/api/papers` at `backend/src/routes/papers.ts:477,479,517-519`. Three closes and one outstanding instance, all the same shape, means this is not a one-off authoring error. It is a systematic gap in how new handlers read query params on PEvO's backend.

## Guidance

**Rule: never write `req.query.<field> as string` (or any variant that narrows `req.query.*` via a cast). Read each query field through a typed validator helper that accepts `raw: unknown`.**

The validator helper is the load-bearing primitive. Its signature must accept `unknown` rather than `string | undefined`, because the wider input type is what forces the runtime check the cast was hiding. Inside the helper, the first conditional is always `typeof raw === 'string'`. That branch rejects arrays, objects, numbers, booleans, and `undefined` in one move. Only after that branch passes do you apply field-specific validation (length cap, enum membership, regex, etc.).

The return shape is one of two:

1. **Discriminated-union Result**, `{ ok: true; value: T } | { ok: false; message: string }`, for fields where "absent" and "present-but-invalid" need distinct disposition. The route entry checks `!result.ok` and returns 400 with `result.message`; on `ok: true`, `result.value` is the safely-typed value (possibly `undefined` if absent is valid).
2. **`T | null`**, for the rarer case where absent has its own 400 handled elsewhere and the helper only needs to communicate "valid" or "invalid".

Helpers live in `backend/src/types/<filter>.ts`, sibling-organized by domain. `disciplines.ts` holds the `?discipline=` validator; `search-filters.ts` holds the `?q=` / `?type=` / `?source=` / `?sort=` / `?language=` validators. Co-locating the validator with the type prevents the type definition and the parser from drifting.

For enum-shaped params, pair the validator with a user-defined type guard whose source of truth is a single `as const` array:

```ts
export const SEARCH_SOURCES = ['native', 'bridge'] as const;
export type SearchSource = typeof SEARCH_SOURCES[number];
export function isSearchSource(s: string): s is SearchSource {
  return (SEARCH_SOURCES as readonly string[]).includes(s);
}
```

The route entry then composes the typeof narrow with the guard: `typeof raw === 'string' && isSearchSource(raw) ? raw : <400-reject>`. Repeated params (`raw` is an array) fail the typeof check; non-string values fail it; unknown enum values pass typeof but fail the guard; absent values are handled explicitly with `=== undefined`. Every error class has its own branch and its own 400 with a specific message. Never a silent coercion, never a fall-through to a default.

The audit primitive: `grep -rn 'req\.query\.[a-zA-Z_]* as ' backend/src/routes/` must return zero hits. The cast is the anti-pattern; eliminating the cast is the audit operation.

## Why This Matters

**TypeScript gives the anti-pattern no static signal.** The `as` cast is the language's explicit "trust me, compiler" override; it produces no error, no warning, no lint hit under PEvO's current ruleset. Reviewers reading the diff see a plausible string narrow and a downstream string-typed variable. The bug is invisible at the layer where the rest of the codebase's correctness is enforced.

**Single-string unit tests never fire the bug.** Every implementer who writes `req.query.language as string` writes a test asserting `GET /api/search?language=en` returns the expected results. That test passes. Repeated-param requests (`?language=en&language=fr`) and nested-param requests (`?language[foo]=bar`) are separate error classes and require their own tests. Per `route-level-error-class-coverage-after-helper-extraction-2026-04-29.md`, each error class needs explicit coverage; this convention names the repeated-param and nested-param classes as the ones that systematically slip through. The mutation-killing test vector for this trap is documented separately at `js-coercion-mutation-kill-vector-2026-05-04.md`; that doc covers what tests must assert, the present doc covers what the production code must not do.

**Each individual fix looks scoped, hiding the systematic nature.** When `?discipline=` was closed, it looked like a discipline-validation hardening. When `?q=` was closed, it looked like an ILIKE-injection hardening. When `?type=`, `?source=`, `?sort=`, `?language=` were closed in one sweep, the systematic framing finally surfaced; but `/api/papers` was not in scope of that sweep and retained the same pattern. Without a convention doc, the pattern resurfaces on every new route handler that destructures `req.query.<field>` directly. With the convention codified, any code review picks up the cast on first read.

**The failure mode at runtime is silent.** A 500 with a stack trace would be self-correcting; the error would be observed and fixed. The actual failure is "the route returns zero results to an otherwise-valid query, the user sees an empty list and assumes their query was right but unmatched, no log line, no metric blip, no alarm." For a search route this degrades UX; for an authorization-touching filter it could leak access decisions to attacker-controlled coercion. The blast radius is bounded by what the field gates, not by the field's superficial shape.

## When to Apply

- **Authoring any new HTTP route handler in `backend/src/routes/*.ts` that reads from `req.query`.** Before writing the handler, identify which validator helper(s) the params route through. If the appropriate helper doesn't exist, write it under `backend/src/types/<filter>.ts` first; if it exists, import it. Do not write `req.query.<field> as string` as a stub "to be hardened later"; the stub is the bug.
- **Auditing existing route handlers for the same anti-pattern.** Run `grep -rn 'req\.query\.[a-zA-Z_]* as ' backend/src/routes/` as a sweep primitive. Every hit is a candidate. The known-remaining instance at `backend/src/routes/papers.ts:477,479,517-519` is the current sweep target.
- **Code-reviewing PRs that destructure `req.query.<field>` directly without a validator helper.** Even if the rest of the diff is correct, the direct destructure plants the trap for the next reader. Block the PR with a pointer to this convention and the appropriate sibling helper.
- **Refactoring an existing validator helper.** If you change the helper's defaulting semantics or return shape, re-grade every existing call site of the helper, not just the diff-touched ones.

Does NOT apply to typed-body reads via Zod / express-validator at `req.body`, which run their own runtime validation; the trap is specific to `req.query` because of the `qs` library's polymorphic parse output. Does NOT apply to internal callers passing typed values to helpers; the trap is at the HTTP perimeter where the input is untrusted.

## Examples

### Before (anti-pattern, currently resident on `/api/papers`)

```ts
// backend/src/routes/papers.ts:477-519 (current, BUG)
const language = req.query.language as string | undefined;
const source = req.query.source as string | undefined;

// Later in the handler:
if (language) {
  filterParams.push(language);
  filterClauses.push(`json_metadata ->> 'language' = $${filterParams.length}`);
}
```

Failure trace for `?language=en&language=fr`:

1. `qs` parses `req.query.language` to `['en', 'fr']` (an array).
2. The `as string | undefined` cast is accepted at compile-time; `language` is typed `string | undefined` but holds a `string[]` at runtime.
3. `if (language)` evaluates `true` (non-empty arrays are truthy).
4. `filterParams.push(['en', 'fr'])` pushes the array; `pg` serializes it as the string `'en,fr'` at bind site.
5. The SQL `json_metadata ->> 'language' = 'en,fr'` matches no stored row.
6. The endpoint returns `{ papers: [], total: 0 }`. No error, no log, no alarm.

### After (canonical fix, Result-shape validator)

```ts
// backend/src/types/search-filters.ts
export type LanguageFilterResult =
  | { ok: true; value: string | undefined }
  | { ok: false; message: string };

export function parseLanguageFilter(raw: unknown): LanguageFilterResult {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw === 'string') return { ok: true, value: raw };
  return {
    ok: false,
    message: 'Invalid language. Must be a single value (repeated params not allowed)',
  };
}
```

```ts
// backend/src/routes/search.ts (route entry)
const languageResult = parseLanguageFilter(req.query.language);
if (!languageResult.ok) {
  return sendError(res, 400, 'BAD_REQUEST', languageResult.message);
}
const language = languageResult.value; // safely `string | undefined`
```

### After (enum form, typeof narrow + user-defined type guard)

```ts
// backend/src/types/search-filters.ts
export const SEARCH_SOURCES = ['native', 'bridge'] as const;
export type SearchSource = typeof SEARCH_SOURCES[number];

export function isSearchSource(s: string): s is SearchSource {
  return (SEARCH_SOURCES as readonly string[]).includes(s);
}
```

```ts
// backend/src/routes/search.ts
const rawSource = req.query.source;
let source: SearchSource | undefined;
if (rawSource === undefined) {
  source = undefined;
} else if (typeof rawSource === 'string' && isSearchSource(rawSource)) {
  source = rawSource;
} else {
  return sendError(
    res,
    400,
    'BAD_REQUEST',
    `Invalid source. Must be one of: ${SEARCH_SOURCES.join(', ')}`,
  );
}
```

The four runtime input classes now route to four distinct outcomes: absent → `undefined`; single valid → typed enum value; single invalid enum → 400 with the allowed-values message; array / nested object / non-string → 400 with the same message. No silent coercion path exists.

### Sweep recipe for an existing-route audit

```bash
# Step 1: find every cast on req.query in route handlers
grep -rn 'req\.query\.[a-zA-Z_]* as ' backend/src/routes/

# Step 2: for each hit, identify the field and check whether a sibling validator
# already exists under backend/src/types/<filter>.ts. If yes, replace the cast
# with a helper call. If no, write the helper first, then replace.

# Step 3: add (or extend) a route-level test that issues a repeated-param request
# and asserts the 400 response. The single-string test alone is not coverage.
```

## Related conventions

- `js-coercion-mutation-kill-vector-2026-05-04.md` — test-side dual; covers how to write mutation-kill vectors that exercise the validator helper this convention prescribes. The two together cover the CODE-side authoring rule (this doc) and the TEST-side assertion shape (sibling doc).
- `route-level-error-class-coverage-after-helper-extraction-2026-04-29.md` — when the validator helper is extracted, both route-level (400 BAD_REQUEST behavior on each rejection class) and helper-level (every input shape: missing, empty string, valid, invalid, `string[]`) coverage are required; the helper's unit tests do not absolve route-level integration coverage.
- `correlated-options-discriminated-union-2026-04-28.md` — the Result-shape `{ ok: true; value: T } | { ok: false; message: string }` return type used by the canonical fix is an application of the broader discriminated-union pattern documented there. Callers cannot omit error-handling silently.
- `discipline-interface-tsc-perimeter-omission-2026-05-11.md` — `as string` is the dual hazard to discipline-interface bypass: instead of a typo silently compiling because the consumer is outside the tsc perimeter, a `string[]` silently compiles because the cast tells tsc to stop checking. Both undermine compile-time discipline at the HTTP perimeter.
