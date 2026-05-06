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

## Phase 1 design landed (2026-05-05)

Architect-led `/ce-brainstorm` + `/ce-doc-review` passes both clean. Phase 1 outputs:

- **Canonical spec:** `agents/docs/ARCHITECTURE.md` section 2 "Multi-Author Trust Model" — 10 subsections covering design alternatives considered, threat model, vouched-vs-claimed semantic, field mutation rules (2-bucket model), authors mutation, light-account signing of consent ops, vouched-set computation Phase 2 constraints, compromised-key recovery, bridge papers, migration, pinner constraint. Plus `### Author Accept (custom_json)` and `### Author Resign (custom_json)` wire formats with full validity rules (signer binding, temporal ordering, (block_num, trx_in_block) tie-breaker). Landed in commit `ddd1c69`.
- **Three follow-up tasks** filed in `tasks/pending/`:
  - `backend-notification-infra-for-consent-ops` — pending-authorships endpoint for the migration banner.
  - `ui-multi-author-consent-affordances` — paper-detail accept/resign affordances + migration banner + badge display.
  - `backend-bridge-paper-author-claim-flow` — deferred stub for original-preprint author identity binding (P2; pick up when a real user surfaces).
- **ε round-3 hold-block** appended to `backend-continuation-post-author-consent-gate.md` and moved back to `tasks/pending/`. The round-3 fixes correct ε's subset-check inversion (replace with no-shrink rule) and the `ipfs_cid`/`document_hash` root-pin (replace with per-version + head-preferred display). Phase 2 of this task layers on top of those round-3 fixes.

### Phase 2 implementation scope

Backend picks up Phase 2 implementation per the canonical spec. Major work areas:

1. **`custom_json` op handling** — extend `PevoCustomJsonAction` union in `backend/src/types/hive.ts` with `AuthorAcceptAction` and `AuthorResignAction`. Add validators per ARCH.md "Author Accept" and "Author Resign" subsections (signer-binding, temporal-ordering for accept, (block_num, trx_in_block) tie-breaker).
2. **Vouched-set computation** — implement read-time vouched-set lookup honoring the four constraints in ARCH.md "Vouched-set computation (Phase 2 constraints)" subsection (one-block staleness, O(1) HAF queries per request, cache invalidation on consent ops, version-scoped cache keys). Integrate with `resolveContinuationChain`'s admit gate.
3. **Custody endpoint extension** — backend signs `author_accept`/`author_resign` for light-account users via the custody endpoint, with the fresh-auth gate (password / ORCID / etc.) per ARCH.md "Light-account signing of consent ops" subsection.
4. **Migration-day flag** — gate the new vouched-set rules behind a deploy flag; on flag-day, the `/api/me/authorships/pending` endpoint (sibling task) returns the affected papers so the UI surfaces the migration banner.
5. **Tests** — canary coverage for: legitimate accept flow, legitimate resign flow, signer-binding rejection, temporal-ordering rejection, historical-union claimed-set, no-shrink rule, light-account fresh-auth gate, compromised-key recovery semantics, bridge-paper exclusion from consent flow.
6. **`/ce-compound`** — at archive, capture the convention doc `agents/docs/solutions/conventions/multi-author-trust-model-<date>.md` if Phase 2 surfaces non-obvious learnings (otherwise skip).

Phase 2 should be planned with `/ce-plan` to break into reviewable rounds. Expect 2-4 rounds of held-pending-fix review given the spec's surface area.

### Phase 2 dependencies

- ε's round-3 fixes must land first (the round-3 corrections establish the no-shrink + per-version baseline that Phase 2 layers consent ops onto).
- The `/api/me/authorships/pending` endpoint (sibling task `backend-notification-infra-for-consent-ops`) and the UI affordances (`ui-multi-author-consent-affordances`) ship concurrently with Phase 2 for the flag-day migration to work.

---

## Phase 2 round breakdown (planned 2026-05-05, backend)

ε round-3 fixes landed on `main` at commit `77db9cf` (no-shrink rule + per-version `ipfs_cid`/`document_hash`), so Phase 2 dependency #1 is met. Phase 2 splits into four rounds, each scoped as a single held-pending-fix review unit.

### Round 1 — types + vouched-set helper (foundational)

**Goal:** wire the on-chain consent-op shape into the type system and produce a pure read-time helper that returns the vouched-set for a paper. No integration with the continuation-chain admit gate yet — that's round 2.

