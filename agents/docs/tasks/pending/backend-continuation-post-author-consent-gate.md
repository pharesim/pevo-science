# BACKEND-CONTINUATION-POST-AUTHOR-CONSENT-GATE — gate paper continuations on named-author membership

**Owner:** Backend Agent
**Created:** 2026-04-30 (architect, surfaced by cluster 1 `/ce-code-review` of `backend-bridge-paper-author-gate.md` round-2 — security reviewer pre-existing finding conf 75)
**Priority:** P1

## Problem

`backend/src/routes/papers.ts` `resolveContinuationChain` (line 587) and the related continuation-walker call site at line 1067 follow `json_metadata.<appTag>.continues` pointers without filtering on author consent. Any Hive account can post a comment with `pevo.continues = { author: <some real paper author>, permlink: <some real paper permlink> }, pevo.type = 'paper'`, and the continuation-walking code surfaces the attacker's title/body/discipline as the paper's displayed content via `/api/papers/:author/:permlink?version=N`.

`isPevoAnyPaper(headMeta, latest.post_author)` returns true for native `paper`-typed posts from any author, so the existing gate doesn't catch this. The `bridge_paper` author-pin convention (closed in cluster 1) doesn't apply here — the spoofed continuation is `type: 'paper'`, not `bridge_paper`.

This is a separate spoof vector from the bridge-paper closure: bridge-paper was about `type=bridge_paper` from any author; this is about `pevo.continues={author,permlink}` from any author claiming to continue someone else's paper. Both are forms of the same anti-pattern (`pevo-object-identity-is-author-vouching-not-metadata-claim`) — the platform trusted a metadata-claim instead of pinning to a vouching identity.

## Threat model

- **Attacker:** any Hive account (free to create on the public chain).
- **Capability:** post a single Hive comment with `pevo.continues = {author: 'real-scientist', permlink: 'real-paper-permlink'}` and `pevo.type = 'paper'`. No permission required.
- **Impact:** the attacker's post becomes the displayed content of `real-scientist/real-paper-permlink` via the version walker. Title, body, abstract, discipline, keywords — all surface as the original paper's apparent v(N+1). The original paper's vote/review history follows the slug, so the attacker effectively rewrites a vetted paper while inheriting the legitimate paper's reputation signal.
- **Detection:** none currently. No canary tests assert the continuation gate; the bridge-paper canary suite covers `bridge_paper` only.

## Goal

Require continuation-post `author` to be a named author of the continued paper. Specifically: a continuation post `C` with `pevo.continues = {author: A, permlink: P}` should be admitted into `(A, P)`'s version chain only if `C.author` (chain-level, the post author of `C`) appears in `(A, P)`'s `pevo.authors[].hive` list.

This means **the continuation author must be one of the named authors of the continued paper**, where "named authors" = the `hive` field values in the original paper's `pevo.authors[]` array.

### How continuation posts work today

Continuation posts are PEvO's mechanism for co-author participation in a paper's revision timeline — they are **not** the edit mechanism. Each author owns their own post(s) and edits them via Hive's native edit mechanism (within Hive's grace window). When a co-author wants to publish their own version of a paper, they broadcast a NEW Hive comment under THEIR account, with `pevo.continues = { author: <some predecessor>, permlink: <some predecessor permlink> }` pointing into the paper's existing chain. They then own that post and can edit it natively over time.

The "version chain" PEvO assembles is the timeline of all such posts (originals + continuations) across all named authors, linked by `continues` pointers. So a paper authored by alice + bob + carol may have:

