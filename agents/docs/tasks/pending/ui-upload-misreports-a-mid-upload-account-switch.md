# An upload misreports an account switch that lands mid-upload

**Owner:** ui
**Created:** 2026-10-08
**Priority:** low

Routed out of the architect archive of the upload mismatch-after-subject-change task
(archived 2026-10-08): the implementer's out-of-scope findings 3 and 4, confirmed against
the code at filing. Both are pre-existing and need a cross-tab account switch inside a
short window.

## Why

`uploadFile` (`lib/ipfs-upload.js`) opens a subject teardown guard so that a cross-tab
sign-in during an upload unwinds with one subject-change message and the silent
`UPLOAD_SUBJECT_CHANGED` code. Two sequences get past it.

1. **A custody switch while the file hashes.** `uploadFileToIpfs` (`api.js`) reads
   `auth.username` before `await sha256File(file)` and `auth.custody` after it.
   - Self-custody to light: `uploadFile` took its no-window branch, so it passes no proof.
     After the hash the store reads light, and `uploadFileToIpfs` throws
     `FRESH_AUTH_REQUIRED` (`reason: 'missing'`) client-side. That branch's catch consults
     only `unwindIfSessionEnded`, which acts on `SESSION_EXPIRED` and `SESSION_INVALIDATED`,
     so the error is rethrown raw and `describeUploadError` maps it to the generic upload
     failure. No subject-change message is shown.
   - Light to self-custody: the store reads self after the hash, so the pre-flight calls
     `signRequest` with the username read before it. Keychain is asked to sign as the
     departed account.
2. **A sign-in between the pre-flight and the transfer.** `POST /api/ipfs/upload` checks
   accreditation before it consumes the upload token, which is bound to the departed
   account. An accredited successor gets 401 `UNAUTHORIZED`, an unaccredited one 403
   `FORBIDDEN`.
   - Windowed branch: `retryOnce` already unwinds the 401 as a subject change. The 403 is
     rethrown raw.
   - No-window (self-custody) branch: the catch consults only `unwindIfSessionEnded`, so
     both are rethrown raw.

   A raw rethrow shows the generic upload failure and no subject-change message.

## Scope

1. A rejection that surfaces after the upload's guard reads torn-down unwinds as a subject
   change (`guard.cancel()`, then `UPLOAD_SUBJECT_CHANGED`) on both the no-window and the
   windowed branch, including every code above.
2. The light-to-self sequence must not ask Keychain to sign for an account the tab no
   longer holds. Re-reading the username after the hash is not a fix: it would sign the
   departed account's file in as the new account, the outcome the guard exists to prevent.
   Ask if the place for the check is unclear.

## Acceptance criteria

1. Each sequence in "Why" ends with one subject-change message and `UPLOAD_SUBJECT_CHANGED`,
   no upload-failed message on top, and the new account still signed in.
2. The light-to-self sequence sends no Keychain signing request.
3. Each sequence is pinned by a unit test that fails if its fix is removed.
4. Full frontend unit suite green; `npm run build` clean.
