---
title: "Normalize-before-hash gates: identical normalization at every read site; denormalized raw payloads pass"
date: 2026-06-10
category: conventions
module: "backend/src/lib/fresh-auth.ts, backend/src/routes/custody.ts, backend/src/routes/orcid.ts"
problem_type: convention
component: authentication
severity: medium
applies_when:
  - "A proof, token, or challenge binds a target by hashing user-supplied fields at mint time and recomputing the hash at verify time"
  - "More than one issuance path feeds a single consume path (multi-mechanism or multi-route topology)"
  - "Adding a new issuance or consume site for fresh-auth credit-op or consent-op targets"
  - "Reviewing a hardening proposal to reject payloads whose raw bytes differ from the normalized form"
  - "Evaluating whether denormalized on-chain payloads are inert (the argument depends on byte-exact downstream indexing)"
tags: [fresh-auth, normalization, trim, hash-binding, issuance-consume-parity, custody, orcid, hive-chain]
related_components:
  - custody
  - orcid
---

# Normalize-before-hash gates: identical normalization at every read site; denormalized raw payloads pass

## Context

PEvO's fresh-auth gate binds a proof to a specific `(action, paper_author, paper_permlink[, author_index, claimer])` target by hashing the fields at issuance and recomputing the hash at consume. The gate has two issuance paths (password re-prompt at `POST /api/custody/fresh-auth`, ORCID round-trip at `POST /api/orcid/start` with `mode: 'fresh_auth'`) and one consume path inside `POST /api/custody/broadcast`.

Before convergence, the sites did not normalize identically: the ORCID issuance path validated fields bare (no trim, no length cap), the password path trimmed, and the consume side hashed raw wire bytes. A whitespace-padded field therefore hashed differently between issuance and consume depending on the mechanism: the same operation self-inflicted a `target_mismatch` 403 when the proof was minted via one path and passed via the other, and uncapped values flowed into Redis state. The fix converged all three sites on one shared reader.

An adversarial review then surfaced the accepted consequence of that fix: with trim applied at every read site, a whitespace-padded wire payload that previously failed `target_mismatch` now passes the gate, and the RAW padded bytes are what broadcast on-chain while the proof bound the trimmed identity. Architect triage dismissed this as fail-safe; this entry records why, because the rationale is invisible in the code.

## Guidance

When a gate normalizes inputs before hashing or comparing, normalize IDENTICALLY at every read site — all issuance paths and the consume side. The mechanism is a single shared reader that every site calls; per-site normalization logic is the failure mode.

The shared reader is `extractCreditOpFields` (`backend/src/lib/fresh-auth.ts`):

```typescript
const paperAuthor = requireStringField(source, 'paper_author', CREDIT_OP_ACCOUNT_MAX_LEN, undefined, { trim: true });
if (!paperAuthor.ok) return { ok: false, field: 'paper_author' };
const paperPermlink = requireStringField(source, 'paper_permlink', HIVE_PERMLINK_MAX_LEN, undefined, { trim: true });
if (!paperPermlink.ok) return { ok: false, field: 'paper_permlink' };
// ... per-action branches for author_index and claimer ...
```

The consume side delegates to the same reader via `creditOpTarget` (`backend/src/routes/custody.ts`), and both issuance routes call it before `creditOpFreshAuthTarget` → `issueFreshAuthToken`. One function, three call sites, no copies.

Accept that this design admits denormalized wire payloads through the gate: once the gate passes, the raw (padded) bytes are what the custodial signer broadcasts.

Do NOT "harden" by adding a reject-if-raw-differs-from-normalized check at the consume side only. That re-introduces a per-site asymmetry in the opposite direction: a proof minted under the trimmed form fails consume whenever the raw wire value is padded, on one path only. If strict-reject semantics are ever wanted, the reject must land at EVERY site simultaneously, behind the same shared reader.

## Why This Matters

**The asymmetry failure mode.** Without a shared reader, each site silently diverges on normalization. The resulting bug is mechanism-specific and looks like flakiness or user error: identical inputs succeed via one issuance path and 403 `target_mismatch` via the other. Whitespace is the canonical trigger, but any per-site field-treatment divergence produces the same class.

**Why padded-passes-gate is fail-safe here.** The dismissal rests on two properties of PEvO's data model:

1. Trim cannot collide two distinct valid Hive identifiers. Whitespace is not a legal character in Hive account names or permlinks, so a padded form passing the gate is a user-supplied artifact of the SAME identity, never a redirect to a different target.
2. Exact-match HAF indexing voids padded ops. PEvO reads authorship and consent state from HAF SQL under exact-match joins on the raw on-chain bytes; the chain is the source of truth (auto memory [claude]). A broadcast carrying a padded identifier matches no row — the op is void, costing the signer their own operation, never minting or stripping credit for a wrong target.

Together these bound the accepted consequence: the gate admits a denormalized variant of the same identity, and the chain's exact-match read model prevents the variant from having any effect.

**Tripwire:** property 2 depends on HAF-side indexing staying byte-exact. If authorship/consent indexing ever becomes trim-aware, fuzzy, or normalizing, the inertness argument collapses and the consume-side acceptance must be revisited.

## When to Apply

- Any proof/token/challenge that binds a target by hashing user-supplied fields at mint time and recomputing at verify time.
- Any multi-issuance-path topology feeding a single consume path, where a bound field is a string that can arrive with normalization artifacts (whitespace, case, encoding) differing by call path.
- When reviewing a hardening proposal that rejects denormalized raw payloads at the consume side: flag it as a per-site asymmetry fix and ask whether the same check lands at all issuance sites; if not, reshape it as a shared-reader change or drop it.

## Examples

Padded `paper_author: ' bob '` submitted on a credit-op flow:

- Before convergence: ORCID issuance hashed `' bob '` raw; the password path hashed the trimmed `'bob'`; the consume side hashed raw. The same wire input produced a proof that consumed cleanly via one mechanism and 403'd via the other.
- After convergence: every site trims to `'bob'` through `extractCreditOpFields` before hashing — no cross-mechanism divergence is possible. The signer then broadcasts `paper_author: ' bob '` (raw bytes) on-chain; HAF's exact-match read finds no `bob` row for it, so the op is void — no credit minted or stripped for a wrong identity.

## Related

- `agents/docs/solutions/conventions/shared-verifier-primitive-canonical-status-mapping-2026-05-16.md` — the canonical reason→status mapping for `consumeFreshAuthToken`; `target_mismatch` is the 403 reason that normalization asymmetry self-inflicts. That entry covers the status-mapping layer; this one covers the normalization layer upstream of it.
- `agents/docs/solutions/conventions/sql-trim-vs-js-trim-whitespace-character-set-asymmetry-2026-05-19.md` — nearest structural cousin: multi-site normalization drift causing cross-surface mismatch, there SQL-vs-JS, here JS-only across issuance/consume.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — call-site completeness discipline when introducing a shared reader: every site that inlined the logic must be found by grep and migrated.
- `agents/docs/solutions/conventions/convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21.md` — the sweep failure mode that produces per-site normalization drift in the first place.
- `agents/docs/solutions/conventions/defensive-gate-co-land-unblocking-surface-2026-05-16.md` — the issuance/consume co-land rule this normalization-parity invariant spans.
