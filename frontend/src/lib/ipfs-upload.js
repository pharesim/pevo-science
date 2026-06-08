import Alpine from 'alpinejs';
import { uploadFileToIpfs, mintIpfsUploadProof, fetchEmailStatus } from '../api.js';

// Error codes thrown by the upload session that the page layer maps to a
// user-facing message via `describeUploadError`. Keeping them here (not raw
// strings in the pages) means a copy/behavior change updates one site.
export const UPLOAD_REAUTH_UNAVAILABLE = 'UPLOAD_REAUTH_UNAVAILABLE';
export const UPLOAD_CANCELLED = 'UPLOAD_CANCELLED';

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
    case UPLOAD_REAUTH_UNAVAILABLE:
      return 'common.uploadReauthRequired';
    case UPLOAD_CANCELLED:
      return 'common.uploadCancelled';
    default:
      return 'common.uploadFailed';
  }
}

// A batch-scoped uploader for one publish/edit action.
//
// Self-custody (Keychain) signs each file's pre-flight descriptor — one Keychain
// prompt per file, no shared state. Light accounts are prompted for their
// password ONCE per batch (held in this closure, wiped on `dispose`) and a
// fresh single-use proof is minted per file. ORCID-only (passwordless) light
// accounts cannot mint a proof inline, so they are blocked up front with
// UPLOAD_REAUTH_UNAVAILABLE before any password prompt.
export function createUploadSession() {
  let password = null;
  let credentialResolved = false;

  function isLight() {
    return Alpine.store('auth')?.custody === 'light';
  }

  // Resolve the light-account credential exactly once per batch. Blocks State C
  // (passwordless, ORCID-only) before prompting — the backend returns an
  // indistinguishable 401 for wrong-password and no-password, so `hasPassword`
  // from the account status is the only clean State-C discriminator.
  async function ensureCredential() {
    if (credentialResolved) return;
    const status = await fetchEmailStatus();
    if (status?.data?.hasPassword === false) {
      throw new UploadSessionError(
        UPLOAD_REAUTH_UNAVAILABLE,
        'Uploads require a password on this account',
      );
    }
    const entered = await Alpine.store('reauthModal').request();
    if (entered === null || entered === undefined) {
      throw new UploadSessionError(UPLOAD_CANCELLED, 'Upload cancelled');
    }
    password = entered;
    credentialResolved = true;
  }

  // Mint a single-use proof, re-prompting once if the cached password is wrong.
  async function mintProof() {
    try {
      return await mintIpfsUploadProof(password);
    } catch (err) {
      if (err?.code === 'UNAUTHORIZED') {
        password = null;
        credentialResolved = false;
        await ensureCredential();
        return mintIpfsUploadProof(password);
      }
      throw err;
    }
  }

  async function uploadOnce(file) {
    if (!isLight()) return uploadFileToIpfs(file);
    await ensureCredential();
    const proof = await mintProof();
    try {
      return await uploadFileToIpfs(file, { freshAuthProof: proof });
    } catch (err) {
      // The single-use token can expire/consume between mint and upload on a
      // slow connection (UNAUTHORIZED at /upload) or the proof can be rejected
      // (FRESH_AUTH_REQUIRED at /upload-token). Mint a fresh proof + token and
      // retry once; the cached password means no re-prompt.
      if (err?.code === 'UNAUTHORIZED' || err?.code === 'FRESH_AUTH_REQUIRED') {
        const retryProof = await mintProof();
        return uploadFileToIpfs(file, { freshAuthProof: retryProof });
      }
      throw err;
    }
  }

  return {
    upload: uploadOnce,
    dispose() {
      password = null;
      credentialResolved = false;
    },
  };
}

// Single-file convenience: open a session, upload, and always wipe the
// credential afterward. Use this for one-off uploads (e.g. an inline editor
// image); use `createUploadSession` directly for multi-file batches so the
// password prompt fires only once.
export async function uploadFile(file) {
  const session = createUploadSession();
  try {
    return await session.upload(file);
  } finally {
    session.dispose();
  }
}
