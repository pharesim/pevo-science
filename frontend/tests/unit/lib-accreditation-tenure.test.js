import { describe, it, expect } from 'vitest';
import { getAccreditedSince } from '../../src/lib/accreditation-tenure.js';

describe('getAccreditedSince', () => {
  // The whole point of the anchor: a metadata re-broadcast advances the
  // latest-op `timestamp`, but tenure must read the earliest-op
  // `accredited_since`. This asserts the accessor PREFERS the anchor over the
  // latest-op timestamp — it FAILS if the accessor ever reverts to reading
  // `timestamp`, which is the silent-rot the shared helper exists to prevent.
  it('prefers accredited_since over the latest-op timestamp', () => {
    expect(getAccreditedSince({ accredited_since: 'SINCE', timestamp: 'LATEST' })).toBe('SINCE');
  });

  it('falls back to the latest-op timestamp when accredited_since is absent', () => {
    expect(getAccreditedSince({ timestamp: 'LATEST' })).toBe('LATEST');
  });

  it('returns null when neither field is present', () => {
    expect(getAccreditedSince({})).toBeNull();
  });

  it('returns null for a null/undefined accreditation', () => {
    expect(getAccreditedSince(null)).toBeNull();
    expect(getAccreditedSince(undefined)).toBeNull();
  });
});
