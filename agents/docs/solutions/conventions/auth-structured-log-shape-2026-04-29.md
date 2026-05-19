---
title: Canonical structured-log shape for backend route emissions
date: 2026-04-29
category: conventions
module: backend
problem_type: convention
component: logging
severity: medium
applies_when:
  - Adding a new structured log emission inside any file under backend/src/routes/
  - Modifying an existing logger.* call in a route handler
  - Writing a test that asserts on route log fields
  - Building or extending an aggregator dashboard or log-grep runbook for backend endpoints
tags:
  - "logging"
  - "structured-logs"
  - "operator-visibility"
  - "authentication"
  - "convention"
---

## Problem

`backend/src/routes/auth.ts` accumulated two structured log shapes that operators had to grep through in parallel:

- **`{ event: '<tag>', email_hash: ... }`** — newer emissions (drain-suppression debug, signup hash log).
- **`{ route: 'auth.<endpoint>', emailKnown: 'known' | 'unknown', err? }`** — older emissions, primarily SMTP-failure catches.

Co-existence in the same file forced operators to know two key names to find every line from one endpoint, made aggregator dashboards keyed on `event` miss SMTP-failure lines (and vice versa), and gave contributors copying from a sibling line essentially a coin-flip on which shape they would propagate.

## Convention

Every structured log emission in `backend/src/routes/{auth,accreditation,custody,signup-verify,settings,orcid}.ts` (and any future route file) uses the canonical merged shape:

```ts
logger.<level>(
  {
    event: '<file>.<endpoint>.<sub_event>',   // canonical aggregator key, snake_case
    route: '<file>.<endpoint>',               // grep-friendly, kebab-case where the endpoint URL is kebab
    email_hash?: hashEmailForLogs(email),     // when correlating per-email; never raw email
    emailKnown?: 'known' | 'unknown',         // when the branch identity matters operationally
    err?: <Error>,                            // when warn/error
    // route-specific fields below
  },
  '<human-readable message>',
);
```

The `<file>` segment is the route file name (snake_case for `event`, kebab-case for `route` when the URL is kebab). Per-file prefixes in use today:

- `backend/src/routes/auth.ts` → `auth.<endpoint>` (event + route)
- `backend/src/routes/accreditation.ts` → `accreditation.<endpoint>`
- `backend/src/routes/custody.ts` → `custody.<endpoint>`
- `backend/src/routes/signup-verify.ts` → `signup_verify.<endpoint>` (event), `signup-verify.<endpoint>` (route)
- `backend/src/routes/settings.ts` → `settings.<endpoint>`
- `backend/src/routes/orcid.ts` → `orcid.<endpoint>`
- `backend/src/routes/admin.ts` → `accreditation.admin.<endpoint>` (this file holds admin-scoped operations on accreditation state — counter reset, future per-token inspect, etc. The `accreditation.admin.` prefix groups them with the rest of the accreditation domain on operator dashboards rather than carving a top-level `admin.` namespace. If a future `admin.ts` ever holds non-accreditation operator surfaces, those would use a different prefix.)

The auth.ts examples below illustrate the shape; the same rules apply to every other file with its own prefix substituted.

### Field rules

- **`event`** is the canonical aggregator discriminator. Format is `auth.<endpoint>.<sub_event>` in snake_case. The endpoint segment uses underscores (e.g., `reset_request`, `resend_verification`) so `event` is valid as a single grep token; the URL form (`reset-request`, `resend-verification`) lives in `route`.
- **`route`** stays for back-compat with existing dashboards and grep runbooks. Format mirrors the URL path: `auth.login`, `auth.reset-request`, `auth.resend-verification`. New emissions add `route` even if no dashboard is currently keyed on it; convergence is uniform-shape.
- **`emailKnown`** is preserved where it appears today (SMTP-failure catches, drain-suppression). Used only when the branch identity is operationally meaningful (timing-oracle audits, sub-branch oracle audits). Do not add it to emissions where the branch is unambiguous from `event`.
- **`email_hash`** is the only correlation identity for emails. Always passes through `hashEmailForLogs` (never raw email — CNPD log-access trust boundary).
- **`err`** carries the underlying Error (or its `.message`). When the log is `warn` or `error`, include it.

### File-level (non-endpoint) emissions

`auth.ts` also emits at startup (`SENTINEL_ARGON2_HASH_PROMISE`-rejection guard) and inside the `burnSentinel` helper called from `auth.ts` AND `custody.ts` AND `signup-verify.ts`. These follow the same shape with `auth.startup.*` / `auth.burn_sentinel.*` discriminators. The `auth.` prefix tags the file the emission lives in, not the route.

