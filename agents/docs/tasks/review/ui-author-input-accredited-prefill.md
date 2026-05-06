# UI-AUTHOR-INPUT-ACCREDITED-PREFILL — prefill ORCID and deactivate input when author's hive is accredited

**Owner:** UI Agent
**Created:** 2026-05-06 (filed at archive of `backend-continuation-post-author-consent-gate.md`, A7; surfaced during round-3 triage finding #3 split-call)
**Priority:** P3

## Problem

The publish form's authors-list input asks the user to enter `{name, hive, orcid, affiliation}` per author. When the author's `hive` field is set to an accredited Hive account, ORCID is already known on the platform (it's part of the accreditation record). Forcing the user to type it again creates two failure modes:

1. **Typo divergence.** The user's hand-typed ORCID differs from the accreditation's bound ORCID; the `pevo.authors[].orcid` field on chain mismatches the accredited identity. Downstream surfaces that key on the chain ORCID diverge from the accredited identity surface.

2. **UX friction.** The user is asked to re-enter information the platform already knows.

## Goal

When the user enters a hive account in the authors list and that account is currently accredited, prefill the ORCID field from the accreditation record and deactivate (read-only or visually-locked) the ORCID input. Surface an "(accredited)" indicator on the entry so the user can see why the field is locked.

Provide a click affordance on the username input to find/select an accredited Hive account (autocomplete from `GET /api/accreditations` or equivalent), reducing the chance of a typo silently locking out the legitimate accredited author.

## Acceptance

1. **ORCID prefill.** When the `hive` field on an authors-list entry is set to an accredited account, the entry's `orcid` field is prefilled from the accreditation record and the input is deactivated. If the user clears the `hive` field (or types one that is not accredited), the ORCID field becomes editable again.

2. **Click affordance.** The username input on each authors-list entry exposes an autocomplete or selector listing accredited accounts the user can pick from (per the user's reading: keeps publishers within the accredited set rather than guessing handles).

3. **Backend-data dependency.** The lookup is read-only (no broadcast). Requires either an existing accreditation lookup endpoint or a thin one if not yet present. Confirm with the architect what surface to read from (probably already exists via `GET /api/accreditations`).

4. **Visual signal.** The deactivated ORCID input has a clear visual marker (e.g. greyed-out + lock icon + "(accredited)" badge) so the user understands why it can't be edited.

5. **Native publish form + edit form.** Apply to both `frontend/src/pages/publish.js` (or wherever the new-paper authors-list editor lives) and `frontend/src/pages/edit.js` (or the edit-paper variant). Continuation-post creation surface, when it ships, follows the same rule.

## Cross-references

- `agents/docs/tasks/blocked/ui-multi-author-consent-affordances.md` — adjacent task covering `author_accept` / `author_resign` affordances; this prefill task is independent but lives in the same general code surface.
- `backend-continuation-post-author-consent-gate.md` round-3 triage finding #3 (archived 2026-05-06) — original surfacing of the split-call rationale.
