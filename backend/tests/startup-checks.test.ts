import { describe, it, expect } from 'vitest';
import { PrivateKey } from '@hiveio/dhive';
import { validatePostingKeyFormat, validateAccountNameFormat } from '../src/startup-checks.js';

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

  it('validates PEVO_ANON_POSTING_KEY (round-2 coverage gap)', () => {
    // Round-2 architect re-review caught that `pevoAnonPostingKey` is consumed via
    // `PrivateKey.fromString` at routes/anonymousReview.ts:174 — same defect class
    // as admin/bridge but uncovered by the round-1 boot validator.
    // Round-3 item 6a: include dhive error-class hint to mirror round-1 admin/bridge rigor.
    expect(validatePostingKeyFormat('', 'PEVO_ANON_POSTING_KEY')).toBeNull();
    const validWif = PrivateKey.fromSeed('startup-checks-anon-fixture').toString();
    expect(validatePostingKeyFormat(validWif, 'PEVO_ANON_POSTING_KEY')).toBeNull();
    const malformedErr = validatePostingKeyFormat('not-a-wif', 'PEVO_ANON_POSTING_KEY');
    expect(malformedErr).not.toBeNull();
    expect(malformedErr).toContain('PEVO_ANON_POSTING_KEY');
    expect(malformedErr).toContain('invalid WIF format');
    expect(malformedErr).toContain('Error');
    expect(malformedErr).toContain('Non-base58 character');
  });

  it('rejects whitespace-only WIF with a recognizable error message (round-3 item 4)', () => {
    // Round-3 item 4: a copy-paste artifact like PEVO_ADMIN_POSTING_KEY=' '
    // would otherwise fall through to dhive's generic 'Non-base58 character',
    // leading operators to misdiagnose copy-paste artifacts as key corruption.
    // Mirror the .trim() guard from validateAccountNameFormat so the message is
    // recognizable.
    const result = validatePostingKeyFormat('   ', 'PEVO_ADMIN_POSTING_KEY');
    expect(result).not.toBeNull();
    expect(result).toContain('PEVO_ADMIN_POSTING_KEY');
    expect(result).toContain('empty or whitespace-only');
  });

  it('rejects single-space WIF (canonical adversarial copy-paste case)', () => {
    const result = validatePostingKeyFormat(' ', 'PEVO_ANON_POSTING_KEY');
    expect(result).not.toBeNull();
    expect(result).toContain('PEVO_ANON_POSTING_KEY');
    expect(result).toContain('empty or whitespace-only');
  });
});

