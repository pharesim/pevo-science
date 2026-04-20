---
title: Security Audit — Findings and Fixes
owner: Architect
status: in-progress
date_started: 2026-04-20
---

# Security Audit — Findings and Fixes

External friend/auditor review, being triaged one finding at a time. Each entry captures: finding summary, decided fix, files touched, status.

---

## FINDING-001 — Universal auth bypass via unbound `X-Hive-Message`

**Severity:** Critical (CVSS 9.6) — CWE-345, CWE-294
**Location:** [backend/src/middleware/verifyHiveSignature.ts:138-148](../../backend/src/middleware/verifyHiveSignature.ts#L138-L148)
**Status:** Fixed (2026-04-20) — backend (SEC-001-BE) and frontend (SEC-001-UI) shipped atomically. The previously-pending in-browser Keychain smoke test is superseded by the TEST-003 equivalence test ([frontend/tests/unit/sec-001-equivalence.test.js](../../frontend/tests/unit/sec-001-equivalence.test.js)), which drives the backend helper ([backend/src/lib/authMessage.ts](../../backend/src/lib/authMessage.ts)) from the frontend's `signRequest` and asserts byte equality for the four representative request shapes. The manual end-to-end signature-verification check (real posting key, real Keychain) is kept deliberately out of automation and remains the pre-deploy gate.

### Summary

`verifyHiveSignature` accepts a client-supplied `X-Hive-Message` header and uses it **verbatim** as the signed payload. There is no binding to the HTTP method, path, body, domain, or a fresh nonce. Any signature produced by the victim's posting key on any dApp (login prompts on other apps, Keychain test prompts, prior PEvO calls) can be replayed to authenticate as that victim for any PEvO endpoint. Replay-cache and timestamp guards are bypassable: the 5-minute `seen-signatures` cache only catches *exact* reuse within 5 minutes on PEvO, and the timestamp check only runs when `X-Hive-Timestamp` is present.

### Current callers of the `X-Hive-Message` escape hatch

1. [frontend/src/auth.js:52-63](../../frontend/src/auth.js#L52-L63) — `/api/auth/session` login, signs `pevo-auth-{ts}-{rand}` (client-generated challenge, not server-issued).
2. [frontend/src/api.js:388-401](../../frontend/src/api.js#L388-L401) — `/api/auth/link`, signs `${email}:link` (no timestamp binding at all since `X-Hive-Timestamp` is present but the header only acts on the fallback path).
3. Docs (not code) claim `/api/bridge/register` and `/api/bridge/update` use `X-Hive-Message` — but the route handlers just use the same middleware; frontend bridge callers do not actually set the header today (verified via grep).

### Decided fix — request-binding with domain separator

Rather than the auditor's suggestion (add a separate `/api/auth/keychain-login` with server-issued nonce), we use a simpler, uniform design that standard HMAC-signing auth schemes use (AWS SigV4, etc.):

1. **Remove `X-Hive-Message` entirely.** No escape hatch. Delete the header from the middleware, from CORS `allowedHeaders`, from API contract docs.
2. **`X-Hive-Timestamp` becomes required.** Reject requests with a missing or >60s-old timestamp.
3. **Add a domain separator and bind the signed message to the full request:**

   ```
   {APP_TAG}-auth|v1|{METHOD}|{path}|{sha256_hex(body)}|{timestamp}
   ```

   `APP_TAG` is the deployment's Hive tag (`pevotest` on beta, `pevo` in prod, anything else on forks). Including it in the separator prevents cross-deployment replay — e.g., a signature captured on beta cannot be replayed against production, even though both accept the same posting keys. So the same signature cannot be replayed across deployments, endpoints, dApps, or past 60s.
4. **Keep the 5-minute signature replay cache** unchanged.
5. **Keep the JWT `Authorization: Bearer` path** unchanged — this finding only affects the Hive-signature path.

### Why not the auditor's separate-challenge design?

The nonce-based login flow the auditor suggests is stricter but adds Redis state and a round-trip for every auth. With request-binding + 60s timestamp + replay cache + domain separator, the attack surface closes:

- Cross-dApp signatures: blocked by the domain separator — no other dApp signs strings shaped like `{APP_TAG}-auth|v1|POST|/api/auth/session|…`.
- Cross-deployment replay (beta ↔ prod, fork ↔ prod): blocked because `APP_TAG` is part of the separator.
- Cross-endpoint reuse on PEvO: blocked by method/path binding.
- Body-tamper: blocked by body hash.
- Time-shift: blocked by 60s window.
- In-window replay: blocked by replay cache.

If future work needs a stronger guarantee (e.g., anti-CSRF for a sensitive flow, or a login form that wants single-use semantics), we can layer a challenge-nonce endpoint on top — it isn't mutually exclusive with request-binding.

### Body-serialization caveat (implementation detail)

Backend currently computes `sha256(JSON.stringify(req.body || ''))`. After Express body-parser, an empty POST body parses to `req.body = {}` → hash of `'{}'`, but a request with no `Content-Type: application/json` header gives `req.body = undefined` → hash of `'""'`. The frontend and backend must agree on exactly one serialization.

Decision: the client **must** always send `Content-Type: application/json` and a JSON body (at minimum `{}`) for authenticated POSTs. Both sides hash `JSON.stringify(body || {})` uniformly — no method-based branching. For GET/DELETE with no body, both sides hash `'{}'` (backend: `req.body` is `undefined`, `|| {}` → `{}`, `JSON.stringify({})` → `'{}'`; frontend helper: pass the empty object explicitly). This is intentional: a single normalization rule avoids client/server drift.

### Files to change

**Backend (Backend agent):**
- `backend/src/middleware/verifyHiveSignature.ts` — remove `X-Hive-Message`, require timestamp, add domain separator, normalize empty-body hash.
- `backend/src/app.ts:103` — remove `X-Hive-Message` from CORS `allowedHeaders`.
- `backend/tests/routes/auth.test.ts` and related test helpers — stop sending `X-Hive-Message`; compute request-bound message in tests.
- `backend/tests/fixtures/mock-auth.ts` — no change needed (already only checks username header).

**Frontend (UI agent):**
- `frontend/src/auth.js` — in `connect()`, compute request-bound message `{APP_TAG}-auth|v1|POST|/api/auth/session|{sha256("{}")}|{timestamp}`, sign that, drop `X-Hive-Message`. Send `{}` body with `Content-Type: application/json`. The APP_TAG must be exposed to the frontend (e.g., injected via Vite env or a `/api/config` endpoint — currently it's already used client-side for posting tags, confirm the existing source).
- `frontend/src/api.js` — in `linkExistingAccount`, compute request-bound message over the auth_token body, drop `X-Hive-Message`.
- Grep for any other frontend caller that still sets `X-Hive-Message` and migrate it.

**Docs (Architect):**
- `agents/docs/api-contracts/common.md` — remove `X-Hive-Message` row from header table; document the domain-separator message format; mark `X-Hive-Timestamp` as required.
- `agents/docs/api-contracts/auth.md` — drop `X-Hive-Message` from session/link headers.
- `agents/docs/api-contracts/bridge.md` — drop `X-Hive-Message` from register/update headers.

### Deployment

Atomic: frontend and backend must ship together, since old frontend builds will no longer authenticate against the new backend. Acceptable for beta — no graceful-rollout burden.
