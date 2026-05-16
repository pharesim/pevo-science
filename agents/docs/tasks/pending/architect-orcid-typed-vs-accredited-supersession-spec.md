# ARCHITECT-ORCID-TYPED-VS-ACCREDITED-SUPERSESSION-SPEC — define the rule for reconciling typed-ORCID against on-chain accredited ORCID over time

**Owner:** Architect Agent (self-task, spec-only)
**Created:** 2026-05-16 (architect, surfaced by user during finding-#15 triage on `ui-author-input-accredited-prefill` round-2)
**Priority:** P2

## Problem

PEvO's publish/edit forms today accept three kinds of co-author entries:

1. **Co-author with no hive account at all** — name + ORCID + affiliation typed by the publishing researcher. ORCID is a free-text input.
2. **Co-author with a hive account that is NOT accredited** — hive handle entered, ORCID typed (today's behavior — the ORCID input is editable when `hive` is not in the accredited directory).
3. **Co-author with a hive account that IS accredited** — hive handle entered, ORCID auto-prefilled from the on-chain accreditation record, ORCID input locked (this is what `applyHiveChangePrefill` / `applyAccreditedPrefill` deliver).

Today's invariant: at **broadcast time**, the `pevo.authors[]` row carries whatever ORCID is currently in the row (typed-or-prefilled). The chain post is immutable from that point.

**User-clarified design rule (2026-05-16, during architect triage):**

> Authors CAN type an ORCID for co-authors that don't have a hive account, but **once that co-author is on hive, his authed ORCID supersedes the typed one if different.**

The current code/schema docs don't capture this supersession rule. Specifically:

- **Schema gap:** `agents/docs/hive-schemas.md` §1.1 documents `pevo.authors[]` as `{name, hive, orcid, affiliation}` with no provenance discriminator. A reader of a paper has no way to tell whether `authors[0].orcid` was typed-by-the-publisher or ORCID-OAuth-attested.
- **Display gap:** the paper-detail view today renders `authors[].orcid` as-is from the chain. If `authors[0].hive === 'alice'` AND alice is currently accredited with ORCID `0000-0002-AAA`, but the chain `authors[0].orcid` was typed by the publisher as `0000-0002-XXX` (because alice was not yet accredited at publish time — or because the publisher typed the wrong value), there is no rule for which one wins on display.
- **Reconciliation gap:** if alice was NOT accredited at publish time but became accredited later, the chain row's typed-ORCID stays forever (Hive posts are immutable; the publisher could edit the post, but a backfill or rewrite isn't automatic). The supersession rule says the on-chain-accredited ORCID is the authoritative identity for display.

## Goal

Specify the semantic for reconciling typed-vs-accredited ORCID at three timing points:
- **At publish/edit time** — what does the form let the user type, vs. lock?
- **At read time** — what does the paper-detail view show as the canonical ORCID for each author row?
- **At reputation-algo time** — which ORCID value drives reputation queries that key on ORCID?

## Acceptance

### 1. Define the supersession rule precisely

Document in `agents/docs/hive-schemas.md` §1.1 (the authors[] schema section) and/or `agents/docs/api-contracts/papers.md`:

- The chain-stored `pevo.authors[i].orcid` is the **as-typed-or-prefilled-at-broadcast-time** value. It is the publisher's stated claim.
- The **canonical display ORCID** for an `authors[i]` row is computed as follows at read time:
  - If `authors[i].hive` is empty (no hive account), use `authors[i].orcid` as-is. No supersession applies.
  - If `authors[i].hive` is set AND that account is currently accredited (per the on-chain accreditation custom_json), use the **accreditation-attested ORCID** from the current accreditation record. The chain-stored `authors[i].orcid` is treated as the publisher's stated claim but not authoritative.
  - If `authors[i].hive` is set AND that account is NOT currently accredited, use `authors[i].orcid` as-is.
  - If the chain-stored `authors[i].orcid` differs from the accreditation-attested ORCID for the same hive account, **show a discrepancy indicator** on the paper-detail view. (Specific UI affordance TBD — a small "i" tooltip explaining the divergence is one shape; an audit-log style "claimed ORCID: X / verified ORCID: Y" is another.)

### 2. Specify the form-time behavior (clarifies the current code)

- ORCID input is editable IFF `authors[i].hive` is empty OR the hive account is NOT in the accredited directory.
- ORCID input is disabled and prefilled IFF the hive account IS in the accredited directory.
- On accredited→non-accredited transition (user changes a co-author's hive from an accredited account to a non-accredited one), the prefilled ORCID clears (today's behavior — this is correct under the supersession rule because the now-non-accredited hive carries no accreditation-attested ORCID to supersede).
- On non-accredited→accredited transition (user changes hive to an accredited account), the prefilled ORCID overwrites the typed one if different (today's behavior in `applyHiveChangePrefill` — correct under the supersession rule).

### 3. Specify the read-time SQL query

The paper-detail / version-chain endpoint must, for each `authors[i]` row, look up the current accreditation state of `authors[i].hive`. Define the canonical SQL (or HAF view) the backend uses to resolve "currently accredited" + "ORCID attested by accreditation."

Cross-reference: the accreditation state-read learning at `agents/docs/solutions/conventions/accreditation-state-read-latest-action-wins-2026-05-15.md` is the authoritative pattern. Use `action IN ('accredit','revoke') ORDER BY block_num DESC LIMIT 1` semantics — never strict `action = 'accredit'` equality.

### 4. Specify the reputation-algo behavior

`agents/docs/reputation-algorithm.md`: queries that aggregate by ORCID (e.g., citation counts by author) should use the canonical display ORCID per the supersession rule, NOT the chain-stored typed ORCID. Document this so the SQL implementations are consistent.

### 5. Spawn implementation tasks once the spec lands

After this spec task archives, file implementation follow-ups:
- `ui-paper-detail-orcid-discrepancy-indicator` — UI task to render the discrepancy on paper-detail view when typed vs. accredited diverge.
- `backend-papers-canonical-orcid-resolution` — backend task to add the supersession lookup to the paper-detail / version-chain endpoint.
- `architect-reputation-algorithm-canonical-orcid` (or include inline) — update reputation-algorithm.md and the associated SQL.

These follow-ups are downstream; they don't need to be filed concurrently with this spec task.

## Out of scope

- **Mutating chain history.** The chain-stored `authors[i].orcid` is whatever the publisher broadcast. PEvO doesn't try to rewrite history; the supersession rule is purely about how to interpret the chain data at read time.
- **A canonical-ORCID-only on-chain field.** Adding a new `authors[i].verified_orcid` field would require schema migration and chain re-tagging. Out of scope; the supersession rule operates on the existing fields.
- **Authoring affordance for the publisher to know when a typed ORCID conflicts with a future accreditation.** Co-authors who become accredited AFTER publication are a forward-looking concern; the publisher cannot know at write time. The supersession rule's discrepancy indicator addresses this at read time, which is the right layer.

## Source

User-architect dialog 2026-05-16 during the architect's combined-findings triage for the `/ce-code-review` of `ui-author-input-accredited-prefill` round-2 (commits `ae7e853`, `820a710`, `eb1416b`).

During finding-#15 triage (a test-hardening concern on `applyAccreditedPrefill`'s no-orcid-in-record path), the user clarified: *"users shouldn't be able to type an orcid, it needs to be set via orcid auth"* → refined to *"authors can type an orcid for co-authors that don't have a hive account, but once that co-author is on hive, his authed orcid supersedes the typed one if different."*

That refinement reframes the current prefill semantics and introduces a supersession rule that doesn't exist in the schema/contract docs yet. This task captures the rule before downstream implementation tasks read it.

## Coordination

- This is an **architect-owned spec task** — no backend or UI implementation belongs in this task. Output is documentation in `agents/docs/`.
- Architect can take this directly to `tasks/review/` once drafted (per the architect-self-task creation rule). Currently filed at `tasks/pending/` because the architect's queue may include other higher-priority work; the architect can pick it up when ready.
- Once archived, the downstream implementation tasks listed in acceptance §5 should be filed by the architect.

## Cross-references

- `agents/docs/hive-schemas.md` §1.1 — `pevo.authors[]` schema (to update).
- `agents/docs/api-contracts/papers.md` — paper-detail response shape (to update).
- `agents/docs/reputation-algorithm.md` — reputation queries by author (to update).
- `agents/docs/solutions/conventions/accreditation-state-read-latest-action-wins-2026-05-15.md` — the canonical accreditation-state-read pattern.
- `ui-author-input-accredited-prefill.md` (round-2 hold) — the parent task whose triage surfaced this design point.
- `frontend/src/lib/accredited-directory.js#applyHiveChangePrefill` / `applyAccreditedPrefill` — the form-time prefill helpers; their behavior matches acceptance §2.
