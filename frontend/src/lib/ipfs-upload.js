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

// Process-wide serialization of the password prompt across ALL upload sessions.
// The reauthModal is a singleton with a refuse-while-open guard: a second
// concurrent request() resolves to null. Two INDEPENDENT upload surfaces -- an
// editor inline-image upload (a one-shot session) and a publish/edit page batch
// (a session held across the batch) -- can each reach reauthModal.request() at
// the same time (e.g. the user drops an image into the body then immediately
// hits Submit). Without coordination the loser resolves null and surfaces
// UPLOAD_CANCELLED, silently dropping its upload. This chain queues every
// session's prompt so only one reauthModal.request() is ever in flight; the next
// waiter prompts only after the previous prompt settles. The serialization lives
// entirely in the upload layer, so the reauthModal contract -- and its non-upload
// settings-action caller -- is untouched.
let promptChain = Promise.resolve();

function withPromptLock(requestPrompt) {
  // Queue behind whatever prompt is currently in flight, then run requestPrompt
  // (the reauthModal.request() call). Advance the chain regardless of how the
  // prompt settles so a cancelled or failed prompt never wedges the gate for the
  // next waiter.
  const run = promptChain.then(() => requestPrompt());
  promptChain = run.then(() => undefined, () => undefined);
  return run;
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
  // A password re-prompt costs one modal interaction; bound it to once per
  // session so a session-JWT expiry or a mid-batch password change (which makes
  // the mint return UNAUTHORIZED again, with a now-correct password) cannot loop
  // the user through endless prompts. Once a re-prompt has fired, a further
  // UNAUTHORIZED rethrows instead of prompting a third time.
  let repromptUsed = false;

  function isLight() {
    return Alpine.store('auth')?.custody === 'light';
  }

  // Resolve the light-account credential exactly once per batch. Blocks State C
  // (passwordless, ORCID-only) before prompting — the backend returns an
  // indistinguishable 401 for wrong-password and no-password, so `hasPassword`
  // from the account status is the only clean State-C discriminator. A failed
  // status fetch (transient network error) must NOT dead-end a valid
  // password-holder: only an explicit `hasPassword === false` blocks; on a
  // thrown/unknown status we fall through to the prompt, and the backend
  // re-verifies and 401s a genuine passwordless account at mint time anyway.
  async function ensureCredential() {
    if (credentialResolved) return;
    let hasPassword;
    try {
      const status = await fetchEmailStatus();
      hasPassword = status?.data?.hasPassword;
    } catch {
      hasPassword = undefined;
    }
    if (hasPassword === false) {
      throw new UploadSessionError(
        UPLOAD_REAUTH_UNAVAILABLE,
        'Uploads require a password on this account',
      );
    }
    // Serialize the prompt across all upload sessions (see promptChain above) so
    // a concurrent editor-image and page-batch upload never collide on the
    // singleton modal and cancel each other.
    const entered = await withPromptLock(() => Alpine.store('reauthModal').request());
    if (entered === null || entered === undefined) {
      throw new UploadSessionError(UPLOAD_CANCELLED, 'Upload cancelled');
    }
    password = entered;
    credentialResolved = true;
  }

  // Mint a single-use proof. On the first UNAUTHORIZED (wrong cached password)
  // re-prompt once and retry; a subsequent UNAUTHORIZED rethrows rather than
  // prompting again, so a JWT expiry or a server-side credential change cannot
  // trigger an unbounded chain of password prompts.
  async function mintProof() {
    try {
      return await mintIpfsUploadProof(password);
    } catch (err) {
      if (err?.code === 'UNAUTHORIZED' && !repromptUsed) {
        repromptUsed = true;
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
      // retry once. The retry mint reuses the cached password and normally needs
      // no prompt; if it does return UNAUTHORIZED, mintProof re-prompts at most
      // once per session (the repromptUsed bound above) and otherwise rethrows.
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
      repromptUsed = false;
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
