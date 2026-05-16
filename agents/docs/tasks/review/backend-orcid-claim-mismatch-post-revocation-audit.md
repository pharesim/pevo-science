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

---

## Backend design proposal (2026-05-16) — awaiting architect ratification

### Recommendation: Alternative 2 — extend accreditation lookup to include revoked-but-once-accredited hives

### Why Alternative 2 over Alternatives 1 and 3

**Alternative 1 (audit all non-self ORCID claims, regardless of accreditation status):**
- Largest signal, lowest precision. Legitimate "I'm co-authoring with researcher X who hasn't signed up to PEvO yet, but their ORCID is Y" cases (especially common pre-accreditation or in bridge papers) would fire the audit at every continuation broadcast.
- Drowns the spoof signal in noise. Operator burden grows linearly with normal multi-author publishing.
- No comparison target: the audit's value is "the broadcaster's claim disagrees with PEvO's attestation". Without an attestation, the audit becomes "the broadcaster's claim disagrees with… nothing", which is just an inventory of unattested claims.

**Alternative 3 (separate watchlist mechanism):**
- Adds new persistent state (a watchlist store).
- Requires operator UX to manage the watchlist (add on revocation, expire when?).
- Arguably the same signal as Alternative 2 with more moving parts: a revoked account IS effectively on the watchlist, but the source of truth is already on-chain (`revoke` action in `custom_json`).
- Conflicts with PEvO's "chain is SSoT" principle — a server-side watchlist becomes an authoritative source separate from the chain.

**Alternative 2 (recommended):** Preserves the audit's precision premise (compare against PEvO's last-known-attested ORCID for the target) and extends the time window past revocation. The on-chain `accred_ranked` CTE already retains revoked-account history; we just need to surface it.

### Shape

1. **Extend `accreditation.ts` with a sibling lookup:**
   ```ts
   export async function getAccreditationOrcidsWithStatus():
     Promise<Map<string, { orcid: string|null, status: 'active'|'revoked' }>>;
   ```
   For each account that has ever been accredited:
   - If the most-recent action is `accredit`, `status: 'active'` and `orcid` from that event.
   - If the most-recent action is `revoke`, `status: 'revoked'` and `orcid` from the most-recent prior `accredit` event for that account.
2. **SQL implementation:** New sibling CTE `accreditation_status` derived from `accred_ranked` (which already tracks both `accredit` and `revoke` rows). The CTE picks `rn = 1` for status + uses a `LATERAL` lookup against `accred_ranked` for the most-recent prior `accredit` row when action='revoke'. The existing `active_accreditations` CTE and `getAccreditedOrcidsByAccount` stay unchanged — non-disruptive for all current callsites.
3. **Audit gate refactor at papers.ts:319-347:** Replace `accreditedOrcids.get(hive)` (active-only) with `accreditationOrcidStatus.get(hive)` (active + revoked). The audit event payload gains a `accreditationStatus: 'active'|'revoked'` field. Operators can filter post-revocation residual from active spoof.
4. **Server-override behavior split:** The current "accredited ORCID is authoritative" server-override applies ONLY to active accreditations. For revoked accreditations, the audit fires but the server does NOT override — a revoked account no longer has authoritative ORCID standing, so the broadcaster's claim passes through (with audit). This keeps revocation a meaningful state change without auditing away the broadcaster's actual claim shape.

### Acceptance impact

Original acceptance line: "After a bad actor's accreditation is revoked, subsequent forged-ORCID broadcasts by that actor (or about that actor) still trigger an audit event."

Met by Alternative 2: the `accreditationOrcidStatus` map includes `{orcid: <last attested>, status: 'revoked'}` for revoked actors, so the audit gate at papers.ts:319-347 still fires, with `accreditationStatus: 'revoked'` in the payload for triage.

### Files anticipated

