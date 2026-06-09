# PEvO API Contract — Custody

Endpoints for light account server-side signing and custody upgrade.

---

### POST /api/custody/broadcast

Sign and broadcast Hive operations for light accounts. Only `comment`, `vote`, and `custom_json` (revote only) operations are permitted.

**Headers:** `Authorization: Bearer <jwt>` or `X-Hive-Username`, `X-Hive-Signature` (account must have `custody: "light"`)

**Body:**

```json
{
  "operations": [
    ["comment", {
      "parent_author": "",
      "parent_permlink": "pevo",
      "author": "researcher1",
      "permlink": "my-paper",
      "title": "Paper Title",
      "body": "...",
      "json_metadata": "{\"app\":\"pevo/1.0\",\"tags\":[\"pevo\",\"science\"]}"
    }]
  ],
  "fresh_auth_proof": "<token from POST /api/custody/fresh-auth, POST /api/orcid/start { mode: 'fresh_auth' }, or POST /api/orcid/start { mode: 'session_auth' }>",
  "idempotency_key": "<optional 1-128 char client-supplied dedup key>"
}
```

`fresh_auth_proof` is REQUIRED on every call. The proof binding semantics differ based on the bundle contents:

- **Bundles containing a consent op** (`author_accept` or `author_resign`) require a **consent-op-kind** proof bound to the specific `(action, root_author, root_permlink)` triple of the consent op. The backend rejects session-kind proofs on this surface with 403 `FRESH_AUTH_REQUIRED` `details.reason: "kind_mismatch"`. Mint via `POST /api/custody/fresh-auth` (password mechanism) or `POST /api/orcid/start { mode: "fresh_auth" }` (ORCID mechanism).
- **Non-consent bundles** (vote, comment, non-consent `custom_json`) accept EITHER a session-kind proof OR a consent_op-kind proof (cross-kind accept: a consent_op-kind proof is strictly more proof and is admitted on this surface). Session-kind proofs are mintable via `POST /api/orcid/start { mode: "session_auth" }` (ORCID mechanism, available to State B/C accounts with a linked ORCID).

The proof is single-use and consumed atomically before the broadcast attempt.

`idempotency_key` is OPTIONAL. When present, the backend embeds the key into the first `comment` op's `json_metadata.<appTag>.idempotency_key` or the first `custom_json` op's `json.idempotency_key` before broadcasting, and on the next retry-equivalent request runs a pre-broadcast HAF lookup. If a prior op carrying the same `(username, key, op_type)` triple has already landed on chain, the backend short-circuits to the existing `tx_id` without re-broadcasting (see response shape extension below). The key MUST be 1-128 characters. Recommended SPA discipline: generate via `crypto.randomUUID()` per logical operation. Pure-vote bundles (no `comment` or `custom_json` op) silently bypass the idempotency layer because votes have no payload surface for embedding; vote re-cast is low-harm (voting-power cost only). Bundles submitted without an `idempotency_key` proceed as before; the field is opt-in during the SPA migration window.

**Response `data`:**

```json
{
  "tx_id": "abc123...",
  "block_num": 12345678,
  "outcome": "already_landed"
}
```

`outcome` is OPTIONAL. The field is **omitted** on a fresh broadcast and **present with value `"already_landed"`** only on the idempotency-hit path (the backend found a prior op carrying the same `idempotency_key` already on chain and skipped re-broadcasting). On the idempotency-hit path `block_num` MAY be `null` (the HAF row representation does not always preserve `block_num` for legacy operations; consumers MUST handle absence without throwing). On a fresh broadcast `block_num` is always a positive integer.

**Constraints:**
- Only `comment`, `vote`, and `custom_json` operations are allowed. All other operation types return 403.
- The `author` (for comments), `voter` (for votes), or `required_posting_auths` (for custom_json) must match the JWT subject.
- For comments, `json_metadata.app` must start with the configured app tag.
- For `custom_json`, the `id` must match the app tag. Permitted `action` values: `revote`, `claim_authorship`, `approve_authorship`, `revoke_authorship`, `author_accept`, `author_resign`. All other actions return 403.
- A bundle MAY contain at most one consent op (`author_accept` or `author_resign`). Bundles with two or more consent ops return 400 `MULTIPLE_CONSENT_OPS`. Submit each consent op in its own request with its own `fresh_auth_proof`.

**Rate limit:** 30 requests per account per minute.

