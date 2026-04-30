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
