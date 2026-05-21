# ARCHITECT-CUSTODY-MD-FRESH-AUTH-CHANGE-EMAIL-ACTION-DOC — document `change_email` action + conditional field requirements on `/fresh-auth`

**Owner:** Architect
**Created:** 2026-05-21 (architect, surfaced by `/ce-code-review` api-contract AC-3 during `backend-custody-limiter-cpu-amplification-mitigation` round-1 review)
**Priority:** P2 (pre-existing contract doc gap; surfaced by middleware visibility)

## Problem

`agents/docs/api-contracts/custody.md` for `POST /api/custody/fresh-auth` documents only `author_accept | author_resign` as valid `action` values, and lists `password`, `action`, `root_author`, `root_permlink` as the body field set with no per-action conditional notation. The actual handler (`backend/src/routes/custody.ts` fresh-auth handler) accepts `change_email` as a third action value, and for `change_email` the `root_author` / `root_permlink` fields are NOT required (the route derives the target from the authenticated username via `req.hiveUsername`, not from body fields).

This gap predates the `backend-custody-limiter-cpu-amplification-mitigation` task; the new `validateFreshAuthBodyShape` middleware made it more visible because the middleware enumerates the same `{ author_accept, author_resign, change_email }` allowlist and applies the same action-conditional `root_author` / `root_permlink` requirement.

## Why now

Filed during architect triage of the round-1 review on `backend-custody-limiter-cpu-amplification-mitigation`. The api-contract reviewer flagged the doc-vs-code drift as AC-3 (medium, conf 90). Not held against the backend task (out of backend zone — `agents/docs/api-contracts/*.md` is architect-owned), filed as a separate architect-owned follow-up.

## Goal

Update `agents/docs/api-contracts/custody.md` to document:

1. `change_email` as a valid `action` value alongside `author_accept` and `author_resign`.
2. Conditional field requirements per action:
   - `author_accept` requires `root_author` + `root_permlink` (paper coords)
   - `author_resign` requires `root_author` + `root_permlink` (paper coords)
   - `change_email` does NOT require `root_author` or `root_permlink` (handler derives target from authenticated username)
3. The semantic difference between actions (what each is gating server-side).

## Acceptance

1. `custody.md` `/fresh-auth` section lists all three actions in the `action` field enum.
2. The body-shape table or prose makes the conditional requirement explicit (which actions require which extra fields).
3. The validator middleware shape (`validateFreshAuthBodyShape`) is consistent with the documented contract — verify by reading both side by side.
4. No other contract docs cite a partial action enum that this update would invalidate.

## Out of scope

- Code changes in `backend/`. The handler and middleware are already correct; only the contract doc is stale.
- New `change_email` semantics or behavior. This is documentation-only.
- Any related ARCHITECTURE.md updates (the action enum lives in the api-contract doc, not in the high-level architecture).

## References

- `agents/docs/api-contracts/custody.md` — `/fresh-auth` section (action enum + body fields)
- `backend/src/routes/custody.ts` — `validateFreshAuthBodyShape` middleware (action allowlist + conditional field check) and the fresh-auth handler (action dispatch)
- Source: `/ce-code-review` api-contract AC-3 finding (architect session 2026-05-21, surfaced during `backend-custody-limiter-cpu-amplification-mitigation` round-1 review)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
