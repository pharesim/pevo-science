# BE-LOG-SHAPE-CONVERGENCE-SIBLING-FILES — Migrate non-auth.ts route emissions onto the canonical structured-log shape

**Owner:** backend
**Created:** 2026-05-04 (architect, surfaced by `/ce-code-review` of `backend-auth-structured-log-convention-converge.md` round-1 — adversarial ADV-6 conf 70 + multi-reviewer corroboration)
**Priority:** P3

## Context

The auth-side convergence task (`backend-auth-structured-log-convention-converge`, commit `153605c`) reshaped all 18 logger.* emissions in `backend/src/routes/auth.ts` onto the canonical shape:

```ts
logger.<level>(
  {
    event: 'auth.<endpoint>.<sub_event>',
    route: 'auth.<endpoint>',
    email_hash?: hashEmailForLogs(email),
    emailKnown?: 'known' | 'unknown',
    err?: <Error>,
  },
  '<human-readable message>',
);
```

That task explicitly listed sibling-file migration as a non-goal: *"Migrating non-`auth.ts` routes onto the canonical shape. Scope is the auth surface; cross-cutting cleanup of accreditation/custody/settings/etc. is a follow-up if the auth-side convergence proves the shape."* The auth-side convergence is now archive-ready (held-pending-fixes for finishing touches but the shape itself has proved out); the follow-up condition is met.

## Goal

Migrate structured log emissions in non-auth.ts route files onto the canonical shape. The same merged shape applies, with the file-level prefix substituted for `auth.`:

- `backend/src/routes/accreditation.ts` → `accreditation.<endpoint>.<sub_event>` / `accreditation.<endpoint>`
- `backend/src/routes/custody.ts` → `custody.<endpoint>.<sub_event>` / `custody.<endpoint>`
- `backend/src/routes/signup-verify.ts` → `signup_verify.<endpoint>.<sub_event>` / `signup-verify.<endpoint>` (note: snake_case `signup_verify` for `event`, kebab-case `signup-verify` for `route`, mirroring the URL path)
- `backend/src/routes/settings.ts` → `settings.<endpoint>.<sub_event>` / `settings.<endpoint>`
- `backend/src/routes/orcid.ts` → `orcid.<endpoint>.<sub_event>` / `orcid.<endpoint>`
- Any other route file with structured log emissions in legacy shapes (run a grep before deciding the inventory)

## Acceptance

1. **Every structured log emission in the listed files** uses the canonical shape with the appropriate file-level prefix.
2. **CNPD compliance preserved:** any `email:` plaintext field migrates to `email_hash: hashEmailForLogs(...)` (or `safeHashEmailForLogs(...)` for nullable inputs, depending on the outcome of `backend-log-pii-email-hash` round-1 hold-fix item 1).
3. **No regression on operator-relevant log lines** — every key currently grepped/dashboarded by operators (`route`, `emailKnown`, `event`, `err`) remains present and named the same. Convergence is additive, not breaking.
4. **Spy-assertion coverage on operationally-critical emissions** per `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`. Pragmatic scope: outer-catch `*.failed` events, broadcast-failure / token-write-failure paths, any emission that drives an operator dashboard. Skip startup-time and helper-internal emissions where driving the path is structurally hard.
5. **`burnSentinel` helper emissions stay `auth.burn_sentinel.*`** — the helper lives in `auth.ts`; the convention's "prefix tags the file the emission lives in" rule means the auth.* prefix is correct even when called from custody.ts / signup-verify.ts. The hold-block on `backend-auth-structured-log-convention-converge` covers the inline-comment + convention-doc updates clarifying this for cross-file readers.
6. **Convention doc updates** at `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md` — narrow the title from "auth-route emissions" to whatever the realized scope is, OR file a sibling convention doc if the shape rules diverge for non-auth files. Architect's call when reviewing the migration.
7. **`npx tsc --noEmit` clean. `npm run lint` clean. Full backend vitest passes.**

## Non-goals

- Migrating non-route library code (e.g., `lib/argon2-error-handler.ts`, `lib/broadcast-error.ts`) — those have their own shape conventions (`event: 'argon2_abort_summary'` etc., per ARCHITECTURE.md Section 5). Scope is route-handler emissions.
- Adding new fields beyond the canonical set.
- A typed discriminated union for `event` strings — explicit-string approach is the convention's accepted enforcement model. Single-spec spy assertions kill the typo class without compile-time coupling.

## Suggested approach

1. Inventory: `rg -n 'logger\.(error|warn|info|debug)' backend/src/routes/` minus `auth.ts`. Group by file. The `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` convention applies — grep is the audit, not eyeballs.
2. For each file, choose the file-level prefix (per the list in Goal above).
3. Rewrite each emission in canonical shape.
4. Add spy assertions per acceptance #4 — likely 2-4 per file.
5. Run targeted vitest on the affected files plus full backend vitest as final check.

## Related

- `backend-auth-structured-log-convention-converge.md` (cluster A, 2026-05-04) — the auth-side proof.
- `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md` — the convention doc defining the shape.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — apply during the audit step.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — apply during the spy-assertion design.
