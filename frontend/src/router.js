import Alpine from 'alpinejs';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from './i18n.js';

// Static route titles (dynamic pages like paper-detail/profile set their own)
const ROUTE_TITLES = {
  'home':                  'PEvO - Open Scientific Publishing',
  'papers':                'Papers — PEvO',
  'publish':               'Publish — PEvO',
  'search':                'Search — PEvO',
  'bridge':                'Bridge — PEvO',
  'accreditation':         'Accreditation — PEvO',
  'accreditation-verify':  'Verify Accreditation — PEvO',
  'researchers':           'Researchers — PEvO',
  'stats':                 'Statistics — PEvO',
  'about':                 'About — PEvO',
  'faq':                   'FAQ — PEvO',
  'getting-started':       'Getting Started — PEvO',
  'contact':               'Contact — PEvO',
  'blog':                  'Blog — PEvO',
  'signup':                'Sign Up — PEvO',
  'signup-orcid-callback': 'ORCID Verification — PEvO',
  'signup-verify':         'Verify Email — PEvO',
  'login':                 'Sign In — PEvO',
  'reset-password':        'Reset Password — PEvO',
  'settings':              'Settings — PEvO',
};

function updateTitle(routeName) {
  const title = ROUTE_TITLES[routeName];
  if (title) document.title = title;
}

const ROUTES = [
  { pattern: /^\/$/,                                   name: 'home' },
  { pattern: /^\/papers$/,                              name: 'papers' },
  { pattern: /^\/paper\/([^/]+)\/([^/]+)$/,           name: 'paper-detail',  params: ['author', 'permlink'] },
  { pattern: /^\/publish$/,                            name: 'publish' },
  { pattern: /^\/edit\/([^/]+)\/([^/]+)$/,             name: 'edit',          params: ['author', 'permlink'] },
  { pattern: /^\/review\/([^/]+)\/([^/]+)$/,          name: 'review',        params: ['author', 'permlink'] },
  { pattern: /^\/search$/,                             name: 'search' },
  { pattern: /^\/bridge$/,                             name: 'bridge' },
  { pattern: /^\/profile\/([^/]+)$/,                   name: 'profile',       params: ['username'] },
  { pattern: /^\/accreditation$/,                      name: 'accreditation' },
  { pattern: /^\/accreditation\/verify$/,              name: 'accreditation-verify' },
  { pattern: /^\/accreditation\/orcid\/callback$/,     name: 'accreditation-orcid-callback' },
  { pattern: /^\/researchers$/,                        name: 'researchers' },
  { pattern: /^\/stats$/,                              name: 'stats' },
  { pattern: /^\/about$/,                              name: 'about' },
  { pattern: /^\/faq$/,                                name: 'faq' },
  { pattern: /^\/getting-started$/,                    name: 'getting-started' },
  { pattern: /^\/contact$/,                            name: 'contact' },
  { pattern: /^\/blog$/,                               name: 'blog' },
  { pattern: /^\/blog\/([^/]+)$/,                      name: 'blog-post',     params: ['permlink'] },
  { pattern: /^\/signup$/,                             name: 'signup' },
  { pattern: /^\/signup\/orcid-callback$/,             name: 'signup-orcid-callback' },
  { pattern: /^\/signup\/verify$/,                     name: 'signup-verify' },
  { pattern: /^\/auth\/verify$/,                       name: 'signup-verify' },
  { pattern: /^\/login$/,                              name: 'login' },
  { pattern: /^\/reset-password$/,                     name: 'reset-password' },
  { pattern: /^\/settings$/,                           name: 'settings' },
];

function parsePath(url) {
  let path = url || '/';
  // Split path from query string
  const qIdx = path.indexOf('?');
  const qs = qIdx >= 0 ? path.slice(qIdx + 1) : '';
  if (qIdx >= 0) path = path.slice(0, qIdx);

  // Ensure path starts with /
  if (!path.startsWith('/')) path = '/' + path;

  // Parse query params
  const query = {};
  if (qs) {
    for (const part of qs.split('&')) {
      const [k, v] = part.split('=').map(decodeURIComponent);
      if (k) query[k] = v ?? '';
    }
  }

  // Extract locale from first path segment
  let locale = null;
  const segments = path.split('/'); // ['', 'en', 'papers', ...]
  if (segments.length >= 2 && SUPPORTED_LOCALES.includes(segments[1])) {
    locale = segments[1];
    // Strip locale prefix: '/en/papers' → '/papers', '/en' → '/'
    path = '/' + segments.slice(2).join('/') || '/';
    if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1);
  }

  // Match route
  for (const route of ROUTES) {
    const m = path.match(route.pattern);
    if (m) {
      const params = {};
      if (route.params) {
        route.params.forEach((name, i) => {
          params[name] = decodeURIComponent(m[i + 1]);
        });
      }
      return { route: route.name, params, query, locale };
    }
  }

  // Fallback: 404 → home
  return { route: 'home', params: {}, query, locale };
}

export function initRouter() {
  const initial = parsePath(window.location.pathname + window.location.search);

  Alpine.store('router', {
    route: initial.route,
    params: initial.params,
    query: initial.query,
    locale: initial.locale || DEFAULT_LOCALE,

    navigate(path) {
      // Separate hash fragment before processing
      let hash = '';
      const hashIdx = path.indexOf('#');
      if (hashIdx >= 0) {
        hash = path.slice(hashIdx);
        path = path.slice(0, hashIdx);
      }

      // Auto-prepend locale if path doesn't already start with a valid locale
      const segments = path.split('?')[0].split('/');
      if (!(segments.length >= 2 && SUPPORTED_LOCALES.includes(segments[1]))) {
        path = '/' + this.locale + (path.startsWith('/') ? path : '/' + path);
      }
      window.history.pushState(null, '', path + hash);
      const parsed = parsePath(path);
      this.route = parsed.route;
      this.params = parsed.params;
      this.query = parsed.query;
      if (parsed.locale) this.locale = parsed.locale;
      updateTitle(parsed.route);
      if (!hash) window.scrollTo(0, 0);
    },
  });

  updateTitle(initial.route);

  window.addEventListener('popstate', () => {
    const parsed = parsePath(window.location.pathname + window.location.search);
    const store = Alpine.store('router');
    store.route = parsed.route;
    store.params = parsed.params;
    store.query = parsed.query;
    if (parsed.locale && parsed.locale !== store.locale) {
      store.locale = parsed.locale;
      // Sync i18n store if locale changed via back/forward navigation
      const i18n = Alpine.store('i18n');
      if (i18n && i18n.locale !== parsed.locale) {
        i18n.setLocale(parsed.locale);
      }
    }
    updateTitle(parsed.route);
    window.scrollTo(0, 0);
  });
}
