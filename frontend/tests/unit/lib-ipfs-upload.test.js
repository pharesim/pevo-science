import { describe, it, expect, vi, beforeEach } from 'vitest';

// The session orchestrates upload credentials; the HTTP two-step and the
// password mint live in api.js (covered in api.test.js). Mock those so these
// tests assert the orchestration: custody routing, State-C gating, prompt-once,
// per-file minting, wrong-password re-prompt, token-expiry retry, and dispose.
const mockUploadFileToIpfs = vi.fn();
const mockMintProof = vi.fn();
const mockFetchEmailStatus = vi.fn();
vi.mock('../../src/api.js', async (importOriginal) => {
  // Spread the real module so ApiRequestError (and any other real exports) stay
  // available; override only the three functions the session calls. Tests build
  // errors via the real ApiRequestError so the shape stays honest -- the class
  // carries `code`, never `status` (test-fabricated-error-shape convention).
  // importOriginal loads api.js, whose top level is pure declarations, so it is
  // side-effect-free under the mocked alpinejs below.
  const actual = await importOriginal();
  return {
    ...actual,
    uploadFileToIpfs: (...a) => mockUploadFileToIpfs(...a),
    mintIpfsUploadProof: (...a) => mockMintProof(...a),
    fetchEmailStatus: (...a) => mockFetchEmailStatus(...a),
  };
});

let custody = 'light';
const reauthRequest = vi.fn();
const toastShow = vi.fn();
vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name) => {
      if (name === 'auth') return { custody };
      if (name === 'reauthModal') return { request: (...a) => reauthRequest(...a) };
      if (name === 'toast') return { show: toastShow };
      return null;
    }),
  },
}));

import {
  createUploadSession,
  uploadFile,
  describeUploadError,
  resetPromptChain,
  UPLOAD_REAUTH_UNAVAILABLE,
  UPLOAD_CANCELLED,
} from '../../src/lib/ipfs-upload.js';
import { ApiRequestError } from '../../src/api.js';

const okUpload = (cid) => ({ status: 'ok', data: { cid, filename: 'f', type: 'application/pdf', size: 1 } });
const file = () => new Blob(['x'], { type: 'application/pdf' });
// Build the real ApiRequestError production throws, not a hand-rolled stand-in.
// The class sets `code` (and optional message/details) and has no `status`
// field; constructing via the real type keeps every error-shape guard honest.
const codedError = (code) => new ApiRequestError(code, code);

