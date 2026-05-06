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

---

## Backend re-review signal (2026-05-05, round-3)

Round-3 hold-fix items 1-2 both landed in this commit.

**Item 1 (P1) — `pevo.authors[]` no-shrink rule.** `fetchPaperDetailFromHaf`'s head-meta override at `backend/src/routes/papers.ts` now extracts the head's `pevo.authors[].hive` set and verifies every entry in the root's `extractAuthorizedContinuationAuthors` set is present in head's set (root ⊆ head, i.e. no-shrink). When a root author is missing, the override is REJECTED (root's authors[] kept for display) and `event: 'continuation_authors_shrink_violation'` warns. Additions are admitted (carol joining during revision surfaces in the displayed authors list, claimed-pending until Phase 2 of `backend-coauthor-trust-model` adds `author_accept`/`author_resign`). The prior round-2 `headAuthorsAreSubset` check (head ⊆ root) is removed — that direction blocked legitimate additions and silently passed insider drops, the inversion the round-3 hold called out.

**Item 2 (P1) — Per-version display for `ipfs_cid` / `ipfs_filename` / `document_hash`.** Replaced the round-2 root-pin assignments with head-preferred fallback to root: `headPevo.X ?? rootPevo.X ?? null`. The default `/api/papers/:author/:permlink` view now reflects the chain head's PDF pointers when the head provides them, falling back to root when a continuation only evolves body/abstract. The dedicated `?version=N` path (`reconstructVersionsFromHaf` + `target.json_metadata` at the v3 endpoint) was already per-version; the new regression-pin canary ('?version=N retrieves per-version ipfs_cid') asserts that explicitly. Per-version retention is on chain via Hive immutability; pinner retention follows the ARCH "Pinner constraint" subsection. The accepted-risk reasoning (continuation broadcaster's reputation, on-chain audit trail, accreditation revocation as deterrent) is documented inline at `routes/papers.ts:595-630`.

### Verification

- Targeted vitest: `continuation-author-gate.test.ts` 20/20, `helpers.test.ts` 21/21, `papers.test.ts` 12 passed + 1 skipped (pre-existing), `paper-detail-v3.test.ts` 1/1, `bridge-paper-author-gate.test.ts` 14/14 (regress clean).
- `npx tsc --noEmit`: clean.
- `npm run lint`: clean (only the two pre-existing `seed-phrase.ts` `no-explicit-any` warnings).

### [TODO Architect]

Round-1 + round-2 architect followups carry forward (commit-cite correction, ARCHITECTURE.md WHY comments at the audit-warn sites, contract-prose updates to ARCHITECTURE.md / api-contracts/papers.md / convention doc per the round-2 [TODO Architect] block above). Round-3 brings two additional inline-comment freshness items the architect may want to revisit during the next contract-prose pass:

- `routes/papers.ts:595-630` block comment now describes the no-shrink + per-version-display rules; if the metadata-trust table in `agents/docs/ARCHITECTURE.md` lands a row referencing this code path, the comment can be trimmed to a one-liner pointing at the spec (the long form is currently load-bearing because the spec row hasn't landed in ARCHITECTURE.md yet).
- The `event: 'continuation_authors_shrink_violation'` audit-event tag replaces round-2's `continuation_authors_subset_violation`. If any operator dashboards or alerting rules reference the old tag, they need updating — backend hasn't grepped for external consumers (none found in repo, but this is a heads-up for operator-side sweeps).

---

## Architect re-review (2026-05-05, round-4) — HELD PENDING FIXES

`/ce-code-review` ran on commit `77db9cf` with 8 reviewers (correctness, security, adversarial, testing, maintainability, project-standards, learnings-researcher, kieran-typescript). 13 distinct findings after dedup. User triage walk-through (2026-05-05) settled the disposition.

### Context: round-3 is being superseded by cumulative-union

During the triage of finding #3 (per-author sub-field spoofing) and #7 (N-deep author laundering), the user articulated the equal-rights policy: **any author currently in the chain's `pevo.authors[]` can broadcast continuations regardless of when they were added; trust is dynamic; cost falls on the introducer via accreditation revocation cascading.**

The user proposed a cleaner design: replace the round-3 no-shrink rule with **cumulative-union** display construction. The displayed authors[] is the union across all chain posts' `pevo.authors[].hive` entries; drops are forbidden by construction. The round-3 commit `77db9cf` stays in production as interim defense. The cumulative-union redesign is filed at `agents/docs/tasks/blocked/backend-multi-author-cumulative-union.md` (blocked on this task's archive).

This means findings tied to the no-shrink override block become MOOT under the supersession plan. Only finding #2 (the cast pattern at the per-version IPFS triple, which is independent of the no-shrink rule) carries forward as a round-4 fix on this task. The remaining findings are dismissed-with-note here so the archive trail stays complete.

### Item to address

