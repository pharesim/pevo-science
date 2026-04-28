# ARCHITECT-DISCIPLINE-FILTER-PUBLISH-CHARSET-ALIGNMENT — Audit + decide

**Owner:** architect (decision); follow-up implementer-task filed after decision
**Created:** 2026-04-28 (surfaced by BE-DISCIPLINE-LENGTH-CAP review, correctness reviewer P3 conf 50)
**Priority:** P3

## Context

BE-DISCIPLINE-LENGTH-CAP (commit `602214f`) introduced the regex `^[\p{L}\p{N} \-]+$/u` on `?discipline=`. The publish form (`frontend/src/pages/publish.js:117-136, 575-577`) lets accredited users type free-form custom discipline strings via `useCustomDiscipline` and stores them verbatim in the post tag/`json_metadata`.

If any paper has been published with a discipline containing characters outside the filter charset (e.g. `Mathematics & Physics`, `C.S.`, `bio/chem`, `STEM (general)`, `Health & Wellness`), the URL filter for that discipline returns `400 BAD_REQUEST`. The paper becomes unfilterable from its own chain metadata.

The `DISCIPLINE_TAXONOMY` predefined subfields all fit the regex today, and `/api/disciplines` returns canon_name values that fit too — so the dropdown UI path is unaffected. But user-typed disciplines bypass the dropdown and could reach the chain.

## [BLOCKED by Architect] (2026-04-28)

**Step 1: HAF audit.** Run against pevotest HAF:

```sql
SELECT DISTINCT LOWER(c.json_metadata -> 'pevotest' ->> 'discipline') AS d
FROM hafsql.comments c
WHERE c.parent_permlink = 'pevotest'
  AND c.json_metadata -> 'pevotest' ->> 'discipline' IS NOT NULL
  AND NOT (LOWER(c.json_metadata -> 'pevotest' ->> 'discipline') ~ '^[\p{L}\p{N} \-]+$')
ORDER BY d;
```

If zero rows: low-priority dismissal (write a one-line note to the conventions doc and close this task; the gap is purely theoretical).

If non-zero rows: pick one direction:

**Option A: Tighten publish.** Add the same charset+length guard to `frontend/src/pages/publish.js` (and the bridge submit form, if it accepts free-form discipline). Existing non-conforming chain posts remain unfilterable; UI shows a banner suggesting the user file a retraction + republish if they want their paper findable via the discipline filter. UI task: `ui-publish-discipline-charset-guard.md`.

**Option B: Relax filter regex.** Add `&`, `.`, `,`, `(`, `)`, `'`, `/` to the allowlist. Length cap stays at 100. Backend task: extension to `BE-DISCIPLINE-LENGTH-CAP`-shape regex. Risk: broader charset = more attack surface for whatever future LIKE/regex/locale-aware processing the value flows through (currently just `LOWER()` then `=`-match, but future-proof concern).

**Option C: Accept divergence.** Document that exotic-charset disciplines are unfilterable via `?discipline=` but remain navigable via direct paper-detail links. No code change; `agents/docs/api-contracts/papers.md` adds a one-line caveat. This is the cheapest option but the most user-hostile for any chain content with non-conforming disciplines.

## Architect decision needed

After HAF audit, pick A / B / C. Then:
- If A: file `ui-publish-discipline-charset-guard.md` in `pending/`.
- If B: file backend extension task in `pending/`.
- If C: add caveat to `papers.md` directly (architect-side fix-in-place); no implementer task.

Then archive this decision-task per the architect protocol.
