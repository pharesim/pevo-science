---
title: '"vouch" is overloaded across three PEvO senses — authorship consent is "consented", never "vouched"'
date: 2026-06-06
category: conventions
module: agents/docs (ARCHITECTURE, hive-schemas, reputation-algorithm), backend/src/consent-ops.ts
problem_type: convention
component: authentication
severity: high
applies_when:
  - "Writing or reviewing any doc, comment, or code touching co-author confirmation of a specific paper"
  - "Naming a function, variable, custom_json op, SQL CTE, or status field in the authorship/reputation/accreditation domain"
  - "Reading ARCHITECTURE.md section 2 (Multi-Author Trust Model) or hive-schemas.md 2.5-2.6 / 2.9-2.11"
  - "Implementing the computeVouchedAuthors to computeConsentedAuthors rename or the consented-set migration"
  - "Reasoning about who receives paper reputation or citation credit"
related_components:
  - consent-ops
  - wot-accreditation
  - paper-version-chain
tags:
  - terminology
  - naming-convention
  - vouch
  - consented-authors
  - authorship-consent
  - wot-accreditation
  - multi-author-trust
  - overloaded-term
---

# "vouch" is overloaded across three PEvO senses — authorship consent is "consented", never "vouched"

## Context

During an architect brainstorm about which authorship signal should gate reputation credit, the user pushed back: "vouching is for accreditation, how is that connected to rep and citations?" The confusion was valid. At that point the authorship-consent model used the term "vouched" for confirmed authorship of a specific paper (e.g. `computeVouchedAuthors` in `backend/src/consent-ops.ts`, and a "Vouched vs claimed authorship" section in `ARCHITECTURE.md`). That name collided directly with the **WoT accreditation** sense of "vouch" (`vouch` / `retract_vouch` custom_json, `hive-schemas.md` 2.5/2.6), producing a category error: a reader naturally read "vouched authors" as "accreditation-vouched authors" and asked why accreditation-vouching was being used to gate citation credit. It is not. The collision was in the name, not the model.

On 2026-06-06 (commit `59375d76`) the authorship-consent sense was renamed "vouched" to "consented" across the docs (ARCHITECTURE section 2, hive-schemas 2.9-2.11, reputation-algorithm.md). The remaining code symbol `computeVouchedAuthors` in `backend/src/consent-ops.ts` is intentionally left for the backend to rename to `computeConsentedAuthors` when wiring the consented-set (tracked by `backend-implement-consented-authorship-model`).

## Guidance

"Vouch" / "vouched" is reserved for two stable senses in PEvO. A third sense — authorship consent — was formerly called "vouched" and is now "consented." Apply the names consistently:

