# PEvO API Contract -- ORCID (Consolidated)

Unified ORCID OAuth endpoints replacing the separate auth and accreditation ORCID flows.

**Replaces:**
- `POST /api/auth/orcid/start` and `POST /api/auth/orcid/callback` (from auth.md)
- `GET /api/accreditation/orcid/start`, `GET /api/accreditation/orcid/link-start`, and `POST /api/accreditation/orcid/callback` (from accreditation.md)

**Route file:** `backend/src/routes/orcid.ts` (new)

---

### POST /api/orcid/start

Initiate the ORCID OAuth2 flow for any mode. Generates a state parameter stored in Redis and returns the ORCID authorization URL.

**Auth:** Required for `accredit` and `link` modes (JWT). Not required for `signup` and `login` modes.

**Body:**

```json
{
  "mode": "signup" | "login" | "accredit" | "link"
}
```

| Mode | Auth | Purpose |
|------|------|---------|
| `signup` | No | Verify ORCID for new account creation |
| `login` | No | Sign in via ORCID |
| `accredit` | Yes (JWT) | Get accredited via ORCID |
| `link` | Yes (JWT) | Link/update ORCID on existing accreditation |

**State stored in Redis:** Key `orcid_state:{state}`, TTL 600s.

```json
{
  "mode": "signup" | "login" | "accredit" | "link",
  "username": "...",
  "timestamp": 1234567890
}
```

`username` is present only for authenticated modes (`accredit`, `link`), read from the JWT.

**Response `data`:**

```json
{
  "redirect_url": "https://orcid.org/oauth/authorize?client_id=...&response_type=code&scope=/authenticate&redirect_uri=...&state=..."
}
```

**Redirect URI:** Derived at runtime as `${config.appUrl}/orcid/callback`. No env var.

**Scope:** All modes use `/authenticate` only. The ORCID Public API (free tier) does not permit additional scopes like `/read-limited` (Member API paid tier).

**Rate limit:** 10 requests per IP per minute.

**Errors:**
- `VALIDATION_ERROR` -- invalid mode
- `UNAUTHORIZED` -- missing/invalid JWT for authenticated modes
- `INTERNAL_ERROR` -- ORCID integration not configured

---

### POST /api/orcid/callback

Complete the ORCID OAuth2 flow. Exchanges the authorization code for an access token, reads the ORCID profile, and performs mode-specific logic.

**Auth:** Required for `accredit` and `link` modes (JWT or Hive-signature headers). The authenticated caller must match the `username` bound into the state by `/start`; otherwise the request is rejected with 403. Not required for `signup` and `login` modes (their state has no bound username). This closes the state-hijack path where a leaked state could be replayed by a different user.

**Body:**

```json
{
  "code": "<ORCID authorization code>",
  "state": "<state from OAuth redirect>"
}
```

**Behavior by mode:**

#### signup

1. Exchange code for token, fetch ORCID profile and works.
2. Check `ORCID_MIN_WORKS` (default 3). Only count works with an external source (Crossref, DataCite, Scopus, etc.).
3. Store verified data in Redis: key `orcid_verified:{nonce}`, TTL 1800s, value `{ orcid_id, works_count, name }`.
4. Return nonce + profile info.

**Response `data`:**

```json
{
  "mode": "signup",
  "orcid_token": "<one-time nonce>",
  "orcid_id": "0000-0001-2345-6789",
  "works_count": 5,
  "name": "Jane Doe"
}
```

The `orcid_token` is consumed by `POST /api/auth/signup`.

#### login

1. Exchange code for token, get ORCID iD.
2. Look up account in `accounts` table by `orcid` column.
3. If found: return JWT session.
4. If not found: return error `NO_ACCOUNT`.

No min works check on login.

**Response `data` (success):**

```json
{
  "mode": "login",
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_at": "2026-04-20T12:00:00Z",
  "custody": "light",
  "username": "researcher1"
}
```

**Response error (no account):**

```json
{
  "status": "error",
  "error": {
    "code": "NO_ACCOUNT",
    "message": "No account linked to this ORCID. Please sign up first."
  }
}
```

The caller already knows the ORCID they submitted, so the response carries no payload. Consumers branching on this code should not expect `error.details`.

#### accredit

1. Exchange code for token, fetch profile and works.
2. Check `ORCID_MIN_WORKS`.
3. Broadcast `accredit` custom_json with `method: "orcid"`.
4. Update `orcid` column in `accounts` table (if light account).

**Response `data`:**

```json
{
  "mode": "accredit",
  "message": "Accreditation via ORCID confirmed",
  "username": "scientist1",
  "orcid": "0000-0001-2345-6789",
  "tx_id": "<Hive custom_json transaction ID>"
}
```

#### link

1. Exchange code for token, get ORCID iD and profile.
2. Fetch existing accreditation from HAF to preserve fields (name, institution, field, method).
3. Broadcast updated `accredit` custom_json with ORCID added/updated.
4. Update `orcid` column in `accounts` table (if light account).

No min works check on link.

**Response `data`:**

