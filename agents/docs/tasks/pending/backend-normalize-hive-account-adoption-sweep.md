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
