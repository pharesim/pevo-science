import { uploadFileToIpfs } from '../api.js';
import {
  ensureSessionWindow,
  slideSessionWindow,
  clearCachedSessionProof,
  handleSessionInconsistency,
  isUsernameMismatch,
  subjectTeardownGuard,
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
// Already-reported outcome for the other teardown shape: a cross-tab subject
// change abandoned the batch. Whatever owed the user a word about that
// teardown has already said it — the guard's own cancel, or the teardown that
// narrated itself — so this carries the same null-key silence contract as
// UPLOAD_SESSION_TORN_DOWN and the page layer must not stack an
// upload-cancelled or upload-failed message on top.
export const UPLOAD_SUBJECT_CHANGED = 'UPLOAD_SUBJECT_CHANGED';

class UploadSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'UploadSessionError';
  }
}

// Map an upload failure to a stable i18n key for the toast / inline message so
// the page layer never has to branch on raw error codes. Returns null for the
// already-reported codes (a torn-down session, a subject change abandoning
// the batch): the teardown's own toast has fired by then, so there is no key
// to show and callers must stay quiet instead of stacking a generic
// upload-failure message on top. The null key IS the page-layer contract for
// "this failure already spoke" — consumers branch on it, never on the
// individual codes, so a new already-reported code needs no page edits.
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
    case UPLOAD_SUBJECT_CHANGED:
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

// How each non-ready window outcome surfaces on this site: the pre-flight
// throws a coded error the page layer describes, rather than toasting
// directly. Keyed by the shared window-outcome vocabulary
// (`WINDOW_OUTCOME_KEYS` in lib/fresh-auth.js); the vocabulary-driven
// exhaustiveness suite pins this table against it, so a member added to the
// vocabulary without a row here is a failing test, not a silent
// misclassification as a cancel.
export const UPLOAD_CODE_BY_WINDOW_OUTCOME = Object.freeze({
  redirect: UPLOAD_CANCELLED,
  cancelled: UPLOAD_CANCELLED,
  failed: UPLOAD_REAUTH_FAILED,
  busy: UPLOAD_REAUTH_BUSY,
  reauthRequired: UPLOAD_REAUTH_REQUIRED,
});

// Internal Error.message text per code (developer-facing; the user-facing copy
// comes from `describeUploadError`'s i18n keys).
const UPLOAD_ERROR_TEXT = Object.freeze({
  [UPLOAD_CANCELLED]: 'Upload cancelled',
  [UPLOAD_REAUTH_FAILED]: 'Re-authentication failed',
  [UPLOAD_REAUTH_BUSY]: 'Another confirmation is open',
  [UPLOAD_REAUTH_REQUIRED]: 'Re-authentication required',
  [UPLOAD_SESSION_TORN_DOWN]: 'Session torn down. Sign in again.',
  [UPLOAD_SUBJECT_CHANGED]: 'Session changed. Upload abandoned.',
});

// Every UploadSessionError this module raises is built here, so the table above
// stays the per-code index its docblock claims rather than losing entries to
// inline strings at the raise sites.
const uploadError = (code) => new UploadSessionError(code, UPLOAD_ERROR_TEXT[code]);

