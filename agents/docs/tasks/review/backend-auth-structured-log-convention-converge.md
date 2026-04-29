# BACKEND-AUTH-STRUCTURED-LOG-CONVENTION-CONVERGE — Converge auth-route structured log shapes onto one canonical discriminator pattern

**Owner:** backend
**Created:** 2026-04-29 (architect, surfaced by cluster B re-review of `backend-reset-request-shutdown-enumeration.md` round-1 P3 emission)
**Priority:** P3

## Context

`backend/src/routes/auth.ts` currently emits structured log lines under at least two coexisting shapes:

- **`{ event: '<machine-readable-tag>', email_hash: '<hashed>' }`** shape — used by the new drain-suppression debug log at `auth.ts:885` (`event: 'reset_request_drain_suppression'`) and the signup hash log at `auth.ts:534`.
- **`{ route: 'auth.<endpoint>', emailKnown: 'known' | 'unknown', err?: <Error> }`** shape — used by the SMTP-failure logs at `auth.ts:665, 669, 936, 942` and most pre-existing structured emissions on the auth surface.

Both shapes are reasonable in isolation. The problem is co-existence in the same file: operators grepping/aggregating reset-request log lines have to know two key names (`route` for SMTP failures, `event` for drain suppression) to find everything from one endpoint; aggregator dashboards keying on `event` miss the SMTP-failure lines (and vice versa); a contributor copying from a sibling line picks up one shape or the other essentially at random.

The cluster B round-1 hold-fix on `backend-reset-request-shutdown-enumeration.md` deepened the split by adding a third instance of the `event:` shape. The architect re-review surfaced this as a convergence finding rather than a hold-block item because the right fix is project-wide convergence, not a local edit at one site (which would just deepen a third-shape split).

## Goal

Pick one canonical structured-log shape for the auth surface and migrate every existing emission onto it. The choice has to balance machine-readability (aggregator keys) against operator-readability (humans tailing logs).

## Suggested shape (pre-decision; implementer picks final)

A merged shape that subsumes both existing forms:

```ts
logger.<level>(
  {
    event: 'auth.<endpoint>.<sub-event>',     // discriminator, snake_case
    route: 'auth.<endpoint>',                 // grep-friendly, redundant with event prefix but kept for back-compat
    email_hash?: hashEmailForLogs(email),     // when correlating per-email; never raw email
    emailKnown?: 'known' | 'unknown',         // when the branch identity matters and isn't otherwise inferable
    err?: <Error>,                            // when warn/error
    // route-specific fields below
  },
  '<human-readable message>'
);
```

`event` becomes the canonical aggregator key; `route` stays as a grep convenience that mirrors the event prefix. Existing dashboards keyed on `route` keep working; new dashboards key on `event`. CNPD compliance is preserved by `email_hash` (never `email` plaintext). The `emailKnown` field is retained where the branch identity is operationally meaningful (SMTP-failure-mode oracles, log-correlation between sibling endpoints).

Implementer may push back if a different shape better fits the team's actual log pipeline (Loki, ELK, CloudWatch Insights, etc.).

## Acceptance

1. **Every structured log emission in `backend/src/routes/auth.ts`** uses the canonical shape decided above.
2. **No regression on operator-relevant log lines** — every key currently grepped/dashboarded by operators (`route`, `emailKnown`, `event`, `err`) remains present and named the same. Convergence is additive, not breaking.
3. **No raw email in logs** — every email-correlated emission goes through `hashEmailForLogs` per the existing CNPD convention.
4. **A new entry under `agents/docs/solutions/conventions/`** captures the canonical shape so a future contributor picks it up without re-deriving the choice. Suggested filename: `auth-structured-log-shape-2026-04-XX.md`. Cross-link from any sibling solution doc that mentions log-shape (e.g., `timing-equalization-smtp-failure-mode-oracle-2026-04-22.md`).
5. **`npx tsc --noEmit` clean. `npm run lint` clean. Full backend vitest passes** — log-shape changes can break tests that match on specific keys.

## Non-goals

- Migrating non-`auth.ts` routes onto the canonical shape. Scope is the auth surface; cross-cutting cleanup of accreditation/custody/settings/etc. is a follow-up if the auth-side convergence proves the shape.
- Capturing this as a `/ce-compound`-style learning. Capture is acceptance line 4; `/ce-compound` is for retrospective learnings about non-obvious solutions, not for documenting newly-decided conventions.
- Adding a `cnpd-pii-log-hashing` convention covering `hashEmailForLogs` semantics (unkeyed truncated SHA-256, log-access trust boundary). That's a separate `/ce-compound` follow-up flagged independently by the cluster B learnings researcher; cross-link it if it lands first.

## Related

- `backend-reset-request-shutdown-enumeration.md` (round-1) — the new `event: 'reset_request_drain_suppression'` log that triggered this surfacing.
- `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md` — prescribes the `{ err, route, emailKnown }` shape for SMTP-failure catches; will need a one-line note that the shape is being subsumed by a unified event-discriminator convention.
- `agents/docs/solutions/conventions/cnpd-pii-log-hashing-*.md` (future) — once written, cross-link from this task's solution doc.