**Errors:**
- `NOT_FOUND` — custodial account not found
- `FORBIDDEN` — operation not in allowlist, author/voter mismatch, or account already upgraded to self-custody
- `VALIDATION_ERROR` — malformed operations or missing app tag
- `MULTIPLE_CONSENT_OPS` (400) — bundle contains more than one consent op. Submit each consent op in its own request.
- `FRESH_AUTH_REQUIRED` (401|403) — the `fresh_auth_proof` is missing, expired, malformed, bound to a different user, bound to a different consent target, or of the wrong kind for this surface. Status is discriminated by `details.reason`:
  - `details.reason: "username_mismatch"` → **403 FORBIDDEN** (user-binding violation; token was issued for a different account). Returned on both consent and non-consent surfaces.
  - `details.reason: "target_mismatch"` → **403 FORBIDDEN** (per-op target-binding violation; token was issued for a different `(action, root_author, root_permlink)` triple than the consent op in the bundle). The fresh-auth proof binds at issuance time to the specific consent op the user authorized; reusing it for a different action or paper is rejected. Consent-surface only (the non-consent surface does not perform target binding).
  - `details.reason: "kind_mismatch"` → **403 FORBIDDEN** (kind-binding violation; a session-kind proof was submitted on the consent-op surface). Session-kind proofs are scoped to non-consent broadcasts only; the consent surface requires a consent_op-kind proof bound to the per-op target. Consent-surface only.
  - `details.reason: "missing" | "expired" | "malformed"` → **401 UNAUTHORIZED** (no valid proof present). Returned on both consent and non-consent surfaces.
  - `details.reason` is a closed enum: `"missing" | "expired" | "username_mismatch" | "target_mismatch" | "kind_mismatch" | "malformed"`. Adding a new value is a wire contract change; document here before shipping. Consumers MUST branch on `details.reason` to render distinct UX, not on the message string.
- `BROADCAST_TIMEOUT` (504) — broadcast timed out before chain confirmation. Message: `"Broadcasting signed operation timed out"`. Details: `{retriable:false, outcome:"uncertain", verify_before_retry:true, timeout_ms}` (`timeout_ms` is present; these routes always use the timer-fire path). Idempotency note: SPA clients carrying an `idempotency_key` MAY retry safely; the retry's pre-broadcast HAF lookup will find the landed op (if it did land) and short-circuit to `outcome: 'already_landed'`. Clients without an `idempotency_key` should verify chain state before retrying.
- `BROADCAST_FAILED` (502) — Hive node rejected the broadcast. Message: `"Failed to broadcast signed operation to Hive"`. Details: `{retriable:false}`.
- `POST_BROADCAST_FAILED` (502): Broadcast confirmed on chain, then a transient downstream cascade write failed. Wire shape per [common.md](common.md). The custody route does not currently emit this code (today only ORCID and accreditation routes wrap post-broadcast writes in `PostBroadcastWriteError`), but the shared `handleBroadcastError` helper can surface it if a future cascade step is added to custody (e.g., custody-state DB update, audit log row). SPA error-handling code keyed on the broadcast-error code surface SHOULD include a handler for this code.
- `POST_BROADCAST_OPERATOR_REQUIRED` (502): Broadcast confirmed on chain, then a permanent downstream cascade write failed. Wire shape per [common.md](common.md). Same custody-not-currently-emitting note as `POST_BROADCAST_FAILED`. Operator intervention required; the user-facing message indicates support contact rather than automatic reconciliation.
- `INTERNAL_ERROR` (500) — non-broadcast errors (database, decryption, key parse) via the outer catch. Only broadcast-path errors flow through 502/504.

**Single-use proof semantics.** The `fresh_auth_proof` is consumed atomically before the broadcast call. If the broadcast subsequently fails (502, 504), the proof is gone; the caller MUST issue a new proof before retrying. This matches the `chain-write-timeout-ambiguous-outcome` convention: single-use state plus ambiguous broadcast outcome means burn-on-consume is the conservative default.

---

### POST /api/custody/fresh-auth

Mint a fresh-auth proof via password re-verification. Light-account-only. The sibling ORCID issuance path lives at `POST /api/orcid/start { mode: "fresh_auth" }` (see [orcid.md](orcid.md)).

**Headers:** `Authorization: Bearer <jwt>` or `X-Hive-Username`, `X-Hive-Signature` (account must have `custody: "light"`)

**Body:**

```json
{
  "password": "SecurePass123",
  "action": "author_accept" | "author_resign" | "change_email" | "delete_account",
  "root_author": "<hive-account>",
  "root_permlink": "<paper-permlink>"
}
```

