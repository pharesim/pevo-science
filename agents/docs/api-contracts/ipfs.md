# PEvO API Contract — IPFS

Endpoints for file upload and IPFS gateway proxy.

---

### POST /api/ipfs/upload-token

Pre-flight that binds a declared file to the authenticated request before the actual upload. Mints a single-use token scoped to the declared file SHA-256. This closes two vectors on `POST /api/ipfs/upload`: a stolen JWT alone cannot pin (it cannot mint a token), and a captured pre-flight cannot pin a different file (the upload re-checks the SHA-256 against the token).

**Request:** JSON body.

```json
{
  "file_sha256": "<64-char lowercase hex SHA-256 of the file bytes>",
  "mimetype": "application/pdf",
  "size": 2048576,
  "fresh_auth_proof": "<ipfs_upload-targeted fresh-auth proof; JWT path only>"
}
```

**Auth:**
- **Signature (Keychain) path:** the per-request Hive signature already body-hashes this JSON descriptor into the signed envelope, so the declared SHA-256 is bound to the signature. No `fresh_auth_proof` is needed.
- **JWT (light-account) path:** a single-use per-action `fresh_auth_proof` bound to `action='ipfs_upload'` is required in addition to the JWT, per ARCHITECTURE.md § 6.5 invariant #1 (a replayable JWT alone must not reach a critical action). The per-action binding means a target-less session proof minted for a vote or comment cannot be redirected here. Mint one via `POST /api/custody/fresh-auth` with `action='ipfs_upload'` (password) or `POST /api/orcid/start mode='fresh_auth' action='ipfs_upload'` (ORCID).

**Validation:** `file_sha256` must be 64-char hex; `mimetype` must be in the accepted-types set below; `size` must be a positive integer within the upload limit. The account must be accredited (same gate as the upload itself, checked here so the pre-flight fails fast).

**Rate limit:** 30 requests per account per hour (its own bucket, separate from the upload pin cap).

**Response `data`:**

```json
{
  "upload_token": "<single-use token>",
  "expires_in": 60
}
```

**Errors:**
- `FRESH_AUTH_REQUIRED`: JWT path with a missing or invalid `fresh_auth_proof`. Returns 401 when no usable proof is present (missing, expired, or malformed), and 403 on a binding violation (a proof for a different username, a different action target, or the wrong proof kind such as a target-less session proof). The `details.reason` field distinguishes the sub-cases. Mirrors the consent-op consume on `POST /api/custody/broadcast`.
- `BAD_REQUEST` — `file_sha256` is not a valid 64-char hex digest.
- `INVALID_FILE_TYPE` (422) — `mimetype` is not in the accepted set.
- `FILE_TOO_LARGE` (413) — declared `size` exceeds the configured limit.
- `FORBIDDEN` — the account is not accredited.

---

### POST /api/ipfs/upload

Upload a file and pin it to IPFS. Uses the local Kubo node by default; falls back to Pinata when configured and Kubo is unavailable.

**Request:** `multipart/form-data` with a `file` field (max size set by `MAX_UPLOAD_SIZE` config).

**Accepted types:** PDF, PNG, JPEG, GIF, WebP, CSV, ZIP. Magic bytes are validated server-side. SVG is not accepted: it is a scriptable XML document the magic-byte check cannot safely sanitize.

**Headers:**
- `X-Hive-Username` and `X-Hive-Signature` (or a Bearer JWT) to authenticate as an accredited user.
- `X-Upload-Token` — the single-use token returned by `POST /api/ipfs/upload-token`. Required. After multer parses the file, the handler consumes the token and rejects the upload unless `sha256(file)` matches the SHA-256 declared when the token was minted.

**Rate limit:** 10 requests per account per hour.

**Response `data`:**

```json
{
  "cid": "QmXyz...",
  "size": 2048576,
  "filename": "paper.pdf",
  "type": "application/pdf"
}
```

**Errors:**
- `UNAUTHORIZED` (401) — invalid signature, or a missing/invalid/expired `X-Upload-Token`.
- `BAD_REQUEST` (400) — the uploaded file's SHA-256 does not match the token's declared hash.
- `FORBIDDEN` — user is not accredited.
- `INVALID_FILE_TYPE` — unsupported type or magic bytes mismatch.
- `FILE_TOO_LARGE` — exceeds configured size limit.
- `SERVICE_UNAVAILABLE` (503) — the upload-tracking store (app DB) is unavailable, so a durable pin record cannot be written; the pin is refused before it is attempted. Retry later. Carries no `details.reason`.
- `INTERNAL_ERROR` (500) — no IPFS backend is configured, or the durable `pending_ipfs_uploads` insert failed after a successful pin (the handler then attempts to unpin and reports failure). A 200 is returned only once the tracking row exists.

---

### GET /api/ipfs/:cid

Validated IPFS gateway proxy. Serves file content only for CIDs referenced by known PEvO papers (checked against HAF metadata, the `pending_ipfs_uploads` table for recent uploads, and a Redis cache as a fast path). The HAF reference check additionally requires the referencing comment's author to be currently accredited, so a free unaccredited account cannot whitelist an arbitrary externally-pinned CID. Unknown CIDs return 404.

**Rate limit:** 60 requests per minute per IP.

**Response:** Streams the file content with `Cache-Control: public, max-age=31536000, immutable`.

**Served Content-Type is allow-listed.** Only the script-execution-safe MIME types (PDF, PNG, JPEG, GIF, WebP, CSV, ZIP) are passed through with their advertised `Content-Type`. Any other upstream type (for example `text/html`, `image/svg+xml`, `application/javascript`) is served as `Content-Type: application/octet-stream` with `Content-Disposition: attachment; filename="<cid>"`, so a pinned HTML/SVG/JS CID cannot execute script under the app origin.

**Isolation headers on every `/api/ipfs/*` response** (gateway and upload routes alike): `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`, and `Cross-Origin-Resource-Policy: same-site`. These reinforce the allow-list: even an HTML body lands in an opaque origin and cannot read the parent origin's storage or call same-origin APIs.

**Errors:**
- `BAD_REQUEST` — invalid CID format.
- `NOT_FOUND` — CID not referenced by any PEvO paper (or referenced only by unaccredited authors).
- `INTERNAL_ERROR` (502) — IPFS gateway unavailable.
