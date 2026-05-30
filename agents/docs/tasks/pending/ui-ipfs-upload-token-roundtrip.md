# UI-IPFS-UPLOAD-TOKEN-ROUNDTRIP — SPA upload flow must do the two-step pre-flight + token round-trip

**Owner:** UI Agent
**Created:** 2026-05-30 (handoff from backend `backend-ipfs-upload-bind-file-to-signature`, flagged for the architect to file)
**Priority:** P1 (the SPA upload path is broken until this lands — `POST /api/ipfs/upload` now requires an `X-Upload-Token` header)

## Problem

The backend bound uploads to a single-use, fresh-auth-gated token. `POST /api/ipfs/upload` now rejects any request without a valid `X-Upload-Token` (401) and rejects a token whose declared SHA-256 does not match the uploaded bytes (400). The SPA's current single-shot upload in `frontend/src/api.js` will 401 until it adopts the two-step flow.

## Goal

Change the SPA upload to:
1. Compute the file's SHA-256 client-side (e.g. `crypto.subtle.digest('SHA-256', bytes)` → lowercase hex).
2. `POST /api/ipfs/upload-token` with `{ file_sha256, mimetype, size }`. On the light-account/JWT path, attach a `fresh_auth_proof` (mint one via the existing fresh-auth flow — see `backend-ipfs-upload-token-proof-binding` for whether this stays a session proof or becomes a per-action proof; coordinate before building). On the Keychain/signature path, the signed request body-hashes the descriptor automatically — no extra proof.
3. `POST /api/ipfs/upload` (multipart) with the returned token in the `X-Upload-Token` header.

## Acceptance

1. A successful supplementary-file upload works end-to-end from the SPA for both the Keychain path and the light-account/JWT path.
2. The SHA-256 sent in the pre-flight matches the bytes uploaded (no 400 mismatch on the happy path).
3. Clear UI error handling for `FRESH_AUTH_REQUIRED` (prompt re-auth), token expiry (re-mint), and SHA-256 mismatch.
4. Existing publish/edit flows that attach supplementary files continue to work.

## Blocked-by note

Confirm the proof kind with `backend-ipfs-upload-token-proof-binding` before wiring the JWT-path `fresh_auth_proof` so the client mints the correct kind. If that decision is still open when this is picked up, move to `blocked/` with a `[BLOCKED by Backend]` note.

## References

- `frontend/src/api.js` — `authenticatedRequest` (JWT path) and `signRequest` (Keychain path); the current upload call.
- `agents/docs/api-contracts/ipfs.md` — the `/upload-token` + `/upload` contract (request/response/error shapes, `X-Upload-Token`).
- `backend/src/routes/ipfs.ts` — the server side (for the exact field names and error codes).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
