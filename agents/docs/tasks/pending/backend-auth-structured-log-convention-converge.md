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
