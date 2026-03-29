import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

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