describe('createUploadSession', () => {
  beforeEach(() => {
    // mockReset (not clearAllMocks) so the once-queues from a prior test don't
    // leak; the Alpine `store` mock is left intact (its impl reads `custody`).
    mockUploadFileToIpfs.mockReset();
    mockMintProof.mockReset();
    mockFetchEmailStatus.mockReset();
    reauthRequest.mockReset();
    toastShow.mockReset();
    custody = 'light';
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
    reauthRequest.mockResolvedValue('hunter2');
    mockMintProof.mockResolvedValue('proof-1');
    mockUploadFileToIpfs.mockResolvedValue(okUpload('bafy'));
  });

  it('self-custody uploads without a proof, password prompt, or mint', async () => {
    custody = 'self';
    const session = createUploadSession();
    const res = await session.upload(file());
    expect(res.data.cid).toBe('bafy');
    expect(mockUploadFileToIpfs).toHaveBeenCalledTimes(1);
    expect(mockUploadFileToIpfs.mock.calls[0][1]).toBeUndefined();
    expect(reauthRequest).not.toHaveBeenCalled();
    expect(mockMintProof).not.toHaveBeenCalled();
    expect(mockFetchEmailStatus).not.toHaveBeenCalled();
  });

  it('light account prompts for the password once per batch and mints a fresh proof per file', async () => {
    mockUploadFileToIpfs.mockResolvedValueOnce(okUpload('cid1')).mockResolvedValueOnce(okUpload('cid2'));
    mockMintProof.mockResolvedValueOnce('proof-a').mockResolvedValueOnce('proof-b');
    const session = createUploadSession();
    const r1 = await session.upload(file());
    const r2 = await session.upload(file());
    expect(r1.data.cid).toBe('cid1');
    expect(r2.data.cid).toBe('cid2');
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(1);
    expect(reauthRequest).toHaveBeenCalledTimes(1);
    expect(mockMintProof).toHaveBeenCalledTimes(2);
    expect(mockMintProof).toHaveBeenCalledWith('hunter2');
    expect(mockUploadFileToIpfs.mock.calls[0][1]).toEqual({ freshAuthProof: 'proof-a' });
    expect(mockUploadFileToIpfs.mock.calls[1][1]).toEqual({ freshAuthProof: 'proof-b' });
  });

  it('blocks ORCID-only (passwordless) accounts with UPLOAD_REAUTH_UNAVAILABLE and never prompts', async () => {
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
    const session = createUploadSession();
    await expect(session.upload(file())).rejects.toMatchObject({ code: UPLOAD_REAUTH_UNAVAILABLE });
    expect(reauthRequest).not.toHaveBeenCalled();
    expect(mockMintProof).not.toHaveBeenCalled();
    expect(mockUploadFileToIpfs).not.toHaveBeenCalled();
  });

  it('throws UPLOAD_CANCELLED when the user dismisses the password modal', async () => {
    reauthRequest.mockResolvedValue(null);
    const session = createUploadSession();
    await expect(session.upload(file())).rejects.toMatchObject({ code: UPLOAD_CANCELLED });
    expect(mockMintProof).not.toHaveBeenCalled();
    expect(mockUploadFileToIpfs).not.toHaveBeenCalled();
  });

  it('re-prompts once when the entered password is wrong, then succeeds', async () => {
    mockMintProof.mockRejectedValueOnce(codedError('UNAUTHORIZED')).mockResolvedValueOnce('proof-ok');
    reauthRequest.mockResolvedValueOnce('wrongpw').mockResolvedValueOnce('rightpw');
    const session = createUploadSession();
    const res = await session.upload(file());
    expect(res.data.cid).toBe('bafy');
    expect(reauthRequest).toHaveBeenCalledTimes(2);
    expect(mockMintProof).toHaveBeenNthCalledWith(1, 'wrongpw');
    expect(mockMintProof).toHaveBeenNthCalledWith(2, 'rightpw');
    expect(mockUploadFileToIpfs.mock.calls[0][1]).toEqual({ freshAuthProof: 'proof-ok' });
  });

  it('re-mints a fresh proof and retries once when the upload token is expired (no re-prompt)', async () => {
    mockUploadFileToIpfs.mockRejectedValueOnce(codedError('UNAUTHORIZED')).mockResolvedValueOnce(okUpload('cid-retry'));
    mockMintProof.mockResolvedValueOnce('proof-1').mockResolvedValueOnce('proof-2');
    const session = createUploadSession();
    const res = await session.upload(file());
    expect(res.data.cid).toBe('cid-retry');
    expect(mockMintProof).toHaveBeenCalledTimes(2);
    expect(mockUploadFileToIpfs).toHaveBeenCalledTimes(2);
    expect(reauthRequest).toHaveBeenCalledTimes(1);
  });

  it('retries once when the upload-token pre-flight rejects the proof (FRESH_AUTH_REQUIRED)', async () => {
    mockUploadFileToIpfs.mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED')).mockResolvedValueOnce(okUpload('cid-2'));
    const session = createUploadSession();
    const res = await session.upload(file());
    expect(res.data.cid).toBe('cid-2');
    expect(mockMintProof).toHaveBeenCalledTimes(2);
  });

  it('dispose() wipes the cached password so the next upload prompts again', async () => {
    const session = createUploadSession();
    await session.upload(file());
    expect(reauthRequest).toHaveBeenCalledTimes(1);
    session.dispose();
    await session.upload(file());
    expect(reauthRequest).toHaveBeenCalledTimes(2);
  });

  it('propagates a non-auth upload error without retry', async () => {
    mockUploadFileToIpfs.mockRejectedValue(codedError('SERVICE_UNAVAILABLE'));
    const session = createUploadSession();
    await expect(session.upload(file())).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(mockUploadFileToIpfs).toHaveBeenCalledTimes(1);
  });

  // The password re-prompt is bounded to once per session: a session-JWT expiry
  // or a mid-batch credential change can make the mint return UNAUTHORIZED again
  // with an already-correct password, which must NOT loop the user through
  // endless prompts.
  it('bounds the re-prompt to once per session: a second UNAUTHORIZED rethrows without a third prompt', async () => {
    // Initial mint UNAUTHORIZED -> re-prompt + retry; retry mint UNAUTHORIZED ->
    // repromptUsed is now set, so mintProof rethrows instead of prompting again.
    mockMintProof
      .mockRejectedValueOnce(codedError('UNAUTHORIZED'))
      .mockRejectedValueOnce(codedError('UNAUTHORIZED'));
    reauthRequest.mockResolvedValueOnce('pw1').mockResolvedValueOnce('pw2');
    const session = createUploadSession();
    await expect(session.upload(file())).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    // Exactly two prompts: the initial credential prompt + one re-prompt. No third.
    expect(reauthRequest).toHaveBeenCalledTimes(2);
    expect(mockMintProof).toHaveBeenCalledTimes(2);
    expect(mockUploadFileToIpfs).not.toHaveBeenCalled();
  });

  it('dispose() resets the re-prompt bound so a reused session can re-prompt again', async () => {
    const session = createUploadSession();
    // Batch 1: first mint UNAUTHORIZED -> re-prompt (2nd prompt) -> retry succeeds.
    mockMintProof.mockRejectedValueOnce(codedError('UNAUTHORIZED')).mockResolvedValueOnce('proof-1');
    await session.upload(file());
    expect(reauthRequest).toHaveBeenCalledTimes(2);

    session.dispose();

    // Batch 2 on the same session: the bound is reset, so a fresh UNAUTHORIZED
    // re-prompts (4th prompt overall) rather than rethrowing.
    mockMintProof.mockRejectedValueOnce(codedError('UNAUTHORIZED')).mockResolvedValueOnce('proof-2');
    const r2 = await session.upload(file());
    expect(r2.data.cid).toBe('bafy');
    expect(reauthRequest).toHaveBeenCalledTimes(4);
  });

  // ensureCredential must not dead-end a valid password-holder when the
  // account-status fetch fails transiently. Only an explicit hasPassword===false
  // (State C) blocks; a thrown/unknown status falls through to the prompt, and
  // the backend re-verifies at mint time. NOTE: a real transient failure (network
  // down / 30s timeout) surfaces from fetch as a raw TypeError / DOMException,
  // NOT an ApiRequestError -- so the catch is intentionally untyped. This test
  // uses a raw TypeError to pin that non-ApiRequestError throws still fall
  // through (it would fail if the catch were narrowed to ApiRequestError-only).
  it('falls through to the password prompt when the status fetch throws transiently, and succeeds', async () => {
    mockFetchEmailStatus.mockRejectedValue(new TypeError('Failed to fetch'));
    const session = createUploadSession();
    const res = await session.upload(file());
    expect(res.data.cid).toBe('bafy');
    expect(reauthRequest).toHaveBeenCalledTimes(1); // prompted despite the status failure
    expect(mockMintProof).toHaveBeenCalledTimes(1);
  });

  it('still blocks without prompting when the status explicitly reports hasPassword=false', async () => {
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
    const session = createUploadSession();
    await expect(session.upload(file())).rejects.toMatchObject({ code: UPLOAD_REAUTH_UNAVAILABLE });
    expect(reauthRequest).not.toHaveBeenCalled();
  });
});

