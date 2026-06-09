---
title: "E2E stub for a dual-actor external provider: prefer backend-only-real fidelity, and hand-roll when the response shape is non-standard"
date: 2026-06-09
category: conventions
module: e2e-harness/orcid-stub
problem_type: convention
component: testing_framework
severity: medium
related_components:
  - authentication
  - development_workflow
  - tooling
applies_when:
  - "building an E2E stub for an external HTTP/OAuth provider that BOTH the browser and the backend call in one flow"
  - "wiring Playwright + Docker against a provider whose response shape is non-RFC-6749"
  - "a base URL resolves differently from the host-browser vs the in-container backend on WSL2/Linux-Docker"
  - "deciding hand-roll vs off-the-shelf mock OAuth2 server for a test harness"
tags:
  - e2e
  - playwright
  - docker-compose
  - oauth
  - orcid
  - test-stub
  - wsl2
  - build-vs-buy
---

# E2E stub for a dual-actor external provider: prefer backend-only-real fidelity, and hand-roll when the response shape is non-standard

## Context

PEvO's ORCID integration is a two-actor OAuth flow: the browser navigates to the provider's `/oauth/authorize` endpoint, and the backend's `/callback` handler (`backend/src/routes/orcid.ts`) does a server-to-server `POST /oauth/token` exchange. Both actors talk to the same external provider. The security-load-bearing half lives entirely on the backend: the token exchange and the subsequent fresh-auth proof mint. The browser's only job in the OAuth hop is to carry an authorization `code` and `state` back to `${baseURL}/orcid/callback`.

Standing this up for E2E (which reuses the dev backend via the swap-in-place `docker-compose.test.override.yml`, not a parallel instance) surfaces two design questions that are easy to get wrong:

1. **Topology/fidelity** — where does the stub live, who is pointed at it, and which hops are real vs. synthesized?
2. **Tooling** — hand-roll the stub, or adopt an off-the-shelf mock OAuth2 server?

The trap on (1) is assuming there is a single base URL that resolves identically from both the host-resident Playwright browser and the in-container backend. On WSL2/Linux-Docker there is not: the browser reaches published ports at `127.0.0.1:<port>`, while a backend container reaches its compose siblings via service-DNS (`orcid-stub:8099`) and the host only via `host.docker.internal` / the gateway IP. No hostname satisfies both.

The trap on (2) is assuming OAuth providers are interchangeable enough that a generic mock fits. PEvO's ORCID client reads identity claims from a **non-standard** response shape, so a spec-compliant mock is the wrong fit.

## Guidance

### Part 1 — Prefer "backend-only-real" fidelity for a dual-actor provider stub

Point ONLY the backend at the compose-network stub via Docker service-DNS, with no host port published:

```yaml
# docker-compose.test.override.yml — backend service
environment:
  ORCID_BASE_URL: http://orcid-stub:8099   # service-DNS, reachable from the backend only
  ORCID_CLIENT_ID: e2e-stub-client          # any non-empty value; /callback short-circuits
  ORCID_CLIENT_SECRET: e2e-stub-secret      # with "ORCID integration is not configured" if blank
```

The stub publishes no host port (`expose: ["8099"]`, not `ports:`) because no browser ever navigates to it. Fulfill the browser-followed `/oauth/authorize` hop in-page with Playwright `route.fulfill`: the spec intercepts the authorize URL the backend's `/start` handler returns, reads the real `state` out of it, and 302s the browser to a host-resolvable URL:

```js
// In the spec: synthesize only the contentless authorize redirect.
await page.route('**/oauth/authorize*', async (route) => {
  const url = new URL(route.request().url());
  const state = url.searchParams.get('state');          // real state minted by /start
  const seededId = '0000-0002-1825-0097';               // per-run-unique; also seeded into accounts.orcid
  await route.fulfill({
    status: 302,
    headers: { location: `${baseURL}/orcid/callback?code=${seededId}&state=${state}` },
  });
});
```

The real path stays real: the backend's `/callback` does a genuine `POST /oauth/token` against the stub and mints a real fresh-auth proof. Only the empty authorize redirect, which carries no security-relevant data, is synthesized.

