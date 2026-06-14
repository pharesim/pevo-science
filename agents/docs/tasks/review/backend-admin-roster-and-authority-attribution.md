# Admin Roster, Tier Authorization, and `issued_by` Authority Attribution

**Owner:** backend
**Created:** 2026-06-14

Introduce a chain-derived admin roster (the human-authorization layer in front of the single on-chain signer), tier-based gating of every authority endpoint, and `issued_by` attribution stamped onto every authority op payload. The on-chain signer is unchanged: all authority custom_json ops continue to be signed by the `config.pevoAdminPostingKey` / `config.hiveAdminAccount` (`pevo.admin`) key via `broadcastAdminCustomJson` (`backend/src/hive.ts`). This task does NOT widen the signer or the `config.accreditationAuthorities` whitelist (which stays `= [hiveAdminAccount]`). What is new is a roster of *humans* authorized to trigger that single key, recorded on-chain for transparency and read live (no persistent app-DB mirror).

## Why

Today any path that reaches `broadcastAdminCustomJson` acts as the undifferentiated `pevo.admin`. There is no record of *which human* triggered an accredit / sanction / retraction, and no graduated permission model. The roster adds (a) a chain-derived human-authorization layer (read live from HAF, Redis-cached — no persistent table to drift), (b) tier gating per the power matrix, and (c) an `issued_by` field on every authority payload. The roster is derived entirely from the on-chain `admin_grant` / `admin_revoke` ops (chain is SSoT; a Redis TTL cache fronts the HAF read), exactly as accreditation membership is derived from `accredit`/`revoke`.

### Power matrix (settled 2026-06-14)

- `admin` — ALL operational authority ops: accredit, approve_authorship (incl. bridged-paper author approval), sanction (`revoke` with `type:"sanction"`), retract_paper, revoke_authorship.
- `super_admin` — all operational ops PLUS promote/demote `admin`s.
- `root` — all of the above PLUS promote/demote `super_admin`s AND `update_weights`. Root = the `pevo.admin` key-holder (operator), bootstrap config, un-demotable.

ONLY `update_weights` and super-admin-management are root-gated; admin-level roster management is `super_admin`+. All operational moderation is available to a plain `admin`.

## Acceptance criteria

- [ ] **No persistent roster table.** Admin status is read LIVE from the chain — there is no `admins` Postgres table. Implement an `active_admins` HAF read over `admin_grant` / `admin_revoke` ops (custom_json `id = config.appTag`, `required_posting_auths` contains `config.hiveAdminAccount` via the singular-`?` JSONB containment pattern, latest-op-per-account wins), the direct analogue of `activeAccreditationsCteBody` / `getAccreditedSet`. Each op carries `account` + `level`; the latest non-revoked grant per account is the live level. Front it with a Redis TTL cache namespaced `${config.appTag}:` (mirror the accreditation `hafCache` / `getAccreditedSet` caching). The read MUST fail closed (resolve to "no level" / deny) if neither HAF nor cache can answer.
- [ ] **Authorization layer.** Add a resolver that maps a verified caller (the Hive username set by `verifyHiveSignature`) to a level (`root` from bootstrap config, else the latest non-revoked on-chain grant for the account via the `active_admins` read, else none) and a gating helper/middleware `requireAdminLevel(min)` enforcing the matrix. Gate every authority endpoint: accredit (`routes/accreditation.ts`), ORCID accredit (`routes/orcid.ts` x2), signup-verify accredit (`routes/signup-verify.ts`), `retract_paper` (`routes/papers.ts`), `approve_authorship` / `revoke_authorship` (`routes/claims.ts`), sanction (the authority-triggered `revoke` path). `update_weights` gated to `root` only.
- [ ] **Critical-action re-auth.** Per ARCHITECTURE.md §6.4 critical-action contract and §6.5 invariant #1, every authority action and every roster-management action is a critical action: it MUST require a fresh re-auth proof (real `verifyHiveSignature` against a signed challenge), NOT a JWT alone. The level resolver keys off the verified Hive username, not a JWT claim.
- [ ] **`issued_by` stamping at every broadcast site.** Add `issued_by: <admin_hive_account>` to EVERY authority op payload passed to `broadcastAdminCustomJson`:
  - `accredit` — `routes/accreditation.ts` (`customJsonPayload` near the `broadcastAdminCustomJson` call), `routes/orcid.ts` (both call sites), `routes/signup-verify.ts`.
  - `revoke` / sanction — `wot.ts` `buildRevocationPayload` (consumed by `cascadeRevocation` and `revokeVoucheeIfBelowThreshold`) and the authority-sanction path. NOTE: WoT auto-revocations carry the system marker (see below), not a person.
  - `retract_paper` — `routes/papers.ts`.
  - `claim_authorship` / `approve_authorship` / `revoke_authorship` — `routes/claims.ts` (the server-side broadcast payloads; the `claim_authorship` light-account path is signer-implicit but still stamps the triggering admin where an admin triggers it).
  - `update_weights`.
