# PEvO API Contract -- Accreditation

Endpoints for accreditation requests, email verification, and Web of Trust. ORCID OAuth endpoints have moved to [orcid.md](orcid.md).

---

### GET /api/accreditations

List accredited researchers.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `field` | string | — | Filter by field of research (prefix-match, optional, max 200 chars) |
| `institution` | string | — | Filter by institution (prefix-match, optional, max 200 chars) |
| `page` | integer | `1` | Page number |
| `limit` | integer | `50` | Results per page (max 200) |

**Filter semantics on `?field=` and `?institution=`:**

- **Prefix-match:** values are matched as case-insensitive prefixes against the corresponding column (`<value>%` ILIKE binding). Substring matches are not supported.
- **Length cap:** values longer than 200 characters return `400 BAD_REQUEST` with `'Filter "field" too long'` or `'Filter "institution" too long'`.
- **LIKE metacharacters are literal:** `%`, `_`, and `\` in user input are escaped server-side and match themselves. `?field=a%` matches researchers whose field starts with the two characters `a%`, not "anything starting with a".
- **Repeated-param silent-unfilter:** repeated occurrences of the same param (`?field=a&field=b`) silently drop the filter rather than coercing the array to a comma-joined literal. Absent / empty / whitespace-only values also drop the filter (do NOT 400).

**Response `data`:** Array of `AccreditedResearcher`

```json
{
  "username": "scientist1",
  "name": "Dr. Jane Smith",
  "institution": "MIT",
  "field": "neuroscience",
  "method": "email",
  "orcid": "0000-0001-2345-6789",
  "timestamp": "2026-01-15T10:00:00Z",
  "accredited_since": "2026-01-15T10:00:00Z"
}
```

`orcid` is present when the researcher has a verified ORCID, otherwise absent/null.

`accredited_since` (ISO-8601 UTC) is the chain block time of the EARLIEST authority `accredit` op for the account, counting all history across sanction gaps (it does not reset on a revoke/sanction). It is the value UIs render for "accredited since" and is stable across metadata edits: a metadata re-broadcast (see `PATCH /api/accreditation/metadata`) moves `timestamp` to the edit time but leaves `accredited_since` unchanged. The list still sorts by the latest-op `timestamp`, not by `accredited_since`; the field is additive and does not change the sort contract.

**Response `meta`:** Pagination metadata: `{ "page": 1, "limit": 50, "total": 142 }`

---

### GET /api/accreditations/:username

Accreditation status for a single user.

**Response `data`:**

```json
{
  "username": "scientist1",
  "is_accredited": true,
  "accreditation": {
    "name": "Dr. Jane Smith",
    "institution": "MIT",
    "field": "neuroscience",
    "method": "email",
    "orcid": "0000-0001-2345-6789",
    "timestamp": "2026-01-15T10:00:00Z",
    "accredited_since": "2026-01-15T10:00:00Z",
    "tx_id": "5123456789"
  } | null
}
```

- `is_accredited`: reflects live membership (sanction-aware, live-WoT-threshold-gated). It is `false` when the account is sanctioned (an un-lifted `type:"sanction"` `revoke`, sticky until a later authority `accredit`) or is a `wot`-method account currently below the live vouch threshold. A legacy (non-sanction) `revoke` no longer suppresses membership: a WoT account reverts to live-threshold evaluation and an authority-pinned account reverts to its latest `accredit`. See ARCHITECTURE.md § 2 "Accreditation Lifecycle & Sanctions".
- `accreditation.tx_id`: the HAF `customJson.id` of the latest authority-signed `accredit` custom_json for this account, as a decimal string. `null` (and `accreditation` itself `null`) when the account has never been accredited or is currently sanctioned. Shape matches `/api/profile/:username` exactly. Note `accreditation` may be non-`null` while `is_accredited` is `false` for a WoT account below threshold (it carries the latest `accredit` metadata even when live standing has lapsed).
- `accreditation.accredited_since`: the tenure anchor, defined under `GET /api/accreditations` above (earliest-op chain block time; stable across metadata edits; latest-op `timestamp` still carries the most recent op's time). Additive field.

The `accredit` row is filtered server-side to only include events signed by `config.accreditationAuthorities` (via `required_posting_auths ?|` on HAF). Self-broadcast fake `accredit` ops do not surface here.

---

### POST /api/accreditation/request

Submit an accreditation request. Triggers an email verification flow.

**Headers:** `X-Hive-Username`, `X-Hive-Signature` (same as other authenticated endpoints).

**Request Body:**

```json
{
  "full_name": "Dr. Jane Smith",
  "institution": "MIT",
  "field": "neuroscience",
  "email": "jsmith@mit.edu",
  "orcid": "0000-0001-2345-6789"
}
```

The `X-Hive-Signature` header proves the requester controls the Hive account. The backend verifies the signature before sending the verification email.

**Response `data`:**

```json
{
  "message": "Verification email sent to j***h@***.edu",
  "expires_at": "2026-03-26T14:30:00Z"
}
```

**Errors:**
- `UNAUTHORIZED` — invalid or missing Hive signature
- `VALIDATION_ERROR` (422) — non-institutional email domain
- `BAD_REQUEST` — missing required fields
- `RATE_LIMITED` — too many requests from this account

---

### POST /api/accreditation/verify

Confirm an email verification token to complete accreditation.

**Request Body:**

```json
{
  "token": "<verification token from email>"
}
```

**Response `data`:**

```json
{
  "message": "Accreditation confirmed",
  "username": "scientist1",
  "tx_id": "<Hive custom_json transaction ID>",
  "outcome": "already_landed"
}
```

The backend broadcasts the accreditation `custom_json` to Hive upon successful verification. The on-chain payload includes an `idempotency_key` field set to `sha256(${token}:${hive_username})` (deterministic per token; no PII since the token is high-entropy and the username is already public). Pre-broadcast the backend probes HAF for a prior `accredit` op carrying the same `idempotency_key`; on hit the response short-circuits to the existing `tx_id` without re-broadcasting.

`outcome` is OPTIONAL and discriminates three response states:

- **Omitted** on a fresh broadcast (the route signed and submitted a new accredit op; `tx_id` is the just-broadcast tx).
- **`"already_landed"`** on the per-token HAF idempotency-hit path: a prior `/verify` call for the SAME token already landed an accredit op (matched by `idempotency_key = sha256(${token}:${hive_username})`). `tx_id` carries the prior broadcast's tx. Per-token state is best-effort cleaned.
- **`"already_accredited"`** on the user-level existing-accreditation gate hit: the Hive account already has an `accredit` op on chain from a DIFFERENT verification flow (e.g., a sibling pending token from a prior `/api/accreditation/request`). `tx_id` carries the prior accredit-op's tx (potentially older). No broadcast attempted; per-token state is best-effort cleaned. Latest-action handling: a `type:"sanction"` `revoke` is sticky and is REFUSED here with `ACCREDITATION_SANCTIONED` (see below) because self-service re-verification cannot lift a moderation sanction; only a deliberate admin `accredit` lifts it. A legacy (non-sanction) `revoke` is not sticky: the gate falls through to the normal per-token check + broadcast path, which re-accredits the account.

Both short-circuit branches return the same envelope shape (`{ message, username, tx_id, outcome }`) on the first flight; only the `outcome` discriminator and the `tx_id` semantics differ.

**24h grace-period idempotency.** A successful 200 (any of the three branches above) writes a short-lived completion record keyed by `sha256(token)` (Redis, 24h TTL, with in-process memStore fallback for flap resilience within a single process lifetime). A subsequent `/verify` with the same token within the 24h window — whether the original flight took the fresh-broadcast, gate-hit, or idempotency-hit path — returns 200 with the same `username` and `tx_id`. The retry envelope collapses to the canonical 3-field shape (`{ message, username, tx_id }` without `outcome`); the discriminator is lossy across the grace-period read because the completion record stores only `{ username, tx_id }`. This makes AbortError-after-success client retries safe without re-broadcasting; the on-chain `idempotency_key` field is the canonical durable idempotency, the grace-period record is a UX-layer cache. The record does NOT re-verify chain state on retry: a WoT-revoke landing between the original broadcast and the retry returns the cached 200 envelope; downstream action gates (publish, review, vote) re-check current chain state.

**Errors:**
- `BAD_REQUEST`: invalid/expired token.
- `ACCREDITATION_SANCTIONED` (403): the account carries an un-lifted `type:"sanction"` `revoke`. Self-service accreditation cannot lift a moderation sanction, and the response does not disclose the sanction reason. The account is restored only by a deliberate admin `accredit` (`POST /api/admin/accreditation/grant`). The same refusal applies on the ORCID callback and signup-verify accredit paths.
- `BROADCAST_FAILED` (502): Hive chain rejected the accreditation broadcast. `details.retriable: false`. The token is consumed; request a new verification token.
- `POST_BROADCAST_FAILED` (502): Broadcast confirmed on chain, then a transient downstream cascade write failed. Today the only emitter on this route is `seedAccreditationBonus`, which writes the initial reputation-bonus row keyed by username. Wire shape per [common.md](common.md). `details.failed_step: 'reputation_seed'`, `details.outcome: 'confirmed'`, `details.tx_id` carries the confirmed accreditation tx_id. The accreditation IS durable; the bonus row is reconciled by the next reputation-batch cycle. Clients should treat this as success from the user's perspective (do NOT prompt for a new verification token; the chain op is canonical).
- `POST_BROADCAST_OPERATOR_REQUIRED` (502): Broadcast confirmed on chain, then a permanent downstream cascade write failed (e.g., a TypeError or non-retriable DB error inside `seedAccreditationBonus`). Wire shape per [common.md](common.md). Same chain-is-canonical semantics as `POST_BROADCAST_FAILED`, but operator intervention is required to reconcile the missed bonus. User-facing message indicates support contact rather than automatic reconciliation. Clients should NOT prompt for a new verification token. **On retry of the same token, the endpoint returns 400 BAD_REQUEST**: the token is consumed by the post-broadcast cleanup so the retry surfaces the operator-actionable signal (rather than serving a misleading cached 200 from the grace-period record, which is deliberately NOT written on this path). The on-chain accreditation IS durable; clients should display the 502 message verbatim and not interpret the subsequent 400 as "token expired, request a new one."
- `BROADCAST_ATTEMPT_LIMIT_EXCEEDED` (502): Per-token broadcast-attempts cap exceeded under concurrent retry burst (the broadcast was never invoked, so this is distinct from `BROADCAST_FAILED`). `details.retriable: false`. The token is **preserved** (soft-block, not consumed): the per-token broadcast-attempts counter and the pending-token entry both TTL out independently within the token's 24h life, after which the user can retry the same token. Clients should NOT call `/api/accreditation/request` for a fresh token in immediate response; that endpoint is rate-limited to 3 requests per account per 24 hours, and burning a slot here may lock the user out for the rest of the day. Surface the message to the user and let them wait or request a fresh email after the wait. Operators alerting on `BROADCAST_FAILED` rate should NOT bucket this code together with `BROADCAST_FAILED`: this signals client retry-pressure, not chain rejection. **Ordering guarantee:** if the operation is already confirmed on chain (either short-circuit branch — `outcome: 'already_landed'` per-token hit OR `outcome: 'already_accredited'` user-level gate hit), this code is never returned regardless of the counter value; both short-circuits respond before the cap is consulted. A confirmed accreditation cannot mask itself as cap-exhausted.
- `BROADCAST_TIMEOUT` (504): Backend aborted the broadcast at 30s. Outcome uncertain. `details.retriable: false, details.outcome: 'uncertain', details.verify_before_retry: true, details.timeout_ms: 30000`. The on-chain `idempotency_key` field (see Response notes above) means a blind retry within the token's 24h life is now SAFE: the retry's pre-broadcast HAF lookup will find the landed op (if it did land) and short-circuit to `outcome: 'already_landed'`. The historical "blind retry produces duplicate `accredit` ops" hazard is closed by the idempotency layer for this endpoint.
- `SERVICE_UNAVAILABLE` (503): Backend Redis dependency was unavailable when the per-token broadcast-attempts counter could not be primed before reaching the broadcast site. `details.retriable: true`. Emits `Retry-After: 30` (server-driven backoff floor for the SPA's `retryAfterSeconds` accessor). No `details.reason` discriminator. The broadcast was never invoked and no chain-side or token-side state changed, so clients can safely retry. See the `details.retriable` note in `common.md` for the cross-endpoint convention.
- `ACCREDITATION_GATE_UNAVAILABLE` (503): The user-level existing-accreditation HAF gate query (run before the per-token idempotency check on every `/verify` invocation) failed — e.g., HAF outage, query timeout, helper-internal error. `details.retriable: true`. Emits `Retry-After: 30` (server-driven backoff floor; matches the sibling `SERVICE_UNAVAILABLE` cadence so both retriable 503 branches on `/verify` share one floor). The token is **preserved** (no `deleteToken` on this branch, deliberately distinct from the gate-hit and idempotency-hit cleanup branches) so the user can retry once HAF recovers. The pre-INCR broadcast-attempts counter is NOT incremented on this path; broadcast was not invoked. Distinct from the sibling `SERVICE_UNAVAILABLE` above so operators can dashboard gate-unavailable rate separately from the Redis-pre-INCR class. **Note on cache visibility:** during the same HAF outage, per-token cache hits (`outcome: 'already_landed'`) are also unreachable because the gate runs first and 503s before the cache lookup runs. Retries during outage will get 503 even if the prior broadcast already landed; the cached answer becomes visible again once HAF recovers and the next gate query succeeds. This is the operator-only-reversible revoke semantic trade-off (preventing override of a chain-recorded revoke takes precedence over preserving idempotency-cache visibility during outage).

---

### PATCH /api/accreditation/metadata

Self-service edit of the caller's OWN accreditation metadata (`full_name`, `institution`, `field`). Re-broadcasts a MERGED admin-signed `accredit` op that preserves `method`, `orcid`, `evidence_hash`, and the origin `issued_by` marker from the prior op; only the supplied metadata fields change (a WoT account stays a WoT account, its `issued_by:"wot"` marker is not flipped). Authorization is the caller's OWN current accreditation, NOT an admin roster level: the op is admin-key-signed (single signer) but human-authorized by the account owner editing their own profile. The tenure anchor (`accredited_since`) is unaffected: this later re-broadcast moves the latest-op `timestamp` but not the earliest-op block time.

This is the canonical path for filling in metadata that first-accreditation left empty (e.g., an ORCID- or WoT-accredited account with a placeholder `institution` and empty `field`). The `/verify` email-confirm path stays idempotent and does NOT update metadata; all metadata changes route through here.

**Headers:** `X-Hive-Username`, `X-Hive-Signature` (same as other authenticated endpoints).

**Authorization:** a fresh re-auth proof for action `edit_accreditation_metadata`, NOT a JWT alone. This is a critical action (ARCHITECTURE.md § 6.4 / § 6.5 invariant #1) because it triggers an admin-signed on-chain broadcast. The proof is bound to `(edit_accreditation_metadata, <username>, "")` (the caller's own username, empty permlink) so a proof minted for user A cannot edit user B, and it is consumed single-use. Mint it via `POST /api/custody/fresh-auth` with `action="edit_accreditation_metadata"` (password) or `POST /api/orcid/start mode="fresh_auth" action="edit_accreditation_metadata"` (ORCID), the same per-action issuance pair as `ipfs_upload` (see [ipfs.md](ipfs.md)). Self-custody (Keychain) callers satisfy the requirement with the request signature and omit `fresh_auth_proof`. Eligibility (currently accredited AND not sanctioned) is checked BEFORE the proof is consumed, so an ineligible caller never burns a valid proof.

**Request Body:**

```json
{
  "full_name": "Dr. Jane A. Smith",
  "institution": "MIT Media Lab",
  "field": "computational neuroscience",
  "fresh_auth_proof": "<single-use proof token; JWT path only>"
}
```

At least one of `full_name`, `institution`, `field` is required (an all-empty body is rejected). Bounds mirror `accreditationRequestSchema`: `full_name` and `institution` 1 to 200 chars, `field` 1 to 100 chars. Each supplied field overlays the prior op's value; omitted fields carry forward unchanged. `fresh_auth_proof` is required only on the JWT/light-account path.

**Response `data`:**

```json
{
  "message": "Accreditation metadata updated",
  "tx_id": "<Hive custom_json transaction ID>",
  "accreditation": {
    "name": "Dr. Jane A. Smith",
    "institution": "MIT Media Lab",
    "field": "computational neuroscience",
    "method": "email",
    "orcid": "0000-0001-2345-6789"
  }
}
```

`accreditation.method` and `accreditation.orcid` reflect the PRESERVED prior-op values, not new input; `orcid` is `null` when the prior op carried none.

**Errors:**
- `UNAUTHORIZED` (401): missing or invalid Hive signature.
- `BAD_REQUEST` (400): body fails validation (all three fields absent, or a field over its length bound).
- `FRESH_AUTH_REQUIRED` (401|403): missing, expired, or mismatched fresh-auth proof on the JWT path. 401 when no usable proof is present; 403 on a binding violation (proof for a different user or action). `details.reason` discriminates; status mapping per [custody.md](custody.md).
- `FORBIDDEN` (403): the caller is not currently accredited (no authority `accredit` op on chain, or a WoT account below the live vouch threshold). There is nothing to edit.
- `ACCREDITATION_SANCTIONED` (403): the account carries an un-lifted `type:"sanction"` `revoke`. A self-service metadata edit cannot lift a moderation sanction (it would otherwise re-broadcast a fresh `accredit` op and self-clear the sanction); only a deliberate admin `accredit` restores the account. Same refusal and message as the sibling `/verify` path. This check is non-cached and closes the membership-cache staleness window.
- `SERVICE_UNAVAILABLE` (503): HAF was unavailable when loading the current accreditation op (the upstream reachability gate). `details.retriable: true`; emits `Retry-After: 30`. No broadcast was attempted and the proof was not consumed, so the caller can retry once HAF recovers. A HAF blip striking the downstream membership/sanction reads after this gate passes fails closed to a `403` rather than a `503`; that is an accepted, self-correcting edge that also resolves on retry.
- `RATE_LIMITED` (429): per-account edit limiter exceeded (each successful edit triggers an admin-signed re-broadcast).
- `BROADCAST_FAILED` (502) / `BROADCAST_TIMEOUT` (504): the chain rejected the broadcast or it timed out. Wire shape per [common.md](common.md). On a timeout the outcome is uncertain (`details.outcome: 'uncertain'`, `details.verify_before_retry: true`); the single-use proof is already spent, so the caller verifies on chain and re-mints rather than blind-retrying with a dead token.

---

### POST /api/admin/accreditation/reset-broadcast-counter

Operator manual-reset for the per-token broadcast-attempts counter. Use when the counter has become inflated by a Redis-flap class (see [chain-write-timeout-ambiguous-outcome.md](../solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md) "Manual reset runbook") and the in-process pending-decrement queue has not converged. The endpoint is admin-only: only the on-chain Hive account named by `config.hiveAdminAccount` can authenticate.

**Headers:** `X-Hive-Username` (must equal `config.hiveAdminAccount`), `X-Hive-Signature`.

**Request Body:**

```json
{
  "token": "<verification token>"
}
```

**Response `data`:**

```json
{
  "token_hash": "<sha256(token), 12 hex>",
  "prior_value": 2
}
```

`prior_value` is the counter value at the moment of the atomic GETDEL (may be `null` if the key was already absent or had TTL'd out). A concurrent `/verify` INCR landing between the GETDEL and the operator reading the response can re-inflate the counter to a small positive value; operators should expect this and treat transient re-inflation as confirmation that fresh traffic continues, not as a reset failure.

**Errors:**
- `BAD_REQUEST` (400): Request body fails validation (missing/empty `token`).
- `FORBIDDEN` (403): The authenticated `X-Hive-Username` is not `config.hiveAdminAccount`. The 403 emits an `accreditation.admin.reset_broadcast_counter_forbidden` audit log carrying `attempted_by` (the non-admin username) and `token_hash` (never the raw token).
- `INTERNAL_ERROR` (500): Redis was reachable at gate-check time but rejected the GETDEL command (transient Redis flap, connection drop, or — for an AGPL fork running on a Redis-compatible store predating GETDEL — `ERR unknown command`). The counter is unchanged: GETDEL is server-atomic, so a throw means no delete occurred. Operator should retry once Redis recovers.
- `SERVICE_UNAVAILABLE` (503): Redis was unavailable at gate-check time. `details.retriable: true`. Emits `Retry-After: 30` (server-driven backoff floor matching the `/api/accreditation/verify` 503 cadence and the in-process drainer's cycle period — one drainer cycle has elapsed by the time the operator retries).

**Auto-recovery alternative.** Most counter inflations under Redis flap auto-recover via the in-process pending-decrement queue + drainer cycle, which operates on the same key namespace via the exported `broadcastAttemptsKey`. This admin endpoint is the manual-reset lever for inflations the auto-recovery cannot converge: e.g., the queue overflowed under sustained outage, the inflation predates the drainer's process lifetime (process restart), or the inflation came from a class the drainer does not retry.

---

### POST /api/admin/accreditation/sanction

Issue a sticky moderation sanction against an account's accreditation. Broadcasts a `revoke` custom_json carrying `type:"sanction"`. A sanction suppresses accreditation membership regardless of vouch support and is lifted ONLY by a later authority `accredit` (`POST /api/admin/accreditation/grant`). This is the only `revoke` the backend broadcasts; a WoT threshold drop is a self-healing live-membership non-event with no op (see POST /api/wot/retract).

**Headers:** `X-Hive-Username`, `X-Hive-Signature`.

**Authorization:** admin-tier (resolved from the on-chain admin roster) AND a fresh re-auth proof for action `admin_sanction`. Sanctioning is a critical action (ARCHITECTURE.md § 6.4 / § 6.5 invariant #1), so a JWT alone is never sufficient. Mint the proof via `POST /api/custody/fresh-auth` or `POST /api/orcid/start` (`mode=fresh_auth`) with `action: "admin_sanction"`; the proof is bound to `(admin_sanction, <acting-admin-username>, "")` and consumed single-use here. Self-custody (Keychain) callers satisfy the fresh-auth requirement with the request signature and may omit `fresh_auth_proof`.

**Request Body:**

```json
{
  "account": "scientist1",
  "reason": "Repeated misconduct after warning",
  "fresh_auth_proof": "<single-use proof token>"
}
```

`reason` is optional free text (max 500 chars) and is broadcast verbatim on-chain (public and immutable). `fresh_auth_proof` is required only on the JWT/light-account path.

**Response `data`:**

```json
{
  "message": "Accreditation sanctioned for scientist1",
  "tx_id": "<Hive custom_json transaction ID>"
}
```

Membership reflects the sanction once HAF ingests the op and the slow-changing membership cache refreshes, so there can be a short propagation delay before the sanctioned account drops from the accredited set.

**Errors:**
- `BAD_REQUEST` (400): request body fails validation (invalid `account`, `reason` over 500 chars).
- `FORBIDDEN` (403): the caller is not an admin-roster member, OR the target is protected from this actor (a base admin cannot sanction `root`, a higher-or-equal admin tier, or themselves).
- `FRESH_AUTH_REQUIRED` (401/403): missing, expired, or mismatched fresh-auth proof. Reason-to-status mapping per [custody.md](custody.md).
- `BROADCAST_FAILED` (502) / `BROADCAST_TIMEOUT` (504): the chain rejected the broadcast or it timed out. Wire shape per [common.md](common.md).

---

### GET /api/wot/:username

Vouch status for a user in the Web of Trust system. Returns the number of vouches received, the threshold required for WoT accreditation, and the list of vouchers.

**Response `data`:** `VouchStatus`

```json
{
  "username": "scientist1",
  "vouch_count": 2,
  "threshold": 3,
  "vouches": [
    { "voucher": "scientist2", "relationship": "colleague", "timestamp": "2026-03-25T10:00:00Z" },
    { "voucher": "scientist3", "relationship": "advisor", "timestamp": "2026-03-25T11:00:00Z" }
  ],
  "eligible": false,
  "accreditation_method": "email"
}
```

`accreditation_method` is the method (`wot`, `email`, `orcid`, or `manual`) of the account's latest `accredit` op in the op-pinned (not-sanctioned) set, or `null` when the account has no current `accredit` op or is sanctioned. It is independent of `eligible` (which reflects only the live vouch count against the threshold): a WoT account below threshold still reports `accreditation_method: "wot"` with `eligible: false`.

**Errors:**
- `INTERNAL_ERROR`: HAF database unavailable (required for WoT queries)

---

### POST /api/wot/vouch

Notify the backend that a vouch `custom_json` has been broadcast. The backend checks whether the vouchee has reached the WoT threshold and auto-accredits them if so. The frontend must first broadcast the `vouch` custom_json via Hive Keychain, then call this endpoint.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`

