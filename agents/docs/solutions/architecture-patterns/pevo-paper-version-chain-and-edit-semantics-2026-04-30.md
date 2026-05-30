---
title: PEvO paper version chain and edit semantics across multi-author continuation posts
description: How resolveContinuationChain assembles a paper's full version timeline across original author plus co-author continuation posts, and how the edit form pre-fills from chain head regardless of which author opens it
date: 2026-04-30
category: architecture-patterns
module: backend, frontend, architecture
problem_type: architecture_pattern
component: service_object
severity: medium
applies_when:
  - Implementing or modifying resolveContinuationChain or any paper-version walker
  - Changing the edit page pre-fill logic at /edit/:author/:permlink
  - Adding or altering the publish-continuation affordance for co-authors
  - Surfacing the version timeline in paper-detail, review, or admin UIs
  - Reasoning about which post on the chain is the canonical head for new edits, reviews, or votes
related_components:
  - paper-detail
  - version-chain
  - edit-flow
  - reconstructVersionsFromHaf
tags:
  - continuation-posts
  - version-chain
  - paper-edit
  - multi-author
  - hive-native-edit
  - pre-fill
  - pevo-authors
  - resolve-continuation-chain
---

# PEvO paper version chain and edit semantics across multi-author continuation posts

## Context

PEvO papers are not single Hive posts edited only by their original author. A paper is a **version chain** assembled across multiple Hive posts and their native edits, possibly authored by different co-authors. This shape exists because Hive enforces a hard constraint: only a post's original `author` can edit it. PEvO's design needs multi-author editability (corrections, response-to-review revisions, authorship transfers when an original author becomes unavailable) without breaking that constraint or delegating posting authority.

The friction this guidance addresses:

- A naive reading of "edit a paper" assumes one Hive post + one author + native edits. The codebase is more nuanced.
- `backend/src/routes/papers.ts:resolveContinuationChain` (line 681) shows the chain-walking SQL but not the editing semantics layered on top.
- `agents/docs/api-contracts/papers.md` documents the `versions[]` response shape (with per-entry `author`/`permlink`) and `head_author` / `head_permlink`, but does not explain who is allowed to author the next entry, or what content the edit form pre-fills with.
- This led to the architect getting the mechanism wrong twice during round-2 triage of `backend-bridge-paper-author-gate.md` on 2026-04-30 — corrected only when the user spelled out "Users of course edit their own post on Hive, but the effect is a new version in the chain."

## Guidance

Treat a PEvO paper as a **linear append-and-edit chain across multiple Hive posts**, with these load-bearing rules:

### 1. Chain composition

A chain is built from:

- **The root post** — first PEvO publication for the paper, owned by its original Hive author.
- **Continuation posts** — subsequent top-level Hive posts (under `parent_permlink = APP_TAG`) whose `pevo.continues = { author, permlink }` points at the current chain head. Each continuation is owned by its broadcaster.
- **Native Hive edits** of any post in the chain by its respective author. Hive returns only the latest body, but HAF preserves every operation, so each native edit becomes a `versions[]` entry attributed to the post's author/permlink.

The chain is ordered by `block_num` of each operation. The "head" is whichever entry has the latest version timestamp — possibly any author's most recent edit, not necessarily the most recent continuation post.

### 2. Per-author-edit ownership (Hive constraint, never violated)

Each user only edits posts they themselves authored. Co-author A cannot native-edit a post owned by B. The way A "edits the paper" when B owns the head is:

- A publishes a **new continuation post under A's account** with `pevo.continues` pointing at the current head, OR
- A native-edits the post A already owns earlier in the chain — which still becomes a new version entry, even though it sits "behind" later chain links chronologically.

The chain-level `author` of any entry is always the broadcasting user. It is never spoofed at the chain layer; only the `pevo.authors[]` metadata array can be misclaimed (separate concern, see `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`).

### 3. Linearity and collision resolution

The chain is linear. Each new continuation continues the latest head. If two continuations land in the same window claiming the same parent head, **earlier `block_num` wins** — the loser is orphaned, not branched. `resolveContinuationChain` enforces this with `ORDER BY co.block_num ASC LIMIT 1` per hop. (Linearity invariant captured 2026-04-12 in the canonical edit-flow design notes; auto memory.)

### 4. Authors list is monotonic

