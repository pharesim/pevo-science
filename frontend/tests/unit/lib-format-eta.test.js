import { describe, it, expect } from 'vitest';
import { formatEta } from '../../src/lib/format-eta.js';

// $t stub echoes the key plus its params so assertions can pin both the
// selected i18n key and the bucketed values the formatter passed.
const t = (key, params) => (params ? `${key}|${JSON.stringify(params)}` : key);

describe('formatEta', () => {
  it('returns etaUnknown for null / undefined', () => {
    expect(formatEta(null, t)).toBe('myImports.etaUnknown');
    expect(formatEta(undefined, t)).toBe('myImports.etaUnknown');
  });

  it('returns etaUnknown for non-finite or negative input', () => {
    expect(formatEta(NaN, t)).toBe('myImports.etaUnknown');
    expect(formatEta(Infinity, t)).toBe('myImports.etaUnknown');
    expect(formatEta(-30, t)).toBe('myImports.etaUnknown');
  });

  it('floors a 0s ETA to ~1 min rather than ~0 min', () => {
    // Position-1 dispatch has eta_seconds 0; "~0 min" reads as "should be done".
    expect(formatEta(0, t)).toBe('myImports.etaMinutes|{"minutes":1}');
  });

  it('rounds sub-hour seconds to whole minutes', () => {
    expect(formatEta(90, t)).toBe('myImports.etaMinutes|{"minutes":2}');   // 1.5 min → 2
    expect(formatEta(600, t)).toBe('myImports.etaMinutes|{"minutes":10}');
    expect(formatEta(3540, t)).toBe('myImports.etaMinutes|{"minutes":59}');
  });

  it('switches to hours+minutes at and above 60 minutes', () => {
    expect(formatEta(3600, t)).toBe('myImports.etaHours|{"hours":1,"minutes":0}');
    expect(formatEta(5400, t)).toBe('myImports.etaHours|{"hours":1,"minutes":30}');
    expect(formatEta(9000, t)).toBe('myImports.etaHours|{"hours":2,"minutes":30}');
  });
});
