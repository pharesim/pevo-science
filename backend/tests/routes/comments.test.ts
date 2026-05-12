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
  it('returns both PEvO-authored and non-PEvO-authored replies by accredited scientists', { timeout: 60_000 }, async () => {
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
});