`pevo.authors[]` may be added to over the chain's lifetime but never removed. A continuation post can introduce a new co-author; subsequent edits cannot drop one. (auto memory)

Monotonicity is now **enforced by construction** rather than by a check-and-reject mechanism. The displayed `authors[]` is the cumulative union of `pevo.authors[]` across every admitted chain post (`buildCumulativeAuthorsForChain`, per `ARCHITECTURE.md § 2 "Display construction (cumulative union)"`). Because the read path unions rather than projecting the head post's metadata, a head edit that omits an earlier-credited name cannot drop it — the name still appears on the earlier post the union reads. There is no longer a `headAuthorsCoverRoot` cover-check or a "reject the override when the head fails to cover the root" step (the superseded model); drops are structurally impossible within a single resolvable-chain read. (The invariant is per-request over the resolvable chain — a truncated walk falls back to the head-meta projection rather than caching a partial union; see the § 2 subsection for that scope boundary.)

### 5. Edit form pre-fill is sourced from the chain head, not the user's own last version

When co-author A clicks "edit" on a paper whose current head is owned by B, the form pre-fills with **B's most recent content** (title, body, keywords, supplementary files, IPFS CID). A then either native-edits A's earlier post (producing a new chain entry that builds on B's revisions) or publishes a new continuation post under A's account. The pre-fill source is the **chain head's content**, regardless of which post in the chain the editor will broadcast against.

### 6. Continuation pointer trust (gated)

`pevo.continues` is authenticated at the display layer: `resolveContinuationChain` admits a continuation post only when its broadcaster is in the predecessor's authorized-author set, computed via `extractAuthorizedContinuationAuthors`. The membership set is the cumulative chain `authors[]` (the append-only union across admitted chain posts, per `ARCHITECTURE.md § 2 "Display construction (cumulative union)"`), so a co-author added mid-chain can continue but an unrelated account cannot. The chain layer is correct about who broadcast each post; this gate adds the upstream-consent check before extending the chain across the boundary. See `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` for the identity-predicate rule this gate instantiates.

## Why This Matters

**Getting it right** preserves three correctness properties simultaneously:

- Hive's only-author-can-edit constraint is never violated (no posting-key delegation, no impersonation).
- Multi-author editability works without a custom "paper" object — the chain emerges from native Hive ops + `pevo.continues` pointers.
- Authorship transfer when an original author goes silent (lost keys, abandoned account, deceased) is possible: a co-author publishes a continuation under their own account and editing flows continue through them.

**Getting it wrong** produces specific bug classes:

- Edit form pre-fills from the user's own last-authored chain entry instead of the head → A overwrites B's revisions on the next save, silently losing chain progress.
- Authorization checks assume `paper.author === editor` → blocks legitimate co-author continuations, or worse, allows native-edit attempts that the Hive node will reject anyway, producing a confusing UX.
- Triage and security review confuse continuation hijack (display-layer trust gap, `pevo.continues` is currently spoofable) with authorship spoofing (chain-layer, not possible) — leading to either over-broad fixes or missed gaps. The active security gate task (`backend-continuation-post-author-consent-gate.md`) is exactly this distinction made operational.
- "Edit my version" flows that ignore the head and write against a stale base produce diff patches that don't apply cleanly, corrupting the reconstructed body (`reconstructVersionsFromHaf` at `backend/src/routes/papers.ts:801`).

## When to Apply

Reach for this model whenever you are:

- Designing or reviewing the edit flow (`/edit/:author/:permlink` route, edit-form pre-fill source, save-button broadcast target).
- Building authorization gates on edit, continuation, retract, or claim endpoints.
- Reading `versions[]` from `GET /api/papers/:author/:permlink` and reasoning about who authored which entry — note that each version entry carries its own `author`/`permlink` precisely because they can differ from the canonical root.
- Triaging a security-review finding about "spoofed paper authorship" — disambiguate chain-layer author (never spoofable) from `pevo.continues` claim (currently spoofable, gate pending) from `pevo.authors[]` metadata claim (separate convention, separate gate).
- Implementing review-version flagging — `reviewed_version` references a chain-entry version, not just a root-post edit.
- Writing or updating UI affordances for co-author editing (`agents/docs/tasks/pending/ui-coauthor-continuation-publishing.md`).

## Examples

### Example 1 — Co-author native-edits and original author then continues

1. `alice` publishes the root: `alice/v1`, `pevo.authors = [alice, bob]`. Chain: `[alice/v1]`. Head: `alice/v1`.
2. `bob` clicks "edit" — pre-fill comes from `alice/v1`. Bob has no post of his own in the chain yet, so the UI offers "publish continuation". Bob broadcasts `bob/continuation-1` with `pevo.continues = {alice, alice/v1}`. Chain: `[alice/v1, bob/continuation-1]`. Head: `bob/continuation-1`.
3. `bob` later clicks "edit" again — pre-fill comes from `bob/continuation-1` (current head, also Bob's own post). Bob native-edits `bob/continuation-1`. Chain entries: 3 (alice/v1, bob/continuation-1 v1, bob/continuation-1 v2). Head content: bob's latest edit.
4. `alice` clicks "edit my version" — pre-fill comes from **bob's most recent edit content** (current chain head), not from `alice/v1`'s original content. Alice native-edits `alice/v1` with a body that builds on Bob's revisions. Chain entries: 4. Head is now alice's edit, even though `bob/continuation-1` is "later" in the chain order — recency is by version timestamp, not chain position.

### Example 2 — Continuation collision, earlier block wins

Head is `alice/v1`. In the same minute:

- `bob` broadcasts `bob/continuation-1` with `pevo.continues = {alice, alice/v1}` at `block_num = 1000`.
- `carol` broadcasts `carol/continuation-1` with `pevo.continues = {alice, alice/v1}` at `block_num = 1003`.

`resolveContinuationChain`'s `ORDER BY co.block_num ASC LIMIT 1` selects `bob/continuation-1`. `carol/continuation-1` is orphaned: it exists on Hive, but it is not part of the paper's chain and not surfaced via `versions[]`. Carol must republish a new continuation that points at the current head (now `bob/continuation-1`) to participate. (auto memory)

### Example 3 — `head_author` / `head_permlink` vs `canonical_author` / `canonical_permlink`

For the chain in Example 1 step 4, after alice's last edit:

- `canonical_author` / `canonical_permlink` = `alice` / `alice/v1` (the root, stable identity for citations and external links).
- `head_author` / `head_permlink` = `alice` / `alice/v1` (the post owning the most recent version timestamp — alice just edited it).
- `versions[]` contains 4 entries with `author`/`permlink` pairs `(alice, alice/v1), (bob, bob/continuation-1), (bob, bob/continuation-1), (alice, alice/v1)`.

Citations always reference `canonical_author`/`canonical_permlink`. The displayed body comes from the head's most recent version. The edit form pre-fills from the same source.

### Example 4 — The bug the security gate closes

`mallory` (no relationship to the paper, not in `pevo.authors`) broadcasts `mallory/fake-continuation` with `pevo.continues = {alice, alice/v1}`. The continuation gate rejects it: `resolveContinuationChain` admits a continuation only when its broadcaster is in the predecessor's authorized-author set (the cumulative chain `authors[]`), and `mallory` is not, so the chain stays `[alice/v1]` and the head display does not flip to mallory's content. The chain-layer `author` of `mallory/fake-continuation` is and always was `mallory` — that part was never spoofed; what was missing, and is now enforced, is the upstream-consent check before extending the chain across the boundary.

## Related

- `backend/src/routes/papers.ts` — `resolveContinuationChain` at line 681; head-version replacement around lines 569–601; `reconstructVersionsFromHaf` at line 801; consumer call sites at lines 913, 1029, 1066.
- `agents/docs/api-contracts/papers.md` — `versions[]`, `head_author`/`head_permlink`, `canonical_author`/`canonical_permlink` field notes.
- `agents/docs/tasks/pending/backend-continuation-post-author-consent-gate.md` — security gate task (P1) closing the `pevo.continues` trust gap.
- `agents/docs/tasks/pending/ui-coauthor-continuation-publishing.md` — UI affordance task (P2) for the publish-continuation flow + chain-head pre-fill rule.
- `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — meta-convention. The continuation gate is a second concrete instance after the bridge-paper gate; the predicate is set-membership in `pevo.authors[].hive` rather than equality to a single pinned account.
- Auto memory `~/.claude/projects/-home-micha-workspace-pevo/memory/project_edit_flow_decisions.md` (2026-04-12) — canonical edit-flow design decisions including linear-chain invariant and monotonic-authors rule.
