/**
 * Route-level + generator tests for `GET /api/papers/:author/:permlink/cite`.
 *
 * The route block exercises the real HTTP handler against real HAF/Hive (400 on
 * bad format, 404 on missing paper, 200 + non-empty content for a real paper).
 *
 * The "live detail shape" block drives the exported generators with a `detail`
 * object shaped exactly like the one `fetchPaperDetailFromHaf` hands the route:
 * co-author names in `detail.authors` (the supersession/cumulative projection,
 * which always carries a `name`) and the DOI under `meta[config.appTag].source.doi`
 * (read via `safePevoMeta`). This is the contract a real fetched paper satisfies;
 * a synthetic `{ pevo: { authors } }` shape (the OLD buggy read) is deliberately
 * NOT used. No middleware/DB is involved for these — the generators are pure.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { generateBibtex, generateRis, generateApa } from '../../src/routes/papers.js';
import { config } from '../../src/config.js';

const app = createApp();

describe('GET /api/papers/:author/:permlink/cite', () => {
  it('rejects invalid format', async () => {
    const res = await request(app).get('/api/papers/nobody/no-paper/cite?format=invalid');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 404 for nonexistent paper', async () => {
    const res = await request(app).get('/api/papers/nobody/no-paper/cite?format=bibtex');
    expect(res.status).toBe(404);
  });

  it('returns citation in all formats when paper exists', async () => {
    // Find a real paper to cite
    const listRes = await request(app).get('/api/papers?limit=1');
    if (listRes.body.data.length === 0) return;

    const { author, permlink } = listRes.body.data[0];

    for (const format of ['bibtex', 'ris', 'apa']) {
      const res = await request(app).get(`/api/papers/${author}/${permlink}/cite?format=${format}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.data.format).toBe(format);
      expect(typeof res.body.data.content).toBe('string');
      expect(res.body.data.content.length).toBeGreaterThan(0);
    }
  });
});

// The route hands the generators a `detail` whose authors live in
// `detail.authors` (the supersession/cumulative projection) and whose DOI lives
// under `meta[config.appTag].source.doi`. These assert the generators read those
// keys: co-author NAMES (not just the posting account) and the DOI line appear.
// A test goes RED if a generator reverts to `detail.json_metadata.pevo` / `detail.doi`.
describe('GET /api/papers/:author/:permlink/cite live detail shape (authors + DOI)', () => {
  // A multi-author paper carrying a DOI, in the exact shape the live /cite path
  // builds: names in detail.authors, DOI under meta[config.appTag].source.doi.
  const detailWithDoi: Record<string, unknown> = {
    author: 'alice',
    permlink: 'collab-paper',
    title: 'A Collaborative Result',
    created: '2024-02-01T00:00:00Z',
    authors: [
      { name: 'Alice Smith', hive: 'alice', orcid: '0000-0001-0000-0001', orcid_verified: '0000-0001-0000-0001', orcid_discrepancy: false },
      { name: 'Bob Jones', hive: 'bob', orcid: '0000-0002-0000-0002', orcid_verified: null, orcid_discrepancy: false },
    ],
    json_metadata: { [config.appTag]: { source: { doi: '10.1000/collab-2024' } } },
  };

  it('BibTeX lists every co-author name and a doi field', () => {
    const out = generateBibtex(detailWithDoi);
    expect(out).toContain('author = {Alice Smith and Bob Jones}');
    expect(out).toContain('doi = {10.1000/collab-2024}');
  });

  it('RIS emits an AU line per co-author and a DO line', () => {
    const lines = generateRis(detailWithDoi).split('\n');
    expect(lines.filter((l) => l.startsWith('AU  - '))).toEqual(['AU  - Alice Smith', 'AU  - Bob Jones']);
    expect(lines.filter((l) => l.startsWith('DO  - '))).toEqual(['DO  - 10.1000/collab-2024']);
  });

  it('APA joins every co-author name', () => {
    expect(generateApa(detailWithDoi)).toContain('Alice Smith, Bob Jones (');
  });

  it('emits no DOI line for a paper without a source DOI', () => {
    const detailNoDoi: Record<string, unknown> = {
      author: 'alice',
      permlink: 'solo-paper',
      title: 'A Solo Result',
      created: '2024-02-01T00:00:00Z',
      authors: [{ name: 'Alice Smith', hive: 'alice', orcid: '0000-0001-0000-0001' }],
      json_metadata: { [config.appTag]: {} },
    };
    expect(generateBibtex(detailNoDoi)).not.toContain('doi = {');
    expect(generateRis(detailNoDoi).split('\n').filter((l) => l.startsWith('DO  - '))).toHaveLength(0);
  });
});
