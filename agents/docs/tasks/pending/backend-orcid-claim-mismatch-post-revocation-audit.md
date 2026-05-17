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

---

## Parent re-review note (2026-05-16, post-merge vitest run) — KNOWN TEST FAILURES, production code unaffected

After cherry-picking the worker commit onto main, parent ran `npx vitest run tests/routes/papers-cumulative-orcid-audit.test.ts`. Result: 3 of 4 tests fail with `expected undefined to be defined` at `findAuditEvent(warnSpy)`. The remaining test ("post-revocation match, non-firing canary") passes correctly.

**Root cause is test-mock infrastructure, not production code.** Vitest output shows the canonical-root walker emitting `event: canonical_root_walker_start_invalid, reason: cont_columns_invalid` for every test request. The walker SQL at `backend/src/routes/papers.ts:1746-1756` selects `cont_author` / `cont_permlink` columns from the start row, then bails at line 1815 when those columns aren't strings. The worker's `seedTwoLinkChain` mocked `rootRow` (lines 164-167) omits `cont_author` and `cont_permlink` fields entirely.

The mock uses `headAuthorsLookupSql` (matcher at line 128) for the walker's start lookup, which is structurally wrong: the walker's SQL selects different columns than the head-authors lookup. Result: walker rejects START → `buildCumulativeAuthorsForChain` runs with the truncated chain (root-only, no continuation) → bob/v2's forged claim never reaches the audit emission → spy captures nothing.

**Production code at `papers.ts:434-528` (the active+revoked arms) is correct** — audit fires when active and override applies; audit fires on revoked without override. The SQL helper `getAccreditationOrcidsWithStatus` correctly handles single- and multi-cycle history via the `accreditation_status` CTE.

Fix is test-only: the worker should either (a) add a separate `canonicalRootWalkerStartSql` matcher that returns a row with `cont_author='alice'`, `cont_permlink='p1'` plus the head-row identity, or (b) extend the existing matcher to handle both cases. The audit-emission assertions are correct; only the chain-reachability needs the mock fix.

Architect: hold for round-2 with the test-mock fix as the single item, or accept the production code and route the test fix to a follow-up if archive timing matters.

---

## Architect round-2 re-review (2026-05-17) — HELD PENDING FIXES

`/ce-code-review` on commits `0e648b6` (Alt 2 implementation) + `5a8f265` (tsconfig fixes) + `5572c49` (parent test-failure note) ran 10 personas (correctness + security + adversarial on opus; testing + maintainability + project-standards + performance + data-integrity + api-contract + reliability on sonnet; ce-agent-native-reviewer skipped per project CLAUDE.md).

**Production code is verified correct** by correctness + data-integrity:
- Multi-cycle LATERAL ORDER BY (ORCID-Y vs ORCID-X) traced correctly.
- JSONB extraction inherits from `accred_ranked` cleanly.
- All sibling reads (profile.ts:37, orcid.ts:1878/1904, accreditations.ts:69/133, hafsql.ts:79, wot.ts via getAccreditedSet) use the same `action IN ('accredit','revoke')` + authority filter pattern; no drift.
- Branch mutual exclusivity (active arm + revoked arm + never-accredited silent) is correct.

Five items hold; one cross-task follow-up filed separately.

### Item 1 [P2] — Test-mock infrastructure: 3 of 4 canaries vacuously fail

**Cross-corroborated:** testing × project-standards × parent's own note (5572c49)
**File:** `backend/tests/routes/papers-cumulative-orcid-audit.test.ts:164-200`

Per parent's note in `5572c49` and the testing reviewer's verification: `seedTwoLinkChain`'s `rootRow` mock omits `cont_author` / `cont_permlink` columns. The canonical-root walker SQL at `papers.ts:1746-1815` selects those columns and bails at `cont_columns_invalid` when they aren't strings. The walker SQL matches the test's `headAuthorsLookupSql` matcher first (both select `c.author, c.json_metadata` AND `parent_permlink = $3`), so walker gets the `rootRow` shape, bails, and `buildCumulativeAuthorsForChain` runs with truncated chain → audit code never reached.

