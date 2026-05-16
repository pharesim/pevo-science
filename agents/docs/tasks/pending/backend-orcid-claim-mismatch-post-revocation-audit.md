# BACKEND-ORCID-CLAIM-MISMATCH-POST-REVOCATION-AUDIT — preserve audit visibility after accreditation revocation

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, follow-up to `backend-multi-author-cumulative-union.md` round-1 review)
**Priority:** P2

## Problem

`backend-multi-author-cumulative-union` (commit b22ce5d) added the `orcid_claim_mismatch` audit event (rule #3 of acceptance) — fired when a broadcaster claims an ORCID for an accredited hive that differs from the hive's on-chain accreditation ORCID. The audit is the operator's signal that someone is forging ORCIDs.

Round-1 adversarial review (adv-005 P2/80) surfaced a workflow gap: **operator response to the audit is typically to revoke the bad actor's accreditation.** Once revoked, the bad actor drops out of `active_accreditations` → drops out of `getAccreditedOrcidsByAccount` → subsequent forged-ORCID broadcasts by the same actor no longer trigger the audit (the rule #3 gate `if (accreditedOrcid)` fails because the actor's accreditation lookup returns nothing).

Compounded by caches: 10-min ORCID cache + 30-min paper-detail cache means the audit blind spot extends well past the revocation moment. Operators want visibility *during* the post-revocation triage window (inspecting what else the bad actor broadcast, identifying related accounts) — exactly when the current code goes silent.

## Goal

Preserve audit-event visibility on forged-ORCID broadcasts by previously-but-no-longer accredited actors, so post-revocation operator triage retains the audit signal.

## Design alternatives

Implementer picks and surfaces for architect review:

1. **Audit on all non-self ORCID claims.** Fire `orcid_claim_mismatch` (or a sibling event) whenever a broadcaster claims an ORCID for a hive that isn't themselves, regardless of accreditation status. Broader signal, more audit volume; operators get post-revocation visibility for free.

2. **Audit all targets historically accredited.** Extend `getAccreditedOrcidsByAccount` (or a sibling helper) to include revoked-but-once-accredited hives, with a flag indicating revocation status. Audit event payload includes the flag so operators can distinguish active-spoof from historical-residual.

3. **Separate "watchlist" mechanism.** After a revocation, the bad actor's account ID enters a server-side watchlist. Any broadcaster claiming an ORCID for any watchlisted hive triggers an `orcid_watchlist_claim` audit event with the watchlist context. More targeted; needs a watchlist store.

## Acceptance

- After a bad actor's accreditation is revoked, subsequent forged-ORCID broadcasts by that actor (or about that actor) still trigger an audit event.
- The audit event payload distinguishes "active accreditation spoof" from "post-revocation residual" so operators can prioritize.
- Canary: revoke alice; bob broadcasts a continuation claiming an ORCID for alice; assert audit fires.

## Out of scope

- The active-accreditation spoof path — already covered by cumulative-union's `orcid_claim_mismatch` event.
- The "accredited but no on-chain ORCID" branch — held as a separate item on `backend-multi-author-cumulative-union` round-2.

## Source

- `backend-multi-author-cumulative-union` round-1 `/ce-code-review` adversarial adv-005 (P2/80).
- User triage 2026-05-16 elected separate-task filing because the closure is design-heavy (needs policy decision on broadening audit scope vs introducing a watchlist mechanism) and operator-workflow-specific.

## Cross-references

- `agents/docs/tasks/pending/backend-multi-author-cumulative-union.md` — sibling task; the audit primitive lives there.
- `backend/src/routes/papers.ts:319-347` — ORCID override block emitting the current audit event.
- `backend/src/accreditation.ts:101-130` — `getAccreditedOrcidsByAccount`, the lookup that determines audit-event eligibility.
