import { fetchAccreditations } from '../api.js';

// Shared accredited-researcher directory used by the publish/edit author-list
// editors to prefill ORCID and offer username autocomplete when a co-author's
// Hive handle is currently accredited.
//
// The directory is fetched lazily and cached at module scope; the publish and
// edit pages both reuse the same map across navigations within a session. The
// cap (200) matches the backend list cap; if the accreditation set grows past
// that, paginate here. Misses fall through silently — a non-accredited handle
// just doesn't prefill ORCID.

const DIRECTORY_LIMIT = 200;

let cache = null;
let inFlight = null;

export function _resetAccreditedDirectoryForTests() {
  cache = null;
  inFlight = null;
}

export async function loadAccreditedDirectory() {
  if (cache) return cache;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetchAccreditations({ limit: DIRECTORY_LIMIT });
      const map = {};
      for (const row of (res?.data || [])) {
        if (row?.username) map[row.username] = row;
      }
      cache = map;
      return cache;
    } catch (err) {
      console.warn('[accredited-directory]', err);
      return {};
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function normalizeUsername(input) {
  if (input == null) return '';
  return String(input).trim().toLowerCase().replace(/^@/, '');
}

export function lookupAccredited(directory, username) {
  if (!directory) return null;
  const key = normalizeUsername(username);
  if (!key) return null;
  return directory[key] || null;
}

export function filterAccreditedByPrefix(directory, prefix, max = 8) {
  if (!directory) return [];
  const p = normalizeUsername(prefix);
  if (!p) return [];
  const out = [];
  for (const username of Object.keys(directory)) {
    if (username.startsWith(p)) {
      out.push(directory[username]);
      if (out.length >= max) break;
    }
  }
  return out;
}
