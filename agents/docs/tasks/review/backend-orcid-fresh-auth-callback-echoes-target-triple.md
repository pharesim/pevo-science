# BACKEND-ORCID-FRESH-AUTH-CALLBACK-ECHOES-TARGET-TRIPLE — echo `action`/`root_author`/`root_permlink` in the `/api/orcid/callback` `fresh_auth` response

**Owner:** Backend
**Created:** 2026-05-16 (architect, surfaced by `/ce-code-review` of `ui-orcid-callback-fresh-auth-mode-dispatch` round-1 — wire-contract mismatch detected by 5 reviewers)
**Priority:** P0 (blocks `ui-orcid-callback-fresh-auth-mode-dispatch` archive; latent until consumer-side `ui-multi-author-consent-affordances` lands, but the cache as currently shipped is a guaranteed no-op without this fix)

## Problem

`backend/src/routes/orcid.ts:1144-1150` (`handleFreshAuth`) currently emits:

```ts
sendOk(res, {
  mode: 'fresh_auth',
  fresh_auth_proof: issued.token,
  expires_at: issued.expires_at,
  mechanism: issued.mechanism,
});
```

The frontend's `_handleFreshAuth` handler (`frontend/src/pages/orcid-callback.js:305-311`) reads `data.action` / `data.root_author` / `data.root_permlink` from this response and passes them to `cacheConsentOpProof(...)`. Because the response doesn't carry those fields, the cache entry is written with all three target-binding fields as `undefined`. The cache lookup (`getCachedConsentOpProof`) does a strict-equality check on the triple; with `undefined !== 'author_accept'` (etc.) always true, the cache becomes a permanent no-op the moment a real consumer wires up.

The api-contract doc at `agents/docs/api-contracts/orcid.md:204-210` documents the four-field response shape correctly. The doc at line 56 explicitly states "State carries the target across the OAuth round-trip; the SPA does not re-submit it on `/callback`" — the target IS available server-side in Redis state (`orcid_state:{state}`.`fresh_auth_target`) and IS consumed by the issuance call site at line 1144 (passed into `issueFreshAuthToken(..., target)`), it's just not echoed back in the response.

## Why the UI agent's Option (b) cache shape is correct in principle

The UI implementer's cache shape decision (Option (b) — sibling `cacheConsentOpProof` helpers keyed on `(action, rootAuthor, rootPermlink)`) is the right design: target-bound proofs need target-bound lookup so the consumer broadcasts against the proof's actual binding. The bug is in the wire: the backend has the target in hand at `/callback` time but doesn't surface it to the frontend.

The alternative fix path (frontend reads target from a pre-redirect localStorage slot written at `/start` time) was considered and rejected at architect triage: it couples this fix to the still-blocked consumer task `ui-multi-author-consent-affordances` and is harder to unit-test in isolation. The backend echoing the triple is mechanically cleaner — three additional fields in an existing `sendOk` call plus the contract doc edit.

## Goal

Echo the target triple in the `fresh_auth` callback response so the SPA can cache it keyed on the binding.

## Acceptance

### 1. Response shape

Modify `handleFreshAuth` in `backend/src/routes/orcid.ts` (around line 1144) to include `action`, `root_author`, `root_permlink` in the `sendOk` envelope. The `target` is already read from Redis state and passed into `issueFreshAuthToken`; reuse it:

```ts
const issued = await issueFreshAuthToken(username, 'orcid', target);
sendOk(res, {
  mode: 'fresh_auth',
  fresh_auth_proof: issued.token,
  expires_at: issued.expires_at,
  mechanism: issued.mechanism,
  action: target.action,
  root_author: target.root_author,
  root_permlink: target.root_permlink,
});
```

### 2. Contract doc update

Update `agents/docs/api-contracts/orcid.md`'s `fresh_auth` response section (around line 204-210) to include the three new fields. Update line 56's narrative if it still implies the target is never round-tripped to the SPA (it isn't re-submitted on `/callback` — that's still true — but it IS now echoed in the response). Make the distinction explicit so future readers understand the difference between "SPA submits target" and "backend echoes target for cache binding".

### 3. Integration test pin

Add a backend integration test (or extend an existing `/api/orcid/callback` fresh_auth test) asserting that the response body for `mode: 'fresh_auth'` includes `action`, `root_author`, `root_permlink` and that their values match the Redis-state target. Per the `wire-contract-shape-pinned-on-backend-not-stub-2026-05-16` convention, this is the pin against future drift — a stub test in the frontend (which already mocks the triple) is correctness-irrelevant for this question. The backend integration test is the source of truth.

### 4. Reachability check

Confirm `target` is non-null at the sendOk site. The existing error path at `agents/docs/api-contracts/orcid.md:216` already documents a 400 `"fresh_auth state is missing the per-op target binding"` defensive rejection when the Redis state is corrupt and `fresh_auth_target` is absent. Verify that defensive path is reached BEFORE the new sendOk so the echo can rely on `target.action` etc. being defined.

## Coordination

