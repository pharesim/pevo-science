// Pure-function helpers — no I/O, no mocks, no carve-out clause needed.
// Tests pin the documented canonicalOrcid / hasOrcidDiscrepancy /
// shouldShowDiscrepancyIndicator contract: chain-vs-verified supersession,
// ORCID format validation (closes the broadcaster trust-spoof surface), and
// the case-b reconciled-values indicator suppression rule documented in
// `agents/docs/api-contracts/papers.md` PaperDetail / PaperSummary caveat.
import { describe, it, expect } from 'vitest';
import {
  canonicalOrcid,
  hasOrcidDiscrepancy,
  shouldShowDiscrepancyIndicator,
} from '../../src/lib/authors.js';

const VALID_A = '0000-0001-2345-6789';
const VALID_B = '0000-0002-1825-0097';
const VALID_X = '0000-0001-2345-678X'; // checksum-X variant
const JUNK_50 = 'BIO: A leading researcher in synthetic chemistry yada';

describe('canonicalOrcid', () => {
  it('returns null for null/undefined author', () => {
    expect(canonicalOrcid(null)).toBe(null);
    expect(canonicalOrcid(undefined)).toBe(null);
  });

  it('prefers orcid_verified when present and well-formed', () => {
    expect(canonicalOrcid({ orcid_verified: VALID_A, orcid: VALID_B })).toBe(VALID_A);
  });

  it('falls through to chain orcid when orcid_verified is null', () => {
    expect(canonicalOrcid({ orcid_verified: null, orcid: VALID_A })).toBe(VALID_A);
  });

  it('falls through to chain orcid when orcid_verified is absent', () => {
    expect(canonicalOrcid({ orcid: VALID_A })).toBe(VALID_A);
  });

  it('returns null when both fields are null', () => {
    expect(canonicalOrcid({ orcid_verified: null, orcid: null })).toBe(null);
  });

  it('accepts the checksum-X variant', () => {
    expect(canonicalOrcid({ orcid_verified: VALID_X })).toBe(VALID_X);
  });

  it('rejects empty-string orcid_verified, falling through to a valid chain orcid', () => {
    // Empty string is non-truthy and also fails ORCID_RE; falls through.
    expect(canonicalOrcid({ orcid_verified: '', orcid: VALID_A })).toBe(VALID_A);
  });

  it('returns null when orcid_verified is empty and chain orcid is also invalid', () => {
    expect(canonicalOrcid({ orcid_verified: '', orcid: '' })).toBe(null);
  });

  it('rejects broadcaster junk strings on the chain orcid field', () => {
    // Backend max(50) lets through arbitrary 50-char strings on the chain
    // value (orcid_verified is regex-pinned at attestation time); the helper
    // is the trust boundary that prevents non-ORCID strings rendering as a
    // green orcid.org link.
    expect(canonicalOrcid({ orcid: JUNK_50 })).toBe(null);
    expect(canonicalOrcid({ orcid: 'https://evil.example/x' })).toBe(null);
    expect(canonicalOrcid({ orcid: '0000-0001-2345-67890' })).toBe(null); // too long
    expect(canonicalOrcid({ orcid: '0000-0001-2345-678' })).toBe(null); // too short
    expect(canonicalOrcid({ orcid: '0000-0001-2345-678Y' })).toBe(null); // bad check char
  });

  it('rejects non-string ORCID values', () => {
    expect(canonicalOrcid({ orcid_verified: 12345 })).toBe(null);
    expect(canonicalOrcid({ orcid: { id: VALID_A } })).toBe(null);
    expect(canonicalOrcid({ orcid: ['a', 'b'] })).toBe(null);
  });
});

describe('hasOrcidDiscrepancy', () => {
  it('returns true only for strict === true', () => {
    expect(hasOrcidDiscrepancy({ orcid_discrepancy: true })).toBe(true);
  });

  it('returns false for === false', () => {
    expect(hasOrcidDiscrepancy({ orcid_discrepancy: false })).toBe(false);
  });

  it('returns false for truthy non-boolean values (strict ===)', () => {
    expect(hasOrcidDiscrepancy({ orcid_discrepancy: 'truthy-string' })).toBe(false);
    expect(hasOrcidDiscrepancy({ orcid_discrepancy: 1 })).toBe(false);
  });

  it('returns false for undefined / missing field (older responses degrade quietly)', () => {
    expect(hasOrcidDiscrepancy({ orcid_discrepancy: undefined })).toBe(false);
    expect(hasOrcidDiscrepancy({})).toBe(false);
  });

  it('returns false for null author', () => {
    expect(hasOrcidDiscrepancy(null)).toBe(false);
  });
});

describe('shouldShowDiscrepancyIndicator', () => {
  it('renders when discrepancy flag is true and values differ', () => {
    expect(
      shouldShowDiscrepancyIndicator({
        orcid: VALID_A,
        orcid_verified: VALID_B,
        orcid_discrepancy: true,
      }),
    ).toBe(true);
  });

  it('suppresses when discrepancy flag is false even if values differ', () => {
    expect(
      shouldShowDiscrepancyIndicator({
        orcid: VALID_A,
        orcid_verified: VALID_B,
        orcid_discrepancy: false,
      }),
    ).toBe(false);
  });

  it('suppresses case-b: chain == verified post-server-override, flag still true', () => {
    // Per papers.md PaperDetail/PaperSummary caveat: backend overrides
    // out.orcid := orcid_verified for accredited authors but keeps
    // orcid_discrepancy: true reflecting the pre-override comparison.
    // Rendering the indicator would surface "Claimed: X • Verified: X".
    expect(
      shouldShowDiscrepancyIndicator({
        orcid: VALID_A,
        orcid_verified: VALID_A,
        orcid_discrepancy: true,
      }),
    ).toBe(false);
  });

  it('returns false for null author', () => {
    expect(shouldShowDiscrepancyIndicator(null)).toBe(false);
  });

  it('returns false when discrepancy flag is missing (older response)', () => {
    expect(
      shouldShowDiscrepancyIndicator({ orcid: VALID_A, orcid_verified: VALID_B }),
    ).toBe(false);
  });
});
