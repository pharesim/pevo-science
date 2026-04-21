# BE-ORCID-ID-FORMAT-VALIDATION — Regex-validate `orcidId` at OAuth token-exchange boundary

**Owner:** backend
**Created:** 2026-04-21 (surfaced by BE-ORCID-TOCTOU-LOCK security review 2026-04-21)
**Priority:** P3

## Context

`backend/src/routes/orcid.ts` receives `orcidId` from the ORCID OAuth token-exchange response and interpolates it into multiple trust-sensitive downstream surfaces without format validation:

- Redis key builders: `orcidBindingCacheKey(orcidId)`, `orcidBindingLockKey(orcidId)`, `${config.appTag}:orcid_state:${state}` (state is separate; orcidId only in the binding variants).
- ORCID public API URL path in `countExternalWorks`: `https://pub.orcid.org/v3.0/${orcidId}/works`.
- JSON payloads broadcast on-chain as `custom_json` metadata.

Validation today: a truthiness check (`if (!orcidId) return ...`) at the entry of `handleAccredit` / `handleLink` / `handleLogin`. No format guard.

**Exploitability is bounded** — the value comes from ORCID's own token-exchange endpoint, which ORCID controls. A malicious or MITM'd ORCID response could inject `../../oauth/token` or colons or control characters, but:
- Redis: `ioredis` sends keys as binary-safe RESP bulk strings, so colons don't create cross-key namespace collisions with structurally different keys.
- ORCID API path: the fetch is pinned to `pub.orcid.org`, so path-traversal stays on that host (no SSRF to internal services).
- On-chain metadata: the payload is part of an admin-signed op; malformed orcid values end up in chain state but don't escalate privileges.

So this is defense-in-depth, not a live exploit. Worth closing because the next caller that joins the surface (say, an admin UI that displays orcid_id in an HTML context) may not have the same bounded trust.

## Goal

Add a single regex validation immediately after the truthiness check at each entry point (handleAccredit, handleLink, handleLogin, and the /start initiation):

```ts
const ORCID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;
if (!ORCID_RE.test(orcidId)) {
  return sendError(res, 400, 'BAD_REQUEST', 'Invalid ORCID iD format');
}
```

Place the regex as a module-level `const` at the top of `orcid.ts` so all handlers share it.

**Test:** one spec that injects an invalid-format orcid_id (e.g. `'0000-0000-0000-0001/../../oauth/token'`) and asserts 400 BAD_REQUEST before any Redis / Hive / HAF call fires.

## Non-goals

Validating the ORCID checksum (last digit is a checksum of the preceding 15; ORCID validates this itself). Our guard is format-level.

Validating at `/start` initiation where `orcidId` is not yet known.

## Acceptance

- Single regex constant at module top.
- Guard at each handler entry + the OAuth callback dispatch.
- One test per handler asserting 400 on malformed orcid_id.
- No Redis / Hive / HAF calls fire on the rejection path.

## [TODO Architect]

None — self-contained defense-in-depth fix.
