# ARCHITECT-CUSTODY-SESSION-AUTH-CONTRACT-DOC — write the `/api/custody/session-auth` contract section in `agents/docs/api-contracts/custody.md`

**Owner:** Architect (self-task)
**Created:** 2026-05-16 (architect, surfaced by `/ce-code-review` of `backend-expires-at-iso-conformance` — api-contract AC-02)
**Priority:** P3 (doc-only gap, not blocking)

## Problem

The `POST /api/custody/session-auth` endpoint landed in `backend-custody-session-auth-password-mint` (currently in `tasks/review/`) and ships the State A password-mechanism session-kind fresh-auth proof. Its assertion block at `backend/tests/routes/custody-session-auth.test.ts:240` cites:

```ts
// expires_at convention matches `/api/custody/fresh-auth` and
// `/api/orcid/start mode=session_auth`: ISO-8601 string per the
// documented wire contract (api-contracts/custody.md:108,
// api-contracts/orcid.md:208,239).
```

But `custody.md:108` is inside the `/api/custody/fresh-auth` section, not a dedicated `/api/custody/session-auth` section. The endpoint has no documented contract entry. A reader landing on `custody.md` finds no specification for the new endpoint's request shape, response shape, rate limit, or error codes — they have to infer from the test file or from the sibling endpoints.

## Goal

Add a `### POST /api/custody/session-auth` section to `agents/docs/api-contracts/custody.md` documenting the State A password-mechanism session-kind fresh-auth proof issuance.

## Acceptance

### 1. Contract section structure

Mirror the existing `### POST /api/custody/fresh-auth` section in `custody.md` (the closest sibling):
- One-paragraph overview describing what the endpoint does (mint a session-kind proof for non-consent broadcasts; State A password mechanism; target-less).
- **Body** subsection: the request shape (`{ "password": "..." }`).
- **Response `data`** subsection: the response shape including `fresh_auth_proof`, `expires_at` (ISO-8601 string, mirroring the fresh-auth contract), `mechanism: "password"`.
- **Rate limit** line.
- **Errors** list: 401 UNAUTHORIZED (missing JWT / no such account / wrong password / no password mechanism), 403 FORBIDDEN (account upgraded to self-custody), 400 VALIDATION_ERROR, 500 INTERNAL_ERROR, 503 SERVICE_UNAVAILABLE.

Source of truth for the wire shape is `backend/src/routes/custody.ts` (the session-auth handler) and `backend/src/lib/fresh-auth.ts:issueSessionFreshAuthToken`. Read both before drafting.

### 2. Update cross-references

If the test comment block at `backend/tests/routes/custody-session-auth.test.ts:240` is the only consumer pointing to the wrong section, leave it alone — its citation `custody.md:108` will silently become correct once the new section's `expires_at` example sits at a known line. Alternatively, after writing the section, update the test comment to cite the new `/api/custody/session-auth` section's exact line. Implementer's call.

### 3. Sibling consistency check

`/api/orcid/callback mode=session_auth` (the ORCID-mechanism session-kind path) already has a section in `orcid.md` at lines 221+. Verify the new custody.md section's prose is consistent with the orcid.md section's framing — both are target-less session-kind proofs that admit only on non-consent `/api/custody/broadcast`. Cross-link if useful.

## Out of scope

- Backend code changes (endpoint already exists and works).
- Test file changes (existing tests pin the wire shape correctly; the doc gap is doc-only).
- Wider PEvO-wide audit of which endpoints lack contract sections (this task is scoped to one specific gap).

## Source

- `/ce-code-review` of `backend-expires-at-iso-conformance` (architect session 2026-05-16): api-contract AC-02 P3 conf 75.
- Architect-self-task: created directly in `tasks/review/` per architect protocol (architect both writes the spec and implements the doc).

## Cross-references

- `agents/docs/api-contracts/custody.md` — the target file; mirror the `/api/custody/fresh-auth` section's shape.
- `agents/docs/api-contracts/orcid.md:221+` — the `mode=session_auth` section as the ORCID-mechanism sibling for prose consistency.
- `backend/src/routes/custody.ts` — the source of truth for the route handler's wire shape.
- `backend/src/lib/fresh-auth.ts:issueSessionFreshAuthToken` — the proof issuance primitive.
- `backend/tests/routes/custody-session-auth.test.ts` — pins the wire shape; reflect that wire shape in the contract section.
- `agents/docs/tasks/review/backend-custody-session-auth-password-mint.md` — the backend task that landed the endpoint (currently awaiting architect review).
