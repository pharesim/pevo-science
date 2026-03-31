import Alpine from 'alpinejs';

export const SUPPORTED_LOCALES = ['ar', 'cs', 'da', 'de', 'en', 'es', 'fa', 'fr', 'he', 'it', 'pl', 'pt', 'sv', 'zh'];
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
  // 1. Cookie
  const cookieLocale = getCookieLocale();
  if (cookieLocale && SUPPORTED_LOCALES.includes(cookieLocale)) return cookieLocale;

  // 2. navigator.language
  if (typeof navigator !== 'undefined' && navigator.language) {
    const lang = navigator.language.split('-')[0];
    if (SUPPORTED_LOCALES.includes(lang)) return lang;
  }

  // 3. Default
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

  // Load initial messages and set direction
  const store = Alpine.store('i18n');
  const isRtl = RTL_LOCALES.includes(locale);
  document.documentElement.dir = isRtl ? 'rtl' : 'ltr';
  document.documentElement.lang = locale;

  // Return the loading promise so main.js can await it
  return store._loadMessages(locale);
}
