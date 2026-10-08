// The work a composer holds, carried across the full-page ORCID round-trip a
// passwordless account takes to open its re-auth window. `broadcastWithFreshAuth`
// (lib/fresh-auth.js) writes it at the moment that navigation fires, and the
// composer takes it back when it mounts on return. A bridge across one
// round-trip in one tab, not a draft: sessionStorage, one slot, and nothing
// writes it but the navigation.
//
// The slot holds one record, `{ surface, target, subject, payload, savedAt }`.
// `surface` names the composer kind, `target` what it composes for (the same
// keys at write and at restore), `subject` the account that wrote it. The key
// is subject-bound (subject-bound-keys.js), so a sign-out or a subject change
// removes it with the rest of that state.
//
// Every export answers without throwing. Storage can be blocked, and the slot
// can hold anything: a reader that throws would break the mount of every
// composer that reads it, and the success clear runs after the broadcast has
// already landed.
import { NAVIGATION_STASH_KEY } from './subject-bound-keys.js';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readRecord() {
  let raw;
  try {
    raw = sessionStorage.getItem(NAVIGATION_STASH_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const record = JSON.parse(raw);
    if (
      isPlainObject(record)
      && typeof record.surface === 'string'
      && typeof record.subject === 'string'
      && isPlainObject(record.target)
      && isPlainObject(record.payload)
    ) {
      return record;
    }
  } catch {
    /* unreadable: removed below */
  }
  clearNavigationStash();
  return null;
}

function sameTarget(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

// Replace the slot with `record`. False when storage refused the write, which
// is the caller's signal that the work would not survive the navigation.
export function writeNavigationStash(record) {
  try {
    sessionStorage.setItem(NAVIGATION_STASH_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function clearNavigationStash() {
  try {
    sessionStorage.removeItem(NAVIGATION_STASH_KEY);
  } catch {
    /* nothing to remove from a storage that cannot be reached */
  }
}

// The payload stored for this surface, target and subject, removed as it is
// read; null when the slot holds no such record.
//
// A record for another surface or target is left in place. Several composers
// read the slot as they mount (a paper page mounts its discussion composer
// before the reply composers its comment trees render later), and a reader
// that removed what it did not match would destroy the record of a composer
// that has not mounted yet. A record naming another account is removed: no
// reader in this tab can restore it. With no subject at all (a session that
// expired during the round-trip), the slot is left for the same account to
// sign back in to.
export function takeNavigationStash(surface, target, subject) {
  if (!subject) return null;
  const record = readRecord();
  if (!record) return null;
  if (record.subject !== subject) {
    clearNavigationStash();
    return null;
  }
  if (record.surface !== surface || !sameTarget(record.target, target)) return null;
  clearNavigationStash();
  return record.payload;
}

// Whether the slot holds a record for this surface and subject whose target
// carries every field of `partialTarget`. Removes nothing.
export function hasNavigationStash(surface, partialTarget, subject) {
  if (!subject) return false;
  const record = readRecord();
  return !!record
    && record.subject === subject
    && record.surface === surface
    && Object.keys(partialTarget).every((key) => record.target[key] === partialTarget[key]);
}
