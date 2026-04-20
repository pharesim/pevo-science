import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let routerStore;
let popstateHandler;

vi.mock('../../src/i18n.js', () => ({
  SUPPORTED_LOCALES: ['ar', 'cs', 'da', 'de', 'en', 'es', 'fa', 'fr', 'he', 'it', 'nl', 'pl', 'pt', 'sv', 'tr', 'zh'],
  DEFAULT_LOCALE: 'en',
}));

const mockI18nStore = { locale: 'en', setLocale: vi.fn() };

vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name, def) => {
      if (name === 'router' && def) { routerStore = def; return def; }
      if (name === 'router') return routerStore;
      if (name === 'i18n') return mockI18nStore;
      return {};
    }),
  },
}));

import { initRouter } from '../../src/router.js';

describe('router', () => {
  let origLocation;
  let origTitle;
  let pushStateSpy;

  beforeEach(() => {
    routerStore = null;
    pushStateSpy = vi.fn();
    window.history.pushState = pushStateSpy;
    window.scrollTo = vi.fn();
    origTitle = document.title;
    mockI18nStore.locale = 'en';
    mockI18nStore.setLocale.mockClear();
    popstateHandler = null;

    // Capture popstate handler
    const origAddEventListener = window.addEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((event, handler) => {
      if (event === 'popstate') popstateHandler = handler;
      return origAddEventListener(event, handler);
    });
  });

  afterEach(() => {
    document.title = origTitle;
    vi.restoreAllMocks();
  });

  function initAt(pathname, search = '') {
    Object.defineProperty(window, 'location', {
      value: { pathname, search },
      writable: true,
      configurable: true,
    });
    initRouter();
    return routerStore;
  }

  describe('route matching', () => {
    it('matches home route', () => {
      const store = initAt('/');
      expect(store.route).toBe('home');
      expect(store.params).toEqual({});
    });

    it('matches papers route', () => {
      const store = initAt('/papers');
      expect(store.route).toBe('papers');
    });

    it('matches paper-detail with params', () => {
      const store = initAt('/paper/alice/my-paper');
      expect(store.route).toBe('paper-detail');
      expect(store.params).toEqual({ author: 'alice', permlink: 'my-paper' });
    });

    it('matches publish route', () => {
      const store = initAt('/publish');
      expect(store.route).toBe('publish');
    });

    it('matches edit with params', () => {
      const store = initAt('/edit/bob/draft-1');
      expect(store.route).toBe('edit');
      expect(store.params).toEqual({ author: 'bob', permlink: 'draft-1' });
    });

    it('matches review with params', () => {
      const store = initAt('/review/carol/paper-x');
      expect(store.route).toBe('review');
      expect(store.params).toEqual({ author: 'carol', permlink: 'paper-x' });
    });

    it('matches search route', () => {
      const store = initAt('/search');
      expect(store.route).toBe('search');
    });

    it('matches bridge route', () => {
      const store = initAt('/bridge');
      expect(store.route).toBe('bridge');
    });

    it('matches profile with username param', () => {
      const store = initAt('/profile/dave');
      expect(store.route).toBe('profile');
      expect(store.params).toEqual({ username: 'dave' });
    });

    it('matches accreditation route', () => {
      const store = initAt('/accreditation');
      expect(store.route).toBe('accreditation');
    });

    it('matches accreditation-verify route', () => {
      const store = initAt('/accreditation/verify');
      expect(store.route).toBe('accreditation-verify');
    });

    it('matches orcid-callback route', () => {
      const store = initAt('/orcid/callback');
      expect(store.route).toBe('orcid-callback');
    });

    it('matches researchers route', () => {
      const store = initAt('/researchers');
      expect(store.route).toBe('researchers');
    });

    it('matches stats route', () => {
      const store = initAt('/stats');
      expect(store.route).toBe('stats');
    });

    it('matches about route', () => {
      const store = initAt('/about');
      expect(store.route).toBe('about');
    });

    it('matches faq route', () => {
      const store = initAt('/faq');
      expect(store.route).toBe('faq');
    });

    it('matches getting-started route', () => {
      const store = initAt('/getting-started');
      expect(store.route).toBe('getting-started');
    });

    it('matches contact route', () => {
      const store = initAt('/contact');
      expect(store.route).toBe('contact');
    });

    it('matches blog route', () => {
      const store = initAt('/blog');
      expect(store.route).toBe('blog');
    });

    it('matches blog-post with permlink', () => {
      const store = initAt('/blog/my-post');
      expect(store.route).toBe('blog-post');
      expect(store.params).toEqual({ permlink: 'my-post' });
    });

    it('matches signup route', () => {
      const store = initAt('/signup');
      expect(store.route).toBe('signup');
    });

    it('matches signup-verify route', () => {
      const store = initAt('/signup/verify');
      expect(store.route).toBe('signup-verify');
    });

    it('matches auth/verify as signup-verify', () => {
      const store = initAt('/auth/verify');
      expect(store.route).toBe('signup-verify');
    });

    it('matches login route', () => {
      const store = initAt('/login');
      expect(store.route).toBe('login');
    });

    it('matches reset-password route', () => {
      const store = initAt('/reset-password');
      expect(store.route).toBe('reset-password');
    });

    it('matches recover route', () => {
      const store = initAt('/recover');
      expect(store.route).toBe('recover');
    });

    it('matches settings route', () => {
      const store = initAt('/settings');
      expect(store.route).toBe('settings');
    });

    it('matches settings-verify-email with token', () => {
      const store = initAt('/settings/verify-email/abc123');
      expect(store.route).toBe('settings-verify-email');
      expect(store.params).toEqual({ token: 'abc123' });
    });

    it('falls back to home for unknown paths', () => {
      const store = initAt('/nonexistent/path');
      expect(store.route).toBe('home');
    });
  });

  describe('locale prefix handling', () => {
    it('strips locale prefix and sets locale', () => {
      const store = initAt('/de/papers');
      expect(store.route).toBe('papers');
      expect(store.locale).toBe('de');
    });

    it('handles locale-only path as home', () => {
      const store = initAt('/fr');
      expect(store.route).toBe('home');
      expect(store.locale).toBe('fr');
    });

    it('defaults locale to en when no prefix', () => {
      const store = initAt('/papers');
      expect(store.locale).toBe('en');
    });

    it('extracts params from locale-prefixed paths', () => {
      const store = initAt('/es/paper/alice/post1');
      expect(store.route).toBe('paper-detail');
      expect(store.params).toEqual({ author: 'alice', permlink: 'post1' });
      expect(store.locale).toBe('es');
    });
  });

  describe('query parameters', () => {
    it('parses query parameters', () => {
      const store = initAt('/search', '?q=quantum&page=2');
      expect(store.route).toBe('search');
      expect(store.query).toEqual({ q: 'quantum', page: '2' });
    });

    it('handles empty query string', () => {
      const store = initAt('/papers', '');
      expect(store.query).toEqual({});
    });

    it('decodes URI components in query', () => {
      const store = initAt('/search', '?q=hello%20world');
      expect(store.query).toEqual({ q: 'hello world' });
    });
  });

  describe('navigate', () => {
    it('pushes state and updates route', () => {
      const store = initAt('/');
      store.navigate('/papers');

      expect(pushStateSpy).toHaveBeenCalledWith(null, '', '/en/papers');
      expect(store.route).toBe('papers');
    });

    it('auto-prepends locale to path', () => {
      const store = initAt('/de/papers');
      store.navigate('/search');

      expect(pushStateSpy).toHaveBeenCalledWith(null, '', '/de/search');
    });

    it('does not double-prepend locale if already present', () => {
      const store = initAt('/');
      store.navigate('/fr/papers');

      expect(pushStateSpy).toHaveBeenCalledWith(null, '', '/fr/papers');
      expect(store.locale).toBe('fr');
    });

    it('scrolls to top on navigation without hash', () => {
      const store = initAt('/');
      store.navigate('/papers');
      expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    });

    it('does not scroll to top when navigating with hash', () => {
      const store = initAt('/');
      window.scrollTo.mockClear();
      store.navigate('/papers#section');
      expect(window.scrollTo).not.toHaveBeenCalled();
    });

    it('preserves hash in pushed URL', () => {
      const store = initAt('/');
      store.navigate('/about#team');
      expect(pushStateSpy).toHaveBeenCalledWith(null, '', '/en/about#team');
    });

    it('updates document.title for static routes', () => {
      const store = initAt('/');
      store.navigate('/papers');
      expect(document.title).toBe('Papers — PEvO');
    });
  });

  describe('popstate', () => {
    it('updates store on popstate event', () => {
      const store = initAt('/');
      expect(popstateHandler).toBeTruthy();

      // Simulate navigating to /papers via browser back
      window.location = { pathname: '/papers', search: '' };
      popstateHandler();

      expect(store.route).toBe('papers');
    });

    it('syncs i18n locale on popstate when locale changes', () => {
      const store = initAt('/en/papers');
      mockI18nStore.locale = 'en';

      window.location = { pathname: '/de/papers', search: '' };
      popstateHandler();

      expect(store.locale).toBe('de');
      expect(mockI18nStore.setLocale).toHaveBeenCalledWith('de');
    });

    it('does not sync i18n when locale is unchanged', () => {
      const store = initAt('/en/papers');

      window.location = { pathname: '/en/search', search: '' };
      popstateHandler();

      expect(mockI18nStore.setLocale).not.toHaveBeenCalled();
    });
  });
});
