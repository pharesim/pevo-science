# BACKEND-PEVO-ADMIN-KEY-STARTUP-VALIDATION — Validate `pevoAdminPostingKey` at server startup so a malformed key fails boot, not a runtime 504

**Owner:** backend
**Created:** 2026-04-28 (architect, surfaced by `/ce-code-review` of `BACKEND-ORCID-ACQUIRED-BRANCH-THROW-GUARD` commit `0d0c156`)
**Priority:** P3
**Source:** Cluster A `/ce-code-review` of `0d0c156` — agent-native AN-001 + reliability REL-001 + adversarial adv-001 (3-reviewer convergence, conf 100 after promotion).

## Problem

`BACKEND-ORCID-ACQUIRED-BRANCH-THROW-GUARD` (commit `0d0c156`) added a wrapper-level catch on `withOrcidBindingLock`'s `'acquired'` branch that routes every escaping throw through `handleBroadcastErrorAmbiguous` → 504 `BROADCAST_TIMEOUT` with `outcome:'uncertain'`, `verify_before_retry:true`, `verify_location:'/settings'`.

Two throw classes route through that catch at HEAD:

1. **Post-broadcast cascade throws** — `cacheOrcidBinding` / `__test_seams.updateAccountOrcid` / `seedAccreditationBonus` rejecting after the broadcast succeeds. Wrapped by `fn` as `PostBroadcastWriteError` (commit `d8b9b75`); `handleBroadcastError` now routes these to **502 POST_BROADCAST_FAILED** (`outcome:'confirmed'`), so they no longer hit the 504 path. Resolved.

2. **Pre-broadcast SYNC throws** — `PrivateKey.fromString(config.pevoAdminPostingKey)` at `backend/src/routes/orcid.ts:520` (handleAccredit) and `:610` (handleLink) on a malformed admin posting key, or `crypto.createHash` building `evidence_hash`. Still route through the wrapper catch as 504 `outcome:'uncertain'`. **No broadcast was attempted, so the outcome is *certain* (nothing happened) — yet the user is told to "verify your ORCID linkage at /settings before retrying" with nothing to verify, and operator alerts keyed on `<routeLabel> broadcast failed on ambiguous-outcome path` page broadcast-on-call when the actual root cause is admin-key configuration.**

The post-broadcast class above can hit different cascade throw types so a wrapper-level `instanceof` discriminator on PostBroadcastWriteError already exists. The pre-broadcast SYNC class is asymmetric: the only realistic trigger in production is `PrivateKey.fromString` rejecting the configured admin key. The configured key doesn't change at runtime — so the right place to catch a malformed key is at server boot, not inside the request lifecycle.

## Goal

Validate `config.pevoAdminPostingKey` (and `config.pevoBridgePostingKey` if it shares the same shape) at server startup, before `app.listen()` returns. A malformed key fails boot loudly with a config-error log line; the wrapper catch never sees a `PrivateKey.fromString` throw in production.

## Acceptance

1. **Startup validation.** Add a startup-time validator at `backend/src/index.ts` (or a small helper module) that calls `PrivateKey.fromString(config.pevoAdminPostingKey)` once and exits the process with a clear error if it throws. Apply the same check to `config.pevoBridgePostingKey` IF it is set (the bridge key is currently optional per existing 503 SERVICE_UNAVAILABLE guard at `claims.ts`; preserve the optional semantics — if unset, skip the check rather than failing boot).

2. **Error message.** The boot-failure log line should name the env var (`PEVO_ADMIN_POSTING_KEY` / `PEVO_BRIDGE_POSTING_KEY`) and the `dhive` error class. Operators reading the log should be able to recognize "key is malformed" without grepping the wrapper catch.

3. **Test.** Unit-level: import the validator, call it with `'invalid-wif'`, assert it throws/exits with a recognizable message. Skip integration-level tests — the production guard is "process exits before listening", which is hard to assert from a request-level test.

4. **Optional follow-up — not in this scope.** The `crypto.createHash` call building `evidence_hash` is also a pre-broadcast SYNC site, but a SHA-256 hash on `${orcidId}|${username}` is not a realistic throw target in Node.js (the hash never rejects on string inputs). Leave it.

## Non-goals

- Adding a new error class to `withOrcidBindingLock`. The wrapper's catch stays as-is — the goal is to ensure the only real-world trigger never fires in production. If a future class of pre-broadcast SYNC throws appears (e.g., a new operation that synchronously serializes an ORCID payload that could reject), file a new task discriminating it at the wrapper layer.
- Changing the wrapper catch envelope shape on the pre-broadcast SYNC path. Operators who see this 504 in production after this task ships have a deployed-but-unvalidated key; the operator-alert mislabel is then a deploy-time event, not a routine alert noise issue.

## Source

- `agents/docs/tasks/review/backend-orcid-acquired-branch-throw-guard.md` `/ce-code-review` 2026-04-28 — agent-native AN-001, reliability REL-001, adversarial adv-001.
- `backend/src/routes/orcid.ts:520` — `PrivateKey.fromString(config.pevoAdminPostingKey)` in `handleAccredit`.
- `backend/src/routes/orcid.ts:610` — same in `handleLink`.
- `backend/src/lib/broadcast-error.ts:14-18` — operator-alert anchor docblock; the third stable suffix `<routeLabel> broadcast failed on ambiguous-outcome path` is the one this task removes from the pre-broadcast SYNC trigger surface.