`password` and `action` are always REQUIRED. The remaining body fields are conditional on the action category:

- **Consent-op actions (`author_accept`, `author_resign`):** `root_author` and `root_permlink` are REQUIRED. The `(action, root_author, root_permlink)` triple is the per-op target the proof binds to; the consent op submitted on a subsequent `POST /api/custody/broadcast` MUST match this triple exactly or the broadcast returns 403 `FRESH_AUTH_REQUIRED` with `details.reason: "target_mismatch"`. `action` is validated as a closed enum; `root_author` and `root_permlink` are validated as non-empty strings. Any missing or malformed field returns 400 `VALIDATION_ERROR`.
- **Non-broadcast actions (`change_email`, `delete_account`):** `root_author` and `root_permlink` are IGNORED if present. The backend synthesizes the target as `(action, <authenticated username>, '')`. Empty `root_permlink` is collision-free against consent-op targets at the hash layer because consent ops require a non-empty `root_permlink`. The `change_email` proof is consumed at the JWT path of `POST /api/settings/email`; the `delete_account` proof at the JWT path of `DELETE /api/settings/email` (see [settings.md](settings.md)); neither is consumed at `POST /api/custody/broadcast`. Both are non-broadcast critical actions per ARCHITECTURE.md § 6.5 invariant #1: `change_email` rotates the address that receives password-reset tokens (an auth-adjacent factor); `delete_account` is the one-way right-to-erasure exit per § 6.3. State A and State B accounts (`password_hash IS NOT NULL`) mint via this route. State C (passwordless ORCID-only) accounts have no password mechanism and MUST mint via `POST /api/orcid/start { mode: "fresh_auth", action: "<action>" }` instead.

The `set_password` action is NOT minted via this route, because `set_password` transitions State C → State B (the user has no password yet by definition) so a password-mechanism proof is structurally inapplicable. `set_password` proofs are minted only via `POST /api/orcid/start { mode: "fresh_auth", action: "set_password" }`.

**Response `data`:**

```json
{
  "fresh_auth_proof": "<single-use token>",
  "expires_at": "2026-05-06T12:05:00.000Z",
  "mechanism": "password"
}
```

`fresh_auth_proof` is a single-use bearer token bound to the JWT subject AND to the action's target. TTL is 5 minutes. Where to submit it depends on the action category: consent-op proofs go in the `fresh_auth_proof` field of a subsequent `POST /api/custody/broadcast` request containing the matching consent op; the `change_email` proof goes in the request body of `POST /api/settings/email` (JWT path).

**Rate limit:** 10 requests per account per minute.

**Errors:**
- `UNAUTHORIZED` (401) — missing JWT, account not found, or password mismatch. The "no password set" case (e.g., ORCID-only account with `password_hash IS NULL`) returns the same shape to avoid becoming a password-existence oracle.
- `FORBIDDEN` (403) — account has been upgraded to self-custody. Self-custody users sign consent ops via Hive Keychain and do not use this endpoint.
- `VALIDATION_ERROR` (400) — missing `password`, missing or invalid `action` (must be one of `"author_accept"`, `"author_resign"`, `"change_email"`, `"delete_account"`), or, for consent-op actions only, missing or empty `root_author` / `root_permlink`. The `change_email` and `delete_account` actions do not require `root_author` or `root_permlink`.
- `INTERNAL_ERROR` (500) — argon2 verification failure or unexpected error.
- `SERVICE_UNAVAILABLE` (503) — argon2 capacity exhausted or backend draining. See [common.md](common.md).

---

### POST /api/custody/session-auth

Mint a target-less session-kind fresh-auth proof via password re-verification. Light-account-only. Used by State A accounts (light + password, no ORCID) to authorize non-consent `POST /api/custody/broadcast` bundles (vote, comment, non-consent `custom_json`). The ORCID-mechanism sibling lives at `POST /api/orcid/start { mode: "session_auth" }` (see [orcid.md](orcid.md)).

**Headers:** `Authorization: Bearer <jwt>` or `X-Hive-Username`, `X-Hive-Signature` (account must have `custody: "light"`)

**Body:**

```json
{
  "password": "SecurePass123"
}
```

`password` is REQUIRED. No per-op target binding: session-kind proofs do NOT carry an `(action, root_author, root_permlink)` triple and are issued for the JWT subject only. They are admitted only on the non-consent broadcast surface; submitting one to a consent-op bundle returns 403 `FRESH_AUTH_REQUIRED` with `details.reason: "kind_mismatch"`.

**Response `data`:**

