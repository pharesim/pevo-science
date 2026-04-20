import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Alpine before importing i18n
const mockStore = {};
const mockMagics = {};
vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name, def) => {
      if (def !== undefined) {
        mockStore[name] = def;
        return def;
      }
      return mockStore[name];
    }),
    magic: vi.fn((name, fn) => {
      mockMagics[name] = fn;
    }),
  },
}));

import { initI18n, SUPPORTED_LOCALES, DEFAULT_LOCALE, RTL_LOCALES } from '../../src/i18n.js';

describe('i18n', () => {
  let originalCookie;
  let originalNavigator;
  let originalLocation;

  beforeEach(() => {
    // Clear mock stores
    Object.keys(mockStore).forEach(k => delete mockStore[k]);
    Object.keys(mockMagics).forEach(k => delete mockMagics[k]);

    originalCookie = Object.getOwnPropertyDescriptor(document, 'cookie');
    originalNavigator = navigator.language;

    // Reset location
    originalLocation = window.location;

    // Mock fetch globally
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ metadata: { title: 'PEvO Test' }, hello: 'Hello' }),
      })
    );

    // Reset document state
    document.documentElement.dir = 'ltr';
    document.documentElement.lang = 'en';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCookie) {
      Object.defineProperty(document, 'cookie', originalCookie);
    }
    delete global.fetch;
  });

  describe('constants', () => {
    it('exports 16 supported locales', () => {
      expect(SUPPORTED_LOCALES).toHaveLength(16);
      expect(SUPPORTED_LOCALES).toContain('en');
      expect(SUPPORTED_LOCALES).toContain('ar');
      expect(SUPPORTED_LOCALES).toContain('zh');
    });

    it('has English as default locale', () => {
      expect(DEFAULT_LOCALE).toBe('en');
    });

    it('marks Arabic, Hebrew, and Farsi as RTL', () => {
      expect(RTL_LOCALES).toEqual(['ar', 'he', 'fa']);
    });
  });

  describe('detectLocale (via initI18n)', () => {
    it('detects locale from URL path', async () => {
      delete window.location;
      window.location = { pathname: '/de/papers', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });

      await initI18n();
      const store = mockStore.i18n;
      expect(store.locale).toBe('de');
    });

    it('detects locale from cookie when URL has no locale prefix', async () => {
      delete window.location;
      window.location = { pathname: '/papers', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: 'PEVO_LOCALE=fr', writable: true, configurable: true });

      await initI18n();
      const store = mockStore.i18n;
      expect(store.locale).toBe('fr');
    });

    it('detects locale from navigator.language when no URL or cookie', async () => {
      delete window.location;
      window.location = { pathname: '/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });
      Object.defineProperty(navigator, 'language', { value: 'es-MX', configurable: true });

      await initI18n();
      const store = mockStore.i18n;
      expect(store.locale).toBe('es');

      Object.defineProperty(navigator, 'language', { value: originalNavigator, configurable: true });
    });

    it('falls back to default locale when no source matches', async () => {
      delete window.location;
      window.location = { pathname: '/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });
      Object.defineProperty(navigator, 'language', { value: 'xx-XX', configurable: true });

      await initI18n();
      const store = mockStore.i18n;
      expect(store.locale).toBe('en');

      Object.defineProperty(navigator, 'language', { value: originalNavigator, configurable: true });
    });

    it('ignores unsupported cookie locale', async () => {
      delete window.location;
      window.location = { pathname: '/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: 'PEVO_LOCALE=klingon', writable: true, configurable: true });
      Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });

      await initI18n();
      const store = mockStore.i18n;
      expect(store.locale).toBe('en');

      Object.defineProperty(navigator, 'language', { value: originalNavigator, configurable: true });
    });
  });

  describe('getNestedValue (via $t magic)', () => {
    it('resolves nested keys', async () => {
      delete window.location;
      window.location = { pathname: '/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });

      await initI18n();

      // $t magic was registered
      expect(mockMagics.t).toBeDefined();
      const tFn = mockMagics.t();

      // Messages were loaded
      expect(tFn('metadata.title')).toBe('PEvO Test');
      expect(tFn('hello')).toBe('Hello');
    });

    it('returns the key itself for missing translations', async () => {
      delete window.location;
      window.location = { pathname: '/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });

      await initI18n();
      const tFn = mockMagics.t();
      expect(tFn('nonexistent.key')).toBe('nonexistent.key');
    });

    it('handles deeply nested missing path', async () => {
      delete window.location;
      window.location = { pathname: '/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });

      await initI18n();
      const tFn = mockMagics.t();
      expect(tFn('a.b.c.d.e')).toBe('a.b.c.d.e');
    });
  });

  describe('interpolation (via $t)', () => {
    it('interpolates simple {key} placeholders', async () => {
      delete window.location;
      window.location = { pathname: '/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ greeting: 'Hello, {name}!' }),
        })
      );

      await initI18n();
      const tFn = mockMagics.t();
      expect(tFn('greeting', { name: 'Alice' })).toBe('Hello, Alice!');
    });

    it('preserves placeholder when param is missing', async () => {
      delete window.location;
      window.location = { pathname: '/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ msg: 'Hi {name}, you have {count} items' }),
        })
      );

      await initI18n();
      const tFn = mockMagics.t();
      expect(tFn('msg', { name: 'Bob' })).toBe('Hi Bob, you have {count} items');
    });

    it('returns template as-is when no params passed', async () => {
      delete window.location;
      window.location = { pathname: '/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ plain: 'No placeholders here' }),
        })
      );

      await initI18n();
      const tFn = mockMagics.t();
      expect(tFn('plain')).toBe('No placeholders here');
    });

    it('returns empty string when template is empty/null', async () => {
      delete window.location;
      window.location = { pathname: '/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ empty: '' }),
        })
      );

      await initI18n();
      const tFn = mockMagics.t();
      // Empty string template with params returns ''
      expect(tFn('empty', { foo: 'bar' })).toBe('');
    });

    it('handles ICU plural with missing variable (defaults to 0)', async () => {
      delete window.location;
      window.location = { pathname: '/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            items: '{count, plural, one {# item} other {# items}}',
          }),
        })
      );

      await initI18n();
      const tFn = mockMagics.t();
      // No count param provided — defaults to 0 via ??
      expect(tFn('items', {})).toBe('0 items');
    });

    it('handles ICU plural with only one case (no other)', async () => {
      delete window.location;
      window.location = { pathname: '/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            singular: '{count, plural, one {just one}}',
          }),
        })
      );

      await initI18n();
      const tFn = mockMagics.t();
      expect(tFn('singular', { count: 1 })).toBe('just one');
      // count != 1 and no "other" branch — returns empty string
      expect(tFn('singular', { count: 5 })).toBe('');
    });

    it('handles ICU plural syntax', async () => {
      delete window.location;
      window.location = { pathname: '/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            items: '{count, plural, one {# item} other {# items}}',
          }),
        })
      );

      await initI18n();
      const tFn = mockMagics.t();
      expect(tFn('items', { count: 1 })).toBe('1 item');
      expect(tFn('items', { count: 5 })).toBe('5 items');
      expect(tFn('items', { count: 0 })).toBe('0 items');
    });
  });

  describe('$lp magic (locale path)', () => {
    it('prefixes path with locale', async () => {
      delete window.location;
      window.location = { pathname: '/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });

      await initI18n();
      expect(mockMagics.lp).toBeDefined();
      const lpFn = mockMagics.lp();
      expect(lpFn('/papers')).toBe('/en/papers');
      expect(lpFn('papers')).toBe('/en/papers');
    });
  });

  describe('RTL detection', () => {
    it('sets dir=rtl for Arabic', async () => {
      delete window.location;
      window.location = { pathname: '/ar/papers', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });

      await initI18n();
      expect(document.documentElement.dir).toBe('rtl');
      expect(document.documentElement.lang).toBe('ar');
    });

    it('sets dir=ltr for non-RTL locales', async () => {
      delete window.location;
      window.location = { pathname: '/de/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });

      await initI18n();
      expect(document.documentElement.dir).toBe('ltr');
      expect(document.documentElement.lang).toBe('de');
    });
  });

  describe('setLocale', () => {
    it('updates locale, cookie, URL, and document direction', async () => {
      delete window.location;
      window.location = { pathname: '/en/papers', search: '?q=test', href: '' };
      window.history = { replaceState: vi.fn() };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });

      // Mock router store
      const mockRouter = { locale: 'en' };
      mockStore.router = mockRouter;

      await initI18n();
      const store = mockStore.i18n;

      await store.setLocale('ar');

      expect(store.locale).toBe('ar');
      expect(document.documentElement.dir).toBe('rtl');
      expect(document.documentElement.lang).toBe('ar');
      expect(window.history.replaceState).toHaveBeenCalledWith(null, '', '/ar/papers?q=test');
      expect(mockRouter.locale).toBe('ar');
    });

    it('rejects unsupported locale', async () => {
      delete window.location;
      window.location = { pathname: '/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });

      await initI18n();
      const store = mockStore.i18n;
      await store.setLocale('klingon');
      expect(store.locale).toBe('en'); // unchanged
    });

    it('inserts locale prefix when URL has no locale segment', async () => {
      delete window.location;
      window.location = { pathname: '/papers', search: '', href: '' };
      window.history = { replaceState: vi.fn() };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });

      await initI18n();
      const store = mockStore.i18n;
      await store.setLocale('fr');

      expect(window.history.replaceState).toHaveBeenCalledWith(null, '', '/fr/papers');
    });

    it('handles root path locale switch', async () => {
      delete window.location;
      window.location = { pathname: '/', search: '', href: '' };
      window.history = { replaceState: vi.fn() };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });

      await initI18n();
      const store = mockStore.i18n;
      await store.setLocale('de');

      expect(window.history.replaceState).toHaveBeenCalledWith(null, '', '/de/');
    });
  });

  describe('_loadMessages', () => {
    it('falls back to English when locale fetch fails', async () => {
      delete window.location;
      window.location = { pathname: '/fr/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });

      let callCount = 0;
      global.fetch = vi.fn(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('network error'));
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ fallback: 'yes' }),
        });
      });

      await initI18n();
      const store = mockStore.i18n;
      expect(store.messages.fallback).toBe('yes');
      expect(store._loading).toBe(false);
    });

    it('silently handles failure of both locale and fallback fetch', async () => {
      delete window.location;
      window.location = { pathname: '/fr/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });

      global.fetch = vi.fn(() => Promise.reject(new Error('all fetches fail')));

      await initI18n();
      const store = mockStore.i18n;
      expect(store._loading).toBe(false);
      // messages remain empty
      expect(Object.keys(store.messages)).toHaveLength(0);
    });

    it('does not fallback when English fetch itself fails', async () => {
      delete window.location;
      window.location = { pathname: '/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });

      global.fetch = vi.fn(() => Promise.reject(new Error('network error')));

      await initI18n();
      const store = mockStore.i18n;
      // English is DEFAULT_LOCALE, so no fallback attempted
      expect(store._loading).toBe(false);
    });

    it('handles non-ok response', async () => {
      delete window.location;
      window.location = { pathname: '/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });

      global.fetch = vi.fn(() => Promise.resolve({ ok: false }));

      await initI18n();
      const store = mockStore.i18n;
      expect(Object.keys(store.messages)).toHaveLength(0);
    });
  });

  describe('document title', () => {
    it('sets document title from loaded messages', async () => {
      delete window.location;
      window.location = { pathname: '/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });

      await initI18n();
      expect(document.title).toBe('PEvO Test');
    });

    it('does not set title when metadata.title is missing', async () => {
      delete window.location;
      window.location = { pathname: '/', search: '', href: '' };
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });
      document.title = 'Original';

      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ other: 'data' }),
        })
      );

      await initI18n();
      expect(document.title).toBe('Original');
    });
  });
});
