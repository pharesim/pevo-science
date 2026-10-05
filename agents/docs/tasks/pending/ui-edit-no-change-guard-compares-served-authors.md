# The edit page's no-change guard lets an untouched form through when the served authors differ from the head op's claim

**Owner:** ui
**Created:** 2026-10-05
**Priority:** normal

Found by the review of the native-edit no-op patch fix (filed at the user's triage, 2026-10-05).

## Why

`handleSubmit` in `frontend/src/pages/edit.js` refuses a submit that changes nothing, before the re-auth gate. Its author check compares the form's assembled authors with `pevoMeta.authors`, the raw `authors` claim in the served metadata. The form's author rows are prefilled by `_prefillForm` from the served `paper.authors`, which is not that raw claim:

- The served `name` of an accredited author is the attested name when the accreditation carries one (`authorsWithSupersessionSelect` in `backend/src/hafsql.ts`, and `resolveAuthorName` on the chain path), not the name the author claimed on chain.
- On a chain paper the served `authors[]` is the cumulative union across the chain's posts, while `pevoMeta` is the latest op's metadata.

So when an author's attested name differs from the claimed one, or on a chain paper whose union differs from the latest op's list, an untouched form gets past the guard. Until the no-op patch fix, such a submit broadcast an empty body and failed ("Edit failed"). Now it lands: a metadata-only version that bumps `version`, rewrites the claimed author entries to the served projection, and makes every existing review read as outdated (`outdated = reviewedVersion < latestVersion` in the paper enrichment route counts every version).

## Scope

Decide "unchanged" against what the form was loaded with, not against the raw head claim. The page already takes a baseline of the form once the prefill is done (`_baselineFields`, `_baselineEditors`, compared through `fieldsMatchSnapshot` from `lib/composer-drafts.js`). A form that still matches its baseline, with no supplementary file attached and no addressed-review tick, is unchanged.

## Acceptance criteria

1. An untouched form refuses with `edit.noChanges` before any re-auth act, for a paper whose served author name differs from the head op's claimed name, and for a chain paper whose served authors differ from the latest op's list.
2. A form with any real change (title, body, keywords, an author field, citations, a file, a review tick) still submits.
3. The existing `an unchanged form costs no re-auth act at all` spec stays green.
4. Each new assertion is probed by reverting its own site; list the probes in the signal block.