Do NOT host-publish the stub and share one base URL. The browser would be told (in the authorize `redirect_url` the backend builds from `config.orcidBaseUrl`) to navigate to an `orcid-stub` / `host.docker.internal` hostname it cannot resolve. And do NOT split the authorize-base (browser) from the token-base (backend): `config.orcidBaseUrl` is a single value feeding both the `/start` authorize-URL builder and the `/callback` token exchange, so splitting them would require a backend code change purely for tests.

### Part 2 — Hand-roll the stub when the provider's response shape is non-standard

PEvO's ORCID client reads `orcid` and `name` as **top-level fields** off the `/oauth/token` JSON. There is no `/userinfo` call and no `id_token` JWT decode. `orcid` is required and is validated against `/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/`. A ~20-line `node:20-alpine` inline server returns exactly that shape:

```yaml
orcid-stub:
  image: node:20-alpine
  expose: ["8099"]            # no host port — backend-only
  command:
    - node
    - -e
    - |
      const http = require('http');
      http.createServer((req, res) => {
        if (req.method === 'POST' && req.url.startsWith('/oauth/token')) {
          let body = '';
          req.on('data', (c) => { body += c; });
          req.on('end', () => {
            const code = new URLSearchParams(body).get('code') || '';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            // Reflect the form `code` back as `orcid` -> spec controls the per-run iD.
            res.end(JSON.stringify({ orcid: code, name: 'E2E Stub Scientist', access_token: 'e2e-stub-access-token' }));
          });
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      }).listen(8099, () => console.log('orcid-stub listening on 8099'));
```

Two details are load-bearing:

- **Reflect the form `code` back as the response `orcid` field.** This hands each spec control of a per-run-unique seeded ORCID iD with zero shared state. A fixed constant iD would collide on the `accounts.orcid` partial-UNIQUE index under Playwright `retries: 1`, because there is no DB reset between a test and its retry — the first attempt's row would still be present.
- **Use string concatenation, not template literals, in the inline script.** A `$` in the YAML block scalar would be consumed by compose variable interpolation.

Off-the-shelf mock OAuth2 servers (e.g. `navikt/mock-oauth2-server`) emit RFC-6749 token JSON and surface claims via `/userinfo` or an `id_token` JWT. Adopting one means coercing it into the bespoke top-level-`orcid` shape (response-template override) plus pinning an image plus mounting a config volume — strictly more moving parts than 20 lines of inline `http`. Model the sidecar on the existing `mailpit` E2E sidecar: E2E-only, compose-network sibling, memory-capped.

No backend code change is needed for the `fresh_auth`/`set_password` modes: `config.orcidBaseUrl`, `config.orcidClientId`, and `config.orcidClientSecret` are already env-overridable (`backend/src/config.ts`). The `signup`/`accredit` modes additionally hit a hardcoded `pub.orcid.org` works URL and are out of scope for this stub.

## Why This Matters

- **It's the only topology that resolves on WSL2/Linux-Docker without a backend code change.** Any single-base-URL or host-published-stub design produces a hostname the host-browser cannot reach, and the symptom (a navigation that hangs or DNS-fails mid-spec) is confusing to diagnose because the backend side looks healthy.
- **The security path stays real.** The actual `POST /oauth/token` exchange and the fresh-auth proof mint run against the stub exactly as they would against ORCID. Only the contentless authorize redirect is faked. A reviewer can trust that the E2E exercises the integrated `/callback` logic, not a hollowed-out shim.
- **Code-reflection sidesteps a real, retry-induced flake.** The `retries: 1` + no-DB-reset interaction makes a fixed iD a latent UNIQUE-index collision that only fires on the retry path — exactly the kind of intermittent failure that erodes trust in the suite. Reflecting the `code` makes per-run iDs free.
- **Hand-rolling is less surface, not a shortcut.** When the provider's contract is bespoke, the off-the-shelf option costs more (image pin + volume + template override) and still doesn't model the real shape faithfully. The 20-line server IS the faithful model.

## When to Apply

Apply the **backend-only-real** pattern when ALL of these hold:

- An external HTTP/OAuth provider is touched by BOTH the browser and the backend in one flow.
- You run E2E on WSL2 or Linux-Docker where host-published ports (`127.0.0.1`) and compose service-DNS are disjoint namespaces.
- The browser's hop carries no security-relevant payload (it's just a redirect ferrying `code`/`state`), so it's safe to synthesize with `route.fulfill` while keeping the backend's exchange real.