```json
{
  "fresh_auth_proof": "<single-use token>",
  "expires_at": "2026-05-06T12:05:00.000Z",
  "mechanism": "password"
}
```

`fresh_auth_proof` is a single-use bearer token bound to the JWT subject (no target binding). TTL is 5 minutes. Submit it as the `fresh_auth_proof` field on a subsequent `POST /api/custody/broadcast` request whose bundle does NOT contain a consent op.

**Rate limit:** 10 requests per account per minute.

**Errors:**
- `UNAUTHORIZED` (401) — missing JWT, account not found, no password mechanism on the account (`password_hash IS NULL`, e.g. State C ORCID-only accounts; these users mint via `POST /api/orcid/start { mode: "session_auth" }` instead), or password mismatch. The "no password set" case returns the same shape as wrong-password to avoid becoming a password-existence oracle.
- `FORBIDDEN` (403) — account has been upgraded to self-custody. Self-custody users sign non-consent ops directly via Hive Keychain and do not use this endpoint.
- `VALIDATION_ERROR` (400) — missing or empty `password`.
- `INTERNAL_ERROR` (500) — argon2 verification failure or unexpected error.
- `SERVICE_UNAVAILABLE` (503) — argon2 capacity exhausted or backend draining. See [common.md](common.md).

---

### POST /api/custody/upgrade

Notify the backend that the user has completed a client-side key upgrade to self-custody. The backend verifies a seed-phrase-derived-pubkey proof, deletes stored encrypted keys, and issues a new JWT. Per ARCHITECTURE.md § 6.4 the upgrade action's required re-auth is the seed-phrase-derived pubkey (not password); per § 6.5 invariant #6 the seed phrase is the upgrade proof, not a session-auth factor.

**Headers:** `Authorization: Bearer <jwt>` or `X-Hive-Username`, `X-Hive-Signature` (account must have `custody: "light"`)

**Body:**

```json
{
  "derived_pubkey": "STM<base58>",
  "signed_proof": "<hex signature>",
  "signed_at": "<ISO-8601 timestamp, within 60s of request>"
}
```

`derived_pubkey` is the public key the UI derives client-side from the BIP39 seed phrase (the same seed generated at signup, never sent to the server). `signed_proof` is a hex-encoded Hive signature over the canonical challenge `${appTag}-custody-upgrade|v1|${username}|${signed_at}`, signed with the seed-derived private key. `signed_at` is the timestamp baked into the challenge; the backend rejects timestamps outside a 60-second window relative to wall-clock time.

The backend verifies the proof by (a) checking the timestamp window, (b) recovering the signing pubkey from `signed_proof` and timing-safe-comparing it to `derived_pubkey`, and (c) confirming `derived_pubkey` appears in the on-chain account's `posting`, `active`, or `owner` key_auths (fetched via Hive RPC). Any failure collapses to a uniform `401 UNAUTHORIZED` with a generic message so the route does not become a chain-state / signature-validity oracle.

**Response `data`:**

```json
{
  "custody": "self",
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_at": "2026-04-15T12:00:00Z"
}
```

**Rate limit:** 1 request per account per hour.

**Errors:**
- `NOT_FOUND` — account not found
- `FORBIDDEN` — account is not a light account (self-custody or upgraded account submitting the upgrade endpoint)
- `VALIDATION_ERROR` (400) — missing or non-string `derived_pubkey`, `signed_proof`, or `signed_at`
- `UNAUTHORIZED` (401) — proof verification failed. Uniform message and status for all of: `signed_at` outside the 60s freshness window, malformed `signed_proof`, signature recovery returns a pubkey that does not match `derived_pubkey`, `derived_pubkey` not present in the on-chain account's key_auths, or no on-chain account exists for the username. Server-side telemetry discriminates via `event:` slugs (`custody.upgrade.proof_malformed`, `custody.upgrade.pubkey_binding_mismatch`, `custody.upgrade.chain_key_mismatch`, `custody.upgrade.hive_account_missing`); the wire envelope is intentionally non-discriminating to prevent oracle behavior.
- `ALREADY_UPGRADED` (409) — account already upgraded (`upgraded_at IS NOT NULL`). Fires before proof verification.
- `SERVICE_UNAVAILABLE` (503) — Hive RPC unavailable during the on-chain key_auths lookup. Distinct from the prior argon2-based 503 (argon2 is no longer in the upgrade path). The message indicates retriability; clients SHOULD distinguish 503 from terminal errors and offer retry rather than routing to a permanent-failure screen.
