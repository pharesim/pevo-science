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
