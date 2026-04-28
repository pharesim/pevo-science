import { describe, it, expect } from 'vitest';
import {
  validateDisciplineFilter,
  DISCIPLINE_FILTER_MAX_LEN,
} from '../../src/types/disciplines.js';

/**
 * Helper-direct unit tests for `validateDisciplineFilter`. The supertest-level
 * coverage in `disciplines-canon-mocked.test.ts` exercises the helper through
 * the `?discipline=` route binding; these specs pin the helper's branches
 * directly so a refactor of the call sites cannot mask a regression in the
 * helper itself, and the boundary at `DISCIPLINE_FILTER_MAX_LEN` is asserted
 * at exactly 100/101 chars (an off-by-one flip from `>` to `>=` would pass
 * the existing 99-accept / 4000-reject assertions silently).
 */

describe('validateDisciplineFilter — absent / non-string shapes return null', () => {
  it('returns null for null', () => {
    expect(validateDisciplineFilter(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(validateDisciplineFilter(undefined)).toBeNull();
  });

  it('returns null for the empty string', () => {
    expect(validateDisciplineFilter('')).toBeNull();
  });

  it('returns null for repeated-param string[] shape (?discipline=a&discipline=b)', () => {
    // Express types `req.query[k]` as
    // `string | ParsedQs | string[] | ParsedQs[] | undefined`. Repeated
    // params yield a `string[]` which the helper must treat as absent —
    // the route handler relies on this to silently unfilter rather than
    // call `.toLowerCase()` on the array (which V8 coerces to the
    // useless string `"a,b"`).
    expect(validateDisciplineFilter(['a', 'b'])).toBeNull();
  });

  it('returns null for ParsedQs object shape', () => {
    // Same Express-types vector: a nested-bracket query
    // (`?discipline[foo]=bar`) yields a plain object. Helper rejects it
    // as a non-string shape and returns null.
    expect(validateDisciplineFilter({ foo: 'bar' })).toBeNull();
  });

  it('returns null for numeric input', () => {
    expect(validateDisciplineFilter(42)).toBeNull();
  });

  it('returns null for boolean input', () => {
    expect(validateDisciplineFilter(true)).toBeNull();
  });
});

describe('validateDisciplineFilter — happy path returns canonical lowercased value', () => {
  it('lowercases an ASCII single-word input', () => {
    expect(validateDisciplineFilter('Physics')).toEqual({ ok: true, value: 'physics' });
  });

  it('lowercases a multi-word ASCII input', () => {
    expect(validateDisciplineFilter('Computer Science')).toEqual({ ok: true, value: 'computer science' });
  });

  it('preserves an already-lowercase input verbatim', () => {
    expect(validateDisciplineFilter('biology')).toEqual({ ok: true, value: 'biology' });
  });

  it('accepts hyphen-containing values (e.g. "bio-physics")', () => {
    // The charset pattern explicitly allows `-` so compound disciplines
    // tagged with hyphens (rather than spaces) round-trip cleanly.
    expect(validateDisciplineFilter('bio-physics')).toEqual({ ok: true, value: 'bio-physics' });
  });

  it('accepts Unicode letters (Latin-extended diacritics)', () => {
    // `\p{L}` covers Unicode-letter codepoints. A French researcher tagging
    // their paper "Mathématiques" must round-trip through the filter.
    expect(validateDisciplineFilter('mathématiques')).toEqual({ ok: true, value: 'mathématiques' });
  });

  it('accepts Unicode letters (non-Latin scripts)', () => {
    // Greek capital letter Phi → small phi case fold is locale-dependent;
    // assert only that the helper returns ok with a string value, since
    // the lowercase result for non-ASCII Unicode depends on the V8 ICU
    // build — what we are pinning here is the charset-allow path.
    const result = validateDisciplineFilter('Φυσική');
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ ok: true });
    if (result && result.ok) {
      // Identity round-trip: lowercase of lowercase equals lowercase.
      expect(result.value).toBe(result.value.toLowerCase());
    }
  });

  it('accepts Unicode digits via \\p{N} (e.g. "co2 reduction")', () => {
    // The charset pattern allows `\p{N}` so disciplines containing digits
    // are not rejected.
    expect(validateDisciplineFilter('CO2 Reduction')).toEqual({ ok: true, value: 'co2 reduction' });
  });
});

