import { describe, it, expect } from 'vitest';
import { localeStrippedPath } from '../../src/lib/url-sync.js';

describe('localeStrippedPath', () => {
  it('returns the path unchanged when there is no locale prefix', () => {
    expect(localeStrippedPath('/papers')).toBe('/papers');
  });

  it('strips a 2-letter locale prefix', () => {
    expect(localeStrippedPath('/en/papers')).toBe('/papers');
  });

  it('strips a 3-letter locale prefix', () => {
    expect(localeStrippedPath('/fra/papers')).toBe('/papers');
  });

  it('strips a locale prefix and drops a trailing slash', () => {
    expect(localeStrippedPath('/fr/papers/')).toBe('/papers');
  });

  it('returns /researchers unchanged when no locale prefix is present', () => {
    expect(localeStrippedPath('/researchers')).toBe('/researchers');
  });

  it('does not confuse a non-locale first segment with a locale', () => {
    // `/research-something` has no `/` or end-of-string right after a
    // 2-3 char prefix, so the lookahead rejects the locale match and the
    // path passes through untouched. In particular it must not collapse
    // to `/researchers` or anything resembling it.
    expect(localeStrippedPath('/research-something')).toBe('/research-something');
    expect(localeStrippedPath('/research-something')).not.toBe('/researchers');
  });

  it('returns "/" for a bare locale-only path', () => {
    expect(localeStrippedPath('/en')).toBe('/');
    expect(localeStrippedPath('/fr/')).toBe('/');
  });

  it('returns "/" for the root', () => {
    expect(localeStrippedPath('/')).toBe('/');
  });
});
