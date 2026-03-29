import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryCache } from '../src/cache.js';

describe('QueryCache', () => {
  let cache: QueryCache;

  beforeEach(() => {
    cache = new QueryCache(100); // 100ms TTL for fast tests
  });

  it('returns undefined for missing keys', async () => {
    expect(await cache.get('missing')).toBeUndefined();
  });

  it('stores and retrieves values', async () => {
    await cache.set('key', { value: 42 });
    expect(await cache.get('key')).toEqual({ value: 42 });
  });

  it('expires entries after TTL', async () => {
    await cache.set('key', 'data', 50);
    expect(await cache.get('key')).toBe('data');
    await new Promise((r) => setTimeout(r, 60));
    expect(await cache.get('key')).toBeUndefined();
  });

  it('getOrSet returns cached value on hit', async () => {
    await cache.set('key', 'cached');
    const fn = vi.fn().mockResolvedValue('fresh');
    const result = await cache.getOrSet('key', fn);
    expect(result).toBe('cached');
    expect(fn).not.toHaveBeenCalled();
  });

  it('getOrSet calls fn on miss and caches result', async () => {
    const fn = vi.fn().mockResolvedValue('computed');
    const result = await cache.getOrSet('key', fn);
    expect(result).toBe('computed');
    expect(fn).toHaveBeenCalledOnce();
    expect(await cache.get('key')).toBe('computed');
  });

  it('getOrSet does not cache null', async () => {
    const fn = vi.fn().mockResolvedValue(null);
    await cache.getOrSet('key', fn);
    expect(await cache.get('key')).toBeUndefined();
  });

  it('invalidate removes a key', async () => {
    await cache.set('key', 'val');
    await cache.invalidate('key');
    expect(await cache.get('key')).toBeUndefined();
  });

  it('clear removes all keys', async () => {
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.clear();
    expect(cache.size).toBe(0);
  });

  it('reports size correctly', async () => {
    expect(cache.size).toBe(0);
    await cache.set('a', 1);
    await cache.set('b', 2);
    expect(cache.size).toBe(2);
  });
});