async function windowProof(guard) {
  const outcome = await ensureSessionWindow({ minRemainingMs: 0, allowRedirect: false });
  if (outcome.ready) return outcome.proof;
  const outcomeKey = Object.keys(UPLOAD_CODE_BY_WINDOW_OUTCOME).find((key) => outcome[key]);
  // A cancelled outcome that coincides with a subject teardown is the
  // teardown's own unwind, not the user stopping: whatever spoke for that
  // teardown has already spoken by now (and where the cancel was the user's
  // own dismissal, the silence is the decision), so this outcome carries the
  // already-reported silent code rather than UPLOAD_CANCELLED — whose
  // upload-cancelled message the page would stack on top as a second toast.
  // The guard is consulted, never cancelled here: firing `guard.cancel()` at
  // this site too would be that same double report.
  if (outcomeKey === 'cancelled' && guard.tornDown()) {
    throw uploadError(UPLOAD_SUBJECT_CHANGED);
  }
  const code = outcomeKey ? UPLOAD_CODE_BY_WINDOW_OUTCOME[outcomeKey] : UPLOAD_CANCELLED;
  throw uploadError(code);
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

// Tear the session down and hand the caller the already-reported code. Shared
// by the first attempt and both retry legs so a mismatch reports identically
// whichever attempt surfaces it.
function tornDownSession() {
  handleSessionInconsistency();
  return uploadError(UPLOAD_SESSION_TORN_DOWN);
}

// One retry attempt: re-acquire the window, then upload. Both retry legs go
// through here so a `username_mismatch` surfacing on a SECOND attempt takes the
// same teardown the first attempt does. Written as a wrapper rather than two
// copies of the mismatch branch because the retries live in `uploadFile`'s
// single flat catch, where a rejection has no enclosing handler left and would
// otherwise escape raw — the page layer then stacks a generic upload failure on
// top of a session that was never torn down.
//
// Only a mismatch is reclassified. `windowProof()`'s own UploadSessionErrors
// (a dismissed prompt, a spent re-auth, a refused round-trip) are the coded
// vocabulary every consumer already describes, so they pass straight through.
async function retryOnce(file, guard) {
  // The re-acquisition reads the store at call time: past a cross-tab subject
  // change it would prompt whoever the tab NOW represents with the generic
  // re-auth message, spend their mint, and push the departed subject's file
  // through under their name. The guard opened at `uploadFile` entry is the
  // only cross-attempt memory of which subject the batch belongs to, so a
  // torn-down retry reports once and unwinds with the silent code instead of
  // re-acquiring.
  if (guard.tornDown()) {
    guard.cancel();
    throw uploadError(UPLOAD_SUBJECT_CHANGED);
  }
  try {
    const proof = await windowProof(guard);
    // Same self-custody branch the first attempt takes: no window means no
    // proof to attach. Shape parity with the first attempt — a null proof
    // takes the same unproofed api.js call as no option at all — and the one
    // reachable retry case is a same-subject cross-tab custody upgrade to
    // self-custody between the attempts (a logged-out store never gets this
    // far: the api layer refuses unauthenticated uploads before any leg runs).
    if (!proof) return await uploadFileToIpfs(file);
    return await attemptOnce(file, proof);
  } catch (err) {
    if (isUsernameMismatch(err)) throw tornDownSession();
    throw err;
  }
}

// Upload one file to IPFS through the two-step pre-flight in `api.js`.
//
// Self-custody (Keychain) signs each file's pre-flight descriptor and needs no
// proof — `ensureSessionWindow` returns a null proof for it. Light accounts
// attach their live window proof.
export async function uploadFile(file) {
  // Opened before the first await so it spans the whole upload, retries
  // included: the pre-flight, the transfer, and both retry legs are each a
  // boundary a cross-tab subject change can land in, and the retries below
  // re-acquire the window for whoever the tab represents at that moment.
  const guard = subjectTeardownGuard();
  const proof = await windowProof(guard);
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
      // Only this flight's own window is this leg's to drop. The generation
      // moves solely inside the subject scrub, which evicts the window slot in
      // the same synchronous block BEFORE it bumps — so past a teardown this
      // flight's window is already gone and the entry sitting here belongs to
      // whoever the tab represents next. Evicting it would charge them a
      // re-auth for a rejection that was never theirs; `retryOnce` unwinds the
      // flight one statement later anyway.
      if (!guard.tornDown()) clearCachedSessionProof();
      return retryOnce(file, guard);
    }
    // username_mismatch means the proof in hand belongs to a different account
    // than the JWT subject — a corrupted session no re-mint fixes, because a
    // re-acquisition under the same divergence produces the same pair. Tear the
    // session down via the shared teardown, matching the broadcast, settings,
    // and authorship siblings. The cost of NOT doing so is a misreport, not a
    // lockout: the subject change that produced the divergence already dropped
    // the cached window, so a resubmit would re-acquire and succeed. But the
    // user is told "upload failed" (and, on the publish path, "publishing
    // failed" on top) for a session that needs re-login, which is neither
    // actionable nor true. The already-reported code aborts the batch while
    // telling the page layer the teardown's toast was the whole message.
    if (isUsernameMismatch(err)) throw tornDownSession();
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
      return retryOnce(file, guard);
    }
    throw err;
  }
}
