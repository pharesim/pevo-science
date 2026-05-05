---
title: When N fields cohere as a single semantic unit, fallback must be atomic at the unit level — never per-field
date: 2026-05-05
category: architecture-patterns
module: backend/src/routes
problem_type: architecture_pattern
component: service_object
severity: high
related_components:
  - authentication
  - database
applies_when:
  - "Multiple response fields jointly describe a single semantic unit (a triple, tuple, or signed payload)."
  - "A fallback chain composes values from more than one source (head -> root, cache -> chain, primary -> secondary)."
  - "At least one source in the chain is partially trusted or write-controlled by a different principal than the others."
  - "Per-field nullish/typeof narrowing (e.g. `??`, `pevoString`-style helpers) selects between sources independently for each field."
  - "The fields together form a unit whose internal consistency is a security or correctness invariant (e.g. signature covers the whole tuple, hash describes the named artifact)."
tags:
  - triple-coherence
  - atomic-fallback
  - response-shaping
  - frankenstein-composite
  - cohering-fields
  - head-root-merge
  - multi-author-trust
  - pevo-versioning
---

# When N fields cohere as a single semantic unit, fallback must be atomic at the unit level — never per-field

## Context

PEvO's per-version paper detail response carries three IPFS-pointer fields that jointly describe one PDF artifact: `ipfs_cid`, `ipfs_filename`, and `document_hash`. The block comment at `backend/src/routes/papers.ts:609-619` makes the invariant explicit: "each post's pointers describe that version's PDF." The triple is one logical unit — the filename and hash describe the bytes the CID resolves to.

Round-3 of `backend-continuation-post-author-consent-gate` introduced a head-version → root-version fallback for these fields, so a continuation post that omits the IPFS pointers can inherit them from the root paper. Round-4 (commit `72c4b5c`) refactored the read with a `pevoString` helper that null-collapses non-string values, and applied the helper independently per field at `papers.ts:679-687`:

```ts
detail.ipfs_cid       = pevoString(headPevo, 'ipfs_cid')       ?? pevoString(rootPevo, 'ipfs_cid');
detail.ipfs_filename  = pevoString(headPevo, 'ipfs_filename')  ?? pevoString(rootPevo, 'ipfs_filename');
detail.document_hash  = pevoString(headPevo, 'document_hash')  ?? pevoString(rootPevo, 'document_hash');
```

The helper extraction made the per-field-fallback shape canonical and easy to copy.

