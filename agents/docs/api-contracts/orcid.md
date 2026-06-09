# PEvO API Contract -- ORCID (Consolidated)

Unified ORCID OAuth endpoints replacing the separate auth and accreditation ORCID flows.

**Replaces:**
- `POST /api/auth/orcid/start` and `POST /api/auth/orcid/callback` (from auth.md)
- `GET /api/accreditation/orcid/start`, `GET /api/accreditation/orcid/link-start`, and `POST /api/accreditation/orcid/callback` (from accreditation.md)

**Route file:** `backend/src/routes/orcid.ts` (new)

---

### POST /api/orcid/start

Initiate the ORCID OAuth2 flow for any mode. Generates a state parameter stored in Redis and returns the ORCID authorization URL.

**Auth:** Required for `accredit`, `link`, `fresh_auth`, and `session_auth` modes (JWT). Not required for `signup` and `login` modes.

**Body:**

```json
{
  "mode": "signup" | "login" | "accredit" | "link" | "fresh_auth" | "session_auth",
  "action": "author_accept" | "author_resign" | "set_password" | "change_email" | "delete_account",
  "root_author": "<hive-account>",
  "root_permlink": "<paper-permlink>"
}
```

| Mode | Auth | Purpose |
|------|------|---------|
| `signup` | No | Verify ORCID for new account creation |
| `login` | No | Sign in via ORCID |
| `accredit` | Yes (JWT) | Get accredited via ORCID |
| `link` | Yes (JWT) | Link/update ORCID on existing accreditation |
| `fresh_auth` | Yes (JWT) | Mint a per-op (consent_op-kind) fresh-auth proof via a fresh OAuth round-trip. Sibling to `POST /api/custody/fresh-auth` (password path). Bound to a specific `(action, root_author, root_permlink)` target. The OAuth-returned ORCID iD MUST equal `accounts.orcid` for the JWT subject; mismatch returns 403. |
| `session_auth` | Yes (JWT) | Mint a target-less (session-kind) fresh-auth proof via a fresh OAuth round-trip. Used by State C (passwordless ORCID-only) accounts — and State B accounts — to authorize non-consent broadcasts (vote, comment, non-consent `custom_json`). The OAuth-returned ORCID iD MUST equal `accounts.orcid` for the JWT subject; mismatch returns 403. |

`action`, `root_author`, and `root_permlink` semantics by `mode === "fresh_auth"` action category:

- **Consent-op actions (`author_accept`, `author_resign`):** `action`, `root_author`, and `root_permlink` are all REQUIRED. The three fields form the per-op target the issued proof binds to; the consent op submitted on a subsequent `POST /api/custody/broadcast` MUST match the triple exactly or the broadcast returns 403 `FRESH_AUTH_REQUIRED` with `details.reason: "target_mismatch"`. Any missing or malformed field returns 400 `VALIDATION_ERROR`.
- **Non-broadcast actions (`set_password`, `change_email`, `delete_account`):** `action` is REQUIRED; `root_author` and `root_permlink` are IGNORED if present. The backend synthesizes the target as `(action, <authenticated username>, '')`, so `root_author` defaults to the JWT subject and `root_permlink` to the empty string. Empty `root_permlink` is what makes these targets collision-free against consent-op targets at the hash layer (consent ops require non-empty `root_permlink` by the validation rule above). `set_password` proofs are consumed at `POST /api/settings/set-password`; `change_email` proofs at the JWT path of `POST /api/settings/email`; `delete_account` proofs at the JWT path of `DELETE /api/settings/email`. All three mint paths are live: State C (passwordless ORCID-only) accounts use this ORCID route; State A/B accounts may instead use the password sibling at `POST /api/custody/fresh-auth` (except `set_password`, which is ORCID-only by definition).

In all modes other than `fresh_auth`, the three fields are IGNORED. Session-kind proofs minted via `session_auth` do NOT carry a target and are admitted only on the non-consent broadcast surface; submitting one to a consent-op bundle returns 403 `FRESH_AUTH_REQUIRED` with `details.reason: "kind_mismatch"`.

**State stored in Redis:** Key `orcid_state:{state}`, TTL 600s.

```json
{
  "mode": "signup" | "login" | "accredit" | "link" | "fresh_auth" | "session_auth",
  "username": "...",
  "timestamp": 1234567890,
  "fresh_auth_target": {
    "action": "author_accept" | "author_resign" | "set_password" | "change_email" | "delete_account",
    "root_author": "<hive-account>",
    "root_permlink": "<paper-permlink>"
  }
}
```

