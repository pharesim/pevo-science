import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { assertBodyRecord, requireStringField } from '../../src/lib/body-record.js';

// Direct unit coverage for the body-shape narrowing helpers. These are pure
// functions (no DB/Redis/HAF), so they run real-path with no mocking. The
// helpers are load-bearing across the seven `skipFailedRequests: true`
// adopters: requireStringField is the single source of truth for body-field
// presence/length/type gating in the layered CPU-amplification mitigation, and
// its `trim` flag governs credential byte-exactness on the custody re-auth
// routes (a trimmed password would diverge from the untrimmed /login + signup
// hash paths and lock a whitespace-bearing credential out of /fresh-auth +
// /session-auth). The trim contract therefore needs direct pins; the byte-
// exactness invariant at the route level is pinned by a separate real-path
// custody test.

describe('requireStringField', () => {
  it('rejects a non-string value (number)', () => {
    const r = requireStringField({ password: 123 }, 'password', 4096);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('password is required');
  });

  it('rejects a missing field (undefined)', () => {
    const r = requireStringField({}, 'password', 4096);
    expect(r.ok).toBe(false);
  });

  it('rejects null', () => {
    const r = requireStringField({ password: null }, 'password', 4096);
    expect(r.ok).toBe(false);
  });

  it('rejects an empty string', () => {
    const r = requireStringField({ x: '' }, 'x', 4096);
    expect(r.ok).toBe(false);
  });

  it('rejects a whitespace-only string regardless of the trim flag (default no-trim)', () => {
    const r = requireStringField({ x: '   ' }, 'x', 4096);
    expect(r.ok).toBe(false);
  });

  it('rejects a whitespace-only string with trim=true', () => {
    const r = requireStringField({ x: '   ' }, 'x', 4096, undefined, { trim: true });
    expect(r.ok).toBe(false);
  });

  it('uses the override message on the failure arm', () => {
    const r = requireStringField({ password: '' }, 'password', 4096, 'Password is required');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Password is required');
  });

  // ── trim=true (identifier/slug-shaped fields) ──
  describe('trim=true', () => {
    it('returns the TRIMMED value on success (surrounding whitespace stripped)', () => {
      const r = requireStringField({ root_author: '  alice  ' }, 'root_author', 64, undefined, { trim: true });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('alice');
    });

    it('succeeds when surrounding whitespace pushes raw over cap but trimmed value is within cap', () => {
      // raw length = 10 ('  abcde  '? -> 9). Use an explicit cap to prove the
      // length check runs against the TRIMMED value: trimmed 'abcde' (5) <= 5.
      const r = requireStringField({ k: '  abcde  ' }, 'k', 5, undefined, { trim: true });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('abcde');
    });

    it('rejects when even the TRIMMED value exceeds the cap', () => {
      const r = requireStringField({ k: '  abcdef  ' }, 'k', 5, undefined, { trim: true });
      expect(r.ok).toBe(false);
    });
  });

  // ── trim=false / default (credential / byte-exact fields) ──
  describe('default (no trim)', () => {
    it('returns the value BYTE-FOR-BYTE on success (surrounding whitespace preserved)', () => {
      const r = requireStringField({ password: '  hunter2  ' }, 'password', 4096);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('  hunter2  ');
    });

    it('rejects a cap-overshoot via padding (length check runs against the RAW value)', () => {
      // raw '  ab  ' length = 6 > cap 5; with no trim the raw length is checked.
      const r = requireStringField({ password: '  ab  ' }, 'password', 5);
      expect(r.ok).toBe(false);
    });

    it('accepts an interior-whitespace credential at the cap boundary without mutation', () => {
      const raw = 'a b c';
      const r = requireStringField({ password: raw }, 'password', 5);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(raw);
    });
  });
});

describe('assertBodyRecord', () => {
  it('returns the body unchanged when it is a plain object', () => {
    const body = { a: 1, b: 'x' };
    const out = assertBodyRecord({ body } as unknown as Request);
    expect(out).toBe(body);
  });

  it('returns an empty object when req.body is null (parse failure path)', () => {
    const out = assertBodyRecord({ body: null } as unknown as Request);
    expect(out).toEqual({});
  });

  it('returns an empty object when req.body is a non-object (e.g., string)', () => {
    const out = assertBodyRecord({ body: 'not-json' } as unknown as Request);
    expect(out).toEqual({});
  });
});