```json
{
  "mode": "link",
  "message": "ORCID linked successfully",
  "username": "scientist1",
  "orcid": "0000-0001-2345-6789",
  "tx_id": "<Hive custom_json transaction ID>"
}
```

**Errors (all modes):**
- `BAD_REQUEST` -- invalid/expired state or authorization code
- `BAD_REQUEST` -- `Invalid ORCID iD format`. The `orcid_id` returned from ORCID's token-exchange response did not match `/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/`. Format-level defense-in-depth guard; ORCID itself validates the MOD 11-2 checksum upstream. Fires at the `/callback` dispatch before any Redis key builder, pub.orcid.org fetch, or `custom_json` broadcast sees the value.
- `UNAUTHORIZED` -- missing/invalid auth on `accredit` or `link` callbacks
- `FORBIDDEN` -- authenticated caller does not match the `username` bound into the state by `/start` (applies to `accredit`, `link`)
- `ORCID_ALREADY_LINKED` (409) -- ORCID is bound to another account. Applies to `accredit` and `link`. Three distinct causes share this code; on the wire all three are non-retriable and identically shaped (no `retriable` field, no `Retry-After` header). Cause discrimination is server-side telemetry only:
  - **Durable on-chain binding:** the ORCID is accredited to another account on Hive. `findAccreditedAccountWithOrcid` matched an authority-signed `accredit` op for a different account. The caller must rebind via that account's keys or wait for a revoke.
  - **Cache-lag binding:** a different account successfully bound this ORCID within the last ~120s and the op has not yet been indexed by HAF. The orcid_binding Redis cache answered the 409 during the HAF-indexing-lag window. The binding is durable once indexed.
  - **Same-tick lock contention:** another request for the same ORCID currently holds the `orcid_binding_lock:${orcid_id}` SETNX lock (acquired before broadcast, released in the finally under a Lua CAS keyed on a per-acquisition nonce). Transient at the server, but terminal from the client's perspective: the OAuth `state` token has already been consumed by the time the lock-acquisition runs, so a same-`{code, state}` retry would land on 400 BAD_REQUEST rather than re-running the operation. Clients restart the ORCID flow on this 409; the holder's broadcast has typically completed by the time `/start` redirects again. **Lock TTL upper bound is 35 seconds in the normal path; on the timer-fire path of `BroadcastTimeoutError` (Option A.1) the lock TTL is extended in-place to 120 seconds (the `HAF_INDEXING_LAG_CEILING_SECONDS` upper bound on HAF-indexing lag) so a concurrent bind cannot acquire a fresh lock while the original broadcast may still be on-chain unindexed.** This extension is server-internal: the wire shape on a contending request inside the extended window is the same 409 as outside it.

  **Why `retriable` is absent on every cause.** Historically the same-tick contention 409 emitted `retriable: true` + `retry_after_seconds: 10` + `Retry-After: 10`. The discriminator was unreachable by design: state is consumed at `/callback` BEFORE lock acquisition, so a same-state retry could only ever return 400. The architect retired the discriminator on this 409 (decision: Option B in ARCHITECT-ORCID-STATE-CONSUMPTION-VS-RETRIABLE-409, archived 2026-04-29). A future retriable surface on a different envelope is still possible. Clients SHOULD continue to treat absence of `error.details.retriable` as `false` and presence as `true`, so the convention remains forward-compatible if a retriable case lands on an endpoint where state semantics permit it.

  **Degraded-mode success (no 409):** When the binding-lock primitive is unavailable -- Redis outage or lock-nonce-shape invariant drift -- `acquireBindingLock` returns `{ state: 'unavailable' }` and the callback degrades to cache-less HAF-only dedup. The lock-contention 409 is never emitted in this mode; if no durable on-chain binding is found, the endpoint returns a normal 2xx success. The narrow same-tick TOCTOU window is accepted in degraded mode (availability over consistency). Operators are alerted via `logger.error` on both causes; consumers see no wire-shape change from the nominal success path.
