// Storage for the publish and edit pages' local drafts (ARCHITECTURE.md § 8,
// "Composer Drafts"). A draft is a convenience copy in localStorage, never a
// source of truth.
//
// One entry per account and composer target. The pages capture the account
// (and, on the edit page, the paper) once and build the key from the captured
// values only, so an instance cannot write under another account's or another
// paper's key. Hive account names and permlinks hold no colon, which keeps the
// separator unambiguous and the per-account prefix exact.

const PUBLISH_PREFIX = 'pevo-draft-publish:';
const EDIT_PREFIX = 'pevo-draft-edit:';

// The keys used before drafts were bound to an account. Their entries carry no
// account and cannot be told apart from the load-time copies every visit
// wrote, so they are deleted, never restored.
const LEGACY_PUBLISH_KEY = 'pevo-draft-publish';
const LEGACY_EDIT_PREFIX = 'pevo-draft-edit-';

// Entry fields that describe the text fields rather than standing on their
// own: they leave the entry together with the text.
const TEXT_BOOKKEEPING = ['savedAt', 'head_marker'];

export function publishDraftKey(account) {
  return `${PUBLISH_PREFIX}${account}`;
}

export function editDraftKey(account, author, permlink) {
  return `${EDIT_PREFIX}${account}:${author}:${permlink}`;
}

function removeKeysMatching(matches) {
  const doomed = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null && matches(key)) doomed.push(key);
  }
  for (const key of doomed) localStorage.removeItem(key);
}

export function removeLegacyDrafts() {
  removeKeysMatching((key) => key === LEGACY_PUBLISH_KEY || key.startsWith(LEGACY_EDIT_PREFIX));
}

// Every draft the account holds: its publish key exactly, and its edit keys by
// a prefix that ends in the separator, so removing `bob` leaves `bobby`'s
// drafts alone. Account deletion calls this; an explicit sign-out keeps them.
export function removeAccountDrafts(account) {
  const publishKey = publishDraftKey(account);
  const editPrefix = `${EDIT_PREFIX}${account}:`;
  removeKeysMatching((key) => key === publishKey || key.startsWith(editPrefix));
}

// The entry stored under `key`, or null. An entry that does not parse to an
// object is removed: nothing can be restored from it, and it would fail the
// same way on every later load.
export function readDraftEntry(key) {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  try {
    const entry = JSON.parse(raw);
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) return entry;
  } catch {
    /* unreadable: falls through to the removal */
  }
  localStorage.removeItem(key);
  console.warn('Draft recovery failed');
  return null;
}

// Whether a stored entry holds text a page can restore. `title` is the shape
// sentinel: every write that stores text stores it as a string.
export function draftHasText(entry) {
  return !!entry && typeof entry.title === 'string';
}

// The entry to store after a write, or null when the key should be removed.
//
// `fields` are the page's text fields and `atBaseline` says whether they equal
// the instance's baseline. A form at its baseline holds no user work, so the
// text fields leave the entry together with their bookkeeping. Any other state
// the entry carries stays, and an entry left with none is removed. `savedAt`
// moves only when the text changed, so an instance that restored a draft and
// writes it back unchanged does not make old text look new. `headMarker` is
// stored only when given, which is the edit page.
export function composeDraftEntry(stored, fields, { atBaseline, now, headMarker }) {
  const names = Object.keys(fields);
  const otherState = {};
  for (const [name, value] of Object.entries(stored || {})) {
    if (!names.includes(name) && !TEXT_BOOKKEEPING.includes(name)) otherState[name] = value;
  }
  if (atBaseline) return Object.keys(otherState).length > 0 ? otherState : null;
  const textUnchanged = !!stored && typeof stored.savedAt === 'number'
    && names.every((name) => JSON.stringify(stored[name]) === JSON.stringify(fields[name]));
  const entry = { ...otherState, ...fields, savedAt: textUnchanged ? stored.savedAt : now };
  if (headMarker !== undefined) entry.head_marker = headMarker;
  return entry;
}

// Each field's value as JSON, the form a baseline is kept and compared in.
export function snapshotFields(fields) {
  const snapshot = {};
  for (const [name, value] of Object.entries(fields)) snapshot[name] = JSON.stringify(value);
  return snapshot;
}

export function fieldsMatchSnapshot(fields, snapshot) {
  return Object.entries(fields).every(([name, value]) => JSON.stringify(value) === snapshot[name]);
}

// The paper's head marker (ARCHITECTURE.md § 2, "Body, edits and versions"):
// `<head author>/<head permlink>/<version count>/<block of the newest op>`.
// The payload's own `head_marker` decides whenever the payload carries one.
// Otherwise the marker is computed from the same fields, and is null when
// `versions` is the one-entry stub (block 0) that a failed or empty replay
// leaves, since the stub says nothing about which version is the head.
export function headMarkerOf(paper) {
  if (Object.prototype.hasOwnProperty.call(paper, 'head_marker')) return paper.head_marker ?? null;
  const versions = Array.isArray(paper.versions) ? paper.versions : [];
  const newest = versions[versions.length - 1];
  if (!newest || (versions.length === 1 && newest.block_num === 0)) return null;
  const headAuthor = paper.head_author || paper.author;
  const headPermlink = paper.head_permlink || paper.permlink;
  return `${headAuthor}/${headPermlink}/${versions.length}/${newest.block_num}`;
}