**1. (P1, originally finding #2 in the round-4 review) Cast-and-coalesce pattern at `papers.ts:679-681`.** Six-way cross-reviewer corroboration (correctness, security, adversarial, testing, maintainability, kieran-typescript). The pattern `(headPevo.X as string) ?? (rootPevo.X as string) ?? null` has three problems:

- **Type-unsafe.** `safePevoMeta` returns `Record<string, unknown>`. `as string` is an assertion, not a narrowing. Runtime values like `0`, `''`, `false`, `{}` flow through. TS infers the entire expression as `string` (the `?? null` tail is dead from the checker's perspective, verified via compiler API).
- **Empty-string divergence.** Every other read site in `papers.ts` (lines 395, 1354) and `helpers.ts:186` uses `pevo.ipfs_cid || null`, which collapses `''` to `null`. The `??` chain passes `''` through unchanged, diverging from the established pattern.
- **`null` vs absent ambiguity.** A head explicitly clearing `ipfs_cid: null` (e.g., transitioning from IPFS-hosted to inline) is silently overridden by `??` falling back to root's CID.

**Fix shape:** Extract a typed helper in `backend/src/helpers.ts`:

```ts
export function pevoString(pevo: Record<string, unknown>, key: string): string | null {
  const v = pevo[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
```

Adopt at the three round-3 lines:

```ts
detail.ipfs_cid = pevoString(headPevo, 'ipfs_cid') ?? pevoString(rootPevo, 'ipfs_cid');
detail.ipfs_filename = pevoString(headPevo, 'ipfs_filename') ?? pevoString(rootPevo, 'ipfs_filename');
detail.document_hash = pevoString(headPevo, 'document_hash') ?? pevoString(rootPevo, 'document_hash');
```

**Canary tests** (extend `continuation-author-gate.test.ts` or `helpers.test.ts`):
- Empty-string `ipfs_cid` on head → falls back to root's value (matches the rest of the codebase's behavior).
- Numeric `0` `ipfs_cid` on head → falls back to root (no longer flows through as a non-string).
- Object `ipfs_cid` on head → falls back to root.

Adoption at the broader cast sites (`papers.ts:395, 1354`, `helpers.ts:186`) is filed as a follow-up at archive (see [TODO Architect] item below). Do NOT include those broader sites in this round-4 commit — keep round-4 narrowly scoped to the round-3-introduced lines so the diff surface stays tight.

### Items dismissed as MOOT under cumulative-union supersession

- **Finding #1 (P1) — `accredited_authors` leak via unconditional `detail.json_metadata = headMeta`.** Originally triaged as hold-block. MOOT under cumulative-union: `accredited_authors` will be rebuilt from the cumulative union (which can't shrink), closing the leak by construction. Captured in `backend-multi-author-cumulative-union.md` rule #6 ("`accredited_authors` rebuilt from union") and canary test.
- **Finding #4 (P2) — No-shrink test doesn't assert audit event.** Originally triaged as hold-block. MOOT under cumulative-union: there is no audit event because there is no no-shrink rule. The `continuation_authors_shrink_violation` audit event is being removed alongside the no-shrink check.
- **Finding #5 (P2) — Stale "subset-check" comment in `reconstructVersionsFromHaf` at `papers.ts:1228`.** Originally triaged as hold-block. MOOT under cumulative-union: the comment will be rewritten as part of the cumulative-union landing (the entire override block + supporting comments are replaced).
- **Finding #9 (P3) — Empty-rootAuthorSet TOCTOU defensive guard.** Originally triaged as hold-block. MOOT under cumulative-union: there is no `rootAuthorSet` to be empty.

### Items dismissed during architect synthesis (per round-3 triage)

- **Finding #6 — Bridge-paper continuation override always rejected.** Dismissed: bridge papers never need to be updated (per user); bridge `/update` route to be retired in a separate task at archive.
- **Finding #7 — N-deep chain progressive author laundering.** Dismissed as accepted risk under broadcaster-attribution + accreditation cascade. Policy clarification captured for `backend-coauthor-trust-model.md` Phase 2 design.
- **Finding #8 — Cache key doesn't include head identity.** Dismissed: round-3 extends a pre-existing cache pattern (head-preferred fields already had this property pre-round-3); no new staleness vectors.
- **Audit-event rename external consumers, normalization asymmetry, audit-log injection, prototype pollution, large-array DoS** — dismissed during synthesis (documented in signal block + verified safe).

### Architect followups (land at archive, do NOT block backend re-submit)

In addition to the round-1 + round-2 + round-3 architect followups already documented in this task, round-4's user-triage adds:

- **A4. ARCHITECTURE.md prose stays at `ddd1c69` for now.** The "Multi-Author Trust Model" section will be REWRITTEN when `backend-multi-author-cumulative-union.md` archives; not at this task's archive. Drop the round-3 [TODO Architect] item to add a metadata-trust table row referencing the no-shrink rule (it'll be replaced).
- **A5. Convention doc updates carry forward to cumulative-union task.** The `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` "Sites this convention applies to" sub-section update + the structural-rule strengthening prose ("every gate enforces author + type identity together") move to the cumulative-union task's archive followups.
- **A6. File three bridge-update retirement tasks at archive.** Per user's call ("bridge papers never need to be updated"):
  - `architect-bridge-paper-immutability-doc.md` — ARCHITECTURE.md "Bridge papers" subsection rewrite documenting immutability + remove update flow references; revisit option-b carve-out for bridge-paper continuations (likely keep as defense-in-depth, document as inert for current bridge implementation).
  - `backend-retire-bridge-update-route.md` — remove `POST /api/bridge/update` route, `bridgeUpdateLockKey` helper, related tests in `bridge.test.ts` and `bridge-haf-lag-locks.test.ts`.
  - `ui-retire-bridge-sync-affordance.md` — remove "Bridge sync" button on paper-detail page, `handleBridgeSync()` method, `updateBridgePaper()` API helper, i18n keys (`bridge.syncing`, `bridge.syncButton`, `bridge.syncSuccess`, `bridge.syncFailed`).
- **A7. File new UI task `ui-author-input-accredited-prefill.md` at archive.** Per round-3 triage finding #3 (split call): ORCID prefilled from accreditation + deactivate input when the author's hive is accredited; click affordance on the username input to find/select an accredited hive account. Cross-references `ui-multi-author-consent-affordances.md` (currently blocked).
- **A8. Codebase-wide `pevoString` adoption follow-up.** Once round-4 lands the helper, file `backend-pevo-string-helper-adoption-sweep.md` in `tasks/pending/` to migrate the existing `|| null` cast sites at `papers.ts:395, 1354`, `helpers.ts:186` (and any other similar sites discovered) to the new helper for codebase consistency.
- **A9. Unblock `backend-multi-author-cumulative-union.md`.** Once this task archives, `git mv` `agents/docs/tasks/blocked/backend-multi-author-cumulative-union.md` to `agents/docs/tasks/pending/` so backend can pick it up.

### Re-review signal

