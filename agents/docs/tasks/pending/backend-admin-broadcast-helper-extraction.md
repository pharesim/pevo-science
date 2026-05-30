# BACKEND-ADMIN-BROADCAST-HELPER-EXTRACTION — duplicate admin-broadcast envelope construction at 5 call sites

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #31 low severity, simplification)
**Priority:** P3

## Problem

Identical envelope construction repeated at 5 admin-broadcast call sites:
- [wot.ts:210-234](backend/src/wot.ts#L210-L234)
- [wot.ts:365-373](backend/src/wot.ts#L365-L373)
- [routes/claims.ts:348-358](backend/src/routes/claims.ts#L348-L358)
- [routes/orcid.ts:866-872](backend/src/routes/orcid.ts#L866-L872)
- [routes/orcid.ts:1067-1071](backend/src/routes/orcid.ts#L1067-L1071)

Shape: `id: appTag, required_auths: [], required_posting_auths: [hiveAdminAccount], json: stringify(payload)` + `PrivateKey.fromString(pevoAdminPostingKey)` + not-configured guard.

`wot.ts` also uses `await import('@hiveio/dhive')` (dynamic) while every other file imports it statically — arbitrary divergence.

## Goal

Extract one `broadcastAdminCustomJson(payload)` helper in [hive.ts](backend/src/hive.ts) next to `broadcastJsonWithTimeout`.

### Suggested approach

- Helper owns the missing-key guard (throw `AdminKeyNotConfiguredError` for per-site response shapes), `PrivateKey.fromString`, and envelope.
- Keep per-site error handling (each route returns its own response shape on broadcast failure).
- Switch `wot.ts` to static `dhive` import.
- `config.hiveAdminAccount` is singular by design — do not introduce a plural authorities array.

## Acceptance

- 5 call sites use the shared helper; envelope construction lives in one place.
- Each call site's response-on-failure shape is preserved (the helper's error is unwrapped per site).
- `wot.ts` no longer uses dynamic dhive import.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Pure simplification; no behavior change for legitimate broadcasts.

## Cross-references

- [backend/src/hive.ts](backend/src/hive.ts) — destination for the helper.
- 5 call sites listed above.
- HAF-query review run `w274tijk0` rank #31.
