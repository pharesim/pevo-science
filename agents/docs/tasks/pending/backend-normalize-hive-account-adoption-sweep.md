# BACKEND-NORMALIZE-HIVE-ACCOUNT-ADOPTION-SWEEP — exhaustively adopt `normalizeHiveAccount` at the 4 sibling raw-lookup sites outside the round-2/round-3 patches

**Owner:** Backend Agent
**Created:** 2026-05-19 (architect, surfaced by adversarial review during the supersession cluster — task 3 round-3)
**Priority:** P2 (with P3 components)

## Problem

`backend-papers-canonical-orcid-resolution` round-2 + round-3 extracted the canonical-hive-account normalizer (renamed `canonicalHiveKey` → `normalizeHiveAccount` in round-3) and adopted it at 3 sites: SQL JOIN in `authorsWithSupersessionSelect`, `computeSupersession` (JS), and 2 `accredited_authors` row-builder sites in `routes/papers.ts`. Per `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`, once a canonical wrapper exists, every direct caller of the underlying pattern (`.hive` byte-equality against accredited / vouched / co-author sets) is a structural drift risk.

Adversarial review of round-3 surfaced 4 sibling sites that still do raw `.hive ===` / `auth ->> 'hive'` byte-equality against consensus-lowercase chain identifiers. Real consensus chain authors are always lowercase, but `pevo.authors[i].hive` is broadcaster-controlled JSON metadata and CAN be mid-case. The exploit window is bounded by PEvO's accreditation-revocation cascade, but the audit is convention-mandated and the sites are mechanically clear.

## Affected sites

### P2 — privilege-escalation surfaces

#### Site 1: `backend/src/hafsql.ts:442` — `accreditedVoteCount` predicate

The predicate filters out the paper author and their co-authors from the count of "third-party accredited reviews." If the comparison uses raw `pevo.authors[i].hive` byte-equality against the chain-validated lowercase reviewer/author identifiers, an uppercase co-author hive bypasses the self-exclusion. The co-author can post reviews of their own paper and have those reviews counted in `accreditedVoteCount` (visible on UI as a third-party accreditation signal).

Reachability requires the publisher (possibly under social pressure from the co-author) to broadcast `pevo.authors=[..., {hive:'Alice'}]` instead of `'alice'`. Deliberate-spoof scenario; not user error after the SPA publish-time prefill closes the legitimate-mistake channel.

#### Site 2: `backend/src/routes/anonymousReview.ts:135` — anonymous-review co-author self-block

The route prevents a paper's authors from reviewing their own paper through the platform's anonymous-review proxy account. If the self-block check uses raw `pevo.authors[i].hive` byte-equality against the requesting hive's lowercase username, an uppercase co-author hive bypasses the block. The co-author posts an anonymous review of their own paper through the proxy — defeating the entire anonymous-review trust model for that paper.

Same reachability as site 1 (broadcaster-controlled `pevo.authors[]` mid-case). Higher abuse-value than site 1: the proxy account is platform-managed; the anonymous-review identity should not be a path for self-review under any circumstance.

### P3 — UX-only sites

#### Site 3: `backend/src/hafsql.ts:651` — `authorshipClaimsCte` auto-accept

A co-author whose `pevo.authors[].hive` was broadcast as uppercase can't auto-accept their authorship claim (their `claim` stays in `pending` indefinitely). Failure-closed (the claim doesn't silently auto-accept against the wrong account), but UX bug: the co-author is stuck.

#### Site 4: `backend/src/routes/papers.ts:2885` — bridge-paper retract authorization

Bridge-paper retract handler checks if the requesting hive matches a `pevo.authors[].hive` from the bridge metadata. Raw comparison fails for uppercase co-author hive; legitimate retract request rejected. Failure-closed UX bug.

## Acceptance

