import { describe, it, expect } from 'vitest';
import {
  validateSearchQuery,
  escapeLikePattern,
  SEARCH_QUERY_MAX_LEN,
} from '../../src/types/search-filters.js';

/**
 * Helper-direct unit tests for `validateSearchQuery` and `escapeLikePattern`
 * (BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP). Real-HAF coverage in
 * `tests/routes/search.test.ts` exercises the helper through the route
 * binding; these specs pin the helper's branches directly so a refactor
 * cannot mask a regression in the helper itself, and the boundary at
 * `SEARCH_QUERY_MAX_LEN` is asserted at exactly 200/201 chars.
 */

describe('validateSearchQuery — absent / non-string shapes return null', () => {
  it('returns null for null', () => {
    expect(validateSearchQuery(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(validateSearchQuery(undefined)).toBeNull();
  });

  it('returns null for the empty string', () => {
    expect(validateSearchQuery('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    // Existing behavior: whitespace-only `?q=` is treated as absent and the
    // route returns 400 "Search query \"q\" is required". The helper folds
    // this branch into the null path so the call site has one shape for
    // "absent or required".
    expect(validateSearchQuery('   ')).toBeNull();
    expect(validateSearchQuery('\t\n')).toBeNull();
  });

  it('returns null for repeated-param string[] shape (?q=a&q=b)', () => {
    // Express types `req.query[k]` as
    // `string | ParsedQs | string[] | ParsedQs[] | undefined`. Repeated
    // params yield a `string[]`. Per the architect's decision baked into
    // the task, this silent-unfilters (matches the discipline contract);
    // since `q` is required, the route returns 400 required.
    expect(validateSearchQuery(['a', 'b'])).toBeNull();
  });

  it('returns null for ParsedQs object shape', () => {
    expect(validateSearchQuery({ foo: 'bar' })).toBeNull();
  });

  it('returns null for numeric input', () => {
    expect(validateSearchQuery(42)).toBeNull();
  });

  it('returns null for boolean input', () => {
    expect(validateSearchQuery(true)).toBeNull();
  });
});

describe('validateSearchQuery — happy path returns LIKE-escaped value', () => {
  it('passes through a clean ASCII query unchanged', () => {
    expect(validateSearchQuery('quantum computing')).toEqual({ ok: true, value: 'quantum computing' });
  });

  it('preserves Unicode letters', () => {
    expect(validateSearchQuery('mathématiques')).toEqual({ ok: true, value: 'mathématiques' });
  });

  it('preserves digits and punctuation that are not LIKE metacharacters', () => {
    expect(validateSearchQuery('CO2 reduction & climate science')).toEqual({
      ok: true,
      value: 'CO2 reduction & climate science',
    });
  });

  it('escapes a literal % to \\%', () => {
    // Without escape, Postgres would interpret % as a wildcard inside the
    // bound parameter and cause unbounded backtracking on
    // `%_%_%_…`-style payloads.
    expect(validateSearchQuery('50% off')).toEqual({ ok: true, value: '50\\% off' });
  });

  it('escapes a literal _ to \\_', () => {
    // Without escape, _ would match any single character — `f__` would
    // match `foo`, `fab`, etc., making the search useless and consuming
    // additional CPU.
    expect(validateSearchQuery('foo_bar')).toEqual({ ok: true, value: 'foo\\_bar' });
  });

  it('escapes a literal \\ to \\\\', () => {
    // The escape character itself must be escaped, otherwise the user
    // could pass `\%` to disable our escape and inject a wildcard.
    expect(validateSearchQuery('back\\slash')).toEqual({ ok: true, value: 'back\\\\slash' });
  });

  it('escapes mixed metacharacters in a single string', () => {
    // Combined payload — the canonical DoS shape `%_%_%_…` becomes
    // literal `\%\_\%\_\%\_…` after the escape, defanging the wildcard.
    expect(validateSearchQuery('%_\\test_%')).toEqual({ ok: true, value: '\\%\\_\\\\test\\_\\%' });
  });
});

describe('validateSearchQuery — length-cap boundary at SEARCH_QUERY_MAX_LEN', () => {
  it('exposes SEARCH_QUERY_MAX_LEN === 200', () => {
    // Pinning the exported constant prevents a silent widening of the cap.
    expect(SEARCH_QUERY_MAX_LEN).toBe(200);
  });

  it('accepts input at exactly SEARCH_QUERY_MAX_LEN chars', () => {
    // Boundary: the cap is inclusive (`raw.length > MAX` is the reject
    // branch). 200 chars must be accepted; an off-by-one flip from `>` to
    // `>=` would surface here.
    const at = 'a'.repeat(SEARCH_QUERY_MAX_LEN);
    expect(at).toHaveLength(200);
    expect(validateSearchQuery(at)).toEqual({ ok: true, value: at });
  });

  it('rejects input at exactly SEARCH_QUERY_MAX_LEN + 1 chars', () => {
    // Boundary: 201 chars must be rejected. Together with the 200-accept
    // case above this pins `>` (the correct operator).
    const over = 'a'.repeat(SEARCH_QUERY_MAX_LEN + 1);
    expect(over).toHaveLength(201);
    expect(validateSearchQuery(over)).toEqual({ ok: false, message: 'Search query too long' });
  });

  it('rejects multi-KB oversize input (DoS guard target)', () => {
    // The original DoS threat model: an attacker submits a multi-KB
    // `?q=` to force ILIKE backtracking. The 200-char cap closes this
    // well before it reaches Postgres.
    const huge = 'a'.repeat(4096);
    expect(validateSearchQuery(huge)).toEqual({ ok: false, message: 'Search query too long' });
  });
});

describe('escapeLikePattern — direct exposure for SQL-binder reuse', () => {
  it('is a no-op on input without LIKE metacharacters', () => {
    expect(escapeLikePattern('plain query')).toBe('plain query');
  });

  it('escapes only the three LIKE metacharacters (\\, %, _) and leaves others alone', () => {
    // Other shell/regex/SQL metacharacters (`*`, `?`, `[`, `(`, `;`, `'`)
    // are NOT LIKE wildcards and must pass through untouched. The escape
    // is scoped to LIKE semantics, not a generic SQL-injection guard
    // (parameterization handles that at the bind layer).
    expect(escapeLikePattern("a*b?c[d](e);f'g")).toBe("a*b?c[d](e);f'g");
  });
});