`username` is present only for authenticated modes (`accredit`, `link`, `fresh_auth`, `session_auth`), read from the JWT. `fresh_auth_target` is present only when `mode === "fresh_auth"` (target-bound issuance); session_auth is target-less by design so the field is absent. The `/callback` handler reads `fresh_auth_target` back from the state map for fresh_auth and passes it to `consumeFreshAuthToken` so the issued proof binds to the same target the user authorized at `/start`. State carries the target across the OAuth round-trip; the SPA does not re-submit it on `/callback`. The backend echoes the target triple (`action`, `root_author`, `root_permlink`) in the `fresh_auth` response body so the SPA can cache the issued proof keyed on its actual binding (see Response shape below).

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

**State consumption semantics.** The OAuth `state` parameter is consumed (DEL from Redis) only on success paths, on application-error paths for unauthenticated modes (`signup`, `login`), and on the application-error paths of authenticated modes that have already passed the auth check. Two error paths intentionally do NOT consume state:

- **403 FORBIDDEN on authenticated modes** (`accredit`, `link` — caller identity does not match the `username` bound at `/start`). The legitimate initiator can retry `/callback` with a valid bearer without being forced back through the ORCID OAuth redirect.
- **Infrastructure errors on the state-read and auth-dispatch paths** (any throw from the state-read `redis.get` or the auth middleware before the auth check returns). The widened try/catch maps these to 500 INTERNAL_ERROR with state preserved, so a transient Redis flap or auth-stack throw on the first attempt does not burn the user's `state` token.

State is consumed on a 500 INTERNAL_ERROR only when the throw originates downstream of the consume DEL (token-exchange dispatch and beyond).

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

#### fresh_auth

1. Exchange code for token, get ORCID iD.
2. Verify the OAuth-returned ORCID iD format matches `/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/`. Mismatch returns 400 `BAD_REQUEST`.
3. Look up `accounts.orcid` for the JWT subject (the `username` bound into the state at `/start`).
4. Verify `accounts.orcid === orcidId`. Mismatch (or account has no ORCID linked) returns 403 `FORBIDDEN`. This is the symmetric guard to the `link`/`accredit` rule that an ORCID belongs to one account.
5. Issue a fresh-auth proof bound to the JWT subject with `mechanism: "orcid"`.

No `custom_json` broadcast on this mode. No min works check.

**Response `data`:**

```json
{
  "mode": "fresh_auth",
  "fresh_auth_proof": "<single-use token>",
  "expires_at": "2026-05-06T12:05:00.000Z",
  "mechanism": "orcid",
  "action": "author_accept" | "author_resign" | "set_password" | "change_email" | "delete_account",
  "root_author": "<hive-account>",
  "root_permlink": "<paper-permlink>"
}
```

`fresh_auth_proof` is a single-use bearer token bound to the JWT subject. TTL is 5 minutes. Where to submit it depends on the action category: consent-op proofs (`author_accept`, `author_resign`) go in the `fresh_auth_proof` field of a subsequent `POST /api/custody/broadcast` request containing the matching consent op (see [custody.md](custody.md)); non-broadcast proofs go in the request body of the matching settings endpoint (`set_password` → `POST /api/settings/set-password`; `change_email` → JWT path of `POST /api/settings/email`; `delete_account` → JWT path of `DELETE /api/settings/email`, see [settings.md](settings.md)).

`action`, `root_author`, and `root_permlink` are the per-op target binding the proof was issued against, echoed from the Redis state's `fresh_auth_target` written at `/start`. The SPA caches the issued proof keyed on this triple so the consume-time lookup matches the proof's actual binding. For non-broadcast actions (`set_password`, `change_email`, `delete_account`), `root_author` is the authenticated username and `root_permlink` is the empty string (no paper is involved). For consent ops (`author_accept`, `author_resign`), both are derived from the paper the user is authorizing.

**Errors specific to `fresh_auth`:**
- `BAD_REQUEST` (400) — invalid ORCID iD format returned by the OAuth round-trip, OR the `fresh_auth_target` is missing from the Redis state map at `/callback`. The latter is a defensive closed-default rejection: `/start` enforces target presence on entry, so an absent `fresh_auth_target` at `/callback` indicates a corrupt state entry rather than a normal client flow. Message: `"fresh_auth state is missing the per-op target binding"`.
- `UNAUTHORIZED` (401) — JWT subject's account not found.
- `FORBIDDEN` (403) — the OAuth-returned ORCID iD does not match `accounts.orcid` for the JWT subject (binding violation), or the account has no ORCID linked.
- `INTERNAL_ERROR` (503) — backend service unavailable.

#### session_auth