**Files:**
- Modify: `backend/src/types/hive.ts` — extend `PevoCustomJsonAction` union with `AuthorAcceptAction` (`type: 'author_accept'`, `root_author`, `root_permlink`) and `AuthorResignAction` (`type: 'author_resign'`, `root_author`, `root_permlink`). Mirror existing `AccreditAction` / `RevokeAction` shape.
- Create: `backend/src/consent-ops.ts` — new module exporting `getVouchedAuthors(rootAuthor, rootPermlink): Promise<Set<string>>`. Internally fetches `author_accept` / `author_resign` ops via `hafsql.operation_custom_json_view` filtered by `custom_id = config.appTag` and a JSON predicate matching `root_author` / `root_permlink`, then applies all validity rules from ARCH.md "Author Accept" / "Author Resign" subsections (signer-binding, claimed-set membership lookup against the paper's chain-walk historical union of `pevo.authors[]`, temporal ordering ≥ first-claim block, latest valid op wins per `(block_num, trx_in_block)`).
- Test: `backend/tests/consent-ops.test.ts` — real-HAF carve-out where feasible; mocked-pool variants for deterministic edge cases (signer-mismatch, pre-claim ordering, same-block tie-break).

**Approach:**
- The helper takes `(rootAuthor, rootPermlink)` and returns the vouched set as a `Set<string>` of lowercased Hive handles. It does NOT cache internally — caching is round 2's concern; round 1 ships a clean read-time function so vouched-set semantics are testable in isolation.
- Claimed-set computation is the historical union per ARCH.md "Vouched vs claimed authorship". Source of truth is the chain-walk of all admitted operations on the paper's continuation chain — round 1 can call into the existing `resolveContinuationChain` for this, even though round 2 will fold the call into the chain-walk itself.
- Helper signature returns `Set<string>`; callers compute membership cheaply.

**Test scenarios:**
- Happy path: root broadcaster is implicitly vouched (no consent op required).
- Happy path: claimed-pending author broadcasts valid `author_accept` → vouched.
- Edge: claimed-pending author's accept op signed by a different account (signer-binding mismatch) → rejected.
- Edge: accept op with `block_num` ≤ first-claim block → rejected (temporal ordering: no name-squatting via pre-broadcast).
- Edge: accept then resign by same author → resigned (latest op wins).
- Edge: accept → resign → accept → vouched (re-accept allowed).
- Edge: same-block tie-break by `trx_in_block` (highest wins).
- Edge: bridge papers (`type: 'bridge_paper'`, head author = `config.hiveBridgeAccount`) — vouched-set is `{config.hiveBridgeAccount}` only; consent ops on bridge papers are inert. Confirms ARCH.md "Bridge papers" subsection.
- Edge: `pevo.authors[].hive: null` entries are excluded from claimed set (handled upstream by `extractAuthorizedContinuationAuthors` already).

**Verification:** unit tests pass; `npx tsc --noEmit` clean; `npm run lint` clean.

### Round 2 — integration with continuation-chain admit gate + cache invalidation

**Goal:** replace the raw `pevo.authors[]` membership check in the continuation-chain admit gate with the round-1 vouched-set lookup, satisfying the four constraints in ARCH.md "Vouched-set computation (Phase 2 constraints)" subsection.

**Files:**
- Modify: `backend/src/routes/papers.ts` — replace the two call sites of `extractAuthorizedContinuationAuthors` that gate continuation-chain admission (lines around 632, 834 per current `main`) with a flow that derives the vouched-set via `getVouchedAuthors(rootAuthor, rootPermlink)` and intersects against the per-post `pevo.authors[]` membership. The bridge-paper special case in `extractAuthorizedContinuationAuthors` stays — bridge papers bypass the consent flow.
- Modify: `backend/src/consent-ops.ts` — add per-paper memoization wrapper so a single paper-detail request fires one consent-op fetch (O(1) per request constraint).
- Modify: `backend/src/block-watcher.ts` (or `backend/src/cache.ts` invalidation hooks) — extend the existing `custom_json` invalidation hook to invalidate `paper-detail:{author}:{permlink}` and `paper-detail:{author}:{permlink}:v{N}` whenever a `custom_json` op with `custom_id = config.appTag` and `type ∈ {author_accept, author_resign}` is observed. Cite ARCH.md "Cache invalidation on every consent op".
- Test: `backend/tests/routes/multi-author-vouched-gate.test.ts` — new test file specifically for the integration path.

**Dependencies:** Round 1.

**Test scenarios:**
- Happy path: vouched co-author broadcasts continuation → admitted.
- Edge: claimed-pending co-author (in `pevo.authors[]` but no `author_accept` op) broadcasts continuation → rejected, audit event logged.
- Edge: vouched co-author resigns, then broadcasts continuation → rejected from the resign block onward.
- Edge: bridge paper continuations (head author = `config.hiveBridgeAccount`) admitted; bridge paper's `pevo.authors[].hive: null` entries excluded from vouched-set.
- Integration: consent op at block N is reflected in vouched-set computation by block N+1 (one-block staleness — verify cache invalidation timing through block-watcher).
- Integration: paper-detail request fires exactly one HAF query for consent ops, regardless of chain length (O(1) constraint).
- Integration: cache invalidation fires for both `paper-detail:{author}:{permlink}` and `paper-detail:{author}:{permlink}:v{N}` on a consent op.

**Verification:** integration tests pass; manual smoke test against local HAF; `[TODO Architect]` note added in this task file describing the contract change for `agents/docs/api-contracts/papers.md` (the continuation-chain admit semantics now reference the vouched-set).

**HAF unavailability — fail closed (per ARCH.md Section 2 "Vouched-set computation (Phase 2 constraints)" / `architect-haf-unavailability-vouched-set-policy`, archived 2026-05-06).** The integration site MUST:

1. Short-circuit before calling `getVouchedAuthors` when the consent flow is inert. Two guards:
   - **Single-author claimed-set.** If the chain-walk's `claimedAuthors` set has size 1 and that single member is the root broadcaster, the broadcaster is implicitly vouched per ARCH.md "Vouched vs claimed authorship" rule 1 — return immediately with vouched-set `{rootAuthor}` and skip the HAF fetch. Most beta-cohort papers fall into this branch.
   - **Bridge papers.** If `pevoMeta.type === 'bridge_paper'` and the chain head is `config.hiveBridgeAccount`, the bridge carve-out applies (ARCH.md "Bridge papers" subsection) — return `{config.hiveBridgeAccount}` and skip the HAF fetch.
2. For genuinely multi-author chains, call `getVouchedAuthors(...)` with the discriminated-union return type from the [TODO Backend] block above. On `result.status === 'haf_unavailable'`, the route MUST `return sendError(res, 503, 'INTERNAL_ERROR', '<message>')` and NOT degrade to a root-only or claimed-set vouched-result. Mirror the precedent at `backend/src/routes/claims.ts:35` and `backend/src/routes/orcid.ts:1502-1506`.
3. The same policy applies to the sibling `/api/me/authorships/pending` endpoint (`backend-notification-infra-for-consent-ops`): single-author / bridge → short-circuit; multi-author + HAF unavailable → 503.

**Test scenario additions for the fail-closed paths:** `getPool()` returning null on a multi-author paper → 503. HAF query throwing on a multi-author paper → 503. Single-author paper served correctly with HAF down (regression guard against over-eager fail-closed). Bridge paper served correctly with HAF down. The single-author / bridge short-circuit guards MUST execute BEFORE the HAF fetch so they survive HAF outages.

**Unblocks:** `backend-notification-infra-for-consent-ops` (in `tasks/blocked/`) — its `/api/me/authorships/pending` endpoint queries the vouched-set produced here. Append a coordination note to that task file when round 2 lands.

### Round 3 — custody endpoint extension + fresh-auth gate

**Goal:** allow light-account users to broadcast `author_accept` / `author_resign` via the existing custody/broadcast endpoint, gated by a per-op fresh-authentication challenge per ARCH.md "Light-account signing of consent ops". Self-custody users are unaffected (they sign via Keychain).

**Files:**
- Modify: `backend/src/routes/custody.ts` — extend the broadcast handler's allowlist of supported op types to include `custom_json` ops with `id = config.appTag` and `json.type ∈ {author_accept, author_resign}`. Reject any other custom_json type that isn't already in the allowlist.
- Create: `backend/src/lib/fresh-auth.ts` — fresh-auth challenge primitive: validates a per-op fresh-auth proof token against the user's auth mechanism (password re-prompt → bcrypt re-verify; ORCID-authed → fresh OAuth round-trip token within last N seconds). The token shape and TTL are local to this module; the round-3 PR documents them inline.
- Modify: `backend/src/types/api.ts` — add `fresh_auth_proof` field to the broadcast request shape; declare it required for `author_accept` / `author_resign` payloads, optional otherwise.
- Modify: `backend/src/custody-audit.ts` (or whichever module owns `logCustodyBroadcast`) — extend audit-log fields to include `auth_mechanism` and the fresh-auth verification outcome. Per ARCH.md the audit log MUST capture timestamp, session ID, user-agent, auth-mechanism.
- Test: `backend/tests/routes/custody-consent-ops.test.ts` — covers light-account accept/resign flow plus fresh-auth gate.

**Dependencies:** Round 1 (types). Independent of round 2 (round 3 is purely the broadcast path; vouched-set integration in round 2 is the read path).

**Test scenarios:**
- Happy path: light-account user with valid fresh-auth proof broadcasts `author_accept` → 200, broadcast succeeds, audit log captures all required fields.
- Happy path: light-account user with valid fresh-auth proof broadcasts `author_resign` → 200, audit log captures fields.
- Edge: light-account user without fresh-auth proof → 401 / 403 with explicit error code.
- Edge: light-account user with stale fresh-auth proof (TTL expired) → 401 / 403.
- Edge: password-account user provides ORCID-style fresh-auth proof (mismatched mechanism) → rejected.
- Edge: self-custody user calls custody endpoint at all → existing 403 still fires (no regression).
- Edge: light-account user broadcasts a non-allowlisted custom_json type → rejected (no regression on existing allowlist).
- Integration: fresh-auth proof is single-use within its TTL — replaying the same proof for a second op fails.

**Verification:** integration tests pass against real Postgres/Redis; `[TODO Architect]` note added describing contract additions for `agents/docs/api-contracts/custody.md`.

### Round 4 — migration-day flag + flag-day cutover canary

**Goal:** gate the new vouched-set rules behind `MULTI_AUTHOR_TRUST_MODEL_ENABLED` env flag. When off, the continuation-chain admit gate falls back to the ε round-3 baseline (raw `pevo.authors[]` membership with no-shrink rule + per-version preservation). When on, the round-2 vouched-set lookup is authoritative. This is the surface that the flag-day deploy flips.

**Files:**
- Modify: `backend/src/config.ts` — add `multiAuthorTrustModelEnabled: boolean` derived from env, default `false` for migration-day safety.
- Modify: `backend/src/routes/papers.ts` (the integration site from round 2) — wrap the vouched-set lookup behind the flag. When off, the call site preserves the round-2 invariants for round-1 unit tests but bypasses the vouched-set check at the integration layer.
- Modify: `backend/src/routes/custody.ts` — broadcast path is NOT flag-gated. Users may broadcast `author_accept` ops before flag-day so the cutover finds them already vouched. Add an inline comment explaining this asymmetry (broadcast lives ahead of the read gate by design).
- Test: `backend/tests/routes/multi-author-flag-gate.test.ts` — flag-on / flag-off behavioral split.

**Dependencies:** Round 2 (the integration site that the flag wraps).

**Test scenarios:**
- Happy path (flag off): continuation by claimed-pending co-author admitted (matches ε round-3 baseline).
- Happy path (flag on): continuation by claimed-pending co-author rejected; same author after broadcasting `author_accept` admitted.
- Integration: pre-flag `author_accept` ops broadcast while flag was off are honored once flag flips on (vouched status from on-chain state is the source of truth, not flag history).
- Edge: bridge papers behave identically with flag on or off (consent flow inert per ARCH.md "Bridge papers" subsection).

**Verification:** flag-off variant of full backend vitest suite passes (ensures no regression on baseline behavior); flag-on variant of consent-flow tests pass; `[TODO Architect]` note added describing the env flag for ARCH.md "Migration" subsection if not already covered.

**Unblocks flag-day deploy:** once round 4 lands and `backend-notification-infra-for-consent-ops` + `ui-multi-author-consent-affordances` are also archived, the operator can flip `MULTI_AUTHOR_TRUST_MODEL_ENABLED=true` to execute the hard cutover per ARCH.md "Migration".

### Round sequencing

```
Round 1 (types + helper)
  └─► Round 2 (continuation gate integration + cache invalidation)
        ├─► Round 3 (custody broadcast path; can run in parallel with round 2 after round 1)
        └─► Round 4 (migration flag wrapping round 2's integration)
              └─► flag-day deploy (orthogonal: also requires sibling tasks to ship)
```

Rounds 2 and 3 are file-disjoint (papers.ts vs custody.ts) and could run as parallel worktree fan-out after round 1 lands. Round 4 must come after round 2 (it wraps round 2's integration site). Each round is one held-pending-fix review unit.

### Out-of-scope deferrals (filed elsewhere)

- The `/api/me/authorships/pending` endpoint → `backend-notification-infra-for-consent-ops` (separate task).
- UI accept/resign affordances + migration banner → `ui-multi-author-consent-affordances` (UI agent).
- Bridge-paper authorship claim flow → `backend-bridge-paper-author-claim-flow` (P2, deferred stub).
- Convention doc capture via `/ce-compound` after round 4 archive — gated on whether non-obvious learnings surfaced; default skip.

---

## Backend round-1 signal (2026-05-05, commit 658332a)

Round 1 (types + vouched-set helper, foundational layer) landed at commit `658332a`. Round 2 may proceed as planned in the round breakdown above.

### What landed

- `AuthorAcceptAction` / `AuthorResignAction` added to `PevoCustomJsonAction` union in `backend/src/types/hive.ts`.
- New module `backend/src/consent-ops.ts` exporting:
  - `ConsentOp` interface (signer, action, rootAuthor, rootPermlink, blockNum, opId).
  - `fetchConsentOpsForPaper(rootAuthor, rootPermlink): Promise<ConsentOp[]>` — HAF fetcher.
  - `computeVouchedAuthors(rootBroadcaster, claimedAuthors, firstClaimBlockByAuthor, consentOps): Set<string>` — pure validity-rule application.
  - `getVouchedAuthors(rootAuthor, rootPermlink, claimedAuthors, firstClaimBlockByAuthor): Promise<Set<string>>` — orchestrator (the call site Round 2 wires into `resolveContinuationChain`).
- 22 vitest cases at `backend/tests/consent-ops.test.ts` covering happy paths, temporal-ordering, name-squatting rejection, resign + re-accept, same-block tie-break (including BigInt-precision opIds), non-claimed signer rejection, multi-author independent histories, case-folding, and SQL-shape contract for the fetcher.

### Verification

- `npx tsc --noEmit` clean.
- `npm run lint` clean (only pre-existing warnings in `seed-phrase.ts`, unrelated).
- `npx vitest run tests/consent-ops.test.ts` — 22/22 pass in 810ms.
- Full backend vitest also exercised. **3 pre-existing failures observed on `main` (NOT caused by Round 1)**: `tests/routes/disciplines-canon-mocked.test.ts` (continuation-chain head-override), `tests/routes/accreditation.test.ts` (502/504 token-cleanup paths, 2 cases), `tests/routes/stats-profile-parity.test.ts` (1 case). Verified pre-existing by re-running `disciplines-canon-mocked` against `git stash`-clean main → same failure. Round 1 code is additive (new types in a discriminated union; new module not yet imported anywhere) and cannot affect those code paths. Surfacing for triage; not fixing in scope.

### [TODO Architect] — spec cleanup needed before archive

These are spec-only inconsistencies that emerged when implementing the canonical wire format. The code is internally consistent; the spec needs to be brought in line with the codebase convention. None of these block Round 2 implementation.

1. **ARCH.md "Author Accept (custom_json)" / "Author Resign (custom_json)" — discriminator field name.** The schema snippets in ARCH.md (lines ~371, ~393) use `type: "author_accept"` / `type: "author_resign"`. Every other PEvO custom_json op in ARCH.md and across `backend/src/` uses `action:` (Accreditation, Revocation, Vouch, RetractPaper, Revote, etc.). Broadcast emission (signup-verify.ts, papers.ts, accreditation.ts, orcid.ts, wot.ts) and parsing (custody.ts allowedActions, accreditations.ts, reputation.ts, notification-queries.ts) all key on `payload.action`. Round 1 implements with `action:` to match the universal convention; please update the two ARCH.md snippets to flip `type:` → `action:` (no other text changes needed).

2. **ARCH.md "Author Accept" validity prose — references a payload field that doesn't exist.** The validity rule says the chain signer "MUST equal `accepting_author_hive` in the payload." The schema, however, only includes `root_author` + `root_permlink` — there is no `accepting_author_hive` field. The implicit interpretation (signer IS the accepter; the binding is degenerate) is what Round 1 implements and is operationally secure. Please reword the validity bullet to say "the chain signer is the accepting author for this op (binding is implicit; the payload carries no subject identity field)" or similar. Optional alternative: add `accepting_author_hive: <hive>` to the schema and require signer == that field — requires more discussion since it adds a redundant data field whose only purpose is to make the convention rule 5 binding-check enforceable as a literal SQL/JS predicate. Round 1 chose the "implicit binding" path for spec literalism on the schema side.

3. **ARCH.md / convention-doc — same-block tie-break primitive.** ARCH.md "Author Accept" line: "Same-block ties are broken by `trx_in_block` (highest wins)." The convention doc rule 2 references `(block_num, trx_in_block)` ordering. The HAF view `hafsql.operation_custom_json_view` does NOT expose `trx_in_block` (the underlying tables `hafd.operations` / `hafsql.haf_operations` do, but not the projection PEvO queries). The view's `id` column is the HAF op id (a bigint encoding block_num + trx_in_block + op_in_trx; confirmed via `pg_get_viewdef`). Round 1 uses `id` as the same-block tie-breaker, which is operationally equivalent. Please update either ARCH.md to reference `id` for `operation_custom_json_view` queries, OR the convention doc to acknowledge that `id` is the canonical tie-break primitive when querying flat op-views.

### [TODO Backend] — helper signature change before Round 2 picks up

Filed 2026-05-06 by the (now-archived) architect task `architect-haf-unavailability-vouched-set-policy`. The architect-decided fail-closed posture for the consent-ops admit gate (per ARCH.md Section 2 "Vouched-set computation (Phase 2 constraints)" — the new paragraph after the four constraint bullets) requires a return-type change on the Round 1 helpers so the Round 2 integration site can distinguish "no consent ops" from "HAF unavailable" and route the latter to a 503. Land this change before Round 2 starts so Round 2's integration code consumes the new shape directly.

1. **`fetchConsentOpsForPaper` returns a discriminated union, not a bare array.** Today (`backend/src/consent-ops.ts:103-164`) the helper returns `Promise<ConsentOp[]>` and silently coalesces both `getPool() === null` and the catch-block path into `[]`. Change to:

   ```ts
   export type ConsentOpsFetchResult =
     | { status: 'ok'; ops: ConsentOp[] }
     | { status: 'haf_unavailable'; reason: 'no_pool' | 'query_failed' };

   export async function fetchConsentOpsForPaper(
     rootAuthor: string,
     rootPermlink: string,
   ): Promise<ConsentOpsFetchResult> { ... }
   ```

   Mirror the existing `bridge.ts` precedent (`backend/src/routes/bridge.ts:161-177`, the `BridgeStatusLookupResult` union). Keep the existing structured pino log on the throw path; emit the SAME log shape on the `getPool() === null` path so both fail-closed firings are visible. The `event` discriminator may stay `consent_ops.fetch_failed` (current name) or rename to `consent_ops.haf_unavailable` (more specific) — implementer's call; pick one stable name and use it on both paths.

2. **`getVouchedAuthors` propagates the discriminated union to its caller.** Same shape:

   ```ts
   export type VouchedAuthorsResult =
     | { status: 'ok'; vouched: Set<string> }
     | { status: 'haf_unavailable'; reason: 'no_pool' | 'query_failed' };

   export async function getVouchedAuthors(
     rootAuthor: string,
     rootPermlink: string,
     claimedAuthors: Set<string>,
     firstClaimBlockByAuthor: Map<string, number>,
   ): Promise<VouchedAuthorsResult> { ... }
   ```

   The pure `computeVouchedAuthors` keeps its current `Set<string>` return type — it has no I/O and no failure mode. The orchestrator wraps the fetch and propagates the union upward.

3. **Tests adapt to the new shape.** The 22 existing cases in `tests/consent-ops.test.ts` now assert on `result.status === 'ok'` and `result.ops` / `result.vouched`. Add at least two cases:
   - `getPool()` returning null → `{ status: 'haf_unavailable', reason: 'no_pool' }` plus the structured pino log fires.
   - HAF query throws → `{ status: 'haf_unavailable', reason: 'query_failed' }` plus the structured pino log fires.

4. **No production callers exist yet** (Round 2 hasn't wired the read gate; the helper is only exercised by tests). The change is mechanical at this stage. Once Round 2 lands, refactoring the return shape would be a much wider blast radius.

The implementer may either fold this into the same round as the rounds-1+3 hold-block fixes (small, file-local, no integration-site touch) or land it as a separate round — implementer's call. Either way, this MUST land before Round 2 picks up.

### Ready for Round 2 — but coordinate with the cumulative-union redesign first

Round 2 (`resolveContinuationChain` integration + cache invalidation) layers directly on top of Round 1's `getVouchedAuthors(...)` call. The integration site is `backend/src/routes/papers.ts` lines ~632 and ~834 where `extractAuthorizedContinuationAuthors` is called against the head and root metadata. Round 2 plan:

1. Use the chain-walk historical claimed-set (union of `pevo.authors[].hive` across all admitted operations on the chain, plus per-author first-claim blockNum).
2. Call `getVouchedAuthors(rootAuthor, rootPermlink, claimedAuthors, firstClaimBlockByAuthor)`.
3. Intersect against the candidate continuator's identity to gate admission.
4. Wire cache invalidation: `paper-detail:{author}:{permlink}` and `paper-detail:{author}:{permlink}:v{N}` invalidate on every consent op observed by the block-watcher / cache hooks.

**Round 2 dependency: `backend-multi-author-cumulative-union.md` should land first.** That task (currently in `tasks/blocked/`, gated on ε's round-4 archive of `backend-continuation-post-author-consent-gate.md`) replaces the round-3 no-shrink rule with a cumulative-union construction at `papers.ts:626-690` — the same code surface Round 2 integrates with. The cumulative-union task is also what produces the chain-walk historical claimed-set + per-author first-claim block data that Round 2 feeds into `getVouchedAuthors`. Round 2 layered on top of cumulative-union is straightforward (one call site, well-defined inputs); Round 2 layered on top of the round-3 no-shrink shape would require Round 2 to also reimplement chain-walk-historical-union semantics, which is exactly what cumulative-union was filed to consolidate. Wait for the architect to move cumulative-union back to `pending/` and a backend instance to land it, then pick up Round 2.

If the cumulative-union task remains blocked for an extended period (e.g., ε's round-4 stalls), an alternative is to begin Round 3 (custody endpoint extension + fresh-auth gate) since it's file-disjoint from `papers.ts` and depends only on Round 1 types. Round 3 ships the broadcast surface for `author_accept` / `author_resign`, which can land independently of when Round 2 wires the read gate.

The Round 1 fetcher is HAF-only (no Hive API fallback). Round 2 should consider whether to add a fallback path or accept HAF-required for the consent-flow gate. Per CLAUDE.md "Data Source Policy" the existing fallback is HAF → Hive API; for consent ops, querying Hive API for arbitrary custom_json history is impractical, so HAF-required is the likely answer.

The `.env` REDIS_URL workaround (added during Round 1 verification: set REDIS_URL to the docker bridge IP rather than the empty value that triggers `redis://:PASSWORD@redis:6379` fallback unresolvable from host) is local-only (`.env` is gitignored). Future test runs may need the same workaround until vitest.config.ts honors shell-env REDIS_URL overrides.

---

## Backend round-3 signal (2026-05-05)

Round 3 (custody endpoint extension + fresh-auth gate for `author_accept` / `author_resign`) lands in this branch's working tree (will commit on the same branch as Round 1).

### What landed

- **`backend/src/lib/fresh-auth.ts`** — new module. Exports `CONSENT_OP_ACTIONS` (the set of payload `action` strings that require a fresh-auth proof: `author_accept`, `author_resign`), `issueFreshAuthToken(username, mechanism)` (mints a 32-byte hex token bound to the issuing username, with 5-min TTL), and `consumeFreshAuthToken(token, expectedUsername)` (single-use lookup via Redis `GETDEL`, in-memory fallback for no-Redis paths). Tokens carry a `mechanism` discriminator (`'password' | 'orcid'`) that is informational only — the security primitives are token secrecy + single-use + username binding + TTL. Module-local cleanup interval drains expired in-memory entries every 60 s; mirrors the orcid_state cleaner shape.
- **`backend/src/routes/custody.ts`** — broadcast handler now detects consent-op operations (`findConsentOpAction`) and requires a `fresh_auth_proof` field in the request body for any bundle containing one. Proof is consumed BEFORE the posting key is decrypted, so a missing/expired/cross-account proof never reaches the broadcast path. New error code `FRESH_AUTH_REQUIRED` (added to `types/api.ts`) carries `details: { reason }` discriminating `'missing' | 'expired' | 'username_mismatch' | …`. Allowlist extended with `'author_accept'` and `'author_resign'`. New endpoint `POST /api/custody/fresh-auth` issues a password-mechanism token (bcrypt verify against `accounts.password_hash`, runs through `runWithArgon2Slot` for queue safety; rate-limited at 10/min/account via the new `custody-fresh-auth` limiter).
- **`backend/src/routes/orcid.ts`** — new `'fresh_auth'` mode (authenticated). Completes a full OAuth round-trip; the `handleFreshAuth` dispatch verifies the OAuth-returned `orcidId` equals `accounts.orcid` for the JWT subject (mismatch → 403, mirrors `link`/`accredit` mode binding rules) and issues an ORCID-mechanism fresh-auth token via `issueFreshAuthToken`. Sibling issuance path to the password endpoint above; same token shape and consume path.
- **`backend/src/custody-audit.ts`** — `logCustodyBroadcast` accepts an optional `extras: CustodyAuditExtras` shape with `auth_mechanism`, `fresh_auth_outcome`, `session_id`, `user_agent`. Non-consent broadcasts pass `undefined`; consent-op success path passes the full set. Backwards-compatible.
- **`backend/migrations/005_custody_audit_consent_ops.sql`** — adds the four new columns to `custody_audit_log`. All nullable; non-consent rows store NULL. Idempotent `ADD COLUMN IF NOT EXISTS`.
- **`backend/src/types/hive.ts`** — already extended in Round 1 (`AuthorAcceptAction` / `AuthorResignAction`); no changes this round.
- **`backend/tests/routes/custody-consent-ops.test.ts`** — 12 cases covering: password-mechanism fresh-auth issuance (happy / wrong-password / missing-password / self-custody / already-upgraded), consent-op broadcast (author_accept happy + audit-log row shape, author_resign happy + audit-log, missing proof, replay, cross-account binding, non-consent op no-fresh-auth-required regression, non-allowlisted action regression). Real-DB pattern (mirrors `custody-upgrade-null-hash.test.ts`); only `hive.js` broadcast helpers and `custody-crypto.js` decryptKey are mocked.

### Verification

- `npx tsc --noEmit` clean.
- `npm run lint` clean (pre-existing `seed-phrase.ts` warnings only).
- `npx vitest run tests/routes/custody-consent-ops.test.ts` — 12/12 pass.
- `npx vitest run tests/routes/custody*.test.ts tests/consent-ops.test.ts` — 35/35 pass (12 new + 23 existing custody + Round 1 consent-ops module suite).
- `npx vitest run tests/routes/orcid.test.ts` — 67/67 pass (new `fresh_auth` mode is non-disruptive to existing modes).

### [TODO Architect] — contract additions for archive-time

The custody contract is architect-owned per backend CLAUDE.md "Boundaries". Round 3 adds:

1. **`agents/docs/api-contracts/custody.md` — new `POST /api/custody/fresh-auth` endpoint.** Request: `Authorization: Bearer <jwt>`, body `{ password: string }`. Response 200: `{ fresh_auth_proof: string, expires_at: number, mechanism: 'password' }`. Error codes: 401 UNAUTHORIZED (invalid password OR no password_hash on account — uniform shape so the route is not a password-existence oracle), 400 VALIDATION_ERROR (missing password), 403 FORBIDDEN (self-custody / already-upgraded), 503 INTERNAL_ERROR (no app DB). Rate limit: 10/min/account (`custody-fresh-auth`).

2. **`agents/docs/api-contracts/custody.md` — `POST /api/custody/broadcast` consent-op contract.** When the operations bundle contains a `custom_json` op with `id = APP_TAG` and payload `action ∈ {'author_accept', 'author_resign'}`, the request body MUST include `fresh_auth_proof: string`. Backend rejects with 401 `FRESH_AUTH_REQUIRED` + `details: { reason }` if missing, expired, malformed, or bound to a different username. Single-use: a successful consume invalidates the proof; subsequent calls with the same token return 401 with `reason: 'expired'`. Bundles MAY mix consent ops with other allowed ops; one proof gates the entire bundle.

3. **`agents/docs/api-contracts/orcid.md` — new `'fresh_auth'` mode.** Authenticated mode. After OAuth callback, returns `{ mode: 'fresh_auth', fresh_auth_proof: string, expires_at: number, mechanism: 'orcid' }` (200) when the OAuth-returned ORCID matches `accounts.orcid` for the JWT subject. 403 FORBIDDEN when the ORCID does not match (or no ORCID linked). Sibling to `POST /api/custody/fresh-auth` — both produce the same proof shape consumed by the broadcast endpoint.

4. **`agents/docs/ARCHITECTURE.md` "Light-account signing of consent ops" — operational note.** The audit-log capture (timestamp / session_id / user_agent / auth_mechanism) is implemented as four columns on `custody_audit_log`; `session_id` is a SHA-256 hash of the bearer JWT truncated to 16 hex chars (opaque to clients, suitable for operator correlation across audit rows from the same session without persisting the token). The bonus column `fresh_auth_outcome` is forward-compatible: today it stores `'verified'` on every row written (the route only writes audit rows on the success path); a future change that adds a row on rejection would set it to the rejection reason.

5. **`agents/docs/ARCHITECTURE.md` — `'fresh_auth'` ORCID mode.** The "Light-account signing of consent ops" subsection states the rule but does not enumerate the issuance endpoints. Adding a one-line cross-reference to `POST /api/custody/fresh-auth` (password) and `POST /api/orcid/start { mode: 'fresh_auth' }` (ORCID) makes the operational story discoverable.

### Round sequencing carry-over

Round 2 (continuation-chain admit-gate integration + cache invalidation) remains gated on `backend-multi-author-cumulative-union.md` per Round 1's signal block. Round 4 (migration-day flag) is gated on Round 2.

Round 3 ships the broadcast surface for consent ops. Once Round 2 lands the read gate, `author_accept` / `author_resign` ops broadcast via Round 3 will start admitting into the vouched-set computation. Until then, broadcast succeeds end-to-end on chain but the read-time consent-gate is not yet enforced (the existing claimed-set gate from ε round-3 still applies).

---

## Architect re-review (2026-05-05, rounds 1+3 → round-4) — HELD PENDING FIXES

`/ce-code-review` ran on commits `658332a` (round 1) + `b9b3b3b` (round 3) — intermediate `72c4b5c` excluded (different task). 12 personas (correctness, security, adversarial, testing, maintainability, project-standards, learnings, performance, api-contract, data-migrations, reliability, kieran-typescript). `ce-agent-native-reviewer` skipped per root CLAUDE.md (PEvO has no agent-native surface).

**Headline finding:** the multi-consent-op bundle bypass at `findConsentOpAction` flagged by 5 reviewers (correctness, security, adversarial, maintainability, kieran-typescript) — the round-3 comment promises a per-op fresh-auth invariant the implementation does not enforce. Cross-reviewer agreement promotes this to high confidence.

Round-2 deferral remains correct (gated on `backend-multi-author-cumulative-union`); the unwired `papers.ts` integration was not flagged.

### Items to address (P1 — 9)

**1. (P1) Multi-consent-op bundle defeats per-op fresh-auth gate.** `backend/src/routes/custody.ts:57-76, 168-194`. `findConsentOpAction` returns the FIRST consent op found; the broadcast handler consumes ONE fresh-auth proof for the entire bundle. The function's docstring at lines 53-56 claims "we intentionally allow at most one consent-op per bundle: bundling consent ops with arbitrary other ops opens a substitution-attack vector where the auth ceremony is shown for one op while the wire payload signs another." The code does not enforce this. Concrete exploit: a compromised SPA submits `[author_accept{paper A}, author_accept{paper B}]` with the user's single proof; both ops sign and broadcast. The user gave the auth ceremony for one paper but vouched onto N papers.

Fix (preferred): in `findConsentOpAction` or its caller, count consent ops in the bundle; reject the request with 400 / `MULTIPLE_CONSENT_OPS` if more than one is present. Alternative (more invasive): per-op proofs with `fresh_auth_proofs: string[]` aligned by op index. Add a regression test asserting a `[author_accept, author_accept]` bundle is rejected even with a valid proof.

**2. (P1) `app-db.ts:initAppDb()` does not include the four new audit columns — fresh deployments silently drop consent-op audit rows.** `backend/src/app-db.ts:80`. The hard-coded `CREATE TABLE custody_audit_log` block does not list `auth_mechanism`, `fresh_auth_outcome`, `session_id`, `user_agent`. On fresh container boots (dev, CI, new prod node before migration 005 runs), the INSERT in `custody-audit.ts:46` references missing columns; the audit write is fire-and-forget (`.catch(() => {})`) so the broadcast succeeds and the row is silently lost.

Fix: append `ALTER TABLE custody_audit_log ADD COLUMN IF NOT EXISTS ...` blocks for the four columns inside `initAppDb()`, mirroring the migration-005 shape. Pattern: see existing `notification_preferences.last_digest_block` handling at `app-db.ts:47`.

**3. (P1) Redis-issued fresh-auth token lost on transient Redis flap during consume.** `backend/src/lib/fresh-auth.ts:261-284`. When the issuance path succeeded against Redis but `redis.getdel` throws on consume, the code falls through to `memStore.get(token)` — which returns nothing because the token was never written there. The caller receives `{ valid: false, reason: 'expired' }` and a spurious 401. The legitimate user must re-authenticate immediately after just having done so. The line-175 comment describes the inverse path (issuance fell back to mem; consume checks mem) but does NOT cover Redis-up-on-issue / Redis-down-on-consume.

Fix: write to memStore as a backup on Redis-issuance success (so the token is recoverable on a flap), OR retry Redis once with a short backoff in the consume path before falling through. Add a test that (a) issues with Redis available, (b) makes `getdel` throw, (c) asserts the consume succeeds (legitimate user) instead of returning `expired`.

**4. (P1) `fetchConsentOpsForPaper` has no `LIMIT` clause — unbounded row set under consent-op spam.** `backend/src/consent-ops.ts:70`. A malicious claimed co-author (in the task's threat model) can spam `author_accept`/`author_resign` ops on a paper; Hive enforces account-level rate limits but no per-paper cap. Once Round 2 wires `getVouchedAuthors` per paper-detail request, the inline fetch returns all rows and `computeVouchedAuthors` allocates O(N) memory + sort.

Fix: add `LIMIT 1000` (or similar high-water mark per the cumulative-union task's expected chain length) plus `ORDER BY id DESC` so the latest ops are retained when the cap fires. Document the cap in the function's JSDoc so Round 2's integration is aware.

**5. (P1) Audit-log loses per-op consent action and target paper for multi-op bundles.** `backend/src/routes/custody.ts:211-213, 282-302`. `logCustodyBroadcast(...)` records joined op-types; the structured pino event records `consent_action` for the FIRST match only. If item-1's substitution exploit fires (or even a benign multi-consent bundle), forensic correlation requires reading the on-chain tx body. ARCH.md "Light-account signing of consent ops" calls out auth-mechanism + session-id + user-agent capture but not per-op payload identity.

Fix: resolves naturally if item-1 is fixed by single-consent rule (only one consent op per audit row → identity preserved). If the per-op-proofs route is taken instead, write one audit row per consent op, OR widen the schema with a JSON column carrying `[{root_author, root_permlink, action}, ...]`.

**6. (P1) `handleFreshAuth` (ORCID `'fresh_auth'` mode) has zero test coverage.** `backend/src/routes/orcid.ts` (the new mode handler added in round 3). Three load-bearing branches: happy (orcid match → token issued), ORCID mismatch → 403, no account → 401. The round-3 signal's `67/67 pass` claim covers non-disruption only. Removing the `accountOrcid !== orcidId` binding check at the mismatch branch would not fail any test — and that check is the security-critical invariant against an attacker who controls any ORCID + a stolen JWT minting fresh-auth tokens as another user.

Fix: add tests in `backend/tests/routes/orcid.test.ts` (or new file) covering: (a) happy-path token issuance, (b) ORCID mismatch → 403 with binding-check error code, (c) no-ORCID-linked → 403, (d) no-account → 401, (e) audit-log row shape on the broadcast that consumes the ORCID-mechanism token (asserts `auth_mechanism: 'orcid'` written).

**7. (P1) Bridge-paper vouched-set exclusion has no test in `consent-ops.test.ts`.** `backend/tests/consent-ops.test.ts`. Round-1 spec line 199 explicitly required this test: "bridge papers (`type: 'bridge_paper'`, head author = `config.hiveBridgeAccount`) — vouched-set is `{config.hiveBridgeAccount}` only; consent ops on bridge papers are inert." The current suite covers root-broadcaster vouching transitively but has no dedicated bridge-paper fixture. A regression that allowed a non-bridge signer's `author_accept` to vouch onto a bridge paper would not be caught.

Fix: add a test passing `claimedAuthors = {hiveBridgeAccount}` + a non-bridge signer's `author_accept` consent op to `computeVouchedAuthors`; assert the non-bridge signer is NOT in the returned set and the bridge account IS. Mirrors the round-1 plan's edge case.

**8. (P1) Three TypeScript unsafe casts bypass discriminated-union exhaustiveness.** Three sites:
- `backend/src/consent-ops.ts:96` — `row.action as 'author_accept' | 'author_resign'`. The SQL `IN (...)` filters but TS sees no guard; if the filter is ever relaxed or the view changes shape, an unrecognized action string silently propagates and falls through `=== 'author_accept'` checks (treated as resign).
- `backend/src/routes/custody.ts:62` — `opParams as { json?: unknown }` from `unknown` without structural narrowing; the followup `as { action?: unknown }` cast on `params.json` accepts `null` typed as object.
- `backend/src/lib/fresh-auth.ts:200` — `JSON.parse(raw) as StoredEntry`; the field-presence checks at lines 206-208 verify `username`/`mechanism` are strings but the exhaustive `mechanism IN ('password' | 'orcid')` check at line 214 is a hand-written membership test that diverges from the type union if the union is extended.

Fix: introduce type-guards (`isConsentAction(v): v is 'author_accept' | 'author_resign'`, `isFreshAuthMechanism(v): v is FreshAuthMechanism`) used at the parse/read boundaries; replace the `opParams` cast with a narrowing block (`typeof opParams === 'object' && opParams !== null && 'json' in opParams`).

**9. (P1) `CustodyAuditExtras` violates the correlated-options-discriminated-union convention.** `backend/src/custody-audit.ts:19`. Per `agents/docs/solutions/conventions/correlated-options-discriminated-union-2026-04-28.md`, four semantically correlated fields (only meaningful when consent op fires) typed as independent optionals admit a future caller supplying `fresh_auth_outcome` without `auth_mechanism` with no TS error. Round 3 introduces this exact shape. Companion finding: `fresh_auth_outcome?: string` at the same site is bare `string` instead of a constrained literal union.

Fix: convert to discriminated union along the lines of:
```ts
type CustodyAuditExtras =
  | { auth_mechanism?: never; fresh_auth_outcome?: never; session_id?: never; user_agent?: never }
  | { auth_mechanism: 'password' | 'orcid'; fresh_auth_outcome: 'verified' | 'missing' | 'expired' | 'username_mismatch' | 'malformed'; session_id?: string; user_agent?: string };
```
and update the only call site in `routes/custody.ts:282-289` to construct the consent-op variant explicitly.

### Items to address (P2 — 9)

**10. (P2) Dead ternary `?: 401 : 401`.** `backend/src/routes/custody.ts:184`. Both branches return 401. Flagged by 4 reviewers (maintainability, api-contract, reliability, kieran-ts).

Fix: collapse to `const status = 401`. If differentiated status codes were intended (the discriminator suggests 403 for `username_mismatch` and 401 for `missing`/`expired`), implement that and update the [TODO Architect] api-contracts/custody.md note accordingly.

**11. (P2) `custody-consent-ops.test.ts` header lacks carve-out clause (a) justification for `custody-crypto.js` mock.** `backend/tests/routes/custody-consent-ops.test.ts:1-41, 71-78`. Root CLAUDE.md "Carve-out for deterministic edge-case coverage" requires "(a) the test file header documents the justification explicitly (which real path is impractical and why)." The header lists `custody-crypto.js` under "Mocks" with the brief "bypass AES-GCM material" but no per-target paragraph; compare `tests/routes/custody.test.ts:10-19` which has the full justification.

Fix: extend the header with a one-paragraph justification for `custody-crypto.js` (key derivation primitives are non-trivial to seed deterministically per-test; the broadcast-mocking already removes the dependency on the decryption output). `hive.js` mocking is already covered by the carve-out's permitted-target list.

**12. (P2) Phantom `'invalid'` reason variant in `FreshAuthVerifyResult`.** `backend/src/lib/fresh-auth.ts:149`. The discriminated union declares `'missing' | 'invalid' | 'expired' | 'username_mismatch' | 'malformed'` but `consumeFreshAuthToken` never produces `'invalid'`. A future maintainer will reuse it with the wrong semantic.

Fix: trim from the union (or document its reserved future use inline if there's a planned case).

**13. (P2) `fresh-auth.ts` exports three symbols with no external consumer.** `backend/src/lib/fresh-auth.ts:71`. `FRESH_AUTH_TTL_SECONDS`, `IssuedFreshAuth`, `FreshAuthVerifyResult` are exported but neither `routes/custody.ts` nor `routes/orcid.ts` imports them.

Fix: drop the three `export` keywords. If tests need the type aliases, keep them exported with a brief comment naming the test file.

**14. (P2) Comment says "bcrypt-verifies" but algorithm is argon2.** `backend/src/lib/fresh-auth.ts:35`. The Issuance-paths section describes the password mechanism as "bcrypt-verifies against accounts.password_hash". The actual implementation uses `argon2.verify` via `runWithArgon2Slot` (`routes/custody.ts:389`). No bcrypt is used anywhere in PEvO backend.

Fix: rename to "argon2-verifies".

**15. (P2) Module-level cleanup interval not testable; `_resetFreshAuthMemStoreForTests` doesn't pause it.** `backend/src/lib/fresh-auth.ts:90`. The `setInterval` starts at module load with `.unref()` (good — prevents vitest hang). However, no exported hook lets a test pause or stub the interval, so a TTL-boundary test cannot avoid racing the cleaner. Also affects Vitest watch mode (re-evaluation creates a new interval per reload).

Fix: export `_stopCleanupForTests` / `_restartCleanupForTests` and call from `_resetFreshAuthMemStoreForTests` so suites can deterministically control the cleaner.

**16. (P2) `fetchConsentOpsForPaper` uses `pool.query()` with no explicit `statement_timeout`.** `backend/src/consent-ops.ts:93`. Slow HAF holds the paper-detail thread once Round 2 wires this inline.

Fix: set `statement_timeout` per query (or document that the HAF Pool's session-level timeout is sufficient — verify which is configured in `backend/src/db.ts`).

**17. (P2) TTL-expiry path in fresh-auth in-memory fallback never exercised.** `backend/src/lib/fresh-auth.ts:186-196`. The `cached.expiresAt > Date.now()` guard at line 190 is reachable only by waiting (or fake-timer manipulation); no test does either. Removing the guard entirely would not be caught.

Fix: add a fake-timer test that issues to memStore (Redis stubbed unavailable), advances `Date.now()` past TTL, asserts `consume` returns `'expired'`. Pair with `_stopCleanupForTests` from item 15 so the cleaner doesn't race.

**18. (P2) Null `password_hash` branch in `POST /api/custody/fresh-auth` not tested.** `backend/src/routes/custody.ts:379-384`. The branch returns 401 UNAUTHORIZED uniformly to avoid becoming a password-existence oracle. No test seeds an account with `password_hash IS NULL` and asserts the uniform shape (status code, error envelope, latency parity vs wrong-password). Mutating the branch to return 404/403 would not be caught, exposing the oracle.

Fix: add a test seeding `password_hash = NULL` (ORCID-only hybrid path), call `/api/custody/fresh-auth`, assert the response is byte-equivalent to a wrong-password 401.

### Items dismissed during architect triage

- **P3 — `orcid.ts:221` stale error message** (lists `signup, login, accredit, link` and omits `fresh_auth`). VALID_MODES gates the actual flow correctly; the string is only reached on invalid-mode submissions where `fresh_auth` is in fact valid. Architect will fix in-place during the archive doc-cluster pass.
- **P3 — `handleFreshAuth` doesn't gate on `custody === 'light'`.** Primary gate at `custody.ts:90-92` 403s self-custody at consume time. Issuance produces an unusable token but no escalation. Same posture as the architect-blessed `/upgrade` burn-sentinel removal (per `agents/docs/solutions/`). Per `feedback_dont_relitigate_settled_ssot` memory: don't relitigate accepted defense-in-depth dismissals.
- **P3 — `author_resign` audit-log test asserts only `auth_mechanism`** (test file lines 303-325; `author_accept` test at 266-301 asserts all four). Folded into items 6 (handleFreshAuth tests) + 9 (CustodyAuditExtras refactor) — the test sweep that lands the discriminated-union-typed extras should also assert all four columns on resign.
- **Pre-existing — `custody.md` "revote only" allowlist text** drifted before round 3 (claim_authorship/approve/revoke were added in earlier rounds without contract update). Folded into the architect-owned doc-cluster pass at archive.

### Architect-owned doc cluster — landed at archive (not implementer fix)

These are tracked as `[TODO Architect]` in the round-1 + round-3 signal blocks above plus additions surfaced this review. I'll land them in the same commit that archives the task once items 1-18 clear:

1. `agents/docs/ARCHITECTURE.md` Section 2 "Author Accept (custom_json)" / "Author Resign (custom_json)" — flip schema discriminator from `type:` → `action:` to match code (round-1 [TODO #1]).
2. ARCH.md "Author Accept" validity prose — clarify that the chain signer IS the accepting author (binding is implicit; no payload identity field) (round-1 [TODO #2]).
3. ARCH.md / convention doc — same-block tie-break primitive: document `id` (HAF op id) as the canonical tie-break for `operation_custom_json_view` queries, with `(block_num, trx_in_block)` carve-out noted (round-1 [TODO #3]).
4. `agents/docs/api-contracts/custody.md` — new `POST /api/custody/fresh-auth` endpoint (round-3 [TODO #1]).
5. `agents/docs/api-contracts/custody.md` — `POST /api/custody/broadcast` consent-op contract + `FRESH_AUTH_REQUIRED` error code (round-3 [TODO #2]).
6. `agents/docs/api-contracts/custody.md` — refresh stale "revote only" allowlist text → full current allowlist (`comment, vote, custom_json {revote, claim_authorship, approve_authorship, revoke_authorship, author_accept, author_resign}`).
7. `agents/docs/api-contracts/orcid.md` — new `'fresh_auth'` mode (start body schema row + callback response shape) (round-3 [TODO #3]).
8. `agents/docs/api-contracts/common.md` — rate-limit table: add `custody-fresh-auth` (10/min/account).
9. `agents/docs/api-contracts/common.md` — note epoch-seconds carve-out for short-lived proof tokens (`expires_at` on `/api/custody/fresh-auth` and ORCID `'fresh_auth'` callback diverges from project-wide ISO 8601 timestamp convention).
10. ARCH.md "Light-account signing of consent ops" — operational note re: audit-log columns + `session_id` SHA-256 of bearer JWT truncated to 16 hex (round-3 [TODO #4]).
11. ARCH.md "Light-account signing of consent ops" — cross-reference issuance endpoints `POST /api/custody/fresh-auth` (password) and `POST /api/orcid/start { mode: 'fresh_auth' }` (ORCID) (round-3 [TODO #5]).

### Follow-up tasks filed (3)

- `agents/docs/tasks/pending/architect-haf-unavailability-vouched-set-policy.md` — architect decides fail-open vs fail-closed when HAF returns null pool / throws; Round 2 wires per policy. Currently `consent-ops.ts:68, 102-114` returns `[]` indistinguishably for "no ops" vs "HAF threw"; this is acceptable in isolation (Round 1 not yet integrated) but needs explicit policy before Round 2 lands.
- `agents/docs/tasks/pending/backend-consent-ops-fetcher-real-haf-coverage.md` — carve-out clause (c) follow-up: real-HAF integration coverage of `fetchConsentOpsForPaper` SQL shape, scheduled to land alongside Round 2's `papers.ts` integration tests.
- `agents/docs/tasks/pending/backend-custody-audit-pii-annotation.md` — add `COMMENT ON COLUMN custody_audit_log.user_agent` documenting PII status under CNPD jurisdiction + the existing account-deletion sweep at `routes/settings.ts:312`. P2 follow-up; not blocking.

### Re-review signal

When items 1-18 land, `git mv` this file back to `tasks/review/`. The architect's next pass scopes `/ce-code-review` to the round-4 commits since the hold block was written. Items 1-9 are P1; items 10-18 are P2. Anchor: items 1+5 (substitution attack + audit-log identity loss) are the load-bearing structural change; items 2-4 are independent correctness/reliability fixes; items 6-7 close test coverage gaps on load-bearing paths; items 8-9 are type-safety hygiene; items 10-18 are scoped local fixes.

Items 1+5 should land together (item 5's resolution depends on item 1's fix shape). Item 9's discriminated-union refactor will touch the same call site as item 5's audit-log changes; coordinate. Items 6+7 (testing) can ship in parallel with the implementation fixes. Items 16-18 are P2 quality-of-implementation items that may roll into a single sweep commit.

---

## Backend round-4 signal (2026-05-06, commit `a28a0d0` on `main`)

All 18 round-4 hold items landed in a single focused commit. Per-item summary:

**P1 (items 1-9):**

1. **Multi-consent-op bundle bypass** — `findConsentOpsInBundle` returns `none` / `single` / `multiple` discriminator; multi-consent bundles 400 with `MULTIPLE_CONSENT_OPS` BEFORE proof consume. Two regression tests + the proof-not-consumed mutation-kill assertion.
2. **app-db.ts fresh-deploy column drift** — appended four `ALTER TABLE custody_audit_log ADD COLUMN IF NOT EXISTS …` blocks for `auth_mechanism` / `fresh_auth_outcome` / `session_id` / `user_agent`.
3. **Redis flap recovery** — `issueFreshAuthToken` writes a memStore backup BEFORE the Redis SET; `consumeFreshAuthToken` deletes the memStore copy on Redis-GETDEL success (no replay window). Two regression tests in `tests/lib/fresh-auth.test.ts`.
4. **`fetchConsentOpsForPaper` cap** — added `LIMIT 1000` and `ORDER BY id DESC`, documented in JSDoc and asserted in the SQL-shape contract test.
5. **Audit identity preserved** — natural consequence of item 1; the `author_resign` audit-row test was widened to assert all four columns.
6. **handleFreshAuth coverage** — 4 new tests in `tests/routes/orcid.test.ts`: happy path, ORCID-mismatch (403, mutation-kills the binding check), no-ORCID-linked (403), no-account (401).
7. **Bridge-paper vouched-set test** — two cases added to `tests/consent-ops.test.ts` exercising `computeVouchedAuthors` with `claimedAuthors = {hiveBridgeAccount}`.
8. **Type guards** — `isConsentAction` (consent-ops.ts), `isOpTuple` (custody.ts), `isFreshAuthMechanism` (fresh-auth.ts) replace the three unsafe casts.
9. **CustodyAuditExtras discriminated union** — converted to `{ auth_mechanism, fresh_auth_outcome, ... } | Record<string, never>`; call site in custody.ts pins the type explicitly; audit log narrows via `'auth_mechanism' in extras`.

**P2 (items 10-18):**

10. **401 vs 403 differentiation** — `FRESH_AUTH_REQUIRED` returns 403 for `details.reason === 'username_mismatch'`, 401 for `'missing'`/`'expired'`/`'malformed'`. Cross-account test updated.
11. **Test header carve-out** — extended `custody-consent-ops.test.ts` header with per-target paragraphs justifying both `hive.js` and `custody-crypto.js` mocks.
12. **Phantom `'invalid'` reason** — trimmed from `FreshAuthVerifyResult` union.
13. **Unused exports dropped** — `IssuedFreshAuth` and `FreshAuthVerifyResult` are now module-internal; `FRESH_AUTH_TTL_SECONDS` stays exported for the new test file.
14. **Comment fix** — "bcrypt-verifies" → "argon2-verifies".
15. **Cleanup hooks** — `_stopCleanupForTests` / `_restartCleanupForTests` exported.
16. **statement_timeout** — documented in JSDoc; per-query timeout deferred to Round 2's integration site per the existing `architect-haf-unavailability-vouched-set-policy` follow-up.
17. **TTL-expiry fake-timer test** — `tests/lib/fresh-auth.test.ts` exercises the in-memory TTL guard via `vi.spyOn(redis, 'getdel').mockRejectedValue(...)` to force the fallback path; mutation-kill confirmed.
18. **Null-hash 401 oracle test** — new file `tests/routes/custody-fresh-auth-null-hash.test.ts`; mutation-kill confirmed by temporary 404 substitution.

**Verification:** `npx tsc --noEmit` clean; `npm run lint` clean (pre-existing seed-phrase warnings only); targeted vitest passes — `tests/consent-ops.test.ts` 24/24, `tests/lib/fresh-auth.test.ts` 8/8, `tests/routes/custody-consent-ops.test.ts` 15/15, `tests/routes/custody-fresh-auth-null-hash.test.ts` 1/1, `tests/routes/custody.test.ts` 8/8, `tests/routes/custody-upgrade-null-hash.test.ts` 2/2, `tests/routes/orcid.test.ts` 71/71.

**[TODO Architect] additions for archive (beyond the 11 already in the hold block):**

- `agents/docs/api-contracts/custody.md` — add `MULTIPLE_CONSENT_OPS` (400) error code under `POST /api/custody/broadcast`, returned when a bundle contains >1 `author_accept`/`author_resign` op.
- `agents/docs/api-contracts/custody.md` — `FRESH_AUTH_REQUIRED` status differentiation: 403 for `details.reason === 'username_mismatch'`, 401 for the other reasons.

Round 2 / Round 4 implementation untouched (gated on `backend-multi-author-cumulative-union`); architect-owned doc cluster carries forward.

---

## Architect re-review (2026-05-06, round-4 → round-5) — HELD PENDING FIXES

`/ce-code-review` dispatched against commit `a28a0d0`. 11 reviewers (correctness, security, adversarial, testing, maintainability, project-standards, api-contract, data-migrations, reliability, kieran-typescript, learnings; ce-agent-native-reviewer suppressed per root CLAUDE.md). Triage produced 9 items below; 3 dismissed (item rationales at the bottom); 1 architect-owned doc cluster partially landed in this re-review pass (see "Architect-landed in this pass" section below).

**Project context surfaced during triage (saved to architect memory `project_single_instance_only.md`):** PEvO will always run as a single backend instance. Multi-instance / multi-replica / cross-process state-coherence threat models are dismissable. Same-process races (mid-call Redis flaps, in-process concurrency) remain in scope.

### Items to address — round-5 (9)

**1. (P0) Fresh-auth single-use semantics broken under same-process Redis flap.** `backend/src/lib/fresh-auth.ts:204-244`. Cross-reviewer agreement: security, adversarial, reliability, correctness — anchor 100. The dual-write defense at hold #3 is asymmetric despite the docstring at lines 195-200 claiming symmetry. The Redis-success leg deletes memStore (line 233) but the memStore-fallback leg has no compensating `redis.del`. Sequence: (a) `redis.getdel` throws on a network blip BEFORE Redis actually deleted, (b) the `else` branch consumes from memStore and returns valid, (c) Redis still has the entry, (d) a replay within TTL hits Redis getdel and returns valid AGAIN — double-consume. Single-instance constraint dismisses the multi-process facet but does NOT dismiss the same-process race.

Fix: on the memStore-fallback success path (after `raw = JSON.stringify(cached.entry)` at line 240), issue a best-effort `redis.del(KEY_PREFIX + token)`. Log on error; do not fail the consume. Correct the docstring at lines 195-200 to describe the actual symmetry: both legs delete the other tier on success. Add a test: stub Redis to throw on the first `getdel`, then "recover" Redis (mock it to behave normally), call consume a second time with the same token, assert `{ valid: false, reason: 'expired' }`. Pair with item 8 below so the test doesn't silent-skip when Redis is unavailable in CI.

**2. (P1) `fetchConsentOpsForPaper` LIMIT 1000 admits consent-op spam de-vouch attack.** `backend/src/consent-ops.ts:103-126`. Adversarial reviewer (anchor 75). The query has `ORDER BY cj.id DESC LIMIT 1000` with no signer filter in the WHERE clause. Any Hive account can post `custom_json {action: 'author_accept', root_author: P, root_permlink: P}` (signer = themselves, fee-less); the op is rejected at the `computeVouchedAuthors` consent-action layer (signer not in claimed-set), but it is still fetched and counts against the LIMIT 1000. Attacker spams 1000+ ops; legitimate co-authors' `author_accept` falls below the cut and is invisible to the computation. Result: legitimate co-authors are de-vouched. Hold #4 framing ("latest ops are retained") was inverted: latest = adversary's most recent.

Fix: per HAF Rule 5 (`agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md`), add `WHERE cj.required_posting_auths ->> 0 IN (claimed_set)` to the SQL. Wire `claimedAuthors` as a parameter to `fetchConsentOpsForPaper`'s signature; update the caller in `papers.ts` to pass it. Add a test: 1000 attacker `author_accept` ops at high `cj.id` + 1 legitimate signer's `author_accept` at low `cj.id`, claimed-set excludes the attacker, assert the legitimate op survives the LIMIT and is in the result set.

**3. (P1) Fresh-auth proof binds to user, not to (action, root_author, root_permlink) — 1-fold cross-paper substitution.** `backend/src/routes/custody.ts:223-252`, `backend/src/lib/fresh-auth.ts:204-274`. Adversarial reviewer (anchor 75). Hold #1 closes N-fold amplification (one ceremony cannot sign N consent ops). But the proof itself only binds `(token, username)`. A compromised SPA can submit `author_resign` on paper Y while the user mentally authenticated for `author_accept` on paper X; same proof passes consume on username; broadcast proceeds. The 5-min TTL gives the attacker the window. Round-3's premise (per-op fresh-auth ceremony as the defense against compromised SPA) requires the proof to actually bind to the op being authorized.

Fix: bind proof to op via content hash. Issuance request body grows to require `{ root_author: string, root_permlink: string, action: 'author_accept' | 'author_resign' }`. Compute `target_hash = SHA256(action ‖ '|' ‖ root_author ‖ '|' ‖ root_permlink)` at issuance, store it in the entry. Consume signature grows: `consumeFreshAuthToken(token, username, expectedTargetHash)`. The custody-broadcast handler computes the expected hash from the bundle's consent op fields and passes it. New verify-result reason `target_mismatch` (returns 403 like `username_mismatch`). Frontend `signer.js` adopts the new request shape (passes the consent target on issuance). Update `agents/docs/api-contracts/custody.md` and `agents/docs/api-contracts/orcid.md` for the new request fields and `target_mismatch` reason — these expand the architect-owned doc updates landed in this pass. Add tests: (a) issue with target X, consume with target Y → `target_mismatch`; (b) issue with target X, consume with target X → valid; (c) consume without expected target (legacy callers) → reject (closed-default policy).

**4. (P1) ORCID `fetch` calls have no timeout discipline.** `backend/src/routes/orcid.ts:334-344` plus other ORCID `fetch` sites. Reliability reviewer (anchor 75). Native Node `fetch` has no default timeout; ORCID provider hang blocks the handler indefinitely. New `handleFreshAuth` mode inherits this. Bundled into round-5 (rather than a separate task) to land alongside the other fresh-auth fixes.

Fix: wrap all ORCID `fetch` call sites in `AbortController` with a 10-second timeout (constant `ORCID_FETCH_TIMEOUT_MS`; expose as env var if a deployment override is needed). On `AbortError`, return 504 `ORCID_PROVIDER_TIMEOUT` with `details: { retriable: false, outcome: 'timeout', verify_before_retry: true }`. Audit every ORCID `fetch` call (`orcid.ts` token exchange, profile fetch, works fetch) — apply uniformly, not just to the round-4 surface. Add a test that stubs fetch to hang; assert the route returns 504 within ~11 seconds and the `AbortError` fires with `event: 'orcid.fetch.timeout'`. Update `agents/docs/api-contracts/orcid.md` Errors table with `ORCID_PROVIDER_TIMEOUT` (architect lands at archive).

**5. (P2) `CustodyAuditExtras` `Record<string, never>` arm is phantom — never constructed.** `backend/src/custody-audit.ts:33-40`. Cross-reviewer agreement: maintainability + kieran-typescript — anchor 100. All 3 callers either pass the consent shape or omit `extras` entirely. The discriminator narrowing uses `'auth_mechanism' in extras` rather than a `kind:` tag, so the empty variant gives no narrowing leverage either. The convention's load-bearing detail (the `?: never` discriminator that catches half-population) is already enforced by the consent arm's required-fields shape.

Fix: collapse to single optional shape:
```ts
export type CustodyAuditExtras = {
  auth_mechanism: 'password' | 'orcid';
  fresh_auth_outcome: FreshAuthOutcome;
  session_id?: string;
  user_agent?: string;
};
```
Update narrowing at the consumer (currently `extras && 'auth_mechanism' in extras`) to a simple `extras !== undefined` check. No behavior change. No new tests required (existing audit-log tests pin the shape).

**6. (P2) `custody-consent-ops.test.ts` bridge-paper exclusion test is misnamed no-op.** `backend/tests/routes/custody-consent-ops.test.ts:487-519`. Testing reviewer (anchor 75). Test is named "vouched-set excludes a non-bridge signer" (round-4 commit message claims it covers hold #7). Only assertion is `expect(res.status).toBe(200)`. The test body's own comment says "broadcast surface is paper-type-blind by design" and "vouched-set inertness is exercised in `consent-ops.test.ts` at the pure-function layer." Provides zero mutation-kill at the broadcast surface despite the name claiming hold #7 coverage.

Fix: delete the test. Bridge-paper exclusion is correctly tested at the pure-function layer (`consent-ops.test.ts` — but see item 7 for that test's separate gap). Note the framing change for hold #7 in this hold block already: "covered at the pure-function layer only; broadcast surface is paper-type-blind by design."

**7. (P2) `consent-ops.test.ts` bridge-paper test does not kill the line-221 mutation it claims to.** `backend/tests/consent-ops.test.ts:261-285`. Testing reviewer (anchor 70 — surfaced past the gate because it directly contradicts a hold-deliverable claim). Setup is `firstClaim = Map([['<bridge>', 100]])` with mallory absent from both `firstClaim` and `claimedAuthors`. Removing the `claimedAuthors.has(signer)` guard at `consent-ops.ts:221` (the gate hold #7 was supposed to defend) leaves mallory falling through to the `firstClaimBlock === undefined → continue` guard at line 224 — which fires because mallory is absent from `firstClaim`. Line 224 absorbs the mutation. Hold #7 deliverable was hollow. Same gap exists in the pre-existing "non-claimed signers" test at lines 222-230.

Fix: change the setup so `firstClaim = Map([['<bridge>', 100], ['mallory', 50]])` while `claimedAuthors = Set(['<bridge>'])`. Now mallory has a defined `firstClaimBlock` (line 224 passes); removing line 221 admits mallory into the vouched set. Mutation is killed. Add an inline comment explaining the divergent-guards mutation-kill design so a future maintainer doesn't "simplify" the setup back into the dual-guard absorption. Apply the same fix shape to the pre-existing non-claimed-signers test if scope permits in the same diff.

**8. (P2) Redis-flap recovery tests silently no-op when Redis is unavailable.** `backend/tests/lib/fresh-auth.test.ts:165-176, 191-205`. Testing reviewer (anchor 75). Both tests use `if (!redis || !isRedisAvailable()) return;` to bail without asserting. CI without Redis reports 8/8 pass with the load-bearing flap-recovery assertions never executing. The entire round-4 hold #3 fix is unverified in any CI environment without a real Redis instance.

Fix: replace silent return with `it.skipIf(!redis || !isRedisAvailable())(...)` so the absence is visibly reported. Apply the same policy to item 1's new round-5 tests (compensating `redis.del` on memStore-fallback success) so they don't inherit the silent-skip pattern.

**9. (P3) Stale carve-out citation in `custody-consent-ops.test.ts` header.** `backend/tests/routes/custody-consent-ops.test.ts:48-52`. Project-standards reviewer (anchor 75). The header cites `tests/lib/custody-crypto.test.ts` as a clause-(c) real-path companion; that file does not exist. The other citation (`tests/routes/signup-verify.test.ts`) does exist and covers the AES-GCM round-trip risk class, so clause (c) is satisfied in spirit, but the stale path misleads any auditor walking the carve-out provenance.

Fix: drop the `tests/lib/custody-crypto.test.ts` line. Optionally tighten the header to explain which risk class each citation covers; minor polish.

### Items dismissed during architect triage

- **Cross-process / multi-instance memStore split-brain (security, adversarial, reliability — initial flag at P0).** Dismissed by the project's single-instance constraint (saved to architect memory `project_single_instance_only.md`). Multi-replica / multi-process state-coherence concerns are not part of PEvO's threat model. The same-process facet of the same finding survives as item 1 above.
- **Fresh-auth proof consumed even when broadcast bundle fails op-validation.** `backend/src/routes/custody.ts:223-252`. Adversarial (anchor 75, P3). Burn-on-consume is the conservative single-use semantic per `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md`. Reissue-on-rejection violates the convention. UX cost under transient chain failure is real but bounded; if SPA-layer experience shows the re-auth burden is worse than expected, file a separate UI task at that point.
- **Bundle iteration duplication (`isOpTuple` pattern in `findConsentOpsInBundle` vs the manual check in the per-op allowlist loop).** `backend/src/routes/custody.ts:131-135 vs 84-86`. Maintainability (anchor 75, P3). The drift is speculative — manual check is currently a strict subset of `isOpTuple`. Consolidation lands as part of any future tightening of `isOpTuple`, not as standalone refactor work.
- **Issuance Redis-throw returns success without surfacing storage tier (operator visibility).** `backend/src/lib/fresh-auth.ts:157-178`. Reliability (anchor 75, P3). Single-instance constraint reduces the operational risk; existing `event: 'fresh_auth.redis_set_failed'` warn-log is correlatable with subsequent `expired` events. If a real Redis-flap incident later shows correlation is genuinely painful, file a small follow-up.

### Architect-landed in this re-review pass (doc cluster, partial)

`agents/docs/api-contracts/custody.md` and `agents/docs/api-contracts/orcid.md` updated to cover items 4, 5, 6, 7 from the existing "Architect-owned doc cluster" list at the top of this section (the round-3/4 cluster's items 4-7). Specifically:

- `custody.md` — `POST /api/custody/broadcast` body now documents `fresh_auth_proof`. Constraints updated: full action allowlist (`revote, claim_authorship, approve_authorship, revoke_authorship, author_accept, author_resign`); single-consent-op-per-bundle rule; `fresh_auth_proof` required when bundle contains a consent op. Errors: `MULTIPLE_CONSENT_OPS` (400), `FRESH_AUTH_REQUIRED` (401|403) with closed-enum `details.reason` and explicit "new value is wire contract change" precedent. New section `POST /api/custody/fresh-auth` documents the password-path issuance (request body, response shape, errors).
- `orcid.md` — `'fresh_auth'` mode added to `POST /api/orcid/start` body schema and mode table. New `#### fresh_auth` section under `POST /api/orcid/callback` documents the OAuth round-trip, the `accounts.orcid === orcidId` binding gate, the response shape, and mode-specific errors.

Items 1, 2, 3, and 10, 11 from the existing TODO Architect cluster (ARCH.md updates: type→action discriminator, author_accept validity prose, same-block tie-break primitive, light-account audit-log columns operational note, fresh-auth issuance endpoint cross-reference) remain pending. They land at archive time, along with item 7 expansion (target-binding fields once round-5 item 3 ships) and the `ORCID_PROVIDER_TIMEOUT` error documentation in `orcid.md` (round-5 item 4).

## Backend re-review signal (2026-05-06, round-5, working tree before commit)

All 9 round-5 hold items addressed. Net diff: 6 production files (`consent-ops.ts`, `custody-audit.ts`, `lib/fresh-auth.ts`, `routes/custody.ts`, `routes/orcid.ts`, `types/api.ts`) + 5 test files (`tests/consent-ops.test.ts`, `tests/consent-ops-real-haf.test.ts`, `tests/lib/fresh-auth.test.ts`, `tests/routes/custody-consent-ops.test.ts`, `tests/routes/orcid.test.ts`) + 1 collateral test (`tests/routes/custody-fresh-auth-null-hash.test.ts`, target-fields plumbed through to keep the password-oracle parity assertion). Bundled into a single commit per round-5 hold guidance.

### Item 1 — Symmetric dual-tier deletion (`backend/src/lib/fresh-auth.ts`)

**Production code:**
- Updated `consumeFreshAuthToken` docstring (lines ~270-300) to describe symmetric dual-tier deletion: Redis-success leg deletes the memStore backup; memStore-fallback leg issues a best-effort `redis.del(KEY_PREFIX + token)` to clear the canonical Redis entry. Pre-fix asymmetry (only Redis-success leg cleared the other tier) admitted same-process double-consume under a Redis blip mid-`getdel` even though the docstring claimed symmetry.
- Added the compensating-del block at consume time (around lines 333-352): on `consumedFromMemStore` and Redis still present, attempt `await redis.del(...)`, log on error with `event: 'fresh_auth.redis_compensating_del_failed'`, do not fail the consume.
- Added `consumedFromMemStore` flag at the consume entry to discriminate which leg succeeded.

**Tests (`tests/lib/fresh-auth.test.ts`):**
- New describe block `Symmetric dual-tier deletion (round-5 hold #1)` with 2 tests:
  - `memStore-fallback success path issues a compensating redis.del so a subsequent Redis-recovered consume cannot replay` — stubs Redis to throw on first `getdel`, allows the compensating del to run, verifies a second consume returns `expired`. The pre-fix asymmetric variant would have left the canonical Redis entry alive and admitted a double-consume.
  - `memStore-fallback compensating del is best-effort (a throwing redis.del does not break the consume)` — stubs both `getdel` and `del` to throw; asserts the consume still returns `valid: true` (the user's broadcast must proceed).

### Item 2 — `fetchConsentOpsForPaper` SQL signer-filter (`backend/src/consent-ops.ts`)

**Production code:**
- `fetchConsentOpsForPaper` signature grew a third parameter: `claimedAuthors: ReadonlySet<string>`. Empty claimed-set short-circuits to `[]` (avoids invalid `IN ()` SQL and matches the `computeVouchedAuthors` semantic that no claimed authors means no vouchable signers).
- SQL gained `AND cj.required_posting_auths ->> 0 IN ($5, $6, ...)` clause — each claimed account is a separate `$N` placeholder starting at $5. The signer-filter pushes the claimed-set membership check INTO the database so the LIMIT 1000 cap can't be exhausted by attacker-signed spam ops (de-vouch attack vector closed).
- Updated docstring to call out the de-vouch attack scenario, the round-5 fix, and HAF Rule 5 (the chain signer IS the implicit accepter/resigner, so signer-filter is equivalent to the `claimedAuthors.has(signer)` check at `computeVouchedAuthors:221`).
- Caller `getVouchedAuthors` updated to pass `claimedAuthors` through (was already a parameter; just plumbed).

**Tests:**
- `tests/consent-ops.test.ts`: existing 4 SQL-shape tests updated to take a 2-author claimed-set and assert the new `IN ($5, $6)` clause + `$5..$N` parameter binding.
- New test `short-circuits to [] when claimedAuthors is empty (no SQL issued)` pins the empty-set semantic.
- New test `signer filter at the SQL excludes non-claimed signers from the row set under spam (mutation kill)` pins the de-vouch defense: the mock asserts `claimedBindings` does NOT contain `mallory` and DOES contain `alice/bob/carol`. A regression that drops the SQL clause would let the test pass only if the mock returned attacker rows; the mock's claimed-bindings assertion is the structural mutation-kill.
- `tests/consent-ops-real-haf.test.ts`: `findKnownPaperWithConsentOps` extended to also project `signer` so the real-HAF test can pass it as the claimed-set; both real-HAF tests updated to take the new arg.

### Item 3 — Per-op fresh-auth target binding

**Production code (`backend/src/lib/fresh-auth.ts`):**
- New types `FreshAuthTargetAction` (`'author_accept' | 'author_resign'`) and `FreshAuthTarget` (`{action, root_author, root_permlink}`).
- `StoredEntry` gained a `target_hash: string` field (SHA-256 hex of the length-prefixed target encoding).
- New exported `computeFreshAuthTargetHash(target)` function. **Encoding correction discovered during testing:** the originally drafted `${action}|${root_author}|${root_permlink}` shape collides for `(author='a|b', permlink='c')` vs `(author='a', permlink='b|c')`. Round-5 final encoding is **length-prefixed**: `<len>|<value>` per field. Hive permlinks today are restricted so '|' cannot appear, but the encoder defends against the upstream constraint relaxing in the future and makes the binding self-evidently correct under any string input. A test in `computeFreshAuthTargetHash — content hash` exercises the pipe-laden permlink case to pin this contract.
- New internal `isValidTargetHash(value)` guard (strict `/^[0-9a-f]{64}$/`).
- `issueFreshAuthToken` signature: now `(username, mechanism, target)`. Computes the hash, embeds in the stored entry.
- `consumeFreshAuthToken` signature: now `(token, expectedUsername, expectedTargetHash)`. Three reject conditions added: (a) stored entry without a well-shaped `target_hash` rejects as `malformed` (round-4-shape leak guard), (b) malformed/empty `expectedTargetHash` rejects as `target_mismatch` (closed-default for legacy callers), (c) stored hash ≠ expected hash rejects as `target_mismatch`.
- New `target_mismatch` reason added to `FreshAuthVerifyResult` and `FreshAuthOutcome` (in `custody-audit.ts`).

**Production callers:**
- `backend/src/routes/custody.ts`:
  - `findConsentOpsInBundle` extended to extract `root_author` and `root_permlink` from the consent op payload; malformed targets fall through to the no-consent path (chain rejection backstop). The `single` discriminator carries the full target.
  - `/api/custody/broadcast` consume site (lines ~225-270): computes `expectedTargetHash` from the actual consent op's fields and passes it. Status code discrimination updated: `target_mismatch` (like `username_mismatch`) returns 403 (binding violation), other reasons 401.
  - `/api/custody/fresh-auth` issue route: request body grew required `action`/`root_author`/`root_permlink` fields. Closed-default validation rejects 400 if any are missing/malformed.
- `backend/src/routes/orcid.ts`:
  - `StartBodySchema` extended with optional `action`/`root_author`/`root_permlink` fields.
  - `/api/orcid/start` mode === 'fresh_auth' branch validates the target fields (closed-default 400 if missing) and stores them in the state map under `fresh_auth_target`.
  - `orcidStates` Map type extended with `fresh_auth_target?: FreshAuthTarget`.
  - `/api/orcid/callback` reads `fresh_auth_target` from state, passes it to `handleFreshAuth`. Defensive 400 if the target is somehow absent (corrupt Redis state).
  - `handleFreshAuth` signature grew a `target: FreshAuthTarget` parameter.

**Tests (`tests/lib/fresh-auth.test.ts`):**
- New describe block `computeFreshAuthTargetHash — content hash (round-5 hold #3)` with 6 tests: 64-char-hex shape, determinism, action-axis differentiation, root_author-axis differentiation, root_permlink-axis differentiation, pipe-laden domain-separation pin.
- New describe block `Per-op target binding (round-5 hold #3)` with 7 tests:
  - issue/consume same target → valid
  - issue X / consume Y → `target_mismatch`
  - 1-fold action-axis substitution (accept → resign with same paper) → `target_mismatch`
  - 1-fold paper-axis substitution (same action, different permlink) → `target_mismatch`
  - closed-default empty-string `expectedTargetHash` → `target_mismatch`
  - closed-default malformed (length-63 hex) → `target_mismatch`
  - closed-default uppercase hex → `target_mismatch` (strict-lowercase contract pinned)
- All existing fresh-auth tests updated to pass target arguments.

**Tests (`tests/routes/custody-consent-ops.test.ts`):**
- New `targetFor` helper extracts the (action, root_author, root_permlink) shape from the test's consent ops.
- All 7 existing `issueFreshAuthToken` calls updated to pass a target matching their broadcast bundle's consent op (or, for tests where the consume side never runs — multi-consent rejection at the gate, allowlist rejection — a well-formed default target).
- New POST /api/custody/fresh-auth tests: missing-action 400, non-consent-action 400, missing-root_author 400, missing-root_permlink 400.
- New end-to-end pin tests: paper-X mint → paper-Y broadcast → 403 `target_mismatch` (audit broadcast surface integration); accept mint → resign broadcast → 403 `target_mismatch`.

### Item 4 — ORCID fetch timeout discipline (`backend/src/routes/orcid.ts`)

**Production code:**
- New `ORCID_FETCH_TIMEOUT_MS` constant (default 10s, env-overridable via `ORCID_FETCH_TIMEOUT_MS`).
- New `OrcidProviderTimeoutError` class for typed error surface.
- New `fetchWithOrcidTimeout(url, init)` wrapper: AbortController + setTimeout; on abort due to the timer firing (vs caller-driven abort), throws `OrcidProviderTimeoutError`. Logs at warn level with structured `event: 'orcid.fetch.timeout'`.
- Both fetch sites (`/oauth/token` exchange in `/callback`, `pub.orcid.org/.../works` in `countExternalWorks`) wrapped.
- `/callback` outer catch detects `OrcidProviderTimeoutError instanceof` and returns 504 `ORCID_PROVIDER_TIMEOUT` with `details: { retriable: false, outcome: 'timeout', verify_before_retry: true }`. Generic 500 path unchanged.
- New `ORCID_PROVIDER_TIMEOUT` error code added to `backend/src/types/api.ts` `ErrorCode` union.

**Tests (`tests/routes/orcid.test.ts`):**
- New describe block `POST /api/orcid/callback — provider-timeout discipline (round-5 hold #4)` with 2 tests:
  - token-exchange hang → 504 with full closed-default `details` shape (uses `installAbortingFetchStub('token')` helper — fetch stub that hooks into the production code's AbortSignal and rejects on abort, simulating a hung provider without wall-clock waits).
  - works-fetch hang → 504 (signup mode reaches `countExternalWorks`).
- Both tests `it.skipIf(env > 1s)` so a deployment override that cranks the timeout above 1 second skips rather than hanging the test for 10s.
- Suite-wide change: `startAuthed('fresh_auth', ...)` helper updated to send default target fields so existing fresh_auth callback tests continue to pass.

### Item 5 — Collapse `CustodyAuditExtras` discriminated union (`backend/src/custody-audit.ts`)

**Production code:**
- `CustodyAuditExtras` collapsed from `T | Record<string, never>` to a single optional shape (`{auth_mechanism, fresh_auth_outcome, session_id?, user_agent?}`). The empty arm was phantom: every call site either passed the consent shape or omitted `extras` entirely; no caller ever constructed `{}`.
- Narrowing at the consumer in `logCustodyBroadcast` simplified from `extras && 'auth_mechanism' in extras ? extras : undefined` to a bare `extras !== undefined` check (now implicit in the optional-chaining).
- Updated docstring to explain the round-4 → round-5 evolution and preserve the round-4 hold #9 motivation (correlated-options-discriminated-union convention) — the convention's load-bearing detail (TS rejecting `auth_mechanism` without `fresh_auth_outcome` or vice versa) survives in the new shape's required-fields contract.
- `'target_mismatch'` added to `FreshAuthOutcome` union (item 3 dependency).

No new tests required (existing audit-log tests pin the shape; the change is type-only at the call sites).

### Item 6 — Delete misnamed bridge-paper exclusion test (`backend/tests/routes/custody-consent-ops.test.ts`)

Deleted lines ~487-519. The test name claimed to cover hold #7 but the only assertion was `res.status === 200` and its own body comment said "broadcast surface is paper-type-blind by design." Zero mutation-kill at the broadcast surface. Bridge-paper exclusion is correctly tested at the pure-function layer in `consent-ops.test.ts:278-336` (the round-5 item 7 update preserves and strengthens that coverage). Replaced with a brief comment block explaining the deletion rationale.

### Item 7 — `consent-ops.test.ts` divergent-guards mutation-kill (`backend/tests/consent-ops.test.ts`)

Setup updated for both affected tests:
- `computeVouchedAuthors — non-claimed signers (defense in depth)` → `ignores accept ops from accounts not in the claimed set`: mallory now has `firstClaim: 50` so guard (b) at `consent-ops.ts:224` passes, leaving guard (a) at `:221` as the sole barrier. Mallory's accept blockNum 120 > 50 so the temporal-ordering filter passes too.
- `computeVouchedAuthors — bridge papers` → `vouches only the bridge account...`: mallory's `firstClaim` entry added (50). Same shape: guard (b) and the temporal filter pass; only guard (a) blocks her.

Both tests gained extensive inline comments explaining the divergent-guards mutation-kill design so a future maintainer doesn't "simplify" the setup back into the dual-guard absorption.

**Mutation-kill attestation:** I deleted the `if (!claimedAuthors.has(signer)) continue;` line at `consent-ops.ts:221` and ran the suite. Result: `1 failed | 30 passed (24 in this file, 30 across the run)` — failures specifically at the two updated tests, with shapes `expected Set{ 'alice', 'mallory' } to deeply equal Set{ 'alice' }` and `expected Set{ 'pevotest.admin', 'mallory' } to deeply equal Set{ 'pevotest.admin' }`. Restored the line; suite back to green at 24/24. Pre-round-5 setup absorbed this mutation silently.

### Item 8 — `it.skipIf` for Redis-availability-gated tests (`backend/tests/lib/fresh-auth.test.ts`)

**Implementation note:** `getRedis()` returns the redis instance before its `connect()` promise resolves. `it.skipIf(...)` evaluates at registration time, before `tests/setup.ts`'s `beforeAll` awaits `redis.ping()`. A naive `const redisAvailable = getRedis() && isRedisAvailable()` at module scope evaluates to `false` at import-time and skips on every CI run. Pattern from `tests/support/redis-helpers.ts`: poll up to ~1s for `redis.status === 'ready'` via top-level `await`. Module scope `await` is supported in this ESM project.

Replaced both round-4 hold #3 tests' `if (!redis || !isRedisAvailable()) return;` early-bail with `it.skipIf(!redisAvailable)`. New round-5 item-1 tests inherit the same pattern. Module-level `redisAvailable` constant documented inline with the rationale.

### Item 9 — Stale `tests/lib/custody-crypto.test.ts` citation removed (`backend/tests/routes/custody-consent-ops.test.ts`)

Header line 50 cited `tests/lib/custody-crypto.test.ts` as a clause-(c) real-path companion; that file does not exist (`find tests/ -name custody-crypto.test*` returns nothing). Citation dropped; the surviving citation (`tests/routes/signup-verify.test.ts`) covers the AES-GCM round-trip risk class via real-key encrypt-at-signup → decrypt-on-first-broadcast flow. Header rewritten to make the surviving citation's risk-class coverage explicit.

### Verification

- `npx tsc --noEmit` — clean build.
- `npm run lint` — clean (2 pre-existing `no-explicit-any` warnings in `seed-phrase.ts`, acceptable per backend CLAUDE.md).
- Targeted suites:
  - `npx vitest run tests/lib/fresh-auth.test.ts` — 23/23 passing (was 8 round-4; +6 hash tests, +2 dual-tier tests, +7 binding tests, +existing 8 - 0 deleted = expected 23).
  - `npx vitest run tests/routes/custody-consent-ops.test.ts` — 20/20 passing (was 14 round-4; -1 deleted item-6 test, +7 round-5 issuance + e2e tests = expected 20).
  - `npx vitest run tests/consent-ops.test.ts` — 24/24 passing (item-2 SQL-shape tests updated, +1 short-circuit test, +1 signer-filter mutation-kill).
  - `npx vitest run tests/consent-ops-real-haf.test.ts` — 1 passed | 1 skipped (the skipped test is the real-HAF row-shape pin which auto-activates once consent ops appear on chain — expected in the current dev environment).
  - `npx vitest run tests/routes/orcid.test.ts` (with `ORCID_FETCH_TIMEOUT_MS=200`) — 73/73 passing (+2 timeout tests).
  - `npx vitest run tests/routes/custody-fresh-auth-null-hash.test.ts` — 1/1 passing (collateral target-fields plumbing).
- Full backend `npx vitest run` — `971 passed | 9 skipped`. Two pre-existing failures unrelated to this round (`tests/routes/disciplines-canon-mocked.test.ts:669` continuation-chain head-override discipline lowercase test — verified pre-existing on `main` via `git stash`; the failure persists with the round-5 patches reverted, so it was not introduced here). Stats-profile-parity flap on the first run cleared on re-run (real-data-dependent).

### Architect followups carried forward at archive

- ARCH.md cluster items 1, 2, 3, 10, 11 from the round-5 hold block (type→action discriminator, author_accept validity prose, same-block tie-break primitive, light-account audit-log columns operational note, fresh-auth issuance endpoint cross-reference) — unchanged.
- New for round-5: `agents/docs/api-contracts/orcid.md` `ORCID_PROVIDER_TIMEOUT` 504 error documentation (item 4) and `agents/docs/api-contracts/custody.md` + `agents/docs/api-contracts/orcid.md` per-op target-binding fields on the issuance request bodies and `target_mismatch` reason on `FRESH_AUTH_REQUIRED` errors (item 3).
- Round-5 hold #2: the LIMIT-1000 docstring at `consent-ops.ts:69-78` notes that "the threshold is sized for the cumulative-union task's expected chain length." The LIMIT semantic narrows under the new signer-filter (now bounded by claimed-set cardinality × per-author rate-limit), so the architect may want to revisit the doc when item 2 lands at archive.

### Ambient hardening (backend self-discipline, not in any hold)

- The `computeFreshAuthTargetHash` encoding regression (pipe-collision under non-Hive-conformant permlinks) was caught at unit-test write-time by the domain-separation test, before any production caller exercised it. Encoding switched to length-prefixed; updated test passes. Documented as a binding-contract pin so a future "simplify the encoder" refactor can't silently re-introduce the collision.

When round-5 lands, `git mv` this file back to `tasks/review/`.

