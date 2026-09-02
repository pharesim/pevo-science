import { describe, it, expect, vi, beforeEach } from 'vitest';

// `lib/ipfs-upload.js` is upload orchestration only: put the shared session
// window in hand, attach its proof to the two-step upload, and retry once when
// the backend rejects the window mid-flight. The HTTP two-step lives in api.js
// (covered in api.test.js) and the window itself lives in lib/fresh-auth.js
// (covered in lib-fresh-auth-session-window.test.js).
//
// Mocking justification (clause-a of project-CLAUDE.md "Carve-out for
// deterministic edge-case coverage"): `uploadFileToIpfs` performs real fetch()
// against `/api/ipfs/upload-token` and `/api/ipfs/upload`, and reproducing a
// window rejected between the pre-flight and the upload would need a running
// backend plus the ability to close a window at a chosen instant. Both
// dependencies are mocked so each outcome is reachable deterministically.
//
// Auth-focus carve-out (clause-b): no auth middleware is mocked and no
// cryptographic verification is bypassed. Window acquisition is stubbed at the
// module boundary because its own behavior is the subject of a sibling suite,
// not of these tests.
//
// Clause-c real-path companion: `frontend/tests/e2e/non-consent-fresh-auth.spec.js`
// exercises upload + broadcast against the real backend.
const mockUploadFileToIpfs = vi.fn();
vi.mock('../../src/api.js', async (importOriginal) => {
  // Spread the real module so ApiRequestError (and any other real exports) stay
  // available; override only the function the upload path calls. Tests build
  // errors via the real ApiRequestError so the shape stays honest -- the class
  // carries `code`, never `status` (test-fabricated-error-shape convention).
  const actual = await importOriginal();
  return { ...actual, uploadFileToIpfs: (...a) => mockUploadFileToIpfs(...a) };
});

const mockEnsureSessionWindow = vi.fn();
const mockClearCachedSessionProof = vi.fn();
const mockSlideSessionWindow = vi.fn();
const mockHandleSessionInconsistency = vi.fn();
// The subject-teardown guard as the upload path sees it: a snapshot factory
// whose answer flips when the mocked teardown "lands". Tests flip
// `guardTornDown` at the boundary they stage (inside a rejection, inside the
// acquisition) to model a cross-tab subject change at that instant; `cancel`
// is observable so a test can assert the teardown reported exactly once (its
// real body toasts, which is out of this suite's boundary).
let guardTornDown = false;
const mockGuardCancel = vi.fn();
vi.mock('../../src/lib/fresh-auth.js', () => ({
  ensureSessionWindow: (...a) => mockEnsureSessionWindow(...a),
  clearCachedSessionProof: (...a) => mockClearCachedSessionProof(...a),
  slideSessionWindow: (...a) => mockSlideSessionWindow(...a),
  handleSessionInconsistency: (...a) => mockHandleSessionInconsistency(...a),
  subjectTeardownGuard: () => ({
    tornDown: () => guardTornDown,
    cancel: (...a) => mockGuardCancel(...a),
  }),
  REMINTABLE_REASONS: ['missing', 'expired', 'malformed'],
  // Mirrors the real shared discriminator: the reason is the whole gate, and
  // the ApiRequestErrors this surface sees carry no status to gate on.
  isUsernameMismatch: (err) =>
    err?.code === 'FRESH_AUTH_REQUIRED' && err.details?.reason === 'username_mismatch',
}));

import {
  uploadFile,
  describeUploadError,
  UPLOAD_CANCELLED,
  UPLOAD_REAUTH_FAILED,
  UPLOAD_REAUTH_REQUIRED,
  UPLOAD_REAUTH_BUSY,
  UPLOAD_SESSION_TORN_DOWN,
  UPLOAD_SUBJECT_CHANGED,
} from '../../src/lib/ipfs-upload.js';
import { ApiRequestError } from '../../src/api.js';

