# ARCHITECT-RECONCILE-AUTHORSHIP-CLAIM-VS-VOUCHED-TRACKS — two overlapping authorship mechanisms need a unified model

**Owner:** architect
**Created:** 2026-06-05 (surfaced during the `backend-co-author-claim-zero-score` review + list-final decision)
**Priority:** P2 (design coherence; not a live defect)

## Problem

PEvO appears to have two distinct, overlapping authorship mechanisms:

1. **`claim_authorship` / `approve_authorship` / `revoke_authorship`** — the co-author **credit** flow. Resolved by `accepted_claims` (`reputation.ts`) and `authorshipClaimsCteBody` (`hafsql.ts`); documented in `hive-schemas.md` § 2.9–2.11. Drives reputation credit.
2. **`author_accept` / `author_resign`** — the **vouched-consent** flow. Documented in `ARCHITECTURE.md` § 6 ("Vouched vs claimed authorship", "Authors mutation"). Gates continuation admission, display badges, and (Phase 2) reputation/citation flow.

These were reviewed together and their relationship is unclear: does an approved `approve_authorship` claim also confer vouched status? Does `author_accept` feed reputation credit, or only the vouched gate? Is one intended to supersede the other? The review could not determine this from code/docs alone.

## Goal

Determine whether the two tracks are redundant, complementary, or one supersedes the other, and document a single coherent authorship model: how a name becomes (a) displayed, (b) credited in reputation, (c) vouched for continuation/consent.

### Constraints to honor

- **List-final invariant (decided 2026-06-05):** authorship credit binds only to a slot named at posting; new co-authors only via continuation revisions. Already applied to the credit flow in `hive-schemas.md` § 2.9/2.10 and `reputation-algorithm.md` "Co-author Credit". Ensure the vouched flow (§ 6) is consistent with it.
- Chain is SSoT; reputation must be reproducible from public on-chain data.

## Acceptance

- A single section (in `ARCHITECTURE.md` § 6, or a clearly cross-linked pair) that states, for each op type, what state it changes (displayed / credited / vouched) and how the two op families compose.
- No contradiction between `hive-schemas.md` § 2.9–2.11, `ARCHITECTURE.md` § 6, and `reputation-algorithm.md` "Co-author Credit".
- If the two tracks are genuinely redundant, a recommendation on consolidation (and a backend task if code changes follow).

## Cross-references

- `agents/docs/hive-schemas.md` § 2.9–2.11; `agents/docs/ARCHITECTURE.md` § 2 "Multi-Author Trust Model" (NOT § 6 — § 6 is the Account State Machine; the § 6 citations in hive-schemas § 2.9/§ 2.10 are pointer rot to fix); `agents/docs/reputation-algorithm.md` "Co-author Credit".
- `backend/src/reputation.ts` (`accepted_claims`, `computeReputationBatch`), `backend/src/hafsql.ts` (`authorshipClaimsCteBody`), `backend/src/consent-ops.ts` (`computeVouchedAuthors`, inert today).

---

## Resolution — Unified authorship consent model (decided 2026-06-05, via brainstorm)

The two families are **complementary, role-split by slot shape** — not redundant, neither wholly supersedes the other. Both routes require the credited person's own explicit consent op; metadata auto-accept is removed.

**Status word:** rename **"vouched" → "consented"** across the docs (doc-only; on-chain op names unchanged). This is ONLY the § 2 authorship-consent status. Do NOT touch the other two senses of "vouch": the WoT accreditation vouch (`hive-schemas.md` § 2.5/§ 2.6) and object "author-vouching" (`ARCHITECTURE.md` § 1).

**Slot states:**
- **Claimed (display only):** named in `authors[]` (root post, or a list-final continuation revision). Plain-text display, no credit.
- **Consented (credited — reputation + citation + badge):** the named person gave explicit consent, via one of two routes selected by slot shape.