describe('validateAccountNameFormat', () => {
  it('returns null for an unset value (preserves optional semantics)', () => {
    expect(validateAccountNameFormat('', 'HIVE_BRIDGE_ACCOUNT')).toBeNull();
  });

  it('returns null for a valid Hive account name', () => {
    expect(validateAccountNameFormat('pevo.admin', 'HIVE_ADMIN_ACCOUNT')).toBeNull();
    expect(validateAccountNameFormat('pevo.bridge', 'HIVE_BRIDGE_ACCOUNT')).toBeNull();
    expect(validateAccountNameFormat('alice', 'HIVE_ANON_ACCOUNT')).toBeNull();
    expect(validateAccountNameFormat('a-b-c', 'HIVE_ONBOARD_ACCOUNT')).toBeNull();
  });

  it('rejects whitespace-only value with a recognizable error message', () => {
    const result = validateAccountNameFormat('   ', 'HIVE_BRIDGE_ACCOUNT');
    expect(result).not.toBeNull();
    expect(result).toContain('HIVE_BRIDGE_ACCOUNT');
    expect(result).toContain('empty or whitespace-only');
  });

  it('rejects single-space value (the canonical adversarial case)', () => {
    // The adversarial scenario: `HIVE_BRIDGE_ACCOUNT=' '` would silently exclude
    // all bridge papers via validPevoPaperWhere's author pin.
    const result = validateAccountNameFormat(' ', 'HIVE_BRIDGE_ACCOUNT');
    expect(result).not.toBeNull();
    expect(result).toContain('HIVE_BRIDGE_ACCOUNT');
  });

  it('rejects uppercase characters', () => {
    const result = validateAccountNameFormat('PevoAdmin', 'HIVE_ADMIN_ACCOUNT');
    expect(result).not.toBeNull();
    expect(result).toContain('HIVE_ADMIN_ACCOUNT');
    expect(result).toContain('invalid Hive account-name format');
  });

  it('rejects names that are too short (under 3 chars)', () => {
    const result = validateAccountNameFormat('ab', 'HIVE_ADMIN_ACCOUNT');
    expect(result).not.toBeNull();
    expect(result).toContain('HIVE_ADMIN_ACCOUNT');
  });

  it('rejects names that are too long (over 16 chars)', () => {
    const result = validateAccountNameFormat('a'.repeat(17), 'HIVE_ADMIN_ACCOUNT');
    expect(result).not.toBeNull();
    expect(result).toContain('HIVE_ADMIN_ACCOUNT');
  });

  it('accepts names at the inclusive lower-length boundary (3 chars) (round-3 item 6b)', () => {
    // A future off-by-one regex tweak (e.g. {3,15} or {2,14}) would slip
    // through if only rejection at 2 is tested. Pin acceptance at the
    // inclusive boundary so the boundary itself is covered.
    expect(validateAccountNameFormat('abc', 'HIVE_ADMIN_ACCOUNT')).toBeNull();
  });

  it('accepts names at the inclusive upper-length boundary (16 chars) (round-3 item 6b)', () => {
    expect(validateAccountNameFormat('a'.repeat(16), 'HIVE_ADMIN_ACCOUNT')).toBeNull();
  });

  it('rejects trailing dot (round-3 item 1: canonical-shape gap)', () => {
    // Adversarial: 'pevo.' boots clean under the legacy /^[a-z][a-z0-9.-]{2,15}$/
    // and silently mismatches every chain query — the exact failure mode the
    // boot validator was filed to prevent.
    const result = validateAccountNameFormat('pevo.', 'HIVE_BRIDGE_ACCOUNT');
    expect(result).not.toBeNull();
    expect(result).toContain('HIVE_BRIDGE_ACCOUNT');
  });

  it('rejects consecutive dots (round-3 item 1)', () => {
    const result = validateAccountNameFormat('foo..bar', 'HIVE_BRIDGE_ACCOUNT');
    expect(result).not.toBeNull();
    expect(result).toContain('HIVE_BRIDGE_ACCOUNT');
  });

  it('rejects trailing hyphen (round-3 item 1)', () => {
    const result = validateAccountNameFormat('a-bc-', 'HIVE_ADMIN_ACCOUNT');
    expect(result).not.toBeNull();
    expect(result).toContain('HIVE_ADMIN_ACCOUNT');
  });

  it('rejects leading dot (round-3 item 1)', () => {
    const result = validateAccountNameFormat('.abc', 'HIVE_ADMIN_ACCOUNT');
    expect(result).not.toBeNull();
    expect(result).toContain('HIVE_ADMIN_ACCOUNT');
  });

  it('rejects segment shorter than 3 chars in dotted name (round-3 item 1)', () => {
    // Hive's per-segment 3-16 char rule: 'pevo.ab' has a 2-char trailing segment.
    const result = validateAccountNameFormat('pevo.ab', 'HIVE_BRIDGE_ACCOUNT');
    expect(result).not.toBeNull();
    expect(result).toContain('HIVE_BRIDGE_ACCOUNT');
  });

  it('rejects names starting with a digit', () => {
    const result = validateAccountNameFormat('1abc', 'HIVE_ADMIN_ACCOUNT');
    expect(result).not.toBeNull();
    expect(result).toContain('HIVE_ADMIN_ACCOUNT');
  });

  it('rejects special characters not in [a-z0-9.-]', () => {
    expect(validateAccountNameFormat('a_b_c', 'HIVE_ADMIN_ACCOUNT')).not.toBeNull();
    expect(validateAccountNameFormat('a$bc', 'HIVE_ADMIN_ACCOUNT')).not.toBeNull();
    expect(validateAccountNameFormat('a b c', 'HIVE_ADMIN_ACCOUNT')).not.toBeNull();
  });

  it('passes the env var name through verbatim so operators can grep the boot log', () => {
    const adminErr = validateAccountNameFormat('  ', 'HIVE_ADMIN_ACCOUNT');
    const bridgeErr = validateAccountNameFormat('  ', 'HIVE_BRIDGE_ACCOUNT');
    expect(adminErr).toContain('HIVE_ADMIN_ACCOUNT');
    expect(bridgeErr).toContain('HIVE_BRIDGE_ACCOUNT');
    expect(adminErr).not.toContain('HIVE_BRIDGE_ACCOUNT');
    expect(bridgeErr).not.toContain('HIVE_ADMIN_ACCOUNT');
  });
});