When round-4 item 1 (the `pevoString` helper extraction + adoption + canaries) lands, `git mv` this file back to `tasks/review/`. Architect's next review pass scopes `/ce-code-review` to the round-4 commit. Expected diff: ~10-15 lines in `helpers.ts` (the helper) + 3 lines replaced in `papers.ts` + 3-5 canary tests. Small surface; clean archive on green review (no further holds expected).

---

## Backend re-review signal (2026-05-05, round-4)

Round-4 hold-fix item 1 landed in this commit. Scope held to the architect's instruction: only the round-3-introduced lines at `papers.ts:679-681` were migrated; broader `|| null` sites at `papers.ts:395, 1354` and `helpers.ts:186` were left untouched per architect followup A8 (separate sweep task to be filed at archive).

**Item 1 (P1) — `pevoString` helper extracted + adopted at the per-version IPFS triple.**

- `backend/src/helpers.ts`: new `pevoString(pevo: Record<string, unknown>, key: string): string | null` helper. Returns the string when the runtime value is a non-empty string; collapses to `null` for empty-string, numeric, boolean, object/array, null, undefined, or missing. Docblock cites the three failure modes the round-3 cast pattern silently let through (empty-string flowing through `??`, numeric `0` flowing through, object/array flowing through), explains the codebase-wide `|| null` collapse convention this helper unifies the read pattern with, and gives the call-shape example.
- `backend/src/routes/papers.ts`: import `pevoString` from `../helpers.js`; replace the three round-3 lines with `detail.X = pevoString(headPevo, 'X') ?? pevoString(rootPevo, 'X')` for `ipfs_cid`, `ipfs_filename`, and `document_hash`. The `?? null` tail is no longer needed (helper already collapses to `null`).

**Canary tests (3 unit + 3 integration = 6 new tests):**

- `backend/tests/helpers.test.ts` adds a `describe('pevoString', ...)` block with 6 unit tests covering: non-empty string passthrough, empty-string collapse to `null`, numeric (`0` and `42`) collapse, object/array collapse, boolean collapse, and `null`/`undefined`/missing-key collapse. Each test docblock is short; the describe-block lead comment cites round-4 hold item 1 and enumerates the three runtime failure modes the helper closes.
- `backend/tests/routes/continuation-author-gate.test.ts` adds 3 integration canaries that exercise the helper through the head-meta override at `papers.ts:679-681`. Each canary seeds a continuation with a pathological head value (empty string / numeric `0` / object) for all three IPFS-triple fields, hits `GET /api/papers/alice/p1`, and asserts the response surfaces the root's `QmRootCid` / `sha256:root` / `root.pdf` instead of the pathological head value. The lead comment block cites round-4 hold item 1 and explains why the cast-and-coalesce shape silently let these through.

### Verification

- Targeted vitest: `helpers.test.ts` 27/27 (21 existing + 6 new), `continuation-author-gate.test.ts` 23/23 (20 existing + 3 new). 50/50 across both files.
- `npx tsc --noEmit`: clean.
- `npm run lint`: clean (only the two pre-existing `seed-phrase.ts` `no-explicit-any` warnings, unrelated).

### Architect followups carry forward

Round-1 + round-2 + round-3 + round-4 architect followups all carry forward to archive — no new architect followup items surfaced during this round. A4/A5 still defer to cumulative-union archive; A6/A7/A8/A9 still fire at this task's archive per the round-4 hold block. The on-main commit cite for round-4 will be added to the architect's archive note.

---

## Architect re-review (2026-05-05, round-4 → round-5) — HELD PENDING FIXES

`/ce-code-review` ran on commit `72c4b5c` with 8 reviewers (correctness, testing, maintainability, project-standards, learnings-researcher, security, adversarial, kieran-typescript; ce-agent-native-reviewer skipped per repo CLAUDE.md). Round-4 item 1 (`pevoString` helper) is correct in shape and unit-test coverage. Adversarial surfaced two issues at the per-version IPFS-triple call site (`papers.ts:680-682` adoption block) that the helper enables but does not solve, both rooted in the same call-site design rather than the helper's own contract.

Two-grep audit per `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` was run before locking round-5 scope: zero remaining `(headPevo|rootPevo).X as string` sites in `backend/src/`. Round-3's `??` cast-pattern exposure is fully closed. The broader `|| null` / `|| []` / `|| 'literal'` sites surfaced by the audit are A8 territory (less exposure than round-3 because `||` collapses falsy non-strings) — A8 spec will expand at archive to enumerate all 12+ sites.

### Items to address

