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
vi.mock('../../src/lib/fresh-auth.js', () => ({
  ensureSessionWindow: (...a) => mockEnsureSessionWindow(...a),
  clearCachedSessionProof: (...a) => mockClearCachedSessionProof(...a),
}));

import {
  uploadFile,
  describeUploadError,
  UPLOAD_CANCELLED,
  UPLOAD_REAUTH_FAILED,
} from '../../src/lib/ipfs-upload.js';
import { ApiRequestError } from '../../src/api.js';

const okUpload = (cid) => ({ status: 'ok', data: { cid, filename: 'f', type: 'application/pdf', size: 1 } });
const file = () => new Blob(['x'], { type: 'application/pdf' });
// Build the real ApiRequestError production throws, not a hand-rolled stand-in.
const codedError = (code) => new ApiRequestError(code, code);

describe('uploadFile', () => {
  beforeEach(() => {
    mockUploadFileToIpfs.mockReset();
    mockEnsureSessionWindow.mockReset();
    mockClearCachedSessionProof.mockReset();
    mockEnsureSessionWindow.mockResolvedValue({ ready: true, proof: 'window-1' });
    mockUploadFileToIpfs.mockResolvedValue(okUpload('bafy'));
  });

  it('attaches the window proof to the upload', async () => {
    const f = file();
    const res = await uploadFile(f);

    expect(res).toEqual(okUpload('bafy'));
    expect(mockUploadFileToIpfs).toHaveBeenCalledWith(f, { freshAuthProof: 'window-1' });
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
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED'))
      .mockResolvedValueOnce(okUpload('bafy2'));
    mockEnsureSessionWindow
      .mockResolvedValueOnce({ ready: true, proof: 'window-1' })
      .mockResolvedValueOnce({ ready: true, proof: 'window-2' });

    const res = await uploadFile(file());

    expect(mockClearCachedSessionProof).toHaveBeenCalledTimes(1);
    expect(res.data.cid).toBe('bafy2');
    expect(mockUploadFileToIpfs.mock.calls[1][1]).toEqual({ freshAuthProof: 'window-2' });
  });

  it('retries once on an UNAUTHORIZED upload leg', async () => {
    mockUploadFileToIpfs
      .mockRejectedValueOnce(codedError('UNAUTHORIZED'))
      .mockResolvedValueOnce(okUpload('bafy3'));

    const res = await uploadFile(file());

    expect(res.data.cid).toBe('bafy3');
    expect(mockUploadFileToIpfs).toHaveBeenCalledTimes(2);
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
    expect(describeUploadError({ code: 'INTERNAL_ERROR' })).toBe('common.uploadFailed');
    expect(describeUploadError(null)).toBe('common.uploadFailed');
    expect(describeUploadError(undefined)).toBe('common.uploadFailed');
  });
});
