# BACKEND-ACCREDITATION-STATE-READ-TIEBREAKER-SWEEP — same-block tie-breaker on the remaining accreditation-state reads + single-source the ranking so the canary can reach every site

**Owner:** backend
**Created:** 2026-06-09 (architect `/ce-code-review` follow-up from the `window-cte-deterministic-tiebreaker` re-review; that task's enumerated 10 sites + held accreditation sites landed clean and archived, but the review's semantic sweep found more accreditation-state-read siblings of the exact same shape, plus a canary-reachability gap)
**Priority:** P2 (same-block accredit/revoke determinism on the ORCID duplicate-bind / binding-live guard and the profile-metadata read; no value/credit impact, but `orcid.ts`'s binding-live re-check is security-adjacent — it decides whether an ORCID can rebind or an account masquerades)

## Problem

The `window-cte-deterministic-tiebreaker` work made every *enumerated* latest-wins SQL site deterministic by appending the monotonic HAF op id (`, cj.id DESC` / `op_id DESC`) as the same-block secondary key, and its held re-review added `getAccreditedSet` and the accreditations-route queries. But a semantic grep (`grep -rn "block_num DESC" backend/src`) surfaces more accreditation-state reads using the **identical** "latest accredit/revoke wins" shape — `... action IN ('accredit','revoke') ... ORDER BY cj.block_num DESC LIMIT 1` with the `required_posting_auths ?| accreditationAuthorities` authority filter — that still lack the tie-breaker. These are exact semantic siblings of `fetchAccreditationStatusFromHaf` (`routes/accreditations.ts`), which already carries `, cj.id DESC`.

Missed sites (verified):

1. **`routes/orcid.ts` — `findAccreditedAccountWithOrcid`, latest-accredit-by-ORCID read.** `... action = 'accredit' AND orcid = $1 ... ORDER BY cj.block_num DESC LIMIT 1`. Selects which account currently holds a given ORCID (the duplicate-bind guard).
2. **`routes/orcid.ts` — `findAccreditedAccountWithOrcid`, binding-live re-check.** `... action IN ('accredit','revoke') AND account = $1 ... ORDER BY cj.block_num DESC LIMIT 1`. A same-block accredit+revoke for the account flips whether the binding is reported live — the security-adjacent one.
3. **`routes/orcid.ts` — `getExistingAccreditation`.** `... action IN ('accredit','revoke') AND account = $1 ... ORDER BY cj.block_num DESC LIMIT 1`.
4. **`routes/profile.ts` — profile-metadata accreditation read (`getExistingAccreditation` equivalent).** Same shape; this one **already projects `cj.id AS event_id`**, and its own comment says it "mirrors the same filter in accreditations.ts and orcid.ts."

Separately, the canary cannot guard the sites that DO carry the tie-breaker. `getAccreditedSet` (`accreditation.ts`) and the two `routes/accreditations.ts` queries build their ranking SQL **inline** (not via an exported fragment), so the `window-cte-deterministic-tiebreaker.test.ts` shape canary cannot reach them — a future edit dropping `, cj.id DESC` from any of these inlined sites passes the whole suite (the live HAF corpus is unlikely to contain a same-block accredit/revoke pair for a test account). The duplication across `getAccreditedSet` / `activeAccreditationsCteBody` / the accreditations route / the orcid+profile reads is precisely what spawned the missed sites in the first place.

## Goal

Make every accreditation-state "latest accredit/revoke wins" read deterministic on same-block ties, and single-source the ranking shape so the shape canary guards every site against tie-breaker removal.

### Suggested approach

1. **Append the tie-breaker** at the four missed sites: `... ORDER BY cj.block_num DESC, cj.id DESC ...` (LIMIT 1 unchanged). `cj.id` needs no projection change for a LIMIT-1 read; `profile.ts` already projects it. Add the convention-path anchor comment used at the sibling sites (cite the Hive-primitive-aware design-rules convention doc, Rule 2 — `(block_num, id)` ordering; the deployed HAF mirror views omit `trx_in_block`).
2. **Single-source the ranking so the canary reaches every site.** Extract the accreditation "latest accredit/revoke wins" ordering (the `accred_ranked` ROW_NUMBER `ORDER BY` and/or the LIMIT-1 status shape) into a shared inspectable fragment (mirroring how `activeAccreditationsCteBody` / `activeVouchesCteBody` are exported and asserted), so `getAccreditedSet`, the accreditations route, and the orcid/profile reads all compose the same fragment. Then extend the shape canary to assert the tie-breaker at each. If a full fragment extraction changes the hot-path query plan for `getAccreditedSet` (the reason that site was append-not-refactor in the prior task), extracting just the `ORDER BY` clause constant is an acceptable narrower form — the goal is canary-reachability, not a CTE rewrite.
3. **Fix the now-misleading in-test coverage note** in `window-cte-deterministic-tiebreaker.test.ts`: it currently acknowledges only the three reputation union CTEs as canary-unreachable, but `getAccreditedSet` + the two accreditations-route inlined sites are equally unreachable. Either make them reachable (per step 2) and update the note, or extend the note to name them. Separately, narrow the note's claim that the reputation union CTEs are "covered end-to-end by the real-HAF reputation-lifecycle suite": that suite asserts run-to-run idempotency on the live corpus and does not seed a same-block native-vote + revote collision, so the cross-arm `op_id` tie-break branch never actually fires — state it as "the lifecycle suite confirms SQL stability on the live corpus; a same-block native-vote/revote collision is not seeded (impractical on a live chain)."

## Acceptance

- The four missed sites carry `ORDER BY cj.block_num DESC, cj.id DESC` with a convention-path anchor comment.
- The shape canary reaches `getAccreditedSet` and both `routes/accreditations.ts` sites (via the shared fragment) and asserts the tie-breaker at each; a dropped `, cj.id DESC` at any reachable site turns the canary red.
- The `window-cte-deterministic-tiebreaker.test.ts` in-test note is accurate (no site silently omitted; the reputation-CTE coverage claim narrowed to what the lifecycle suite actually proves).
- A behavioral regression for the `orcid.ts` binding-live re-check on a same-block accredit+revoke (deterministic resolution to the latest op) — or a recorded rationale if a synthetic same-block fixture is impractical for that route and the shape canary plus the existing real-path test are deemed sufficient.
- Comment anchors clean: convention-path citation only; no task slug, round number, line number, SHA, or § citation in code/test comments (mind `convention-enforcing-fix-must-audit-its-own-new-code` for any reworded comment).
- `npm run typecheck` + `npm run lint` clean.

## Cross-references

- `backend/src/routes/orcid.ts` (`findAccreditedAccountWithOrcid` ×2 reads, `getExistingAccreditation`), `backend/src/routes/profile.ts` (profile-metadata accreditation read).
- `backend/src/accreditation.ts` (`getAccreditedSet` inlined ROW_NUMBER), `backend/src/routes/accreditations.ts` (`fetchAccreditationsFromHaf`, `fetchAccreditationStatusFromHaf`), `backend/src/hafsql.ts` (`activeAccreditationsCteBody` — the exported-fragment reference shape).
- `backend/tests/window-cte-deterministic-tiebreaker.test.ts` (the shape canary + the in-test coverage note).
- `agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md` (Rule 2 — `(block_num, id)` ordering; the views omit `trx_in_block`).
- `agents/docs/solutions/conventions/accreditation-state-read-latest-action-wins-2026-05-15.md` (enumerates `orcid.ts` / `profile.ts` as members of this accreditation-state-read family).
- `agents/docs/solutions/conventions/convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21.md` (the partial-fix-drift root cause: audit by semantic pattern, not syntactic form).

## Notes

- Already-accepted residuals from the prior task — do NOT pull these in: `wot.ts` `update_params` read, `reputation.ts` `update_weights` read (admin-singular, practically never tied on the single-instance posture), `lib/idempotency.ts` (sha256-keyed; a same-block multi-row collision implies a hash collision), `routes/papers.ts` `batchResolveVotes` revote dedup (display-surface, reconciled in JS). They are accepted-as-is per that task's triage; this sweep is scoped to the accreditation-state-read family only.