- `alice/paper-v1` (original), edited by alice via Hive native edits.
- `bob/paper-continuation` (bob's first contribution), `pevo.continues = {alice, paper-v1}`, edited by bob via Hive native edits afterwards.
- `carol/paper-continuation`, `pevo.continues = {bob, paper-continuation}` (or back to alice's; the chain isn't strictly linear).

The chain-level `author` of any post is always the broadcasting user — never spoofed at the chain layer. What CAN be spoofed today is the `pevo.continues` pointer: any Hive account can claim continuation against any paper, and `resolveContinuationChain` will admit them.

So the gate this task adds defends the **display** side: a post `C` with `pevo.continues = {A, P}` is admitted into the head paper's version chain only if `C.author` is in `(A, P)`'s `pevo.authors[].hive` set. Posts from non-author accounts are silently hidden from PEvO surfaces.

The companion UI concern (let named co-authors create their own continuation post + edit it) is filed separately as `ui-coauthor-continuation-publishing.md`. The backend gate must land first OR concurrently — without it, the UI work would let more accounts broadcast continuations that the gate has to filter. With the gate in place, the UI surface is risk-free.

## Acceptance

### 1. Author-consent check in `resolveContinuationChain`

`backend/src/routes/papers.ts:587` `resolveContinuationChain`. Before admitting a candidate continuation `C` into `(A, P)`'s version chain, verify:

- Read the head paper's `pevo.authors[]` array (which is already loaded for rendering).
- Extract the set of `hive` values from `pevo.authors[]`.
- If `C.author` is NOT in that set, REJECT the continuation. Skip the post; do not surface its content.

Implementation note: `pevo.authors[]` is the canonical authoring list for both native and bridge papers. For bridge papers the chain-level `author` is `config.hiveBridgeAccount`, but `pevo.authors[]` still lists the original preprint authors — so a continuation `C` of a bridge paper must have `C.author` in the original-author set, not equal to the bridge account. Native papers have the original authors in both fields (the post author is one of `pevo.authors[].hive`), so the check is straightforward.

### 2. Cover the second call site

`backend/src/routes/papers.ts:1067` is the second continuation-walker invocation. Apply the same gate. Don't duplicate the logic — extract a small helper `isAuthorizedContinuationAuthor(continuationPost, headPaper): boolean` and call it from both sites.

### 3. Canary tests

`backend/tests/routes/papers.test.ts` (or a new dedicated file). Cover:

- **Spoofed continuation excluded:** post `attacker-account/somelink` with `pevo.continues = {author: 'real-scientist', permlink: 'real-paper'}` and `pevo.type = 'paper'`. Hit `GET /api/papers/real-scientist/real-paper?version=N`. Assert the spoofed post's title/body do NOT appear in the response. Assert the version chain only includes posts whose `author` is in the original paper's `pevo.authors[].hive`.
- **Legitimate continuation admitted:** the original paper has `pevo.authors[]` listing two scientists `alice` and `bob`. Post `bob/v2` with `pevo.continues = {author: 'alice', permlink: 'paper-v1'}`. The version chain includes `bob/v2`. (Tests that bob — a named author — can continue alice's paper.)
- **Self-continuation:** post `alice/v2` continuing `alice/paper-v1`. Admitted (alice is a named author of her own paper).
- **Bridge paper continuation:** original paper authored by `config.hiveBridgeAccount` with `pevo.authors[]` listing the original preprint authors. Continuation by one of the named authors (NOT by the bridge account) is admitted. Continuation by an arbitrary account is excluded.

### 4. CI guard / convention extension

Append a paragraph to `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` documenting that `pevo.continues = {author, permlink}` is a metadata claim that must be paired with named-author membership in the continued paper, NOT trusted on the post itself. Add a sub-section under "Sites this convention applies to" enumerating the continuation surface.

The existing `check-bridge-paper-discipline.sh` script doesn't cover this surface (it greps for `'bridge_paper'` literals). A separate guard would grep for direct uses of `pevo.continues` in route code and require they go through the new `isAuthorizedContinuationAuthor` helper. This is over-engineering today (only two call sites exist); revisit if more callers appear.

### 5. ARCHITECTURE.md note

Update `agents/docs/ARCHITECTURE.md` (architect-owned) — append a row to the metadata-trust table documenting that `pevo.continues` is gated on named-author membership, similar to the existing notes on `bridge_paper` author-pinning. This is a small architect edit at archive time.

## Out of scope

- Adding a positive-consent signal (the original paper opting in to particular continuation authors via a separate metadata field). The named-author membership check is sufficient for the threat model and matches existing PEvO authoring semantics.
- Retroactive cleanup of any spoofed continuations already on chain. The gate change makes them invisible going forward; on-chain history is immutable.
- Generalizing the gate to other metadata-claim fields (e.g., `pevo.cites`, `pevo.reviews`). File separately if those surfaces have analogous spoof vectors.
- Frontend changes — the gate is server-side; if a spoofed continuation is currently rendered in the SPA, post-fix it simply disappears (no UI change needed).

## Why now

1. **Pre-existing security gap.** The bridge-paper closure (cluster 1, archived 2026-04-28) demonstrated the platform-wide convention. This is the same anti-pattern at a different metadata-claim site. Closing it now leverages the same convention reasoning + reviewer attention.
2. **Trivially exploitable.** Any Hive account can execute the attack with one comment broadcast. No detection mechanism exists today.
3. **Bounded scope.** Two call sites in `papers.ts`; well-defined fix shape; canary tests follow the bridge-paper-author-gate pattern.

## Source

`/ce-code-review` cluster 1 task `backend-bridge-paper-author-gate.md` round-2 — security reviewer finding (P2 conf 75, pre_existing=true). Surfaced when the reviewer audited adjacent metadata-trust paths during the bridge-paper review.

User-architect dialog 2026-04-30 confirmed the gate shape: continuation author must be one of the named authors in the continued paper (`pevo.authors[].hive`).

## Cross-references

- `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — convention this task extends.
- `agents/docs/api-contracts/papers.md` — author/version semantics; may need a note on the continuation-author requirement.
- `backend/src/routes/papers.ts:587, 1067` — the two sites needing the gate.

## Backend implementation note (2026-04-30)

Backend landed the gate. Single resolution point: `resolveContinuationChain` in `backend/src/routes/papers.ts`. Both call sites (`fetchPaperDetailFromHaf` and `reconstructVersionsFromHaf`) flow through it, so a single helper-extract was unnecessary — the gate lives inline in the chain resolver, with two pure helpers in `backend/src/helpers.ts` (`extractAuthorizedContinuationAuthors`, `isAuthorizedContinuationAuthor`). Defense-in-depth: SQL-side `c.author = ANY($N::text[])` filter (efficient, prevents disallowed candidates from being returned at all) AND JS-side re-check (catches drift if a future SQL refactor drops the ANY() arm).

Files:
- `backend/src/helpers.ts` — `extractAuthorizedContinuationAuthors`, `isAuthorizedContinuationAuthor` helpers.
- `backend/src/routes/papers.ts` — `fetchHeadAuthorizedAuthors` (resolves the per-chain authorized set once), `resolveContinuationChain` (gate), updated import.
- `backend/tests/routes/continuation-author-gate.test.ts` — 14 canary tests: 4 pure-helper unit tests + 7 SQL-shape canaries (mocked pool per CLAUDE.md "Running Tests" carve-out, justification in file header).

Bridge-paper canary (`tests/routes/bridge-paper-author-gate.test.ts`) and real-HAF papers tests (`tests/routes/papers.test.ts`) pass unchanged.

`npm run lint` clean (only the two pre-existing `seed-phrase.ts` `no-explicit-any` warnings).

[TODO Architect]
1. **`agents/docs/ARCHITECTURE.md`** — append a row to the metadata-trust table documenting that `pevo.continues = {author, permlink}` is gated on named-author membership in the continued paper's `pevo.authors[].hive` set, similar to the existing `bridge_paper` author-pin row. Per task acceptance #5; architect-owned doc.
2. **`agents/docs/api-contracts/papers.md`** — consider adding a note that the version chain admits only continuation posts whose author is a named author of the head paper. The shape is server-side filtering (no client-visible API change), so this is documentation-only. Per task acceptance "may need a note on the continuation-author requirement"; architect-owned per backend CLAUDE.md.
3. **`agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`** — append a "Sites this convention applies to" sub-section enumerating the two surfaces now closed: `bridge_paper` (closed cluster 1, `validPevoPaperWhere()` helper across 15 sites; CI guard `scripts/check-bridge-paper-discipline.sh`) and `pevo.continues = {author, permlink}` (closed by this task; gate in `resolveContinuationChain` with helpers `extractAuthorizedContinuationAuthors` + `isAuthorizedContinuationAuthor` in `backend/src/helpers.ts`; canary `backend/tests/routes/continuation-author-gate.test.ts`; predicate shape is **set membership** in `pevo.authors[].hive`, enforced both SQL-side `c.author = ANY($N::text[])` and JS-side; no CI grep guard since both call sites flow through `resolveContinuationChain`). The convention doc lives under `agents/docs/solutions/` which is architect-owned territory per the commit-zone hook map; backend agents cannot touch it without `[skip-zone-audit]`.

---

## Architect re-review (2026-05-04, round-2) — HELD PENDING FIXES

`/ce-code-review` ran on the on-main commits `063ead7` (gate landing — replays orphan worktree commit `da5d371` the implementer signal block above mis-cites) + `3ea8892` (disciplines fixture update). 10 personas. The substantive author-consent gate is correct for its STATED threat model (unauthenticated outsider posting `pevo.continues={author,permlink}`). However the review surfaced (a) a directly-exploitable type-spoof gap that bypasses the gate, (b) a co-author display-spoof class the threat model doesn't cover, (c) a likely BUG that breaks bridge-paper continuations entirely, and (d) several cross-corroborated correctness issues.

### Items to address

**1. (P1) Continuation type-spoof — chain-walk SQL doesn't filter `pevo.type='paper'`.** `routes/papers.ts:762-774` chain-walk query filters by parent + `pevo.continues` pointer + author membership, but does NOT include `validPevoPaperWhere` (no `pevo.type='paper'` predicate). A named co-author can post a comment with author=bob (in alice's `pevo.authors[]` — passes the new gate) AND `pevo.type='review'` (NOT a paper) AND `pevo.continues={author:'alice', permlink:'paper-v1'}`. Chain-walk admits it. Body-overwrite at `papers.ts:586-601` is unconditional. Bob's review content surfaces as alice/paper-v1's apparent paper body for ~30 minutes (cache TTL).

This is identical-pattern to bridge_paper enforcement (15-site SQL helper + JS-level `isPevoBridgePaper(meta, author)`). The cluster B convention `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` requires BOTH author identity AND object identity at every gate.

Fix:
- (a) Add `validPevoPaperWhere(source: 'all')` (or equivalent) to the chain-walk SQL at `papers.ts:762-774`. Wraps existing predicates with the `type='paper' OR (author=bridge AND type='bridge_paper')` filter.
- (b) Add JS-side `isPevoAnyPaper(meta, author)` re-check at the candidate-admit site in `resolveContinuationChain`. Defense-in-depth, mirrors the gate's existing dual-layer pattern.
- (c) Canary test: post a continuation with `pevo.type='review'` from a named co-author, hit `/api/papers/:author/:permlink`, assert the review content does NOT appear in `versions[]` or `body` overwrite.

Surface for `/ce-compound` at archive: this finding shows the convention's ENUMERATED list of "two cases" (bridge_paper + pevo.continues) was itself an enumerated-exemption-list anti-pattern. Strengthen the convention from "enumerate cases" to structural rule: "every gate must enforce author + type identity together, not just one."

**2. (P1) Co-author display-spoof via head-metadata override.** `routes/papers.ts:586-601` unconditionally overwrites `detail.authors`, `detail.ipfs_cid`, `detail.document_hash`, `detail.citations` with the head continuation post's metadata. A vouched co-author Bob (in alice's `pevo.authors[]`) can:
1. Post `bob/v2` continuing alice's paper — admitted by the new gate.
2. In `bob/v2`'s metadata, set `pevo.authors=[{hive:'mallory'}]` (drop alice, add a "co-author"), point `ipfs_cid` to a different paper entirely, override DOI/citations.
3. Result: alice/paper-v1's URL displays a paper with mallory listed as author, mallory's IPFS payload, mallory's DOI — but alice's reputation, slug, votes, and review thread.

The gate addresses unauthenticated-attacker spoofing but does NOT constrain trusted-co-author abuse. This is an architectural gap: the threat model the gate was built against doesn't include insider abuse.

Fix (scoped — closes the highest-impact attack now):
- Lock `pevo.authors[]` against widening via continuation: when overriding `detail.authors`, the head's author set must be a SUBSET of the root's `pevo.authors[]` (a co-author can refine but not expand authorship). New authors can only be added via root-author edit, not via continuation.
- Root-pin `ipfs_cid` and `document_hash`: these are NEVER overridden by continuations. The canonical paper payload is what the gate is supposed to protect.
- Allow `title`, `body`, `abstract`, `discipline` to evolve normally (legitimate version evolution).
- Canary tests for each of the above (subset rejection on widening, root-pin on payload pointers).

The broader trust-model question (co-signing / fully locked fields / additive-only authorship architecture) is filed as **`backend-coauthor-trust-model.md`** (P1 architecture/security follow-up).

**3. (P1) Redundant casts in security-critical path.** Two related kieran-typescript findings (KT-1 + KT-2):
- (a) `helpers.ts:86-97` `extractAuthorizedContinuationAuthors`: vacuous re-cast `pevoMeta as Record<string, unknown>` after the falsy guard at line 88; double cast on `entry as Record<string, unknown>` then `(entry as Record<string, unknown>).hive as string` at lines 92-93. Extract `entry` once via a local `const e = entry as Record<string, unknown>` inside the `if (entry && typeof entry === 'object')` branch, then read `e.hive` directly.
- (b) `papers.ts:704-706, :783`: `row.author as string` and `next.author as string` cast without narrowing in the security-critical path. If HAF returns NULL author, the cast silently passes `undefined as string`. Gate fails-closed (undefined !== bridgeAccount) but the cast suppresses a detectable invariant violation. Add `if (typeof row.author !== 'string') return null;` at line 705 and `if (typeof candidateAuthor !== 'string') break;` at line 783.

Both are 1-2 line changes; preserves fail-closed semantics; makes the invariant compiler-checkable.

**4. (P2 batched — critical security/correctness, all 4-way cross-corroborated conf 100).**
- (a) **Lowercase the `pevo.authors[].hive` set.** `helpers.ts:86-98` `extractAuthorizedContinuationAuthors` doesn't lowercase. Hive enforces lowercase `c.author` chain-side. So `pevo.authors[{hive:'Alice'}]` (typo / display-case copy-paste) silently locks out the legitimate `alice` continuation. Real-world UX failure mode. Apply `.toLowerCase()` to each extracted hive AND ensure the SQL `c.author = ANY($N)` comparison is byte-equal-after-lowercase on both sides.
- (b) **TOCTOU author-set expansion.** `fetchHeadAuthorizedAuthors` reads CURRENT `json_metadata`. An attacker can broadcast a spoof continuation today (excluded by gate). If the original author later edits `pevo.authors[]` to include the attacker handle (compromise / social engineering), the pre-existing spoof is admitted retroactively — no re-broadcast required. Mitigation: capture the head paper's `block_num` or `last_edited` timestamp at the ROOT version's publish moment (or first-version-with-this-author-set moment) and gate continuations by their broadcast-time-vs-author-set-edit-time. If implementation is heavy, document as residual + audit-log every `pevo.authors[]` edit so operators can correlate post-incident.
- (c) **Versioned cache-key staleness.** `routes/papers.ts:1420-1430` `/invalidate` endpoint flushes `paper-detail:{author}:{permlink}` + `paper-enrichment:{author}:{permlink}` but NOT `paper-detail:{author}:{permlink}:v{N}` versioned keys. After `pevo.authors[]` edit, versioned-view requests serve stale gate result for up to 30 min. Fix: extend the invalidate handler to flush `paper-detail:{author}:{permlink}:v*` via Redis SCAN+DEL pattern (or in-memory prefix scan).
- (d) **Double `fetchHeadAuthorizedAuthors` per uncached request.** `fetchPaperDetailFromHaf` runs `resolveContinuationChain` directly (line 573) AND launches `reconstructVersionsFromHaf` (line 554) concurrently in `Promise.all`; the latter calls `resolveContinuationChain` again (line 891). Each invocation independently fires `fetchHeadAuthorizedAuthors`. Two HAF queries per uncached request, not one. Fix: hoist `resolveContinuationChain` resolution out of `Promise.all` and pass the already-resolved chain into `reconstructVersionsFromHaf` — OR memoize `fetchHeadAuthorizedAuthors` results in a request-scoped Map keyed on `(author, permlink)`.

**5. (P1 / likely BUG) Bridge papers can never be continued.** `backend/src/bridge.ts:480-528` `buildBridgeMetadata` writes `hive: null` for every author (original-preprint authors don't have Hive accounts). The new `extractAuthorizedContinuationAuthors` filters non-string `hive` values → bridge papers always have an EMPTY authorized set → the gate's `size === 0` short-circuit blocks ALL continuations of bridge papers.

This **directly contradicts task acceptance criterion #4** ("Continuation by named original authors of a bridge paper is admitted; continuation by an arbitrary account is excluded") — the gate now excludes EVERY continuation, including legitimate bridge updates that flow through `bridge.ts /update`.

Fix design (architect-blessed before backend implements):
- **Recommended (Option b): special-case the gate to admit `config.hiveBridgeAccount` as the authorized continuation author for bridge papers.** Bridge papers' canonical update path IS the bridge account itself (`bridge.ts /update` posts a continuation under `config.hiveBridgeAccount`). The acceptance criterion's framing ("named original authors") was actually wrong — original-preprint authors don't have on-chain identity for a bridge paper; the bridge account vouches for them. Continuation of a bridge paper by the bridge account is the only legitimate path; any other author should be excluded. Change `extractAuthorizedContinuationAuthors` (or `resolveContinuationChain`) to special-case bridge papers: authorized set is `{config.hiveBridgeAccount}`, not `pevo.authors[].hive`.
- Update task acceptance #4 to reflect this.
- Canary tests: continuation of a bridge paper by `config.hiveBridgeAccount` is admitted; continuation by any other account is excluded.

**6. (P2 batched — test scaffolding).**
- (a) Real-HAF carve-out clause (c) NOT satisfied. `tests/routes/continuation-author-gate.test.ts` file header claims `papers.test.ts` and `paper-detail-v3.test.ts` cover the gate at the real-HAF level, but neither file actually does. Per CLAUDE.md "Running Tests" carve-out: either ADD the real-HAF integration variant (preferred) or correct the header to file as a follow-up. Recommended: file as follow-up (the bridge-paper-author-gate task established the precedent of mocked + grep canaries; real-HAF integration for spoofed-continuation seeding has the same impracticality).
- (b) Bridge-paper attacker case not directly asserted in fixture. The bridge-paper test at line 371 verifies the bridge account is excluded from the ANY() filter but doesn't directly assert attacker exclusion in the bridge fixture. Add a one-line attacker-exclusion assertion to the bridge case (requires BUG fix item 5 to land first; the case will then exercise the new bridge-paper special-case path).

**7. (P2) Inline `isAuthorizedContinuationAuthor` trivial Set.has wrapper.** `helpers.ts:123-126`: 3 executable lines + 22-line JSDoc. The type guard isn't reused. Inline at the single call site as `authorizedAuthors.has(candidateAuthor)`; keep `extractAuthorizedContinuationAuthors` (which earns its keep by normalizing heterogeneous on-chain data); remove the redundant export and its describe block in the test file. Reduces helper-bloat without losing coverage (the unit tests for `extractAuthorizedContinuationAuthors` are sufficient).

**8. (P2 — frontend side, folded from cluster ζ review) UI warning for malformed-metadata case.** `frontend/src/pages/edit.js:431-438` `userPostInChain` walk: if head paper has empty/missing `pevo.authors[]` (malformed), backend gate degenerates chain to root-only → legitimate co-author's `userPostInChain` returns null → `isContinuation` falls through to `head_author/head_permlink` fallback → routes the edit as a NEW continuation rather than native edit.

Fix: if `userPostInChain` returns null AND `currentUser.username` IS in `paper.pevo.authors[].hive`, surface a UI warning ("Server-side metadata incomplete; please refresh") rather than silently mis-routing. NOTE: this lives in `frontend/`, NOT backend's zone — the fix belongs in the held ζ task `ui-coauthor-continuation-publishing.md`, not here. Listed for traceability; ζ's hold block carries this item.

### Items dismissed during architect triage

- **`fetchHeadAuthorizedAuthors` lacks `validPevoPaperWhere` SQL identity pin** (sec-6) — covered by item 1's chain-walk SQL fix; the head-fetch SELECT will inherit the predicate.
- **JS-side `break`-on-first-unauthorized untested** (RR-3) — edge case (legitimate author after attacker in chain order); SQL filter prevents in production.
- **Regex sensitivity to `::text[]` cast** (T-02) — cosmetic; refactor would correctly fail.
- **Weak spoof-rejection assertion in canary** (Correctness-5, P4) — P4, low criticality given other coverage.
- **Stale `Refs:` line in commit body** (PS-002) — commit body is immutable on pushed history; future commits can be written correctly.

### Items deferred to follow-up tasks

- **`backend-coauthor-trust-model.md`** (P1 architecture/security) — broader insider-abuse defense: co-signing / locked fields / additive-only authorship design exploration. Surfaced by item 2 above; the locked-fields hold-fix here is a scoped immediate defense, not the full design.
- **`backend-canonical-root-walker-author-gate.md`** (P2 security) — `findCanonicalRoot` walks attacker-controlled `pevo.continues` pointers backward without author check, up to 51 SQL queries per request fully attacker-induced (DoS amplifier) + URL-redirect phishing pretext. Forward content-spoof is correctly blocked by the new gate; backward walking is the residual surface.

### Architect followups (land at archive, do NOT block backend re-submit)

- **A1.** Correct the implementer signal block's commit cite — the implementation note above references `da5d371`, but `da5d371` is NOT an ancestor of main (orphan worker-worktree commit). The actual on-main implementation commit is `063ead7`. Add a parenthetical when archiving.
- **A2.** `[TODO Architect]` items 1, 2, 3 from the implementer signal block remain architect-owned at archive: ARCHITECTURE.md metadata-trust row, papers.md version-chain admission rule, convention doc "Sites this convention applies to" sub-section. The convention doc update should ALSO incorporate the structural-rule strengthening surfaced by hold item 1 (above): "every gate enforces author + type identity together."
- **A3.** Append WHY comments inline at archive time:
  - `routes/papers.ts:709-712` `fetchHeadAuthorizedAuthors` catch — document the fail-soft choice (returns null → root-only chain on transient DB error).
  - `routes/papers.ts:742-749` — document the root-vs-head pin choice (gate references ROOT's authors[], not chain-head's; deliberate per task spec; co-author added in v2's metadata cannot post a continuation).

### Re-review signal

When items 1-7 land (item 8 lives in ζ), `git mv` this file back to `tasks/review/`. The architect's next review pass scopes `/ce-code-review` to the round-2 commits and archives on clean. Item 5 (bridge-paper continuation BUG) requires architect blessing on the design choice (Option b recommended) before backend implements; surface in the implementer's intake question if not yet ratified.

---

## Backend re-review signal (2026-05-04, commit 4e145fc)

Round-2 hold-fix items 1-7 all landed in commit `4e145fc` (cherry-pick of worker `5105646f`). User (acting as architect) ratified **Option b** for item 5 on intake.

**Item 1 (P1) — Continuation type-spoof closed.** `resolveContinuationChain` chain-walk SQL now wraps `validPevoPaperWhere(source: 'all')`; JS-side `isPevoAnyPaper(candidateMeta, candidateAuthor)` re-check on the candidate's parsed metadata. A vouched co-author posting `pevo.type='review'` with `continues={...}` can no longer surface review content as the paper's apparent body. Canary `'rejects a continuation type-spoof'` simulates SQL-predicate bypass and asserts the JS gate trips.

**Item 2 (P1) — Co-author display-spoof closed (scoped).** `fetchPaperDetailFromHaf`'s head-meta override now (a) subset-checks head's `pevo.authors[].hive` against root's authorized-author set (rejects widening into mallory/etc.; warns `event: 'continuation_authors_subset_violation'`), (b) root-pins `ipfs_cid` + `document_hash` (never overridden by continuations). `title`/`body`/`abstract`/`discipline`/`keywords`/`citations`/`language` continue to evolve. Two canaries: subset-rejection on widening, root-pin on payload pointers. Broader trust-model deferred to `backend-coauthor-trust-model.md`.

**Item 3 (P1) — Redundant casts removed.**
- `helpers.ts`: `extractAuthorizedContinuationAuthors` extracts `entry` once via `const e = entry as Record<string, unknown>`.
- `routes/papers.ts`: typeof guards added at `fetchHeadAuthorizedAuthors` (return null on non-string author) and the chain-walk hop (break on non-string `candidateAuthor`).

**Item 4 (P2 batched).**
- (a) Lowercase applied to extracted `pevo.authors[].hive` entries.
- (b) Audit log: `event: 'paper_authors_metadata_edit'` warn fires from `reconstructVersionsFromHaf` whenever `pevo.authors[]` mutates between versions of the same post.
- (c) Versioned cache invalidation: `/invalidate` now flushes `paper-detail:{author}:{permlink}:v*` keys via new `QueryCache.invalidatePrefix()` (Redis SCAN+DEL, in-memory prefix-scan fallback). New `cache.test.ts` case pins prefix-match semantics.
- (d) Hoisted `resolveContinuationChain` out of `Promise.all` in `fetchPaperDetailFromHaf`; `reconstructVersionsFromHaf` accepts an optional `prefetchedChain` to avoid duplicate fetches.

**Item 5 (P1 BUG, Option b ratified) — Bridge-paper continuations work.** `extractAuthorizedContinuationAuthors` signature changed to `(pevoMeta, headAuthor)`. When `pevoMeta.type === 'bridge_paper' && headAuthor === config.hiveBridgeAccount`, the authorized set is `{config.hiveBridgeAccount}`. `bridge.ts /update` is now the only legitimate continuator. Canaries: bridge account admitted; arbitrary attackers AND original-preprint accounts excluded.

**Item 6 (P2 batched) — Test scaffolding.**
- (a) Test file header corrected to remove false claim about real-HAF coverage; marks real-HAF as filed follow-up.
- (b) Attacker-exclusion assertion added to bridge canary (now exercises Option b's bridge-paper special-case path).

**Item 7 (P2) — `isAuthorizedContinuationAuthor` inlined.** Removed export + dedicated tests. Single call site uses `authorizedAuthors.has(candidateAuthor)` directly. `extractAuthorizedContinuationAuthors` retained (richer with bridge-paper special case + lowercase normalization).

### Verification

- Targeted vitest: `continuation-author-gate.test.ts` 17/17, `helpers.test.ts` 21/21, `papers.test.ts` 12 passed + 1 skipped (pre-existing), `cache.test.ts` 10/10, `bridge-paper-author-gate.test.ts` 14/14 (regress clean), `paper-detail-v3.test.ts` 1/1.
- `npx tsc --noEmit`: clean.
- `npm run lint`: clean. Discipline tripwire OK.

### [TODO Architect]

Round-1 architect followups A1, A2, A3 carry forward (commit-cite correction, ARCHITECTURE.md WHY comments at lines 709-712 and 742-749). Round-2 brings additional contract prose:

- **`agents/docs/ARCHITECTURE.md`** — append a row to the metadata-trust table for `pevo.continues = {author, permlink}` (gated on named-author membership; bridge papers special-case to `config.hiveBridgeAccount`).
- **`agents/docs/api-contracts/papers.md`** — version-chain admission rule note (server-side filter, no client-visible API change).
- **`agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`** — append "Sites this convention applies to" sub-section enumerating both surfaces (bridge_paper + pevo.continues), AND incorporate the structural-rule strengthening: "every gate enforces author + type identity together, not just one."

---

## Architect re-review (2026-05-05, round-3) — HELD PENDING FIXES

These findings did not come from a fresh `/ce-code-review` pass on the round-2 commit `4e145fc`; they surfaced during the brainstorm of `backend-coauthor-trust-model` and the `/ce-doc-review` of the resulting Multi-Author Trust Model spec landed in `agents/docs/ARCHITECTURE.md` (commit `ddd1c69`). Both are corrections to round-2's hold-fix item 2 ("Co-author display-spoof closed (scoped)"). Both block archive.

### Items to address

**1. (P1) Subset-check inversion on `pevo.authors[]` override.** `backend/src/routes/papers.ts:625-635` implements `headAuthors ⊆ rootAuthors` (every entry in head's authors must be in root's). This is the wrong direction:

- Removing authors silently passes the subset check (e.g., `{bob} ⊆ {alice, bob}` passes — bob silently drops alice). This IS the insider-abuse vector the round-2 fix was supposed to defend against.
- Adding authors fails the subset check, contradicting the canonical version-chain semantics in `agents/docs/solutions/architecture-patterns/pevo-paper-version-chain-and-edit-semantics-2026-04-30.md` rule #4 (`pevo.authors[]` is monotonic; additions are legitimate when a co-author joins during revision) AND contradicting the Multi-Author Trust Model spec just landed in ARCHITECTURE.md.

The right rule per ARCHITECTURE.md "Authors mutation" subsection (just landed):

- Head's `pevo.authors[].hive` may be a SUPERSET of root's (additions allowed; new entries are claimed-pending until the new author broadcasts a valid `author_accept` op — Phase 2 of `backend-coauthor-trust-model` adds the accept/resign primitive).
- Head's `pevo.authors[].hive` MUST NOT shrink. If any name in root's `pevo.authors[].hive` is missing from head's, the override is rejected and an audit event is logged (`event: 'continuation_authors_shrink_violation'`).
- Vouched-set computation reads `author_accept`/`author_resign` ops; that is Phase 2 work. For round-3's hold-fix the simpler "no-shrink" rule is the immediate correction. Phase 2 layers the consent ops on top.

Concretely: replace the `headAuthorsAreSubset` check with `headAuthorsCoverRoot` (or equivalent) — every name in `rootAuthorSet` MUST appear in `headAuthorsRaw`'s extracted hive set. New names in head are admitted (will be claimed-pending in the long-term model; for round-3 they're written into the displayed authors list as plain entries pending Phase 2). Update the audit-event tag accordingly. Update canary tests:

- `'rejects head metadata that drops a root author'` — bob's continuation with `pevo.authors=[bob]` (alice missing) is rejected; warn fires.
- `'admits head metadata that adds a new author'` — bob's continuation with `pevo.authors=[alice, bob, carol]` is admitted; carol surfaces in the displayed list.

**2. (P1) `ipfs_cid` and `document_hash` root-pin is wrong-shaped.** `backend/src/routes/papers.ts:656-658` root-pins these fields, never overriding from continuations. This kills the legitimate revision use case where each version has its own PDF (alice's v1 has CID_A, bob's v2 has CID_B).

The right rule per ARCHITECTURE.md "Field mutation rules" table (just landed):

- Each chain post's `ipfs_cid`, `document_hash`, and `ipfs_filename` apply to that version's view.
- The default `/api/papers/:author/:permlink` view (no `?version=N`) reads from the chain head, like other free-edit fields.
- `?version=N` reads from the N-th version's metadata.
- All historical CIDs are preserved on chain (Hive immutability); the pinner agent retains them per the "Pinner constraint" subsection.

Concretely: replace the root-pin assignments at `backend/src/routes/papers.ts:656-658` with head-preferred lookup with root fallback:

```ts
detail.ipfs_cid = headPevo.ipfs_cid ?? rootPevo.ipfs_cid ?? null;
detail.ipfs_filename = headPevo.ipfs_filename ?? rootPevo.ipfs_filename ?? null;
detail.document_hash = headPevo.document_hash ?? rootPevo.document_hash ?? null;
```

Update the comment block at `backend/src/routes/papers.ts:595-613` to reflect the corrected reasoning (per-version retention + per-version display, not root-pin). Update canary tests:

- `'shows head's ipfs_cid for the default view when continuation provides one'` — bob's continuation with a different `ipfs_cid` becomes the displayed CID for the head view.
- `'falls back to root ipfs_cid when head doesn't carry one'` — head metadata without `ipfs_cid` reads root's.
- Both `?version=1` and `?version=2` retrieve the correct per-version CID.

The risk of bob spoofing his continuation's `ipfs_cid` to a different paper is treated identically to body-spoof: accepted risk, broadcaster-attributed reputation flow, on-chain audit trail, accreditation revocation as deterrent. Document this in the comment block.

### Re-review signal

When items 1-2 land, `git mv` this file back to `tasks/review/`. The architect's next review pass scopes `/ce-code-review` to the round-3 commits (since the original `/ce-code-review` pass covered round-2). Both items are inline corrections to existing logic — small diff expected.

### Cross-references

- `agents/docs/ARCHITECTURE.md` section 2 "Multi-Author Trust Model" — canonical spec for the corrected rules (commit `ddd1c69`).
- `agents/docs/tasks/pending/backend-coauthor-trust-model.md` — Phase 2 implementation of the full consent-op flow (`author_accept`/`author_resign`); ε's round-3 fixes establish the minimal correct rule that Phase 2 layers on.
- `agents/docs/solutions/architecture-patterns/pevo-paper-version-chain-and-edit-semantics-2026-04-30.md` — version-chain semantics that the no-shrink rule restores compatibility with.