- `backend/src/hafsql.ts` — add `accreditationStatusCteBody()` deriving from `accred_ranked`.
- `backend/src/accreditation.ts` — add `getAccreditationOrcidsWithStatus()`. Cached 10 min, throw-on-error parity with existing helpers. Optional: refactor `getAccreditedOrcidsByAccount` to derive from the new helper (filter to `status === 'active'`), reducing duplicate CTE work — but only if architect is OK with the refactor footprint.
- `backend/src/routes/papers.ts:289-455` — `buildCumulativeAuthorsForChain` consumes the new map; audit emission carries `accreditationStatus` field. Server-override only when `status === 'active'`.
- `backend/tests/routes/papers-cumulative-orcid-audit.test.ts` (new or extend existing) — canary: revoke `alice`; `bob` broadcasts a continuation naming alice with a forged ORCID; assert audit event fires with `accreditationStatus: 'revoked'` and `accreditedOrcid: <alice's-last-attested>`.

### Cross-task synergy

The shared chain-resolver helper from `backend-cumulative-union-listing-surfaces-parity` Option 4 carries chain-wide ORCID enumeration. Once that ships, the audit fires per chain author across listing/profile/search surfaces (not just detail). Operator-volume implication: audit may fire many times per request once listing extends cumulative-union semantics. Dedupe by `(rootAuthor, rootPermlink, hive)` is the natural mitigation; operators already filter by `event: orcid_claim_mismatch`.

### Open items needing architect input

1. Confirm Alternative 2 is the right shape.
2. Confirm the server-override-vs-pass-through behavior split for revoked accreditations (server overrides ONLY for active, audit fires for both).
3. Confirm the new `accreditationStatus: 'active'|'revoked'` field on the audit event is acceptable for log schemas / downstream consumers.
4. Confirm the audit-volume implication of listing-surface cumulative-union extension (item above) is acceptable; if not, gate audit emission to detail-surface only.

### Status

This task is moved to `review/` for architect ratification. No code changes have been made. Architect ratification preferred to land coherently with `backend-cumulative-union-listing-surfaces-parity` and `backend-canonical-root-walker-cumulative-aware`.

[TODO Architect] Ratify Alternative 2 and clarify items 1-4 above.

---

## Architect ratification (2026-05-16)

**Decision:** Alternative 2 is ratified. Backend may proceed to implementation.

### Decisions on open items

1. **Alt 2 shape ratified.** Alt 1 (audit all non-self claims) rejected for noise-vs-precision: legitimate "co-authoring with a not-yet-registered researcher" cases would all fire audit, drowning the spoof signal. Alt 3 (server-side watchlist) rejected for violating PEvO's chain-is-SSoT principle — a server-side watchlist that's not derived from chain state would be a separate authoritative source alongside the on-chain `accredit`/`revoke` history that already encodes the same information. Alt 2 preserves the audit's precision premise (compare against PEvO's last-attested ORCID for the target) and extends the time window past revocation without adding new authoritative state.

   **Additive concern (not a blocker; backend addresses during implementation):** the LATERAL "most-recent prior `accredit` before current `revoke`" lookup must handle multi-cycle accredit/revoke/re-accredit/revoke history (e.g., alice accredited with ORCID-X → revoked → re-accredited with ORCID-Y → revoked again; the lookup MUST return ORCID-Y, not ORCID-X). Add a SQL test case for this multi-cycle shape — the canary at acceptance §3 (revoke alice; bob broadcasts forged ORCID for alice) only covers the single-cycle path.

2. **Server-override behavior split ratified.** Active accreditation → server overrides (PEvO has authoritative ORCID for the hive). Revoked accreditation → pass-through with audit (PEvO no longer claims authority; broadcaster's claim is what's broadcast). This makes revocation a meaningful state change without auditing away the broadcaster's actual claim shape. The audit captures the discrepancy for operator follow-up (typical next step: investigate the broadcaster, file revocation against THEM).