1. **Replace each of the 4 sites' raw `.hive` / `auth ->> 'hive'` lookups with the canonical wrapper:**
   - SQL sites: `LOWER(TRIM(...))` matching the round-3 pattern + the `[a-z0-9.-]+` charset regex guard.
   - JS sites: `normalizeHiveAccount(...)` import from `backend/src/lib/author-supersession.ts`.
2. **Exhaustive grep audit:** `grep -rnE '\.hive\b' backend/src/` after the fix, re-disposition every remaining site against the wrapper. Document any intentional non-adoption (e.g., sites that legitimately accept verbatim chain values without normalization) with a one-line comment anchored on the rationale.
3. **Tests per site, anchored on the abuse vector:**
   - Site 1 (accreditedVoteCount): test that a vote from a co-author whose `pevo.authors[].hive` is `'Alice'` (uppercase) is NOT counted in `accreditedVoteCount` for that paper.
   - Site 2 (anonymous-review self-block): test that an anonymous-review submission by a vouched co-author whose hive is `'Alice'` (uppercase) is rejected with the self-block 403.
   - Sites 3 + 4 (UX): test that an uppercase-hive co-author can auto-accept (site 3) and retract bridge papers (site 4).
4. **Mutation-kill verification:** reverting any of the 4 sites to raw lookup fails the corresponding test red.
5. **No SQL-side migration burden:** the JOIN-predicate normalization runs in-query on read; no backfill needed.

## Out of scope

- Re-litigating PEvO's broadcaster-attribution + accreditation-cascade trust model. Per CLAUDE.md the accreditation-revocation cascade is the primary defense; this task closes mechanical normalization drift at sites where the wrapper exists and is convention-mandated.
- Other normalization classes (orcid, name, affiliation). Filed separately as `backend-orcid-trim-parity` (sibling task).
- New convention docs. The existing `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` governs.

## Cross-references

- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — the convention this task enforces.
- `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — the deeper convention these gates honor (author-side check is the security predicate; broadcaster-metadata is at most a routing input).
- Cluster review 2026-05-19 (architect-context): adversarial findings for 4 sites; correctness corroborated site 4.
- `backend/src/lib/author-supersession.ts` — `normalizeHiveAccount` definition.
- `backend/src/hafsql.ts:442, :651` — SQL sites.
- `backend/src/routes/anonymousReview.ts:135` — JS site (anonymous-review self-block).
- `backend/src/routes/papers.ts:2885` — JS site (bridge-paper retract).

## Architect re-review (2026-05-20) — HELD PENDING FIXES:

Wrapper adoption at the 6 sites is correct and the architect's grep audit verifies the claim is exhaustive (remaining `.hive` reads in `author-supersession.ts` are display-passthrough/type-guard, not predicate comparisons). Several test-coverage and structural gaps need to land for the mutation-kill guarantees to hold.

1. **`backend/tests/hafsql.test.ts:759-768`** — the `paper_resolved_votes` cascade-fail defense test still hardcodes the pre-fix `subqueryShape` (`a ->> 'hive' = plv.voter`) while production `backend/src/reputation.ts:651-652` was widened to `LOWER(TRIM(...)) ~ '^[a-z0-9.-]+$' AND LOWER(TRIM(...)) = plv.voter`. A targeted revert of the normalization at that production site would leave this test green; the mutation-kill property is silently weakened. Update `subqueryShape` to mirror the post-fix predicate (preserves the cascade-fail defense AND pins normalization), AND add a synthetic-data behavioral assertion (voter='bob', paper authors=[{hive:'Bob'}]) asserting bob's vote is excluded from `paper_resolved_votes` post-fix. (Cross-corroborated by security + testing + adversarial + maintainability — four independent reviewers.)

2. **`backend/tests/hafsql.test.ts:665-668`** — the new `authorshipClaimsCteBody` describe-block docblock cites `excludeSelfReviewWhere-callsite-canaries.test.ts` as the clause-(c) real-path companion. That cited file tests presence of `excludeSelfReviewWhere(` invocations across route call sites — it does NOT cover the `LOWER(TRIM(...))` normalization in `authorshipClaimsCteBody`. The clause-(c) claim is materially overstated. Add a helper-output canary that calls `authorshipClaimsCteBody(...)` and asserts both `LOWER(TRIM(... ->> 'hive')) ~ '^[a-z0-9.-]+$'` and the `LOWER(TRIM(...)) = cb.claimer` equality conjunct appear in the returned body. Correct or remove the misleading companion citation in the docblock.

3. **`backend/src/hafsql.ts:670`** — the new hive-username auto-accept arm uses direct integer index (`-> cb.author_index ->> 'hive'`); sibling arms (`excludeSelfReviewWhere`, `paper_resolved_votes`) defend via `jsonb_array_elements(CASE WHEN jsonb_typeof = 'array' ...)` + inner `jsonb_typeof = 'object'` guards. Fail-soft today (`-> N` on a non-array → NULL, which makes the conjunct false), but the asymmetry invites a parity-driven refactor that erases either guard. Either add the explicit `jsonb_typeof` defense at the auto-accept arm OR add a one-line inline comment noting the direct-index variant is structurally safer (integer subscript bounds the access; no array iteration to guard).

4. **`backend/tests/routes/anonymousReview.test.ts:186-219`** — the third-party "Carol" control test asserts `expect(...).not.toContain(...)` inside `if (res.status === 403)`. After the self-block check the route requires `config.pevoAnonPostingKey` (unset in tests) → returns 500 → status is never 403 → inner expect never runs → test passes vacuously. A regression where the new normalization incorrectly self-blocks Carol (a true third-party) slips through today. Either stub `pevoAnonPostingKey` + broadcast and assert 200, OR drop the if-guard and assert `expect(res.status).not.toBe(403)` unconditionally.

5. **`backend/tests/routes/anonymousReview.test.ts` and `backend/tests/routes/retract.test.ts`** — extend route-layer tests to cover whitespace-padded co-author entries (e.g. `{hive:' alice '}`), not just uppercase. Per task acceptance #3, "tests per site, anchored on the abuse vector" — the SQL behavioral matrix covers both classes; the route layer only covers uppercase. A regression that broke `.trim()` in `normalizeHiveAccount` while keeping `.toLowerCase()` would not be caught by current route tests.

6. **`backend/src/helpers.ts:extractAuthorizedContinuationAuthors`** — add a test pinning the off-charset rejection path. Helper switched from `e.hive.trim().toLowerCase()` (admitted any non-empty result) to `normalizeHiveAccount(e.hive)` (rejects off-charset per `^[a-z0-9.-]+$`). The narrowing IS the convention's intent per architect dismissal of the cluster-review "silent admit-set narrowing" finding; the rejection IS the post-fix contract; a test should pin it. Existing tests cover the lowercasing/whitespace-trim path; the off-charset reject path (`{hive:'al;ice'}` → not admitted) is uncovered. A regex-loosening regression would silently re-open admit-set leakage.

### Architect notes (no implementer action)

- **Signal block grep audit** (wrapping-primitive convention rule 12) was not appended to this task file before the `pending/ → review/` move. Architect ran the grep at review intake; the 6-site claim is verified exhaustive. Implementer should include the grep output verbatim in the signal block on the next `pending/ → review/` move per the convention.
- **Commit message description of `helpers.ts` change** is inverted (says "inline trim/lowercase" — actual change adopted `normalizeHiveAccount`). Dismissed per architect triage: future maintainers read the diff (which is correct), not the commit body, post-landing.
- **Silent admit-set narrowing** for historical chain posts with exotic-whitespace hive entries dismissed per architect triage: narrowing IS the convention's intent; pre-fix tolerance was inconsistent with the canonical normalization.
- **Reputation cycle silent re-scoring** dismissed per architect triage: correct outcome; per PEvO logging-minimal posture no operator signal added.
