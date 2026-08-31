import { uploadFileToIpfs } from '../api.js';
import {
  ensureSessionWindow,
  slideSessionWindow,
  clearCachedSessionProof,
  handleSessionInconsistency,
  REMINTABLE_REASONS,
} from './fresh-auth.js';

// Error codes thrown by the upload path that the page layer maps to a
// user-facing message via `describeUploadError`. Keeping them here (not raw
// strings in the pages) means a copy/behavior change updates one site.
export const UPLOAD_CANCELLED = 'UPLOAD_CANCELLED';
export const UPLOAD_REAUTH_FAILED = 'UPLOAD_REAUTH_FAILED';
export const UPLOAD_REAUTH_REQUIRED = 'UPLOAD_REAUTH_REQUIRED';
export const UPLOAD_REAUTH_BUSY = 'UPLOAD_REAUTH_BUSY';
// Already-reported outcome: the session teardown in `uploadFile` has shown its
// own re-login toast before this code is thrown, so consumers must surface
// nothing on top of it (mirrors FRESH_AUTH_REDIRECT_PENDING's
// message-suppression contract on the broadcast surface). `describeUploadError`
// maps it to null rather than an i18n key.
export const UPLOAD_SESSION_TORN_DOWN = 'UPLOAD_SESSION_TORN_DOWN';

class UploadSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'UploadSessionError';
  }
}

// Map an upload failure to a stable i18n key for the toast / inline message so
// the page layer never has to branch on raw error codes. Returns null for the
// already-reported UPLOAD_SESSION_TORN_DOWN code: the teardown's re-login
// toast has fired by then, so there is no key to show and callers must stay
// quiet instead of stacking a generic upload-failure message on top.
export function describeUploadError(err) {
  switch (err?.code) {
    case UPLOAD_CANCELLED:
      return 'common.uploadCancelled';
    case UPLOAD_REAUTH_FAILED:
      return 'settings.reauthFailed';
    case UPLOAD_REAUTH_REQUIRED:
      return 'common.reauthRequired';
    case UPLOAD_REAUTH_BUSY:
      return 'common.reauthPromptOpen';
    case UPLOAD_SESSION_TORN_DOWN:
      return null;
    default:
      return 'common.uploadFailed';
  }
}

// Put a session window in hand for the upload pre-flight.
//
// `POST /api/ipfs/upload-token` accepts a live session-kind proof, so the
// upload leg and the broadcast leg share one window: publishing a paper with a
// PDF costs a single re-auth act rather than a password prompt for the upload
// plus a separate one for the broadcast. There is no per-batch plaintext
// password held anywhere, and no account state is locked out of inline upload —
// a passwordless account opens its window by ORCID round-trip before it ever
// picks a file (the acquire-before-commit rule the pages implement), so by the
// time an upload runs the window is already open and this is a cache hit.
//
// Two policies make that true rather than merely likely:
//
//   - No pre-flight margin (`minRemainingMs: 0`). The margin belongs at the
//     gates — file selection, submit entry, and immediately before the
//     broadcast — never inside a leg. Demanding it here would force a re-auth
//     mid-sequence on a window the broadcast leg would have accepted, which is
//     precisely the mid-flow interruption the gates exist to move earlier.
//
//   - No navigation (`allowRedirect: false`). By the time a leg runs there is
//     always something to lose: a picked image, a hashed PDF, a batch of
//     completed pins. A passwordless account whose window closed mid-batch gets
//     a non-navigating refusal it can act on, not a full-page ORCID round-trip
//     that discards the work. A password account still prompts inline, which
//     costs nothing.
//
// A dismissed modal and an in-flight redirect both surface as UPLOAD_CANCELLED:
// the user is either stopping deliberately or navigating away, and neither
// warrants an error. A spent re-auth surfaces as UPLOAD_REAUTH_FAILED, a
// suppressed round-trip as UPLOAD_REAUTH_REQUIRED — re-authenticate, then
// resubmit, with the form still intact — and a prompt already owned by a
// different action as UPLOAD_REAUTH_BUSY. The busy case must not fall through
// to UPLOAD_CANCELLED: the user never saw a prompt for this upload, so
// reporting an upload they cancelled is exactly the silent-drop ambiguity the
// busy sentinel exists to remove.
async function windowProof() {
  const outcome = await ensureSessionWindow({ minRemainingMs: 0, allowRedirect: false });
  if (outcome.ready) return outcome.proof;
  if (outcome.reauthRequired) {
    throw new UploadSessionError(UPLOAD_REAUTH_REQUIRED, 'Re-authentication required');
  }
  if (outcome.failed) {
    throw new UploadSessionError(UPLOAD_REAUTH_FAILED, 'Re-authentication failed');
  }
  if (outcome.busy) {
    throw new UploadSessionError(UPLOAD_REAUTH_BUSY, 'Another confirmation is open');
  }
  throw new UploadSessionError(UPLOAD_CANCELLED, 'Upload cancelled');
}

