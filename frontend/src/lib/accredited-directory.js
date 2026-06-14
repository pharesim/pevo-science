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
      // Intentional: do NOT assign `cache` on failure. A transient fetch
      // failure (network blip, backend hiccup) should be recoverable on the
      // next call — the next caller will re-enter this IIFE and re-issue
      // `fetchAccreditations`. If we cached `{}` here, every subsequent
      // call would short-circuit at the `if (cache) return cache` gate and
      // the directory would stay empty for the rest of the session.
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

// Apply ORCID-prefill semantics for a co-author row when the user changes its
// `hive` field. Mutates `row` in place. Three cases:
//
//   1. New hive is accredited AND directory row has an `orcid`:
//      write `acc.orcid` to row.orcid (and the input becomes locked because
//      isCoAuthorAccredited(...) returns true upstream).
//   2. New hive is accredited but the directory row has NO `orcid` field
//      (malformed accreditation record): leave row.orcid untouched. The input
//      still locks (the field is owned by the accreditation record), but we
//      do NOT blank a value the user already typed.
//   3. New hive is NOT accredited: clear row.orcid. This is the
//      "accredited→non-accredited transition" case — the previously prefilled
//      ORCID belongs to a different identity and would silently be carried
//      onto the published Hive post otherwise.
export function applyHiveChangePrefill(row, directory) {
  if (!row) return;
  const acc = lookupAccredited(directory, row.hive);
  if (acc) {
    if (acc.orcid) row.orcid = acc.orcid;
    // else: leave row.orcid alone (case 2)
  } else {
    row.orcid = '';
  }
}

// Reapply ORCID-prefill across an array of rows AFTER the directory loads.
// Distinct from applyHiveChangePrefill: this runs at directory-resolve time
// (potentially after a draft restore), so we must not clobber any ORCID the
// user typed BEFORE the fetch returned. We only write when row.orcid is
// blank — a non-blank value is treated as user intent and left alone.
//
// Reactivity note: in-place `row.orcid` mutation is safe under Alpine 3's
// proxy. Alpine's reactivity engine is @vue/reactivity's `reactive()`,
// which lazily deep-proxies nested objects on access — including
// objects pushed into reactive arrays AFTER init.
// The `for...of` below traverses the array through the proxy, so each
// `row` IS the reactive-wrapped object; setting `row.orcid` triggers any
// subscribed `:value="ca.orcid"` effects. Verified 2026-05-16 against
// @vue/reactivity directly with the push-after-init then in-place-mutate
// pattern. No `.slice()` workaround needed at the publish.js / edit.js
// call sites.
export function applyAccreditedPrefill(rows, directory) {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (!row) continue;
    const acc = lookupAccredited(directory, row.hive);
    if (!acc) continue;
    // Skip rows the user has already filled in. Also skip when the
    // accreditation record is missing an orcid (per applyHiveChangePrefill
    // case 2, we never write blank).
    if (row.orcid) continue;
    if (!acc.orcid) continue;
    row.orcid = acc.orcid;
  }
}
