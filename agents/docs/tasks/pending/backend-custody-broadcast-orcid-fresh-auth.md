# BACKEND-CUSTODY-BROADCAST-ORCID-FRESH-AUTH — Accept ORCID fresh-auth proof on `/custody/broadcast` (non-consent path)

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, surfaced by account-state-machine brainstorm at `agents/docs/ARCHITECTURE.md` § 6)
**Priority:** P2

## Problem

`POST /api/custody/broadcast` (`backend/src/routes/custody.ts`) for non-consent ops currently uses `password` as the re-auth factor. The consent-op path (lines ~273-354) already accepts a `fresh_auth_proof` discriminator that can carry either a password-mechanism or ORCID-mechanism proof; non-consent ops do not.

This blocks state C accounts (passwordless ORCID-only — see `agents/docs/ARCHITECTURE.md` § 6.1) from broadcasting any non-consent op via the server. State C users have ORCID as their only registered auth factor; they can produce an ORCID fresh-auth proof via `/api/orcid/callback mode='fresh_auth'`, but the non-consent broadcast path does not accept it.

Per `agents/docs/ARCHITECTURE.md` § 6.4 (Critical-action / re-auth contract), non-consent broadcast's required re-auth is "fresh-auth proof matching a factor registered on the account." Per-state availability: A — password proof only; B — password OR ORCID proof; C — ORCID proof only.

## Goal

Extend the non-consent `/api/custody/broadcast` re-auth gate to accept `fresh_auth_proof` (same shape as the consent-op path) in addition to / instead of bare `password`. State C accounts become able to broadcast non-consent ops via ORCID fresh-auth proof.

## Approach

The consent-op path's primitives at `backend/src/lib/fresh-auth.ts` already verify both password-mechanism and ORCID-mechanism proofs. Reuse them on the non-consent branch.

