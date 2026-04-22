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

---

## Architect decision (2026-04-22): `trust proxy = 1`, document in common.md

**Chosen config:** `app.set('trust proxy', 1)` in `backend/src/app.ts`. Simplify `byIp(req)` to return `req.ip`. Remove manual XFF parsing.

**Rationale.** Production topology is single nginx → Docker backend, so exactly one hop is trustworthy. An explicit CIDR allowlist is overkill for this shape; numeric `1` is Express-idiomatic and reviewable. If a CDN (Cloudflare, Fastly) is added later, `1` bumps to `2` or becomes an explicit CIDR — the follow-up is trivial and scoped.

**Yes, document in `common.md`.** Add a short "Trusted Proxy Chain" subsection under "Rate Limiting" noting: "Per-IP rate-limit keys use the peer IP derived from `req.ip` with `trust proxy = 1`. Production topology assumes exactly one trusted proxy hop (nginx on the host). X-Forwarded-For values from untrusted upstreams are not honored." Architect edits this during re-review; implementer flags via `[TODO Architect]` note in the task.

**Scope clarifications for implementer:**
- Test: supertest request with spoofed `X-Forwarded-For: 1.2.3.4` — in production-like config (`trust proxy = 1`, where supertest injects no peer), `req.ip` is the spoof value (by design: the test simulates an intermediate proxy adding XFF). Dev-like config (no `trust proxy`) returns loopback, ignoring XFF.
- Verify no test regression. Rate-limit tests that set `X-Forwarded-For` to distinguish IPs should still work because `trust proxy = 1` honors the first-in-chain value.
- If any existing `byIp`-style helper exists outside `middleware/rateLimit.ts`, migrate it to `req.ip` too (grep before shipping).
- Acknowledge the IPv6 /64 rotation non-goal explicitly in the task's changelog (attacker with a /64 block still rotates per-request legitimately; closing that requires keying on a broader CIDR or session/account — out of scope).

---

## [TODO Architect] — common.md doc snippet

Add a "Trusted Proxy Chain" subsection under "Rate Limiting" in `agents/docs/api-contracts/common.md` with the architect-specified text:

> Per-IP rate-limit keys use the peer IP derived from `req.ip` with `trust proxy = 1`. Production topology assumes exactly one trusted proxy hop (nginx on the host). X-Forwarded-For values from untrusted upstreams are not honored.

Implementer cannot edit contract files per task boundary; architect owns this on re-review.

## Changelog

- **2026-04-22 (backend implementer):** Implemented architect decision. `app.set('trust proxy', 1)` was already present in `backend/src/app.ts:53` (added by an earlier change); left as-is. Simplified `byIp()` in `backend/src/middleware/rateLimit.ts` to return `req.ip ?? 'unknown'` and removed the manual `x-forwarded-for` header parsing. Grep of `backend/src/**/*.ts` confirms no other sites consume `x-forwarded-for` / `req.headers['x-forwarded-for']` for request-keying (the one remaining `0xff` hit in `routes/ipfs.ts` is an unrelated JPEG magic-byte check). Added two supertest regressions to `backend/tests/middleware/rateLimit.test.ts`: (1) `trust proxy = 1` honors first-in-chain XFF so distinct XFF values get distinct buckets, (2) without `trust proxy`, supertest XFF rotation does NOT create fresh buckets (the spoof-guard property).
- **IPv6 /64 rotation non-goal:** `trust proxy = 1` correctly closes the *header-spoofing* bypass (attacker sending arbitrary `X-Forwarded-For` headers directly to an unproxied backend). It does NOT close the *legitimate-IP-rotation* bypass: an attacker controlling an IPv6 /64 block rotates source IPs per-request at the socket level, and each rotated IP becomes a fresh bucket. Closing that requires keying on a broader IPv6 CIDR (e.g. /64) or on session/account rather than raw peer IP. Out of scope for this task; track separately if it becomes a real threat.
