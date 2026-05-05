---
title: "Hive primitive-aware design rules for PEvO custom_json ops — check what the chain already enforces before inventing app-layer machinery"
description: "Six load-bearing rules for designing PEvO custom_json operations that respect Hive's chain primitive semantics (transaction-size bound, canonical op ordering, native key rotation, single-sided consent ops, signer-subject binding, temporal-ordering of pre-broadcast ops) instead of reinventing or ignoring them."
date: 2026-05-05
category: conventions
module: backend, architecture
problem_type: convention
component: authentication
severity: high
applies_when:
  - "Designing a new PEvO custom_json op (id = APP_TAG) for accreditation, consent, attestation, rotation, governance, or any non-native action"
  - "Reviewing a proposed app-layer size cap, rate limit, or payload bound that may already be enforced by Hive consensus (notably the ~64KB transaction-size bound)"
  - "Walking or ordering Hive ops in HAF SQL queries — any ORDER BY that uses block_num without trx_in_block as a tiebreaker"
  - "Writing a HAF SQL validity rule for a custom_json consent op — must explicitly bind required_posting_auths[0] to the payload subject"
  - "Auditing a custom_json op type that can be pre-broadcast and activate retroactively (name-squatting attack class) without a temporal-ordering rule"
related_components:
  - hive-custom-json-ops
  - haf-sql-validity-rules
  - accreditation-service
  - consent-ops
  - architecture-doc
tags:
  - hive-primitives
  - custom-json
  - consent-ops
  - signer-subject-binding
  - haf-sql-validity
  - block-ordering
  - name-squatting
  - account-update
---

# Hive primitive-aware design rules for PEvO custom_json ops

## Context

A `/ce-brainstorm` + `/ce-doc-review` pass on the multi-author trust model (now landed in `agents/docs/ARCHITECTURE.md` "Multi-Author Trust Model", section 2) surfaced six concrete design lessons that share a single common thread: **Hive's chain primitives have specific semantics PEvO must respect, and they bound certain attack surfaces while leaving others uncovered.** Designers proposing PEvO `custom_json` op types or any chain-interaction surface must check Hive's existing guarantees before inventing application-layer enforcement.

The brainstorm started with three multi-sig primitive options (per-paper Hive sub-account, application-layer co-signing with embedded signatures, time-locked veto window). The chosen design — single-sided `author_accept` / `author_resign` `custom_json` ops with explicit per-op validity rules — is the embodying example of the meta-rule. The /ce-doc-review surfaced concrete issues at every design level: a security finding worried about an application-layer attack Hive consensus already prevents (transaction size); a same-block ordering ambiguity in the spec's "highest `block_num` wins" rule; a missing signer-binding rule that would have allowed third-party impersonation; and a name-squatting attack where pre-broadcast ops sit dormant and activate retroactively. All four were Hive-primitive misalignments — over-engineering for one, under-engineering for the others.

This convention is the Hive-primitive-aware extension of the family started by [`pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`](pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md). That doc establishes the gate-predicate rule: every authorization gate must terminate in an identity predicate (`author = <pinned>`, `signer IN <vouched-set>`). This doc generalizes one layer up: when an authorization gate is implemented as a `custom_json` op type, the identity predicate must be the chain signer (`required_posting_auths[0]`), the validity rule must bind that signer to the payload subject, the ordering rule must use `(block_num, trx_in_block)`, and the temporal rule must reject pre-broadcast dormant ops. The two docs are siblings: identity-binding at gate predicates, plus Hive-primitive-aware design at the op-type layer.

The cost of getting this wrong is twofold. **Over-engineering** — building app-layer checks for what Hive already does (transaction size limits, posting-key revocation via `account_update`). **Under-engineering** — missing app-layer checks Hive does NOT do (signer-to-payload binding, temporal-ordering validity, same-block tie-breaking). Both are recurring traps for agents proposing solutions; this convention forces a Hive-first mental model.

## Guidance

When designing or reviewing any PEvO `custom_json` op type or chain-interaction surface, walk these six rules. Each is concrete; together they form a checklist.

### 1. Hive's ~64 KB transaction-size limit is a natural attack-surface bound.

