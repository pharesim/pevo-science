// Tests the consent-op fresh-auth proof cache in `frontend/src/lib/fresh-auth.js`
// — cacheConsentOpProof / getCachedConsentOpProof / clearCachedConsentOpProof —
// with the credit-op target extension (author_index + claimer). This pins the
// sibling `ui-credit-op-proof-cache-slot-key` acceptance: a proof minted for one
// slot/subject is NEVER reused for another, and anchored consent ops / settings
// actions (triple-only target) keep matching.
//
// Mocking justification (project-CLAUDE.md "Carve-out for deterministic edge-case
// coverage", clause-a): fresh-auth.js imports signer.js (real fetch to
// /api/custody/broadcast), api.js, and alpinejs at module load. We mock only
// those module-load deps so the REAL cache functions run against jsdom's
// sessionStorage — no auth/crypto middleware is involved (clause-b: this is a
// client-side cache, not an auth-verification path; the proof's cryptographic
// binding is verified server-side and covered by backend integration tests).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/signer.js', () => ({ broadcastOps: vi.fn() }));
vi.mock('../../src/api.js', () => ({ startOrcid: vi.fn(), consentOpRequestFields: vi.fn() }));
vi.mock('alpinejs', () => ({ default: { store: vi.fn(() => null) } }));

import {
  cacheConsentOpProof,
  getCachedConsentOpProof,
  clearCachedConsentOpProof,
} from '../../src/lib/fresh-auth.js';

const CONSENT_OP_PROOF_KEY = 'pevo_fresh_auth_consent_op_proof';
const future = () => new Date(Date.now() + 3_600_000).toISOString();

beforeEach(() => {
  sessionStorage.clear();
});

describe('consent-op proof cache — credit-op target keying', () => {
  it('hits on an exact credit-op target (action, paper, slot, claimer)', () => {
    cacheConsentOpProof('proof-1', future(), 'approve_authorship', 'alice', 'perm', 2, 'bob');
    expect(
      getCachedConsentOpProof('approve_authorship', 'alice', 'perm', 2, 'bob'),
    ).toBe('proof-1');
  });

  it('does NOT reuse a slot-2 proof for a slot-3 broadcast (per-slot keying)', () => {
    cacheConsentOpProof('proof-slot2', future(), 'claim_authorship', 'alice', 'perm', 2);
    expect(getCachedConsentOpProof('claim_authorship', 'alice', 'perm', 3)).toBe(null);
    // The intended slot-2 lookup still hits.
    expect(getCachedConsentOpProof('claim_authorship', 'alice', 'perm', 2)).toBe('proof-slot2');
  });

  it('does NOT reuse an approve proof bound to claimer A against claimer B', () => {
    cacheConsentOpProof('proof-A', future(), 'approve_authorship', 'alice', 'perm', 1, 'aaa');
    expect(getCachedConsentOpProof('approve_authorship', 'alice', 'perm', 1, 'bbb')).toBe(null);
  });

  it('binds revoke on claimer only (no author_index on the wire)', () => {
    cacheConsentOpProof('proof-rev', future(), 'revoke_authorship', 'alice', 'perm', undefined, 'bob');
    expect(getCachedConsentOpProof('revoke_authorship', 'alice', 'perm', undefined, 'bob')).toBe('proof-rev');
    // A revoke lookup that (wrongly) supplies an author_index misses.
    expect(getCachedConsentOpProof('revoke_authorship', 'alice', 'perm', 0, 'bob')).toBe(null);
  });
});

describe('consent-op proof cache — anchored / triple-only targets', () => {
  it('matches an anchored consent op (author_accept) on the triple alone', () => {
    cacheConsentOpProof('proof-acc', future(), 'author_accept', 'alice', 'perm');
    expect(getCachedConsentOpProof('author_accept', 'alice', 'perm')).toBe('proof-acc');
  });

  it('does NOT match a triple-only proof when a slot is requested', () => {
    cacheConsentOpProof('proof-acc', future(), 'author_accept', 'alice', 'perm');
    expect(getCachedConsentOpProof('author_accept', 'alice', 'perm', 0)).toBe(null);
  });

  it('reads a pre-extension cached entry (no author_index/claimer fields) as triple-only', () => {
    // Simulate a legacy entry written before the extension shipped.
    sessionStorage.setItem(
      CONSENT_OP_PROOF_KEY,
      JSON.stringify({ token: 'legacy', expiresAt: future(), action: 'change_email', rootAuthor: 'alice', rootPermlink: '' }),
    );
    expect(getCachedConsentOpProof('change_email', 'alice', '')).toBe('legacy');
    // But a credit-op lookup (with a slot) correctly misses the legacy triple entry.
    expect(getCachedConsentOpProof('change_email', 'alice', '', 0)).toBe(null);
  });
});

describe('consent-op proof cache — mismatch / expiry / clear', () => {
  it('returns null on action / paper mismatch', () => {
    cacheConsentOpProof('proof', future(), 'claim_authorship', 'alice', 'perm', 1);
    expect(getCachedConsentOpProof('approve_authorship', 'alice', 'perm', 1)).toBe(null);
    expect(getCachedConsentOpProof('claim_authorship', 'mallory', 'perm', 1)).toBe(null);
    expect(getCachedConsentOpProof('claim_authorship', 'alice', 'other', 1)).toBe(null);
  });

  it('returns null and clears the slot on TTL expiry', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    cacheConsentOpProof('stale', past, 'author_accept', 'alice', 'perm');
    expect(getCachedConsentOpProof('author_accept', 'alice', 'perm')).toBe(null);
    expect(sessionStorage.getItem(CONSENT_OP_PROOF_KEY)).toBe(null);
  });

  it('clearCachedConsentOpProof drops the slot', () => {
    cacheConsentOpProof('proof', future(), 'author_accept', 'alice', 'perm');
    clearCachedConsentOpProof();
    expect(getCachedConsentOpProof('author_accept', 'alice', 'perm')).toBe(null);
  });
});