- [ ] **WoT auto-grant system marker.** WoT auto-accreditation (`broadcastWotAccreditation`) and any self-healing/threshold WoT op stamp `issued_by: "wot"` (a system marker, not a person). Coordinate the exact marker string with `backend-revoke-sanction-wot-membership` so both tasks agree.
- [ ] **Payload type updates (`types/hive.ts`).** Add `issued_by: string` to `AccreditAction`, `RevokeAction`, `RetractPaperAction`, `UpdateWeightsAction`, and the authorship actions (`claim_authorship` / `approve_authorship` / `revoke_authorship` shapes). Add the new `AdminGrantAction` / `AdminRevokeAction` interfaces (below) and union them into the authority-action union alongside `AccreditAction | RevokeAction | UpdateWeightsAction`.
- [ ] **Promotion / demotion endpoints.** `super_admin` promotes/demotes `admin`s; `root` promotes/demotes `super_admin`s. Each endpoint's only write is the on-chain broadcast: emit an `admin_grant` / `admin_revoke` authority op signed by `pevo.admin` via `broadcastAdminCustomJson`, `issued_by` the acting human. On broadcast success, BUST the Redis `active_admins` cache key so the new level is visible immediately. There is NO app-DB write — the next `active_admins` read re-derives the level from the chain. Handle the broadcast-timeout-ambiguous outcome the way the WoT broadcast paths do (do not assume success on timeout).
- [ ] **Lockout guard.** Cannot demote `root` (it is bootstrap config, not an on-chain grant, so no `admin_revoke` targets it — reject any attempt). Cannot demote the last avenue of `super_admin`-tier control such that no human can manage the roster — reject with a clear, emdash-free error string. Because root is always present via config, the roster can never be emptied of bootstrap authority.
- [ ] **`admin_grant` / `admin_revoke` wire format.** Define and document inline in `types/hive.ts`:
  - `AdminGrantAction`: `{ action: "admin_grant"; account: string; level: "admin" | "super_admin"; issued_by: string; timestamp: string }`
  - `AdminRevokeAction`: `{ action: "admin_revoke"; account: string; level: "admin" | "super_admin"; reason: string; issued_by: string; timestamp: string }`
  - Both signed by `pevo.admin`; `issued_by` is the acting `super_admin`/`root`. Ordering/latest-wins reads from CHAIN BLOCK TIME, not the payload `timestamp` (mirrors the accredit tenure convention) — the latest non-revoked grant per account is the live level.