const okUpload = (cid) => ({ status: 'ok', data: { cid, filename: 'f', type: 'application/pdf', size: 1 } });
const file = () => new Blob(['x'], { type: 'application/pdf' });
// Build the real ApiRequestError production throws, not a hand-rolled stand-in.
const codedError = (code) => new ApiRequestError(code, code);
// The pre-flight's 401 carries a structured reason; the client branches on it.
const freshAuthRejected = (reason = 'expired') =>
  new ApiRequestError('FRESH_AUTH_REQUIRED', 'FRESH_AUTH_REQUIRED', null, { reason });

describe('uploadFile', () => {
  beforeEach(() => {
    mockUploadFileToIpfs.mockReset();
    mockEnsureSessionWindow.mockReset();
    mockClearCachedSessionProof.mockReset();
    mockSlideSessionWindow.mockReset();
    mockHandleSessionInconsistency.mockReset();
    guardTornDown = false;
    mockGuardCancel.mockReset();
    mockEnsureSessionWindow.mockResolvedValue({ ready: true, proof: 'window-1' });
    mockUploadFileToIpfs.mockResolvedValue(okUpload('bafy'));
  });

  it('attaches the window proof to the upload', async () => {
    const f = file();
    const res = await uploadFile(f);

    expect(res).toEqual(okUpload('bafy'));
    expect(mockUploadFileToIpfs).toHaveBeenCalledWith(f, { freshAuthProof: 'window-1' });
  });

  it('acquires without a margin and without navigating', async () => {
    // The margin belongs at the gates (file selection, submit entry, and
    // immediately before the broadcast), never inside a leg: demanding it here
    // forces a mid-sequence re-auth on a window the broadcast leg would accept.
    // And by the time a leg runs there is always work to lose, so the ORCID
    // round-trip must not fire out from under it.
    await uploadFile(file());

    expect(mockEnsureSessionWindow).toHaveBeenCalledWith({
      minRemainingMs: 0,
      allowRedirect: false,
    });
  });

  it('replays the idle slide after every successful upload', async () => {
    // The pre-flight consumes the window and the backend slides its deadline
    // but echoes nothing back. Skipping the replay leaves the client behind by
    // the whole upload duration, and it then evicts a token the server would
    // still honour -- for a passwordless account, discarding a completed pin.
    await uploadFile(file());
    await uploadFile(file());

    expect(mockSlideSessionWindow).toHaveBeenCalledTimes(2);
  });

  it('sends no proof for self-custody', async () => {
    // Keychain signs the pre-flight descriptor per file, so the window layer
    // hands back a null proof and the upload must go out un-proofed rather than
    // with `undefined` in the options bag.
    mockEnsureSessionWindow.mockResolvedValue({ ready: true, proof: null });

    const f = file();
    await uploadFile(f);

    expect(mockUploadFileToIpfs).toHaveBeenCalledWith(f);
  });

  it('reuses one window across a batch: no second acquisition per file', async () => {
    // The window is acquired once and reused; this is what makes a publish with
    // a PDF plus supplementary files cost one re-auth act rather than one per
    // file. `ensureSessionWindow` is a cache read after the first acquisition,
    // so it is called per upload but never prompts twice -- what matters here is
    // that no upload bypasses it and none holds a credential of its own.
    await uploadFile(file());
    await uploadFile(file());
    await uploadFile(file());

    expect(mockEnsureSessionWindow).toHaveBeenCalledTimes(3);
    expect(mockUploadFileToIpfs).toHaveBeenCalledTimes(3);
    for (const call of mockUploadFileToIpfs.mock.calls) {
      expect(call[1]).toEqual({ freshAuthProof: 'window-1' });
    }
  });

  it('drops the dead window before re-acquiring on a rejected proof', async () => {
    // Without the clear, the re-acquisition is a cache hit on the very proof the
    // backend just rejected and the retry fails identically.
    mockUploadFileToIpfs
      .mockRejectedValueOnce(freshAuthRejected('expired'))
      .mockResolvedValueOnce(okUpload('bafy2'));
    mockEnsureSessionWindow
      .mockResolvedValueOnce({ ready: true, proof: 'window-1' })
      .mockResolvedValueOnce({ ready: true, proof: 'window-2' });

    const res = await uploadFile(file());

    expect(mockClearCachedSessionProof).toHaveBeenCalledTimes(1);
    expect(res.data.cid).toBe('bafy2');
    expect(mockUploadFileToIpfs.mock.calls[1][1]).toEqual({ freshAuthProof: 'window-2' });
    expect(mockSlideSessionWindow).toHaveBeenCalledTimes(1);
  });

  it('a refused upload token retries without destroying the window', async () => {
    // UNAUTHORIZED comes from the upload leg and means the single-use upload
    // token was refused -- a token store evicted between the two steps, or a
    // token already consumed by a duplicate request (a slow transfer cannot be
    // the cause: the 30-second request abort in api.js fires long before the
    // token's TTL). It says nothing about the session window, so clearing the
    // window here charges the user a full re-auth act for a stale token.
    mockUploadFileToIpfs
      .mockRejectedValueOnce(codedError('UNAUTHORIZED'))
      .mockResolvedValueOnce(okUpload('bafy3'));

    const res = await uploadFile(file());

    expect(res.data.cid).toBe('bafy3');
    expect(mockUploadFileToIpfs).toHaveBeenCalledTimes(2);
    expect(mockClearCachedSessionProof).not.toHaveBeenCalled();
    expect(mockUploadFileToIpfs.mock.calls[1][1]).toEqual({ freshAuthProof: 'window-1' });
  });

  it('does not re-mint a rejection re-minting cannot fix', async () => {
    // `wrong_mechanism` means the factor the proof was minted with is not
    // registered on the account. A second mint of the same factor produces the
    // same rejection, so the failure is surfaced rather than looped.
    mockUploadFileToIpfs.mockRejectedValue(freshAuthRejected('wrong_mechanism'));

    await expect(uploadFile(file())).rejects.toMatchObject({ code: 'FRESH_AUTH_REQUIRED' });
    expect(mockUploadFileToIpfs).toHaveBeenCalledTimes(1);
    expect(mockClearCachedSessionProof).not.toHaveBeenCalled();
  });

  it('does not retry a transport failure', async () => {
    mockUploadFileToIpfs.mockRejectedValue(codedError('INTERNAL_ERROR'));

    await expect(uploadFile(file())).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(mockUploadFileToIpfs).toHaveBeenCalledTimes(1);
    expect(mockClearCachedSessionProof).not.toHaveBeenCalled();
  });

  it('surfaces a dismissed re-auth modal as a cancel, never as a failure', async () => {
    mockEnsureSessionWindow.mockResolvedValue({ ready: false, cancelled: true });

    await expect(uploadFile(file())).rejects.toMatchObject({ code: UPLOAD_CANCELLED });
    expect(mockUploadFileToIpfs).not.toHaveBeenCalled();
  });

  it('surfaces an in-flight redirect as a cancel', async () => {
    // The page is navigating to ORCID; an error toast on the way out is noise.
    mockEnsureSessionWindow.mockResolvedValue({ ready: false, redirect: true });

    await expect(uploadFile(file())).rejects.toMatchObject({ code: UPLOAD_CANCELLED });
    expect(mockUploadFileToIpfs).not.toHaveBeenCalled();
  });

  it('surfaces a spent re-auth distinctly from a cancel', async () => {
    mockEnsureSessionWindow.mockResolvedValue({ ready: false, failed: true });

    await expect(uploadFile(file())).rejects.toMatchObject({ code: UPLOAD_REAUTH_FAILED });
    expect(mockUploadFileToIpfs).not.toHaveBeenCalled();
  });

  it('a closed window mid-batch refuses instead of navigating away', async () => {
    // Once acquisition stops navigating, a passwordless account whose window
    // closed mid-batch must get an actionable refusal with the form intact,
    // not a full-page round-trip that discards the pins already paid for.
    mockEnsureSessionWindow.mockResolvedValue({ ready: false, reauthRequired: true });

    await expect(uploadFile(file())).rejects.toMatchObject({ code: UPLOAD_REAUTH_REQUIRED });
    expect(mockUploadFileToIpfs).not.toHaveBeenCalled();
  });

  it('a prompt owned by another action surfaces as busy, never as a cancel', async () => {
    // The user never saw a prompt for this upload, so reporting an upload they
    // cancelled is the silent-drop ambiguity the busy sentinel exists to
    // remove: the message must say another confirmation is open.
    mockEnsureSessionWindow.mockResolvedValue({ ready: false, busy: true });

    await expect(uploadFile(file())).rejects.toMatchObject({ code: UPLOAD_REAUTH_BUSY });
    expect(mockUploadFileToIpfs).not.toHaveBeenCalled();
  });

  it('a mismatched session tears down instead of reporting a generic failure', async () => {
    // username_mismatch means the proof in hand belongs to a different account
    // than the JWT subject; no re-mint fixes that pair. Without the teardown
    // the user is told the upload failed for a session that needs re-login,
    // which is neither actionable nor true.
    mockUploadFileToIpfs.mockRejectedValue(freshAuthRejected('username_mismatch'));

    // The rejection carries the dedicated already-reported code, not the raw
    // FRESH_AUTH_REQUIRED error: the teardown's re-login toast has already
    // spoken, and a raw rethrow used to make the pages stack a generic
    // upload-failure surface on top of it.
    await expect(uploadFile(file())).rejects.toMatchObject({
      code: UPLOAD_SESSION_TORN_DOWN,
      name: 'UploadSessionError',
    });
    expect(mockHandleSessionInconsistency).toHaveBeenCalledTimes(1);
    // No blind retry against the same mismatched pair, and no local cache
    // clear: the teardown's disconnect drops the window itself.
    expect(mockUploadFileToIpfs).toHaveBeenCalledTimes(1);
    expect(mockClearCachedSessionProof).not.toHaveBeenCalled();
  });

  // ─── A mismatch surfacing on a RETRY, not on the first attempt ───────────
  //
  // Both retry legs sit inside the single flat catch that handles the
  // first-attempt mismatch, so a rejection from either had no enclosing
  // handler left and escaped raw to the page layer. The reachable interleaving
  // is narrow but real: the proof is dereferenced into a local before the
  // upload runs, and the pre-flight hashes the whole file before it reads the
  // JWT, so a subject change landing in that gap presents the previous
  // subject's proof under the new subject's token.

  it('a mismatch surfacing on the re-mint retry tears down like a first-attempt one', async () => {
    mockUploadFileToIpfs
      .mockRejectedValueOnce(freshAuthRejected('expired'))
      .mockRejectedValueOnce(freshAuthRejected('username_mismatch'));
    mockEnsureSessionWindow
      .mockResolvedValueOnce({ ready: true, proof: 'window-1' })
      .mockResolvedValueOnce({ ready: true, proof: 'window-2' });

    await expect(uploadFile(file())).rejects.toMatchObject({
      code: UPLOAD_SESSION_TORN_DOWN,
      name: 'UploadSessionError',
    });
    expect(mockHandleSessionInconsistency).toHaveBeenCalledTimes(1);
    expect(mockUploadFileToIpfs).toHaveBeenCalledTimes(2);
  });

  it('a mismatch surfacing on the refused-token retry tears down like a first-attempt one', async () => {
    // The aged-token leg deliberately keeps the window (the 401 came from the
    // upload leg, which says nothing about the window), so its retry
    // cache-hits the same proof — and that is exactly the proof that can go
    // stale under a subject change.
    mockUploadFileToIpfs
      .mockRejectedValueOnce(codedError('UNAUTHORIZED'))
      .mockRejectedValueOnce(freshAuthRejected('username_mismatch'));

    await expect(uploadFile(file())).rejects.toMatchObject({
      code: UPLOAD_SESSION_TORN_DOWN,
      name: 'UploadSessionError',
    });
    expect(mockHandleSessionInconsistency).toHaveBeenCalledTimes(1);
    expect(mockUploadFileToIpfs).toHaveBeenCalledTimes(2);
    // The window is still not this leg's to drop.
    expect(mockClearCachedSessionProof).not.toHaveBeenCalled();
  });

  // ─── A subject teardown landing between an attempt and its retry ─────────
  //
  // Both retry legs re-acquire the window at call time, and the store answers
  // for whoever the tab represents NOW. After a cross-tab login as someone
  // else, an unguarded retry would prompt the new subject with the generic
  // re-auth message, spend their mint, and push the departed subject's file
  // through under their name. The guard opened at `uploadFile` entry is the
  // only cross-attempt memory of which subject the batch belongs to.

  it('a teardown between the rejected-proof attempt and its retry re-acquires nothing', async () => {
    mockUploadFileToIpfs.mockImplementationOnce(async () => {
      guardTornDown = true;
      throw freshAuthRejected('expired');
    });

    await expect(uploadFile(file())).rejects.toMatchObject({
      code: UPLOAD_SUBJECT_CHANGED,
      name: 'UploadSessionError',
    });
    // No re-acquisition for the new subject: the only window call is the
    // first attempt's own pre-flight.
    expect(mockEnsureSessionWindow).toHaveBeenCalledTimes(1);
    expect(mockUploadFileToIpfs).toHaveBeenCalledTimes(1);
    // The teardown reported exactly once, through the guard's own cancel.
    expect(mockGuardCancel).toHaveBeenCalledTimes(1);
  });

  it('a teardown between the refused-token attempt and its retry re-acquires nothing', async () => {
    mockUploadFileToIpfs.mockImplementationOnce(async () => {
      guardTornDown = true;
      throw codedError('UNAUTHORIZED');
    });

    await expect(uploadFile(file())).rejects.toMatchObject({
      code: UPLOAD_SUBJECT_CHANGED,
      name: 'UploadSessionError',
    });
    expect(mockEnsureSessionWindow).toHaveBeenCalledTimes(1);
    expect(mockUploadFileToIpfs).toHaveBeenCalledTimes(1);
    expect(mockGuardCancel).toHaveBeenCalledTimes(1);
  });

  it('a teardown cancel during the upload\'s own acquisition throws the silent code, reporting nothing new', async () => {
    // The acquisition's own teardown boundaries have already reported (or
    // deliberately stayed silent); the upload layer's job is only to stop the
    // page speaking a second time. Mapping this cancelled outcome to
    // UPLOAD_CANCELLED would stack the page's upload-cancelled message on top
    // of the teardown's own report.
    mockEnsureSessionWindow.mockImplementationOnce(async () => {
      guardTornDown = true;
      return { ready: false, cancelled: true };
    });

    await expect(uploadFile(file())).rejects.toMatchObject({
      code: UPLOAD_SUBJECT_CHANGED,
      name: 'UploadSessionError',
    });
    expect(mockUploadFileToIpfs).not.toHaveBeenCalled();
    // The guard's cancel is NOT this site's to fire: the boundary inside the
    // acquisition owns the report, and a second cancel here would toast twice.
    expect(mockGuardCancel).not.toHaveBeenCalled();
  });

  it('a non-mismatch failure on the retry propagates raw, with no teardown', async () => {
    // The retry's catch reclassifies exactly one thing: a username mismatch.
    // Any other failure keeps its own identity so the page layer describes the
    // real cause instead of tearing down a session that is still consistent.
    mockUploadFileToIpfs
      .mockRejectedValueOnce(freshAuthRejected('expired'))
      .mockRejectedValueOnce(codedError('INTERNAL_ERROR'));
    mockEnsureSessionWindow
      .mockResolvedValueOnce({ ready: true, proof: 'window-1' })
      .mockResolvedValueOnce({ ready: true, proof: 'window-2' });

    await expect(uploadFile(file())).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(mockHandleSessionInconsistency).not.toHaveBeenCalled();
    expect(mockUploadFileToIpfs).toHaveBeenCalledTimes(2);
  });

  it('a retry after a cross-tab custody upgrade uploads without a proof rather than a null one', async () => {
    // A custody upgrade to self-custody landing between the attempts is a
    // same-subject change: no teardown fires, and the re-acquisition answers
    // ready-with-no-proof — the self-custody shape, where Keychain signs the
    // pre-flight and no window exists. The first attempt has always branched
    // on that; the retries must take the same branch rather than passing the
    // null through in the options bag.
    mockUploadFileToIpfs
      .mockRejectedValueOnce(codedError('UNAUTHORIZED'))
      .mockResolvedValueOnce(okUpload('bafy2'));
    mockEnsureSessionWindow
      .mockResolvedValueOnce({ ready: true, proof: 'window-1' })
      .mockResolvedValueOnce({ ready: true, proof: null });

    const res = await uploadFile(file());

    expect(res).toEqual(okUpload('bafy2'));
    expect(mockUploadFileToIpfs).toHaveBeenNthCalledWith(2, expect.anything());
  });

  it('a logged-out store surfaces the API layer\'s raw UNAUTHORIZED, never an unproofed upload', async () => {
    // With no username in the store the API layer refuses before any upload
    // runs, so "uploads without a proof after the session went away" cannot
    // happen: the ready-with-no-proof answer only ever pairs with a
    // self-custody store. The unproofed attempt sits outside the retry
    // machinery entirely — no safety-net retry, no teardown — so the refusal
    // propagates raw with its own identity intact.
    mockEnsureSessionWindow.mockResolvedValue({ ready: true, proof: null });
    mockUploadFileToIpfs.mockRejectedValue(new ApiRequestError('UNAUTHORIZED', 'Not logged in'));

    const rejection = await uploadFile(file()).then(
      () => null,
      (err) => err,
    );
    expect(rejection).toBeInstanceOf(ApiRequestError);
    expect(rejection).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockUploadFileToIpfs).toHaveBeenCalledTimes(1);
    expect(mockUploadFileToIpfs).toHaveBeenCalledWith(expect.anything());
    expect(mockHandleSessionInconsistency).not.toHaveBeenCalled();
  });

  it('never blocks a passwordless account up front', async () => {
    // The retired State-C block ("Uploads require a password on this account")
    // dead-ended ORCID-only accounts before any prompt. A passwordless account
    // now opens its window by ORCID round-trip before it picks a file, so by
    // upload time it holds a proof like any other account and uploads normally.
    mockEnsureSessionWindow.mockResolvedValue({ ready: true, proof: 'orcid-window' });

    const res = await uploadFile(file());

    expect(res.data.cid).toBe('bafy');
    expect(mockUploadFileToIpfs).toHaveBeenCalledWith(expect.anything(), { freshAuthProof: 'orcid-window' });
  });
});

