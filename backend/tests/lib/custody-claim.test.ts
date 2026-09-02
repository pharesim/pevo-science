/**
 * Unit pins for `custodyClaimFor`, the one derivation of a session's
 * `custody` claim from an `accounts` row.
 *
 * The helper is small on purpose; what these pins protect is its DIRECTION.
 * `'light'` is the claim that grants server-side signing, so the derivation
 * mints it only from a row with no `upgraded_at` epoch AND an explicit
 * `'light'` column, and everything else falls toward `'self'`. The route
 * suites show the mints agreeing on well-formed rows; only a unit test can
 * feed the derivation a row the schema CHECK would refuse and pin which way
 * it falls.
 *
 * No mocks, no database: pure function.
 */

import { describe, it, expect } from 'vitest';
import { custodyClaimFor } from '../../src/lib/custody-claim.js';

describe('custodyClaimFor', () => {
  it('mints light for the light states A/B/C (column light, no epoch)', () => {
    expect(custodyClaimFor({ custody: 'light', upgraded_at: null })).toBe('light');
  });

  it('mints self for state D (column self, epoch set)', () => {
    expect(custodyClaimFor({ custody: 'self', upgraded_at: new Date() })).toBe('self');
    // The pg driver hands back a Date for TIMESTAMPTZ; a few row types across
    // the mint sites annotate it as the ISO string instead. Only nullness
    // matters, so both spellings must read the same.
    expect(custodyClaimFor({ custody: 'self', upgraded_at: '2026-01-01T00:00:00.000Z' })).toBe('self');
  });

  it('reads the epoch ahead of the column: an epoch on a light column still mints self', () => {
    // The row shape the pre-fix upgrade route produced. The back-fill and the
    // schema CHECK make it unreachable in the database, but the derivation's
    // direction is what keeps a stale light claim from ever being minted if
    // a row like it were read, and that direction is pinned here rather than
    // assumed.
    expect(custodyClaimFor({ custody: 'light', upgraded_at: new Date() })).toBe('self');
    expect(custodyClaimFor({ custody: null, upgraded_at: new Date() })).toBe('self');
  });

  it('honours a self column with no epoch', () => {
    expect(custodyClaimFor({ custody: 'self', upgraded_at: null })).toBe('self');
  });

  it('mints self for a row with no custody value: the Keychain account that added an email', () => {
    // A pure self-custody Keychain user who registers an email through
    // settings gets a row with a username and no custody value; the server
    // holds no keys for it, so it must read as self. This is the row the
    // settings reader reports on, and the one shape where the old inline
    // derivations disagreed with each other (the settings reader said self,
    // the mints said light).
    expect(custodyClaimFor({ custody: null, upgraded_at: null })).toBe('self');
  });

  it('normalises an unexpected column value to self, the claim that grants nothing', () => {
    // The column is TEXT; the claim type is the closed pair. Anything that is
    // not the explicit light marker must not be promoted into the claim that
    // lets the server sign.
    expect(custodyClaimFor({ custody: 'unexpected', upgraded_at: null })).toBe('self');
    expect(custodyClaimFor({ custody: '', upgraded_at: null })).toBe('self');
  });

  it('treats an absent epoch column as not upgraded', () => {
    // A mocked row that omits `upgraded_at` reads as undefined at runtime;
    // that must mean "no epoch", never "self", so the explicit light column
    // still wins. The cast is the only way to hand the helper the shape a
    // mock would.
    expect(custodyClaimFor({ custody: 'light' } as unknown as Parameters<typeof custodyClaimFor>[0])).toBe('light');
  });
});