## Notes

The `event` discriminator approach is what `argon2_abort_summary` (semaphore-side) already uses (`event: 'argon2_abort_summary'` per `ARCHITECTURE.md` Section 5). Auth-side convergence on the same shape brings the two operator-signal surfaces into agreement.

---

## Backend re-review signal (2026-04-29, working tree)

Convergence sweep landed. All 18 structured log emissions in `backend/src/routes/auth.ts` use the canonical merged shape; the new convention is captured under `agents/docs/solutions/conventions/`.

### Canonical shape adopted

```ts
logger.<level>(
  {
    event: 'auth.<endpoint>.<sub_event>',     // canonical aggregator key, snake_case
    route: 'auth.<endpoint>',                 // grep-friendly, kebab-case where the URL is kebab
    email_hash?: hashEmailForLogs(email),     // when correlating per-email; never raw email
    emailKnown?: 'known' | 'unknown',         // when branch identity matters operationally
    err?: <Error>,                            // when warn/error
  },
  '<human-readable message>',
);
```

`event` is snake_case (single grep token, valid as an aggregator field name). `route` stays kebab where the URL path is kebab (`auth.reset-request`, `auth.resend-verification`) — back-compat with existing dashboards. The `auth.` prefix is uniform across file-level (startup, helper) and route-level emissions; the second segment is the endpoint or file-level component.

### Emission inventory (18 sites)

- **Startup (1):** `auth.startup.sentinel_hash_failed` (line 171, error).
- **`burnSentinel` helper (1):** `auth.burn_sentinel.failed` (line 245, warn). Helper is called from both `auth.ts` and `custody.ts`; the file-level prefix tags the file the emission lives in, not the route.
- **/signup (5):** `auth.signup.dup_burn_failed` (lines 425 + 437, warn — both dup-burn `.catch` blocks) · `auth.signup.smtp_send_failed` (line 539, error) · `auth.signup.smtp_not_configured` (line 548, error — preserves `email_hash`) · `auth.signup.failed` (line 566, error — top-level catch).
- **/resend-verification (3):** `auth.resend_verification.smtp_send_failed` (line 687, warn — preserves `emailKnown: 'known'`) · `auth.resend_verification.smtp_not_configured` (line 699, warn — preserves `emailKnown: 'known'`) · `auth.resend_verification.failed` (line 712, error — top-level catch).
- **/login (1):** `auth.login.failed` (line 860, error — top-level catch).
- **/reset-request (4):** `auth.reset_request.drain_suppression` (line 930, debug — preserves `email_hash`, gains `emailKnown: 'unknown'` for sub-branch oracle correlation) · `auth.reset_request.smtp_send_failed` (line 987, warn — preserves `emailKnown: 'known'`) · `auth.reset_request.smtp_not_configured` (line 1001, warn — preserves `emailKnown: 'known'`) · `auth.reset_request.failed` (line 1014, error — top-level catch).
- **/reset (1):** `auth.reset.failed` (line 1091, error — top-level catch).
- **/recover (2):** `auth.recover.memo_decrypt_failed` (line 1185, error — preserves `username` field) · `auth.recover.failed` (line 1293, error — top-level catch).

### Test impact

`backend/tests/routes/auth-reset-request-shutdown.test.ts` was the only test file pinned to a structured log field (the `event: 'reset_request_drain_suppression'` assertion added in `backend-reset-request-shutdown-enumeration.md` round-2). The assertion is updated to match the new canonical shape:

- `event: 'auth.reset_request.drain_suppression'` (was `reset_request_drain_suppression`)
- Adds `route: 'auth.reset-request'` and `emailKnown: 'unknown'` to the expected object — both are now present in the production emission and the assertion verifies them, so a future drift on those fields would also fail.

No other test files matched any of the modified field shapes (verified via grep on the test tree before editing).

### New convention doc

`agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md` — captures the canonical shape, field rules, file-level emission convention, the `reset_request_drain_suppression` rename, and anti-patterns. Cross-linked from `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md` (the doc that prescribed the older `{ err, route, emailKnown }` shape this convention subsumes for SMTP-failure catches).

### Verification

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean (only pre-existing seed-phrase.ts warnings).
- Targeted vitest on the auth route tests (auth, auth-argon-error-translation, auth-signup-argon-error-translation, auth-signup-dup-saturated, auth-reset-request-shutdown, auth-concurrency, auth-recover, auth-resume-signup): 52 tests passed across 6 files (3 of the 8 I tried were not present in the tree; the 6 that ran are the auth-route surface).
- Full backend vitest: 640 passed | 5 skipped, with 1 isolated flake on `tests/routes/reputation-lifecycle.test.ts` ("re-throws permanent errors (TypeError) so post-broadcast discrimination surfaces 502") that does NOT involve `auth.ts`. Re-running the same test file in isolation produces 10/10 pass; running on main without my changes produces 10/10 pass. The flake reproduces only under full-suite parallel load against real Postgres/Redis (the suite contains many ECONNRESET / ETIMEDOUT lines from concurrent HAF queries during the run). Surfacing it here so the architect re-review pass can verify; it is not introduced by this convergence sweep.
