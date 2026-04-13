import diff_match_patch from 'diff-match-patch';

const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const DIFF_EQUAL = 0;

const TYPE_MAP = { [DIFF_DELETE]: 'delete', [DIFF_INSERT]: 'insert', [DIFF_EQUAL]: 'equal' };

function textDiff(oldText, newText) {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(oldText || '', newText || '');
  dmp.diff_cleanupSemantic(diffs);
  const segments = diffs.map(([op, text]) => ({ type: TYPE_MAP[op], text }));
  const changed = diffs.some(([op]) => op !== DIFF_EQUAL);
  return { changed, segments };
}

function setDiff(listA, listB, keyFn) {
  const keysA = new Set((listA || []).map(keyFn));
  const keysB = new Set((listB || []).map(keyFn));
  const added = (listB || []).filter(item => !keysA.has(keyFn(item)));
  const removed = (listA || []).filter(item => !keysB.has(keyFn(item)));
  return { changed: added.length > 0 || removed.length > 0, added, removed };
}

/**
 * Compare two PaperDetail versions and return a structured diff.
 * @param {Object} versionA - PaperDetail for the older version
 * @param {Object} versionB - PaperDetail for the newer version
 * @returns {Object} diff result
 */
export function computeVersionDiff(versionA, versionB) {
  const title = textDiff(versionA.title, versionB.title);

  const diffable = !versionA.ipfs_cid && !versionB.ipfs_cid;
  const bodyDiff = diffable ? textDiff(versionA.body, versionB.body) : { changed: false, segments: [] };
  const body = { changed: bodyDiff.changed, diffable, segments: bodyDiff.segments };

  const authors = setDiff(
    versionA.authors, versionB.authors,
    a => a.hive
  );

  const supplementaryFiles = setDiff(
    versionA.supplementary_files || versionA.json_metadata?.pevo?.supplementary_files || [],
    versionB.supplementary_files || versionB.json_metadata?.pevo?.supplementary_files || [],
    f => f.cid
  );

  const citations = setDiff(
    versionA.citations || versionA.json_metadata?.pevo?.citations || [],
    versionB.citations || versionB.json_metadata?.pevo?.citations || [],
    c => `${c.author}|${c.permlink}`
  );

  const tagsA = versionA.keywords || versionA.tags || [];
  const tagsB = versionB.keywords || versionB.tags || [];
  const keywords = setDiff(tagsA, tagsB, k => k);

  return { title, body, authors, supplementaryFiles, citations, keywords };
}
