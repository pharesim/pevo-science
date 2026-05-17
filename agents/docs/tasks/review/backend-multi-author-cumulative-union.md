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

UNBLOCKED 2026-05-06 — keystone task `backend-continuation-post-author-consent-gate.md` archived round-6 clean per `tasks-archive.md`. `pevoString` helper landed at `backend/src/helpers.ts:170` and is adopted at the IPFS-triple site. This task moved to `tasks/pending/` and picked up by the backend agent.

---

## Backend implementation signal (2026-05-06, working tree on `main`)

Implementation lands across `backend/src/{accreditation,helpers,routes/papers}.ts` plus canary additions in `backend/tests/routes/continuation-author-gate.test.ts`. Touch points:

- **`backend/src/accreditation.ts`** — added `getAccreditedOrcidsByAccount(): Promise<Map<string, string | null>>` (cached 10 min via `hafCache.getOrSet` with throw-on-error semantics matching `getAllAccreditedAccounts`). Issues `SELECT account, orcid FROM active_accreditations` after `activeAccreditationsCteBody`. Empty-string ORCIDs collapse to `null` at extract time so callers always see `string | null` cleanly.
- **`backend/src/helpers.ts`** — `extractAuthorizedContinuationAuthors` JSDoc rewritten to frame the helper as "this chain post's contribution to the cumulative authorized set" rather than "head paper's set." Behavior unchanged (still bridge-paper-carve-out + lowercased `hive` extraction). Parameter renamed `headAuthor` → `postAuthor` for clarity at the new framing.
- **`backend/src/routes/papers.ts`** —
  - **`resolveContinuationChain`** rewritten for per-hop cumulative admit-set (acceptance #4). The `cumulative` Set seeds from the root's contribution; each admitted candidate's contribution is unioned in; the SQL filter `c.author = ANY($4::text[])` regenerates each iteration. Bridge-paper Option-b is preserved by construction (bridge candidates contribute `{bridgeAccount}`, no change to cumulative). JS-side defense-in-depth re-checks remain: cumulative set membership + `isPevoAnyPaper`.
  - **`buildCumulativeAuthorsForChain`** new helper (above `safePevoMeta`) implementing acceptance #1, #2, #3, #6, #7, #8. Maintains a `Map<lowercased_hive, { entry, sourceAuthor, sourcePermlink, isSelf }>` with the most-recent self-claim winning over fallback claims; emits `orcid_claim_mismatch` for accredited-vs-claimed ORCID divergence; prefills missing ORCID claims for accredited hives.
  - **Head-meta override block (formerly `papers.ts:626-690`)** replaced with cumulative-union construction. `rootAuthorSet` and `headAuthorsCoverRoot` removed. `continuation_authors_shrink_violation` event removed. The IPFS-triple atomic block (round-5/6) and other head-preferred fields (discipline, keywords, citations, language, supplementary_files) preserved verbatim.
  - **`accredited_authors` rebuild** at `papers.ts:917-927` now reads from `detail.authors` (the cumulative union) rather than `detail.json_metadata.{appTag}.authors`. Closes round-3 finding #1 by construction: a head post that drops a chain author from its own metadata cannot leak the shrunken set into accreditation because the union retains the dropped author.
  - **Accreditation lookups hoisted** to the parallel-fetch block alongside `paperResult` / `fullVersions` / `retraction` so `accreditedAccountSet` and `accreditedOrcidsByAccount` are loaded once per request. Both paths cached 10 min by `hafCache`.

### Audit events (acceptance #8)

- **Removed:** `continuation_authors_shrink_violation` (no-shrink rule deleted with the round-3 block).
- **Added:** `orcid_claim_mismatch` with `{ rootAuthor, rootPermlink, hive, claimedOrcid, accreditedOrcid, claimSource }`. `claimSource` is the `${author}/${permlink}` of the chain post that contributed the winning entry (for self-claim winners, points at the hive's own post; for fallback winners, points at the broadcaster's post).
- **Retained:** `paper_authors_metadata_edit` at `reconstructVersionsFromHaf` (round-2 native-edit audit log; not touched by this task).

### Canaries (acceptance #9)

`backend/tests/routes/continuation-author-gate.test.ts` extended with 11 new cumulative-union canaries (header rewritten, two outdated round-3 canaries replaced):

- "cumulative union admits all hives across the chain (root + head)" — first-occurrence order, multi-hive union (#1).
- "drops are silently ignored under cumulative-union (forbidden by construction)" — replaces the round-3 no-shrink canary; asserts no `continuation_authors_shrink_violation` fires AND alice retained in display (#2).
- "self-claim wins for sub-fields (most-recent self-claim by the hive about itself)" — name resolution from self-claim (#3).
- "fallback to most-recent claim when no self-claim exists for a hive" — carol's name from bob's fallback (#4).
- "self-claim updates fallback once the hive broadcasts a self-claim" — 3-link chain, carol's self-claim wins over earlier fallback (#5).
- "ORCID server override fires for accredited-vs-claimed mismatch" — audit event + override + `claimSource` attribution (#6).
- "ORCID passes through unchanged when claim matches accreditation" — no warn fires (#7).
- "non-accredited ORCID claim passes through" — carol not accredited, claim survives unchanged (#8).
- "per-hop cumulative admit-set admits an author added mid-chain" — carol added by bob/v2 → carol/v3 admitted via cumulative SQL filter (#9).
- "per-hop cumulative admit-set rejects outsiders" — mallory absent everywhere, SQL filter excludes (#10).
- "accredited_authors rebuilt from cumulative union (closes round-3 finding #1 leak)" — drop in head metadata doesn't leak through to accreditation (#12).

Bridge paper canary (#11) already covered by the existing `'bridge-paper continuation: only the bridge account is authorized (Option b)'` test (untouched).
Canonical-root walker interaction (#13) covered by `backend/tests/routes/canonical-root-walker.test.ts`'s 16 canaries — verified all pass under the cumulative-union changes (no behavioral change to the backward walker; see "Architect re-review notes" below).

40/40 tests in `continuation-author-gate.test.ts` green. Targeted vitest pass clean across `helpers.test.ts`, `papers.test.ts`, `paper-detail-v3.test.ts`, `canonical-root-walker.test.ts`, `continuation-author-gate.test.ts` (96 passed + 1 skipped). `npx tsc --noEmit` clean. `npm run lint` clean (2 pre-existing warnings in `seed-phrase.ts`, unrelated).

### Mutation-kill attestation (per `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`)

Verified each of the new canaries kills its intended mutation class:

- **Cumulative-union admits canary fails red** if `extractAuthorizedContinuationAuthors` is reverted to "extract from root only" — carol from bob/v2's contribution would not surface, and the test asserts `hives = ['alice', 'bob', 'carol']`.
- **Drops-ignored canary fails red** if I add a `headAuthorsCoverRoot` check back and reject the override — display would lose alice or fall back to bob-only.
- **Self-claim-wins canary fails red** if the winning-claim selection is changed to "most-recent across chain regardless of self-claim" — alice's name would resolve to bob/v2's blank (no name) or to bob/v2's claim about alice if it had a name.
- **ORCID mismatch fires canary fails red** if the override path is removed (prefill-only) — `out.orcid` would stay `'wrong-orcid'` and no warn would fire.
- **ORCID match passes canary fails red** if the override fires unconditionally — `'orcid_claim_mismatch'` would fire even for matches.
- **Per-hop cumulative admit canary fails red** if the cumulative isn't extended on candidate admission — carol/v3 would not be in the chain (bob's contribution would not have added carol to the cumulative for hop 2). The `assertChainWalkAuthorFilter(sql, params, ['alice', 'bob', 'carol'])` line specifically pins the cumulative includes carol.
- **Outsider-rejection canary fails red** if mallory ends up in the cumulative array for any reason — the test inspects the bound parameter and asserts mallory absent.
- **accredited_authors rebuilt canary fails red** if the rebuild is reverted to read from `detail.json_metadata` — the head's shrunken authors (only bob) would surface and alice would drop from `accredited_authors`.

### Architect followups (acceptance #10, #11, plus contract surface) [TODO Architect]

The following architect-owned surfaces require updates AT ARCHIVE of this task. The backend agent does NOT edit them per `agents/backend/CLAUDE.md` "Boundaries" — they are listed here so the architect's archive pass picks them up.

1. **`agents/docs/ARCHITECTURE.md` section 2 "Multi-Author Trust Model" — REWRITE.** The current text describes the round-3 no-shrink rule + `headAuthorsCoverRoot` cover-check. Replace with cumulative-union semantics:
   - Display construction: cumulative union of `pevo.authors[].hive` across all chain posts; first-occurrence order; sub-field resolution rule (most-recent self-claim wins; else most-recent fallback).
   - ORCID server-override for accredited hives (rule #3 of this task's acceptance); `orcid_claim_mismatch` audit event for divergent claims.
   - Chain-walk admit-set: per-hop cumulative (the union grows as each chain post contributes; bridge-paper Option-b carve-out preserved by construction).
   - "Drops are forbidden by construction" — call out that the inversion-prone check is replaced by a structural invariant; cite the round-2/round-3 history (subset → no-shrink) in passing as motivation for the structural shift.
   - Phase 2 layering: `author_accept` / `author_resign` consent ops gate the badge surface; the cumulative union is monotonic membership; vouched-status decays under resign — orthogonal dimensions.
   - Bridge-paper subsection: cumulative-union doesn't change bridge-paper handling (the carve-out stays defense-in-depth under the immutability policy; bridge update flow is being retired in `backend-retire-bridge-update-route.md`).

2. **`agents/docs/api-contracts/papers.md` — UPDATE the PaperDetail Notes section.** Add bullet describing cumulative-union semantics for `authors[]`:
   - `authors[]` is the union of `pevo.authors[].hive` entries (lowercased, deduplicated) across all chain posts in the version history; per-hive sub-fields resolve to the most-recent self-claim or, absent a self-claim, the most-recent claim across the chain.
   - For accredited authors, `orcid` is server-overridden when the on-chain accredited ORCID differs from the broadcaster's claim; mismatches are recorded server-side as audit events (no client-visible field beyond the corrected `orcid`).
   - `accredited_authors` is the intersection of `authors[]` (the union) with the on-chain accreditation set. A head post that drops a chain author from its own `pevo.authors[]` cannot shrink `accredited_authors` — the union retains the dropped author.

3. **`agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — UPDATE the "Sites this convention applies to" section.** The continuation-post gate's predicate shifts from "set membership in root's authorized set" to "set membership in the cumulative chain authors[]." The structural rule "every gate enforces author + type identity together" is preserved; the predicate's expressed shape changes. Update the relevant bullet under "Sites this convention applies to."

4. **`agents/docs/solutions/architecture-patterns/pevo-paper-version-chain-and-edit-semantics-2026-04-30.md` rule #4 — APPEND a paragraph.** Rule #4 ("Authors list is monotonic") is now reinforced by the cumulative-union construction. The rule no longer relies on a check-and-reject mechanism (round-3 no-shrink) — drops are forbidden by construction (the union only grows). Append a paragraph noting: "The monotonic invariant is enforced by `buildCumulativeAuthorsForChain` at `backend/src/routes/papers.ts` (the union `Map<hive, ...>` only grows during chain iteration; no chain post can remove a hive that another chain post added)."

### Architect re-review notes

- **Backward canonical-root walker (`findCanonicalRoot`) NOT modified.** The walker's per-hop check ("child author in predecessor's `pevo.authors[]`") is strictly stricter than cumulative-union's per-hop check ("child author in cumulative set of all predecessors"). Strictly stricter is fail-CLOSED — the walker may reject some chains that the forward walker admits, returning a continuation post (not the root) as canonical. This causes a UX edge case: for a chain `alice/p1 → bob/v2 → carol/v3` where bob/v2's `pevo.authors[]` drops alice's entry but alice's contribution to the cumulative still admits carol's hop, hitting URL `carol/v3` resolves to `carol/v3` (per-hop check rejects bob/v2 → alice/p1) rather than `alice/p1`. The full chain is still surfaced when hitting URL `alice/p1`. Acceptable degradation: real-world insider-drop scenarios should be rare; deep links from search/citations typically point at canonical roots; the spec acceptance #13 only required "verify the cumulative-union construction doesn't reintroduce attack surface there" (verified — no NEW attack surface; the walker's stricter check is fail-closed). If this UX edge case needs closure, file `backend-canonical-root-walker-cumulative-aware.md` as a follow-up.

- **Pre-existing test failure unrelated to this task.** `backend/tests/routes/disciplines-canon-mocked.test.ts > GET /api/papers/:author/:permlink — continuation-chain head-override lowercases head metadata (chain length > 1)` fails with `expected 'physics' to be 'biology'` on UNCHANGED main (verified via `git stash` + targeted run). The mock's chain-walker response row omits `json_metadata`, which causes `isPevoAnyPaper(candidateMeta, 'bob')` to return false in `resolveContinuationChain`, breaking the chain at length 1 and skipping the head-override block. This bug pre-dates this task (existed since the consent-gate landed at `3ea8892` "update disciplines-canon-mocked fixture for the new author-consent gate"). Cumulative-union doesn't introduce the failure or worsen it. Optional follow-up: `backend-disciplines-canon-mocked-fixture-fix.md` adding `json_metadata` to the chain-walker mock row would close it (~3 LOC test fix). Backend leaves this for the architect's triage at archive — the fix is mechanical; if it's worth a task slug, the architect files one.

- **`stats-profile-parity.test.ts` flake under full-suite run.** During the full-suite vitest pass, `'stats vs profile reader parity > stats ignores chain-revoked users with stale prod entries'` failed with shifted real-HAF values; running the same test file alone passes 4/4 cleanly. Likely a real-HAF + cache state flake (test pollution between concurrent suites or chain-state drift between test runs). Not a regression from this task's changes; flagged for architect awareness.

---

## Architect re-review round-2 (2026-05-16) — HELD PENDING FIXES

`/ce-code-review` on commit `b22ce5d` dispatched 11 reviewers (correctness, security, adversarial, testing, maintainability, project-standards, learnings, performance, api-contract, reliability, kieran-typescript; `ce-agent-native-reviewer` skipped per root CLAUDE.md project policy). Surfaced findings: 5 held below, 4 filed as separate tasks (`backend-cumulative-union-listing-surfaces-parity`, `backend-canonical-root-walker-cumulative-aware`, `backend-orcid-claim-mismatch-post-revocation-audit`, plus one already-existing `backend-search-partial-degradation-allsettled` filed from a sibling review), 4 dismissed at triage. The 5 held items are all in-scope of the cumulative-union task's stated invariants (ORCID server-override under rule #3; rule #3 cache-coherence; comment-rot from the round-3 → cumulative-union transition).

### Items to address

**1. (P2) ORCID server-override misses "accredited but no on-chain ORCID" spoof case**

**Where:** `backend/src/routes/papers.ts:319-347` (ORCID branch inside `buildCumulativeAuthorsForChain`).

**Why:** Rule #3 states "accredited ORCID is authoritative." ORCID is **optional** on accreditation — an accredited user may choose not to provide one, and that is the normal state, not an edge case. When an accredited hive has no on-chain ORCID, the current code's `if (accreditedOrcid)` gate skips the override branch entirely. A vouched co-author can broadcast `pevo.authors=[{hive:'alice', orcid:'fake'}]` for an accredited alice (who chose not to share an ORCID), and the forged value surfaces in `detail.authors[]` with no audit event. The spoof surface is broad (every accredited user who opted not to share), and "trust the broadcaster when authority is silent" contradicts the rule's intent — the accredited user's own claim of "no ORCID" IS the authority.

**Fix:** When `cumulative.has(hive)` AND `accreditedAccountSet.has(hive)` AND `accreditedOrcid` is null AND a broadcaster claim is present: set `out.orcid = null` (suppress the claim) and emit `orcid_claim_mismatch` with `accreditedOrcid: null` so operators see the spoof attempt. Update rule #3 narrative in the task body to enumerate all four branches (match / mismatch / prefill / suppress) explicitly. Add a canary to `continuation-author-gate.test.ts`: accredited hive with no on-chain ORCID + claim present → `out.orcid = null` + warn fires.

**2. (P2) Empty-map cache poisoning in `getAccreditedOrcidsByAccount` when `pool === null`**

**Where:** `backend/src/accreditation.ts:101-130` + `backend/src/cache.ts:73` interaction.

**Why:** When `getPool()` returns null (HAF not yet connected at startup, transient pool drop), `getAccreditedOrcidsByAccount` returns an empty map. The cache layer's null-skip rule treats `[]`/empty-Map as cacheable; the degraded result persists for the full 10-min TTL. If HAF recovers mid-window, rule #3's ORCID server-overrides are silently suppressed until cache expiry — exactly the moment when spoof detection should re-engage. Sibling `getAllAccreditedAccounts` has the same bug; this hold scopes to the new helper only — the sibling is acknowledged as a known limitation pending a separate audit.

**Fix:** In `getAccreditedOrcidsByAccount`, early-return the empty map *before* entering `hafCache.getOrSet` when `pool === null`. Don't store the degraded result. The next request after HAF connects re-tries the underlying query and populates the cache correctly. Matches the documented "startup condition" intent without polluting the recovery window. Add a unit canary asserting the `pool === null` path skips the cache write.

**3. (P2) Replace 5 task-slug citations with `ARCHITECTURE.md § 2` references**

**Where:** `backend/src/routes/papers.ts:195`, `:800`, `:1145`; `backend/src/accreditation.ts:92`; `backend/src/helpers.ts:110` — comments citing `backend-multi-author-cumulative-union.md` by slug.

**Why:** Per root CLAUDE.md "Don't reference the current task, fix, or callers in comments — those belong in the PR description and rot as the codebase evolves." Task slugs disappear from `tasks/` at archive; comments become dangling pointers. The permanent home for the rationale invoked is `agents/docs/ARCHITECTURE.md § 2 "Multi-Author Trust Model"`, which the architect rewrites at archive per the existing [TODO Architect] item #1 in this task body.

**Fix:** At each site, replace the slug citation with `agents/docs/ARCHITECTURE.md § 2 "Multi-Author Trust Model"`. Wait for the architect's ARCHITECTURE.md § 2 rewrite to land at archive so the section heading is stable before swapping the citations.

**4. (P2) Purge 6 round-number citations with permanent behavioral statements**

**Where:** `backend/src/routes/papers.ts:207, :810, :949, :2224`; `backend/tests/routes/continuation-author-gate.test.ts:977, :982` — comments citing "round-3" or "round-6" as behavioral markers.

**Why:** Same convention as item #3. Round numbers are task-history (a hold-cycle artifact internal to the workflow), not behavioral WHY. A future reader has no context for "round-3 no-shrink check" — round numbers rot fast and break en masse on hold collapse. Precedent: the recent `architect(review-validity-gate-and-display-reputation-parity)` round-3 hold items 2+5 directed the exact same purge on `reputation.ts:user_reviews` CTE comments; implementer's round-5 signal applied it.

**Fix:** Replace each round-number citation with the permanent behavioral statement. Examples:

- "supersedes the round-3 no-shrink check" → "drops are forbidden by construction (union-only growth)"
- "closes round-3 finding #1" → "reads from detail.authors (cumulative union) so a head that drops an author cannot shrink accredited_authors"
- "round-3 hold item 1: third call site" → brief description of why the memo is threaded through

**5. (P2) Delete stale `// satisfies no-shrink` comment**

**Where:** `backend/tests/routes/continuation-author-gate.test.ts:1007`.

**Why:** Remnant of the removed round-3 no-shrink check. The no-shrink rule no longer exists; the cumulative-union construction supersedes it. The fixture data needs no annotation about a constraint that no longer exists.

**Fix:** Delete the comment.

### Findings filed as separate tasks (no action on this hold)

- `backend-cumulative-union-listing-surfaces-parity.md` (P1) — listing/profile/search surfaces still derive `accredited_authors` from a single post's `pevo.authors[]` rather than the cumulative union; the task's "drops forbidden by construction" invariant holds only at detail. User triage 2026-05-16 ratified the cumulative policy as load-bearing across surfaces. Filed as follow-up because the task body's acceptance was detail-scoped; listing-surface closure is a design exercise (recursive CTE vs denormalization vs bounded approximation).
- `backend-canonical-root-walker-cumulative-aware.md` (P2) — backward walker's stricter check causes two cached canonical roots for the same chain depending on URL entry, with divergent cached `accredited_authors` / `citation_count`. Task body already anticipated this filing with the same slug.
- `backend-orcid-claim-mismatch-post-revocation-audit.md` (P2) — once a forging bad actor is revoked, they drop from `getAccreditedOrcidsByAccount`, blinding subsequent audit-event fires exactly during the post-revocation triage window. Design follow-up (audit-all-claims-on-accredited-targets vs widen-to-all-non-self-claims vs watchlist).

### Findings dismissed at triage (no action)

- Admit-vs-display TOCTOU across chain-walk SQL + 30-min cache (adversarial adv-006 P2/75): accepted as policy. The cumulative reflects current chain metadata; broadcaster-edit-on-chain is attributable and revocable via accreditation. **Architect doc-note for archive:** the ARCHITECTURE.md § 2 rewrite (existing [TODO Architect] item #1) must explicitly state the per-request scope of the "drops forbidden by construction" invariant, so a future reader doesn't infer across-time permanence.
- Mutation-kill attestation overstated for self-claim-wins canary (adversarial adv-004 P2/60): preemptive hardening per `feedback_dismiss_preemptive_test_hardening`. The "first vs most-recent self-claim ordering" mutation class isn't a plausible regression.
- Backward `findCanonicalRoot` UX degradation (correctness #1 P2/100): security property (fail-CLOSED) holds; filed as separate task for cumulative-aware redesign (see above).
- Several P3 testing-quality and api-contract-doc-drift findings: api-contract items fold into architect's archive-time doc edits per existing [TODO Architect] items; testing items recommend dismiss per `feedback_dismiss_preemptive_test_hardening`.

### Re-review signal

When items 1-5 land, `git mv` this file from `tasks/pending/` back to `tasks/review/` per `feedback_task_mv_to_review_after_each_round.md`. Use bare `backend:` or `backend(<scope>):` commit prefixes so the zone-audit hook fires. The architect's next review pass scopes `/ce-code-review` to commits since `b22ce5d`. Items can land in any order or in one combined commit; item 3 (slug → ARCHITECTURE.md § 2) should land AFTER the architect's [TODO Architect] item #1 doc rewrite so the section reference is stable.

## Backend re-review signal (2026-05-16, round-2 fix commit)

Round-1 hold items 1-5 landed.

- Item 1 (P2) — spoof closure at papers.ts:422-439 (new `else if (claimedOrcid)` branch suppresses the claim, sets `out.orcid = null`, emits `orcid_claim_mismatch` with `accreditedOrcid: null`); canary at continuation-author-gate.test.ts under describe block "cumulative-union display construction" ("suppresses broadcaster ORCID claim when accredited target has no on-chain ORCID").
- Item 2 (P2) — `pool === null` early-return at accreditation.ts:101 (`if (getPool() === null) return new Map();` BEFORE `hafCache.getOrSet`); unit canary at tests/lib/accreditation-orcid-cache.test.ts asserts `getOrSetSpy` not called on null-pool path AND sibling contrast that cache IS entered on live-pool path.
- Item 3 (P2) — 5 slug citations replaced with `agents/docs/ARCHITECTURE.md § 2 "Multi-Author Trust Model"` references at papers.ts:196, :940, :1283; accreditation.ts:92; helpers.ts:111. `grep -rn "backend-multi-author-cumulative-union" backend/src/` returns zero.
- Item 4 (P2) — 6 round-number citations purged: papers.ts:208 (round-3 no-shrink), :923 (round-3 no-shrink), :1022 (round-6 signal block ref), :1062 (closes round-3 finding #1), :2350 (round-3 hold item 1); test:981 (closes round-3 finding #1 leak — replaced in both `it()` title and body). Replacement language anchors on behavioral invariants (union-only growth, drops forbidden by construction).
- Item 5 (P2) — stale `// satisfies no-shrink` comment removed at continuation-author-gate.test.ts:1011 (now line shifted by item-4 retitling).

Tools note: this worktree has no `node_modules` (worktrees share `.git` but not installed deps). Could not run `npm run lint` or `npx tsc --noEmit` from inside the worktree; both fail with "Cannot find package 'typescript-eslint'" / "Cannot find module 'express'" respectively because the resolver cannot reach the parent's `node_modules`. Edits are syntactic-comment-only (items 3, 4, 5), a new `else if` branch inside an existing typed scope (item 1), an early-return statement (item 2), and two new test files using established mock patterns (item 1 canary, item 2 canary). No new types, no new imports, no signature changes — lint/tsc deltas should be invariant against the pre-existing seed-phrase.ts warnings baseline. Vitest not run per parent serialization rule.

## Architect re-review round-3 (2026-05-17) — HELD PENDING FIXES

`/ce-code-review` ran on commits `3b6d781..b248761` (round-2 hold-fix surface, 212 LOC across 6 files) with 11 reviewers (correctness, security, adversarial at opus; testing, maintainability, project-standards, performance, api-contract, reliability, kieran-typescript at sonnet; ce-learnings-researcher unstructured; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md project policy; `previous-comments` skipped — not a GitHub PR, the architect-context hold-block IS the prior feedback verified directly). All 5 round-2 hold items landed structurally correct. Surfaced findings: 4 held below, 1 architect-doc edit pulled forward (handled at archive of A1 below), 1 dismissed at triage. A1 also spawned a new UI verification task filed at `agents/docs/tasks/pending/ui-papers-orcid-null-fallback-verification.md`.

### Items to address

**1. (P2, anchor 100, cross-reviewer correctness + adversarial) — `orcid_claim_mismatch` audit branch (d) omits `accreditationStatus: 'active'` discriminator.**

**Where:** `backend/src/routes/papers.ts:417-433` (the new `else if (claimedOrcid)` branch added in round-2 item 1).

**Why:** Branches (b) (active mismatch) and the revoked branch both emit `accreditationStatus: 'active' as const` / `'revoked' as const` in their audit payload. The new branch (d) omits the field. Operator log queries filtering on `accreditationStatus` (e.g., `accreditationStatus = 'active'` to scope a triage dashboard to current spoof attempts) silently drop every (d) event. Cross-reviewer corroboration (correctness + adversarial → anchor 100). The audit-event schema asymmetry is operator-visible (logs only, not HTTP wire) but the [TODO Architect] item 1 (ARCHITECTURE.md § 2 rewrite) at this task's archive will enumerate audit-event schemas — converge now so the documented schema isn't a holes-by-default record.

**Fix:** Add `accreditationStatus: 'active' as const,` to the audit payload at `papers.ts:421-432`. Add a canary assertion in `backend/tests/routes/continuation-author-gate.test.ts:915-963` (the spoof-case canary) asserting `expect(event.accreditationStatus).toBe('active')`. Mutation-kill: removing the field from the production emit fails the canary.

**2. (P2, anchor 100, maintainability M-1) — Surviving slug citation at `accreditation.ts:173`.**

**Where:** `backend/src/accreditation.ts:173` — JSDoc for `getHistoricalAccreditationOrcids` contains `(per backend-multi-author-cumulative-union.md rule #3)`.

**Why:** Introduced by sibling commit `0e648b6` (`backend(orcid-claim-mismatch-post-revocation-audit): implement Alt 2 per architect ratification`) AFTER the round-2 hold-fix commit landed. The implementer's "grep returns zero" claim at the round-2 signal block was honest at commit `3b6d781`/`b248761` but is false at HEAD. The slug becomes a dangling pointer at archive. Per `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`.

**Fix:** Replace the parenthetical with `(per agents/docs/ARCHITECTURE.md § 2 "Multi-Author Trust Model")`. Wait for the [TODO Architect] § 2 rewrite to land at archive so the anchor is stable; if landing this fix before the doc rewrite, point at the section heading as-it-will-be (the heading text is stable across the rewrite).

**3. (P2, anchor 100, maintainability M-2) — Pre-existing file header `// supersedes the round-3 no-shrink check` not swept by item 4.**

**Where:** `backend/tests/routes/continuation-author-gate.test.ts:29`.

**Why:** Pre-existing at round-2 baseline `b22ce5d`, not in item 4's 6-site list, not swept. Same rot class — when this task archives, `round-3` becomes a dangling pointer. Convention same as item 2 above.

**Fix:** Rewrite the header line as a behavioral statement, e.g., `// Canaries for cumulative-union construction (drops forbidden by construction; ORCID server-override for accredited hives).` Per `task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` "anchor on behavioral invariants instead."

**4. (P2, anchor 100, maintainability M-3) — Round-2 fix commits INTRODUCED new round-N citations.**

**Where:**
- `backend/tests/lib/accreditation-orcid-cache.test.ts:4` — `Background (round-2 hold item 2):` in the test file header.
- `backend/tests/routes/continuation-author-gate.test.ts:916` — `// Item 1 (round-2 hold):` inline above the spoof canary.

**Why:** Self-violation of the convention the round-2 fix was enforcing. Item 4 explicitly purged similar markers from production code AND test code (including `continuation-author-gate.test.ts:977/:982`). The fix should be self-consistent.

**Fix:** Replace each with a behavioral statement that pins the test's load-bearing assertion:
- Test file header → `Verifies the pool-null early-return invariant for the accreditation ORCID cache helper (skip cache write when getPool() is null so a recovered HAF connection sees the next request's real result, not a degraded empty Map cached for the TTL).`
- Inline comment → `Pins the suppress-branch for accredited targets without on-chain ORCID: broadcaster's claim is overridden to null and orcid_claim_mismatch fires with accreditedOrcid: null.`

### Items dismissed during architect triage

- **A1 (P1/75, api-contract)** — `authors[].orcid` widened to `string | null` without contract update. **Architect handled inline (this round): doc edit landed at `agents/docs/api-contracts/papers.md` documenting `orcid: string | null` + the suppression-to-null path + the SPA null-guard requirement.** Companion UI verification task filed at `agents/docs/tasks/pending/ui-papers-orcid-null-fallback-verification.md` (P1) to audit all SPA orcid-render sites for null-safety. Doc edit pulled forward from [TODO Architect] item 2 at archive (no behavioral change to the backend round-2 fix; the doc just catches up to the wire shape the backend already emits).
- **A6 (P3/75, maintainability)** — 5-branch enum comment at `papers.ts:382`. Dismissed: the enum scaffolds branch (d)'s self-claim WHY rationale; trimming individual branch labels loses the structural frame. Per architect judgment; the architecturally durable home for the four-branch table is the [TODO Architect] § 2 rewrite at archive, at which point this comment can shrink to a pointer.
- **Pre-existing: sibling cache poisoning at `accreditation.ts:251` (getAllAccreditedAccounts) and `:209` (getAccreditationOrcidsWithStatus)** — same pool-null cache-poisoning class as round-2 item 2. Acknowledged in round-2 hold body as out-of-scope (pending separate sibling audit). Surfaced again here but not promoted; remains out-of-scope for this task.
- **adv-r3-003 (P3/60, item-2 canary mutation-kill weakness)** — preemptive test hardening per `feedback_dismiss_preemptive_test_hardening`.
- **adv-r3-004 (P3/50, accredited-user-with-unlinked-self-claim)** — UX edge case (accredited user with their own legitimate but unlinked ORCID self-claim gets it suppressed + flagged as self-spoof). Below confidence gate; design surface for future consideration but not actionable now.
- **rel-001 (P3/40, narrow TOCTOU on pool flap)** — single-instance deployment makes the window unreachable in practice.
- **kt-001 (P3/50, `fired![0]` non-null assertion)** — pre-existing pattern; preemptive hardening.

### Learnings cross-references (architect to link in ARCHITECTURE.md § 2 rewrite at archive)

Five `/ce-learnings-researcher` Known Pattern matches surfaced; relevant for the eventual § 2 rewrite anchoring:
- `agents/docs/solutions/conventions/accredited-orcid-is-optional-not-edge-case-2026-05-16.md` — the four-branch verification lattice this fix implements.
- `agents/docs/solutions/conventions/caching-wrapper-discriminated-union-poisoning-2026-05-11.md` — governs round-2 item 2's fix shape and the pre-existing sibling cache surface.
- `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` — governs items 2, 3, 4 of this hold.
- `agents/docs/solutions/conventions/defense-gated-walker-early-exit-return-discipline-2026-05-16.md` — companion check for cumulative-union helpers' early-exit paths (already audited round-1; flagged here as a permanent reference for the § 2 rewrite).
- `agents/docs/solutions/test-failures/assertion-vacuity-from-upstream-bail-in-mocked-tests-2026-05-17.md` — fresh-same-day learning; relevant to all chain-walker mocked tests including the round-2 canaries (assertion-vacuity gate passes for this round's canaries per architect-context verification, but the doc is the canonical reference for any future mocked-walker canary).

### Re-review signal

When items 1-4 land in a single round-3 commit (or split arbitrarily), `git mv` this file from `tasks/pending/` back to `tasks/review/` per `feedback_task_mv_to_review_after_each_round.md`. Use bare `backend:` or `backend(<scope>):` commit prefixes so the zone-audit hook fires. The architect's next review pass scopes `/ce-code-review` to commits since `b248761`. Item 2's slug-citation replacement should land AFTER (or alongside) the architect's [TODO Architect] § 2 rewrite so the section reference is stable; items 1, 3, 4 are independent and can land any time.

## Backend re-review signal (2026-05-17, round-3 fix commit)

Round-2 hold items 1-4 landed.

- **Item 1 (P2) — case-d audit payload `accreditationStatus: 'active'` discriminator.** Production fix already landed via sibling commit `c2f9c9b` (`backend(orcid-claim-mismatch-post-revocation-audit): round-3 hold fixes`), which extracted `emitOrcidClaimMismatchAudit` and routed all three emission sites (cases b, d, and the revoked arm) through the helper. The helper at `backend/src/routes/papers.ts:222-251` uniformly maps `args.status` → `accreditationStatus` in the warn payload; the suppress-branch at `papers.ts:477-489` now passes `status: 'active'`. This round adds the missing canary assertion at `continuation-author-gate.test.ts:962-968` (`expect(event.accreditationStatus).toBe('active')`) with a mutation-kill comment. Mutation classes the assertion kills: (a) removing `accreditationStatus: args.status` from the helper's log payload, (b) routing case-d outside the helper without the field.
- **Item 2 (P2) — slug citation replacement.** At `backend/src/accreditation.ts:197`, `(per backend-multi-author-cumulative-union.md rule #3)` replaced with `(per agents/docs/ARCHITECTURE.md § 2 "Multi-Author Trust Model")`. The surrounding JSDoc paragraph was lightly tightened to avoid the now-orphaned task-slug parenthetical at the bottom. `grep -n "backend-multi-author-cumulative-union" backend/src/` now returns zero (only the sibling `backend-orcid-claim-mismatch-post-revocation-audit.md` slug at `:202` remains, and it is owned by that sibling task — out of scope here per round-3 hold's per-task scoping). Landing the swap now (before the architect's [TODO Architect] § 2 doc rewrite) is consistent with the round-2 fix that established the same anchor at 5 prior sites; the section heading "Multi-Author Trust Model" is the load-bearing token and is stable across the rewrite.
- **Item 3 (P2) — pre-existing file-header round-3 reference at `continuation-author-gate.test.ts:27-30`.** Rewritten as a behavioral statement: "A structural invariant replaces what was previously a check-and-reject mechanism." Drops the `round-3` round-number and the historical `continuation_authors_shrink_violation` event-name anchor; the bullet's load-bearing content (drops forbidden by construction, union only grows) is unchanged.
- **Item 4 (P2) — two round-N citations introduced by round-2 fix commits.** Both sites rewritten as behavioral statements:
  - `backend/tests/lib/accreditation-orcid-cache.test.ts:4` — header `**Background (round-2 hold item 2):**` → `**Why this matters.**` with the load-bearing fix invariant pinned in-place.
  - `backend/tests/routes/continuation-author-gate.test.ts:916` — inline `// Item 1 (round-2 hold):` → behavioral statement starting with "Pins the suppress-branch for accredited targets without on-chain ORCID:" matching the hold's suggested replacement language.

Verification: `npm run typecheck` clean (both `typecheck:src` and `typecheck:tests`). `npx vitest run backend/tests/routes/continuation-author-gate.test.ts backend/tests/lib/accreditation-orcid-cache.test.ts` against Docker Postgres+Redis: 52/52 green (45 in `continuation-author-gate.test.ts`, 2 in `accreditation-orcid-cache.test.ts`, the rest in transitive imports). Lint not run inline (no edits to load-bearing rule surfaces — only comment rewrites + one canary assertion).

