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

## [BLOCKED by Backend] (2026-05-30) — RESOLVED 2026-06-08 (architect, moved to `tasks/pending/`)

**RESOLVED 2026-06-08.** The backend posture decision landed: `backend-ipfs-upload-token-proof-binding` archived 2026-06-06 choosing **(b) per-action target binding**. ARCHITECTURE.md § 6.4 no longer carries the "under review" note and documents that the JWT path requires a per-action `ipfs_upload`-targeted fresh-auth proof (target `(ipfs_upload, <username>, '')`); `api-contracts/ipfs.md` documents the per-action requirement; the server validates it via `ipfsUploadFreshAuthTarget` (`backend/src/lib/fresh-auth.ts`) in the upload-token route. The SPA must mint the per-action proof via `POST /api/custody/fresh-auth` with `action='ipfs_upload'` (password path) or `POST /api/orcid/start` with `mode='fresh_auth' action='ipfs_upload'` (ORCID path) before requesting the upload token. Original blocking detail preserved below.

The JWT-path proof kind is still undecided. `backend-ipfs-upload-token-proof-binding`
remains in `tasks/pending/` with its (a) session-class vs (b) per-action target-binding
decision unresolved, and ARCHITECTURE.md § 6.4 (Issue IPFS upload token row) still carries
"The session-proof choice (vs a per-action target binding) is under review in
`backend-ipfs-upload-token-proof-binding`." Per this task's "Blocked-by note", the SPA must
not be wired until the proof kind is fixed, or it will mint the wrong proof for the JWT path.

Unblock condition: backend lands the posture decision, removes the § 6.4 "under review" note,
and (if the decision is (b)) documents the per-action `action`/target the client must bind.
Backend moves this file back to `tasks/pending/` once resolved.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## UI implementation note (2026-06-08)

Implemented the two-step SPA upload. **This is auth-touching — apply the account-state
defense review (§ 6.1 / 6.4 / 6.5) at review intake.**

**Shape.** New per-file two-step HTTP in `frontend/src/api.js` (`uploadFileToIpfs`,
`mintIpfsUploadProof`); batch orchestration in new `frontend/src/lib/ipfs-upload.js`
(`createUploadSession` / `uploadFile` / `describeUploadError`); new promise-based password
modal `frontend/src/components/reauth-modal.js` (+ template in `index.html`, init in
`main.js`, modeled on `broadcast-confirm`). Callsites `publish.js` / `edit.js` wrap the
upload region in one session (`dispose()` in `finally`); `editor.js` inline-image upload
uses the single-shot `uploadFile`.

**Paths.**
- **Keychain (self):** signs the upload-token descriptor (binds the SHA-256, no proof). The
  upload step is gated by the single-use `X-Upload-Token`, not the auth method, so it goes
  out with the session JWT — self-custody pays exactly ONE Keychain prompt per file (the
  descriptor signature), not two. Relies on `verifyHiveSignature` skipping the proof on the
  signature branch (ipfs.ts upload-token handler) and accepting JWT on `/upload`.
- **Light + password (State A/B):** one password prompt per batch (held in the session
  closure, wiped on dispose), a fresh single-use `ipfs_upload`-targeted proof minted per file
  via `POST /api/custody/fresh-auth`. Wrong password re-prompts once; token-expiry re-mints +
  retries once.
- **Light, ORCID-only (State C, passwordless):** blocked up front with a "set a password in
  Settings" message (`common.uploadReauthRequired`). State C is detected via
  `fetchEmailStatus().data.hasPassword === false` (the backend returns an indistinguishable
  401 for wrong-password vs no-password, so the account-status flag is the only clean
  discriminator).

**Product decisions** (confirmed with the user, since the task text did not resolve them):
one password prompt per upload batch (vs per file), and block State C with a "set a password"
message (vs an ORCID redirect + file re-attach, which a `File` cannot survive across a
full-page navigation). A follow-up is NOT filed — State C users set a password once, then
upload normally.

**i18n.** Added `common.confirm`, `common.uploadReauthRequired`, `common.uploadCancelled`,
`reauth.title`, `reauth.message` to `en.json`; English stubs into the 15 other locales;
STUBS.md sweep `### Added 2026-06-08 (UI-IPFS-UPLOAD-TOKEN-ROUNDTRIP)`.

**Tests.** New `tests/unit/lib-ipfs-upload.test.js` (custody routing, State-C block,
prompt-once, per-file mint, wrong-password re-prompt, token retry, dispose) and
`tests/unit/components-reauth-modal.test.js`; upload HTTP-shape tests added to `api.test.js`
(self signs / light sends proof / X-Upload-Token); existing publish/edit/editor mocks
redirected from the old `uploadToIpfs` to the session. Full frontend unit suite green (1385);
build green. Not E2E-run (the two-step upload needs the full stack in test-mode); flagging for
the architect to decide whether an E2E spec is wanted before archive.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