Open design choice (architect's call at implementation time, document in the implementer signal block):

- **Option A: deprecate the bare `password` field on the non-consent path.** Require all callers to pass `fresh_auth_proof` issued via `/api/custody/fresh-auth` (password mechanism) or `/api/orcid/callback mode='fresh_auth'` (ORCID mechanism). Symmetric with the consent-op path; one re-auth shape for both branches; clean wire contract.
- **Option B: support both.** Backward-compatible: accept either `password` (legacy shape for state A/B users) OR `fresh_auth_proof` (new shape, required for state C). More code paths, but no UI migration pressure.

Option A is cleaner; Option B is the safer rollout if there are deployed UI clients pinning the bare `password` shape. The architect's brainstorm recommendation is Option A — wire contract uniformity is a strong invariant per the API-contract review lens.

## Acceptance

1. State A users can broadcast non-consent ops with a password-mechanism `fresh_auth_proof`.
2. State B users can broadcast with either password OR ORCID-mechanism `fresh_auth_proof`.
3. State C users can broadcast with an ORCID-mechanism `fresh_auth_proof` — previously blocked.
4. State D users continue to receive 403 / not applicable (encrypted keys wiped at upgrade; nothing to decrypt and broadcast with).
5. Per-target binding semantics for ORCID-mechanism proofs on non-consent ops: the proof should not require a per-op target (only consent ops need that — see `agents/docs/ARCHITECTURE.md` § 6.4 second row). A general session-level ORCID proof suffices.
6. Real-path integration tests cover the new ORCID branch for state C accounts, plus regression tests for A and B.
7. `agents/docs/api-contracts/custody.md` updated to document the wire-shape change (architect-zone — flag as `[TODO Architect]` at implementer-signal time).

## Out of scope

- Consent-op path changes — already correct, per `custody.ts:312`.
- `/custody/fresh-auth` itself — issues proofs, doesn't consume them; no change needed.
- `/custody/upgrade` re-auth — separate task (`backend-custody-upgrade-seed-phrase-reauth.md`), uses seed-phrase-derived key, not fresh-auth proof.

## References

- `agents/docs/ARCHITECTURE.md` § 6.4 (Critical-action / re-auth contract)
- `agents/docs/ARCHITECTURE.md` § 6.5 invariants #1, #2 (re-auth at critical actions; factor must match registered set)
- `backend/src/routes/custody.ts:312` (consent-op fresh_auth_proof verification — pattern to extend)
- `backend/src/lib/fresh-auth.ts` (proof verification primitives, password and ORCID mechanisms)

## Implementer signal — 2026-05-16 (round 1)

**Design chosen:** Option A (require `fresh_auth_proof` on the non-consent path).

The current non-consent path runs no re-auth check at all — only the JWT (`verifyHiveSignature` middleware) is required. This violated § 6.5 invariant #1 ("Critical actions require fresh re-auth proof. A stolen JWT must not be a one-step takeover vector"). The task's "currently uses `password`" framing is historical aspiration, not an accurate description of HEAD. The fix is to ADD a fresh-auth gate, not deprecate an existing one.

**Storage primitive change:** extended `lib/fresh-auth.ts` `StoredEntry` with a `kind: 'consent_op' | 'session'` discriminator (default `'consent_op'` for backward compat). `issueFreshAuthToken` accepts an optional `kind` parameter — when `'session'`, the `target` argument is ignored and no `target_hash` is stored. Added a new `consumeSessionFreshAuthToken(token, expectedUsername)` that accepts EITHER a `kind: 'session'` entry (no target check) OR a `kind: 'consent_op'` entry (target check skipped — non-consent broadcasts don't need per-op binding). Cross-kind acceptance is the cheaper choice: State A/B users can mint via the existing `/custody/fresh-auth` (per-op proof) and reuse the same token for a non-consent broadcast on the same session.

**Issuance for State C:** added ORCID `mode='session_auth'` in `routes/orcid.ts`. Mints a target-less ORCID-mechanism session-kind proof. Avoids forcing State C users to send dummy per-op target fields when they're broadcasting a vote/comment/etc.

**`/custody/fresh-auth` left alone**, per the task's "out of scope" line. State A/B users keep using it (per-op issuance with action+root_author+root_permlink); the resulting token works for non-consent broadcasts too via the cross-kind accept on consume. If the operator ergonomics around requiring per-op fields on State A non-consent broadcasts become a real complaint, a follow-up can add a session-only password issuance route (or extend `/custody/fresh-auth` with a `purpose` discriminator).

**Wire shape change** — `[TODO Architect]`: `POST /api/custody/broadcast` now REQUIRES `fresh_auth_proof: string` on every call (consent op or not). Missing/expired/cross-account proofs are rejected with the same 401/403 FRESH_AUTH_REQUIRED envelope as the consent-op path. New ORCID mode `'session_auth'` requires only the authenticated session; no per-op target fields in the `/start` body. Update `agents/docs/api-contracts/custody.md` and the orcid contract doc accordingly.

**Tests:**
- `backend/tests/routes/custody-non-consent-fresh-auth.test.ts` (new) — state A/B/C/D real-path integration coverage. Mocks the chain broadcast helper + `decryptKey` per the custody.test.ts carve-out pattern, runs real Postgres + Redis + argon2 + verifyHiveSignature + fresh-auth.ts.
- `backend/tests/lib/fresh-auth.test.ts` — new section covers session-kind issuance/consume, cross-kind acceptance on `consumeSessionFreshAuthToken`, and rejection of session-kind proofs on `consumeFreshAuthToken` (the consent-op consume).
- `backend/tests/routes/custody.test.ts` — existing tests updated to pass `fresh_auth_proof` on non-consent broadcasts (was: no proof; now: required).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Architect re-review (2026-05-16, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` ran on commit `84602f8` (round-1 implementation). Account-state defense review (project CLAUDE.md): the implementation closes § 6.5 invariant #1 on the non-consent surface (JWT-alone-as-takeover-vector gap closed). Cross-kind accept is structurally sound (session-kind strictly rejected on consent surface via `kind_mismatch`; consent_op-kind accepted on non-consent surface as "strictly more proof"). All four states (A/B/C/D) are exercised in `custody-non-consent-fresh-auth.test.ts` with real `verifyHiveSignature`. Six items surface — five P1 (one cross-reviewer-promoted to conf 100), one P3 cross-task interaction. Three P2 items dismissed at architect triage (see below).

### Items to address

**1. (P1, conf 90, maintainability) `KEY_PREFIX` constant in `fresh-auth.ts` now stores session-kind tokens too but its name still says `consent_op`.** `backend/src/lib/fresh-auth.ts:140` — `KEY_PREFIX = \`${config.appTag}:fresh_auth:consent_op:\``. After round-1, `issueSessionFreshAuthToken` writes session-kind entries under the same prefix; a Redis SCAN or operator inspection of the keyspace shows `consent_op`-prefixed keys that are actually session entries. The module-level comment (line 17) repeats the stale value. Fix: rename to kind-neutral (e.g., `…:fresh_auth:token:`) and update the docstring. Pure rename, no semantic change.

**2. (P1, conf 100 cross-reviewer) `orcid.ts:515` switch on `storedMode` lacks `default: assertNever`.** Cross-reviewer corroboration: kieran-typescript KT-2 conf 75 + adversarial adv-2 conf 75 → promoted. The switch covers all six current `OrcidMode` arms but `noImplicitReturns` is not in `tsconfig.json`'s `strict` bundle, so TypeScript does not enforce exhaustiveness. A future arm added to `OrcidMode` without a switch case compiles cleanly and produces a silent no-response path at runtime. The file already uses `assertNever` at three other switches (lines 778, 979, 1646). Fix: add `default: return assertNever(storedMode);` as the terminal arm.

**3. (P1, conf 75, kieran-typescript) `orcid.ts:430` Redis-deserialized `OrcidMode` cast bypasses runtime validation.** `JSON.parse(raw) as { mode: OrcidMode; ... }` with no guard on `parsed.mode` before assigning to `storedMode`. A stale Redis entry written by a prior code version carrying an unrecognized mode literal has `storedMode` typed `OrcidMode` at compile time, but at runtime the switch at 515 has no `default` arm (see item 2), so the function exits the switch body silently and sends no response. The in-memory path (`orcidStates` Map) is safe because only validated `/start` code writes to it; the Redis path is a raw `JSON.parse` cast. Fix: before assigning, check membership: `if (!VALID_MODES.has(parsed.mode as string)) { return sendError(res, 400, 'BAD_REQUEST', 'Unrecognized state mode'); }`. Cross-confirms #2.

**4. (P1, conf 90, reliability) `handleSessionAuth` in `orcid.ts:1162` lacks try/catch on the `pool.query` call.** A DB error propagates as an unhandled throw caught by the outer `/callback` try/catch, returning a generic 500 with `orcid.callback.failed` log — no DB-failure discriminator. Every sibling handler (`handleFreshAuth`, `handleLink`, `handleAccredit`) has its own try/catch on the DB call. Fix: wrap the DB call in a try/catch with a structured `orcid.session_auth.db_failed` error event (or whichever event slug matches the sibling pattern).

**5. (P1, conf 75, maintainability) `issueSessionFreshAuthToken` duplicates the dual-write block without the round-4 rationale comment.** `backend/src/lib/fresh-auth.ts:349` — `issueFreshAuthToken` carries a multi-line comment (round-4 hold #3, lines 293-301) explaining why `memStore.set` is written unconditionally before the Redis attempt (Redis-flap spurious-401 protection). `issueSessionFreshAuthToken` performs the identical dual-write (lines 364-385) but without that rationale. A future maintainer reading only the session path will see what looks like dead code in the Redis-success branch and may remove it, reintroducing the bug the round-4 hold fixed. Fix: copy the rationale comment block from the parent function, or extract a private `storeEntry` helper that carries the rationale in one place.

**6. (P3, conf 75, correctness) Dead-code `=== null` arms in custody.ts post-fresh-auth-widening.** `backend/src/routes/custody.ts:614` (auditExtras `freshAuthMechanism === null ? undefined : {...}`) and `:626` (logBroadcastAttempt `=== null ? ... : ...`). After this round, both consent (line 372) AND non-consent (line 399) paths set `freshAuthMechanism = result.mechanism` upstream; the consume functions return early with 401/403 on missing/invalid proof. So `freshAuthMechanism === null` is guaranteed false on the success path; the `=== null` arms can never fire. Fix: drop the conditional and inline the populated branch. This also touches the migration-006 stale-comment finding (separately held on `backend-custody-audit-pii-annotation`); coordinating the rewrite there with this dead-code cleanup avoids two rounds of confusion about the same surface.

### Items dismissed during architect triage

- **(P1, conf 85, maintainability) ~80 lines duplicated between `consumeFreshAuthToken` and `consumeSessionFreshAuthToken`** — root CLAUDE.md "no premature abstractions; three similar lines is better than a premature abstraction". The split is intentional and the asymmetry (consent does target binding + kind isolation; session does cross-kind accept) means a shared helper would have to thread enough discriminator state that the abstraction adds rather than removes complexity. Revisit if a third consume function arrives.
- **(P2, conf 75, adversarial) Cross-kind accept lets a compromised SPA substitute a consent_op-bound proof into a silent non-consent broadcast.** Designer's deliberate trade-off. Alternative (strict kind isolation on non-consent) creates significantly worse State A UX (every vote/comment requires a per-op-bound proof mint). Documented residual; user mental model risk is acknowledged.
- **(P3, conf 75, adversarial) Non-consent broadcast burns fresh-auth proof before the `upgraded_at` gate** — State D users with stale light JWT waste each ORCID/password ceremony on retry. State D is one-shot (post-upgrade), rare edge case.
- **(P3, conf 75, testing) Missing route-level `kind_mismatch` → 403 integration test on consent surface.** Unit-level pin exists at `fresh-auth.test.ts:543`; the route-layer wiring is mechanical (the `status` ternary). Per `feedback_dismiss_preemptive_test_hardening`.

### Re-review signal

When items 1-6 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit. Note: item 6's coordination with the sibling `backend-custody-audit-pii-annotation` round-3 hold is structural — both touch the same `freshAuthMechanism === null` invariant. Recommend landing item 6 of this task BEFORE the migration-006 rewrite, so the dead arms are gone before the COMMENT documents the new (universal) population semantics.

## Backend re-review signal (2026-05-16, round-2 fix commit)

Round-1 hold items 1-6 landed.

- Item 1 (P1) — `KEY_PREFIX` renamed at `backend/src/lib/fresh-auth.ts:151` from `:fresh_auth:consent_op:` to `:fresh_auth:token:`; module docstring at lines 16-21 updated to reflect kind-neutral storage. Pure rename, no semantic change.
- Item 2 (P1) — `default: return assertNever(storedMode);` added at `backend/src/routes/orcid.ts:554-560` as terminal arm of the `switch (storedMode)` at `orcid.ts:531`. Future `OrcidMode` arms fail at compile time instead of silently no-responding. Matches the pattern at the three existing `assertNever` switches in the same file.
- Item 3 (P1) — `VALID_MODES.has(parsed.mode)` runtime guard added at `backend/src/routes/orcid.ts:443` on the Redis-deserialization path; the `parsed.mode` field is now typed `unknown` and narrowed via the existing module-level `VALID_MODES` set. Stale Redis entries with unrecognized literals now return 400 BAD_REQUEST `Unrecognized state mode` instead of falling out of the dispatch switch with no response.
- Item 4 (P1) — `try/catch` on the `pool.query` in `handleSessionAuth` at `backend/src/routes/orcid.ts:1186-1199`; emits structured `orcid.session_auth.db_failed` event on DB error with `route: 'orcid.handleSessionAuth'`, `username`, and `err`. Discriminates DB failures from the generic outer `orcid.callback.failed` slug.
- Item 5 (P1) — copied the round-4 hold #3 rationale comment block into `issueSessionFreshAuthToken` at `backend/src/lib/fresh-auth.ts:375-386` (preceding the `memStore.set` dual-write). Chose option (a) — duplicate the comment — over extracting a `storeEntry` helper because the issue/session shapes diverge enough (target-hash field, `consent_op` vs `session` kind) that a single-arg helper would smuggle conditional branching back into the caller while the call sites are already minimal. The duplicated comment carries the full Redis-flap spurious-401 rationale so a future maintainer cannot mistake the unconditional `memStore.set` for dead code in the Redis-success branch.
- Item 6 (P3) — dropped the dead `freshAuthMechanism === null` arms in `backend/src/routes/custody.ts:623-628` (`auditExtras` constructor) and `:632-637` (`logBroadcastAttempt('success', ...)` call). Both consent (line 372) and non-consent (line 399) paths now universally set `freshAuthMechanism = result.mechanism` upstream; both consume helpers early-return 401/403 on missing/invalid proof. Inlined the populated branch, retyped `auditExtras` from `CustodyAuditExtras | undefined` to `CustodyAuditExtras`, and added an inline note pointing forward to the universal-population invariant for the sibling `backend-custody-audit-pii-annotation` migration-006 rewrite. Coordinates with that sibling task (dead-arm cleanup lands first, then the COMMENT rewrite there documents the new semantics).

`npm run lint` clean (only the two pre-existing `seed-phrase.ts:26-27` `no-explicit-any` warnings, unrelated); `npx tsc --noEmit` clean. Vitest not run in worktree (parent serializes).

---

## Architect re-review (2026-05-16, round-2 → round-3) — HELD PENDING FIXES

`/ce-code-review` ran on commit `1437e41` (10 reviewers: correctness/security/adversarial on Opus; rest on Sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md). All 6 round-1 hold items land cleanly (verified). Four items held; one item routed to a new task; one item accepted as residual.

### Items held (must fix before archive)

**1. (P2, conf 100 — cross-reviewer-promoted: maintainability M1 + learnings-researcher) Task-slug citations and bare line-number anchors in production code comments.** Three sites in this round's diff + sibling code: `backend/src/lib/fresh-auth.ts:156` (`FreshAuthKind` docstring "See BACKEND-CUSTODY-BROADCAST-ORCID-FRESH-AUTH for the State C / non-consent broadcast path"); `backend/src/routes/custody.ts:628` (the hold #6 banner block, plus bare line-number citations `(line 372)` and `(line 399)` in the same paragraph); `backend/src/routes/orcid.ts:550` (the `session_auth` case body's `BACKEND-CUSTODY-BROADCAST-ORCID-FRESH-AUTH: target-less session proof…` comment).

  Two distinct conventions violated:
  - `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` — slug becomes a dead pointer on archive (task moves into `tasks-archive.md` which is trimmed to 250 lines).
  - `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` — line-number anchors rot on any insertion above the cited range.

  Fix shape: replace each citation with a behavioral-invariant anchor.
  - `fresh-auth.ts:156`: drop the slug suffix; the durable invariant ("State C ORCID-only accounts have no per-op target to bind a consent-op-kind proof to; session-kind closes the JWT-only takeover gap per ARCH.md § 6.5 invariant #1") is the right wording.
  - `custody.ts:628`: rewrite the comment block to anchor on the consume-helper invariant ("`freshAuthMechanism` is non-null on the success path: `consumeFreshAuthToken` and `consumeSessionFreshAuthToken` early-return 401/403 on missing/invalid proof, so whichever upstream branch ran has assigned `result.mechanism` before reaching this constructor"). Drop both bare line-number citations; reference the consume helpers by name.
  - `orcid.ts:550`: rewrite to describe what the `session_auth` case does ("target-less session-kind proof issuance — used by the non-consent broadcast surface where per-op target binding is not required"). Drop the slug prefix.

**2. (P2, conf 75, maintainability M2) `KEY_PREFIX` comment history paragraph is migration-era narrative.** `backend/src/lib/fresh-auth.ts:143-151` — four of six sentences describe the rename history ("historical name was…", "operator inspections saw…"). Once the 5-minute Redis TTL clears all old-prefix keys (within minutes of deploy), this history has zero operational value and misleads future maintainers into thinking the rename is an ongoing concern. The durable invariant fits in two sentences: kind-neutral prefix; discrimination is by the `kind` JSON field inside the stored value, not by key namespace. Git history already records the rename rationale permanently.

  Fix shape: trim to the two-sentence invariant. Drop the historical-name paragraph.

**3. (P2, conf 75, kieran-typescript KT-1) `VALID_MODES` typed as `ReadonlySet<string>` rather than `Set<OrcidMode>` — `as OrcidMode` cast is load-bearing, not redundant.** `backend/src/routes/orcid.ts:89`. The round-1 implementer signal framed `parsed.mode as OrcidMode` (line 446) as "redundant after the `VALID_MODES.has()` guard"; that's only true if TypeScript can narrow `parsed.mode` from `string` to `OrcidMode` via the set's element type, which requires `Set<OrcidMode>` (not `Set<string>`). With the current typing, a future `OrcidMode` literal added to the union but missed in the `VALID_MODES` array would silently reject valid new modes with a 400 and TypeScript would emit no diagnostic.

  Fix shape: `const VALID_MODES = new Set<OrcidMode>(['signup', 'login', 'accredit', 'link', 'fresh_auth', 'session_auth']) satisfies ReadonlySet<OrcidMode>`. This (a) makes a future OrcidMode-without-VALID_MODES-update a compile error, (b) lets TypeScript narrow `parsed.mode` post-guard so the `as OrcidMode` cast can be removed, and (c) keeps `satisfies` so the inferred type stays as the literal-element-typed set.

**4. (P2, conf 75, testing T1) No test pins the new `orcid.session_auth.db_failed` event slug or the 500 response from `handleSessionAuth`'s inner try/catch.** `backend/tests/routes/orcid.test.ts` `session_auth` describe block (around lines 3158-3265) covers four sibling branches (happy path, orcid-mismatch 403, null-orcid 403, missing-row 401), but no test drives `appQueryMock` to reject for the `SELECT orcid FROM accounts WHERE username = $1` query. A mutation removing the inner try/catch reverts to the pre-r2 bare `await pool.query`; the outer `/callback` catch still returns 500 INTERNAL_ERROR, so the status assertion passes — only the discriminated slug regresses, invisibly. The slug discriminator is exactly what item 4 was added for; without a canary it can silently regress.

  Fix shape: add a test in the `session_auth` describe block that stubs `appQueryMock` to reject for the orcid SELECT and asserts (a) status 500, (b) error code INTERNAL_ERROR, (c) logger.error called with `event: 'orcid.session_auth.db_failed'`. Pattern matches the `orcid.callback.failed` slug assertion already at `orcid.test.ts:3462`.

### Items dismissed during architect triage

- **(P3, conf 100, adversarial + security residual) `KEY_PREFIX` rename deploy-boundary orphan window** — tokens issued pre-deploy under `:fresh_auth:consent_op:` become unreadable post-deploy. Up to 5-min UX disruption (spurious 401 mid-ceremony) per deploy. Accepted residual for single-instance beta; bounded by FRESH_AUTH_TTL_SECONDS; no security weakening (orphaned tokens are unconsumable → no replay vector). Memory `project_single_instance_only` makes deploy-window-orphan UX an acceptable cost.

### Routed to follow-up tasks (not held here)

- **(P1, conf 75, adversarial adv-1) Concurrent dual-consume race on fresh-auth tokens.** `backend/src/lib/fresh-auth.ts:478-507` (`consumeFreshAuthToken`) and `:660-689` (`consumeSessionFreshAuthToken`). Redis `GETDEL` is atomic per Redis, but the local `memStore.delete(token)` fires only AFTER `await redis.getdel` resolves. Two concurrent consumes can both find the still-populated memStore backup → both return valid → both broadcasts proceed. Pre-existing of round-2 (round-2 only copies the dual-write comment); newly visible from this review. Filed as `backend-fresh-auth-consume-redis-memstore-race.md` in `tasks/pending/` for separate review against the consume helpers' invariant claims. NOT held on this task — the round-2 diff doesn't touch the consume code.

### Architect-zone work landing at archive (not held)

- `agents/docs/api-contracts/orcid.md` — `session_auth` mode error table currently lists only 400, 401, 403, 503. Item 4's `handleSessionAuth` inner try/catch now emits 500 INTERNAL_ERROR `'Session authentication failed'` on DB failure. Add the 500 row to the per-mode error table. Will land in the same commit that archives this task.

### Re-review signal

When items 1-4 land, `git mv` this file back to `tasks/review/`. Round-3 architect review scopes `/ce-code-review` to the round-3 commit only.
