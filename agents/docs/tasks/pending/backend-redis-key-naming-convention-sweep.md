# BE-REDIS-KEY-NAMING-CONVENTION-SWEEP — Audit and resolve `:cache:` prefix drift

**Owner:** architect (audit) + backend (retrofit)
**Created:** 2026-04-21 (surfaced by BE-ORCID-TOCTOU-LOCK project-standards review 2026-04-21)
**Priority:** P2

## Context

`agents/backend/CLAUDE.md` Redis Conventions state: **"All Redis keys are prefixed with `${APP_TAG}:cache:`"**. The intent appears to be namespacing keys so a future `appTag` change (or coexistence of `pevo` and `pevotest` instances in one Redis) cannot collide.

Current state shows drift. Several key builders omit the `:cache:` segment:

1. `backend/src/routes/orcid.ts` — `orcidBindingCacheKey` returns `${config.appTag}:orcid_binding:${orcidId}` (pre-existing).
2. `backend/src/routes/orcid.ts` — `orcidBindingLockKey` returns `${config.appTag}:orcid_binding_lock:${orcidId}` (added by BE-ORCID-TOCTOU-LOCK commit `635d482`).
3. `backend/src/middleware/verifyHiveSignature.ts` — replay cache key shape (check for drift).
4. `backend/src/middleware/rateLimit.ts` — `${config.appTag}:rl:${name}:*` shape (clearly not `:cache:`; rate-limit keys are not caches by any definition).
5. Other call sites TBD — full sweep needed.

Two outcomes are possible:

**Option A — the rule is too narrow.** `:cache:` was coined when the only Redis use was HafCache. Lock keys, rate-limit keys, session keys, replay caches are not caches. The rule should be **"Every Redis key is prefixed with `${APP_TAG}:<domain>:`"** where `<domain>` is an open set (`cache`, `rl`, `lock`, `orcid_binding`, `orcid_state`, etc.). Under this rule the drift is apparent but not wrong; the backend CLAUDE.md wording is what needs updating.

**Option B — the rule is load-bearing.** `:cache:` is meant as a namespace collision guard. All keys should actually use it, even if semantically awkward (`${APP_TAG}:cache:orcid_binding_lock:${orcidId}`). Under this rule, existing keys need a one-time retrofit + a migration note (old keys expire naturally; new keys use the new shape).

`reference_redis_app_tag.md` in the user's auto-memory says: *"All Redis keys must be prefixed with `${config.appTag}:` (caches, rate limits, tokens, etc.)"* — which agrees with Option A. The backend CLAUDE.md and the user memory disagree about whether `:cache:` is a required segment or just one possible domain. This task resolves the disagreement.

## Goal

1. **Audit.** Grep the backend for all `${config.appTag}:` key construction sites. Enumerate their current shape.
2. **Decide.** Architect picks Option A or B and updates `agents/backend/CLAUDE.md` accordingly.
3. **Retrofit (if B).** Backend agent updates key builders + notes the TTL-based migration (existing keys expire naturally, new keys use the new shape; no data migration needed for cache/lock/rl keys).

## Non-goals

Changing the `${config.appTag}` segment itself. Introducing a new Redis prefix constant module (unless the sweep reveals enough duplication to justify one).

## Acceptance

- `agents/backend/CLAUDE.md` has one unambiguous Redis-key-naming rule.
- All key builders in `backend/src/` conform.
- If Option B chosen: no data migration needed (all affected keys are TTL'd or short-lived).

## [TODO Architect]

1. Run the audit first — the decision depends on how many keys currently drift and in how many distinct shapes.
2. Pick Option A or B with a one-paragraph rationale written into the updated CLAUDE.md rule.
