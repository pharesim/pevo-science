# BE-RATE-LIMIT-XFF-SPOOF-GUARD — Bind per-IP rate limits to a trusted X-Forwarded-For chain

**Owner:** backend
**Created:** 2026-04-21 (surfaced by SEC-LOGIN-UNKNOWN-USER-TIMING security+adversarial reviews 2026-04-21)
**Priority:** P2

## Context

`backend/src/middleware/rateLimit.ts:69-72` defines `byIp(req)` to derive the rate-limit key:

```ts
export const byIp = (req: Request): string => {
  const xff = req.header('x-forwarded-for');
  return xff ? xff.split(',')[0].trim() : req.ip || 'unknown';
};
```

This trusts the FIRST value in `X-Forwarded-For` verbatim. An attacker setting `X-Forwarded-For: <random-ip>` on every request gets a fresh rate-limit bucket per request. All per-IP limits across `/api/auth/*`, `/api/bridge/*`, and `/api/orcid/*` are bypassable via header rotation.

This is pre-existing, not introduced by any recent commit. It is load-bearing for the SEC-LOGIN-UNKNOWN-USER-TIMING defense-in-depth story (rate limits are the complementary defense layer when timing oracles close partially). The XFF trust gap undermines that layer on every distributed attack.

## Goal

Bind `byIp()` to a trusted-proxy chain:

1. **Production.** nginx is the only proxy in front of the backend (per root CLAUDE.md "Production Deployment"). nginx appends the peer IP to `X-Forwarded-For` and sets `X-Real-IP` to the peer. Configure Express `app.set('trust proxy', 1)` so `req.ip` becomes the right-most trustworthy value. Use `req.ip` as the rate-limit key. Remove the manual XFF parsing.
2. **Local dev.** Docker-compose maps the backend directly to a port; no proxy. `trust proxy` = `loopback` would be safe but may still pick up XFF from `curl -H 'X-Forwarded-For: ...'`. Acceptable for dev; production is what matters.
3. **Test.** supertest injects requests directly. `req.ip` is `::ffff:127.0.0.1` by default. Rate-limit tests that need distinct IPs continue to set `X-Forwarded-For` — but only if `trust proxy` is configured to parse it, which it must be in production. Verify no test regression.

Alternative: keep `byIp` manual but add a `TRUSTED_PROXIES` env var allowlist and reject XFF values not originating from a trusted proxy. More code, no benefit over Express's built-in `trust proxy` setting.

## Non-goals

Rate-limit bypass via IPv6 /64 rotation (attacker with a /64 block rotates source IP legitimately per-request; `trust proxy` doesn't close this). Separate concern, requires keying on a broader CIDR or on session/account.

Changing the rate-limit buckets themselves or their TTLs.

## Acceptance

- `app.set('trust proxy', 1)` (or equivalent) in `backend/src/app.ts`.
- `byIp()` simplified to return `req.ip` (drop manual XFF parsing).
- Test: a supertest request with a spoofed `X-Forwarded-For: 1.2.3.4` header uses `1.2.3.4` as the rate-limit key in production-like config, and uses loopback in dev-like config.
- Test: per-IP limits no longer bypassable via XFF rotation from an untrusted upstream in a production-like config.

## [TODO Architect]

1. Confirm `trust proxy` value. For the current single-nginx setup, `1` (trust one hop) is correct. If a CDN (Cloudflare, Fastly) is added in front later, this becomes `2` or needs an explicit CIDR allowlist.
2. Decide whether to also document the trusted-proxy chain in `agents/docs/api-contracts/common.md` (where rate-limit semantics live).

## [BLOCKED by Architect] (2026-04-22)

Implementation cannot start until the architect confirms the `trust proxy` value for the current topology (likely `1`) and decides whether `common.md` gains a trusted-proxy-chain subsection. Architect `git mv`s back to `pending/` once resolved.