This task unblocks `agents/docs/tasks/blocked/ui-orcid-callback-fresh-auth-mode-dispatch.md`. When this backend task is archived, the architect will move the UI task back to `tasks/pending/` so the UI implementer can verify tests still pass against the now-correct wire shape and address the two folded sub-items (clause (a) header restoration, NaN-expiresAt guard parallel-fix).

The `session_auth` sibling response (around `orcid.ts:1200+`) is target-less by design and does NOT need a parallel change — session-kind proofs are not target-bound.

## Out of scope

- Frontend changes — addressed in `ui-orcid-callback-fresh-auth-mode-dispatch` (held in `blocked/` pending this task).
- Consumer-side `/start` caller — owned by `ui-multi-author-consent-affordances` (in `blocked/`).
- `session_auth` response — target-less by design, not affected.

## Cross-references

- `backend/src/routes/orcid.ts:1144-1150` — issuance call site to modify.
- `agents/docs/api-contracts/orcid.md:204-210` — fresh_auth response shape doc to update.
- `agents/docs/api-contracts/orcid.md:56` — narrative about SPA submit vs backend echo.
- `frontend/src/pages/orcid-callback.js:305-311` — frontend consumer (do not edit from backend; UI task addresses this).
- `frontend/src/lib/fresh-auth.js:75-112` — `cacheConsentOpProof` + `getCachedConsentOpProof` (do not edit).
- `agents/docs/solutions/conventions/wire-contract-shape-pinned-on-backend-not-stub-2026-05-16.md` — the documented convention this fix and its integration test enforce.
- `agents/docs/tasks/blocked/ui-orcid-callback-fresh-auth-mode-dispatch.md` — the UI task this unblocks.

## Backend implementation note (2026-05-16)

Code change landed at `backend/src/routes/orcid.ts` `handleFreshAuth` (around the old line 1144). The `sendOk` envelope now carries seven fields: `mode`, `fresh_auth_proof`, `expires_at`, `mechanism`, `action`, `root_author`, `root_permlink`.

Reachability of the defensive 400 confirmed: `backend/src/routes/orcid.ts:540-547` rejects the request with `'fresh_auth state is missing the per-op target binding'` BEFORE the switch dispatches to `handleFreshAuth(...)` at line 548, so `target` is guaranteed non-null at the new `sendOk` echo site. An inline code comment was added at the echo site documenting this invariant.

Integration test pin: extended the existing happy-path test at `backend/tests/routes/orcid.test.ts` describe block `POST /api/orcid/callback — fresh_auth mode (round-4 hold #6)` with three new `expect(...)` assertions on `data.action`, `data.root_author`, `data.root_permlink`. The expected values match the `startAuthed('fresh_auth', ...)` helper defaults (`author_accept` / `someroot` / `somepermlink-v1`) which the helper passes into `/api/orcid/start` and which the backend persists into the Redis state for the callback to read back. This pins the wire shape on the backend per the `wire-contract-shape-pinned-on-backend-not-stub-2026-05-16` convention. The test file's existing carve-out header (DB pool mocks + `broadcastJsonMock`, real `verifyHiveSignature`, real Redis) already covers this assertion's risk class — no new mock surface introduced.

## [TODO Architect] — api-contracts/orcid.md edits required

The architect lands these during the archive-time pass per `agents/backend/CLAUDE.md` "Boundaries" (api-contracts are architect-owned, not backend-editable):

1. **Response-shape lines 204-210 of `agents/docs/api-contracts/orcid.md`** — extend the documented `fresh_auth` response body to include the three new fields:

   - `action` — the target's action, one of the documented `FreshAuthTargetAction` values (e.g. `author_accept`, `author_resign`).
   - `root_author` — the target's `root_author` (Hive account name, lowercase, 3–16 chars).
   - `root_permlink` — the target's `root_permlink` (Hive permlink slug).

   Format consistent with the existing four-field documentation; values are echoed from the Redis state's `fresh_auth_target` block submitted to `/api/orcid/start`.

2. **Narrative line 56 of `agents/docs/api-contracts/orcid.md`** — currently reads "State carries the target across the OAuth round-trip; the SPA does not re-submit it on `/callback`". This is still TRUE for the request body (SPA does not re-submit target on `/callback`), but the response now echoes it. Make the distinction explicit so future readers understand the difference between "SPA submits target" (no, only on `/start`) and "backend echoes target for cache binding" (yes, on `/callback` fresh_auth response). Suggested rewording: "State carries the target across the OAuth round-trip; the SPA does not re-submit it on `/callback`. The backend echoes the target triple (`action`, `root_author`, `root_permlink`) in the `fresh_auth` response body so the SPA can cache the issued proof keyed on its actual binding (see Response shape below)."

3. **No changes to the defensive 400 documented at line 216** — that rejection still fires the same way; the 400 vs the new echo path is orthogonal (the 400 fires when state is corrupt; the echo runs after the state lookup succeeds and the target is in hand).

No code change required for items 1-3; these are doc-only and editing `api-contracts/*.md` is outside the backend agent's zone.
