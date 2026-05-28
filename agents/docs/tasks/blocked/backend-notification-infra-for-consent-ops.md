# BACKEND-NOTIFICATION-INFRA-FOR-CONSENT-OPS — surface pending authorships to logged-in users

**Owner:** Backend Agent
**Created:** 2026-05-05 (architect, surfaced by `/ce-doc-review` of `agents/docs/ARCHITECTURE.md` Multi-Author Trust Model section)
**Priority:** P1 (blocks the multi-author trust model flag-day cutover)

## Problem

The Multi-Author Trust Model in `agents/docs/ARCHITECTURE.md` introduces consent-gated authorship. On flag-day, existing multi-author co-authors are demoted to claimed-pending status (lose their PEvO user badge on affected papers) until they broadcast `author_accept`. The UI surfaces this transition via a one-time migration banner (`ui-multi-author-consent-affordances` acceptance criterion #4), which needs a backend endpoint to enumerate the affected papers per user.

This task scopes that backend endpoint plus the migration-day data preparation.

## Goal

Provide a backend endpoint the frontend can call to ask: "for the currently-authenticated user, which papers list them as a co-author but where they are not yet vouched?"

## Acceptance

### 1. Pending-authorships endpoint

`GET /api/me/authorships/pending` returns the list of papers where the authenticated user appears in `pevo.authors[].hive` of any admitted chain post but does NOT have a valid `author_accept` op (or has resigned without re-accepting). Bridge papers are excluded from this list (`hive: null` entries are scoped out of the consent flow per ARCH.md "Bridge papers" subsection).

Response shape:
```
{
  "pending": [
    {
      "root_author": "alice",
      "root_permlink": "paper-v1",
      "title": "...",
      "added_by": "bob",
      "added_at_block": 12345,
      "added_at_ts": "<ISO 8601>"
    },
    ...
  ]
}
```

The endpoint requires authentication (the user can only fetch their OWN pending authorships, not others').

### 2. Migration-day correctness

On flag-day deploy, the endpoint MUST return the correct set for every affected user from the moment the deploy lands. This means the vouched-set computation (per `backend-coauthor-trust-model` Phase 2) must be in place AND the endpoint must traverse all admitted multi-author papers, identifying entries where `pevo.authors[].hive` includes the requesting user but no valid `author_accept` op exists for that user-paper pair.

Performance: the per-user scan SHOULD execute under 500ms at beta scale (low number of papers). Index on whatever HAF view supports "papers where hive X is in pevo.authors[]" (e.g., a JSONB containment index on `pevo.authors`).

### 3. Tests

- Canary covering the endpoint (vouched user → empty list; claimed-pending user → expected papers).
- Edge cases: bridge papers excluded; resigned-then-re-accepted user counted as vouched (not in pending list).
- Real-HAF coverage where feasible per `CLAUDE.md` "Running Tests" carve-out.

### 4. ARCH.md update

After implementation, append a row to the API contract index (`agents/docs/api-contracts/`) documenting the new endpoint. Architect-owned; backend leaves a `[TODO Architect]` note.

## Out of scope

- Real-time notification push (WebSocket / SSE / email): the migration banner is one-shot polling, not real-time. If real-time becomes needed later, files separately.
- A `/api/me/authorships/vouched` endpoint listing the user's vouched authorships: not required for the migration banner. Resign affordances live on paper-detail pages where vouched status is already known per-page; no separate index is needed.
- The UI affordance for displaying pending state (filed separately as `ui-multi-author-consent-affordances`).
- The actual broadcast of `author_accept` / `author_resign` ops via custody (covered by Phase 2 of `backend-coauthor-trust-model`; this task is purely about the discovery endpoint).

## Dependencies

- `backend-coauthor-trust-model` Phase 2 (vouched-set computation must be queryable).
- `ui-multi-author-consent-affordances` (UI consumes the endpoint).

## Cross-references

- `agents/docs/ARCHITECTURE.md` section 2 "Multi-Author Trust Model" — canonical spec.
- `agents/docs/tasks/pending/backend-coauthor-trust-model.md` — Phase 2 implementation of the trust model.
- `agents/docs/tasks/blocked/ui-multi-author-consent-affordances.md` — sibling UI task (also blocked).

---

## [BLOCKED by Architect] (originally backend startup triage 2026-05-05; refreshed 2026-05-11, 2026-05-28 — re-owned to Architect, see latest refresh)

The `GET /api/me/authorships/pending` endpoint requires the vouched-set computation specified in `backend-coauthor-trust-model.md` Phase 2 (see this task's "Dependencies" clause above). Phase 2 has not started in code — none of the new `custom_json` op handlers (`AuthorAcceptAction`/`AuthorResignAction`), the read-time vouched-set lookup, or the migration-day flag exist yet. Without those, this endpoint cannot identify "claimed-pending" authorships.

Move back to `tasks/pending/` once Phase 2 of `backend-coauthor-trust-model.md` lands the vouched-set lookup that this endpoint queries.

### Block-note refresh 2026-05-11 (backend startup triage)

The dependency framing above is partly stale. Status today:
- **`backend-coauthor-trust-model` Round 1 primitives landed and archived 2026-05-06.** `consent-ops.ts` exports `fetchConsentOpsForPaper`, `computeVouchedAuthors`, and `getVouchedAuthors`. `types/hive.ts` exports `AuthorAcceptAction` and `AuthorResignAction`. The "vouched-set lookup" the original block-note claimed does not exist DOES exist as a per-paper primitive.
- **Phase 2 (continuation-chain admit-gate integration + cache invalidation) is currently in `tasks/review/` as `backend-multi-author-cumulative-union.md`** — under architect review, not yet archived. That is the actual current gate on this task.
- **Phase 4 (migration-day flag) has not started.** Until the flag flips, every existing co-author is implicitly vouched and this endpoint's "pending" set is empty by construction. The migration banner the endpoint serves cannot fire pre-flag.

Net: task remains blocked. The accurate gate now is "`backend-multi-author-cumulative-union.md` archives AND the Phase 4 migration-day flag starts." When the cumulative-union task archives, re-evaluate whether this endpoint can ship ahead of the migration-day flag (the primitives would let it answer correctly; the only consumer is the migration banner which doesn't exist yet).

### Block-note refresh 2026-05-28 (backend startup triage) — re-owned to Architect

The 2026-05-11 framing above is now itself stale, and the underlying rollout has fragmented. Verified state as of 2026-05-28:

- **The named gate is gone.** The "cumulative-union / `backend-coauthor-trust-model`" work archived (`backend-coauthor-trust-model` at commit `d7a25b6e`, round-5 clean), and the entry has since been trimmed out of `tasks-archive.md`'s 250-line cap. The membership/identity successor `backend-author-identity-model` is in `tasks/review/` (not archived); it scopes name-supersession + Hive-less co-author persistence in the cumulative union, NOT the consent layer.
- **The "implicitly vouched until flag-day" premise was imprecise.** `computeVouchedAuthors` (`consent-ops.ts`) grandfathers no one — vouched = root-broadcaster OR a valid `author_accept`. The real reason the pending set is empty today is structural, not a flag state: **the consent-decay layer is not wired into any read path at all.** The `fetchConsentOpsForPaper` / `computeVouchedAuthors` primitives exist but are orphaned (zero read-path callers); `resolveContinuationChain` reconstructs cumulative-union *membership* only and never applies accept/resign decay (see the reworded comment in `papers.ts`'s detail head-meta block). So no co-author is demoted to claimed-pending in production today and no user is stranded — this endpoint is correct-but-premature, not urgent.
- **Real remaining prerequisites, both untracked by any live task:** (a) wire the consent-decay layer (apply `computeVouchedAuthors` at read time so "vouched vs claimed-pending" is a real product state), and (b) the migration-day hard-cutover flag (ARCH.md § 2 "Hard cutover"). Per ARCH.md § 2 (the "flag-day deploy depends on two follow-up surfaces" paragraph), this endpoint is a **co-requisite of** flag-day, not downstream of it — flag-day must not ship without it and the UI banner.

**Why re-owned to Architect:** the unblock path is no longer prior *backend* work (the primitive it needs already exists). It is a rollout-sequencing + task-creation decision the architect owns: the trust-model consent layer landed its primitives and then stalled with no live task tracking the read-path integration or the migration flag, and `ARCHITECTURE.md` § 2 still describes a flag-day cutover that has no implementation path scheduled.

**[TODO Architect]** Re-scope the multi-author consent-layer rollout: (1) decide whether to file a task to wire `computeVouchedAuthors` into `resolveContinuationChain`'s read path (the "Phase 2 consent layer" the orphaned primitives were built for), (2) scope the migration-day flag, and (3) sequence this endpoint + `ui-multi-author-consent-affordances` into that cutover bundle. Until that sequencing exists, this task stays blocked. The primitives and this endpoint's data shape are ready whenever the bundle is scheduled.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
