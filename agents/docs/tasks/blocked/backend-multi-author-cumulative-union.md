# BACKEND-MULTI-AUTHOR-CUMULATIVE-UNION — replace round-3 no-shrink rule with cumulative-union display construction

**Owner:** Backend Agent
**Created:** 2026-05-05 (architect, surfaced by the round-3 architect re-review of `backend-continuation-post-author-consent-gate.md` — user articulated the equal-rights policy and proposed cumulative-union as a cleaner shape; brainstorm captured the design)
**Priority:** P1 (supersedes round-3's no-shrink rule in production)

## Background

Round-3 of `backend-continuation-post-author-consent-gate.md` (commit `77db9cf`) landed a no-shrink rule on the head-meta override: every hive in the root paper's authorized-author set must appear in the head's `pevo.authors[]`, otherwise the override is rejected and display falls back to the root's authors[]. The rule was anchored on a static `rootAuthorSet`.

During the architect re-review, the user articulated the trust policy: **any author currently in the chain's `pevo.authors[]` can broadcast continuations regardless of when they were added; trust is dynamic; cost falls on the introducer via accreditation revocation cascading through accounts they introduced.**

This policy makes `rootAuthorSet` over-restrictive. A cleaner shape: build the displayed authors list **cumulatively from root to head as a monotonic union**. Each chain post adds authors but cannot drop existing ones, because the displayed list is the union across all chain posts computed at display time. Drops are **forbidden by construction**, not by a check that can be inverted, bypassed, or get out of sync with the spec.

The brainstorm dialogue (architect ↔ user, 2026-05-05) settled four design decisions that this task implements.

## Threat model carried over from round-3

- **Attacker:** any Hive account, including a vouched co-author already in the chain's authors[].
- **Capabilities:** broadcast a continuation post (`pevo.continues = {author, permlink}`) with arbitrary `pevo.authors[]` and arbitrary metadata; broadcast directly via Hive Keychain bypassing the SPA.
- **Existing defenses (round-2 + round-3):** chain-walk SQL filter on author + type identity (per `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`); JS-side re-check defense-in-depth; per-version display for `ipfs_cid` / `ipfs_filename` / `document_hash`.
- **Round-3 closure (no-shrink rule):** prevents head's `pevo.authors[]` from silently dropping a root author from display.
- **Cumulative-union closure (this task):** drops are mathematically impossible — the displayed authors[] is the union across all chain posts. Additions are admitted (any author in any chain post displays). Sub-field claims (name, affiliation, ORCID) are resolved per the rules below.

## Goal

Replace the round-3 head-meta override block (`backend/src/routes/papers.ts:626-690`) with a cumulative-union construction. Display `detail.authors[]` as the union of `pevo.authors[].hive` across all chain posts, with sub-fields resolved by the brainstorm rules. Replace the per-hop chain-walk admit-set with a per-hop cumulative-union admit-set. Remove `rootAuthorSet` entirely; the `extractAuthorizedContinuationAuthors` helper becomes a chain-cumulative builder.

## Acceptance

### 1. Display authors[] is the cumulative union of `pevo.authors[].hive`

For a chain `[root, post_1, post_2, ..., post_N]` (root + N continuations), the displayed `detail.authors[]` is built by:

1. Walk the chain in order (root first, head last).
2. For each chain post's `pevo.authors[]` array, extract entries with a `hive` field that is a non-empty string after `.trim().toLowerCase()`. Skip entries with `hive === null` (legitimate for bridge papers' original-preprint authors — they remain in `detail.authors[]` per the existing bridge convention via a separate path; see #6 below).
3. Build a `Map<string, AuthorEntry>` keyed by the lowercased `hive`. Each map entry preserves the resolved sub-fields per rule #2 below.
4. The displayed `detail.authors[]` is the map values, in **first-occurrence order** across the chain (the order in which each unique hive first appeared in any chain post).

Drops are forbidden by construction: once a hive enters the map, no later chain post can remove it (later posts can only contribute their own entries; map keys persist).

### 2. Per-hive sub-field resolution: self-claim wins, fallback to most-recent

For each unique hive in the cumulative union:

- **Self-claim wins:** if the chain contains one or more posts whose `chain-author === hive` (i.e., the hive's own continuation posts) AND that post's `pevo.authors[]` contains an entry for itself, take the **most-recent self-claim's** `name` and `affiliation` fields.
- **Fallback to most-recent across chain:** if no self-claim exists for that hive (e.g., bob added carol but carol hasn't broadcast a continuation yet), take the **most-recent claim across the chain** (any broadcaster's claim about that hive).

This rule applies uniformly to `name`, `affiliation`, and any other free-text sub-field. It does NOT apply to `orcid` — see rule #3.

**Rationale:** broadcaster-attribution is the trust model. Each author speaks for themselves; when they haven't yet, the most-recent claim by another chain author is a reasonable default (likely the inviter who knows the bio). The introducer is on the hook for the initial bio claim until the introduced author updates it.

### 3. Per-hive ORCID resolution: server overrides when claim differs from accreditation

For each unique hive in the cumulative union:

- **If the hive is accredited** (i.e., appears in the accreditation custom_json attestation set):
  - Look up the on-chain accredited ORCID for that hive.
  - Compare against the resolved `orcid` field from rule #2 (self-claim or fallback).
  - **If they match:** pass through.
  - **If they differ:** override with the accredited ORCID. Emit `event: 'orcid_claim_mismatch'` audit log with `{ rootAuthor, rootPermlink, hive, claimedOrcid, accreditedOrcid, claimSource }` so operators can correlate post-incident.
  - **If the resolved ORCID is missing:** prefill from accreditation (effectively the same code path as override).
- **If the hive is NOT accredited:** apply rule #2 unchanged (self-claim wins, fallback to most-recent). No server override.

**Rationale:** accredited ORCID is the authoritative on-chain fact; broadcast claims about an accredited account's ORCID are at most a second-best signal. Closes the direct-Keychain spoof where bob broadcasts `pevo.authors=[{hive:'alice', orcid:'fake'}]` for an accredited alice; SPA prefill (separate task `ui-author-input-accredited-prefill.md`) closes the legitimate-user-mistake path at publish time. Audit event makes the spoof attempt visible for accreditation-revocation triage.

### 4. Chain-walk admit-set is per-hop cumulative

`resolveContinuationChain` admits a candidate continuation `C` at hop `N` only if:

- `C.author` (chain-level) is in the **cumulative union** of `pevo.authors[].hive` from chain posts `0..N-1`, AND
- `C` is itself a valid PEvO paper class (round-2 object-identity check unchanged).

**Implementation note (planning, not spec):** the current per-hop `for (let i = 0; i < MAX_HOPS; i++)` loop already does one SQL query per hop. The admit-set was static (root's authors); under cumulative-union it grows per hop. JS-side bookkeeping tracks the cumulative set; SQL parameter `$N::text[]` regenerates each iteration. SQL/CTE alternatives are a planning decision (one round-trip recursive CTE vs N round-trips) — not gated by this spec.

The chain-walk admit-set check fires in BOTH:
- SQL filter (`c.author = ANY($N::text[])`) — primary defense, prevents disallowed candidates from being returned.
- JS-side re-check at the candidate-admit site — defense-in-depth.

### 5. Bridge paper handling unchanged

The round-2 option-b carve-out for bridge papers stays:

- For bridge papers (`pevoMeta.type === 'bridge_paper' && headAuthor === config.hiveBridgeAccount`), the chain-walk admit-set is `{config.hiveBridgeAccount}` regardless of `pevo.authors[]` content (which carries `hive: null` for original-preprint authors).
- Per the user's call during the round-3 triage ("bridge papers never need to be updated"), the bridge `/update` route is being retired in a separate task. Until that lands, the option-b carve-out is defense-in-depth.

The cumulative-union construction at display time treats bridge papers' `hive: null` entries as carrier data only (they remain in `detail.authors[]` for display via the existing bridge metadata path; they don't enter the union map because their `hive` is null).

### 6. Removal of `rootAuthorSet` and the no-shrink override block

- Remove `rootAuthorSet` extraction at `papers.ts:642` and the `headAuthorsCoverRoot` cover-check loop at `papers.ts:642-657`.
- Remove the `event: 'continuation_authors_shrink_violation'` audit log (no shrinking is possible under cumulative-union).
- Replace the assignment block at `papers.ts:659-690` with the cumulative-union construction. `detail.json_metadata` should be set to a SYNTHETIC metadata object that reflects the union'd authors[] (so downstream `accredited_authors` rebuild reads the correct set), or `accredited_authors` should be rebuilt directly from `detail.authors` (cleaner — closes round-3 finding #1's leak by construction). Backend implementer chooses; canary tests pin both surfaces.
- The `extractAuthorizedContinuationAuthors` helper is refactored from "extract from root metadata" to "extract from any chain post's metadata" (a building block for the cumulative union). Single-post extraction logic (lowercase, trim, skip non-string `hive`) is preserved.

### 7. Per-version IPFS pointers (carry over from round-3 hold item 2)

Round-3's per-version display for `ipfs_cid` / `ipfs_filename` / `document_hash` is correct and stays. Implementation should adopt the `pevoString(pevo, key): string | null` helper (see `backend-continuation-post-author-consent-gate.md` round-3 hold item #2 — that helper extraction is the in-flight hold-block on the round-3 task). If the round-3 hold lands first, this task adopts the helper at lines 679-681; if this task lands first, it ships the helper as part of the redesign.

### 8. Audit events

Replace the round-3 audit event surface:

- **Removed:** `event: 'continuation_authors_shrink_violation'` (no-shrink rule deleted).
- **Removed:** `event: 'continuation_authors_subset_violation'` (round-2 tag, already replaced in round-3).
- **Added:** `event: 'orcid_claim_mismatch'` (per rule #3).
- **Retained:** `event: 'paper_authors_metadata_edit'` (round-2 audit-log for `pevo.authors[]` mutation between versions of the same post — still fires for native-edits of a single chain post).

### 9. Tests (`backend/tests/routes/continuation-author-gate.test.ts` — extend or rewrite)

Replace the round-3 canaries with cumulative-union canaries. The carve-out for mocking `getPool()` is preserved (per `CLAUDE.md` "Running Tests"); file header documents justification.

Required canary cases:

- **Cumulative union admits all hives across the chain.** Root has `[alice, bob]`. bob/v2 adds carol. carol/v3 adds nobody new. Display authors[] = `[alice, bob, carol]` in first-occurrence order.
- **Drops are silently ignored (forbidden by construction).** bob/v2's `pevo.authors=[bob]` (drops alice). carol/v3 (legitimate addition by bob, then carol broadcasts) lists `[alice, carol]`. Display authors[] still = `[alice, bob, carol]` because each hive entered the map at its first occurrence and persists.
- **Self-claim wins for sub-fields.** Root has `[{hive:'alice', name:'Alice Smith'}, {hive:'bob', name:'Robert Bob'}]`. bob/v2 has `[{hive:'alice'}, {hive:'bob', name:'Bob Smith'}]`. Display: alice's name = "Alice Smith" (her self-claim from root); bob's name = "Bob Smith" (his self-claim from v2, most-recent self-claim).
- **Fallback to most-recent when no self-claim.** Root has `[alice, bob]`. bob/v2 adds `[{hive:'carol', name:'Initial Guess'}]`. carol hasn't broadcast a continuation yet. Display: carol's name = "Initial Guess" (most-recent fallback claim by bob).
- **Self-claim updates fallback.** Continuing the previous case: carol/v3 broadcasts with `[{hive:'carol', name:'Carol Real'}]`. Display: carol's name = "Carol Real" (now there's a self-claim, which wins).
- **ORCID server override fires for mismatch.** Bob (vouched) broadcasts `[{hive:'alice', orcid:'fake'}]`; alice is accredited with ORCID `0000-0000-0000-1234`. Display: alice's ORCID = `0000-0000-0000-1234` (server override). Asserts `event: 'orcid_claim_mismatch'` fires with the claimed-vs-accredited diff.
- **ORCID passes through when match.** Same setup with bob's claim matching the accredited ORCID. No audit event. ORCID = the matching value.
- **Non-accredited ORCID claim passes through.** Carol (not accredited). Bob's continuation includes `[{hive:'carol', orcid:'whatever'}]`. Display: carol's ORCID = "whatever". No audit event, no override.
- **Per-hop cumulative admit-set.** Chain-walk: root has `[alice, bob]`; bob/v2 adds carol; carol/v3 attempts to broadcast. v3 admitted because carol is in the cumulative set after hop 1. Without cumulative, v3 would be rejected.
- **Per-hop cumulative admit-set rejects outsiders.** mallory broadcasts `pevo.continues={alice, p1}` against root (mallory not in root). Rejected at hop 0 admit-set check.
- **Bridge paper unchanged.** Bridge paper continued by bridge account: admit-set = `{bridgeAccount}` regardless of `pevo.authors[]` (which has all `hive: null` entries). Test asserts the option-b carve-out behavior survives.
- **`accredited_authors` rebuilt from union.** Bob (vouched) broadcasts `[{hive:'bob'}]` (drops alice from his continuation's metadata). Cumulative union still has alice. `accredited_authors` correctly includes alice (assuming alice is accredited). Closes round-3 finding #1.
- **Canonical-root walker (`findCanonicalRoot`) interaction.** Existing canary in `backend-canonical-root-walker-author-gate.md` (currently in `tasks/review/`) — verify the cumulative-union construction doesn't reintroduce attack surface there.

### 10. ARCHITECTURE.md rewrite (architect-owned, lands at archive)

The current "Multi-Author Trust Model" section in `agents/docs/ARCHITECTURE.md` (commit `ddd1c69`) describes the no-shrink rule. At archive of this task, the architect rewrites the section to describe cumulative-union semantics:

- Display construction (cumulative union, monotonic by construction)
- Per-hive sub-field rules (self-claim wins, fallback to most-recent, ORCID server override)
- Chain-walk admit-set (per-hop cumulative)
- Bridge paper carve-out (option-b)
- Audit events (`orcid_claim_mismatch`)
- Phase 2 layering (`author_accept` / `author_resign` consent ops gate the badge surface; the union is monotonic, vouched-status decays under resign)

The rewrite is a [TODO Architect] item at archive (architect followups), alongside the convention doc updates below.

### 11. Convention doc updates (architect-owned, lands at archive)

`agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — update the "Sites this convention applies to" section. The continuation-post gate's predicate shifts from "set membership in root's authorized set" to "set membership in the cumulative chain authors[]." The structural rule "every gate enforces author + type identity together" is preserved.

`agents/docs/solutions/architecture-patterns/pevo-paper-version-chain-and-edit-semantics-2026-04-30.md` — rule #4 ("Authors list is monotonic") is reinforced by cumulative-union (the union enforces monotonicity by construction; the rule no longer relies on a check). Append a paragraph to rule #4 noting the new mechanism.

## Out of scope

- **Phase 2 of the multi-author trust model** (`author_accept` / `author_resign` consent ops, vouched-set computation, badge gating, withdrawal display, migration UI, `/api/me/authorships/*` endpoints). Filed at `agents/docs/tasks/pending/backend-coauthor-trust-model.md`. Phase 2 layers on top of cumulative-union: the union is the chain-derived membership; vouched-status is a separate dimension that decays under resign.
- **Bridge paper update flow retirement.** Per the user's call during the round-3 triage, bridge papers never need to be updated. Filed as separate tasks (architect ARCH update, backend route deletion, ui sync-button removal) at archive of `backend-continuation-post-author-consent-gate.md`. Cumulative-union assumes bridge papers' option-b carve-out remains as defense-in-depth until the retirement lands.
- **Migration of existing chains.** Round-3 just landed (~24h before this task is filed); no production chains have exercised the no-shrink override-rejection path. The cumulative-union switch has no migration burden — chains under round-3 rules display identically under cumulative-union (the no-shrink rule was guarding against drops that the cumulative-union also forbids).
- **Cache invariants.** Existing `/invalidate` flow and cache key shape unchanged. Cumulative-union doesn't introduce new staleness vectors beyond what round-2's per-version display already established.
- **N-deep chain progressive author additions.** Per the user's call (round-3 triage finding #7), accepted risk under broadcaster-attribution + accreditation cascade. Cumulative-union encodes this policy; Phase 2 layers consent-op gating to mitigate display-surface impact.

## Why now

1. **Replaces an inverted check with a structural rule.** Round-3's no-shrink rule was the second inversion in two rounds (round-2 had `head ⊆ root`, round-3 inverted to `root ⊆ head`). Cumulative-union removes the inversion-prone check entirely; drops are mathematically impossible.
2. **Encodes the equal-rights policy directly.** "Any author can broadcast continuations regardless of when they were added" maps cleanly to "the chain's growing authors[] is the admit-set." No special-casing root vs added-later.
3. **Cleaner Phase 2 substrate.** Phase 2 (`author_accept` / `author_resign`) layers on a monotonic membership graph. Vouched-status decays under resign; membership is permanent. The two dimensions are orthogonal under cumulative-union; under no-shrink they were tangled.
4. **Closes the `accredited_authors` leak from round-3 by construction.** Round-3 finding #1 (the unconditional `detail.json_metadata = headMeta` leaking head's shrunk authors[] to downstream accreditation rebuild) becomes moot — `accredited_authors` rebuilds from the cumulative union, which can't shrink.

## Source

- Round-3 architect re-review of `backend-continuation-post-author-consent-gate.md` (2026-05-05).
- User-architect dialog 2026-05-05 (round-3 triage findings #3, #6, #7, #9).
- Brainstorm session 2026-05-05 (architect ↔ user) — captured the four design decisions: cumulative-union construction, self-claim/most-recent sub-field resolution, server ORCID override, per-hop cumulative admit-set.

## Cross-references

- `agents/docs/ARCHITECTURE.md` section 2 "Multi-Author Trust Model" — to be rewritten at archive of this task.
- `agents/docs/ARCHITECTURE.md` section 2 "Vouched-set computation (Phase 2 constraints)" subsection — fail-closed-on-HAF-unavailability paragraph (added 2026-05-06 by `architect-haf-unavailability-vouched-set-policy`). The cumulative-union chain-walk in this task is HAF-required by construction (the per-hop SQL fails-closed implicitly when HAF throws); the consent-ops layer added by `backend-coauthor-trust-model` Round 2 now matches that posture explicitly. No code change to cumulative-union's chain-walk is needed — this is a cross-reference for the holistic posture.
- `agents/docs/tasks/review/backend-continuation-post-author-consent-gate.md` — round-3 task; this task supersedes its no-shrink rule. Round-3 archives with no-shrink as interim defense (production stays correct under round-3 until cumulative-union lands).
- `agents/docs/tasks/pending/backend-coauthor-trust-model.md` — Phase 2 design; rebases on cumulative-union once this task archives.
- `agents/docs/tasks/blocked/ui-multi-author-consent-affordances.md` — Phase 2 UI; cumulative-union doesn't change publish-time UX (the SPA prefill task `ui-author-input-accredited-prefill.md` covers the ORCID prefill at the input level).
- `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — the structural convention this gate enforces; updated at archive.
- `agents/docs/solutions/architecture-patterns/pevo-paper-version-chain-and-edit-semantics-2026-04-30.md` — version-chain semantics; rule #4 reinforced at archive.
- `backend/src/routes/papers.ts:626-690` — the head-meta override block being replaced.
- `backend/src/helpers.ts` — `extractAuthorizedContinuationAuthors` to be refactored as a chain-cumulative builder.

[BLOCKED by Architect] (2026-05-05) — Gated on archive of `agents/docs/tasks/review/backend-continuation-post-author-consent-gate.md`. The cumulative-union redesign replaces the head-meta override block at `backend/src/routes/papers.ts:626-690`, which is the same code surface where round-3's final outstanding hold-block item (#2: `pevoString(pevo, key): string | null` helper extraction for the IPFS triple at lines 679-681) is in flight. Landing both in parallel would merge-conflict and risk implementer confusion. Dependency chain: (1) backend lands round-4 of `backend-continuation-post-author-consent-gate.md` with the `pevoString` helper, (2) architect re-reviews and archives round-3 with no-shrink as interim defense + the architect followups documented there, (3) architect `git mv`s this task to `tasks/pending/` for backend to pick up. Move back to `pending/` once round-3 archives.