Hive consensus rejects transactions larger than ~64 KB. This caps the size of any `custom_json` payload AND the `pevo.authors[]` array (which lives inside a `comment` op's `json_metadata`) to a few hundred entries — at most ~300-400 author objects, depending on per-entry size. **Do not build application-layer caps for what Hive already enforces.** Consensus rejects oversized ops before they land in HAF; PEvO never sees the row.

Recurring trap: a /ce-doc-review security finding worried about "an attacker writing 10,000 fake authors into `pevo.authors[]` causing UI render DoS." That attack cannot be staged on chain — a 10,000-entry array exceeds ~64 KB. The defender is Hive consensus, not PEvO route handlers.

The asymmetry: an application-layer cap may still be appropriate as a defense-in-depth render-time guard (e.g., paginate display if `pevo.authors.length > 50`), but it should be motivated by UX, not by the imagined unbounded-size attack. Document the motivation accordingly.

Sites this applies to:
- `pevo.authors[]` array (already bounded by Hive op size)
- `pevo.citations[]` references
- `pevo.supplementary_files[]` array of CIDs
- Any `custom_json` payload PEvO designs

### 2. Use `(block_num, trx_in_block)` for Hive op ordering, not `block_num` alone.

Hive blocks are 3 seconds and contain multiple transactions per block. A "latest op wins" rule keyed on `block_num` alone is ambiguous when two ops affecting the same `(subject, scope)` land in the same block. **Always order by `(block_num ASC, trx_in_block ASC)` and pick the highest tuple.**

A /ce-doc-review reviewer flagged the brainstorm spec's "highest `block_num` wins" as ambiguous for same-block `author_accept` + `author_resign` ops — both could land in block N from the same compromised key. The deterministic resolution is the tuple; HAF SQL exposes `trx_in_block` on the `operation_custom_json_view` for exactly this purpose.

Anti-pattern (ambiguous):
```sql
ROW_NUMBER() OVER (
  PARTITION BY cj.json::jsonb ->> 'account'
  ORDER BY cj.block_num DESC
) AS rn
```

Correct (deterministic):
```sql
ROW_NUMBER() OVER (
  PARTITION BY cj.json::jsonb ->> 'account'
  ORDER BY cj.block_num DESC, cj.trx_in_block DESC
) AS rn
```

This pattern applies to **every** "latest op wins" computation in PEvO:
- `active_accreditations` CTE in `backend/src/hafsql.ts` (accredit vs. revoke)
- `active_vouches` CTE (vouch vs. retract_vouch)
- Vouched-set computation for `author_accept` / `author_resign` (per ARCHITECTURE.md "Author Accept (custom_json)" validity rules)
- Late vote ops (`pevo.late_vote` after the 7-day window)
- Any future `(subject, scope) → latest action` pattern

The existing CTEs in `backend/src/hafsql.ts` (`accred_ranked`, `vouch_ranked`) currently order by `block_num DESC` only and should be extended to add `trx_in_block DESC` as the secondary key the moment two ops in the same block become a realistic concern (compromised-key recovery, automated revoke pipelines, batched migration ops).

### 3. Hive-native `account_update` covers posting-key compromise recovery.

PEvO does not need a custom key-rotation primitive. Hive's `account_update` op takes a new posting key; consensus rejects further ops signed by the old key from that block onward. Document compromised-key recovery semantics by **referencing `account_update`**, not by inventing a `pevo_key_rotation_attestation` op type or similar.

The PEvO brainstorm considered (and rejected) inventing a custom rotation primitive. The correct framing, captured in ARCHITECTURE.md "Compromised-key recovery":

> Posting-key compromise admits a finite, bounded attack window. ... The legitimate co-author becomes unvouched until they:
> 1. Rotate their posting key via Hive's native `account_update` op (Hive consensus rejects further ops signed by the old key from that block onward).
> 2. Broadcast a new `author_accept` for the affected paper to restore vouched status going forward.

Bounded-window damage (ops broadcast under the compromised key before rotation) is permanent on chain (immutable), but functionally reversible by **inverse ops**: an attacker-broadcast `author_resign` is reversed by a post-rotation `author_accept`; an attacker-added continuation post can be superseded by a legitimate continuation pinned to the latest head.

Sites this applies to:
- Posting-key compromise (general — `account_update` is always the recovery primitive)
- Light-account master-key incidents (light accounts can rotate via the seed phrase upgrade flow, then broadcast `account_update`)
- Any spec discussion of "what if the user's key is compromised" — answer is always `account_update`, never a new PEvO op type

The same logic extends to active and owner keys: `account_update` covers all of them. Custom rotation attestations are anti-patterns.

### 4. Single-sided `custom_json` consent ops are a lighter alternative to M-of-N multi-sig.

When the threat model is "compromised co-author / insider abuse" rather than "all parties must jointly commit," **per-actor `custom_json` ops with appropriate validity rules suffice**. Do not reach for Hive multi-sig sub-accounts or application-layer co-signing schemes when single-sided consent ops cover the threat.

The PEvO brainstorm started with three primitive options:
1. Per-paper Hive sub-account with M-of-N posting auth.
2. Application-layer co-signing with embedded signatures in `pevo.authors[]`.
3. Time-locked veto window (broadcast immediately, others can veto within N hours).

It converged on **single-sided `author_accept` / `author_resign` ops**. The threat model is "vouched co-author turned adversarial," not "all co-authors must jointly commit." A new author broadcasts `author_accept` under their own posting key; a co-author who wants out broadcasts `author_resign` under their own posting key. Each op is signed by exactly one party, the party whose state is mutating.

Wire format:
```
id: "<APP_TAG>"
required_auths: []
required_posting_auths: ["<actor>"]
json: {
  type: "author_accept" | "author_resign",
  root_author: "<paper_root_author>",
  root_permlink: "<paper_root_permlink>"
}
```

Sites this applies to:
- `author_accept` / `author_resign` (current spec)
- Future "review_endorsement" / "citation_attestation" (if added) — same single-sided shape
- Vouches (`active_vouches` CTE) — already this shape
- Late vote ops — already this shape

When NOT to use this: operations that semantically require joint commitment (e.g., a hypothetical "all co-authors agree to retract"). For those, a multi-sig sub-account is appropriate. PEvO has none of these today.

### 5. Validity rules for consent ops MUST bind signer to payload subject explicitly.

A `custom_json` op carries two pieces of identity information: the chain signer (`required_posting_auths[0]`) and any payload-level identity claim (`json.subject_hive_account` or analogous). **The validity rule must require these to be equal.** Otherwise an attacker crafts a payload citing a third party's identity and broadcasts under their own posting key — minting a consent op against someone else's name.

The brainstorm's first-pass spec for `author_accept` only checked the payload's `accepting_author_hive` against on-chain criteria (presence in claimed authors set). A /ce-doc-review reviewer caught the gap: without `required_posting_auths[0] == accepting_author_hive`, mallory could broadcast `{type: "author_accept", accepting_author_hive: "alice", ...}` under mallory's own key, marking alice vouched without alice's consent.

Anti-pattern (validity rule missing signer-binding):
```ts
function isValidAuthorAccept(op: CustomJsonOp): boolean {
  const payload = JSON.parse(op.json);
  return (
    isInClaimedAuthorsSet(payload.accepting_author_hive, payload.root_author, payload.root_permlink) &&
    op.block_num > earliestClaimBlock(payload.accepting_author_hive)
  );
}
```

Correct (signer bound to subject):
```ts
function isValidAuthorAccept(op: CustomJsonOp): boolean {
  const payload = JSON.parse(op.json);
  return (
    op.required_posting_auths[0] === payload.accepting_author_hive &&  // load-bearing
    isInClaimedAuthorsSet(payload.accepting_author_hive, payload.root_author, payload.root_permlink) &&
    op.block_num > earliestClaimBlock(payload.accepting_author_hive)
  );
}
```

The SQL form (in a vouched-set CTE):
```sql
AND cj.required_posting_auths ->> 0 = cj.json::jsonb ->> 'accepting_author_hive'
```

Sites this applies to (every PEvO `custom_json` type that asserts something about a subject identity):
- `author_accept` — signer must equal `accepting_author_hive`
- `author_resign` — signer must equal `resigning_author_hive`
- WoT `vouch` / `retract_vouch` — signer must equal `voucher`
- Late vote ops — signer must equal voter
- Any future consent op type

The accreditation op family is the **inverted shape** of this rule, and it is consistent: accreditation is admin-issued, so the signer is the *issuer* (not the subject), and the whitelist filter `cj.required_posting_auths ?| $N::text[]` against `[HIVE_ADMIN_ACCOUNT, ...ACCREDITATION_AUTHORITIES]` (see `backend/src/hafsql.ts`) is the signer-binding equivalent. The general principle: **the signer's role in the op semantics MUST be enforced as a signer-binding predicate, never assumed.**

### 6. Pre-broadcast `custom_json` ops must be rejected if they pre-date their eligibility window.

A `custom_json` op can be broadcast at any time, including **before** the on-chain context that would make it valid exists. Without a temporal lower bound, an attacker pre-broadcasts a consent op that sits inert on chain, then activates retroactively when later ops create the eligibility context.

Concrete attack (the "name-squatting" class): mallory pre-broadcasts `{type: "author_accept", accepting_author_hive: "mallory", root_author: "alice", root_permlink: "paper-1"}` at block N=1000. The op is invalid at block 1000 (mallory is not in the claimed authors set yet) but lives on chain. Later, at block N=5000, alice publishes a continuation post (or bob does, with alice's metadata) that lists mallory in `pevo.authors[]`. Without a temporal validity rule, mallory's old op suddenly becomes valid at read time — mallory is now vouched without ever broadcasting under post-eligibility conditions.

Defense: the op's `block_num` MUST be strictly greater than the earliest block at which the actor became eligible.

ARCHITECTURE.md "Author Accept (custom_json)" validity rules capture this:
> The accept op's `block_num` MUST be strictly greater than the `block_num` of the earliest admitted chain post operation that included `accepting_author_hive` in `pevo.authors[]`.

SQL form (in a vouched-set CTE — illustrative):
```sql
WITH earliest_claim AS (
  SELECT
    pevo_authors.hive AS author,
    c.author AS root_author,
    c.permlink AS root_permlink,
    MIN(c.block_num) AS earliest_block
  FROM ${T.comments} c
  CROSS JOIN LATERAL jsonb_array_elements(c.json_metadata -> $1 -> 'authors') AS pevo_authors
  WHERE -- chain-membership predicate
  GROUP BY pevo_authors.hive, c.author, c.permlink
)
SELECT cj.*
FROM ${T.customJson} cj
JOIN earliest_claim ec
  ON ec.author = cj.json::jsonb ->> 'accepting_author_hive'
 AND ec.root_author = cj.json::jsonb ->> 'root_author'
 AND ec.root_permlink = cj.json::jsonb ->> 'root_permlink'
WHERE cj.custom_id = $1
  AND cj.json::jsonb ->> 'type' = 'author_accept'
  AND cj.required_posting_auths ->> 0 = cj.json::jsonb ->> 'accepting_author_hive'
  AND cj.block_num > ec.earliest_block;  -- load-bearing
```

Sites this applies to:
- `author_accept` (current spec; the rule is in place per ARCHITECTURE.md "Author Accept (custom_json)")
- Any future "X-attestation" op (review endorsement, citation attestation, claim of identity for bridge papers)
- The bridge-paper author-claim flow (`backend-bridge-paper-author-claim-flow`, currently scoped) — pre-broadcast accepts must not retroactively activate when the importer assigns Hive handles. This is exactly why ARCHITECTURE.md "Bridge papers" forbids importer-side `pevo.authors[].hive` mapping.

The general rule: **for any `custom_json` op whose validity depends on later-occurring on-chain context, the op must include or be checked against a temporal lower bound tied to that context.**

## Why This Matters

When PEvO designs a chain-interaction surface, there are two kinds of mistakes, and they are equally costly.

**Over-engineering** — building app-layer checks for what Hive consensus already enforces. The transaction-size example (rule 1) is the canonical instance. A reviewer or agent sees a payload field and worries about unbounded-size DoS, then proposes a length cap, a per-author-per-block rate limit, or a verification round trip — all of which are dead code, because the attack is rejected by Hive consensus before it lands. The same trap exists for posting-key revocation (rule 3): inventing a "PEvO key rotation attestation" parallel to Hive's `account_update` adds an op type, a validity rule, a HAF query, and ongoing maintenance — all to duplicate a primitive consensus already provides for free.

**Under-engineering** — missing app-layer checks Hive does NOT do. Hive does not bind signer to payload (rule 5): `required_posting_auths` is a chain-layer authentication of the broadcaster, but consensus has no opinion about whether the broadcaster is authorized over the *subject* the payload mentions. Hive does not enforce temporal-ordering validity for app-defined ops (rule 6): a `custom_json` is just a key-value blob that consensus accepts under the broadcaster's posting key. Hive does not break same-block ties for app-defined "latest op wins" (rule 2): block ordering is at the block-tuple level, not the operation level, until the consumer keys on `(block_num, trx_in_block)`. And Hive does not provide multi-party joint commitment for app-defined consent (rule 4) — that has to be modeled at the application layer if needed.

The convention forces a Hive-first mental model. **Before designing or proposing a `custom_json` op type, ask: which of these properties does Hive give me for free? Which do I have to add?** Build a checklist against rules 1-6. The PEvO `author_accept` / `author_resign` design embodies the answer for one specific case; future op types should walk the same six rules from scratch, since the answers may differ (e.g., a hypothetical multi-author retract op would NOT be a single-sided consent op per rule 4 — it would need joint commitment).

## When to Apply

Apply this convention any time you are working with a Hive chain-interaction surface in PEvO. Concrete trigger situations:

- **Designing a new `custom_json` op type** for PEvO (any `id = APP_TAG`). Walk all six rules before the spec is finalized.
- **Reviewing a security finding** that proposes an application-layer cap, limit, or rate-limiter on chain-derived data. Ask: what does Hive consensus already do here? (Rule 1.)
- **Implementing "latest op wins per (subject, scope) pair" semantics** in a HAF query. Verify the `ORDER BY` clause uses `(block_num, trx_in_block)`, not `block_num` alone. (Rule 2.)
- **Specifying compromised-key recovery** for any PEvO consent or attestation flow. Reference `account_update`; do not invent a custom rotation op. (Rule 3.)
- **Choosing between Hive-native multi-sig sub-accounts and application-layer consent ops** for a new flow. Default to single-sided ops unless the threat model truly requires joint commitment. (Rule 4.)
- **Writing or reviewing validity rules** for any `custom_json` type. Verify the chain signer is bound to the relevant payload identity field. (Rule 5.)
- **Auditing an existing PEvO `custom_json` validity rule** for signer-binding correctness. Grep for `required_posting_auths` predicates in `backend/src/hafsql.ts` and `backend/src/routes/papers.ts` and verify each appears next to the relevant payload-identity equality check. (Rule 5.)
- **Designing any flow where a payload's validity depends on later-occurring on-chain context** (bridge importer assignments, late-vote eligibility, deferred attestations). Add the temporal-lower-bound predicate. (Rule 6.)
- **Triaging a /ce-doc-review or /ce-code-review finding** that touches a custom_json op type. The six rules form a fast checklist for reviewers.

## Examples

**Rule 1: Transaction-size limit is a natural bound.**

Before (over-engineered):
```ts
// papers.ts route handler — defending pevo.authors[] from "unbounded" growth
if ((post.json_metadata?.[appTag]?.authors?.length ?? 0) > 1000) {
  return res.status(400).json({ error: 'too_many_authors' });
}
```

After (rely on Hive consensus):
```ts
// No app-layer cap needed. Hive's ~64 KB transaction-size limit caps
// pevo.authors[] to ~300-400 entries per op naturally; oversized ops are
// rejected by consensus and never reach HAF.
//
// Optional: add a UX-motivated render-time pagination guard (display
// the first N authors with "+M more" if length > 50). That guard is
// motivated by UX, not by an unbounded-size attack.
```

---

**Rule 2: Use `(block_num, trx_in_block)` for op ordering.**

Before (ambiguous on same-block ties):
```sql
ROW_NUMBER() OVER (
  PARTITION BY cj.json::jsonb ->> 'accepting_author_hive',
               cj.json::jsonb ->> 'root_author',
               cj.json::jsonb ->> 'root_permlink'
  ORDER BY cj.block_num DESC
) AS rn
```

After (deterministic):
```sql
ROW_NUMBER() OVER (
  PARTITION BY cj.json::jsonb ->> 'accepting_author_hive',
               cj.json::jsonb ->> 'root_author',
               cj.json::jsonb ->> 'root_permlink'
  ORDER BY cj.block_num DESC, cj.trx_in_block DESC
) AS rn
```

---

**Rule 3: Use Hive native `account_update` for posting-key recovery.**

Before (inventing a custom op):

> Add a new `custom_json` type `pevo_key_rotation_attestation` that lists the new posting key. PEvO validity logic ignores ops signed by the old key after a rotation attestation lands.

After (reference the native primitive):

> Posting-key compromise recovery: the user broadcasts a Hive `account_update` op with a new posting key. Hive consensus rejects further ops signed by the old key from that block onward. PEvO needs no custom rotation op type. Pre-rotation damage is reversed via inverse ops where applicable (e.g., re-broadcast `author_accept` after a spurious `author_resign`).

---

**Rule 4: Single-sided consent ops over multi-sig.**

Before (multi-sig sub-account proposal):

> Each multi-author paper is owned by a Hive sub-account whose posting authority is M-of-N across all co-authors. Adding or removing an author requires a new sub-account `account_update` co-signed by M existing authors.

After (single-sided per-actor consent):

> Each co-author broadcasts `author_accept` under their own posting key when they join. Each co-author broadcasts `author_resign` under their own posting key when they leave. The vouched-set computation reads the latest op per (author, paper) pair. No joint commitment, no sub-account, no co-signing flow.

---

**Rule 5: Bind signer to payload subject.**

Before (validity rule misses signer-binding):
```ts
function isValidAuthorAccept(op: CustomJsonOp): boolean {
  const payload = JSON.parse(op.json);
  return isInClaimedAuthorsSet(
    payload.accepting_author_hive,
    payload.root_author,
    payload.root_permlink,
  );
}
```

After (signer is bound to the asserting subject):
```ts
function isValidAuthorAccept(op: CustomJsonOp): boolean {
  const payload = JSON.parse(op.json);
  return (
    op.required_posting_auths[0] === payload.accepting_author_hive &&
    isInClaimedAuthorsSet(
      payload.accepting_author_hive,
      payload.root_author,
      payload.root_permlink,
    ) &&
    op.block_num > earliestClaimBlock(
      payload.accepting_author_hive,
      payload.root_author,
      payload.root_permlink,
    )
  );
}
```

---

**Rule 6: Reject pre-broadcast dormant ops via temporal lower bound.**

Before (validity rule has no temporal predicate; pre-broadcast op sits inert and activates retroactively):
```sql
SELECT cj.*
FROM ${T.customJson} cj
WHERE cj.custom_id = $1
  AND cj.json::jsonb ->> 'type' = 'author_accept'
  AND cj.required_posting_auths ->> 0 = cj.json::jsonb ->> 'accepting_author_hive'
  AND EXISTS (
    SELECT 1 FROM admitted_chain_posts acp
    WHERE acp.root_author = cj.json::jsonb ->> 'root_author'
      AND acp.root_permlink = cj.json::jsonb ->> 'root_permlink'
      AND acp.claimed_authors ? (cj.json::jsonb ->> 'accepting_author_hive')
  );
-- Mallory's pre-broadcast op at block 1000 satisfies all conjuncts at read
-- time once block 5000 introduces mallory into pevo.authors[]. Retroactive
-- activation.
```

After (temporal lower bound rejects ops broadcast before eligibility):
```sql
WITH earliest_claim AS (
  SELECT
    pa.hive AS author,
    c.author AS root_author,
    c.permlink AS root_permlink,
    MIN(c.block_num) AS earliest_block
  FROM ${T.comments} c
  CROSS JOIN LATERAL jsonb_array_elements(c.json_metadata -> $1 -> 'authors') AS pa
  WHERE -- admitted-chain-post predicate
  GROUP BY pa.hive, c.author, c.permlink
)
SELECT cj.*
FROM ${T.customJson} cj
JOIN earliest_claim ec
  ON ec.author       = cj.json::jsonb ->> 'accepting_author_hive'
 AND ec.root_author  = cj.json::jsonb ->> 'root_author'
 AND ec.root_permlink = cj.json::jsonb ->> 'root_permlink'
WHERE cj.custom_id = $1
  AND cj.json::jsonb ->> 'type' = 'author_accept'
  AND cj.required_posting_auths ->> 0 = cj.json::jsonb ->> 'accepting_author_hive'
  AND cj.block_num > ec.earliest_block;
-- Mallory's pre-broadcast op at block 1000 fails `cj.block_num > ec.earliest_block`
-- when ec.earliest_block = 5000. Dormant ops cannot activate retroactively.
```

## Related

- [`pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`](pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md) — sibling convention. That doc is about identity-binding at gate predicates ("every OR-arm in an authorization gate must terminate in an identity predicate"); this doc is the Hive-primitive-aware extension at the op-type layer ("the chain signer is the identity predicate, and the validity rule must bind it to the payload subject"). Read together.
- [`../architecture-patterns/pevo-paper-version-chain-and-edit-semantics-2026-04-30.md`](../architecture-patterns/pevo-paper-version-chain-and-edit-semantics-2026-04-30.md) — adjacent architecture pattern. That doc covers the chain semantics (continuation pointers, head computation, edit pre-fill); this doc covers the underlying Hive primitives those semantics are built on (`custom_json` validity rules, `(block_num, trx_in_block)` ordering, `account_update`-based recovery).
- [`enumerated-exemption-lists-are-drift-vectors-2026-04-28.md`](enumerated-exemption-lists-are-drift-vectors-2026-04-28.md) — methodology meta-rule. The six rules in this doc are themselves a checklist; future audits should resist the temptation to enumerate "ops that don't need rule N" carve-outs and instead surface drift via grep on the structural predicates (e.g., grep for `cj.required_posting_auths ->> 0` next to every `cj.json::jsonb ->> '<subject_field>'` equality).
- [`hive-signature-request-binding-shape-2026-04-21.md`](hive-signature-request-binding-shape-2026-04-21.md) — adjacent "principal must be bound to the request, not self-asserted" pattern at the authentication layer. Same family as rule 5, applied to HTTP request binding instead of `custom_json` op binding.
- [`chain-primitive-proxy-prefer-deletion-2026-04-28.md`](chain-primitive-proxy-prefer-deletion-2026-04-28.md) — sibling rule under PEvO principle #1 ("Hive-native, not Hive-wrapped"); same impulse applied to DB-schema decisions, while this doc applies it to op-semantics decisions.
- [`chain-write-timeout-ambiguous-outcome-2026-04-22.md`](chain-write-timeout-ambiguous-outcome-2026-04-22.md) — adjacent: relies on the same "Hive has no native idempotency keys" property the rules above explore from the validity-rule side.
- `agents/docs/ARCHITECTURE.md` "Multi-Author Trust Model" section (and "Accreditation (custom_json)" subsection) — the embodying spec. The trust-model section enacts all six rules; the accreditation subsection is the prior-art `required_posting_auths` whitelist pattern (signer-binding via authority list, the inverted-shape sibling of rule 5).
- `backend/src/hafsql.ts` — `activeAccreditationsCteBody` and `activeVouchesCteBody`. Current call sites for the `?|` whitelist pattern (rule 5 applied to admin-issued ops) and target sites for the `(block_num, trx_in_block)` ordering upgrade (rule 2).
- `backend/src/routes/papers.ts` `resolveContinuationChain` — the chain-walk consumer of the rules; the pending `backend-coauthor-trust-model` Phase 2 implements the vouched-set computation that integrates rules 2, 5, and 6.