describe('uploadFile (single-shot)', () => {
  beforeEach(() => {
    mockUploadFileToIpfs.mockReset();
    custody = 'self';
    mockUploadFileToIpfs.mockResolvedValue(okUpload('one-shot'));
  });

  it('uploads a single file through a disposable session', async () => {
    const res = await uploadFile(file());
    expect(res.data.cid).toBe('one-shot');
    expect(mockUploadFileToIpfs).toHaveBeenCalledTimes(1);
  });
});

describe('describeUploadError', () => {
  it('maps codes to stable i18n keys, defaulting to common.uploadFailed', () => {
    expect(describeUploadError({ code: UPLOAD_REAUTH_UNAVAILABLE })).toBe('common.uploadReauthRequired');
    expect(describeUploadError({ code: UPLOAD_CANCELLED })).toBe('common.uploadCancelled');
    expect(describeUploadError(new Error('boom'))).toBe('common.uploadFailed');
    expect(describeUploadError(null)).toBe('common.uploadFailed');
  });
});

// The reauthModal is a singleton with a refuse-while-open guard: a second
// concurrent request() resolves to null. Two independent upload sessions (an
// editor inline-image upload and a publish/edit page batch) can race to it, and
// the loser would surface UPLOAD_CANCELLED. createUploadSession serializes the
// prompt across ALL sessions so only one reauthModal.request() is ever open.
describe('cross-surface prompt serialization', () => {
  // Macrotask flush so the fire-and-forget prompt chain settles its microtasks.
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    // promptChain is module-level state shared across tests; reset it so a prior
    // test that left a prompt pending cannot stall these.
    resetPromptChain();
    mockUploadFileToIpfs.mockReset();
    mockMintProof.mockReset();
    mockFetchEmailStatus.mockReset();
    reauthRequest.mockReset();
    custody = 'light';
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
    mockMintProof.mockResolvedValue('proof');
    mockUploadFileToIpfs.mockResolvedValue(okUpload('bafy'));
  });

  it('serializes the prompt across two concurrent sessions so the loser is not cancelled', async () => {
    // Faithful reauthModal model: only one prompt may be open; a request() while
    // one is open returns null (the real refuse-while-open contract). With the
    // gate the second session waits its turn and never hits that branch.
    let openCount = 0;
    let maxConcurrent = 0;
    const resolvers = [];
    reauthRequest.mockImplementation(() => {
      if (openCount > 0) return Promise.resolve(null); // refuse-while-open
      openCount += 1;
      maxConcurrent = Math.max(maxConcurrent, openCount);
      return new Promise((resolve) => {
        resolvers.push((pw) => { openCount -= 1; resolve(pw); });
      });
    });

    const s1 = createUploadSession();
    const s2 = createUploadSession();
    const p1 = s1.upload(file());
    const p2 = s2.upload(file());
    await flush();

    // Both sessions raced to the prompt, but only one is open.
    expect(maxConcurrent).toBe(1);
    expect(reauthRequest).toHaveBeenCalledTimes(1);

    // Resolve the first prompt; the gate then lets the second session prompt.
    resolvers[0]('pw-1');
    await flush();
    expect(reauthRequest).toHaveBeenCalledTimes(2);
    expect(maxConcurrent).toBe(1); // never two open at once

    resolvers[1]('pw-2');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.data.cid).toBe('bafy');
    expect(r2.data.cid).toBe('bafy'); // the second session was NOT cancelled
  });

  it('leaves the self-custody (Keychain) path ungated and unprompted', async () => {
    custody = 'self';
    const s1 = createUploadSession();
    const s2 = createUploadSession();
    const [r1, r2] = await Promise.all([s1.upload(file()), s2.upload(file())]);
    expect(r1.data.cid).toBe('bafy');
    expect(r2.data.cid).toBe('bafy');
    expect(reauthRequest).not.toHaveBeenCalled();
  });

  // Models the singleton reauthModal: only one prompt open at a time; a request
  // while one is open resolves null (refuse-while-open). Returns counters + a
  // resolver queue so a test can settle prompts in order and assert serialization.
  function refusingModal() {
    const state = { openCount: 0, maxConcurrent: 0, resolvers: [] };
    reauthRequest.mockImplementation(() => {
      if (state.openCount > 0) return Promise.resolve(null);
      state.openCount += 1;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.openCount);
      return new Promise((resolve) => {
        state.resolvers.push((pw) => { state.openCount -= 1; resolve(pw); });
      });
    });
    return state;
  }

  // The gate's correctness rests on the chain advancing on EVERY settle, not just
  // success. A cancelled (null) first-session prompt must still let the next
  // waiter prompt and complete uncancelled.
  it('advances the gate after a cancelled (null) first-session prompt', async () => {
    const modal = refusingModal();
    const s1 = createUploadSession();
    const s2 = createUploadSession();
    const p1 = s1.upload(file());
    p1.catch(() => {}); // p1 rejects later; pre-attach so it is never flagged unhandled
    const p2 = s2.upload(file());
    await flush();
    expect(reauthRequest).toHaveBeenCalledTimes(1); // s2 queued behind s1

    modal.resolvers[0](null); // s1 dismisses
    await flush();
    expect(reauthRequest).toHaveBeenCalledTimes(2); // gate advanced -> s2 prompts

    modal.resolvers[1]('pw-2');
    await expect(p1).rejects.toMatchObject({ code: UPLOAD_CANCELLED });
    expect((await p2).data.cid).toBe('bafy'); // s2 not collateral-cancelled
    expect(modal.maxConcurrent).toBe(1);
  });

  // A rejecting/throwing prompt must also advance the chain (the reject handler
  // on the chain tail), not wedge every later waiter.
  it('advances the chain after a rejecting prompt (no wedge)', async () => {
    let firstCall = true;
    const resolvers = [];
    reauthRequest.mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        return Promise.reject(new Error('prompt boom'));
      }
      return new Promise((resolve) => { resolvers.push(resolve); });
    });
    const s1 = createUploadSession();
    const s2 = createUploadSession();
    const p1 = s1.upload(file());
    p1.catch(() => {}); // p1 rejects later; pre-attach so it is never flagged unhandled
    const p2 = s2.upload(file());
    await flush();
    expect(reauthRequest).toHaveBeenCalledTimes(2); // chain advanced past the rejection

    resolvers[0]('pw-2');
    await expect(p1).rejects.toThrow('prompt boom');
    expect((await p2).data.cid).toBe('bafy');
  });

  it('serializes 3 concurrent sessions one prompt at a time', async () => {
    const modal = refusingModal();
    const sessions = [createUploadSession(), createUploadSession(), createUploadSession()];
    const ps = sessions.map((s) => s.upload(file()));
    await flush();
    expect(reauthRequest).toHaveBeenCalledTimes(1); // only the first is open

    modal.resolvers[0]('pw0');
    await flush();
    expect(reauthRequest).toHaveBeenCalledTimes(2); // second opens only now

    modal.resolvers[1]('pw1');
    await flush();
    expect(reauthRequest).toHaveBeenCalledTimes(3); // third opens only now

    modal.resolvers[2]('pw2');
    const results = await Promise.all(ps);
    expect(results.every((r) => r.data.cid === 'bafy')).toBe(true);
    expect(modal.maxConcurrent).toBe(1); // never two prompts open at once
  });

  // A session disposed while queued behind another session's prompt must NOT open
  // the modal when its turn comes -- a typed password would be spent on a dead
  // session. It resolves to UPLOAD_CANCELLED instead.
  it('a session disposed while queued never opens the modal', async () => {
    const modal = refusingModal();
    const s1 = createUploadSession();
    const s2 = createUploadSession();
    const p1 = s1.upload(file());
    const p2 = s2.upload(file());
    p2.catch(() => {}); // p2 rejects later; pre-attach so it is never flagged unhandled
    await flush();
    expect(reauthRequest).toHaveBeenCalledTimes(1); // s1 open, s2 queued

    s2.dispose(); // abandon s2 while it waits
    modal.resolvers[0]('pw-1'); // s1 completes, gate advances to s2

    expect((await p1).data.cid).toBe('bafy');
    await expect(p2).rejects.toMatchObject({ code: UPLOAD_CANCELLED });
    // The modal was never opened for the disposed session.
    expect(reauthRequest).toHaveBeenCalledTimes(1);
  });
});