- `VALIDATION_ERROR` -- ORCID profile has fewer than `ORCID_MIN_WORKS` works (signup/accredit modes only)
- `VALIDATION_ERROR` -- link mode but user is not accredited
- `INTERNAL_ERROR` -- ORCID API unreachable
- `BROADCAST_FAILED` (502) -- Hive chain rejected the accreditation/link broadcast (accredit + link modes). `details.retriable: false`. The OAuth `state` has already been consumed; the caller must restart the ORCID flow.
- `BROADCAST_TIMEOUT` (504) -- Backend either aborted the broadcast at 30s, or caught a non-timer throw on a code path where outcome cannot be determined (accredit + link modes). `details.retriable: false, details.outcome: 'uncertain', details.verify_before_retry: true, details.verify_location: '/settings'` (the field set is the contract; consumers MUST access by key name, not by position. The serialization order is a source-readability convention, not a wire contract). The OAuth `state` has been consumed, so retrying `POST /api/orcid/callback` with the same `{code, state}` body returns 400 BAD_REQUEST. The caller MUST verify linkage at `/settings` (or via `/api/accreditation/:username`) before restarting the flow. Blind retry would duplicate the `custom_json` op if the original broadcast landed. The 504 fires on three distinct trigger paths; clients see the same envelope shape on all three (with `details.timeout_ms` only present when noted):
    - **Timer-fire on the lock-acquired branch.** `BroadcastTimeoutError` raised by the 30s `broadcastJsonWithTimeout` wall-clock bound. `details.timeout_ms: 30000` is present.
    - **Non-timer throw on the lock-unavailable branch (Redis outage or lock-nonce-shape invariant drift).** Any throw escaping `fn` while the lock primitive is unavailable is treated as outcome-ambiguous (the broadcast may have landed without a lock-TTL margin to bound a retry race). `details.timeout_ms` is omitted unless the underlying throw is a `BroadcastTimeoutError` (in which case it is present per the timer-fire rule above).
    - **Pre-broadcast SYNC throw on the lock-acquired branch.** Synchronous failure inside `fn` before the broadcast call (e.g. `PrivateKey.fromString` on a malformed admin key, an envelope-hash compute error). The wrapper's outer catch routes this through the same envelope. `details.timeout_ms` is omitted (the throw is not a `BroadcastTimeoutError`). Note: in production this class signals a server-side configuration issue and should not reach the route in normal operation; see `tasks/pending/backend-pevo-admin-key-startup-validation.md` for the architect's planned startup-validation guard. Post-broadcast async throws on the same branch take a different shape; see `POST_BROADCAST_FAILED` below.

  **Server-side residual race window after the 504.** The Option A.1 lock-TTL extension (in-place expand to `HAF_INDEXING_LAG_CEILING_SECONDS = 120s` on `BroadcastTimeoutError`) is the boundary of server-side double-bind protection. If the broadcast actually landed on chain but HAF indexing lag exceeds 120 seconds, the lock self-expires while the binding remains unindexed; a user who restarts the OAuth flow (new `/start`, new state, new `/callback`) acquires a fresh lock and broadcasts a duplicate `custom_json` op. Both ops can land on chain → ORCID is bound twice. The 504's `verify_before_retry: true` + `verify_location: '/settings'` instruction is the user-side mitigation: verify before restarting OAuth, regardless of how much time has passed since the 504. The 120-second window is "best-effort" not a hard guarantee; clients MUST NOT use 120s as a "safe to retry without verification" timer.
- `POST_BROADCAST_FAILED` (502) -- Broadcast confirmed on chain, then a downstream cascade write (cache, accounts row, reputation seed) failed. `details.retriable: false, details.outcome: 'confirmed', details.tx_id: <40-char lowercase hex string, the Hive transaction id>, details.failed_step: 'cache_write' | 'account_update' | 'reputation_seed'`. The OAuth `state` has been consumed; the chain state is durable. The frontend should display the linkage as successful and surface the failed step to operators rather than asking the user to verify or retry. Per-step reachability and recovery semantics:
    - **`cache_write`** -- the binding cache (`orcid_binding:${orcidId}`) write failed. Reachable from both `mode:'accredit'` and `mode:'link'`. Recovery: the next request that needs the cache populates it from HAF; no scheduled reconcile.
    - **`account_update`** -- the `accounts.orcid` column write failed. Reachable from both modes. Recovery: the column is a denormalized projection of the on-chain accreditation; ORCID-based account lookups (`/api/orcid/login`) read it directly, so a missed write requires either a scheduled HAF-replay job (not currently implemented) or a manual operator re-run.
    - **`reputation_seed`** -- the accreditation reputation-bonus seed (`reputation:batch:${username}`) write failed. Reachable from `mode:'accredit'` only (`mode:'link'` does not seed reputation). Recovery: the next reputation batch cycle (≤ 1 day in test, ≤ 7 days in production) recomputes from chain state.

  **Stability scope:** `details.failed_step` is the stable wire contract; integrators MUST branch on this enum value rather than substring-matching `error.message`. The per-step user-facing `error.message` strings above are informational and may be edited for clarity in a future copy pass without a contract bump. The cross-resource standard error table in `common.md` lists `POST_BROADCAST_FAILED` alongside `BROADCAST_FAILED`.

---

### Changes to POST /api/auth/signup

When `orcid_token` is provided:
- `email` becomes optional (NULL allowed in DB after migration)
- `password` becomes optional when no email is provided
- `institution` and `field` become optional (filled from ORCID if available, empty string otherwise)
- `full_name` falls back to ORCID profile name when not provided

The rest of the signup flow (verify, confirm/link) is unchanged. ORCID-signup accounts skip email verification and go directly to the username/keys step.

---

### Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `ORCID_CLIENT_ID` | (none) | ORCID OAuth2 client ID. Required for ORCID features. |
| `ORCID_CLIENT_SECRET` | (none) | ORCID OAuth2 client secret. Required for ORCID features. |
| `ORCID_BASE_URL` | `https://orcid.org` | Set to `https://sandbox.orcid.org` for the ORCID sandbox environment. |
| `ORCID_MIN_WORKS` | `3` | Minimum externally-sourced works required for signup/accredit modes. |
