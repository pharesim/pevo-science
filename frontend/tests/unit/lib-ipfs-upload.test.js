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
vi.mock('../../src/lib/fresh-auth.js', () => ({
  ensureSessionWindow: (...a) => mockEnsureSessionWindow(...a),
  clearCachedSessionProof: (...a) => mockClearCachedSessionProof(...a),
  slideSessionWindow: (...a) => mockSlideSessionWindow(...a),
  handleSessionInconsistency: (...a) => mockHandleSessionInconsistency(...a),
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

  it('a retry after the session went away uploads without a proof rather than a null one', async () => {
    // A teardown between the attempts leaves the store with no light custody,
    // so the re-acquisition answers ready-with-no-proof — the self-custody
    // shape. The first attempt has always branched on that; the retries had
    // not, and passed the null straight through as a proof.
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
});
