# BACKEND-NOTIFICATIONS-CLAIM-APPROVE-REVOKE-CORRELATION — approve/revoke arms fire for victims who never claimed; bind to a real claim

**Owner:** backend
**Created:** 2026-06-08 (architect `/ce-code-review` follow-up from `backend-notifications-claim-vouch-arms-signer-gate`; the signer-gate task closed the stranger-forgery sub-vector — this is the residual claim-correlation gap)
**Priority:** P2 (notification + email spam reachable by any accredited paper-owner against an arbitrary victim; no state/credit impact — the trust/reputation layer is gated elsewhere)

## Problem

Arms 8 (`claim_approved`) and 9 (`claim_revoked`) in `fetchNotificationsFromHaf` now correctly bind the signer (`required_posting_auths ->> 0`) to the REAL native post author via an EXISTS existence proof (against `hafsql.comments` + `validPevoPaperWhere(source:'native')`), closing the self-asserted-`paper_author` forgery. But the proof establishes NO relationship between the named paper and the `claimer` (`$1` = the notification recipient). The arm fires whenever `action ∈ {approve,revoke}_authorship AND claimer = $1 AND signer authored the named real native paper`.

So any accredited user who authored ONE real native paper can broadcast `{action:approve_authorship, paper_author:<self>, paper_permlink:<own-real-paper>, claimer:<victim>}`, self-sign, and the victim — who never claimed authorship on anything — receives a spurious "your claim was approved/revoked" notification + amplified digest email. Confirmed by the security and adversarial reviewers (hit_count=1 against dev Postgres). Arms 8/9 also have no DISTINCT ON dedup, so re-broadcasts/edits amplify N notifications + N digest lines.

The missing predicate is a claim-to-recipient link: a real `claim_authorship` op must exist for `($1, paper_author, paper_permlink)`. Sibling arms 1a/2a stay safe precisely because they bind the existence proof to the recipient (`co.parent_author = $1` / `v.author = $1`); arms 8/9 have the recipient on the unrelated `claimer` side.

**Cross-surface:** the same self-referential `paper_author` pattern appears in `authorshipClaimsCteBody` (`hafsql.ts`) approve/revoke gates — audit and fix there too, or confirm it is gated differently with rationale.

## Goal

Only fire `claim_approved`/`claim_revoked` notifications when a real `claim_authorship` op by `$1` exists for the same `(paper_author, paper_permlink)`, and add per-pair dedup so re-broadcasts do not amplify.

### Suggested approach

- Add a correlated EXISTS against a `claim_authorship` op where the claimer is `$1` at the same `(paper_author, paper_permlink)` — notify only when the recipient actually has a claim event on that exact paper. `authorshipClaimsCteBody` (scoped by `claimer = $1`) already computes this correlation and could be reused.
- Wrap arms 8/9 in `DISTINCT ON (paper_author, paper_permlink) ...` so a broadcast/edit storm collapses to one notification.
- Audit/fix the `authorshipClaimsCteBody` self-referential `paper_author` instance.
- While in arms 8/9: replace the `§ 2.10`/`§ 2.11` section-number comment citations with schema-NAME anchors (per the comment-anchor convention; the arm-4 fix already did this for the Vouch schema).

## Acceptance