- [ ] **Tests.** Tier gating (a plain `admin` is rejected from roster management; a `super_admin` is rejected from demoting another `super_admin`; `update_weights` rejected for non-`root`); `issued_by` present and correct on each authority op payload (and the `"wot"` marker on WoT auto-grants); the `active_admins` read reflects latest-op-per-account wins (a grant then a later `admin_revoke` resolves to no-level) and the Redis key is busted on self-initiated grant/revoke so the new level is visible without waiting for TTL; fail-closed when HAF is unavailable and the cache is cold. For tests whose focus is NOT cryptographic verification, the `MOCK_VERIFY_SIGNATURE` fixture (`backend/tests/fixtures/mock-auth.ts`) is permitted under the CLAUDE.md carve-out with the required header acknowledgement; at least one real-path companion must exercise real `verifyHiveSignature` on a gated authority route so the re-auth invariant (§6.5 #1) is covered for real.

## Comment / doc cleanup (REVERSES nothing about the signer)

- [ ] Update the "admin account is singular by design" comment in `hafsql.ts` (the retracted-papers / admin-op JSONB containment fragment, near the `params: [config.appTag, config.hiveAdminAccount]` query — singular `?` not `?|`) to clarify the distinction: the *signer* (`pevo.admin`) stays singular by design; the *human admin roster* is a new, separate authorization layer in front of it, derived from on-chain `admin_grant`/`admin_revoke` ops. Do not anchor the new comment on line numbers — anchor on the stable function/query identity.
- [ ] Update the root `CLAUDE.md` "admin is singular by design" note (and the `project_admin_is_singular` memory if surfaced) to record: the SIGNER and `config.accreditationAuthorities` / `config.hiveAdminAccount` stay singular and un-widened; the new `admins` roster is the human-authorization layer (chain-derived, read live — no persistent table) and does NOT widen the on-chain signer. (Architect owns `CLAUDE.md` edits — file a note/TODO rather than editing it directly if the boundary blocks you.)

## Coordination

This task touches shared code with two sibling accreditation tasks:

- **Authority-op payloads (`issued_by` shape).** The `issued_by` field added here is shared with `backend-editable-accreditation-metadata` (accredit re-broadcast carries `issued_by`) and `backend-revoke-sanction-wot-membership` (the sanction/`type:"sanction"` payload carries `issued_by`; WoT auto-grant uses the `"wot"` system marker). Agree the field name (`issued_by`), the system-marker string for WoT, and the `types/hive.ts` shape with both tasks before landing so the `AccreditAction` / `RevokeAction` interfaces are edited once, not thrice. Whoever lands first defines the field; the others extend.
- **Sanction authorization.** The tier-authorization layer added here (plain `admin` may issue a sanction) is *consumed by* `backend-revoke-sanction-wot-membership` — that task implements the sanction semantics (`type:"sanction"` stickiness, the ever-sanctioned guard in `broadcastWotAccreditation`, live-threshold WoT membership); this task only gates *who* may trigger the authority-sanction op and stamps `issued_by`. Do not implement sanction stickiness or the WoT membership rewrite here.
- **`hafsql.ts` reads.** `activeAccreditationsCteBody` / `accreditationStatusCteBody` / `activeVouchesCteBody` are edited by BOTH `backend-editable-accreditation-metadata` (latest-vs-earliest accredit op, tenure anchor) and `backend-revoke-sanction-wot-membership` (sanction filtering + live-threshold). The `active_admins` read added here is a SEPARATE new CTE/helper over `admin_grant`/`admin_revoke` (the analogue of `activeAccreditationsCteBody`) — keep it a standalone fragment; do NOT entangle the accreditation CTEs.

## Implementation notes

- Resolver order: `root` (bootstrap config) → latest non-revoked on-chain grant for the caller (`active_admins` HAF read, Redis-cached) → unauthorized. The lockout guard runs before broadcast on demote.
- Latest-op-per-account-wins makes re-broadcast naturally idempotent (a re-emitted `admin_grant` just re-resolves to the same level — there are no rows to duplicate).
- All user-facing error strings (lockout, insufficient tier) must be emdash-free per project convention.

## Backend progress (PARTIAL — 2026-06-14, NOT ready for review)

Two of the five increments have landed on `main`; three remain. This task is
NOT in `review/` — do not archive until the remaining increments land.

**Landed:**
- Roster core (commit `f51e9820`): `activeAdminsCteBody` (hafsql.ts, singular `?`
  signer gate over `admin_grant`/`admin_revoke`, verified against live HAF),
  `admin-roster.ts` service module (`getAdminRoster` Redis-cached chain read,
  `getAdminLevel` resolver root→grant→none with fail-closed, `levelMeets`,
  `requireAdminLevel` middleware, `bustAdminRosterCache`), `config.rootAdminAccount`
  bootstrap (`PEVO_ROOT_ADMIN || hiveAdminAccount`), `AdminGrantAction` /
  `AdminRevokeAction` types + union. 16 tests.
- `issued_by` attribution (commit `8d3b0fd7`): field defined on `AccreditAction` /
  `RevokeAction` / `RetractPaperAction` (optional on `UpdateWeightsAction`), stamped
  at every `broadcastAdminCustomJson` site.

**Resolved design decision (with user, 2026-06-14) — self-service accredit is NOT
admin-gated.** The email `/verify`, ORCID callback, and signup confirm/link flows
are triggered by the scientist (no admin in the loop), so `requireAdminLevel` on
them would break self-service accreditation. They are LEFT UNGATED and stamp
`issued_by = config.hiveAdminAccount` (the admin account is the accreditor; the
user only supplies verification). `requireAdminLevel` + fresh-auth applies ONLY to
genuine admin-moderation endpoints. WoT auto ops stamp `issued_by: "wot"`.

**Findings for architect triage:**
- `update_weights` has NO backend broadcast endpoint today (read-only from chain in
  reputation.ts / reputation-batch.ts). Nothing to gate-to-root or stamp; the type
  field is added for forward-compat only. The AC's "gate update_weights / stamp
  issued_by" is moot until a backend broadcast endpoint exists.
- Bridge-key authorship paths in `claims.ts` (approve/revoke via
  `broadcastJsonWithTimeout` under `config.hiveBridgeAccount`, a DIFFERENT signer)
  are NOT stamped — only `broadcastAdminCustomJson` payloads were, per the AC's
  load-bearing rule. Whether bridge-signed ops also carry `issued_by` is a finer
  attribution question for the architect.

**Remaining increments:**
1. Gate admin-moderation endpoints (`retract_paper` papers.ts, `approve_authorship`
   / `revoke_authorship` claims.ts) with `requireAdminLevel(tier)` + a fresh re-auth
   proof per §6.4 (per-request Hive signature for self-custody; fresh-auth token for
   light accounts — read §6.4 carefully; do NOT ship a JWT-only critical path). The
   sanction endpoint is owned by `backend-revoke-sanction-wot-membership`; provide the
   middleware/fresh-auth machinery for it to wire through.
2. Promote/demote endpoints: `super_admin` ↔ `admin`, `root` ↔ `super_admin`;
   broadcast `admin_grant` / `admin_revoke` (`issued_by` = acting human) then
   `bustAdminRosterCache()`; lockout guard (cannot demote `root`; cannot orphan
   `super_admin` control); broadcast-timeout-ambiguous handling per the WoT pattern.
3. hafsql.ts "admin singular by design" comment update (signer singular vs roster
   layer); `[TODO Architect]` notes for the root `CLAUDE.md` "admin is singular"
   edit and the `project_admin_is_singular` memory; final full typecheck/lint/test.

## Backend completion (2026-06-14) — remaining increments landed; ready for review

Topology decision (with user, 2026-06-14): the admin authority surface is exposed
as NEW `/api/admin/*` endpoints (roster-gated + fresh-re-auth), SEPARATE from the
existing self-service user-signed routes (author self-retract in `papers.ts`, peer
approve/revoke in `claims.ts`), which keep their own identity-based authorization
untouched. This matches the already-built, in-review `ui-admin-console` SPA, which
explicitly defers final shapes to the backend. The earlier increment-1 phrasing
("gate the existing endpoints") would have either broken those self-service paths
or forced a UI rewrite; the new-endpoint topology avoids both.

**Landed:**
- Increment 2+1 (commit `a026f63f`): fresh-auth machinery in `lib/fresh-auth.ts`
  (`AdminFreshAuthTargetAction` tuple/union/Set/guard for the six `admin_*`
  actions + generic `adminActionFreshAuthTarget((action,<username>,'')` builder);
  issuance wiring on BOTH paths (`POST /api/custody/fresh-auth` password +
  `POST /api/orcid/start mode=fresh_auth` ORCID) + the body-shape validator).
  Reusable `requireFreshAdminAuth(action)` in `admin-roster.ts` (self-custody
  signature passes; JWT path demands a single-use target-bound proof, 401/403
  split mirroring `ipfs.ts`) — the sibling sanction task wires through this same
  helper. `getAdminRosterDetailed()` + `activeAdminsCteBody` now project
  `granted_by`/`granted_at` (additive; `getAdminLevel`'s account/level read
  unchanged). Seven endpoints in `routes/admin.ts`, each
  `verifyHiveSignature -> requireAdminLevel(tier) -> validate -> requireFreshAdminAuth`:
  `GET /roster` (tier:null/200 for non-roster), `POST /roster/grant|revoke`
  (tier matrix + lockout guards: root un-demotable, no self-demote; cache bust on
  success/timeout, broadcast-timeout-ambiguous handled via `handleBroadcastError`),
  `POST /accreditation/grant`, `/papers/retract`, `/authorship/revoke`
  (pevo.admin-signed), `/authorship/approve` (bridge-key, bridged papers only).
  `issued_by` stamps the acting admin on every payload.
