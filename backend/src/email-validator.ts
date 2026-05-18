/**
 * Institutional email validator.
 *
 * Uses the JetBrains/swot academic domain database (data/academic-domains.json)
 * plus configurable extra domains via INSTITUTIONAL_EMAIL_DOMAINS env var.
 *
 * Regenerate the data file: scripts/update-academic-domains.sh
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface AcademicDomains {
  tlds: string[];
  domains: string[];
}

// ── Load domain data ───────────────────────────

let domainSet: Set<string> | null = null;
let tldSuffixes: string[] | null = null;
let extraSuffixes: string[] | null = null;
let extraAddresses: Set<string> | null = null;

function load(): {
  domains: Set<string>;
  tlds: string[];
  extra: string[];
  addresses: Set<string>;
} {
  if (domainSet && tldSuffixes && extraSuffixes && extraAddresses) {
    return {
      domains: domainSet,
      tlds: tldSuffixes,
      extra: extraSuffixes,
      addresses: extraAddresses,
    };
  }

  const dataPath = resolve(__dirname, '..', 'data', 'academic-domains.json');
  const raw: AcademicDomains = JSON.parse(readFileSync(dataPath, 'utf8'));

  domainSet = new Set(raw.domains);
  tldSuffixes = raw.tlds.map((t) => (t.startsWith('.') ? t : `.${t}`));
  extraSuffixes = [];
  extraAddresses = new Set();

  // INSTITUTIONAL_EMAIL_DOMAINS: comma-separated list of extra entries.
  // Entries starting with "." are treated as suffixes (e.g. ".gov", ".gc.ca")
  // Entries containing "@" are treated as exact-address allowlist (e.g. "alice@gmail.com")
  // Other entries are exact domains (e.g. "fraunhofer.de", "cern.ch")
  const envExtra = process.env.INSTITUTIONAL_EMAIL_DOMAINS || '';
  if (envExtra) {
    for (const entry of envExtra.split(',')) {
      const d = entry.trim().toLowerCase();
      if (!d) continue;
      if (d.includes('@')) {
        extraAddresses.add(d);
      } else if (d.startsWith('.')) {
        extraSuffixes.push(d);
      } else {
        domainSet.add(d);
      }
    }
  }

  return {
    domains: domainSet,
    tlds: tldSuffixes,
    extra: extraSuffixes,
    addresses: extraAddresses,
  };
}

/**
 * Check whether an email address belongs to an institutional domain.
 * Checks against:
 * 1. Exact-address allowlist from INSTITUTIONAL_EMAIL_DOMAINS env var (entries containing "@")
 * 2. Exact domain match in swot database (e.g. "uni-freiburg.de")
 * 3. Parent domain match (e.g. "cs.uni-freiburg.de" matches "uni-freiburg.de")
 * 4. TLD suffix match from swot tlds.txt (e.g. "ac.za", "edu.cn")
 * 5. Extra domains/suffixes from INSTITUTIONAL_EMAIL_DOMAINS env var
 */
export function isInstitutionalEmail(email: string): boolean {
  const atIdx = email.lastIndexOf('@');
  if (atIdx < 1) return false;
  const normalized = email.toLowerCase();
  const domain = normalized.slice(atIdx + 1);
  if (!domain || domain.includes('..') || !domain.includes('.')) return false;

  const { domains, tlds, extra, addresses } = load();

  if (addresses.has(normalized)) return true;

  // Check exact domain and all parent domains
  // e.g. for "dept.cs.uni-freiburg.de" check:
  //   "dept.cs.uni-freiburg.de", "cs.uni-freiburg.de", "uni-freiburg.de"
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    if (domains.has(candidate)) return true;
  }

  // Check TLD suffixes (e.g. ".ac.za", ".edu.cn")
  for (const suffix of tlds) {
    if (domain.endsWith(suffix) || domain === suffix.slice(1)) return true;
  }

  // Check extra suffixes (.gov, .gc.ca, .mil, env-configured)
  for (const suffix of extra) {
    if (domain.endsWith(suffix) || domain === suffix.slice(1)) return true;
  }

  return false;
}

/** Reset cached data (for testing). */
export function _resetRulesCache(): void {
  domainSet = null;
  tldSuffixes = null;
  extraSuffixes = null;
  extraAddresses = null;
}