**Request Body:**

```json
{
  "vouchee": "scientist4"
}
```

**Response `data`:**

```json
{
  "message": "Vouch recorded. scientist4 has been auto-accredited via Web of Trust.",
  "accredited": true,
  "tx_id": "<Hive transaction ID or null>",
  "vouch_status": { "...VouchStatus object..." }
}
```

When the vouchee has not yet reached the threshold, the message format is `"Vouch recorded. scientist4 has N/M vouches."` and `accredited` is `false`.

**Errors:**
- `BAD_REQUEST` — missing `vouchee`
- `VALIDATION_ERROR` (422) — voucher is the same as vouchee
- `FORBIDDEN` — voucher is not accredited

---

### POST /api/wot/retract

Notify the backend that a `retract_vouch` custom_json has been broadcast. WoT membership is evaluated live against the current vouch graph, so a retraction is a self-healing non-event: when a vouchee drops below the threshold it simply stops appearing in the accredited set on the next membership read. No `revoke` op is broadcast and no cascade runs. The backend polls HAF until the signer's vouch edge to the vouchee has disappeared from `active_vouches` (so the returned `vouch_status` reflects fresh chain state), then responds. The frontend must first broadcast the `retract_vouch` custom_json via Hive Keychain, then call this endpoint.

**Headers:** `X-Hive-Username`, `X-Hive-Signature`

**Request Body:**

```json
{
  "vouchee": "scientist4"
}
```

**Response `data`:**

```json
{
  "message": "Retraction processed.",
  "revocation_outcome": "none",
  "revocations": [],
  "vouch_status": { "...VouchStatus object, or null when HAF is unavailable..." }
}
```

`revocation_outcome` is always `none` and `revocations` is always `[]`. A WoT threshold drop no longer triggers a `revoke` op; membership self-heals from the live vouch graph on the next read. (The five former outcome values, `revoked`, `skipped`, `unverified`, `timeout`, and `chain_error`, were removed when the threshold-drop cascade was retired.) `vouch_status` may be `null` when HAF is unavailable during the post-retraction status poll.

**Errors:**
- `BAD_REQUEST` (400): missing `vouchee`
- `VALIDATION_ERROR` (422): the signer is the same as the vouchee (cannot retract a vouch for yourself)
- `FORBIDDEN` (403): the signer is not an accredited researcher
