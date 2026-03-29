import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

const app = createApp();

describe('Paper detail Phase 3 fields', () => {
  it('includes versions array and retraction fields when paper exists', async () => {
    // Find a real paper
    const listRes = await request(app).get('/api/papers?limit=1');
    if (listRes.body.data.length === 0) return;

    const { author, permlink } = listRes.body.data[0];
    const res = await request(app).get(`/api/papers/${author}/${permlink}`);
    expect(res.status).toBe(200);

    // Versions
    expect(res.body.data).toHaveProperty('versions');
    expect(Array.isArray(res.body.data.versions)).toBe(true);
    expect(res.body.data.versions.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.versions[0]).toHaveProperty('version_number');
    expect(res.body.data.versions[0]).toHaveProperty('created');
    expect(res.body.data.versions[0]).toHaveProperty('title');

    // Retraction
    expect(res.body.data).toHaveProperty('is_retracted');
    expect(typeof res.body.data.is_retracted).toBe('boolean');
    expect(res.body.data).toHaveProperty('retraction_reason');
    expect(res.body.data).toHaveProperty('retraction_timestamp');
  });
});
