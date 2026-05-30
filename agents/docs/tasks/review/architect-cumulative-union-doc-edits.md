# ARCHITECT-CUMULATIVE-UNION-DOC-EDITS — land the 4 [TODO Architect] doc edits inherited from BACKEND-MULTI-AUTHOR-CUMULATIVE-UNION

**Owner:** Architect Agent
**Created:** 2026-05-19 (architect, deferred at archive of `backend-multi-author-cumulative-union` round-3)
**Priority:** P1

## Context

`backend-multi-author-cumulative-union` (archived 2026-05-19 round-3 clean) prescribed 4 architect-owned doc edits at the round-1 backend signal under `[TODO Architect]`:

1. **`agents/docs/ARCHITECTURE.md` § 2 "Multi-Author Trust Model" — REWRITE.** Currently describes the round-3 no-shrink rule + `headAuthorsCoverRoot` cover-check (superseded). Replace with cumulative-union semantics: display construction (cumulative union of `pevo.authors[].hive` across all chain posts, first-occurrence order, sub-field resolution rule — most-recent self-claim wins, else most-recent fallback); ORCID server-override for accredited hives + `orcid_claim_mismatch` audit event for divergent claims; chain-walk admit-set per-hop cumulative; "Drops are forbidden by construction" framing; Phase 2 layering (`author_accept` / `author_resign`); bridge-paper subsection. Round-2 hold also added: per-request scope of "drops forbidden by construction" invariant (explicit time-bounded scope so a future reader doesn't infer across-time permanence). Spans current lines 172-288 of `ARCHITECTURE.md`.

2. **`agents/docs/api-contracts/papers.md` — UPDATE the PaperDetail Notes section** for cumulative-union semantics on `authors[]`, ORCID server-override + audit event behavior, `accredited_authors` rebuild semantics.

3. **`agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — UPDATE the "Sites this convention applies to" section.** Continuation-post gate's predicate shifted from "set membership in root's authorized set" to "set membership in the cumulative chain authors[]"; structural rule preserved.

4. **`agents/docs/solutions/architecture-patterns/pevo-paper-version-chain-and-edit-semantics-2026-04-30.md` rule #4 — APPEND a paragraph** noting that "Authors list is monotonic" is now reinforced by the cumulative-union construction (the union enforces monotonicity by construction; the rule no longer relies on a check-and-reject mechanism).

## Why deferred (not landed at archive of the parent task)

`backend-cumulative-union-listing-surfaces-parity` is in `tasks/pending/` (architect ratified Option 4 design 2026-05-19) and a sibling backend agent is actively implementing it in the working tree at commit `259d9cb`. That task extends the cumulative-union invariant from the **detail surface** (where the parent task closed it) to **listing / profile** surfaces via a shared `resolveChainCumulativeAuthors` helper + per-root Redis chain cache.

§ 2's rewrite should describe the cross-surface invariant in its final shape — not the detail-only intermediate state. Rewriting now would require a second rewrite when listing-surfaces lands; rewriting once after both tasks ship captures the full picture with no churn.

[BLOCKED by Backend] — Gated on archive of `backend-cumulative-union-listing-surfaces-parity` (currently in `tasks/pending/`). When that task archives, the sibling backend agent or architect `git mv`s this file from `tasks/blocked/` to `tasks/pending/` per CLAUDE.md rule #6.

## Acceptance

When unblocked:

1. `ARCHITECTURE.md` § 2 rewrite covers: cumulative-union (detail) + listing-surfaces parity (the new task's invariant) + per-request invariant scope + Phase 2 layering + bridge-paper carve-out + audit event schema.
2. `api-contracts/papers.md` PaperDetail Notes + PaperSummary Notes (listing-surfaces extends to PaperSummary too) cover the cumulative semantics.
3. The 2 convention-doc updates land (small paragraph-level edits).
4. Cross-references between the 4 docs are consistent.
5. After the doc edits land, re-check whether any production code comments cite `agents/docs/ARCHITECTURE.md § 2` against text that the rewrite removed; update or remove those comments per the comment-anchor conventions.

## Author-identity-model additions (2026-05-26)

The author-identity-model `/ce-brainstorm` (spun off the `backend-cumulative-union-listing-surfaces-parity` round-3→round-4 deferral) added scope to the § 2 rewrite. The rewrite must also incorporate, once `backend-author-identity-model` lands:

- **Hive-less display-credit persistence.** § 2's claimed-set narrative is hive-keyed (for *vouching*). Add the display-completeness companion: Hive-less display-only credits (`hive: null`) persist across chain links via a composite-key union (ORCID-else-normalized-name), so they are not dropped from `authors[]` on multi-link papers. Note the two tracks (hive-keyed, hive-less) never auto-merge — the bridge-author-claim attestation flow is the only Hive-less→Hive link path; fuzzy name/ORCID auto-mapping stays forbidden.
- **Name-supersession.** Add the name-supersession rule to `agents/docs/hive-schemas.md` § 1.1 alongside the ORCID supersession rule: an accredited author's attested name (`active_accreditations.researcher_name`) supersedes the broadcaster claim, silently — no discrepancy field, no audit event (unlike ORCID). Mark `authors[i].name` mandatory with the read-time fallback order (attested → broadcaster name → hive handle → orcid).
- **`api-contracts/papers.md`.** `PaperSummary.authors[]` / `PaperDetail.authors[]`: `name` mandatory; name-supersession (attested wins, silent); no new field added.

Gated additionally on `backend-author-identity-model` landing (so the rewrite describes the final author shape, not an intermediate state). Same single-rewrite rationale as the listing-surfaces gating below.

## Cross-references

- `agents/docs/tasks/pending/backend-author-identity-model.md` — author-identity-model code task whose doc edits land here.
- Parent task: `backend-multi-author-cumulative-union` (archived 2026-05-19 round-3 clean — see `tasks-archive.md`)
- Sibling task: `agents/docs/tasks/pending/backend-cumulative-union-listing-surfaces-parity.md` (architect ratification block landed 2026-05-19 commit `b5a0f92`)
- `agents/docs/ARCHITECTURE.md` lines 172-288 — § 2 Multi-Author Trust Model
- `agents/docs/api-contracts/papers.md` — PaperDetail / PaperSummary schemas
- `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — convention update
- `agents/docs/solutions/architecture-patterns/pevo-paper-version-chain-and-edit-semantics-2026-04-30.md` — rule #4 update

## UNBLOCKED 2026-05-30 (architect)

Both gating tasks have archived: `backend-cumulative-union-listing-surfaces-parity` (archived 2026-05-26, round-4 clean) and `backend-author-identity-model` (archived 2026-05-30, round-5 clean). The author shape is now final, so the § 2 rewrite can describe the cross-surface invariant + author-identity additions in their final form with no second-rewrite churn. Moving `blocked/` → `pending/` (architect's own work queue).

## IMPLEMENTED 2026-05-30 (architect)

All doc edits landed, grounded against the final implemented code (`buildCumulativeAuthorsForChain`, `resolveChainCumulativeAuthors`, `backend/src/lib/author-supersession.ts`):

1. **`ARCHITECTURE.md § 2`** — added `#### Display construction (cumulative union)` subsection (cumulative union across chain posts, first-occurrence order, two never-merging tracks (Hive-keyed + Hive-less composite-key), sub-field resolution, ORCID server-override + `orcid_claim_mismatch` audit schema (active/revoked arms + suppress-to-null), name-supersession reference, `accredited_authors` intersection, cross-surface parity via the shared helper + per-root Redis cache, per-request invariant scope for "drops forbidden by construction"). Rewrote the contradictory no-shrink / `headAuthorsCoverRoot` reject-override paragraph in "Authors mutation" to the cumulative-union construction.
2. **`api-contracts/papers.md`** — PaperSummary + PaperDetail Notes: `authors[]` cumulative-union, `authors[].name` mandatory (name-supersession + fallback chain), `accredited_authors` rebuild semantics.
3. **`hive-schemas.md § 1.1`** — added the **Name-supersession rule (read time)** block (silent, currently-accredited-only, fallback order attested→broadcaster→hive→orcid); marked read-time `name` mandatory in the `authors` field note.
4. **`pevo-object-identity-...-2026-04-28.md`** — continuation-gate predicate updated: membership set is the cumulative chain `authors[]`, not the root's; structural identity-predicate rule preserved.
5. **`pevo-paper-version-chain-...-2026-04-30.md`** rule #4 — appended the cumulative-union "monotonic by construction" paragraph.

**Adjacent-scope corrections (flag for review):** while in `pevo-paper-version-chain-...-2026-04-30.md`, corrected now-stale doc-vs-code drift in **rule #6** and **Example 4**, which described the continuation-consent gate as unimplemented ("currently unauthenticated… Until that lands", "Today resolveContinuationChain admits it"). The gate has landed (`extractAuthorizedContinuationAuthors` is live; the gate task archived), so those statements were factually wrong. Not enumerated in the original acceptance list — surfaced here for the archive-review pass.

**Acceptance crit 5 (code-comment recheck):** no production code comment cites the removed no-shrink/cover-check text (grep for `cover-check|coverRoot|no-shrink|override is rejected|superset of root` in `backend/src`+`frontend/src` returns nothing — the code was already on the cumulative-union path; only the doc lagged). `papers.ts:529`'s `§ 2` citation points at the ORCID-authoritative rule, which the rewrite now documents explicitly.

Moving `pending/` → `review/` for the archive pass.