// One consume of the window: upload, then replay the idle slide the backend
// performed on the pre-flight but echoed nothing about. Without it the client
// falls behind the server by the whole upload duration and then evicts a token
// the server would still honour.
async function attemptOnce(file, proof) {
  const res = await uploadFileToIpfs(file, { freshAuthProof: proof });
  slideSessionWindow();
  return res;
}

// Upload one file to IPFS through the two-step pre-flight in `api.js`.
//
// Self-custody (Keychain) signs each file's pre-flight descriptor and needs no
// proof — `ensureSessionWindow` returns a null proof for it. Light accounts
// attach their live window proof.
export async function uploadFile(file) {
  const proof = await windowProof();
  if (!proof) return uploadFileToIpfs(file);

  try {
    return await attemptOnce(file, proof);
  } catch (err) {
    // Two failures look alike at the call site and must not be treated alike.
    //
    // FRESH_AUTH_REQUIRED comes from the pre-flight (`/ipfs/upload-token`) and
    // means the session window itself was rejected: drop it and re-acquire, a
    // real re-auth act.
    if (err?.code === 'FRESH_AUTH_REQUIRED' && REMINTABLE_REASONS.includes(err.details?.reason)) {
      clearCachedSessionProof();
      return attemptOnce(file, await windowProof());
    }
    // username_mismatch means the cached proof belongs to a different account
    // than the JWT subject — a corrupted session no re-mint can fix, because
    // every re-acquisition would replay the same mismatched pair. Tear the
    // session down and force re-login via the shared teardown, matching the
    // broadcast, settings, and authorship siblings; without it every retry
    // resends the same stale proof and the paper-upload path wedges behind a
    // generic failure until the window's cap. The teardown disconnects (which
    // drops the cached window) and shows the re-login toast; the thrown
    // already-reported code aborts the batch while telling the page layer the
    // teardown's toast was the whole message — rethrowing the raw error here
    // used to stack a generic upload-failure surface on top of it.
    if (err?.code === 'FRESH_AUTH_REQUIRED' && err.details?.reason === 'username_mismatch') {
      handleSessionInconsistency();
      throw new UploadSessionError(
        UPLOAD_SESSION_TORN_DOWN,
        'Session torn down. Sign in again.',
      );
    }
    // UNAUTHORIZED comes from the upload leg (`/ipfs/upload`) and means the
    // single-use upload token was refused. Not because a slow transfer outlived
    // the token's TTL — every request carries a 30-second abort composed in
    // api.js, so an upload aborts long before a 60-second token expires — but
    // through the other ways that status arrives: a token store evicted or
    // restarted between the two steps, or a token already consumed by a
    // duplicate of this request. None of that says anything about the session
    // window (the window is only consulted at the pre-flight), so clearing it
    // here would destroy a live window and charge the user a full re-auth act.
    // Retry the two-step once as a safety net; the pre-flight cache-hits the
    // live window and mints a fresh token.
    if (err?.code === 'UNAUTHORIZED') {
      return attemptOnce(file, await windowProof());
    }
    throw err;
  }
}
