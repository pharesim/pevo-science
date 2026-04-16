import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

const app = createApp();

describe('GET /api/accounts/search', () => {
  it('returns 400 when q param is missing', async () => {
    const res = await request(app).get('/api/accounts/search');
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('error');
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 when q is empty', async () => {
    const res = await request(app).get('/api/accounts/search?q=');
    expect(res.status).toBe(400);
  });

  it('returns 400 when q is a single character', async () => {
    const res = await request(app).get('/api/accounts/search?q=a');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns results with correct shape', async () => {
    const res = await request(app).get('/api/accounts/search?q=pharesim');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data).toHaveProperty('accounts');
    expect(Array.isArray(res.body.data.accounts)).toBe(true);

    if (res.body.data.accounts.length > 0) {
      const account = res.body.data.accounts[0];
      expect(account).toHaveProperty('username');
      expect(account).toHaveProperty('is_accredited');
      expect(typeof account.username).toBe('string');
      expect(typeof account.is_accredited).toBe('boolean');
    }
  });

  it('returns matching accounts for a known prefix', async () => {
    const res = await request(app).get('/api/accounts/search?q=pharesim');
    expect(res.status).toBe(200);
    const accounts = res.body.data.accounts;
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts[0].username).toMatch(/^pharesim/);
  });

  it('respects the limit parameter', async () => {
    const res = await request(app).get('/api/accounts/search?q=ph&limit=2');
    expect(res.status).toBe(200);
    expect(res.body.data.accounts.length).toBeLessThanOrEqual(2);
  });

  it('clamps limit to max 10', async () => {
    const res = await request(app).get('/api/accounts/search?q=ph&limit=50');
    expect(res.status).toBe(200);
    expect(res.body.data.accounts.length).toBeLessThanOrEqual(10);
  });

  it('sanitizes invalid characters from query', async () => {
    const res = await request(app).get('/api/accounts/search?q=PHARESIM');
    expect(res.status).toBe(200);
    // Should work because it lowercases the input
    expect(res.body.data.accounts.length).toBeGreaterThan(0);
  });

  it('returns 400 for query with only invalid characters', async () => {
    const res = await request(app).get('/api/accounts/search?q=!!');
    expect(res.status).toBe(400);
  });
});
