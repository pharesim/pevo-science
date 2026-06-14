# BACKEND-CONSENTED-ROUTE1-BRIDGE-PREDICATE-HELPER — centralize the consented_authors Route-1 bridge predicate via validPevoPaperWhere

**Owner:** backend
**Created:** 2026-06-14 (architect, from the clean review of the Route-2 ORCID bridge-exclusion task)
**Priority:** P3 (maintainability consistency; pre-existing, no behavioral defect)

## Problem

The Route-1 bridge-account arm of the `consented_authors` CTE in `consentedAuthorsCteBody`
(`backend/src/hafsql.ts`) hand-rolls the bridge-paper predicate inline:

```
OR (rc.json_metadata -> ${tag} ->> 'type' = 'bridge_paper' AND rc.author = ${bridge})
```

This is the same `(author = $bridge AND type = 'bridge_paper')` predicate that
`validPevoPaperWhere({ source: 'bridge' })` already expresses. The recently-landed Route-2 ORCID
bridge-exclusion guard (in the `consent_signer_eligibility` CTE of the same function) reuses the helper,
which establishes the helper as the canonical single-source for the bridge-identity predicate. The
Route-1 arm directly below it still hand-rolls the same logic, so the two now diverge in form while
agreeing in meaning. If the helper's bridge discriminant ever gains a third condition (e.g. a status or
provenance field), the hand-rolled arm would silently miss it and the two bridge gates would disagree.

No behavioral defect today: the hand-roll is equivalent to the helper's `bridgeArm` for the current
two-condition predicate. This is a consistency/divergence-prevention cleanup, not a fix.

## Goal

The `consented_authors` Route-1 bridge-account arm expresses its bridge-paper predicate through
`validPevoPaperWhere`, so the bridge-identity predicate has exactly one source of truth across
`consentedAuthorsCteBody`.

## Acceptance

- The inline `rc.json_metadata -> tag ->> 'type' = 'bridge_paper' AND rc.author = bridge` predicate in
  the Route-1 arm of `consented_authors` is replaced by
  `validPevoPaperWhere({ commentAlias: 'rc', appTagParam: tag, bridgeAccountParam: bridge, source: 'bridge' })`.
  (`rc` is already the comment alias in that arm; `tag` and `bridge` are already bound at those param
  positions, so no param re-allocation is needed.)
- Behavior is unchanged: the existing consented-set behavioral pins (the consented-authors real-postgres
  suites, including the bridge-ORCID-exclusion regression) stay green. A bridge paper's own bridge-account
  Route-1 self-consent must still resolve exactly as before.
- `npm run typecheck` + `npm run lint` clean.
- Comment anchors stay on stable symbols.

## Cross-references

- `backend/src/hafsql.ts` — `consentedAuthorsCteBody` (the `consented_authors` Route-1 arm),
  `validPevoPaperWhere` (the helper; `source: 'bridge'` expands to the bridge-identity-plus-type form).
- `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`
  — the convention that mandates `validPevoPaperWhere` as the centralized bridge-identity predicate rather
  than inline hand-rolls.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
