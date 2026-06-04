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

## Architect re-review (2026-05-30) — HELD PENDING FIXES:

`/ce-code-review` (scoped to `5ad6bdbf` + `f8cbfc87`) confirmed the core goals are met: the descriptor is bound into the signed envelope, the sha256 binding is strong, `hiveAuthMethod` cannot be bypassed, and there is no JWT-only pin path. Four items before archive:

1. **Double-spend: the token store dropped the two single-use defenses its sibling `fresh-auth.ts` ships** (and the docblock claims to "mirror"): the synchronous in-flight-consume lock, AND the compensating `redis.del` on the memStore-fallback leg. A Redis-throw-on-consume (ready-but-throwing) lets request A consume from memStore while the Redis copy stays alive for request B to GETDEL after recovery — the same single-use token consumed twice. Add both (mirror `fresh-auth.ts` exactly). Add a regression test: issue with Redis present, force GETDEL to throw on consume A, assert consume B against the still-alive Redis copy is rejected.
2. **`X-Upload-Token` header cast lies about the `string[]` case.** `req.headers['x-upload-token'] as string | undefined` is wrong when the header is sent twice. Use `Array.isArray(raw) ? raw[0] : raw`. Safe today (consumeUploadToken rejects non-string) but the cast is dishonest.
3. **AC4 not asserted: `uploader_account` recording.** The happy-path test mocks `getAppPool` but never checks the query args, so "records `uploader_account = user` in `pending_ipfs_uploads`" (an explicit acceptance criterion) has no mutation-killing assertion. Add it.
4. **Clause-(c) real-path gap.** `ipfs-upload-real-path-verifyhivesignature.test.ts` exercises only `/upload` (which 400s on no-file before the token gate), NOT `/upload-token`. The sha256-binding-via-signed-envelope path has no real-crypto coverage, so the test header's clause-(c) claim is unmet. Per CLAUDE.md, either add a real-signature body-tamper test on `/upload-token` (sign one descriptor, submit a different `file_sha256` → 401) or correct the header and file a tracked follow-up.

Not blocking (handled elsewhere): the cross-surface session-proof scope is a design decision tracked in `backend-ipfs-upload-token-proof-binding`. The status-code mapping (only `username_mismatch`→403) is acceptable — session-consume never returns `target_mismatch`/`kind_mismatch`, so the collapsed branch is unreachable (optional defensive consistency only). Token-burned-on-pin-failure and proof-consumed-before-accreditation are accepted single-use UX residuals. The UI round-trip is filed as `ui-ipfs-upload-token-roundtrip`.

## Backend re-review signal (2026-06-04):

All four hold items landed, plus an in-scope fix for a pre-existing test breakage this task's own earlier migration caused.

1. **Double-spend defenses mirrored from `fresh-auth.ts`.** `lib/ipfs-upload-token.ts` now carries BOTH single-use defenses: (a) an in-process `inFlightConsumes` lock (`consumeUploadToken` does the synchronous `has`→`add` critical section, then delegates to `consumeUploadTokenLocked`, releasing in `finally`); (b) the compensating `redis.del` on the memStore-fallback leg (when GETDEL throws and the entry is consumed from memStore, the canonical Redis copy is best-effort deleted so a Redis-recovered replay can't GETDEL it a second time). Regression tests added in `ipfs-upload-token.test.ts` ("double-spend defenses" describe): the required compensating-del test (issue with Redis, GETDEL throws on consume A → A succeeds via memStore, B against the recovered Redis copy is rejected), the best-effort variant (GETDEL + del both throw, A still succeeds), and a concurrent dual-consume single-use test. The Redis-tier tests gate on a `redisAvailable` poll, mirroring `fresh-auth.test.ts`.
2. **`X-Upload-Token` header `string[]` honesty.** `routes/ipfs.ts` now reads `req.headers['x-upload-token']` and takes `Array.isArray(raw) ? raw[0] : raw` instead of the `as string | undefined` cast.
3. **AC4 asserted.** The happy-path test in `ipfs-upload-token.test.ts` now uses a stable `appQueryMock` and asserts the `pending_ipfs_uploads` INSERT args are `[cid, uploader_account=user, size, backend]`.
4. **Clause-(c) real-path gap closed.** `ipfs-upload-real-path-verifyhivesignature.test.ts` gained a `/upload-token` describe with real `verifyHiveSignature`: a descriptor tampered after signing (sign one `file_sha256`, submit another) → 401 (the real-crypto proof the descriptor is bound into the signed envelope), a correctly-signed-descriptor-passes-auth positive (400 at descriptor validation, before the HAF accreditation read, so it stays deterministic and HAF-free), and a missing-signature 401. The file docblock was broadened to name `ipfs-upload-token.test.ts` as a companion and explain why `/upload` alone could not cover this (it 400s on no-file before the token gate).

**In-scope regression fix (surfaced):** the token gate this task added in the prior round broke `ipfs-pin-durability.test.ts` (it POSTs `/upload` with no `X-Upload-Token`, so every request 401'd at the gate before reaching the durability state machine; vitest retries then exhausted the in-memory limiter → cascade of 429s). Confirmed pre-existing by stashing this round's changes and re-running (all 7 red identically at HEAD). Fixed in-scope per the user's stated preference for green-suite-in-scope on self-caused regressions: each spec now mints a real single-use upload token (the store's in-memory tier, since the file mocks redis null) bound to the posted bytes' sha256 and sends it in `X-Upload-Token`, and uses a distinct per-test account so a retry on one spec can't exhaust another's limiter bucket. All 7 green.

Verified: `npm run typecheck` clean; lint of `routes/ipfs.ts` + `lib/ipfs-upload-token.ts` clean; 45 tests pass across `ipfs-upload-token`, `ipfs-upload-real-path-verifyhivesignature`, `ipfs-pin-durability`, and `ipfs-gateway-hardening`.
