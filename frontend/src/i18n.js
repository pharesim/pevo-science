import Alpine from 'alpinejs';

export const SUPPORTED_LOCALES = ['ar', 'cs', 'da', 'de', 'en', 'es', 'fa', 'fr', 'he', 'it', 'nl', 'pl', 'pt', 'sv', 'tr', 'zh'];
export const DEFAULT_LOCALE = 'en';
export const RTL_LOCALES = ['ar', 'he', 'fa'];

const COOKIE_NAME = 'PEVO_LOCALE';

function getCookieLocale() {
  const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE_NAME + '=([^;]*)'));
  return match ? match[1] : null;
}

function setCookieLocale(locale) {
  document.cookie = `${COOKIE_NAME}=${locale};path=/;max-age=31536000;SameSite=Lax`;
}

function detectLocale() {
  // 1. URL path first segment
  const segments = window.location.pathname.split('/');
  if (segments.length >= 2 && SUPPORTED_LOCALES.includes(segments[1])) {
    return segments[1];
  }

  // 2. Cookie
  const cookieLocale = getCookieLocale();
  if (cookieLocale && SUPPORTED_LOCALES.includes(cookieLocale)) return cookieLocale;

  // 3. navigator.language
  if (typeof navigator !== 'undefined' && navigator.language) {
    const lang = navigator.language.split('-')[0];
    if (SUPPORTED_LOCALES.includes(lang)) return lang;
  }

  // 4. Default
  return DEFAULT_LOCALE;
}

function getNestedValue(obj, key) {
  return key.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), obj);
}

function interpolate(template, params) {
  if (!params || !template) return template || '';
  // Handle ICU plural: {var, plural, one {singular} other {plural}}
  const result = template.replace(/\{(\w+),\s*plural,\s*((?:[a-z]+\s*\{[^}]*\}\s*)+)\}/g, (_, varName, cases) => {
    const value = Number(params[varName] ?? 0);
    const parsed = {};
    const caseRegex = /(\w+)\s*\{([^}]*)\}/g;
    let m;
    while ((m = caseRegex.exec(cases)) !== null) {
      parsed[m[1]] = m[2];
    }
    const branch = (value === 1 && parsed.one) ? parsed.one : (parsed.other || '');
    return branch.replace(/#/g, String(value));
  });
  // Handle simple {key} replacements
  return result.replace(/\{(\w+)\}/g, (_, key) => {
    return params[key] !== undefined ? String(params[key]) : `{${key}}`;
  });
}

export function initI18n() {
  const locale = detectLocale();

  Alpine.store('i18n', {
    locale,
    messages: {},
    _loading: false,

    async setLocale(newLocale) {
      if (!SUPPORTED_LOCALES.includes(newLocale)) return;
      this.locale = newLocale;
      setCookieLocale(newLocale);
      await this._loadMessages(newLocale);

      // Set document direction and language
      const isRtl = RTL_LOCALES.includes(newLocale);
      document.documentElement.dir = isRtl ? 'rtl' : 'ltr';
      document.documentElement.lang = newLocale;

      // Swap locale prefix in current URL
      const path = window.location.pathname;
      const segments = path.split('/');
      let newPath;
      if (segments.length >= 2 && SUPPORTED_LOCALES.includes(segments[1])) {
        segments[1] = newLocale;
        newPath = segments.join('/');
      } else {
        newPath = '/' + newLocale + (path === '/' ? '/' : path);
      }
      // Preserve query string
      newPath += window.location.search;
      window.history.replaceState(null, '', newPath);

      // Sync router store locale
      const router = Alpine.store('router');
      if (router) router.locale = newLocale;
    },

    async _loadMessages(loc) {
      this._loading = true;
      try {
        const res = await fetch(`/messages/${loc}.json`);
        if (res.ok) {
          this.messages = await res.json();
        }
      } catch {
        // Fallback: try English
        if (loc !== DEFAULT_LOCALE) {
          try {
            const res = await fetch(`/messages/${DEFAULT_LOCALE}.json`);
            if (res.ok) {
              this.messages = await res.json();
            }
          } catch { /* silent */ }
        }
      } finally {
        this._loading = false;
      }
    },
  });

  // Register $t magic helper
  Alpine.magic('t', () => {
    return (key, params) => {
      const messages = Alpine.store('i18n').messages;
      const template = getNestedValue(messages, key);
      if (template === undefined) return key;
      return interpolate(template, params);
    };
  });

  // Register $lp (locale path) magic helper
  Alpine.magic('lp', () => {
    return (path) => '/' + Alpine.store('i18n').locale + (path.startsWith('/') ? path : '/' + path);
  });

  // Load initial messages and set direction
  const store = Alpine.store('i18n');
  const isRtl = RTL_LOCALES.includes(locale);
  document.documentElement.dir = isRtl ? 'rtl' : 'ltr';
  document.documentElement.lang = locale;

  // Return the loading promise so main.js can await it
  return store._loadMessages(locale);
}
