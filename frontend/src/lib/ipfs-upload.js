import { uploadFileToIpfs } from '../api.js';
import { ensureSessionWindow, clearCachedSessionProof } from './fresh-auth.js';

// Error codes thrown by the upload path that the page layer maps to a
// user-facing message via `describeUploadError`. Keeping them here (not raw
// strings in the pages) means a copy/behavior change updates one site.
export const UPLOAD_CANCELLED = 'UPLOAD_CANCELLED';
export const UPLOAD_REAUTH_FAILED = 'UPLOAD_REAUTH_FAILED';

class UploadSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'UploadSessionError';
  }
}

// Map an upload failure to a stable i18n key for the toast / inline message so
// the page layer never has to branch on raw error codes.
export function describeUploadError(err) {
  switch (err?.code) {
    case UPLOAD_CANCELLED:
      return 'common.uploadCancelled';
    case UPLOAD_REAUTH_FAILED:
      return 'settings.reauthFailed';
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
// A dismissed modal and an in-flight redirect both surface as UPLOAD_CANCELLED:
// the user is either stopping deliberately or navigating away, and neither
// warrants an error. A spent re-auth surfaces as UPLOAD_REAUTH_FAILED.
async function windowProof() {
  const outcome = await ensureSessionWindow();
  if (outcome.ready) return outcome.proof;
  if (outcome.failed) {
    throw new UploadSessionError(UPLOAD_REAUTH_FAILED, 'Re-authentication failed');
  }
  throw new UploadSessionError(UPLOAD_CANCELLED, 'Upload cancelled');
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
    return await uploadFileToIpfs(file, { freshAuthProof: proof });
  } catch (err) {
    // The window can close between the pre-flight and the upload on a slow
    // connection (UNAUTHORIZED at /upload) or be rejected outright
    // (FRESH_AUTH_REQUIRED at /upload-token). Re-acquire once and retry. The
    // re-acquisition is a real re-auth act, not a silent re-mint: a closed
    // window is the user's to reopen.
    if (err?.code === 'UNAUTHORIZED' || err?.code === 'FRESH_AUTH_REQUIRED') {
      // Drop the dead window first, or the re-acquisition is a cache hit on the
      // very proof the backend just rejected and the retry fails identically.
      clearCachedSessionProof();
      const retryProof = await windowProof();
      return uploadFileToIpfs(file, { freshAuthProof: retryProof });
    }
    throw err;
  }
}