Round-5 architect review surfaced the Frankenstein attack: a vouched co-author (already in the root paper's `pevo.authors[].hive`) broadcasts a continuation v2 with `pevo = { ipfs_cid: 'QmAttacker', ipfs_filename: 0, document_hash: 0 }`. Per-field fallback yields:

- `detail.ipfs_cid = 'QmAttacker'` (head supplied a valid string)
- `detail.ipfs_filename = 'root.pdf'` (head's `0` collapses to null → falls back to root)
- `detail.document_hash = 'sha256:rootHash'` (head's `0` collapses to null → falls back to root)

The triple `{QmAttacker, root.pdf, sha256:rootHash}` never existed on chain in any single version. Today's blast radius is bounded — the frontend uses `ipfs_cid` for the download link and does not yet verify `document_hash`. Forward-looking risk: when payload integrity verification lands (SHA-256 over the downloaded bytes vs. the displayed `document_hash`), verification will pass against root's hash while the attacker's content is fetched from `QmAttacker` — a silent integrity bypass. Filed as round-5 hold; backend will land an atomic-triple shape.

## Guidance

**Structural rule:** when N fields cohere semantically as a single logical unit, and any of those fields can fall back to a different source, the fallback decision MUST be made at the unit level — either *all from source A* or *all from source B*. Never per-field.

Atomic-triple shape for the IPFS case:

```ts
const headHasAnyTriple =
  pevoString(headPevo, 'ipfs_cid')      !== null ||
  pevoString(headPevo, 'ipfs_filename') !== null ||
  pevoString(headPevo, 'document_hash') !== null;

if (headHasAnyTriple) {
  // Head's view of the artifact. Any null sub-field stays null;
  // we do NOT splice in root values, because root describes a different artifact.
  detail.ipfs_cid      = pevoString(headPevo, 'ipfs_cid');
  detail.ipfs_filename = pevoString(headPevo, 'ipfs_filename');
  detail.document_hash = pevoString(headPevo, 'document_hash');
} else {
  // Root's view as a coherent triple.
  detail.ipfs_cid      = pevoString(rootPevo, 'ipfs_cid');
  detail.ipfs_filename = pevoString(rootPevo, 'ipfs_filename');
  detail.document_hash = pevoString(rootPevo, 'document_hash');
}
```

**Implementer audit checklist when designing field-level fallback:**

1. **Identify groupings.** Do N fields jointly describe one logical thing (an artifact, an address, a key pair, a signed payload)? If you find yourself writing the same `?? otherSource.X` clause for two or more sibling fields, stop and ask whether they cohere.
2. **If yes, lift the decision to the unit level.** Write one `if (sourceA_has_unit) { copy A } else { copy B }`. Never spread `??` across the sibling fields.
3. **If no — fields are genuinely independent** (e.g., user preferences with no inter-field invariant) — per-field fallback is correct and unit-level lifting would be over-engineering.
4. **Document the cohering-unit invariant inline** at the call site so future readers (and the next round's helper-extractor) understand WHY the fallback is unit-level and don't "simplify" it back to per-field `??`.

## Why This Matters

**(a) Frankenstein composites silently break source-coherence consumers.** Per-field fallback can produce a record whose values never coexisted in any single source. Downstream code that assumes the record describes a real, coherent thing — payload integrity verification, signature checks, audit reconstruction, replay attestations, "which version did this come from" provenance — silently breaks or becomes bypassable. In the PEvO IPFS case, a future SHA-256 verification step will compare downloaded bytes against a `document_hash` that came from a different version than the `ipfs_cid` the bytes came from. Verification succeeds; the user sees attacker-controlled content with a green checkmark.

**(b) The bug is invisible to type checking.** Each individual field has the correct type — `ipfs_cid` is a string, `ipfs_filename` is a string, `document_hash` is a string. Only the *combination* is invalid. Static analysis, schema validators, and per-field tests all pass. The invariant is a cross-field relationship, which means tests must explicitly assert source-coherence at the response boundary ("the triple emitted equals the triple from exactly one input source"). That's an unusual test shape — most response-shape tests assert per-field values against fixtures, not cross-field provenance — so the gap survives test suites that look comprehensive.

## When to Apply

Apply the atomic-unit fallback shape in any response shaper that merges N fields from M sources where the N fields cohere semantically. Common coherent-unit shapes:

- Address blocks `{street, city, postal_code, country}`.
- JWT claim sets where `iss`/`sub`/`aud` together identify the token's authority.
- Key pairs `{public_key, key_id}` and signature payloads `{op_payload, signature}`.
- Audit triples `{actor, action, target}` and `{kind, payload, signature}` envelopes.
- Versioned-payload triples `{cid, filename, hash}` (this case).
- Pagination cursor pairs `{cursor, sort_field}` where the cursor is only meaningful under a specific sort.

**PEvO-specific recurrences to watch:**

- IPFS triple `{ipfs_cid, ipfs_filename, document_hash}` (this case, `papers.ts:679-687`).
- Authors triple `{name, orcid, hive}` if a future fallback semantic emerges across continuation versions — the ORCID and Hive handle pair must come from the same attestation.
- Source attestation `{source.type, source.doi, source.id}` where `source.type` qualifies the format of `source.id` — splicing a `type=arxiv` with an `id` from a `type=doi` source produces a malformed reference.
- Signature pairs `{op_payload, custom_json_id}` — Hive guarantees these together at broadcast time, but PEvO-derived response shapes that re-emit them from different views must keep them paired.
- Reputation snapshot triples `{cycle_id, computed_at, score_value}` if cached and live reads ever get spliced.

## Examples

**Negative — per-field `??` fallback (round-4, commit `72c4b5c`, `papers.ts:679-687`):**

```ts
detail.ipfs_cid       = pevoString(headPevo, 'ipfs_cid')       ?? pevoString(rootPevo, 'ipfs_cid');
detail.ipfs_filename  = pevoString(headPevo, 'ipfs_filename')  ?? pevoString(rootPevo, 'ipfs_filename');
detail.document_hash  = pevoString(headPevo, 'document_hash')  ?? pevoString(rootPevo, 'document_hash');
```

Frankenstein composite possible: head's `ipfs_cid` + root's `ipfs_filename` + root's `document_hash` is emitted even though that combination exists in neither version.

**Positive — atomic-triple shape (round-5 hold target, same site):**

```ts
const headHasAnyTriple =
  pevoString(headPevo, 'ipfs_cid')      !== null ||
  pevoString(headPevo, 'ipfs_filename') !== null ||
  pevoString(headPevo, 'document_hash') !== null;

if (headHasAnyTriple) {
  detail.ipfs_cid      = pevoString(headPevo, 'ipfs_cid');
  detail.ipfs_filename = pevoString(headPevo, 'ipfs_filename');
  detail.document_hash = pevoString(headPevo, 'document_hash');
} else {
  detail.ipfs_cid      = pevoString(rootPevo, 'ipfs_cid');
  detail.ipfs_filename = pevoString(rootPevo, 'ipfs_filename');
  detail.document_hash = pevoString(rootPevo, 'document_hash');
}
```

The decision point is the *triple*, not each field. The emitted record always matches exactly one on-chain source.

**Generic anti-pattern — address fallback:**

```ts
return {
  street:      head.street      ?? root.street,
  city:        head.city        ?? root.city,
  postal_code: head.postal_code ?? root.postal_code,
};
// Produces an address that doesn't exist: head's street in root's city
// with root's postal code. Mailable-looking, but routes to nowhere real.
```

**Generic correct pattern — address fallback:**

```ts
const headHasAddress = head.street != null || head.city != null || head.postal_code != null;
return headHasAddress
  ? { street: head.street, city: head.city, postal_code: head.postal_code }
  : { street: root.street, city: root.city, postal_code: root.postal_code };
```

The triple is sourced atomically; downstream consumers that geocode, mail, or audit the address get a record that corresponds to a real input.

## Related

- `agents/docs/solutions/architecture-patterns/pevo-inverted-predicate-collapse-encode-invariant-structurally-2026-05-05.md` — sibling pattern doc on the same task family. That doc collapses the `pevo.authors[]` predicate via cumulative-union (an additive cluster); this learning addresses cohering clusters where the fallback must remain atomic. The two are complementary structural fixes for two field clusters in the same `papers.ts:609-690` block.
- `agents/docs/solutions/architecture-patterns/pevo-paper-version-chain-and-edit-semantics-2026-04-30.md` — version-chain semantics. Rule #5 ("pre-fill from chain head") and the per-field head replacement around lines 569-601 are exactly where Frankenstein-triple risk lives. That doc needs a forward-reference to this learning so future readers applying rule #5 don't reproduce the bug.
- `agents/docs/solutions/conventions/symmetric-walker-convention-application-audit-prototype-holds-2026-05-05.md` — same-day sibling on the same task family. That doc covers convention application across symmetric walkers; this one covers atomic-unit fallback in response shaping. Both belong in the cluster of "round-5 multi-author" learnings.
- `agents/docs/solutions/conventions/object-shape-fix-every-reset-site-2026-04-21.md` — methodology cousin. "Fix every site that resets the object shape" is the per-mutation-site analog of "fall back as an atomic unit"; both reject per-field discipline.
- `agents/docs/solutions/conventions/correlated-options-discriminated-union-2026-04-28.md` — methodology cousin. "Correlated options" → "discriminated union" is the parallel pattern for compile-time correlation; this learning is the runtime-fallback parallel.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — methodology cousin. "Every call site of a wrapper must propagate every error class" is the wrapper-cross-product analog of "every field of an atomic unit must come from the same source."
- `agents/docs/tasks/pending/backend-continuation-post-author-consent-gate.md` — round-5 hold with the atomic-triple shape spec. The implementer will land the structural fix as part of the round-5 commit.
- `agents/docs/ARCHITECTURE.md` "Multi-Author Trust Model" — canonical spec for the IPFS triple and the head→root fallback policy. Will be revisited when `backend-multi-author-cumulative-union.md` archives.