- Increment 3 (commit `cfa2bfbe`): `retractedPapersCteBody` comment clarified
  (singular on-chain SIGNER vs the separate chain-derived human-admin ROSTER).
- Tests (commit `a0df4799`): `tests/routes/admin-endpoints.test.ts` (25, mocked-auth
  focus: tier gating, lockout, issued_by/payload capture, fresh-auth gate,
  roster GET disclosure) + `tests/routes/admin-fresh-auth-real-path-verifyhivesignature.test.ts`
  (3, real `verifyHiveSignature` + `requireFreshAdminAuth` on `/roster/grant` —
  carve-out clause (c) real-path companion for the new gate). 28 new + related
  existing (admin-roster, fresh-auth, custody-fresh-auth, admin) all green
  (132 specs). `npm run typecheck` (src+tests) + `npm run lint` clean (one
  pre-existing unrelated warning in `author-supersession.ts`).

**[TODO Architect] — API-contract edits (architect-owned `api-contracts/*.md`):**
- Document the new `/api/admin/*` endpoints (paths, request/response shapes,
  tier + fresh-auth requirements). Shapes are pinned by `routes/admin.ts` +
  `validation.ts` and match `frontend/src/api.js`'s `/admin/*` client. Suggest a
  new section in `accreditation.md` (alongside the existing
  `/api/admin/accreditation/reset-broadcast-counter`) or a dedicated admin block.
