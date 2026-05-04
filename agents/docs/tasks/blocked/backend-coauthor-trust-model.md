# BACKEND-COAUTHOR-TRUST-MODEL — Architecture: insider-abuse defense for multi-author papers

**Owner:** Backend Agent (with architect design lead)
**Created:** 2026-05-04 (architect, surfaced by ε `/ce-code-review` cluster B)
**Priority:** P1 (architecture / security)

## Why now

ε's round-1 work landed the continuation-author-consent gate — closes the unauthenticated-attacker spoof class where any Hive account could post `pevo.continues = {alice, paper-v1}` and have their content surface as alice's apparent paper v(N+1).

Cluster-B `/ce-code-review` surfaced an architectural finding the gate's threat model doesn't cover: **trusted co-author display-spoof** (security sec-1, conf 75).

### The attack

Bob is in alice's `pevo.authors[]` (vouched named co-author):

1. Bob posts `bob/v2` continuing alice's paper with `pevo.continues = {alice, paper-v1}` — admitted by the new gate.
2. In `bob/v2`'s metadata, Bob sets:
   - `pevo.authors = [{hive: 'mallory'}]` — drop alice, "add" mallory.
   - `ipfs_cid` pointing to a different paper entirely (mallory's paper).
   - `doi` overridden to mallory's DOI.
   - `citations` overridden.
3. `papers.ts:586-601` unconditionally overwrites `detail.authors`, `detail.ipfs_cid`, `detail.document_hash`, `detail.citations` with the head continuation post's metadata.

Result: alice/paper-v1's URL displays a paper with mallory listed as author, mallory's IPFS payload, mallory's DOI — but alice's reputation, slug, votes, and review thread.

### Why the gate doesn't stop this

The continuation-author-consent gate enforces **author identity** (Bob must be in `pevo.authors[]`) but not **field-write authorization** (which fields can Bob mutate). Co-author trust today is "mutual obliteration" — any co-author can rewrite the paper.

The convention `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` framed identity as the authorization primitive. That's correct for outsider defense; it's insufficient for insider defense.

## Scope reconciliation

ε's hold-block lands a **scoped immediate defense** (Option 6 from architect triage):
- Lock `pevo.authors[]` against widening via continuation (subset check on the override).
- Root-pin `ipfs_cid` and `document_hash` (NEVER overridden by continuations).
- Allow `title`, `body`, `abstract`, `discipline` to evolve normally.

This task is the **broader architectural design** that goes beyond field-locking:
- What's the right trust model for multi-author papers in a decentralized system?
- Should authorship changes require all-author co-signing?
- Should specific fields (DOI, IPFS payload, authorship) be permanently immutable post-publish, or only revisable via a signed multi-author op?
- Should there be a "version-pinning" mechanism where a co-author can mark their contribution as the canonical reference for a citation?

## Goal

Design + implement a richer trust model for PEvO multi-author papers. The output is BOTH a design doc + the implementation.

## Design questions (to brainstorm before implementing)

### 1. What's the threat model?

- Attacker = compromised co-author account (private key leak, social engineering on hot-wallet).
- Attacker = malicious co-author who was legitimately added but later turns adversarial.
- Attacker = co-author whose Hive account is sold or transferred.

### 2. What fields are sensitive?

Likely sensitive (architect's intuition; verify with brainstorm):
- `pevo.authors[]` — adding/removing authors.
- `ipfs_cid`, `document_hash` — pointing to a different paper.
- `doi` — claiming a different DOI.
- `citations` — fabricating reference graph.

Likely non-sensitive (versions can legitimately update these):
- `title`, `abstract`, `body`, `discipline`, `keywords`, `tags`.

Reviewable design space: "every co-author trusts every other co-author for title/body changes; sensitive fields require multi-sig" is one model. Others exist.

### 3. What's the multi-sig primitive?

Hive supports `multi_sig` accounts and weighted authority. Options:
- (a) Per-paper multi-sig sub-account, all co-authors are signers, threshold = M of N. Heavy: requires creating an account per paper.
- (b) `custom_json` op with embedded signatures from each co-author, validated by HAF/PEvO query layer. Lighter: no new accounts; relies on application-layer enforcement.
- (c) Time-locked + co-author-veto window: any co-author edit to a sensitive field starts a 24h challenge window; any other co-author can veto via `custom_json`. Lightest: no signature primitive; UX-driven.

### 4. What about retroactive co-author additions?

If alice publishes alone, then later wants to add bob as a co-author, what's the flow? Multi-sig requires bob to sign. Could be a `custom_json invitation` op + bob's `custom_json acceptance` op.

### 5. What about the bridge-paper case?

Bridge papers' `pevo.authors[]` lists original-preprint authors who don't have Hive accounts. They can't sign. The bridge service vouches. So the multi-sig model needs a "vouched-signer" primitive — the bridge account signs on their behalf, recorded in the bridge_paper metadata.

(The cluster-B-discovered BUG that bridge papers can never be continued, because `buildBridgeMetadata` writes `hive: null`, is being addressed in ε's hold-block via a special-case admit. That short-term fix should be revisited under this task's broader design.)

### 6. What's the migration story?

Existing PEvO papers don't have multi-sig. New design has to either:
- Apply only to NEW papers (papers published after migration date).
- Retroactively apply to existing papers, with a "ratification window" where all listed co-authors must sign.

## Acceptance

This is a P1 architecture task; acceptance is the DESIGN, not just the implementation. Two phases:

### Phase 1: Brainstorm + design doc

Invoke `/ce-brainstorm` on the trust-model question with the architect. Output: a written design doc under `agents/docs/` (architect-owned zone — backend leaves [TODO Architect] markers; architect lands the doc) that:
- States the threat model explicitly.
- Enumerates sensitive vs non-sensitive fields with rationale.
- Picks ONE multi-sig primitive design (with reasoning vs the alternatives).
- Defines the migration story.
- Includes a `/ce-doc-review` pass before implementation begins.

### Phase 2: Implementation

Once design is ratified:
- Schema changes for multi-sig representation in `pevo` metadata.
- Backend validation logic for sensitive-field updates.
- Frontend SPA UI for: signing prompts, pending-edit visibility, veto/challenge UX.
- Tests covering: legitimate multi-author edit, attempted insider-abuse blocked, bridge-paper case, retroactive co-author addition.
- Convention doc `agents/docs/solutions/conventions/multi-author-trust-model-2026-XX-XX.md`.

This is a major feature; expect 2-4 implementation rounds with held-pending-fix reviews.

## Out of scope

- Cross-paper trust (e.g., "alice's reputation vouches for bob across all alice's papers"). Per-paper trust only.
- Anonymous co-authors. PEvO's existing `pevo.authors[]` requires a Hive handle.
- Post-publication royalty splits or token distribution. PEvO has no token; no royalty layer.

## Coordination

- **ε's hold-block:** ε's hold-fix item 2 lands the scoped immediate defense (locked fields + subset check). After ε archives, this task picks up the broader architecture.
- **Bridge-paper continuation BUG fix in ε:** the special-case admit for bridge-paper continuations interacts with this task's multi-sig design. Coordinate so the long-term bridge-paper trust model is consistent.
- **Frontend SPA work:** signing prompts + UI changes are likely UI agent's scope; file `ui-multi-author-signing-flow.md` after Phase 1 design is ratified.

## Source

- ε `/ce-code-review` (cluster B, 2026-05-04): security sec-1 (P1, conf 75). Filed in ε's "Items deferred" → "Architectural decision warrants brainstorming".

## Cross-references

- `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — convention this task extends from "identity-only" to "identity + field-write authorization".
- ε task `backend-continuation-post-author-consent-gate.md` — sibling task; landed the identity layer.
- `agents/docs/solutions/architecture-patterns/pevo-paper-version-chain-and-edit-semantics-2026-04-30.md` — version-chain semantics this task interacts with.

---

## [BLOCKED by Architect] (backend startup triage 2026-05-04)

Phase 1 of this task is explicit: "Invoke `/ce-brainstorm` on the trust-model question with the architect." The brainstorm is the first deliverable; backend cannot proceed to Phase 2 implementation without (a) the threat-model writeup, (b) the sensitive-vs-non-sensitive field enumeration, (c) the chosen multi-sig primitive (per-paper sub-account vs custom_json+app-layer-validation vs co-author-veto window), and (d) the migration story for existing papers.

What backend needs from architect to unblock:
1. Architect-led `/ce-brainstorm` session with the user covering the design questions in this task file's "Design questions" section.
2. Resulting design doc landed under `agents/docs/` (architect-owned zone) with `/ce-doc-review` pass clean.
3. Decision on the bridge-paper trust model interaction (the ε hold-block special-case admit for `hive: null` authors needs a long-term home that is consistent with this task's design).

Once the design doc is ratified, this task moves back to `tasks/pending/` and backend picks up Phase 2 implementation (schema changes, validation logic, tests, convention doc).