Result: 3 of 4 canaries (single-cycle, multi-cycle, active spoof) fail because `findAuditEvent(warnSpy)` returns undefined. The 4th canary (post-revocation match, non-firing) passes vacuously — walker bail satisfies `expect(event).toBeUndefined()` regardless of whether the active/revoked-arm branching is correct.

The architect's acceptance §3 ("Canary: revoke alice; bob broadcasts a continuation claiming an ORCID for alice; assert audit fires") is structurally unmet. Production code is correct, but the test file currently provides only false-positive coverage.

**Fix shape** (per the parent's note and the testing reviewer's analysis): either add a separate `canonicalRootWalkerStartSql` matcher discriminating on `cont_author` presence in the SELECT clause, OR extend the existing `headAuthorsLookupSql` matcher to fork. The matcher should return a row with `cont_author='alice'`, `cont_permlink='p1'`, head-row identity, and `json_metadata` as the expected object (per parseMeta acceptance). Once the chain reaches `buildCumulativeAuthorsForChain`, the audit-emission assertions should fire as written.

### Item 2 [P2] — Branch (d) audit payload missing `accreditationStatus` + bypasses dedup

**Cross-corroborated:** adversarial × maintainability × api-contract (conf 80)
**File:** `backend/src/routes/papers.ts:417-434` (pre-existing branch from parent cumulative-union task)

The active-arm's third audit emission path — "accredited target with no on-chain ORCID + broadcaster claim present: suppress claim" (case d from parent task's rule #3) — emits `orcid_claim_mismatch` WITHOUT:
- the new `accreditationStatus: 'active'` field (architect ratification at this task line 130: "Single event `orcid_claim_mismatch` with additive `accreditationStatus: active | revoked` field is preferred over splitting into two event names. Backward-compatible (additive field)").
- the new `auditedKeys` dedup Set.

**Operator-impact:** dashboards filtering `event === 'orcid_claim_mismatch' AND accreditationStatus === 'active'` silently miss case-d events. The active-arm spoof gets dropped from operator visibility despite being categorically an active-arm spoof.

**Fix shape:** add `accreditationStatus: 'active' as const` to the case-d payload and consult `auditedKeys.has(auditKey)` before emit + `auditedKeys.add(auditKey)` after. Genuinely additive (backward-compatible). Pairs naturally with Item 4 (extract `emitOrcidClaimMismatchAudit` helper) — case d becomes a third call site of the same helper.

**Add a new canary** to `papers-cumulative-orcid-audit.test.ts` pinning case d's `accreditationStatus: 'active'` payload (accredited hive, on-chain ORCID is null, broadcaster supplies a claim) so a regression that drops the field surfaces.

### Item 3 [P2] — Extract `emitOrcidClaimMismatchAudit` helper

**Source:** maintainability M3 (conf 75)
**File:** `backend/src/routes/papers.ts:387-410, 417-434, 437-462`

Three audit emissions in `buildCumulativeAuthorsForChain` share the same payload skeleton (event, rootAuthor, rootPermlink, hive, claimedOrcid, accreditedOrcid, claimSource, message) and the same `auditedKeys` dedup-key construction. After Item 2's fix to branch (d), all three share identical dedup discipline. The arms differ only in:
- `accreditationStatus` literal (`'active'` for case b + case d, `'revoked'` for revoked arm).
- `accreditedOrcid` source.
- log message string.
- Active-arm case b also mutates `out.orcid`; revoked arm and case d do not (so the helper consolidates emission only; the override remains inline at the call site for case b).

**Fix shape:** extract `emitOrcidClaimMismatchAudit({status, accreditedOrcid, claimedOrcid, hive, rootAuthor, rootPermlink, claimSource, message}, auditedKeys)`. Call from all three sites. Surrounding decision-tree branching stays as-is.