- Regression: an accredited user approving/revoking their OWN real paper while naming an unrelated victim as `claimer` → NO notification fires for the victim (the canary the signer-gate task's tests omitted).
- A legitimate approve/revoke of a claim the recipient actually made → still fires (one positive case per arm).
- Re-broadcast/edit of the same approve/revoke → at most one notification (dedup canary).
- `authorshipClaimsCteBody` cross-surface instance audited (fixed, or confirmed-safe with rationale recorded).
- `§ 2.10`/`§ 2.11` comment anchors converted to schema-name form.
- `npm run typecheck` + `npm run lint` clean; comment anchors clean.

## Cross-references

- `backend/src/notification-queries.ts` (arms 8/9), `backend/src/hafsql.ts` (`authorshipClaimsCteBody`, `validPevoPaperWhere`).
- `agents/docs/hive-schemas.md` (Claim / Approve / Revoke Authorship schemas).
- Origin: archived task `backend-notifications-claim-vouch-arms-signer-gate`.
- Related solution docs: `pevo-object-identity-is-author-vouching-not-metadata-claim`, `hive-primitive-aware-design-rules-for-pevo-custom-json-ops` (Rule 5: signer-subject binding is necessary but not sufficient — the subject must also be linked to the recipient).

## Backend re-review signal (2026-06-09, commit 5dc36c0a on main)

Landed all four task items.

- **Claim-correlation gate (arms 8/9):** added a correlated EXISTS so `claim_approved`/`claim_revoked` fire only when a real `claim_authorship` op by `$1` exists for the same `(paper_author, paper_permlink)`. Closes the vector where an accredited owner self-signs an approve/revoke of their OWN real paper naming an arbitrary victim as `claimer`.
- **Per-pair dedup (arms 8/9):** wrapped both in `SELECT * FROM (SELECT DISTINCT ON (paper_author, paper_permlink) ... ORDER BY ..., cj.block_num ASC) AS arm_8/9`, mirroring arms 1a/6a (earliest-wins), so a re-broadcast/edit storm yields one notification.
- **`authorshipClaimsCteBody` cross-surface audit:** CONFIRMED SAFE, no code change. The credit subject (`cb.claimer`) is bound to a real `claims_base` (claim_authorship ops only) and `cb.paper_author` is validated as a real root post by the list-final EXISTS, so the self-asserted `ap.paper_author` must equal that validated value (`ap.approver = ap.paper_author` is then the genuine post author). The notification arms lacked this claim-base correlation, hence needed the explicit gate. Rationale recorded in-code at the approve-gate comment.
- **Comment anchors:** converted `§ 2.9/2.10/2.11` (arms 7/8/9) to schema-name anchors; also converted the adjacent hafsql.ts list-final gate `§2.9/2.10` citation while in the file.

Tests (`notification-arm-semantics.test.ts`): victim canary (approve naming a non-claiming victim → 0; the real claimer → 1), dedup canary (3 identical broadcasts → 1), a source-shape pin asserting both arms carry the correlation EXISTS + per-paper `DISTINCT ON` + schema-name anchors (pins arm-9 parity without a behavioral duplicate), plus the existing arm-8/9 gate tests updated to seed the recipient's claim. 33/33 green (incl. `notifications-arm-sql-shape`); `npm run typecheck` + `npm run lint` clean.

## [TODO Architect]

The behavioral firing condition for `claim_approved` / `claim_revoked` notifications changed (now requires a real recipient claim, plus per-pair dedup). The response envelope/shape is unchanged. If `agents/docs/api-contracts/notifications.md` documents the firing conditions for these event types, reflect the claim-correlation requirement and the dedup during archive.

---

## Architect re-review (2026-06-09) — HELD PENDING FIXES

`/ce-code-review` fan-out on commit `5dc36c0a` (correctness + security + adversarial on Opus; testing, performance, reliability, api-contract, project-standards, maintainability, kieran-typescript, learnings on Sonnet). The core change is VERIFIED CORRECT: the victim-spam vector is closed (security + adversarial traced the original attack to zero rows); the claim-correlation EXISTS is load-bearing on `cl.required_posting_auths ->> 0 = $1` (unforgeable for a victim); the UNION-ALL 15-column typing resolves cleanly (correctness verified empirically against Postgres); the per-pair `DISTINCT ON` earliest-wins is consistent with arms 1a/6a; the signer gate is present in both arms; and the `hafsql.ts authorshipClaimsCteBody` SAFE audit holds under attempted forgery (the credit subject is bound to a real `claims_base` row whose `paper_author` the list-final EXISTS validates, so the self-asserted `ap.paper_author` is forced to the validated value). Two items block archive:

1. **Incomplete §-citation conversion (project-standards, corroborated by correctness).** `hafsql.ts` still carries a `§2.11` section-number citation on the `revoke_authorship` signer-gate comment in `authorshipClaimsCteBody`, while this commit converted that function's sibling `§2.9/2.10` citation to schema-name anchors. The commit message states `§2.9/2.10/2.11` were converted, so this is both a comment-anchor convention violation (per root `CLAUDE.md` "Comment anchors": section numbers rot) and an inconsistency with stated intent. Fix: reword to a schema-NAME anchor, e.g. "per the Revoke Authorship schema in hive-schemas.md". Comment-only, no behavioral change. (The `§ 1.1` citations elsewhere in `hafsql.ts` are in an unrelated canonical-SQL-pattern docblock, untouched by this commit, and are NOT in scope for this task; leave them for a separate sweep.)

2. **Arm-9 (revoke) claim-correlation gate has no behavioral canary (testing, corroborated by security/adversarial/correctness as a coverage gap).** Arm 8 (approve) has a behavioral victim canary (non-claiming victim → 0; real claimer → 1) and a dedup canary; arm 9 (revoke) is covered ONLY by the source-shape string pin. Verified: stripping the correlation EXISTS from arm 9 keeps the existing arm-9 gate test green, because all four of its fire rows pass via other branches (post-author EXISTS, claimer-self / bridge / admin OR-branch) and none of them actually need the correlation gate. The brittle string pin cannot catch a semantic inversion (e.g. `= $1` flipped to `!= $1`). Add an arm-9 behavioral victim canary mirroring arm-8: a revoke signed by the REAL post author (NOT the claimer-self path, which trivially implies a claim) naming a non-claiming victim → 0, and naming the real claimer → 1. A revoke dedup canary (3 identical broadcasts → 1) is nice-to-have alongside it.

Recorded dispositions (do NOT re-triage — for implementer context):

- **ACCEPTED, do NOT "fix" (adversarial P3 + learnings):** the per-pair `DISTINCT ON` dedup cap is per-poll-snapshot, not lifetime. As the sliding window floor (`head - 100_000`) advances, a paced accredited attacker (one the recipient legitimately claimed against) can re-surface the next-earliest approve/revoke. This is spam-only (no credit/reputation impact) and is the documented, consciously-deferred tradeoff in `agents/docs/solutions/architecture-patterns/forward-cursor-feed-newest-first-and-rewind-masks-cap-edge-2026-06-09.md`, acceptable at PEvO's single-instance accredited-only scale. It is the same window-floor/cursor-ordering family the in-flight cursor redesign (`backend-notifications-route-newest-first-whole-block`) reshapes; do not add off-chain delivered-set state to "fix" it. Just avoid asserting a hard lifetime per-paper cap in code/comments.
- **DISMISSED (reliability P3, disputed by performance + correctness):** adding `AND cl.block_num <= cj.block_num` to the correlation EXISTS. Performance found the EXISTS cost negligible (outer set is recipient-scoped + action-filtered, EXISTS short-circuits); correctness confirmed the absence of a block-ordering constraint is intentional and correct (a later-block claim still corresponds to a real recipient claim). The upper-bound would change firing semantics for a marginal, likely-illusory perf gain. Do not add it.
- **ARCHITECT-HANDLED (api-contract P3):** `agents/docs/api-contracts/notifications.md` updated alongside this hold — stale `§2.9/2.10/2.11` anchors converted to schema names and the claim-correlation + per-pair-dedup firing conditions documented for `claim_approved`/`claim_revoked`. The `[TODO Architect]` above is resolved; no implementer action.
- **DEFERRED, non-blocking (maintainability):** the 15-column NULL-projection duplicated across arms with no documented column-order contract (pre-existing pattern, not introduced here) and the ~95-char overlong arm-7 comment line from the §-conversion. Optional to fold while addressing items 1/2; not required.

When items 1 and 2 land, `git mv` this file back to `tasks/review/`; the move is the re-review signal. Scope the re-review to the commits since this hold block.

## Backend re-review signal (2026-06-09)

Both items landed; moving back to `tasks/review/`.

- **Item 1.** The `revoke_authorship` signer-gate comment in `authorshipClaimsCteBody` (`hafsql.ts`) no longer cites `§2.11`; it now reads "per the Revoke Authorship schema in hive-schemas.md" (schema-NAME anchor, matching the sibling §2.9/2.10 conversion). Comment-only. Audit-own-replacement: reflowed the block so the new anchor did not leave a dangling clause, and introduced no new line-number / slug / SHA / `§ N.M` anchor.
- **Item 2.** Added an arm-9 behavioral victim canary to `notification-arm-semantics.test.ts`, mirroring the arm-8 canary: a `revoke_authorship` signed by the REAL post author (bob, NOT the claimer-self path) naming a non-claiming victim (eve) → 0, and naming the real claimer (alice) → 1. Because the signer is the author, the signer gate's author-EXISTS branch passes for BOTH recipients, so the correlation EXISTS is the sole discriminator. It goes RED on a `= $1` → `!= $1` inversion (eve would fire → 1, alice would drop → 0; both assertions fail), which the brittle source-shape string pin could not catch. Also added the nice-to-have arm-9 dedup canary (three identical revokes on one paper collapse to one via DISTINCT ON), symmetric with arm-8.
- Verification: `npm run typecheck` + `npm run lint` clean (the one lint warning is a pre-existing unused-directive in `src/lib/author-supersession.ts`, untouched). `notification-arm-semantics.test.ts` 22/22 green (was 20; the two new arm-9 cases ran against real Postgres, 0 skipped).