3. **Audit payload schema ratified.** Single event `orcid_claim_mismatch` with additive `accreditationStatus: 'active' | 'revoked'` field is preferred over splitting into two event names. Backward-compatible (additive field); operators filter by status via the existing event channel without learning a new event name.

4. **Listing-surface audit volume mitigation ratified with explicit fallback.** Dedup by `(rootAuthor, rootPermlink, hive)` is the right initial approach — bounds volume to per-paper-per-hive, which is reasonable. If volume becomes problematic in practice once `backend-cumulative-union-listing-surfaces-parity` extends cumulative-union to listing surfaces, fallback is to gate audit emission to detail-surface only. Don't preemptively gate — let real volume data drive the decision.

### Declined

- The optional `getAccreditedOrcidsByAccount` refactor (derive from the new helper, filter to `status === 'active'`) is **declined for this task** per YAGNI. The duplicate CTE work is real but trivial. If a future task touches both helpers, the refactor can fold in then; doing it now bloats the scope of this task without a concrete pay-off.

### Cross-task synergy carried forward (not addressed here)

- `backend-cumulative-union-listing-surfaces-parity` — when that task lands, item 4's audit-volume question becomes live. Dedup helper should be in place by then.
- `backend-canonical-root-walker-cumulative-aware` — shares the chain-resolver helper space; coordinate via implementation review at sibling-merge time.

### Move

This file moves from `tasks/review/` back to `tasks/pending/` so the backend implementer sees it at startup per root CLAUDE.md rule #8. After landing, `git mv` to `tasks/review/` for architect re-review.

---

## Backend implementer signal (2026-05-16, round-1)

Alt 2 (architect-ratified) implemented per the ratification block: extend the accreditation lookup to include revoked-but-once-accredited hives with a status flag; audit event payload gains an `accreditationStatus: 'active' | 'revoked'` distinguisher; server-override applies only on `active`, `revoked` passes the broadcaster's claim through with the audit emitting for triage visibility.

**Files changed:**

