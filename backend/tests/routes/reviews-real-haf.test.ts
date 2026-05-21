/**
 * Real-HAF integration companion suite for GET /api/reviews/:author/:permlink.
 *
 * This file deliberately does NOT invoke the test-mock carve-out (no
 * `vi.mock('../../src/db.js')`, no `MOCK_VERIFY_SIGNATURE` fixture, no
 * mocked pool helpers). It pairs with `reviews.test.ts`'s mocked-pool
 * coverage of the `buildReviewDetail` projection / `pevoString` collapse
 * semantics / SQL accreditation gate / SQL parent-paper parity gate, and
 * integrates the route against the live HAF pool so a different mutation
 * class (SQL composition errors, real CTE-binding bugs, pool config
 * errors, accreditation-set wiring) is caught at the route layer.
 *
 * Sibling real-HAF coverage by risk class:
 *   - `papers.test.ts` exercises the paper-detail reviews-array filter
 *     against real HAF — same author-vouching SQL pattern.
 *   - `review-parity-invariant.test.ts` exercises the display↔reputation
 *     predicate-set equality at sibling SQL sites.
 *   - `reputation-lifecycle.test.ts` exercises `user_reviews` CTE
 *     composition end-to-end against real HAF.
 *
 * The single-doc reviews endpoint was the only review-class route without
 * any real-HAF coverage; this file closes that gap for the 404 and 200
 * branches.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { isHafConfigured } from '../../src/db.js';

const app = createApp();

// Match the broader real-HAF integration files (`papers.test.ts`,
// `paper-detail-v3.test.ts`): override the walker wall-clock budget so the
// public HAF testnet's slower-than-default tail doesn't surface as 503
// SERVICE_UNAVAILABLE and mask the integration-shape assertions. Restored
// in afterAll so file ordering doesn't affect sibling suites.
let originalBudgetMs: number;
beforeAll(() => {
  originalBudgetMs = config.hafWalkerWallClockMs;
  (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = 60_000;
});
afterAll(() => {
  (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = originalBudgetMs;
});

describe('GET /api/reviews/:author/:permlink (real HAF)', () => {
  it.skipIf(!isHafConfigured())(
    'returns 404 + NOT_FOUND for an unseeded (author, permlink) pair',
    { timeout: 60_000 },
    async () => {
      // Random-shaped author/permlink that cannot exist on chain: Hive
      // usernames are bounded length and lowercase-alpha-only, but the
      // route doesn't validate input shape — it falls through to the HAF
      // query, which returns zero rows for any non-existent pair. The
      // route then sendError(404, 'NOT_FOUND'). No DB seed required;
      // pins the integrated path's empty-rows → 404 envelope contract.
      const res = await request(app).get(
        '/api/reviews/no-such-reviewer-9b3f/no-such-permlink-9b3f',
      );
      expect(res.status).toBe(404);
      expect(res.body?.status).toBe('error');
      expect(res.body?.error?.code).toBe('NOT_FOUND');
    },
  );

  it.skipIf(!isHafConfigured())(
    'returns 200 with the review envelope shape for a live accredited-reviewer record',
    { timeout: 90_000 },
    async (ctx) => {
      // Walk the live HAF for a real review: list papers, find one with
      // reviews, pick the first review. The live corpus may be empty in
      // a fresh test environment; ctx.skip() rather than vacuously pass
      // so absence is visible in CI instead of silent.
      // Walk a wider page than the typical real-HAF integration tests
      // (papers.test.ts uses limit=5). The single-doc reviews surface
      // depends on finding any paper with at least one review; review
      // density on the live testnet is thin, so a larger walk avoids
      // skipping the assertion when reviewed papers exist but aren't in
      // the top-N most-recent.
      const listRes = await request(app).get('/api/papers?limit=100');
      expect(listRes.status).toBe(200);
      if (!Array.isArray(listRes.body?.data) || listRes.body.data.length === 0) {
        ctx.skip('No papers in live HAF corpus; review-shape assertion not exercisable');
        return;
      }

      let reviewAuthor: string | undefined;
      let reviewPermlink: string | undefined;
      for (const paper of listRes.body.data as Array<{ author: string; permlink: string }>) {
        const detailRes = await request(app).get(
          `/api/papers/${paper.author}/${paper.permlink}`,
        );
        if (detailRes.status !== 200) continue;
        const reviews = detailRes.body?.data?.reviews as
          | Array<{ author?: string; permlink?: string }>
          | undefined;
        if (Array.isArray(reviews) && reviews.length > 0) {
          const first = reviews[0];
          if (typeof first?.author === 'string' && typeof first?.permlink === 'string') {
            reviewAuthor = first.author;
            reviewPermlink = first.permlink;
            break;
          }
        }
      }

      if (!reviewAuthor || !reviewPermlink) {
        ctx.skip('No paper with at least one review in live HAF corpus');
        return;
      }

      const res = await request(app).get(
        `/api/reviews/${reviewAuthor}/${reviewPermlink}`,
      );
      expect(res.status).toBe(200);
      expect(res.body?.status).toBe('ok');

      // Tolerant shape assertions only — values drift as the live corpus
      // evolves. Anchor on response envelope and `buildReviewDetail`
      // projection field names (the stable contract).
      const data = res.body?.data;
      expect(data).toBeTruthy();
      expect(data.author).toBe(reviewAuthor);
      expect(data.permlink).toBe(reviewPermlink);
      expect(typeof data.body).toBe('string');
      expect(data.rating).toBeTruthy();
      // Rating sub-keys mirror the `buildReviewDetail` default shape.
      expect(data.rating).toHaveProperty('methodology');
      expect(data.rating).toHaveProperty('novelty');
      expect(data.rating).toHaveProperty('clarity');
      expect(data.rating).toHaveProperty('significance');
      // `reviewer_attestation_id` is `pevoString(...)` collapsed: either
      // a non-empty string (anon-proxy attestation hash) or null. The
      // collapse semantic itself is pinned deterministically in the
      // sibling mocked-pool file; here we only assert the contract that
      // this field is one of those two runtime shapes.
      expect(
        data.reviewer_attestation_id === null
          || typeof data.reviewer_attestation_id === 'string',
      ).toBe(true);
      // Parent paper triple.
      expect(data.paper).toBeTruthy();
      expect(typeof data.paper.author).toBe('string');
      expect(typeof data.paper.permlink).toBe('string');
      expect(typeof data.paper.title).toBe('string');
      // Enrichment surface.
      expect(typeof data.is_accredited).toBe('boolean');
      expect(typeof data.is_anonymous).toBe('boolean');
      expect(typeof data.net_votes).toBe('number');
      expect(typeof data.reviewer_reputation).toBe('number');
      // Live-corpus admission invariant: the SQL gate admits only
      // accredited reviewers OR the configured anon-proxy account. The
      // enrichment layer then sets `is_accredited` based on the
      // accreditedSet membership check at `enrichReviewDetail`. So for a
      // review that surfaces here, either the row IS_accredited:true OR
      // the row IS the anon-proxy account with is_accredited:false. Any
      // other combination signals a regression in either the SQL gate
      // (un-accredited author leaking through) or the enrichment lookup
      // (accredited author mis-classified).
      if (data.is_accredited === false) {
        expect(data.author).toBe(config.hiveAnonAccount);
      }
    },
  );

  // Unaccredited-author 404 branch: a deterministic on-chain account
  // broadcasting a review-shaped comment under an unaccredited Hive
  // account cannot be located reliably on the public chain (the spam
  // vector exists in theory, but seeding such an account against the
  // public HAF DB is impractical per task acceptance #3). Confirmed
  // none surfaces via the listing walk above. That branch remains
  // pinned in mocked-pool coverage at `reviews.test.ts`'s SQL
  // accreditation gate describe block. The real-HAF predicate-set
  // equality is exercised at `review-parity-invariant.test.ts` for
  // the sibling-CTE risk class.
});