describe('describeUploadError', () => {
  it('maps cancel and spent-re-auth to distinct keys and everything else to the generic one', () => {
    expect(describeUploadError({ code: UPLOAD_CANCELLED })).toBe('common.uploadCancelled');
    expect(describeUploadError({ code: UPLOAD_REAUTH_FAILED })).toBe('settings.reauthFailed');
    expect(describeUploadError({ code: UPLOAD_REAUTH_REQUIRED })).toBe('common.reauthRequired');
    expect(describeUploadError({ code: UPLOAD_REAUTH_BUSY })).toBe('common.reauthPromptOpen');
    expect(describeUploadError({ code: 'INTERNAL_ERROR' })).toBe('common.uploadFailed');
    expect(describeUploadError(null)).toBe('common.uploadFailed');
    expect(describeUploadError(undefined)).toBe('common.uploadFailed');
  });

  it('maps the already-reported teardown code to null, never to the generic key', () => {
    // The teardown's re-login toast is the whole message for this code; a
    // fallthrough into 'common.uploadFailed' is exactly the double-report the
    // code exists to prevent.
    expect(describeUploadError({ code: UPLOAD_SESSION_TORN_DOWN })).toBeNull();
  });

  it('maps the already-reported subject-change code to null too', () => {
    // Same contract as the torn-down code: the guard's own cancel has spoken
    // (or the teardown deliberately stayed silent), so the page layer owes
    // nothing on top. A null key is what the pages' silent-abort branch keys
    // on, so this pin is what keeps a future code from toasting twice.
    expect(describeUploadError({ code: UPLOAD_SUBJECT_CHANGED })).toBeNull();
  });
});