- `backend/src/hafsql.ts` — added `accreditationStatusCteBody(startIdx = 1)`. Derives a per-account status row from `accred_ranked` (materialized by the existing `activeAccreditationsCteBody`). For each account: `status = 'active'` when the most-recent action is `accredit`, else `'revoked'`; `orcid` for active rows = the most-recent `accredit`'s ORCID, for revoked rows = the most-recent *prior* `accredit`'s ORCID via a LATERAL lookup. Empty-params CTE; `nextIdx` passes through.
- `backend/src/accreditation.ts` — added `AccreditationStatus` type + `getAccreditationOrcidsWithStatus()`. Cached 10 min (parity with `getAccreditedOrcidsByAccount`), throw-on-error parity (loud-fail so audit visibility doesn't degrade silently on HAF outage). Did NOT refactor `getAccreditedOrcidsByAccount` (architect's YAGNI dismissal of the optional refactor).
- `backend/src/routes/papers.ts` — wired the new helper into the paper-detail parallel fetch block (alongside `getAccreditedOrcidsByAccount`); extended `buildCumulativeAuthorsForChain` signature with a sixth `accreditationOrcidStatus` parameter; split the ORCID override block into two arms (active-arm preserves existing rule #3 behavior with `accreditationStatus: 'active'`; revoked-arm passes the claim through but emits the audit with `accreditationStatus: 'revoked'`); added request-scoped audit dedup keyed by `(rootAuthor, rootPermlink, hive)`.
- `backend/tests/routes/papers-cumulative-orcid-audit.test.ts` — new file. Four canaries (see Test coverage list below).

**Multi-cycle SQL shape (the LATERAL):**

```sql
accreditation_status AS (
  SELECT
    ar.account,
    CASE WHEN ar.action = 'accredit' THEN 'active' ELSE 'revoked' END AS status,
    CASE
      WHEN ar.action = 'accredit' THEN ar.orcid
      ELSE (
        SELECT prior.orcid FROM accred_ranked prior
        WHERE prior.account = ar.account
          AND prior.action = 'accredit'
        ORDER BY prior.rn ASC
        LIMIT 1
      )
    END AS orcid
  FROM accred_ranked ar
  WHERE ar.rn = 1
)
```

Multi-cycle correctness (accredit ORCID-X → revoke → re-accredit ORCID-Y → revoke): `accred_ranked` is partitioned by `account` and ordered by `block_num DESC`, so `rn = 1` is the most-recent event (the second revoke), `rn = 2` is the second-to-most-recent (the second accredit with ORCID-Y), `rn = 3` is the first revoke, `rn = 4` is the first accredit with ORCID-X. The subselect filters to `action = 'accredit'` and orders by `rn ASC LIMIT 1`, so it picks `rn = 2` (the ORCID-Y accredit) — NOT ORCID-X. The docstring on `accreditationStatusCteBody` walks through this; the multi-cycle test canary pins the JS-side contract.

**Dedup approach:**

Request-scoped `auditedKeys: Set<string>` initialized at function entry in `buildCumulativeAuthorsForChain`. Key shape: `${rootAuthor}/${rootPermlink}/${hive}`. Both audit-emission arms (active + revoked) consult and update the same Set. Per architect's "right initial approach" decision — no preemptive gating; future volume data drives any further rate-limiting. The Set is GC'd with the function call (no cross-request leakage).

**Server-override split:**

- `accreditedAccounts.has(hive)` (active arm) → existing rule #3 behavior unchanged. On mismatch: audit with `accreditationStatus: 'active'`, override display ORCID to the accredited value. On prefill: override to accredited (no audit). On match: pass through (no audit).
- `accreditationOrcidStatus.get(hive)?.status === 'revoked'` (revoked arm, only reached when NOT in `accreditedAccounts`) → broadcaster's claim passes through unchanged. On mismatch (forged claim vs last-attested ORCID, both non-null): audit with `accreditationStatus: 'revoked'`. Other missing/match cases are silent.
- Never-accredited hives fall through both arms silently (carol-style — no signal to emit).

**Test coverage:**

`backend/tests/routes/papers-cumulative-orcid-audit.test.ts` (new file, mocked-pool carve-out per clauses (a)/(b)/(c) documented in the file header):

1. **Single-cycle post-revocation canary** (acceptance §3): alice revoked, bob's continuation forges alice's ORCID. Asserts: audit fires with `accreditationStatus: 'revoked'`, `accreditedOrcid: '0000-0000-0000-1234'` (last-attested), `claimedOrcid: 'forged-orcid-by-bob'`, `claimSource: 'bob/v2'`; display alice's ORCID = the forged claim (no server override).
2. **Multi-cycle post-revocation canary** (architect's additive concern): alice's history is accredit ORCID-X → revoke → re-accredit ORCID-Y → revoke. Asserts: audit's `accreditedOrcid` is ORCID-Y (the most-recent prior accredit), explicitly NOT ORCID-X.
3. **Active spoof regression**: alice currently accredited with a known ORCID; bob forges. Asserts: audit fires with `accreditationStatus: 'active'`, server overrides display ORCID to the accredited value. Pins the parent task's rule #3 behavior.
4. **Post-revocation match (non-firing)**: bob's claim equals alice's last-attested ORCID. Asserts: no audit fires.

[TODO Architect] Audit event schema documentation — the `accreditationStatus` field is a new additive field on the `orcid_claim_mismatch` event payload. If `agents/docs/ARCHITECTURE.md` enumerates audit event payloads (it currently does not have a dedicated audit-event-schema section), the new field would be a natural addition. Suggest the architect decide whether to document the field there or in an inline doc-comment on the audit emission site (the latter is what the implementation already does). The `accreditationStatusCteBody` docstring covers the SQL-side multi-cycle invariant. No `ARCHITECTURE.md` updates were made under this task to respect the agent-zone boundary.
