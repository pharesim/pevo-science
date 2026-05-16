---
title: "ORCID on accreditation is OPTIONAL — missing-ORCID is the normal state, not an edge case, and 'authority is authoritative' rules must handle the null branch explicitly"
date: 2026-05-16
category: conventions
module: backend/src/accreditation.ts
problem_type: convention
component: authentication
severity: high
applies_when:
  - "Writing any code path that branches on `(accreditedAccountSet.has(hive), accreditedOrcidByAccount.get(hive))` — i.e., 'is this hive accredited AND what is their on-chain ORCID'"
  - "Designing a server-override or canonical-source rule where the canonical source is a nullable field on the accreditation record (today: ORCID; future: any optional accreditation-attested field — institution, name, etc.)"
  - "Reviewing a finding that gates a defense on `if (accreditedOrcid)` or any sibling truthy check on an accreditation-record field — the 'null branch' is reachable for accredited users, not just unaccredited ones"
  - "Triaging the spoof surface of a multi-author / co-author / impersonation finding — the spoof target includes accredited users who opted not to share an ORCID, not just unaccredited targets"
  - "Replicating the pattern in `getAccreditedOrcidsByAccount` for a new optional accreditation field (e.g., affiliation, name, contact)"
related_components:
  - authentication
  - database
tags:
  - orcid
  - accreditation
  - multi-author-trust
  - security
  - authority-vs-fallback
  - optional-fields
  - spoof-defense
---

# ORCID on accreditation is OPTIONAL — missing-ORCID is the normal state, not an edge case

## Context

PEvO accreditation allows users to skip providing an ORCID. The on-chain accreditation record's ORCID field is nullable by design — a researcher who chose not to share an ORCID is **accredited with no on-chain ORCID**, and that is the normal state, not a legacy artifact, not an edge case.

This is non-obvious from the codebase alone:

- `getAccreditedOrcidsByAccount()` in `backend/src/accreditation.ts:101` returns `Promise<Map<account, string | null>>`. The TypeScript signature's `| null` reads as "occasionally null," not "commonly null."
- No prior `agents/docs/solutions/` entry stated the optionality (verified at compound-write time across `conventions/`, `architecture-patterns/`, `runtime-errors/`).
- Project CLAUDE.md describes ORCID as used in attestation, but does not state it is optional.
- The default mental model for a "scientific publication platform" reviewer/implementer is "ORCID is required." That model is wrong for PEvO.

The convention was made visible during `/ce-code-review` on `backend-multi-author-cumulative-union` round-1 (architect session, 2026-05-16). A security-reviewer-surfaced finding (sec-1) was initially mis-triaged as a narrow edge case anchored on the assumption that no-on-chain-ORCID is rare. User correction: "orcid is NOT strictly required" — which reversed the finding's classification from P3-dismissible to P2-held (commit `f6ce0ea`, hold item 1 on the cumulative-union task).

## Guidance

When a defense, display rule, or server-override gates on an accreditation-record field, treat the field's `null` branch as a **first-class branch**, not a fall-through:

1. **The accredited user's CLAIM of "no value" IS the authority.** If the accreditation record's ORCID is null, the accredited user's authoritative answer to "what is your ORCID" is *no ORCID*. Do not fall back to "trust whoever speaks first" (e.g., a co-author's broadcast claim) when the authority is silent. Silent authority is still authoritative.

