/**
 * Default institutional email domain patterns from the spec (§3.3).
 * Matches against the full domain (everything after @).
 *
 * Types:
 * - suffix:  domain ends with this string (e.g. ".edu")
 * - exact:   domain matches exactly (e.g. "cern.ch")
 * - pattern: regex against the domain (e.g. German university patterns)
 */
interface DomainRule {
  type: 'suffix' | 'exact' | 'pattern';
  value: string;
  regex?: RegExp;
}

const DEFAULT_RULES: DomainRule[] = [
  // US universities
  { type: 'suffix', value: '.edu' },

  // Country-specific academic (.ac.*)
  ...'.ac.uk,.ac.jp,.ac.kr,.ac.in,.ac.za,.ac.nz,.ac.at,.ac.be,.ac.il,.ac.th,.ac.tz'
    .split(',').map(s => ({ type: 'suffix' as const, value: s })),

  // Country-specific edu (edu.*)
  ...'.edu.au,.edu.cn,.edu.br,.edu.mx,.edu.ar,.edu.co,.edu.pe,.edu.tr,.edu.pl,.edu.eg,.edu.ng,.edu.sg,.edu.hk,.edu.tw,.edu.my,.edu.ph,.edu.vn'
    .split(',').map(s => ({ type: 'suffix' as const, value: s })),

  // German universities — pattern match
  { type: 'pattern', value: 'uni-*.de', regex: /^uni-[a-z0-9-]+\.de$/ },
  { type: 'pattern', value: 'tu-*.de', regex: /^tu-[a-z0-9-]+\.de$/ },
  { type: 'pattern', value: 'fh-*.de', regex: /^fh-[a-z0-9-]+\.de$/ },
  { type: 'pattern', value: 'hs-*.de', regex: /^hs-[a-z0-9-]+\.de$/ },

  // French universities — pattern match
  { type: 'pattern', value: 'u-*.fr', regex: /^u-[a-z0-9-]+\.fr$/ },
  { type: 'pattern', value: 'univ-*.fr', regex: /^univ-[a-z0-9-]+\.fr$/ },

  // Research institutes
  { type: 'exact', value: 'csic.es' },
  { type: 'exact', value: 'cnrs.fr' },
  { type: 'exact', value: 'mpg.de' },
  { type: 'exact', value: 'nih.gov' },
  { type: 'exact', value: 'cern.ch' },
  { type: 'suffix', value: '.research.' },  // research.* TLDs

  // National labs (.gov subdomains)
  { type: 'suffix', value: '.gov' },
];

let cachedRules: DomainRule[] | null = null;

/**
 * Load rules: default set + any extra domains from INSTITUTIONAL_EMAIL_DOMAINS env var.
 * Extra domains are comma-separated suffixes (e.g. ".ethz.ch,.epfl.ch").
 */
function getRules(): DomainRule[] {
  if (cachedRules) return cachedRules;

  const rules = [...DEFAULT_RULES];

  const extra = process.env.INSTITUTIONAL_EMAIL_DOMAINS || '';
  if (extra) {
    for (const raw of extra.split(',')) {
      const d = raw.trim().toLowerCase();
      if (!d) continue;
      // If it starts with a dot, treat as suffix; otherwise exact match
      rules.push(d.startsWith('.')
        ? { type: 'suffix', value: d }
        : { type: 'exact', value: d }
      );
    }
  }

  cachedRules = rules;
  return rules;
}

/**
 * Check whether an email address belongs to an institutional domain.
 * Returns true if the domain matches any rule.
 */
export function isInstitutionalEmail(email: string): boolean {
  const atIdx = email.lastIndexOf('@');
  if (atIdx < 1) return false;
  const domain = email.slice(atIdx + 1).toLowerCase();
  if (!domain || domain.includes('..') || !domain.includes('.')) return false;

  for (const rule of getRules()) {
    switch (rule.type) {
      case 'suffix':
        if (domain.endsWith(rule.value) || domain === rule.value.slice(1)) return true;
        break;
      case 'exact':
        if (domain === rule.value || domain.endsWith(`.${rule.value}`)) return true;
        break;
      case 'pattern':
        if (rule.regex!.test(domain)) return true;
        break;
    }
  }
  return false;
}

/** Reset cached rules (for testing). */
export function _resetRulesCache(): void {
  cachedRules = null;
}
