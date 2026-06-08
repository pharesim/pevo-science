import { describe, it, expect, vi, beforeEach } from 'vitest';

// The session orchestrates upload credentials; the HTTP two-step and the
// password mint live in api.js (covered in api.test.js). Mock those so these
// tests assert the orchestration: custody routing, State-C gating, prompt-once,
// per-file minting, wrong-password re-prompt, token-expiry retry, and dispose.
const mockUploadFileToIpfs = vi.fn();
const mockMintProof = vi.fn();
const mockFetchEmailStatus = vi.fn();
vi.mock('../../src/api.js', () => ({
  uploadFileToIpfs: (...a) => mockUploadFileToIpfs(...a),
  mintIpfsUploadProof: (...a) => mockMintProof(...a),
  fetchEmailStatus: (...a) => mockFetchEmailStatus(...a),
}));

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
  UPLOAD_REAUTH_UNAVAILABLE,
  UPLOAD_CANCELLED,
} from '../../src/lib/ipfs-upload.js';

const okUpload = (cid) => ({ status: 'ok', data: { cid, filename: 'f', type: 'application/pdf', size: 1 } });
const file = () => new Blob(['x'], { type: 'application/pdf' });
const codedError = (code) => Object.assign(new Error(code), { code });

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
