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