- **Sense 1 — WoT accreditation vouch.** The `vouch` / `retract_vouch` custom_json ops (`hive-schemas.md` 2.5/2.6), broadcast by an accredited researcher for *another researcher's credentials*. Three vouches from distinct accredited accounts trigger an `accredit` op with `method: "wot"`. Vocabulary: voucher, vouchee, vouch, retract vouch. This is about whether someone is an accredited scientist at all.
- **Sense 2 — Object author-vouching (read-gate).** "author-vouched" in `ARCHITECTURE.md` section 1 ("Accredited-Only Data Policy") describes the ontological boundary: a Hive comment with PEvO-shaped metadata authored by a non-accredited account is not a PEvO object. Vocabulary: vouched account, author-vouching, read-gate. Object-existence layer, not per-paper credit. See `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`.
- **Sense 3 — Authorship consent.** A co-author confirming authorship *of a specific paper*. Two routes (`ARCHITECTURE.md` section 2 "Consented vs claimed authorship"): the anchored-slot `author_accept` op (slot carries the co-author's `hive` handle or authority-attested ORCID), or `claim_authorship` + `approve_authorship` for name-only slots. Vocabulary: **consented**, consented authors, consented-set, `computeConsentedAuthors`. Never "vouched."

When naming new symbols, statuses, ops, SQL CTEs, or variables in authorship or reputation code: use "consented" for sense 3; reserve "vouch" / "vouched" strictly for senses 1 and 2.

## Why This Matters

The three senses gate different things at different layers, and conflating them yields wrong conclusions about the reputation model.

**Sense 1 (WoT vouch)** gates membership in the **accredited set** — the `$2` `accreditedArr` parameter passed to `computeReputationBatch`. Being accredited means your votes count, your reviews count, and you receive `W_accreditation_bonus`. A platform-wide identity gate; it says nothing about which paper credits you.

**Sense 3 (authorship consent)** gates which **named co-authors of a specific paper** receive that paper's reputation and citation credit. Per `reputation-algorithm.md` "Co-author Credit," consented co-authors receive the same paper reputation score as the posting author. A paper can name five co-authors, of whom only two have consented — only those two and the posting author receive that paper's credit.

These are **orthogonal gates**: accreditation-vouching != paper credit. Being accredited is a *precondition* for receiving meaningful reputation, but it is not what causes a specific paper to credit a specific co-author — consent is. Calling authorship consent "vouching" made readers reason as if sense 1 caused sense 3's credit, which is wrong. The rename makes the two layers structurally distinct in the vocabulary.

## When to Apply

- Writing or reviewing any authorship, reputation, or accreditation doc, comment, or code.
- Naming new custom_json ops, SQL CTEs, TypeScript functions, or status fields in the authorship/consent domain.
- Implementing the pending `computeConsentedAuthors` rename and the consented-set migration (`backend-implement-consented-authorship-model`).
- Reviewing or debugging any code that touches `accepted_claims`, `computeVouchedAuthors` (legacy name), or any authorship-gated credit path in the reputation batch query.
- Any discussion that reasons about who receives citation or paper reputation credit — distinguish "is accredited" (sense 1/2) from "has consented to this paper" (sense 3).

## Examples

### Three-sense disambiguation

| Sense | Op / concept | Doc location | What it gates |
|-------|-------------|--------------|---------------|
| 1 — WoT accreditation vouch | `vouch` / `retract_vouch` custom_json; `method: "wot"` on `accredit` | `hive-schemas.md` 2.5, 2.6 | Membership in the accredited set — whose votes/reviews/authorship feed reputation at all (`$2` accreditedArr). |
| 2 — Object author-vouching | "author-vouched" read-gate; accredited account authoring a PEvO post | `ARCHITECTURE.md` section 1 | Whether a Hive comment is a PEvO object at all (ontological boundary, not per-paper credit). |
| 3 — Authorship consent | `author_accept` (anchored) / `claim_authorship` + `approve_authorship` (name-only); "consented" | `ARCHITECTURE.md` section 2; `hive-schemas.md` 2.9-2.11; `reputation-algorithm.md` "Co-author Credit" | Which named co-authors of a specific paper receive that paper's reputation + citation credit. |

### The category error (the incident)

**Wrong reasoning:** "Co-authors must be vouched before they receive paper credit — so accreditation-vouching gates citation credit?"

**Why it is wrong:** "vouched authors" (sense 3, now "consented authors") was confused with "WoT-vouched" (sense 1). Accreditation is a precondition for reputation inputs mattering at all, but it is not what causes a specific paper to credit a specific co-author. A newly accredited researcher does not automatically receive credit for every paper they are named on; they must consent to each paper.

**Correct reasoning:** "A co-author receives paper credit iff (a) they are in the accredited set (sense 1 / sense 2 read-gate) AND (b) they have consented to that specific paper (sense 3). The two gates are orthogonal."

### Correct symbol usage

- `computeConsentedAuthors(paper)` — correct (sense 3); `computeVouchedAuthors(paper)` — legacy, tracked for rename.
- `wotVouchCount(account)` — correct (sense 1).
- `isAuthorVouched(account)` — acceptable only when describing the sense-2 read-gate (object existence), not authorship credit.

## Related

- `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — defines **sense 2** (object-level author-vouching at gate predicates). Distinct from this doc (which defines the three-way overload + the consented rename); the two coexist and cross-reference.
- `hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md` — `author_accept` / `author_resign` consent-op design; uses "vouched" in the authorship-consent sense throughout (a prime terminology-sweep target now that the rename has landed).
- `pevo-paper-version-chain-and-edit-semantics-2026-04-30.md` — the continuation-author-consent gate; a concrete application of the consented-set.

> **Terminology-sweep candidate.** Several existing solutions docs still use "vouched" in the authorship-consent (sense 3) meaning and predate this rename: `hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md` (highest priority), `pevo-paper-version-chain-and-edit-semantics-2026-04-30.md`, `accredited-orcid-is-optional-not-edge-case-2026-05-16.md`, `symmetric-walker-convention-application-audit-prototype-holds-2026-05-05.md`, `pevo-cohering-field-triple-atomic-fallback-2026-05-05.md`, `sibling-field-sql-js-parity-audit-2026-05-19.md`. The object-vouching doc (sense 2) is NOT stale — it correctly keeps "vouch". A targeted `/ce-compound-refresh conventions` (or `/ce-compound-refresh consent-ops`) sweep can realign the sense-3 usages.