2. **Enumerate all four branches at any `(is_accredited, has_authority_value, has_claim)` gate.** For ORCID specifically:

   | Accredited? | On-chain ORCID present? | Broadcaster claim present? | Correct behavior |
   | --- | --- | --- | --- |
   | yes | yes | no | display the on-chain ORCID (prefill from authority) |
   | yes | yes | yes, matches authority | display the on-chain ORCID (pass-through) |
   | yes | yes | yes, differs from authority | override + audit (`orcid_claim_mismatch` with `accreditedOrcid: <value>`) |
   | yes | **no** | yes | **suppress claim + audit** (`out.orcid = null`, emit `orcid_claim_mismatch` with `accreditedOrcid: null`) |
   | yes | no | no | display nothing (consistent: authority is silent, no claim to fall back to) |
   | no | n/a | yes | pass claim through (broadcaster attribution; not authority's domain) |
   | no | n/a | no | display nothing |

   The fourth row is the easily-missed branch. Any gate that does `if (accreditedOrcid) { ... override path ... }` and lets execution fall out the bottom for the null case is silently choosing "trust the broadcaster" — which is wrong when the target is accredited.

3. **The pattern generalizes beyond ORCID.** Any "authority X is authoritative when present" rule whose authority source can be null must specify the null-handling branch explicitly at the gate. This is the same shape as the `config.hiveAnonAccount || ''` "Hive prohibits empty author names" comment pattern at `backend/src/routes/reviews.ts:110` — making the implicit-data-shape explicit at the gate so a future reader can audit the safety. Both are cases where the value-set's "uncommon" case (null/empty) needs explicit handling to avoid an attacker-exploitable silent default.

4. **The same applies to future optional accreditation fields.** If accreditation grows to attest institution, name, contact, or any other field — and that field is optional — the same four-branch enumeration applies. Do not assume the field is universally present just because it usually is in the test corpus.

## Why This Matters

The spoof surface created by treating no-on-chain-ORCID as "rare" rather than "normal" is **broad, not narrow**:

- Every accredited user who exercised the optional-ORCID path is a spoof target.
- A vouched co-author (or, post-co-author-trust-model, any account in the chain's cumulative author set) can broadcast `pevo.authors=[{hive:'alice', orcid:'fake-orcid'}]` for accredited alice (who shared no ORCID), and the forged value surfaces in the API response with no audit event under a naive `if (accreditedOrcid)` gate.
- The audit blind spot is silent — operators have no signal that the spoof is happening at all.

The fix is small (a few lines per gate), but the gap-detection failure mode is structural: a reviewer or implementer working from the default "ORCID is universally present" mental model will repeatedly draft, review, and ship code that silently trusts the broadcaster when the authority is silent. Documenting this once at the convention level closes the gap-class — future PRs touching ORCID can be reviewed against the four-branch enumeration above.

## When to Apply

- Any new code path in `backend/src/` that calls `getAccreditedOrcidsByAccount()` or reads `active_accreditations.orcid` directly.
- Any display surface returning `authors[].orcid` (paper detail, paper summary, profile, search results, reputation).
- Any spoof-defense / authority-override / audit-event rule that's structurally "if the authority says X, do Y."
- Any future migration that adds optional fields to accreditation (institution, name, contact) — the same four-branch enumeration generalizes.
- Reviewing any `/ce-code-review` finding scoped to "narrow edge case for users with no ORCID" — re-classify as broad spoof surface and re-triage.

## Examples

### Before (silent spoof bypass)

```ts
// backend/src/routes/papers.ts (buildCumulativeAuthorsForChain, ORCID override block)
const accreditedOrcid = accreditedOrcidsByAccount.get(hive);
const claimedOrcid = winning.get(hive)!.entry.orcid;

if (accreditedAccountSet.has(hive)) {
  if (accreditedOrcid) {
    // ✅ Path A: accredited + on-chain ORCID exists
    if (claimedOrcid && claimedOrcid !== accreditedOrcid) {
      logger.warn({ event: 'orcid_claim_mismatch', hive, claimedOrcid, accreditedOrcid, claimSource }, '...');
      out.orcid = accreditedOrcid;  // override
    } else if (!claimedOrcid) {
      out.orcid = accreditedOrcid;  // prefill
    }
    // else: claim matches authority, pass through
  }
  // ❌ Silent path: accredited + no on-chain ORCID + claim present
  //    `out.orcid` stays whatever the broadcaster claimed.
  //    `claimedOrcid` (e.g., 'fake-orcid' broadcast by a vouched co-author) surfaces unchanged.
  //    No audit event fires.
}
```

### After (explicit null-branch handling)

```ts
const accreditedOrcid = accreditedOrcidsByAccount.get(hive);
const claimedOrcid = winning.get(hive)!.entry.orcid;

if (accreditedAccountSet.has(hive)) {
  if (accreditedOrcid) {
    // Path A: accredited + on-chain ORCID exists
    if (claimedOrcid && claimedOrcid !== accreditedOrcid) {
      logger.warn({ event: 'orcid_claim_mismatch', hive, claimedOrcid, accreditedOrcid, claimSource }, '...');
      out.orcid = accreditedOrcid;
    } else if (!claimedOrcid) {
      out.orcid = accreditedOrcid;
    }
  } else if (claimedOrcid) {
    // Path B: accredited + NO on-chain ORCID + broadcaster claim present.
    // The accredited user's silence IS their authoritative answer (they opted not to share).
    // Suppress the broadcaster's claim and emit an audit event so the spoof attempt
    // is operator-visible.
    logger.warn(
      { event: 'orcid_claim_mismatch', hive, claimedOrcid, accreditedOrcid: null, claimSource },
      'broadcaster-claimed ORCID for an accredited hive with no on-chain ORCID; suppressing',
    );
    out.orcid = null;
  }
  // Path C: accredited + no on-chain ORCID + no claim — out.orcid stays null. Consistent.
}
// Non-accredited path: broadcaster attribution; out.orcid keeps the claim unchanged.
```

### Sibling pattern (already-explicit null handling)

```ts
// backend/src/routes/reviews.ts (single-doc accreditation gate)
const params = [author, permlink, config.hiveAnonAccount || ''];
// `config.hiveAnonAccount || ''` is safe because Hive consensus prohibits empty
// author names — `c.author = ''` never matches. The OR-arm becomes a no-op when
// HIVE_ANON_ACCOUNT is unset, instead of silently widening the gate.
```

The reviews.ts comment is the canonical shape: name the unusual data-state explicitly, document why it's safe (or what the explicit handling does), and gate the behavior at the predicate site rather than relying on a silent default further down the call stack.

## Related

- `agents/docs/tasks/pending/backend-multi-author-cumulative-union.md` (round-2 hold item 1) — the held finding that surfaced this convention. Implementer fix lands the four-branch enumeration at `papers.ts:319-347`.
- `agents/docs/solutions/conventions/accreditation-state-read-latest-action-wins-2026-05-15.md` — sibling convention on accreditation-state HAF reads. Both conventions share the same shape: "the obvious read of the data is wrong; the explicit, less-obvious read is required for correctness."
- `backend/src/accreditation.ts:101-130` — `getAccreditedOrcidsByAccount` returns `Map<account, string | null>`. The `| null` is the structural signal that this convention applies.
- `backend/src/routes/reviews.ts:110` — the sibling explicit-null-handling pattern (`config.hiveAnonAccount || ''`).