`burnSentinel` importer inventory (relevant when a sibling-file refactor rewires call sites — the emission's file-level prefix stays `auth.burn_sentinel.*` regardless of the caller, so operators grepping for `auth.recover.*` / `auth.signup.*` / `custody.*` etc. will NOT match a burn-sentinel failure that fired from those routes). Citations are by branch description rather than line number; line numbers shift with every neighboring edit and re-stale this list immediately. Use `grep -n burnSentinel backend/src/routes/` for the live anchors.

- `backend/src/routes/auth.ts` — `/signup` (multiple sites in the dup-burn path), `/login`, `/reset-request`, `/resend-verification`, `/recover`.
- `backend/src/routes/signup-verify.ts` — 3 call sites: unknown-email branch, non-confirmed branch, ORCID-only-no-password branch.
- `backend/src/routes/custody.ts` — currently zero call sites. A prior `/upgrade` timing-equalization burn was removed in a fresh-auth refactor (see comment block in custody.ts at the prior call site for the rationale). Listed here so a future re-introduction of `burnSentinel` in custody.ts updates this inventory rather than recreating the cross-file attribution gap.

### Existing event values

The convergence sweep (commit landing this convention) renamed existing `event:` values to fit the `auth.<endpoint>.<sub_event>` shape:

- `event: 'reset_request_drain_suppression'` → `event: 'auth.reset_request.drain_suppression'`

Aggregators or runbooks pinned to the old value need a one-line update. The `route: 'auth.reset-request'` field is now also present, providing an alternative grep anchor.

## Why this shape

- **Single canonical aggregator key.** `event` is the snake_case machine-readable discriminator dashboards key on. One key for everything.
- **Back-compat with existing operator habit.** `route` stays in kebab-case mirroring the URL because that's what existing operators grep for.
- **CNPD compliance preserved.** `email_hash` is the only allowed email identity in logs.
- **No special casing.** Every emission in the file follows the same shape, so a contributor copying from a sibling line cannot accidentally pick a non-canonical form.

## Anti-patterns to avoid

- **Mixing shape inside one emission.** Don't write `{ event: 'foo' }` for a new line and `{ route: 'auth.bar' }` for the next; both fields go on every emission.
- **Putting raw email in `email_hash`.** Always go through `hashEmailForLogs(email)`.
- **Adding new top-level fields without thinking.** Route-specific fields are fine, but check whether the existing canonical fields already cover what you need.
- **Renaming `route` to match `event`'s snake_case.** That breaks back-compat with operator runbooks; the kebab/snake split is intentional.

## Scope

This convention covers all backend route files: `auth.ts`, `accreditation.ts`, `custody.ts`, `signup-verify.ts`, `settings.ts`, `orcid.ts` (and any future route file under `backend/src/routes/`). The auth-side convergence landed first (commit `153605c` + round-2 hold-fix `62674b1`); the sibling-file migration followed in commit `54532c2`. Any new emission in any of these files MUST adopt the canonical shape with the appropriate file-level prefix.

Lib-level helpers and other non-route emissions (e.g., `lib/argon2-error-handler.ts`'s `event: 'argon2_abort_summary'`, `lib/broadcast-error.ts`, the cross-file `burnSentinel` helper which lives in auth.ts and emits under `auth.burn_sentinel.*`) follow their own established discriminator patterns. The "prefix tags the file the emission lives in, not the calling route" rule applies to those helpers — see the `burnSentinel` importer inventory above for the canonical example.

## Cross-references

- `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md` — describes the `{ err, route, emailKnown }` shape that this convention subsumes for SMTP-failure catches; the `event` discriminator is now the primary aggregator key for those emissions.
- `agents/docs/ARCHITECTURE.md` Section 5 — the argon2 semaphore's `event: 'argon2_abort_summary'` lives outside `auth.ts` but uses the same `event:` discriminator pattern; auth-side convergence brings the two operator-signal surfaces into shape agreement.
- `agents/docs/solutions/conventions/pino-spy-serializer-ordering-trap-2026-05-06.md` — `err` carries the raw Error so pino's serializer can process it, but pino's `serializers.err` fires at write time and is NOT visible to `vi.spyOn(logger, 'warn').mock.calls` assertions. Tests asserting that `err` payloads do not leak sensitive fields need a logger-wrapper layer that runs the redact policy before the spy intercepts; `serializers.err` alone is transport-only protection.
