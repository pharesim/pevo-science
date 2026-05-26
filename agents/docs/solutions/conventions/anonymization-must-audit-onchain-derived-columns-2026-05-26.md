---
title: Anonymizing a DB row must audit every surviving column for Hive-chain resolvability
date: 2026-05-26
category: conventions
module: backend (custody_audit_log / account-delete right-to-erasure)
problem_type: convention
component: database
severity: medium
applies_when:
  - Writing or reviewing code that anonymizes a DB row in place (NULLing or hashing columns) rather than deleting it
  - A row being anonymized retains any Hive-derived identifier (tx_id, block_num, permlink, author)
  - Reviewing a GDPR / right-to-erasure path and a comment or doc claims "no PII remains"
tags:
  - gdpr
  - anonymization
  - right-to-erasure
  - hive-chain
  - custody-audit-log
  - re-identification
  - pii
  - column-audit
---

# Anonymizing a DB row must audit every surviving column for Hive-chain resolvability

## Context

PEvO's account-delete path (the `DELETE /api/settings/email` handler) anonymizes
`custody_audit_log` rows instead of deleting them, so the forensic trail survives
a deletion. It runs, in the same transaction that removes the `accounts` row:

```sql
UPDATE custody_audit_log
   SET username = NULL, user_agent = NULL, session_id = NULL
 WHERE username = $1;
```

The accompanying migration COMMENT claimed this satisfied "GDPR Art. 17
right-to-erasure: no PII remains." Two independent reviewers (security and
adversarial) flagged that the claim is false for broadcast-type rows: the row
still carries `tx_id` and `block_num`, which are references to a public Hive
transaction. Anyone can resolve `tx_id` on any public Hive API node and read the
operation's `required_posting_auths` / `author`, recovering the exact username
that was just NULLed. The anonymization NULLed the obvious PII columns but left a
re-identification handle untouched in the same row.

## Guidance

When you anonymize a row in place, the anonymization is only as complete as its
**weakest surviving identifier**. NULLing the columns that obviously hold PII
(`username`, `user_agent`, `session_id`) is not enough if another surviving
column lets an observer recover the subject by a different route.

In PEvO the dominant such route is the Hive chain. Any of these surviving columns
is a re-identification handle, because Hive is a public, immutable ledger and the
user themselves signed the operation onto it:

- `tx_id` -> resolves to the transaction, whose auths/author name the signer.
- `block_num` (plus operation context) -> narrows to the signed operation.
- `permlink` / `author` (where stored) -> directly name the account.

So, before accepting that a row is anonymized, enumerate **every** surviving
column and ask of each: can an observer with public data (especially the Hive
chain) re-identify the subject from this value? Treat the surviving set as an
allowlist you must individually justify, not a denylist of known-bad columns you
strike off. This is the same posture PEvO already takes for log serialization in
[[defensive-recursive-serializer-and-pino-err-redact-policy-2026-05-11]] -- name
and justify what survives, rather than chase what to strip.

There are two valid resolutions when a chain-derived identifier survives:

1. **NULL it too**, if the erasure truly must sever every link. This costs the
   on-chain forensic correlation that retaining it would provide.
2. **Retain it by design and stop claiming erasure of it.** This is PEvO's
   choice for `tx_id`/`block_num`: they are inherently public, user-signed
   on-chain data, so erasing the local copy achieves nothing (the chain copy
   persists). The erasure then covers the username link and the PII-derived
   columns, NOT the public-ledger operation. The claim wording must say exactly
   that. The canonical wording lives in `ARCHITECTURE.md` § 4; mirror it in any
   migration COMMENT or handler comment rather than restating "no PII remains."

The decision is a product/compliance judgment. The non-negotiable part is that
the claim must match what actually survives.

## Why This Matters

A "no PII remains" claim that is false is worse than no claim: it represents the
erasure as complete to operators, auditors, and future maintainers, so the gap
goes unexamined. The failure mode is silent -- the obvious columns are NULL, the
test passes, and the surviving chain reference sits unnoticed. It is also a
recurring class: chain-derived identifiers (`tx_id`, `block_num`) are easy to
treat as inert metadata when they actually carry identity/authorship semantics --
the same oversight as
[[perf-floor-drop-removes-incidental-security-predicate-2026-05-25]], where a
`block_num` predicate was read as a planner hint while it was doing
authorship-narrowing work.

The reason retaining the chain reference is defensible (rather than a leak) is
that the chain is the authoritative public record and the DB row only mirrors it
-- the framing established in
[[chain-primitive-proxy-prefer-deletion-2026-04-28]]. You cannot erase what the
user published to an immutable public ledger; you can only erase your local
linkage and PII-derived columns, and you must describe the erasure in those
terms.

## When to Apply

- Reviewing or writing any in-place anonymization (NULL / hash) of a row that is
  kept rather than deleted -- audit-log retention, soft-delete, pseudonymization.
- Any row that retains a Hive `tx_id`, `block_num`, `permlink`, or `author`
  after the "PII" columns are cleared.
- Reviewing a migration COMMENT, handler comment, or `ARCHITECTURE.md` paragraph
  that asserts a GDPR erasure / right-to-erasure outcome -- confirm the asserted
  outcome matches the surviving-column set.

This belongs to PEvO's broader "audit beyond the immediate diff" discipline; see
[[sql-semantic-shift-cross-surface-audit-2026-05-12]] for the SQL-change variant.

## Examples

Before -- anonymize NULLs the obvious PII but claims complete erasure:

```sql
-- migration COMMENT: "GDPR Art. 17 right-to-erasure: no PII remains."
UPDATE custody_audit_log
   SET username = NULL, user_agent = NULL, session_id = NULL
 WHERE username = $1;
-- tx_id / block_num survive -> resolvable on the public Hive chain to the signer.
-- The "no PII remains" claim is false for any row with a broadcast tx_id.
```

After -- same UPDATE (chain refs retained by design), accurate claim:

```sql
-- Erasure covers the username link and the PII-derived columns
-- (user_agent, session_id). tx_id / block_num are references to public,
-- user-signed Hive transactions and are inherently public; they are retained
-- for forensics, not erased. See ARCHITECTURE.md § 4.
UPDATE custody_audit_log
   SET username = NULL, user_agent = NULL, session_id = NULL
 WHERE username = $1;
```

Reviewer checklist for an in-place anonymization:

1. List every column that survives the UPDATE (not just the ones in the SET).
2. For each, ask: can public data -- especially the Hive chain -- re-identify the
   subject from this value?
3. If yes for any column: either NULL it, or retain it deliberately and reword the
   erasure claim to exclude it. Never leave a "no PII remains" claim standing over
   a surviving re-identification handle.

## Related

- [[defensive-recursive-serializer-and-pino-err-redact-policy-2026-05-11]] -- allowlist-every-surviving-field posture, applied to log serialization.
- [[perf-floor-drop-removes-incidental-security-predicate-2026-05-25]] -- same chain fields (`block_num`, `tx_id`) whose semantic weight was overlooked in a different change.
- [[chain-primitive-proxy-prefer-deletion-2026-04-28]] -- chain is the authoritative public record; DB rows mirror it (the rationale for retaining chain refs by design).
- [[sql-semantic-shift-cross-surface-audit-2026-05-12]] -- audit a SQL change beyond the clause it touches.
