# BACKEND-IPFS-UPLOAD-BIND-FILE-TO-SIGNATURE — bind uploaded file to signed envelope; require fresh-auth on JWT path

**Owner:** Backend Agent
**Created:** 2026-05-30 (security audit workflow)
**Priority:** P2 (stolen-JWT impersonation: arbitrary content pinned under victim's account; potential illegal-content liability)

## Problem

`POST /api/ipfs/upload` in `backend/src/routes/ipfs.ts` is registered as `verifyHiveSignature, ipfsUploadLimiter, handler` and the handler then runs `upload.single('file')` (multer) INSIDE itself.

The signature path: `verifyHiveSignature` canonicalizes the signed message as

```
{appTag}-auth|v1|POST|/api/ipfs/upload|sha256(JSON.stringify(req.body ?? {}))|{timestamp}
```

At signature-check time the multipart body has not been parsed (`express.json` skips multipart, and multer has not run yet), so `req.body` is `{}` and the body hash is `sha256('{}')`. The actual uploaded bytes never enter the signed envelope. A captured Keychain signature for `/api/ipfs/upload` is a generic upload-anything token for the 60-second timestamp window.

The JWT path: the SPA always uses the Bearer JWT path (`frontend/src/api.js`'s `authenticatedRequest`). The JWT branch in `verifyHiveSignature` skips all freshness/binding checks — no `fresh_auth_proof`, no per-request signature, no body binding. Any attacker who steals a victim's JWT (XSS, malicious browser extension, exfiltrated localStorage) can pin arbitrary files (including illegal content) to PEvO's IPFS infrastructure with `uploader_account = victim` recorded in `pending_ipfs_uploads`. The accreditation check at the handler entry is no defense if the victim IS accredited.

This is the highest single-finding blast-radius issue from the first-pass audit. It also composes with the IPFS gateway Content-Type defect (separate task) — once the gateway is hardened, this remains as a JWT-impersonation surface.

## Goal

Bind the file content to the auth envelope on every code path. Single uniform mechanism preferred over branching by auth method.

## Fix sketch

Two complementary changes; (1) is the structural fix, (2) closes the JWT path independently.

1. **Pre-flight body-binding.** Require the client to POST a small JSON pre-flight to a new endpoint, e.g. `POST /api/ipfs/upload-token` with body `{ file_sha256, mimetype, size }`. The pre-flight is body-hashed by the existing canonical (works for Keychain signature) AND requires a fresh-auth proof (works for JWT path), and returns a single-use upload token (Redis-backed, 60s TTL, scoped to the declared file_sha256). The actual file upload then goes to `POST /api/ipfs/upload` carrying the upload token in a header; the handler computes `sha256(file.buffer)` after multer parses and rejects the upload if the hash does not match the token's declared hash. This makes body-binding uniform across Keychain and light-account paths without extending `buildCanonicalAuthMessage`.

2. **Fresh-auth on the JWT path.** Independent of (1), require a `fresh_auth_proof` (session-kind token, the same primitive used by `/api/custody/broadcast`'s non-consent branch) on `/api/ipfs/upload` when the auth method is JWT. A stolen JWT alone cannot pin files; the attacker must also obtain a fresh-auth proof, which is single-use and short-lived.

Implementer's call on whether to land (1) and (2) together or stage them. Landing (1) makes (2) partially redundant on the structural axis but the fresh-auth requirement still helps reduce the per-request exposure window.

## Acceptance

1. **Body-binding enforced.** Test: a request with a valid auth envelope (signature OR JWT + fresh-auth proof) but a file whose sha256 does not match the declared/upload-token hash returns 400/401; the file is NOT pinned; no row inserted in `pending_ipfs_uploads`.
2. **Capture-and-replay defeated on the signature path.** Test: capture a signed upload-token request from a legitimate flow; replay it with a DIFFERENT file. Expected: request fails (token tied to the original sha256). Confirms the file content is now bound to the signed envelope.
3. **Stolen-JWT cannot pin without fresh-auth.** Test: a valid JWT without an accompanying fresh-auth proof on `/api/ipfs/upload` returns 401/403 with a clear error code (`FRESH_AUTH_REQUIRED` or equivalent). The legitimate flow (mint a fresh-auth proof, then upload) succeeds.
4. **Legitimate flow works end-to-end.** Test: the SPA's actual call sequence (mint fresh-auth proof, declare pre-flight, upload) successfully pins a file and records `uploader_account = user` in `pending_ipfs_uploads`. Magic-byte and accreditation gates still apply.
5. **Rate-limit interaction.** `ipfsUploadLimiter` still applies; the pre-flight endpoint also gets a reasonable rate limit (suggest reusing the same limiter or a sibling).
6. **Mutation-kill:** revert the sha256 comparison OR the fresh-auth requirement → the respective acceptance test goes RED.

## Out of scope

- Magic-byte / MIME validation on the upload path (existing behavior preserved; SVG handling covered in `backend-ipfs-gateway-content-type-and-cid-scope`).
- Frontend SPA changes beyond the new pre-flight + token round-trip (UI agent picks this up after the backend ships the contract).
- Migrating the auth envelope shape itself; the canonical stays as-is for non-upload routes.

## References

- `backend/src/routes/ipfs.ts` — `POST /upload` handler; signature-vs-JWT branching.
- `backend/src/middleware/verifyHiveSignature.ts` — Keychain-signature canonicalization (`buildCanonicalAuthMessage` or equivalent); JWT branch (lines around the body-hash skip).
- `backend/src/routes/custody.ts` — `/broadcast` fresh-auth-proof pattern to mirror (the session-kind token primitive and its consume-once Redis semantics).
- `backend/src/lib/freshAuth.ts` (or wherever the fresh-auth token primitive lives).
- `frontend/src/api.js` — `authenticatedRequest` (JWT path the SPA actually uses today) and `signRequest` (Keychain path).
- `agents/docs/ARCHITECTURE.md` § 6.5 — invariant that JWT-only access on critical actions is a security defect.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Backend implementation note (2026-05-30)

Landed the full approach (1)+(2) per the user's call.

**What shipped (backend):**
- New `POST /api/ipfs/upload-token` pre-flight. Body `{ file_sha256, mimetype,
  size }`. On the signature path the body is hashed into the signed envelope
  (so the declared sha256 is bound); on the JWT path it additionally requires a
  single-use **session** fresh-auth proof (`fresh_auth_proof` in body, consumed
  via `consumeSessionFreshAuthToken`). Returns `{ upload_token, expires_in: 60 }`.
- `POST /api/ipfs/upload` now requires an `X-Upload-Token` header. After multer
  parses, the handler consumes the token (single-use) and rejects unless
  `sha256(file.buffer)` matches the token's declared hash. A stolen JWT alone
  cannot pin (it cannot mint a token without fresh-auth); a captured pre-flight
  cannot pin a different file (sha256 mismatch).
- New single-use store `backend/src/lib/ipfs-upload-token.ts` (Redis-primary +
  in-memory fallback, 60s TTL, account-bound), mirroring the fresh-auth store.
- Error codes reused (no new `ErrorCode`): missing/invalid token → 401
  `UNAUTHORIZED`; sha256 mismatch → 400 `BAD_REQUEST`; JWT-without-fresh-auth →
  401 `FRESH_AUTH_REQUIRED`.

**[TODO Architect] `api-contracts/ipfs.md` contract updates:**
1. Document `POST /api/ipfs/upload-token` (request body, the JWT-path
   `fresh_auth_proof` requirement, the `{ upload_token, expires_in }` response).
2. `POST /api/ipfs/upload` now requires the `X-Upload-Token` header and 401s
   without a valid one; note the sha256-binding 400.

**[TODO Architect] file a UI follow-up task.** The SPA's `frontend/src/api.js`
upload flow must change to a two-step round-trip: compute the file sha256,
`POST /upload-token` (attaching a fresh-auth proof on the light-account/JWT
path), then `POST /upload` with the returned token in `X-Upload-Token`. This is
a `ui-*` task (UI zone), so the backend cannot create the task file itself
without tripping the commit zone-audit hook — flagging it here for the architect
to spin up.