**Two consent routes:**
1. **Anchored slot** (slot carries a Hive handle OR an ORCID) → the co-author broadcasts **`author_accept`**. Eligibility anchor: `slot.hive == accepter`, OR `slot.orcid ==` the accepter's authority-attested ORCID. No author approval needed; the original author need not know the co-author's Hive handle. The explicit `author_accept` is the consent + credit trigger.
2. **Name-only slot** (neither hive nor ORCID) → the co-author broadcasts **`claim_authorship`** and the **author or admin** broadcasts **`approve_authorship`** to bind the claiming Hive account to the name-only slot. The approval substitutes for the missing identity anchor.

**Removed:** the metadata **auto-accept** (a `claim_authorship` auto-resolving to credit from an ORCID/hive match with no explicit consent op). The match now only gates *who may consent*; credit always requires the explicit op.

**Removal / backstop:** self-withdrawal via `author_resign` (anchored route) or the claimer's self-`revoke_authorship` (name-only route) demotes consented → claimed. **Author/admin `revoke`** is the backstop against the one residual abuse vector — a compromised/malicious co-author injecting a name via a continuation who then self-accepts. Revoke is a remedy, never a consent gate.

**Hive-less / bridge preserved:** ORCID-bearing slots → `author_accept` once the person is accredited with that ORCID; name-only / `hive:null` (incl. immutable bridge papers) → `claim` + author/admin `approve` (the bridge-author-claim attestation flow). No credit path is lost.

**No migration / no flag-day:** nothing live uses these ops yet — the model is the go-forward definition. Docs go ahead of code; backend implements directly. (Supersedes the "hard cutover" framing in `ARCHITECTURE.md` § 2 "Migration".)

**Resolves:** the original §2-says-credit-gated-on-consent vs reputation-credits-via-claim/approve contradiction — in favor of **consent gates credit**, via the two-route mechanism. Also fixes the § 2-vs-§ 6 pointer rot. Honors list-final (both routes require a named slot; continuation is the add path) and chain-SSoT (consented-set reproducible from on-chain ops).

## Execution checklist

**Architect (docs) — DONE 2026-06-05:**
- [x] `ARCHITECTURE.md` § 2: rewrote the trust model as the two-route consent model; renamed vouched→consented; replaced the "reputation/citation gated on vouched" framing with the two-route mechanism; dropped the flag-day/cutover framing ("Migration" → "Rollout"); fixed the § 6 self-references; added the ORCID anchor to the Author Accept wire-format validity; added the § 6.4 name-only-route credit-ops re-auth row.
- [x] `hive-schemas.md` § 2.9–2.11: scoped `claim`/`approve`/`revoke` to the **name-only** route; cross-referenced `author_accept`/`author_resign` as the **anchored** route; removed the auto-accept framing; fixed the § 6 → § 2 cross-refs.
- [x] `reputation-algorithm.md` "Co-author Credit": reframed credit via the consented-set (two routes), removed auto-accept from the model; kept the live cycle (and "Canonical SQL Query") documenting current code + list-final pending framing.
- [x] Surgical rename "vouched" → "consented" across the three docs (WoT-vouch and object-vouching senses spared; `computeVouchedAuthors` code symbol left until backend renames it).

**Backend (filed → `tasks/pending/`):**
- [x] `backend-implement-consented-authorship-model` — wire the two-route consent model, remove auto-accept, credit via the consented-set, add the revoke backstop. Sequenced after `backend-co-author-claim-zero-score`.
- [x] `backend-authorship-credit-ops-fresh-auth` — § 6.4 re-auth for `claim`/`approve`/`revoke_authorship` on custody broadcast.

**Related task interactions:**
- `backend-co-author-claim-zero-score` (held): added an architect note — land its Items 1+2 as scoped against the current auto-accept query; the consented-model migration removes auto-accept later; fixed its § 6 → § 2 ref.
- `architect-reputation-algorithm-canonical-sql-resync` (Task 2): documents current live behavior + a forward note; unblocked by this. Still open.
