# UI-COAUTHOR-CONTINUATION-PUBLISHING — let named co-authors publish and edit their own continuation post

**Owner:** UI Agent
**Created:** 2026-04-30 (architect, surfaced during cluster 1 review triage on `backend-continuation-post-author-consent-gate.md`)
**Priority:** P2

## Background — how continuations work in PEvO

PEvO papers can have multiple named authors (the `pevo.authors[]` array on the head paper's metadata). When a co-author wants to publish their own version of a paper, they broadcast a **new** Hive comment under THEIR own account, carrying `pevo.continues = { author: <predecessor post author>, permlink: <predecessor permlink> }` and the new content. They own that post and can edit it via Hive's native edit mechanism over time. The "version chain" PEvO assembles for a paper is the timeline of all such posts (the original + every co-author's continuation), linked by `continues` pointers.

This is distinct from "editing someone else's post" — Hive doesn't allow that. Each user only edits the posts they own. Co-authorship in PEvO means each named author can publish (and own) their thread of versions in the same paper's chain.

## Problem

Today the paper-detail UI exposes the affordance to publish a continuation only to the **chain-level post author** (the original publisher). A co-author named in `pevo.authors[].hive` but who has not yet published their own continuation has no UI surface to do so. Subsequent edits to a co-author's already-published continuation are governed by Hive's native edit window (handled by the existing edit flow on whatever post is currently the head); but the **first time** a named co-author wants to participate in the chain, the UI today doesn't let them.

The companion backend task (`backend-continuation-post-author-consent-gate.md`) closes the security side: continuation posts from non-named accounts are excluded from the version chain. With both tasks landed:

- A named co-author broadcasts their first continuation → backend admits → display shows it as part of the chain → user can edit it natively after.
- A non-author broadcasts a spoofed continuation → backend rejects → display ignores it.

## Acceptance

### 1. "Publish continuation" affordance for co-authors

Paper-detail page (`frontend/src/pages/paper-detail.js` or equivalent — investigate during implementation). Today the publish/edit flow predicate is roughly `currentUser.username === paper.author`. Widen to:

```js
const canPublishContinuation = currentUser?.username && (
  paper.pevo?.authors?.some(a => a.hive === currentUser.username)
);
const isOwnPost = currentUser?.username === paper.author;
const canEditOwnPost = isOwnPost; // Hive native edit, only on your own post
```

The two affordances are different actions:

- **Edit own post** (`canEditOwnPost`) — Hive native edit on the post the user already authored. No new continuation; just update the existing comment via the standard Hive edit operation.
- **Publish continuation** (`canPublishContinuation && !isOwnPost`) — broadcast a new comment under the user's account with `pevo.continues = {author, permlink}` of whatever post in the chain the user is continuing FROM (typically the latest version they're aware of).

Bridge papers (`type: 'bridge_paper'`, post author = `config.hiveBridgeAccount`): the publish-continuation affordance should **not** appear. Bridge-paper updates flow through `/api/bridge/update`. Gate the predicate on `paper.pevo?.type !== 'bridge_paper'`.

### 2. Edit / continuation form — always pre-fill from chain head

The PEvO version chain is the timeline of all posts (originals + every co-author's continuations) AND every Hive-native edit applied to any of those posts. Each native edit produces a "new version" in the chain timeline as PEvO presents it.

Implication for the form: regardless of whether the user is publishing a new continuation OR editing their own existing post, the form MUST pre-fill from the **chain head** (the latest version in the chain at viewing time), not from the user's own last version. Concrete cases:

- Alice has `alice/v1`. Bob publishes `bob/continuation-1` (edits some content). Bob then native-edits `bob/continuation-1`. Alice clicks "edit my version". The form pre-fills with bob's most recent edit content (the chain head), and on submit Alice's content goes into `alice/v1` via Hive native edit. The result: another new version on the chain, which now reflects alice's revision applied on top of bob's most recent content.
- A first-time co-author publishing their initial continuation pre-fills from the chain head as before; the new continuation post points at the head's author/permlink in `pevo.continues`.

Two affordance paths converge on the same form, differing only in submit:

| Affordance | Pre-fill source | Submit action |
|---|---|---|
| Publish continuation (first time as a named co-author) | chain head's content | broadcast new comment under `currentUser.username`, `pevo.continues = {author: head.author, permlink: head.permlink}` |
| Edit my version (user already has a post in the chain) | chain head's content | Hive native edit on `currentUser`'s own existing post in this chain |

Other paper fields (title, body, abstract, discipline, keywords, ipfs_cid, etc.) carry the user's revisions on top of the chain-head content.

The user broadcasts under their own posting authority (Keychain or backend custodial signing path) in both cases.

**Implementation note.** Today's edit flow pre-fills from the original post's content (`paper.author/paper.permlink` head). After this task lands, pre-fill comes from `versions[versions.length - 1]` (or whatever shape the version-chain endpoint returns as "head"). Verify the endpoint distinguishes "head as of viewing" from "the original post" — if it doesn't, the head computation may need a small backend addition.

### 3. Tests

- Unit: publish-continuation affordance renders when current user is in `paper.pevo.authors[].hive` AND has not yet published a post in this chain.
- Unit: edit-my-version affordance renders when current user is in `paper.pevo.authors[].hive` AND already has a post in the chain.
- Unit: neither affordance renders when current user is not a named author.
- Unit: bridge-paper case suppresses both affordances.
- Unit (head pre-fill): when the chain head is a co-author's recent post, the form pre-fills with the head's content regardless of which named author opens the form.
- Integration / E2E:
  - A named co-author with no prior continuation broadcasts one → version chain shows it.
  - A named co-author with an existing post hits "edit my version" against a chain whose head is a different co-author's recent edit → form pre-fills with the OTHER co-author's content → submit produces a Hive native edit on the user's own post → new version appears in the chain.

Coordinate with `ui-e2e-edit-paper-flow.md` already in `tasks/review/`; may extend that suite.

### 4. Locale strings

Likely needs new keys for the publish-continuation affordance label, tooltip, and the success toast post-broadcast. Sweep all 16 locale files + `STUBS.md`. Use neutral labels like `paper.publishContinuation` and `paper.continuationPublished`.

### 5. No backend change required

The backend already accepts continuation posts (no special endpoint; the user broadcasts directly via Hive). The companion backend gate task adds the *display-side* filter on the version-chain walker. This UI task is purely the publishing/editing affordance.

## Out of scope

- **Approval workflows.** Co-authorship in PEvO grants the right to publish a continuation; no approval from the original author is required. Future governance work could change this; not in scope here.
- **Editing OTHER co-authors' posts.** Hive doesn't allow it; PEvO doesn't try to. Each user only edits posts they authored.
- **Bridge-paper editing.** Out of scope per item 1.
- **Backend changes.** The companion backend task is the security side. This task is frontend-only.

## Why now

- The backend continuation-author-gate work (`backend-continuation-post-author-consent-gate.md`) makes the security side correct — but with no UI surface for legitimate co-authors to participate, multi-author PEvO papers have a dormant authoring model.
- Multi-author papers are a stated PEvO use-case (the metadata schema accommodates them); the missing affordance is a quiet bug.
- The fix is bounded: predicate widening + a publish-continuation form path that mostly reuses the existing edit form's content widgets.

## Source

User-architect dialog 2026-04-30: architect surfaced the continuation-author-gate as a security closure (cluster 1 review pre-existing finding); user clarified the actual continuation mechanism (per-author posts, not in-place edit) and noted that co-authors today can't surface their own continuations in the UI. Architect filed this UI task with the correct framing alongside the backend gate.

## Cross-references

- Companion backend task: `backend-continuation-post-author-consent-gate.md` (pending). Lands first or concurrently.
- `agents/docs/api-contracts/papers.md` — multi-author and version-chain semantics.
- `frontend/src/pages/paper-detail.js` (if that's the location — investigate) — current edit-button gate.
- Existing E2E coverage in `ui-e2e-edit-paper-flow.md` (`tasks/review/`) — may need extension for the co-author publish-continuation path.
