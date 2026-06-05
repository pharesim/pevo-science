/**
 * SQL-shape canary: the paper arm of the `active_authors` CTE in the
 * reputation cycle MUST filter on the accredited-author set
 * (`c.author = ANY($2::text[])`).
 *
 * Background. `active_authors` UNIONs two arms: a paper arm (top-level
 * PEvO papers) and a review arm (review-shaped replies to those papers).
 * Its sole consumer, `voter_weights`, joins
 * `active_authors aa ON aa.author = a.voter` where `a.voter` iterates
 * `unnest($2::text[])` (accreditedArr). Any non-accredited author the
 * paper arm materializes is therefore discarded by that join — but
 * without an arm-level filter the paper arm first scans EVERY site-wide
 * PEvO paper author. Bounding the paper arm on `c.author = ANY($2)` makes
 * the scan proportional to the accredited set instead of the full corpus,
 * with no semantic delta for the consumer.
 *
 * The review arm already carries `(c.author = ANY($2::text[]) OR c.author
 * = $18)`. This canary pins the paper arm's `c.author = ANY($2::text[])`
 * and asserts the paper arm does NOT widen that filter with an
 * `OR c.author =` clause — a bridge account is never a voter, so OR'ing it
 * in would re-widen the scan for zero consumer benefit. A regression that
 * drops the paper-arm filter, or that "helpfully" adds the bridge OR to
 * the paper arm, fails red.
 *
 * This is a pure source-level shape pin: it reads `src/reputation.ts` as
 * text and scopes its assertions to the paper arm of the `active_authors`
 * CTE by anchoring on the stable CTE label and the `UNION ALL` arm
 * boundary. No database pool, no Hive API, and no auth middleware are
 * exercised, so the project test-mock carve-out does not apply (nothing
 * is mocked).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(__dirname, '../..');

describe('active_authors paper arm accredited-author filter — source-level shape pin', () => {
  const source = readFileSync(resolve(PROJECT_ROOT, 'src/reputation.ts'), 'utf-8');

  /**
   * Slice the `active_authors` CTE body, bounded by its stable CTE label
   * and the next CTE label (`voter_weights AS (`, its sole consumer). The
   * paper arm is everything before the first `UNION ALL`; the review arm
   * is everything after. Anchoring on these stable SQL tokens keeps the
   * assertions scoped to the paper arm and immune to line-number drift.
   */
  function paperArm(src: string): string {
    const start = src.indexOf('active_authors AS (');
    expect(start, 'active_authors CTE not found in reputation.ts').toBeGreaterThanOrEqual(0);
    const end = src.indexOf('voter_weights AS (', start);
    expect(end, 'voter_weights CTE (block terminator) not found after active_authors').toBeGreaterThan(start);
    const block = src.slice(start, end);
    const unionAt = block.indexOf('UNION ALL');
    expect(unionAt, 'active_authors must UNION ALL a paper arm and a review arm').toBeGreaterThan(0);
    return block.slice(0, unionAt);
  }

  it('paper arm filters on the accredited-author set (c.author = ANY($2::text[]))', () => {
    const arm = paperArm(source);
    // The paper arm selects from the comments table and filters top-level
    // PEvO papers; without this conjunct it scans the full site-wide corpus.
    expect(arm, 'paper arm must select c.author from the comments table').toContain('SELECT c.author FROM');
    expect(
      arm,
      'paper arm must bound the scan to the accredited-author set with c.author = ANY($2::text[])',
    ).toContain('c.author = ANY($2::text[])');
  });

  it('paper arm does NOT widen the accredited filter with a bridge OR-term', () => {
    const arm = paperArm(source);
    // Bridge accounts are never voters, so OR'ing one in would re-widen the
    // scan with zero benefit to the voter_weights consumer. The review arm
    // legitimately uses the `c.author = ANY($2::text[]) OR c.author = $18`
    // form; the paper arm must use the bare accredited-set filter. Pin the
    // absence of the `OR c.author =` SQL token rather than the bridge param
    // number itself — the param number ($17/$18) also appears in
    // validPevoPaperWhere's bridge composition and in explanatory prose, so
    // only the OR-clause token cleanly distinguishes a widened scan.
    expect(
      arm,
      'paper arm accredited filter must not be widened with an OR c.author term (e.g. OR c.author = $18)',
    ).not.toContain('OR c.author =');
  });
});