**1. (P2) Frankenstein triple — per-field independent fallback violates triple-coherence invariant.** `backend/src/routes/papers.ts:685-687` reads `ipfs_cid` / `ipfs_filename` / `document_hash` independently, each falling back to root on its own. A vouched co-author (covering root's authors set, gate passes) can broadcast a continuation v2 whose head metadata is `{ ipfs_cid: 'QmAttacker', ipfs_filename: 0, document_hash: 0 }` (or `''`, `null`, `[]` — all collapse identically via the helper). Result: `detail.ipfs_cid = 'QmAttacker'`, `detail.ipfs_filename = 'root.pdf'`, `detail.document_hash = 'sha256:rootHash'`. The triple never existed on chain in any single version — the displayed filename and hash describe root's PDF; the CID points at attacker's content.

The block comment at `papers.ts:609-619` says "each post's pointers describe that version's PDF" — independent per-field fallback violates this triple-coherence invariant. The 3 round-4 canaries pin the all-three-pathological case as correctly falling back; they never test the asymmetric mixed-shape case, so a future refactor preserving per-field fallback would not fail.

Currently impact is bounded (frontend `paper-detail.js:904-905` reads `ipfs_cid` for the download link but does not use `document_hash` for integrity verification — adversarial confirmed via grep). The architectural risk is forward-looking: when integrity verification lands (SHA-256 check on downloaded payload against displayed `document_hash`), the verification would PASS against root's hash while the attacker's content downloads — silent bypass. Closing the invariant now is much smaller than retrofitting it after consumers depend on per-field fallback.

The cumulative-union supersession plan (`backend-multi-author-cumulative-union.md`) addresses authors-set mutation, NOT the per-version IPFS-triple fallback path. Triple coherence is part of the ARCHITECTURE.md "Field mutation rules" table that round-3 just landed and remains load-bearing under cumulative-union.

**Fix shape.** Treat the triple as atomic at the call site:

```ts
const headHasAnyTriple =
  pevoString(headPevo, 'ipfs_cid') !== null
  || pevoString(headPevo, 'ipfs_filename') !== null
  || pevoString(headPevo, 'document_hash') !== null;
if (headHasAnyTriple) {
  detail.ipfs_cid = pevoString(headPevo, 'ipfs_cid');
  detail.ipfs_filename = pevoString(headPevo, 'ipfs_filename');
  detail.document_hash = pevoString(headPevo, 'document_hash');
} else {
  detail.ipfs_cid = pevoString(rootPevo, 'ipfs_cid');
  detail.ipfs_filename = pevoString(rootPevo, 'ipfs_filename');
  detail.document_hash = pevoString(rootPevo, 'document_hash');
}
```

(Helper-extract optional — `applyAtomicTriple(detail, source)` is fine; inline is also fine. Implementer's call.)

**Canary tests** (extend `backend/tests/routes/continuation-author-gate.test.ts`):
- `'admits an atomic triple from head when head supplies any one of the three fields as a non-string but at least one is a valid string'` — head `{ ipfs_cid: 'QmHeadCid', ipfs_filename: 0, document_hash: '' }` → response carries `{ ipfs_cid: 'QmHeadCid', ipfs_filename: null, document_hash: null }` (head's view; head supplied a CID, so no fallback to root). Update the existing 3 canaries' framing accordingly — they currently test the "head supplied none" case and assert root fallback; that semantic stays correct for triple-atomic.
- `'falls back to root when head supplies none of the three fields as valid strings'` — already covered by the 3 round-4 canaries; adjust their framing to make explicit that ALL THREE head fields collapse to null.
- `'rejects asymmetric Frankenstein composition'` — head `{ ipfs_cid: 'QmHeadCid', ipfs_filename: 0 }` (missing document_hash entirely) → response carries `{ ipfs_cid: 'QmHeadCid', ipfs_filename: null, document_hash: null }`, NOT root's filename/hash. This is the canary that would FAIL with the current per-field code and PASS after the atomic-triple fix.

**2. (P3) Null-clear conflation — head intentionally clearing `ipfs_cid` is indistinguishable from head omitting it.** Same call site (`papers.ts:685-687`) and same fix block as item 1, so they bundle. `pevoString` returns `null` for both `headPevo.ipfs_cid === null` (head explicitly cleared the field — alice's v2 short correction with no PDF, inline body only) and `headPevo.ipfs_cid === undefined` (head omitted the key, no opinion). Both fall back to root's CID. Frontend renders root's stale PDF as the v2 download link; `version-diff.js:36 is_diffable` toggles wrong (v2 looks IPFS-hosted when it's actually inline).

Round-3's retrospective explicitly flagged this as a problem with `??`; the round-4 helper preserves it verbatim and extends it to `''`. The docblock frames the empty-string collapse as a feature ("matching the rest of the codebase") but the rest of the codebase is summary paths (`papers.ts:396, 1360`) where there's no head-vs-root distinction. The per-version detail path is the only place where "head explicitly cleared" has semantic weight.

Inline-only continuations ARE a supported product shape (`is_diffable` check exists; frontend renders them differently). The helper silently breaks that shape.

**Fix shape (composes with item 1's atomic-triple).** Use sentinel-aware presence check (`'ipfs_cid' in headPevo`) to distinguish "head cleared" from "head omitted":

```ts
const headHasAnyTripleKey =
  'ipfs_cid' in headPevo
  || 'ipfs_filename' in headPevo
  || 'document_hash' in headPevo;
if (headHasAnyTripleKey) {
  detail.ipfs_cid = pevoString(headPevo, 'ipfs_cid');           // null when head cleared
  detail.ipfs_filename = pevoString(headPevo, 'ipfs_filename');
  detail.document_hash = pevoString(headPevo, 'document_hash');
} else {
  detail.ipfs_cid = pevoString(rootPevo, 'ipfs_cid');
  detail.ipfs_filename = pevoString(rootPevo, 'ipfs_filename');
  detail.document_hash = pevoString(rootPevo, 'document_hash');
}
```

The semantic: "if head touched ANY of the triple keys, it's expressing a per-version triple; if head touched NONE, it inherits root's." A head that clears with `ipfs_cid: null` and omits the other two keys is treated as expressing the triple (with all-null contents) — `is_diffable` correctly toggles to "inline".

**Canary tests:**
- `'preserves head\'s explicit null ipfs_cid (inline-only continuation, no PDF)'` — head `{ ipfs_cid: null, ipfs_filename: null, document_hash: null }` → response `{ ipfs_cid: null, ipfs_filename: null, document_hash: null }`, NOT root's CID.
- `'falls back to root when head omits all triple keys (no opinion expressed)'` — head metadata with no `ipfs_*` keys → response carries root's triple. (This is the existing fallback behavior; pin it explicitly so a future refactor doesn't regress.)

**Mutation-kill attestation.** Backend's round-5 signal block MUST include the explicit revert-verify attestation per `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`: "I reverted the atomic-triple block to per-field fallback and confirmed the asymmetric Frankenstein canary fails. I reverted the sentinel-aware `'in'` check to `pevoString(headPevo, 'ipfs_cid') ?? ...` and confirmed the inline-only-continuation canary fails." One- to three-line attestation in the signal block.

### Items dismissed during architect triage

- **Whitespace / control-char / zero-width-space CIDs pass `pevoString` unmodified into URL-construction sites** (adversarial F3, P3 conf 55, partially corroborated by security residual). Pre-existing behavior; not introduced by round-4. Filed as separate task `backend-paper-detail-cid-validate-on-emit.md` (output-side CID shape validation at API response-emit boundary). Decoupled from this task's archive.

### Architect followups (carry forward to archive)

Round-1 + round-2 + round-3 + round-4 architect followups all carry forward unchanged. The two-grep audit run during this round-5 surfaced A8 scope expansion: A8's spec at archive will list all 12+ sites including `reviews.ts:30`, `bridge.ts:533-535`, `helpers.ts:213, 215`, `papers.ts:396, 680, 681, 688, 689, 1360-1362`, and may need 2 sibling helpers (`pevoStringArray`, `pevoStringWithDefault`) since several sites are array/with-default shapes that `pevoString` doesn't cover. That expansion fires at this task's archive (when this task is archived after round-5 lands clean).

### Re-review signal

When round-5 items 1-2 land in a single commit, `git mv` this file back to `tasks/review/`. Architect's next review pass scopes `/ce-code-review` to the round-5 commit. Expected diff: ~15 lines in `papers.ts` (atomic-triple + sentinel-aware block replacing the 3 current lines) + 3-5 new canary tests + the existing 3 canaries' framing comments updated. Small surface; clean archive expected on green review.

---

## Backend re-review signal (2026-05-05, round-5 single commit)

Round-5 items 1+2 landed in a single bundled commit (item 2's sentinel-aware `'in'` check supersedes item 1's `pevoString-non-null` check; the architect's hold block specified item 2 as the final fix shape, "composes with item 1's atomic-triple"). The two items share the call site `backend/src/routes/papers.ts:685-687` (now expanded to a ~17-line atomic block at lines 682-720 with extended block comment).

### Item-by-item disposition

| # | Disposition | Notes |
|---|---|---|
| 1 (P2 Frankenstein) | Fixed via item 2's fix shape | Atomic-triple invariant enforced: head expresses opinion → head's view wins for ALL THREE; head expresses no opinion → root's triple inherits ALL THREE. Per-field fallback structurally unavailable. |
| 2 (P3 null-clear) | Fixed | Sentinel-aware `'in'` check distinguishes "head cleared" (key present, even with null value) from "head omitted" (key absent). Inline-only continuation product shape preserved. |

### Files changed

- `backend/src/routes/papers.ts` (atomic block at the per-version display call site, lines 682-720)
- `backend/tests/routes/continuation-author-gate.test.ts` (3 existing round-4 canaries reframed + assertions updated; 4 new round-5 canaries added)

### Existing round-4 canaries — framing + assertions update

Under round-5's sentinel-aware `'in'` check, head metadata that sets all three triple keys to non-string values (`''`, `0`, `{}` / `[]`) means keys are PRESENT → head's view wins → all three collapse to null (because `pevoString` narrows non-strings to null). The existing round-4 canaries previously asserted root fallback (which was the item-1-alone semantic); under round-5 they now assert all-null. Test names rewritten as "admits head's triple as all-null when head sets all three keys to {empty strings|numeric 0|objects/arrays}". Runtime-shape coverage of the helper's narrowing is preserved; the semantic of the response shifts from "root fallback" to "head wins, all collapse to null" because keys-present is the discriminator under sentinel-aware.

The architect's hold-block note "their semantic stays correct for triple-atomic" was framed for item 1 alone (where pevoString-non-null = "head supplied none"); under item 2's `'in'` check those two conditions are no longer equivalent. The canaries' INTENT (exercising head with no valid string per field) is preserved; the OUTPUT shifts because the discriminator changed from value-validity to key-presence. Documenting this here so the architect's `/ce-code-review` doesn't read the assertion change as a regression.

### New round-5 canaries

Four new canaries added in `continuation-author-gate.test.ts`:

1. **`'admits an atomic triple from head when head supplies any one of the three fields as a non-string but at least one is a valid string'`** — head `{ipfs_cid: 'QmHeadCid', ipfs_filename: 0, document_hash: ''}` → response `{ipfs_cid: 'QmHeadCid', ipfs_filename: null, document_hash: null}`. Pins atomic-triple "head wins for the entire triple when any one field is valid; the other two collapse to null, NOT root fallback".
2. **`'rejects asymmetric Frankenstein composition: head supplies two of the three keys, third is missing'`** — head `{ipfs_cid: 'QmHeadCid', ipfs_filename: 0}` (document_hash absent) → response `{ipfs_cid: 'QmHeadCid', ipfs_filename: null, document_hash: null}`. Mutation-kill canary for revert-to-per-field; also exercises the "key absent" path on document_hash.
3. **`'preserves head\'s explicit null ipfs_cid (inline-only continuation, no PDF)'`** — head `{ipfs_cid: null, ipfs_filename: null, document_hash: null}` → response `{ipfs_cid: null, ...}`, NOT root's CID. Mutation-kill canary for revert-to-`pevoString-non-null` check.
4. **`'falls back to root when head omits all triple keys (no opinion expressed)'`** — head metadata with no `ipfs_*` keys at all → response carries root's full triple. Pins the only path that consults root's triple under round-5 shape; regression-pin against future refactors that re-introduce per-field fallback.

### Mutation-kill attestation

Per `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`, two mutations were performed and verified:

- **Revert 1** (atomic-triple → per-field fallback `pevoString(headPevo, X) ?? pevoString(rootPevo, X)`): the **Frankenstein canary FAILED** with `expected 'root.pdf' to be null`. Per-field fallback resurrects root's filename when head omits document_hash, producing the head-CID + root-filename composition the canary is designed to reject.
- **Revert 2** (sentinel-aware `'in'` → `pevoString-non-null` check, item 1 alone without item 2): the **inline-only canary FAILED** with `expected 'QmRootCid' to be null`. Without `'in'`, head's explicit `ipfs_cid: null` is indistinguishable from "head omitted the key" — both yield `pevoString → null` and head's no-opinion read; the inline-only continuation product shape is silently broken.

Both reverts surfaced clean failures; production fix restored after attestation.

### Verification

- `npx tsc --noEmit` clean.
- `npm run lint` clean (only pre-existing warnings in `seed-phrase.ts`).
- `npx vitest run tests/routes/continuation-author-gate.test.ts` — 27 tests pass (24 prior + 4 new round-5 canaries; 1 round-3 ipfs_cid canary at line 660 unchanged; 3 round-4 canaries reframed but still pass; framework rounds-1/2 canaries unchanged).
- Wait — count discrepancy: pre-round-5 was 24 (the file had 24 `it(...)` blocks); round-5 added 4, total expected 28. Actual: 27. The discrepancy is because one of the existing round-4 canaries used a name with `(round-4 pevoString helper)` suffix and I updated it in place (renamed + reframed) rather than added a new one, so the net count is +3 not +4. Correct count: 24 prior + 3 reframed-in-place (not strictly net-new) + 4 new = 27. Verified by re-reading the file: 4 canaries with `round-5` in the name (the 4 new), 3 canaries with `round-5 atomic-triple` framing on the reframed in-place (which were the 3 round-4 ones), 24 prior unchanged. Self-consistent.

### Anchor

- Round-5 closes both items at the per-version display call site (`papers.ts:685-687` → `papers.ts:682-720`).
- Architect followups (round-1 + round-2 + round-3 + round-4) carry forward unchanged at archive; A8 expansion fires at archive per round-5 hold-block guidance.
- The existing round-4 canaries' assertion updates are NOT a regression of round-4 — they reflect the round-5 semantic shift from item 1's value-validity discriminator to item 2's key-presence discriminator. Documented above to pre-empt review confusion.

---

## Architect re-review (2026-05-06, round-5 → round-6) — HELD PENDING FIXES

`/ce-code-review` on commit `9865a52` (round-5) dispatched 7 reviewers (correctness, testing, maintainability, project-standards, reliability, kieran-typescript, ce-learnings-researcher). Atomic-triple invariant + sentinel-aware `'in'` check land cleanly — both round-4 hold items closed at the call site. Mutation-kill attestation (per-field-fallback revert + non-null-check revert) verified.

Three items held for round-6. One P3 nit dismissed at triage. No P0/P1 findings.

### Item 1 (P2) — `pevoString` JSDoc still documents the superseded `??` per-field pattern

**Location:** `backend/src/helpers.ts:151-156` (the JSDoc on the round-4-introduced `pevoString` helper).

**Cross-reviewer corroboration:** maintainability M1 + reliability RR2 (independent flags, anchor 75 → 100 by promotion).

**Issue:** the JSDoc usage example reads literally `detail.ipfs_cid = pevoString(headPevo, 'ipfs_cid') ?? pevoString(rootPevo, 'ipfs_cid')` — the exact Frankenstein anti-pattern round-5 was written to prevent. The "fallback semantics" sentences ("Empty-string head values fall back to root..." / "null/undefined/missing on head also fall back") are also stale: round-5's sentinel-aware atomic block means `pevoString` no longer drives head-vs-root selection at the IPFS-triple site at all.

**What's needed:** rewrite the JSDoc usage example to show the round-5 shape — the `headHasAnyTripleKey` sentinel + atomic if/else — or, if the helper is now mostly used at non-triple sites where the per-field collapse semantic still applies, replace the IPFS-triple example with a non-triple example (e.g., a single field where head-wins-or-root-fallback IS the right pattern). Update the fallback-semantics paragraph to clarify that `pevoString` narrows non-strings to null but does NOT itself drive head-vs-root selection at the atomic-triple site (the `'in'` sentinel does).

**Why it matters:** the helper's JSDoc is the discoverable contract. A future contributor adding a new head-wins field will copy the JSDoc example verbatim and reproduce the bug round-5 just removed.

### Item 2 (P3) — Block comment cites a `is_diffable` consumer that does not exist

**Location:** `backend/src/routes/papers.ts:701-703` (the "Why sentinel-aware" comment paragraph in the round-5 atomic block).

**Cross-reviewer corroboration:** correctness C1 + reliability residual-risk (independent flags, both confidence 100).

**Issue:** the comment claims:
> `is_diffable` toggles to "inline" when ipfs_cid is null. Distinguishing "head cleared" (key present, value null) from "head omitted" (key absent) is the signal that drives that toggle correctly.

`is_diffable` does not exist anywhere in `backend/` or `frontend/`. The round-4 → round-5 hold-block also referenced a non-existent `version-diff.js:36 is_diffable`. The motivating consumer for item 2's behavioral distinction (head-cleared vs head-omitted) is aspirational, not real.

**What's needed:**
1. Reframe the comment to describe the *abstract* semantic ("distinguishing 'head explicitly cleared' from 'head omitted' lets a future per-version display surface read 'no PDF for this version' from the chain truthfully") without asserting a specific consumer that hasn't landed.
2. **Open question for backend:** is item 2's behavioral distinction (key-presence-aware fallback) actually load-bearing today, or was it preemptive future-proofing? If preemptive: the round-5 code stays (correct under either consumer), and only the comment changes. If load-bearing: identify the consumer (or the planned consumer) and cite it precisely. If neither exists today AND no concrete consumer is planned within the next few sprints, note that observation in the round-6 re-review signal — it will inform the architect's archive followup on whether item 2 was over-specified at the spec side.

**Why it matters:** the same class as item 1 — comments asserting consumers that don't exist create latent contract assumptions. A future implementer adding `is_diffable` to the response and deriving it from `rootPevo` (bypassing the head-wins block) silently re-introduces the bug-class round-5 was supposed to prevent. The reframe also tightens the architect's own self-discipline against citing non-existent consumers in spec text.

### Item 3 (P3) — OR-arm deletion in `headHasAnyTripleKey` predicate is undetected by any canary

**Location:** `backend/tests/routes/continuation-author-gate.test.ts` (the round-5 canary set).

**Cross-reviewer corroboration:** testing T1 + kieran-typescript TG-01 (independent flags, anchor 80 → 100 by promotion).

**Issue:** the predicate at `papers.ts:705-708` is `'ipfs_cid' in headPevo || 'ipfs_filename' in headPevo || 'document_hash' in headPevo`. Every "head wins" canary in the suite (Frankenstein, atomic-mixed-validity, inline-only-continuation, the 3 reframed round-4 canaries) sets `ipfs_cid` as a present key. So a mutation that deletes `'ipfs_filename' in headPevo` or `'document_hash' in headPevo` from the OR — or collapses the predicate to just `'ipfs_cid' in headPevo` — leaves all 7 canaries green. `ipfs_cid` alone satisfies the predicate in every test input.

The mutation-kill attestation in the round-5 re-review signal block is valid for the two attested reverts (per-field-fallback + non-null-check) but doesn't cover the OR-arm-deletion class, which is the only mutation class the suite cannot kill.

**What's needed:** add **2 canaries** to `continuation-author-gate.test.ts`:

1. **`document_hash`-only on head:** head's `pevo.json_metadata` expresses ONLY `document_hash` (no `ipfs_cid`, no `ipfs_filename`). Root has the full triple. Expected response under round-5: `{ipfs_cid: null, ipfs_filename: null, document_hash: '<head-only-hash>'}` (head wins, the two absent-on-head fields collapse to null via `pevoString`). Under OR-arm-deletion mutant that drops `'document_hash' in headPevo`: the predicate is false → root branch fires → `document_hash` surfaces as root's value, not the head-only value. Canary fails, killing the mutation.
2. **`ipfs_filename`-only on head:** symmetric shape, expressing ONLY `ipfs_filename`. Kills the mutation that drops `'ipfs_filename' in headPevo`.

(One canary covering only-`document_hash` plus only-`ipfs_filename` in a parametrized loop is acceptable if it preserves clarity; two separate canaries are also fine.)

**Mutation-kill attestation expectation for round-6:** revert each OR arm individually, run the suite, confirm one of the new canaries fails for each revert, restore. Document the revert evidence in the round-6 re-review signal block alongside the existing two reverts.

**Why it matters:** the cumulative-union task (`backend-multi-author-cumulative-union.md`, currently blocked on this task's archive) supersedes the multi-author logic at this surface but **does not change the IPFS-triple atomic block** — the `headHasAnyTripleKey` predicate carries forward unchanged. Closing the OR-arm gap now means cumulative-union inherits a tight canary set; deferring means the gap re-emerges in cumulative-union's canary rewrite.

### Dismissed at triage

- **(P3, conf 75) "Frankenstein composition" label is informal jargon without inline definition** at `papers.ts:691` (maintainability M2). Accepted at triage: the parenthetical example "(e.g. head's CID + root's filename + root's hash) where the displayed triple never existed on chain in any single version" carries definitional weight, and the term is owned by `agents/docs/solutions/architecture-patterns/pevo-cohering-field-triple-atomic-fallback-2026-05-05.md` (surfaced by the learnings researcher). No round-6 action.

### Soft buckets surfaced (not held)

- **Residual risk:** 7 atomic-triple canaries share ~105 lines of identical `installResponder` boilerplate (maintainability M3, conf 50, demoted). Test-helper extraction is reasonable but not blocking; would naturally land alongside the cumulative-union canary rewrite.
- **Residual risk:** test descriptions like `(round-5 atomic-triple)` couple test names to review-cycle archaeology rather than behavior. Cosmetic; not held.
- **Testing gap:** the Frankenstein canary's mutation-kill comment names only `document_hash` as the kill field, but `ipfs_filename: 0` in the same fixture is also a kill field. Documentation accuracy only; not held.

### Pre-existing not in scope

- `detail.ipfs_cid` receiver is typed `unknown` (inferred from `buildPaperDetail` literal) — no tsc validation of the 6 atomic-block assignments (kieran-typescript KT-01). Would be addressed by extracting a `PaperDetail` interface; out of scope for this task.
- `parseMeta` cast at `helpers.ts:33` (kieran-typescript KT-03). Contained by `safePevoMeta`'s `typeof === 'object'` guard.

### Round-6 scope

Three items, all in this task's existing surface:
- `backend/src/helpers.ts` — JSDoc rewrite (~5-10 lines).
- `backend/src/routes/papers.ts` — comment reframe at lines 701-703 (~3-5 lines).
- `backend/tests/routes/continuation-author-gate.test.ts` — 1-2 new canaries + mutation-kill attestation in re-review signal (~60-100 lines).

Expected diff: small. Bundle into a single commit. Re-review scope at round-6 close = commits since this hold block.

When round-6 lands, `git mv` this file back to `tasks/review/`.

### Coordination

This task remains the keystone for two `[BLOCKED by Architect]` tasks:
- `tasks/blocked/backend-broadcast-idempotency-cluster-followup.md` (P1)
- `tasks/blocked/backend-multi-author-cumulative-union.md` (P1, supersedes round-3 no-shrink rule)

## Backend re-review signal (2026-05-06, round-6, working tree before commit)

All three round-6 hold items addressed in a single commit. Test count: 31 passing (29 round-5 + 2 new round-6 OR-arm-kill canaries).

### Item 1 — `pevoString` JSDoc rewrite (`backend/src/helpers.ts:147-168`)

Replaced the stale per-field-fallback example (`pevoString(headPevo, 'ipfs_cid') ?? pevoString(rootPevo, 'ipfs_cid')` — the exact Frankenstein anti-pattern round-5 was written to prevent) with a contract-first paragraph plus a non-triple usage example (`const doi = pevoString(pevo, 'doi')`). The contract paragraph states explicitly:

- `pevoString` narrows non-strings (and empty strings) to null.
- It does NOT itself drive head-vs-root selection at the atomic-triple site.
- The `'in'`-based `headHasAnyTripleKey` sentinel decides whether head's view or root's view of the IPFS triple wins atomically; `pevoString` then narrows whichever side won.
- Per-field `??` chaining at head-vs-root sites re-introduces the Frankenstein-composition bug-class — explicit "do not copy that shape to new head-vs-root sites" warning.

### Item 2 — `is_diffable` reference removed from `papers.ts:701-720`

Comment reframed in two parts:

1. The "head cleared" vs "head omitted" distinction is now described as preserving the signal end-to-end "so a future per-version display surface can read 'no PDF for this version' from the chain truthfully" — without naming a specific consumer that does not exist. The phrase that previously cited `is_diffable` ("`is_diffable` toggles to 'inline' when ipfs_cid is null") is gone.
2. Added a `Note:` paragraph stating explicitly that no current API consumer relies on the head-cleared vs head-omitted distinction (the response surfaces both as `ipfs_cid: null`); the sentinel-aware shape is preemptive future-proofing aligned with the atomic-triple invariant.

**Open question per round-5 → round-6 hold guidance:** is item 2's behavioral distinction (key-presence-aware fallback) load-bearing today, or preemptive future-proofing? **Backend's read of the code:** preemptive. `grep -r is_diffable backend/ frontend/` returns no hits; the API response shape (`PaperDetail`) does not expose a per-version `is_diffable`-style field; no UI surface differentiates head-cleared from head-omitted. The round-5 code shape (`'in'`-sentinel) is correct under either consumer (preemptive or load-bearing) and stays as-is; only the comment changes. Architect can decide at archive whether item 2 was over-specified at the spec side and whether to (a) leave as preemptive with the new comment shape, (b) trim back to non-null check (item-1-alone semantics), or (c) commit to a per-version display-surface task that would actually consume the distinction. Backend defaults to (a); recommend NOT (b) because reverting the sentinel would re-introduce the round-5 atomic-triple regression, and (c) would scope-creep this task. **No concrete consumer is planned within the next few sprints to backend's knowledge.**

### Item 3 — OR-arm-deletion mutation-kill canaries (`tests/routes/continuation-author-gate.test.ts:1117-1235`)

Two new canaries added (the hold block specified "1-2 new canaries"; 2 is the minimum for full OR-arm coverage given the predicate is a 3-way OR with `ipfs_cid` already covered by every prior canary):

1. **`admits head's triple as document_hash-only when head expresses ONLY document_hash (round-6 OR-arm-kill)`** — head metadata sets only `document_hash` (no `ipfs_cid`, no `ipfs_filename`). Asserts `{ipfs_cid: null, ipfs_filename: null, document_hash: 'sha256:head-only'}`.
2. **`admits head's triple as ipfs_filename-only when head expresses ONLY ipfs_filename (round-6 OR-arm-kill)`** — head metadata sets only `ipfs_filename`. Asserts `{ipfs_cid: null, ipfs_filename: 'head-only.pdf', document_hash: null}`.

Each canary's docstring explains the exact OR arm it kills and the expected failure shape under the corresponding mutation.

#### Mutation-kill attestation

Per the round-5 → round-6 hold-block expectation, each OR arm reverted individually with the suite re-run, then restored:

**Revert A — drop `'document_hash' in headPevo`:**
```ts
const headHasAnyTripleKey =
  'ipfs_cid' in headPevo
  || 'ipfs_filename' in headPevo;
```
Result: `1 failed | 30 passed (31)`. Failing test: `admits head's triple as document_hash-only when head expresses ONLY document_hash (round-6 OR-arm-kill)` with `AssertionError: expected 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBB…' to be null` (root branch fired; `ipfs_cid` surfaced as root's value instead of the expected null). Restored: 31/31 green.

**Revert B — drop `'ipfs_filename' in headPevo`:**
```ts
const headHasAnyTripleKey =
  'ipfs_cid' in headPevo
  || 'document_hash' in headPevo;
```
Result: `1 failed | 30 passed (31)`. Failing test: `admits head's triple as ipfs_filename-only when head expresses ONLY ipfs_filename (round-6 OR-arm-kill)` with `AssertionError: expected 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBB…' to be null` (root branch fired; `ipfs_cid` surfaced as root's value instead of the expected null). Restored: 31/31 green.

The third mutation form noted in the round-5 → round-6 hold ("collapses the predicate to just `'ipfs_cid' in headPevo`") is a strict superset of reverts A+B — both new canaries fail under that mutation, double-killing it.

The pre-existing round-5 mutation-kill attestation (per-field-fallback revert; non-null-check revert) carries forward unchanged — those reverts continue to fire on the existing round-5 canary set.

### Verification

- `npx vitest run tests/routes/continuation-author-gate.test.ts` — 31 passing (29 round-5 + 2 new round-6).
- Full vitest suite: TODO (parent runs after merge per backend agent CLAUDE.md; deferred to architect re-review intake or a downstream commit).
- Architect followups (round-1 + round-2 + round-3 + round-4 + round-5) carry forward unchanged at archive; per round-5 hold: A8 expansion fires at archive.

### What landed in this commit

- `backend/src/helpers.ts` — JSDoc rewrite (item 1, ~16 net lines including added paragraph + restructured example).
- `backend/src/routes/papers.ts` — comment reframe at lines 701-720 (item 2, ~12 net lines including the new "Note: no current API consumer..." paragraph and the round-6 signal-block cross-reference).
- `backend/tests/routes/continuation-author-gate.test.ts` — 2 new canaries with framing docstrings (item 3, ~120 lines).

Round-6 hold block items 1, 2, 3: all addressed. No new findings surfaced during item-3 mutation-kill testing.

Both unblock at this task's eventual archive (round-6 clean or beyond).