### Item 4 [P2] — Rename `getAccreditationOrcidsWithStatus` to a more distinct name

**Source:** maintainability M2 (conf 75)
**File:** `backend/src/accreditation.ts:206` + import in `papers.ts`

`getAccreditedOrcidsByAccount` (active-only) vs `getAccreditationOrcidsWithStatus` (active + revoked, with `status` flag) — both `Map<string, …>`, colocated, imported side-by-side in `papers.ts`:

```ts
import { getAccreditedSet, getAllAccreditedAccounts, getAccreditedOrcidsByAccount, getAccreditationOrcidsWithStatus }
```

Four similarly-prefixed exports whose semantic boundaries aren't obvious from name alone. Autocompleting maintainer typing `getAccredit…` gets four plausible options; picking the wrong one is a silent semantic widening or narrowing (no type error — both `Map<string, …>` shapes).

**Fix shape:** rename the new helper to `getAllEverAccreditedOrcidsWithStatus` (or another name that signals "includes revoked" in the name itself). Touches 3 sites: the helper definition + the `papers.ts` import + the `papers.ts` callsite. The CTE name (`accreditation_status` in hafsql.ts) and the cache key (`accreditation_orcid_status`) can stay; this is purely a JS-side rename.

### Item 5 [P2] — Relocate the new helper's docstring/body to remove ambiguous ownership

**Source:** maintainability M4 (conf 75)
**File:** `backend/src/accreditation.ts:141-203` (current ordering)

The docstring at lines 142-164 documents `getAllAccreditedAccounts`. The new docstring at lines 166-203 (intended for `getAccreditationOrcidsWithStatus` / its post-rename name) was inserted BETWEEN that docstring and the `getAllAccreditedAccounts` function declaration at line 251, with the `export type AccreditationStatus = 'active' | 'revoked'` and the new helper body at lines 204-249 between them.

Reader-side effect: `getAllAccreditedAccounts`'s docstring is followed by ANOTHER docstring before any function declaration appears — ambiguous ownership on first read.

**Fix shape:** move the new function's docstring + type export + body BEFORE `getAllAccreditedAccounts`'s docstring, OR after `getAllAccreditedAccounts`'s implementation. The current sandwich layout is the maintainability bug.

### Files for round-3

- `backend/src/routes/papers.ts` (items 2, 3 — emit-helper extraction + case-d payload fix)
- `backend/src/accreditation.ts` (items 4, 5 — rename + relocate)
- `backend/tests/routes/papers-cumulative-orcid-audit.test.ts` (item 1 + new case-d canary from item 2)
- This task file (round-3 implementer signal block when moving back to review/)

### New follow-up task filed by architect (separate from this hold)

- `backend-fetch-paper-detail-haf-error-vs-not-found.md` (P1) — `fetchPaperDetailFromHaf` (and sibling enrichment/retract/cite handlers) swallow HAF-class errors into `null → 404`, structurally defeating the loud-fail intent on `getAccreditationOrcidsWithStatus`. Closed at the route layer in a separate task; this task's audit code is correct given the helper throws on outage. Filed in `tasks/pending/`.

### Dismissed at architect triage (recorded for transparency)

- **Per-paper audit amplification on revoked-author dossiers** (adversarial P3/70): architect already ratified "no preemptive gating; future volume data drives gating" (item 4, this task file line 132). Settled.
- **Pool-null cache-poisoning divergence from sibling helper** (adversarial × maintainability P3/55): exploit requires runtime config toggle which doesn't happen in production (pool=null is dev-only). Production-irrelevant.
- **6-positional-parameter `buildCumulativeAuthorsForChain` signature** (maintainability P2/75): defer until `backend-cumulative-union-listing-surfaces-parity` adds the second caller; that's the natural extraction moment. Premature now.

---

## Backend re-review signal (2026-05-17, commit SHA b2e9ef5) — round 3