- Document the new fresh-auth issuance actions (`admin_grant_role`,
  `admin_revoke_role`, `admin_grant_accreditation`, `admin_retract_paper`,
  `admin_revoke_authorship`, `admin_approve_authorship`) in `custody.md`
  (`POST /api/custody/fresh-auth`) and `orcid.md` (`POST /api/orcid/start
  mode=fresh_auth`), and the §6.4 admin-authority row already added at
  ARCHITECTURE.md line ~855.

**[TODO Architect] — decisions to confirm:**
- `update_weights` remains moot: there is still NO backend `update_weights`
  broadcast endpoint (read-only from chain), so nothing to root-gate or stamp.
  The type field exists for forward-compat only.
- Bridge-signed `approve_authorship` (`/authorship/approve`) now carries
  `issued_by` (the acting admin) even though it is signed by the bridge key, not
  pevo.admin. This resolves the open "should bridge-signed ops carry issued_by"
  question in the attribution direction (attribution is a payload field,
  independent of the signer). Confirm or revert.
- **Pre-existing §6.4 gap (left untouched by design):** the self-service routes
  (`POST /api/papers/:author/:permlink/retract`, `POST /api/papers/:author/:permlink/claims/:claimer/{approve,revoke}`)
  accept a JWT without a fresh re-auth proof. Per the user's "keep it separate
  from user actions" decision, these were NOT modified here. Strictly, §6.4 line
  735 ("every critical action requires fresh re-auth") implies they should gate
  too; filing as a separate follow-up rather than widening this task's scope.
- Roster `granted_at` is the grant op's payload `timestamp` (display only;
  latest-wins ordering uses `block_num`), mirroring `activeAccreditationsCteBody`'s
  `event_timestamp`. If the architect wants chain-block-time for display, that is
  an additive block-time join (out of scope here).