Apply the **hand-rolled stub** decision when:

- The provider's response shape is non-standard (top-level claims, missing `/userinfo`, no `id_token`), so a spec-compliant mock would need coercion anyway.
- A small inline `node:*-alpine` server can return the exact shape the client parses.
- You can model it on an existing E2E sidecar (here, `mailpit`) for consistency.

Do NOT apply this when:

- The provider is touched only by the backend (no browser hop to reconcile — just point `config.*BaseUrl` at the stub).
- The flow depends on a hardcoded provider URL the config doesn't override (e.g. the `pub.orcid.org` works URL used by `signup`/`accredit`) — that needs a separate decision.
- An off-the-shelf mock already speaks the exact shape your client parses, in which case the coercion cost disappears and adopting it may be cleaner.

This is a real compose sidecar (live container), NOT an in-process mock — it sits outside the unit/integration mock carve-out governed by `test-mock-carve-out-clause-c-2026-05-04.md`.

## Examples

**The resolution mismatch that motivates backend-only-real (WSL2/Linux-Docker):**

```
host-browser (Playwright)   ->  reaches stub only at  127.0.0.1:<published-port>
in-container backend        ->  reaches stub at       orcid-stub:8099  (compose DNS)
                            ->  reaches host at        host.docker.internal / gateway IP

No single ORCID_BASE_URL value satisfies both. Splitting authorize-base from
token-base would require editing the /start handler in backend/src/routes/orcid.ts,
which builds the authorize redirect_url from config.orcidBaseUrl and uses the same
value for the /oauth/token exchange in /callback.
```

**The real backend exchange that stays real (from the `/callback` handler):**

```ts
// backend/src/routes/orcid.ts — token exchange runs unchanged against the stub
const tokenRes = await fetchWithOrcidTimeout(`${config.orcidBaseUrl}/oauth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  body: new URLSearchParams({ client_id: ..., client_secret: ..., grant_type: 'authorization_code', code, redirect_uri: getRedirectUri() }),
});
const tokenData = await tokenRes.json() as { orcid: string; name?: string; access_token?: string };
// orcid read TOP-LEVEL, required, format-checked — the shape the stub must emit:
if (!tokenData.orcid) return sendError(res, 400, 'BAD_REQUEST', 'ORCID response missing orcid field');
if (!ORCID_RE.test(tokenData.orcid)) return sendError(res, 400, 'BAD_REQUEST', 'Invalid ORCID iD format');
```

**Bring-up sequence (E2E reuses the dev backend container):**

```bash
./deploy.sh test-db-up   # seed/migrate pevo_app_test first (once per machine, idempotent)
./deploy.sh test-up      # recreate backend with docker-compose.test.override.yml + sidecars
# ... run Playwright specs ...
./deploy.sh up           # restore backend to dev routing (pevo_app)
```

## Related

- `conventions/playwright-page-route-trigger-timing-2026-04-21.md` — the in-page `page.route()` half of the split. Backend-only-real uses `route.fulfill` for the browser redirect hop; that doc covers the trigger/interception timing race to avoid when registering the route.
- `conventions/wire-contract-shape-pinned-on-backend-not-stub-2026-05-16.md` — the rule the stub's `/oauth/token` response shape must obey: a stub is correctness-irrelevant and must reflect the backend's real response shape. Reinforced here (the stub returns the bespoke top-level-`orcid` shape the client actually parses).
- `conventions/account-state-fixture-must-satisfy-all-dimensions-2026-06-09.md` — the per-run ORCID iD reflected by the stub is seeded into `accounts.orcid` as part of a §6.1 State C fixture; that fixture must satisfy every state dimension, not just the one the assertion reads.
- `conventions/accredited-orcid-is-optional-not-edge-case-2026-05-16.md` — ORCID domain semantics context.
- `conventions/test-mock-carve-out-clause-c-2026-05-04.md` — boundary: this learning is E2E real-infra (a live sidecar), distinct from the in-process unit/integration mock carve-out.
- `conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` and `conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` — the inline comments this doc prescribes anchor on stable symbols (the `orcid-stub` service, `ORCID_BASE_URL`, the `/oauth/token` endpoint), not line numbers or task slugs.