All 5 round-2 hold items landed in commit `b2e9ef5`. Targeted vitest run on `tests/routes/papers-cumulative-orcid-audit.test.ts` is green (5/5, includes the new case-d canary from item 2). Typecheck + lint clean for the touched files. Full-suite run is the parent's step.

### Item 1 (test-mock walker fix) — landed

`backend/tests/routes/papers-cumulative-orcid-audit.test.ts`. Added a new `canonicalRootWalkerStartSql` matcher discriminating on the walker SQL's `AS cont_author` + `AS cont_permlink` column projections. The matcher is ordered BEFORE `headAuthorsLookupSql` in the mock chain so the walker's start probe is no longer swallowed by the head-authors matcher. Returns 0 rows for the walker probe (alice/p1 is the canonical root in every canary here, so the real SQL's `'continues' IS NOT NULL` predicate would return empty too) — walker bails via the SQL-empty-row path (debug log) instead of the data-shape `cont_columns_invalid` warn path.

Additional restructure that surfaced during canary execution: the previous `rootAuthors: [{ hive: 'alice' }, { hive: 'bob' }]` made alice self-claim in the root, which won the cumulative-union per the helper's "most-recent self-claim wins" rule and suppressed bob's later forged claim from reaching the audit branches. Switched all four canaries to `rootAuthors: [{ hive: 'bob' }]` — bob's continuation introduces alice, no self-claim, fallback rule applies, audit fires as designed.

### Item 2 (case-d audit payload + dedup) — landed

`backend/src/routes/papers.ts`. The active-arm case-d emission (accredited target with `null` on-chain ORCID + broadcaster claim present) now carries `accreditationStatus: 'active' as const` and consults/updates the same `auditedKeys` Set as cases (b) and the revoked-arm. Pairs naturally with item 3: case-d became a third call site of the new helper.

New canary added to the test file: `active spoof, case d (accredited target has no on-chain ORCID): audit fires with accreditationStatus=active, claim suppressed`. Pins `event.accreditationStatus === 'active'`, `event.accreditedOrcid === null`, `event.claimedOrcid === 'forged-orcid-by-bob'`, and `aliceEntry.orcid === null` (suppression behavior).

### Item 3 (`emitOrcidClaimMismatchAudit` helper extraction) — landed

`backend/src/routes/papers.ts`. Extracted module-level helper `emitOrcidClaimMismatchAudit({status, accreditedOrcid, claimedOrcid, hive, rootAuthor, rootPermlink, claimSource, message}, auditedKeys)`. Three call sites inside `buildCumulativeAuthorsForChain` now route through it (active-arm case-b override+audit, active-arm case-d suppress+audit, revoked-arm pass-through+audit). The helper consolidates payload skeleton + dedup-key construction + dedup-Set update + `logger.warn` emission; the surrounding decision-tree (override vs suppress vs pass-through) stays inline so the audit primitive does not couple to display-mutation policy.

### Item 4 (rename) — landed

`backend/src/accreditation.ts:234` + `backend/src/routes/papers.ts:22, 292, 967`. Renamed `getAccreditationOrcidsWithStatus` → `getAllEverAccreditedOrcidsWithStatus`. The "AllEver" prefix carries the active+revoked-union semantic at the import-site autocomplete (where `getAccreditedSet`, `getAllAccreditedAccounts`, `getAccreditedOrcidsByAccount`, and this helper line up side-by-side). Test file docstrings updated to match. CTE name (`accreditation_status` in `hafsql.ts`) and cache key (`accreditation_orcid_status`) unchanged per the hold block's "JS-side rename only" guidance.

### Item 5 (relocate helper) — landed

`backend/src/accreditation.ts`. The new helper's docstring + `AccreditationStatus` type export + function body now live AFTER `getAllAccreditedAccounts`'s implementation, eliminating the doubled-docstring ambiguity flagged in the hold block. `getAllAccreditedAccounts` once again sits directly under its own docstring.

### Acceptance check (re-verified)

- Single-cycle post-revocation canary fires `orcid_claim_mismatch` with `accreditationStatus: 'revoked'`, `accreditedOrcid: '0000-0000-0000-1234'`, `claimedOrcid: 'forged-orcid-by-bob'`. Display ORCID = forged claim (no override). [PASS]
- Multi-cycle post-revocation canary's `accreditedOrcid` is ORCID-Y (most-recent prior accredit), NOT ORCID-X. [PASS]
- Active spoof regression canary fires `orcid_claim_mismatch` with `accreditationStatus: 'active'`, server overrides to accredited ORCID. [PASS]
- Case-d active spoof canary (new in this round) fires with `accreditationStatus: 'active'`, `accreditedOrcid: null`, display suppressed to null. [PASS]
- Post-revocation match canary (no mismatch, no audit) still passes (non-vacuously now). [PASS]

---

## Architect re-review (2026-05-17, round-3 → round-4) — HELD PENDING FIXES

`/ce-code-review` on commit `b2e9ef5` ran 9 personas (correctness + security + adversarial on opus; testing + maintainability + project-standards + data-integrity + api-contract + previous-comments + learnings-researcher on sonnet; reliability + kieran-typescript + performance skipped — round-3 is mechanical hold-fix on a read-only paper-detail rendering surface; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). All 5 round-2 hold items verified clean by previous-comments + correctness + data-integrity + adversarial + testing — helper extraction is cohesive (no display-mutation leak), rename grep-clean (zero hits on old name), case-d emission carries the additive field and dedup, test-mock walker matcher discriminates correctly, doubled-docstring resolved. CTE + cache-key unchanged per spec. Security found no PII/JWT exposure; audit payload is public-on-chain only.

Two items hold on the round-3 commit's own newly-added code — both maintainability findings against the convention `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` (written the same day, from this exact class of incident).

### Items held

**1. (P1, conf 85, maintainability M1) `AccreditationStatus` type declaration stranded between the new helper's docstring and its function body.** `backend/src/accreditation.ts:237` (approximate line; verify on read).

Item-5 of the round-2 hold relocated the new helper's body to AFTER `getAllAccreditedAccounts`'s implementation, eliminating the doubled-docstring ambiguity. That fix landed correctly. But the `export type AccreditationStatus = 'active' | 'revoked'` declaration sits between the closing `*/` of `getAllEverAccreditedOrcidsWithStatus`'s 47-line docstring and the `export async function` line itself, with no blank-line separator. A reader scanning the file for the exported type finds it buried inside what visually reads as the new function's docstring block.

Fix shape (architect's pick — either is acceptable):
- (a) Move `export type AccreditationStatus = 'active' | 'revoked'` to the module's type-export zone (early in the file alongside other exports), OR
- (b) Add a blank-line separator before the type declaration so it visually disambiguates from the docstring block, OR
- (c) Move the type to immediately AFTER the function body (the type is only consumed by callers of the function, so placing it right after the implementation is also defensible).

Architect recommendation: (a) — module-level type-export zone is the cleanest. The type is part of the module's public API; treating it as a co-located implementation detail visually obscures that.

**2. (P2, conf 70, maintainability M3) Round-N hold-item markers in production code and tests.** Direct violation of `task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` AND `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` (the latter was written from this exact class of incident). Affected sites:

- `backend/src/routes/papers.ts:476` (approximate) — `// round-2 hold item 2: ...` style marker in production code. Highest-risk site (production grep target).
- `backend/tests/routes/papers-cumulative-orcid-audit.test.ts:135, 196, 400` (approximate) — `// Round-2 hold item 1:` style markers in test code. Lower-risk but still rotting once this task archives.

Fix shape: replace the round-N framings with behavioral-invariant descriptions. The matcher-ordering comment in the test file is the highest-value rewrite: replace "Round-2 hold item 1: this matcher must come BEFORE …" with "The canonical-root walker SQL shares a SELECT shape with `headAuthorsLookupSql`; the walker matcher MUST be listed first or the walker probe gets swallowed and `buildCumulativeAuthorsForChain` runs against an incomplete chain. Production code is at `papers.ts:1760`." The production-code instance at `papers.ts:476` similarly anchors on the case-d behavior, not the hold framing.

Although M3's anchor (70) is below the strict 75 confidence gate, it surfaces this round because the directly-applicable convention exists (written from prior incidents of exactly this shape) and the violation is in production code, not just tests. Both maintainability findings are post-fix issues on the commit's own newly-added code — the canonical convention-enforcing-fix self-audit gap.

### Items dismissed at architect triage

- **adversarial-cache-ttl-divergence (P3/60)** — independent 10-min cache TTLs on `accreditedAccountSet` vs `accreditationOrcidStatus` can produce a wrong audit-arm during the post-revocation window. PEvO single-instance per `project_single_instance_only.md`; bounded by 10-min self-heal; pre-existing two-cache architecture (not a round-3 regression). Filing as residual.
- **adversarial-accreditedorcids-divergence (P3/55)** — `accreditedAccountSet.has(X)=true` + `accreditedOrcidsByAccount.get(X)=undefined` (LRU evicted) forces case-d false suppression. Cache eviction is operationally rare; both caches use the same 10-min TTL so divergence requires LRU pressure that PEvO single-instance won't see. Filing as residual.
- **adversarial-helper-dedup-mutation-not-pinned-by-test (P3/70) + testing TG-1** — the helper's `auditedKeys.add(auditKey)` line is structurally unreachable from current callers (per-hive iteration via `orderedHives.map`, mutually exclusive if/else cascade). A regression dropping the add-line passes all tests. Preemptive test hardening for a refactor scenario with no current trigger — dismissed per `feedback_dismiss_preemptive_test_hardening.md`.
- **adversarial self-claim precedence not canaried (P3/75)** — the `rootAuthors` restructure from `[alice, bob]` to `[bob]` documents the self-claim-suppresses-audit precedence rule in comments but adds no positive assertion. Same dismissal rationale (preemptive); the comments + the existing 4 self-claim-relevant canaries in sibling test files cover the wayfinding.
- **maintainability M2 (P2/75) — matcher ordering self-enforcement.** The "MUST be listed BEFORE" constraint is comment-prose, not structural. But: at least 3 of 5 canaries assert `expect(event).toBeDefined()`, so a chain reorder fails those canaries loudly. Documentation guard adequate; structural guard would be premature.
- **correctness residual — `auditedKeys` docstring says "request-scoped" but is "call-scoped".** Cosmetic doc drift; below actionable bar.
- **project-standards residual — logging event name `orcid_claim_mismatch` uses underscore (sibling routes use dotted).** Pre-existing in `papers.ts` (`continuation_chain_*`, `canonical_root_walker_*`, `paper_authors_metadata_edit` all underscore); no documented PEvO convention requiring dotted form. Not a regression; cross-file consistency sweep would be its own task.
- **testing residual — case-d canary doesn't assert dedup behavior across two requests.** Preemptive per `feedback_dismiss_preemptive_test_hardening.md`.

### Suppressed below anchor 75 (surfaced for transparency)

- adversarial findings 1-4 (all P3/55-75 single-persona, dismissed as above).
- maintainability M3 (conf 70) — suppressed by anchor gate but HELD as item 2 above because the convention violation is documented and the fix shape is mechanical.
- correctness's "auditedKeys docstring" residual (conf 30).

### Files for round-4

- `backend/src/accreditation.ts` (item 1: `AccreditationStatus` type placement)
- `backend/src/routes/papers.ts` (item 2: round-N marker cleanup at the case-d emission site)
- `backend/tests/routes/papers-cumulative-orcid-audit.test.ts` (item 2: round-N marker cleanup at 3 sites)

Per root CLAUDE.md rule #8, this file moves from `tasks/review/` back to `tasks/pending/`. After landing the round-4 fixes, `git mv` back to `tasks/review/` for round-4 re-review.
