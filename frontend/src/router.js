import Alpine from 'alpinejs';

const ROUTES = [
  { pattern: /^\/$/,                                   name: 'home' },
  { pattern: /^\/papers$/,                              name: 'papers' },
  { pattern: /^\/paper\/([^/]+)\/([^/]+)$/,           name: 'paper-detail',  params: ['author', 'permlink'] },
  { pattern: /^\/publish$/,                            name: 'publish' },
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
      return { route: route.name, params, query };
    }
  }

  // Fallback: 404 → home
  return { route: 'home', params: {}, query };
}

export function initRouter() {
  const initial = parsePath(window.location.pathname + window.location.search);

  Alpine.store('router', {
    route: initial.route,
    params: initial.params,
    query: initial.query,

    navigate(path) {
      window.history.pushState(null, '', path);
      const parsed = parsePath(path);
      this.route = parsed.route;
      this.params = parsed.params;
      this.query = parsed.query;
      window.scrollTo(0, 0);
    },
  });

  window.addEventListener('popstate', () => {
    const parsed = parsePath(window.location.pathname + window.location.search);
    const store = Alpine.store('router');
    store.route = parsed.route;
    store.params = parsed.params;
    store.query = parsed.query;
    window.scrollTo(0, 0);
  });
}