describe('validateDisciplineFilter — length-cap boundary at DISCIPLINE_FILTER_MAX_LEN', () => {
  it('exposes DISCIPLINE_FILTER_MAX_LEN === 100', () => {
    // Pinning the exported constant prevents a silent widening of the cap
    // (e.g. someone bumps to 1000 to "fix" a stuck request without
    // understanding the DoS rationale).
    expect(DISCIPLINE_FILTER_MAX_LEN).toBe(100);
  });

  it('accepts input at exactly DISCIPLINE_FILTER_MAX_LEN chars', () => {
    // Boundary: the cap is inclusive (`raw.length > MAX` is the reject
    // branch). 100 chars must be accepted; an off-by-one flip from `>` to
    // `>=` would surface here (and only here — 99 chars pass either way).
    const at = 'a'.repeat(DISCIPLINE_FILTER_MAX_LEN);
    expect(at).toHaveLength(100);
    expect(validateDisciplineFilter(at)).toEqual({ ok: true, value: at });
  });

  it('rejects input at exactly DISCIPLINE_FILTER_MAX_LEN + 1 chars', () => {
    // Boundary: 101 chars must be rejected. Together with the 100-accept
    // case above this pins `>` (the correct operator). A revert to `>=`
    // would pass 100 → 99 (was already passing) but would FAIL 100 here
    // (because the 100-accept assertion above would flip from ok→reject).
    const over = 'a'.repeat(DISCIPLINE_FILTER_MAX_LEN + 1);
    expect(over).toHaveLength(101);
    expect(validateDisciplineFilter(over)).toEqual({ ok: false, message: 'Discipline filter invalid' });
  });

  it('rejects oversize multi-KB input (DoS guard target)', () => {
    // The original DoS threat model: an attacker submits a 1MB+
    // `?discipline=` to force `String.prototype.toLowerCase()` and
    // Postgres LOWER() over the full blob. The cap catches this well
    // before it reaches V8 / Postgres.
    const huge = 'a'.repeat(1024 * 1024);
    expect(validateDisciplineFilter(huge)).toEqual({ ok: false, message: 'Discipline filter invalid' });
  });
});

describe('validateDisciplineFilter — charset rejection', () => {
  it('rejects characters outside [Unicode letter | Unicode digit | space | hyphen]', () => {
    // `$` is outside `\p{L}\p{N} \-` — a query like `?discipline=$$$` is
    // clearly garbage / fuzzing and should 400 rather than fall through
    // to a 0-hit response.
    expect(validateDisciplineFilter('$$$')).toEqual({ ok: false, message: 'Discipline filter invalid' });
  });

  it('rejects values containing punctuation', () => {
    // Periods, commas, slashes, ampersands — none currently in the
    // taxonomy. If the publish-form charset widens later, the
    // `architect-discipline-filter-publish-charset-alignment` task
    // tracks the alignment.
    expect(validateDisciplineFilter('a.b')).toMatchObject({ ok: false });
    expect(validateDisciplineFilter('a,b')).toMatchObject({ ok: false });
    expect(validateDisciplineFilter('a/b')).toMatchObject({ ok: false });
    expect(validateDisciplineFilter('a&b')).toMatchObject({ ok: false });
  });

  it('rejects underscore (not in the allowed charset)', () => {
    // `_` is intentionally not in `\p{L}\p{N} \-`. If a discipline starts
    // using snake_case naming, that's a charset alignment decision, not
    // an emergency widening.
    expect(validateDisciplineFilter('bio_physics')).toMatchObject({ ok: false });
  });

  it('rejects HTML-like markup', () => {
    expect(validateDisciplineFilter('<script>alert(1)</script>')).toMatchObject({ ok: false });
  });

  it('emits the invalid-message string verbatim on guard failure', () => {
    // The route handler echoes `result.message` verbatim into the 400
    // response body. Pinning the literal here protects callers from a
    // silent message change that would break clients matching on the
    // string.
    const result = validateDisciplineFilter('$$$');
    expect(result).toEqual({ ok: false, message: 'Discipline filter invalid' });
  });
});
