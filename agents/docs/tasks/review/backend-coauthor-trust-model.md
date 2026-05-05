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
