import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

const app = createApp();

describe('GET /api/papers/:author/:permlink/comments', () => {
  it('returns 404 for nonexistent paper', async () => {
    const res = await request(app).get('/api/papers/nobody/no-paper/comments');
    expect(res.status).toBe(404);
    expect(res.body.status).toBe('error');
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns comments with correct structure when paper exists', async () => {
    // Find a real paper first
    const listRes = await request(app).get('/api/papers?limit=1');
    if (listRes.body.data.length === 0) return;

    const { author, permlink } = listRes.body.data[0];
    const res = await request(app).get(`/api/papers/${author}/${permlink}/comments`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toHaveProperty('page');
    expect(res.body.meta).toHaveProperty('limit');
    expect(res.body.meta).toHaveProperty('total');

    if (res.body.data.length > 0) {
      const comment = res.body.data[0];
      expect(comment).toHaveProperty('author');
      expect(comment).toHaveProperty('permlink');
      expect(comment).toHaveProperty('body');
      expect(comment).toHaveProperty('created');
      expect(comment).toHaveProperty('net_votes');
      expect(comment).toHaveProperty('is_accredited');
      expect(comment).toHaveProperty('parent_author');
      expect(comment).toHaveProperty('parent_permlink');
    }
  });

  it('respects limit parameter', async () => {
    const listRes = await request(app).get('/api/papers?limit=1');
    if (listRes.body.data.length === 0) return;

    const { author, permlink } = listRes.body.data[0];
    const res = await request(app).get(`/api/papers/${author}/${permlink}/comments?limit=1`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(1);
  });

  // backend-papers-filter-accreditation lane 2 canary: comments are
  // gated unconditionally to accredited authors at the SQL layer
  // (`JOIN active_accreditations aa ON aa.account = dc.author`).
  // Every returned comment must have `is_accredited: true`. A regression
  // that re-introduces the conditional accreditedJoin would surface here
  // as an entry with is_accredited:false.
  it('every returned comment is accredited-authored (no unaccredited leaks)', { timeout: 60_000 }, async () => {
    const listRes = await request(app).get('/api/papers?limit=10');
    if (listRes.body.data.length === 0) return;
    for (const paper of listRes.body.data) {
      const res = await request(app).get(`/api/papers/${paper.author}/${paper.permlink}/comments`);
      expect(res.status).toBe(200);
      for (const comment of res.body.data) {
        expect(
          comment.is_accredited,
          `comment ${comment.author}/${comment.permlink} on paper ${paper.author}/${paper.permlink} has is_accredited:${comment.is_accredited}`,
        ).toBe(true);
      }
    }
  });

  // Regression canary: the comment tree CTE uses self-reference in its
  // UNION ALL recursive arm. Without `WITH RECURSIVE` the query fails
  // to parse and fetchCommentsFromHaf catches/swallows the error, leaving
  // the endpoint to return empty `[]` with no signal. A second sibling
  // bug (ORDER BY referencing the inner-CTE alias `dc` at the outermost
  // SELECT) only surfaced after the RECURSIVE fix.
  //
  // This canary pins a real on-chain PEvO comment that MUST round-trip
  // through the SQL query. If the comment ever stops appearing here,
  // either the SQL regressed or the underlying chain object was
  // retracted — both worth a failing test.
  it('returns both PEvO-authored and non-PEvO-authored replies by accredited scientists', { timeout: 60_000, retry: 5 }, async () => {
    const PAPER_AUTHOR = 'jesusalejos';
    const PAPER_PERMLINK = 'tica-y-meta-antropologa-una-aproximacin-al-sentido-de-la-tecnologa-hoy-en-hans-urs-von-balthasar-mp2t81qb';
    // PEvO-authored: app=pevotest/0.1, pevotest.type='comment'
    const PEVO_COMMENT = 're-tica-y-meta-antropologa-una-aproximacin--1778602170560-55ex0f';
    // peakd-authored: json_metadata={"tags":"pevotest"}, no app field, no pevotest.type.
    // Author is accredited, so it MUST appear under the "accreditation is
    // the trust layer" policy. The SQL filter excludes only typed reviews
    // (type='review'), not non-PEvO clients.
    const PEAKD_COMMENT = 're-jesusalejos-texm5t';
    const res = await request(app).get(`/api/papers/${PAPER_AUTHOR}/${PAPER_PERMLINK}/comments`);
    expect(res.status).toBe(200);
    const permlinks = res.body.data.map((c: { permlink: string }) => c.permlink);
    expect(
      permlinks,
      'PEvO-authored discussion comment must appear; if missing, the comments CTE likely silently failed (check server logs for "HAF comments query failed")',
    ).toContain(PEVO_COMMENT);
    expect(
      permlinks,
      'Non-PEvO-authored reply by an accredited scientist must appear; if missing, the SQL is re-gating on the authoring client',
    ).toContain(PEAKD_COMMENT);
  });

  // Regression: an accredited-authored reply whose parent comment is
  // authored by a non-accredited Hive account (e.g. posted via peakd by
  // an unaccredited user) must NOT survive the listing. The outer
  // `accreditedJoin` only gates on the row's own author, so without a
  // descent-side gate in the recursive CTE arm such replies would render
  // as orphans against missing context. The fix adds an EXISTS
  // (active_accreditations) clause to the recursive arm so descent only
  // proceeds through accredited parents.
  //
  // This canary pins a real on-chain orphan: `pevo.science` replied to a
  // comment authored by `joann2`, who is not accredited. The reply must
  // be absent from the response (parent is gone; reply has no context).
  //
  // This paper's CORRECT listing is empty: every direct reply is authored
  // by a non-accredited account (dropped by the outer accreditedJoin), and
  // the sole accredited comment is the orphan itself, which the descent
  // gate hides. The test is still not vacuous on that empty result:
  //   - `status === 200` proves a real response, not a masked failure.
  //     `fetchCommentsFromHaf` loud-fails (throws -> 503/500) on a HAF/CTE
  //     error, so an error can never masquerade as an empty `200 []`.
  //   - `.not.toContain(orphan)` kills the descent-gate mutation: reverting
  //     the recursive-arm EXISTS makes the orphan reappear (its own author
  //     is accredited), turning the response non-empty so the assertion
  //     fails. The kill does not require a non-empty correct result, so no
  //     positive-presence floor is asserted (this paper has no accredited
  //     non-orphan sibling to assert on).
  it('hides accredited replies whose parent author is non-accredited', { timeout: 60_000, retry: 5 }, async () => {
    const PAPER_AUTHOR = 'pevo.science';
    const PAPER_PERMLINK = 'pevo-original-whitepaper-2016-2026-revision-mnczwwdm';
    const ORPHAN_REPLY_PERMLINK = 're-joann2-tdeuxx';
    const res = await request(app).get(`/api/papers/${PAPER_AUTHOR}/${PAPER_PERMLINK}/comments?limit=200`);
    expect(res.status).toBe(200);
    const permlinks = res.body.data.map((c: { permlink: string }) => c.permlink);
    expect(
      permlinks,
      'accredited reply with non-accredited parent must be hidden; if present, the recursive CTE descent is not gated on parent accreditation',
    ).not.toContain(ORPHAN_REPLY_PERMLINK);
  });

  // Pagination integrity: meta.total must match the size of the unpaginated
  // data set. If the data query gates descent on accreditation but the count
  // query does not (or vice versa), totals drift from rendered counts and
  // pagination breaks. Pin the bug-paper because we know it has a deliberate
  // mismatch case (orphan reply) that the count query must also exclude.
  it('meta.total matches the unpaginated data length for the orphan-parent paper', { timeout: 60_000, retry: 5 }, async () => {
    const PAPER_AUTHOR = 'pevo.science';
    const PAPER_PERMLINK = 'pevo-original-whitepaper-2016-2026-revision-mnczwwdm';
    const res = await request(app).get(`/api/papers/${PAPER_AUTHOR}/${PAPER_PERMLINK}/comments?limit=200`);
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(res.body.data.length);
  });

  // backend-papers-filter-accreditation lane 2 canary: legacy
  // `?accredited_only=false` opt-out is silently ignored. A regression
  // that re-introduces the parse + JOIN-toggle branch would surface here
  // as a divergence between param-on and param-off listings.
  it('?accredited_only=false is silently ignored (returns identical set to no param)', { timeout: 60_000 }, async () => {
    const listRes = await request(app).get('/api/papers?limit=1');
    if (listRes.body.data.length === 0) return;
    const { author, permlink } = listRes.body.data[0];
    const [withoutParam, withFalseParam] = await Promise.all([
      request(app).get(`/api/papers/${author}/${permlink}/comments`),
      request(app).get(`/api/papers/${author}/${permlink}/comments?accredited_only=false`),
    ]);
    expect(withoutParam.status).toBe(200);
    expect(withFalseParam.status).toBe(200);
    expect(withFalseParam.body.meta.total).toBe(withoutParam.body.meta.total);
    const key = (c: { author: string; permlink: string }) => `${c.author}/${c.permlink}`;
    expect(new Set(withFalseParam.body.data.map(key))).toEqual(new Set(withoutParam.body.data.map(key)));
  });

  // Canonical per-paper tree cache invariant: every sort/order/page
  // combination must yield the same UNDERLYING set of comments. Sort/order
  // only reorder; pagination only slices. The JS-side paginator runs against
  // a single cached tree, so a regression that drops rows in the slice or
  // skips the deep copy before sort would surface here as a set divergence
  // between (sort=date, order=asc) and (sort=votes, order=desc) on the
  // bug-paper that has a known multi-comment tree.
  it('JS-side sort/order produce identical sets across all four (sort,order) variants', { timeout: 60_000, retry: 5 }, async () => {
    const PAPER_AUTHOR = 'jesusalejos';
    const PAPER_PERMLINK = 'tica-y-meta-antropologa-una-aproximacin-al-sentido-de-la-tecnologa-hoy-en-hans-urs-von-balthasar-mp2t81qb';
    const variants = [
      { sort: 'date', order: 'asc' },
      { sort: 'date', order: 'desc' },
      { sort: 'votes', order: 'asc' },
      { sort: 'votes', order: 'desc' },
    ];
    const responses = await Promise.all(
      variants.map((v) =>
        request(app).get(
          `/api/papers/${PAPER_AUTHOR}/${PAPER_PERMLINK}/comments?limit=200&sort=${v.sort}&order=${v.order}`,
        ),
      ),
    );
    const sets = responses.map((r) => {
      expect(r.status).toBe(200);
      return new Set(r.body.data.map((c: { author: string; permlink: string }) => `${c.author}/${c.permlink}`));
    });
    // All four variants must produce the same underlying set.
    for (let i = 1; i < sets.length; i++) {
      expect(sets[i]).toEqual(sets[0]);
    }
    // meta.total must agree across variants (canonical tree's `total` is
    // sort-independent; only the slice changes).
    for (let i = 1; i < responses.length; i++) {
      expect(responses[i].body.meta.total).toBe(responses[0].body.meta.total);
    }
  });

  // Pagination boundary: page-2 must not duplicate or skip rows relative to
  // page-1 (the JS-side slice would drop a row if `offset` were miscomputed,
  // or duplicate one if the sort was unstable across pages). Use limit=2 to
  // force a real page boundary on the canonical tree.
  it('paginated slices concatenate to the unpaginated list (no skips, no duplicates)', { timeout: 60_000, retry: 5 }, async () => {
    const PAPER_AUTHOR = 'jesusalejos';
    const PAPER_PERMLINK = 'tica-y-meta-antropologa-una-aproximacin-al-sentido-de-la-tecnologa-hoy-en-hans-urs-von-balthasar-mp2t81qb';
    const all = await request(app).get(
      `/api/papers/${PAPER_AUTHOR}/${PAPER_PERMLINK}/comments?limit=200&sort=date&order=asc`,
    );
    expect(all.status).toBe(200);
    if (all.body.data.length < 3) return; // not enough to exercise the boundary
    const [p1, p2] = await Promise.all([
      request(app).get(`/api/papers/${PAPER_AUTHOR}/${PAPER_PERMLINK}/comments?limit=2&page=1&sort=date&order=asc`),
      request(app).get(`/api/papers/${PAPER_AUTHOR}/${PAPER_PERMLINK}/comments?limit=2&page=2&sort=date&order=asc`),
    ]);
    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    const key = (c: { author: string; permlink: string }) => `${c.author}/${c.permlink}`;
    const concat = [...p1.body.data, ...p2.body.data].map(key);
    const expected = all.body.data.slice(0, concat.length).map(key);
    expect(concat).toEqual(expected);
    // No row appears in both pages.
    const p1Keys = new Set(p1.body.data.map(key));
    for (const c of p2.body.data) {
      expect(p1Keys.has(key(c))).toBe(false);
    }
  });
});