Target-less ORCID session-kind proof issuance. Used by State C (passwordless ORCID-only) accounts that have no password mechanism to mint via `POST /api/custody/fresh-auth`, and by State B accounts that prefer the ORCID factor over their password. The mint flow is identical to `fresh_auth` except (a) no per-op target binding, (b) the issued proof is admitted only on the non-consent `POST /api/custody/broadcast` surface.

1. Exchange code for token, get ORCID iD.
2. Verify the OAuth-returned ORCID iD format matches `/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/`. Mismatch returns 400 `BAD_REQUEST`.
3. Look up `accounts.orcid` for the JWT subject (the `username` bound into the state at `/start`).
4. Verify `accounts.orcid === orcidId`. Mismatch (or account has no ORCID linked) returns 403 `FORBIDDEN`. Same symmetric guard as `fresh_auth`.
5. Issue a session-kind fresh-auth proof bound to the JWT subject with `mechanism: "orcid"`. No target binding.

No `custom_json` broadcast on this mode. No min works check.

**Response `data`:**

```json
{
  "mode": "session_auth",
  "fresh_auth_proof": "<single-use token>",
  "expires_at": "2026-05-06T12:05:00.000Z",
  "mechanism": "orcid"
}
```

`fresh_auth_proof` is a single-use bearer token bound to the JWT subject (no target binding). TTL is 5 minutes. Submit it as the `fresh_auth_proof` field on a subsequent `POST /api/custody/broadcast` request whose bundle does NOT contain a consent op. Submitting a session-kind proof to a consent-op bundle returns 403 `FRESH_AUTH_REQUIRED` with `details.reason: "kind_mismatch"`.

**Errors specific to `session_auth`:**
- `BAD_REQUEST` (400) — invalid ORCID iD format returned by the OAuth round-trip.
- `UNAUTHORIZED` (401) — JWT subject's account not found.
- `FORBIDDEN` (403) — the OAuth-returned ORCID iD does not match `accounts.orcid` for the JWT subject, or the account has no ORCID linked.
- `INTERNAL_ERROR` (503) — backend service unavailable.

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
- `ORCID_PROVIDER_TIMEOUT` (504) -- The ORCID provider HTTP call (token exchange or works fetch) did not return headers within the configured timeout (default 10000ms; env-overridable via `ORCID_FETCH_TIMEOUT_MS`). Distinct from `BROADCAST_TIMEOUT` (which fires on the Hive-broadcast leg, 30s default). Fires across `signup`, `login`, `accredit`, `link`, and `fresh_auth` modes. `details: {retriable: false, outcome: 'timeout', verify_before_retry: true}`. The OAuth `state` has been consumed before the provider call, so a same-`{code, state}` retry returns 400 BAD_REQUEST. On modes where the provider call may have partially completed server-side (the `accredit` token-exchange path may have consumed the auth code on ORCID's side), `verify_before_retry: true` instructs the SPA to verify state at `/settings` before restarting the OAuth flow rather than auto-retrying. Treat `retriable: false` on a 504 as "restart the OAuth flow," not "transient gateway error, retry-after backoff."
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
- `POST_BROADCAST_OPERATOR_REQUIRED` (502) -- Permanent-severity sibling of `POST_BROADCAST_FAILED`. Same wire shape (`details.retriable: false, details.outcome: 'confirmed', details.tx_id: <40-char lowercase hex>, details.failed_step: 'cache_write' | 'account_update' | 'reputation_seed'`) and same "chain op is durable" semantics, but the cascade write failed with a class that automatic reconciliation will NOT close (TypeError/SyntaxError/RangeError on the JS path, or SQLSTATE class `23*`/`42*` integrity/schema-drift on the DB path). Discriminated at throw time by `PostBroadcastWriteError.severity === 'permanent'` (see `backend/src/lib/broadcast-error.ts:497`). Emitted from both `mode:'accredit'` (orcid.ts:871-886) and `mode:'link'` (orcid.ts:1035-1039). Operators alert at higher priority than `POST_BROADCAST_FAILED` (page-worthy vs dashboard-worthy). The user-facing message should indicate support contact rather than automatic reconciliation, since "give it a moment to sync" is misleading for the permanent class. **Client handling:** per `common.md` cross-resource MUST, any client handler keyed on `POST_BROADCAST_FAILED` MUST also include this code, otherwise OPERATOR_REQUIRED envelopes fall through to the generic verification-failed path and the user is routed toward `/recover` (which would surface 409 `ORCID_ALREADY_LINKED` since the chain bind is durable). Like its sibling, this code is non-retriable and the OAuth `state` has been consumed; do not restart the OAuth flow.

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
