/**
 * Canary tests for the output-side IPFS CID shape validator.
 *
 * Pins the `isValidIpfsCid` predicate and `validatedCid` thin wrapper added in
 * BACKEND-PAPER-DETAIL-CID-VALIDATE-ON-EMIT. The wrapper enforces a strict
 * shape match (CIDv0 base58btc or CIDv1 lowercase-base32) at every paper-detail
 * emit site in `routes/papers.ts`. Mutation kill: deleting either regex
 * branch — or relaxing them to allow whitespace, control chars, or
 * zero-width chars — fails one of the cases below.
 *
 * Scope. This file pins the pure predicate + the warn-and-clear wrapper
 * behaviour. Integration coverage at the response-emit sites lives in
 * `tests/routes/continuation-author-gate.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { isValidIpfsCid, validatedCid } from '../../src/lib/ipfs-validation.js';
import { logger } from '../../src/logger.js';

describe('isValidIpfsCid', () => {
  it('admits a valid CIDv0 (Qm... base58btc, 46 chars total)', () => {
    // Real CIDv0 example from IPFS docs: QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG
    expect(isValidIpfsCid('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(true);
  });

  it('admits a valid CIDv1 base32 (b... lowercase, length >= 21)', () => {
    // Real CIDv1 base32 example: bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi
    expect(isValidIpfsCid('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toBe(true);
  });

  it('rejects whitespace-padded CIDv0 (leading + trailing)', () => {
    // The shape match anchors with ^…$, so any padding fails. This is the
    // primary motivating threat: a broadcaster setting `ipfs_cid` to a value
    // with stray whitespace (intentional or accidental) shouldn't surface
    // through the response untouched.
    expect(isValidIpfsCid('  QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(false);
    expect(isValidIpfsCid('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG  ')).toBe(false);
    expect(isValidIpfsCid(' QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG ')).toBe(false);
    // Tab + newline padding too
    expect(isValidIpfsCid('\tQmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(false);
  });

  it('rejects embedded control chars (newline, null byte, carriage return)', () => {
    // Log-injection / response-pollution vector: a CID containing \n could
    // split a log line or smuggle markup into a downstream renderer. The
    // shape match is the cheap filter.
    expect(isValidIpfsCid('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbd\n')).toBe(false);
    expect(isValidIpfsCid('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbd\x00')).toBe(false);
    expect(isValidIpfsCid('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbd\r')).toBe(false);
    // Embedded mid-string newline (trying to split a log line):
    expect(isValidIpfsCid('QmYwAPJzv\n5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(false);
  });

  it('rejects zero-width / unicode-invisibles inside the CID', () => {
    // U+200B ZERO WIDTH SPACE; the base58btc / base32 alphabets are ASCII,
    // so any non-ASCII char must reject.
    expect(isValidIpfsCid('QmYwAPJzv5CZsnA​625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(false);
    // U+FEFF ZERO WIDTH NO-BREAK SPACE (BOM)
    expect(isValidIpfsCid('﻿QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidIpfsCid('')).toBe(false);
  });

  it('rejects an arbitrary garbage string', () => {
    expect(isValidIpfsCid('not-a-cid')).toBe(false);
    expect(isValidIpfsCid('hello world')).toBe(false);
    // Wrong-length CIDv0 (43 chars after Qm instead of 44):
    expect(isValidIpfsCid('Qm' + 'a'.repeat(43))).toBe(false);
    // Wrong CIDv1 prefix (uppercase B):
    expect(isValidIpfsCid('B' + 'a'.repeat(30))).toBe(false);
    // CIDv0 alphabet uses base58btc — `0`, `O`, `I`, `l` are excluded.
    expect(isValidIpfsCid('Qm' + '0'.repeat(44))).toBe(false);
    expect(isValidIpfsCid('Qm' + 'O'.repeat(44))).toBe(false);
    expect(isValidIpfsCid('Qm' + 'I'.repeat(44))).toBe(false);
    expect(isValidIpfsCid('Qm' + 'l'.repeat(44))).toBe(false);
  });

  it('rejects non-string inputs (defensive: callers may pass through string-coerce helpers)', () => {
    expect(isValidIpfsCid(null)).toBe(false);
    expect(isValidIpfsCid(undefined)).toBe(false);
    expect(isValidIpfsCid(42)).toBe(false);
    expect(isValidIpfsCid({})).toBe(false);
    expect(isValidIpfsCid([])).toBe(false);
  });
});

describe('validatedCid', () => {
  const ctx = { author: 'alice', permlink: 'p1' };

  it('passes through a valid CIDv0 unchanged (no warn)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
    const result = validatedCid('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', ctx);
    expect(result).toBe('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('passes through a valid CIDv1 base32 unchanged (no warn)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
    const result = validatedCid('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', ctx);
    expect(result).toBe('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns null for null/undefined input silently (no warn — legitimate "no IPFS attachment" state)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
    expect(validatedCid(null, ctx)).toBe(null);
    expect(validatedCid(undefined, ctx)).toBe(null);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('clears whitespace-padded CID to null AND emits a structured warn anchor', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
    const result = validatedCid('  QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', ctx);
    expect(result).toBe(null);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Pin the structured anchor: event key is the dashboard-keyable contract.
    const arg = warnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.event).toBe('paper_detail_ipfs_cid_rejected');
    expect(arg.author).toBe('alice');
    expect(arg.permlink).toBe('p1');
    expect(typeof arg.raw_cid_prefix).toBe('string');
    warnSpy.mockRestore();
  });

  it('truncates raw_cid_prefix to 32 chars to prevent log injection', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
    // 100-char attack payload with embedded newline (would split a log line
    // if logged unmodified). Truncate to 32 chars.
    const payload = 'attacker-prefix\nINJECTED-LINE-FOLLOWS' + 'X'.repeat(100);
    validatedCid(payload, ctx);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const arg = warnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect((arg.raw_cid_prefix as string).length).toBe(32);
    warnSpy.mockRestore();
  });

  it('clears empty-string input to null with warn (string-coerced upstream callers)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
    expect(validatedCid('', ctx)).toBe(null);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('clears arbitrary garbage to null with warn', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
    expect(validatedCid('not-a-cid-at-all', ctx)).toBe(null);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('clears CID with embedded control char to null with warn (log-injection vector)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
    expect(validatedCid('QmYwAPJzv\n5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', ctx)).toBe(null);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
