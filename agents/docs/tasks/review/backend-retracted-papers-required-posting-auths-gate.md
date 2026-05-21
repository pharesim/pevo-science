# Gate retracted-paper reads on required_posting_auths

**Owner:** backend
**Created:** 2026-05-21

## Symptom

A third party can broadcast `{custom_id: pevotest, action: 'retract_paper', author: <victim>, permlink: <victim-paper>}` with their own posting key and suppress the victim's paper from `/api/papers` listings, `/api/papers/:author/:permlink` (via the retraction-info overlay), and the bridge import path. The producer-side convention — only the retract handler (`papers.ts:3263`) broadcasts retract_paper, signed with `config.pevoAdminPostingKey` — is not a chain-enforced read-side gate. All three read sites trust any `retract_paper` custom_json whose `custom_id` matches the app tag.

This is the same forgery class that `activeAccreditationsCteBody` already defends against via `required_posting_auths ?| $N::text[]`. The accreditation gate explicitly defangs broadcaster-spoofing for accredit/revoke ops; the retracted-paper sites never adopted it.

## Scope

Add a posting-auths gate to all three retracted-paper read sites, scoped to `config.hiveAdminAccount` (singular — the admin account is the sole legitimate broadcaster of retract_paper per the current handler, and the architecture pins admin as singular by design):

1. `retractedPapersCteBody` in `backend/src/hafsql.ts:252` — add `AND cj.required_posting_auths ? $N` with `config.hiveAdminAccount` bound to `$N`.
2. `loadRetractedPapers` in `backend/src/routes/papers.ts:2665` — same gate.
3. `isRetracted` in `backend/src/routes/papers.ts:3242` — same gate.

Use the singular `?` JSONB operator (does the array contain this string?) rather than `?|` with a one-element array, since the legitimate broadcaster set is exactly one account. This is a deliberate departure from the `?|` shape in `activeAccreditationsCteBody` — that CTE binds `config.accreditationAuthorities` (plural), while admin is singular.

## Why this is safe to backfill retroactively

Every retract_paper custom_json broadcast through the PEvO backend uses `config.pevoAdminPostingKey`, so `required_posting_auths` will always be `[config.hiveAdminAccount]`. Adding the gate cannot drop a legitimate retraction. The pevotest namespace is small enough (single-digit retractions today) that a manual cross-check against the live HAF before merging is feasible — run a one-shot query for any retract_paper rows whose `required_posting_auths` does NOT include `config.hiveAdminAccount` and confirm they are forgeries or test broadcasts.

## Out of scope

- Multi-admin / admin key rotation. The architecture pins `config.hiveAdminAccount` as singular (`project_admin_is_singular`); if that ever widens to plural, this gate widens with it.
- Author-direct retraction (no backend mediation). If a future flow lets the paper author broadcast retract_paper directly with their own key, the gate's predicate would need to include "author of the named paper" — but that path doesn't exist today and would need design.
- Retroactive cleanup of any forged rows already on-chain. The gate filters them out at read time; nothing on-chain can be undone.

## Acceptance criteria

- All three read sites gate on `required_posting_auths ? config.hiveAdminAccount`.
- A live-HAF sanity check confirms no legitimate retractions are dropped by the gate (`SELECT COUNT(*) FROM ... WHERE action='retract_paper' AND NOT (required_posting_auths ? '<admin>')` returns 0, or only known-bad rows).
- `backend/tests/hafsql.test.ts` and any retract-related route tests pass.
- Manual repro: hit `/api/papers` and a single paper-detail endpoint, confirm retracted papers are still correctly suppressed (no behavior change for legitimate retractions).
