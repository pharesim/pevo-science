import { describe, it, expect } from 'vitest';
import { PrivateKey } from '@hiveio/dhive';
import { validatePostingKeyFormat } from '../src/startup-checks.js';

describe('validatePostingKeyFormat', () => {
  it('returns null for an unset key (preserves optional semantics)', () => {
    expect(validatePostingKeyFormat('', 'PEVO_ADMIN_POSTING_KEY')).toBeNull();
  });

  it('returns null for a valid WIF', () => {
    // Derive a throwaway WIF deterministically — never used on chain.
    const validWif = PrivateKey.fromSeed('startup-checks-test-fixture').toString();
    expect(validatePostingKeyFormat(validWif, 'PEVO_ADMIN_POSTING_KEY')).toBeNull();
  });

  it('returns a recognizable error message for a non-base58 key, naming env var + dhive error class', () => {
    const result = validatePostingKeyFormat('invalid-wif', 'PEVO_ADMIN_POSTING_KEY');
    expect(result).not.toBeNull();
    expect(result).toContain('PEVO_ADMIN_POSTING_KEY');
    expect(result).toContain('invalid WIF format');
    expect(result).toContain('Error');
    expect(result).toContain('Non-base58 character');
  });

  it('returns a recognizable error message for a too-short key, naming env var + AssertionError', () => {
    const result = validatePostingKeyFormat('5J', 'PEVO_BRIDGE_POSTING_KEY');
    expect(result).not.toBeNull();
    expect(result).toContain('PEVO_BRIDGE_POSTING_KEY');
    expect(result).toContain('AssertionError');
  });

  it('passes the env var name through verbatim so operators can grep the boot log', () => {
    const adminErr = validatePostingKeyFormat('garbage', 'PEVO_ADMIN_POSTING_KEY');
    const bridgeErr = validatePostingKeyFormat('garbage', 'PEVO_BRIDGE_POSTING_KEY');
    expect(adminErr).toContain('PEVO_ADMIN_POSTING_KEY');
    expect(bridgeErr).toContain('PEVO_BRIDGE_POSTING_KEY');
    expect(adminErr).not.toContain('PEVO_BRIDGE_POSTING_KEY');
    expect(bridgeErr).not.toContain('PEVO_ADMIN_POSTING_KEY');
  });
});
