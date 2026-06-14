# Admin Roster, Tier Authorization, and `issued_by` Authority Attribution

**Owner:** backend
**Created:** 2026-06-14

Introduce an app-level admin roster (the human-authorization layer in front of the single on-chain signer), tier-based gating of every authority endpoint, and `issued_by` attribution stamped onto every authority op payload. The on-chain signer is unchanged: all authority custom_json ops continue to be signed by the `config.pevoAdminPostingKey` / `config.hiveAdminAccount` (`pevo.admin`) key via `broadcastAdminCustomJson` (`backend/src/hive.ts`). This task does NOT widen the signer or the `config.accreditationAuthorities` whitelist (which stays `= [hiveAdminAccount]`). What is new is a roster of *humans* authorized to trigger that single key, recorded for transparency.

## Why

Today any path that reaches `broadcastAdminCustomJson` acts as the undifferentiated `pevo.admin`. There is no record of *which human* triggered an accredit / sanction / retraction, and no graduated permission model. The roster adds (a) a Postgres-cached human-authorization layer, (b) tier gating per the power matrix, and (c) an `issued_by` field on every authority payload plus an on-chain audit trail (`admin_grant` / `admin_revoke`) so the roster itself is reconstructable from the chain (chain stays SSoT; the table is a rebuildable cache).

### Power matrix (settled 2026-06-14)

- `admin` — ALL operational authority ops: accredit, approve_authorship (incl. bridged-paper author approval), sanction (`revoke` with `type:"sanction"`), retract_paper, revoke_authorship.
- `super_admin` — all operational ops PLUS promote/demote `admin`s.
- `root` — all of the above PLUS promote/demote `super_admin`s AND `update_weights`. Root = the `pevo.admin` key-holder (operator), bootstrap config, un-demotable.

ONLY `update_weights` and super-admin-management are root-gated; admin-level roster management is `super_admin`+. All operational moderation is available to a plain `admin`.

## Acceptance criteria

- [ ] **`admins` table migration.** New `backend/migrations/0XX_admins.sql` creating `admins(admin_account text, level text check (level in ('admin','super_admin')), granted_by text, granted_at timestamptz, revoked_at timestamptz null)`. Root is NOT a row — it is bootstrap config (the `pevo.admin` key-holder, derived from `config.hiveAdminAccount` or a dedicated `PEVO_ROOT_ADMIN` env, decide and document inline). Add the `schema_migrations` tracking row per migration 008 convention. Run via `./deploy.sh migrate`.
- [ ] **Authorization layer.** Add a resolver that maps a verified caller (the Hive username set by `verifyHiveSignature`) to a level (`root` from bootstrap config, else the latest non-revoked `admins` row, else none) and a gating helper/middleware `requireAdminLevel(min)` enforcing the matrix. Gate every authority endpoint: accredit (`routes/accreditation.ts`), ORCID accredit (`routes/orcid.ts` x2), signup-verify accredit (`routes/signup-verify.ts`), `retract_paper` (`routes/papers.ts`), `approve_authorship` / `revoke_authorship` (`routes/claims.ts`), sanction (the authority-triggered `revoke` path). `update_weights` gated to `root` only.
- [ ] **Critical-action re-auth.** Per ARCHITECTURE.md §6.4 critical-action contract and §6.5 invariant #1, every authority action and every roster-management action is a critical action: it MUST require a fresh re-auth proof (real `verifyHiveSignature` against a signed challenge), NOT a JWT alone. The level resolver keys off the verified Hive username, not a JWT claim.
- [ ] **`issued_by` stamping at every broadcast site.** Add `issued_by: <admin_hive_account>` to EVERY authority op payload passed to `broadcastAdminCustomJson`:
  - `accredit` — `routes/accreditation.ts` (`customJsonPayload` near the `broadcastAdminCustomJson` call), `routes/orcid.ts` (both call sites), `routes/signup-verify.ts`.
  - `revoke` / sanction — `wot.ts` `buildRevocationPayload` (consumed by `cascadeRevocation` and `revokeVoucheeIfBelowThreshold`) and the authority-sanction path. NOTE: WoT auto-revocations carry the system marker (see below), not a person.
  - `retract_paper` — `routes/papers.ts`.
  - `claim_authorship` / `approve_authorship` / `revoke_authorship` — `routes/claims.ts` (the server-side broadcast payloads; the `claim_authorship` light-account path is signer-implicit but still stamps the triggering admin where an admin triggers it).
  - `update_weights`.
- [ ] **WoT auto-grant system marker.** WoT auto-accreditation (`broadcastWotAccreditation`) and any self-healing/threshold WoT op stamp `issued_by: "wot"` (a system marker, not a person). Coordinate the exact marker string with `backend-revoke-sanction-wot-membership` so both tasks agree.
- [ ] **Payload type updates (`types/hive.ts`).** Add `issued_by: string` to `AccreditAction`, `RevokeAction`, `RetractPaperAction`, `UpdateWeightsAction`, and the authorship actions (`claim_authorship` / `approve_authorship` / `revoke_authorship` shapes). Add the new `AdminGrantAction` / `AdminRevokeAction` interfaces (below) and union them into the authority-action union alongside `AccreditAction | RevokeAction | UpdateWeightsAction`.
- [ ] **Promotion / demotion endpoints.** `super_admin` promotes/demotes `admin`s; `root` promotes/demotes `super_admin`s. Each endpoint (a) emits an on-chain `admin_grant` / `admin_revoke` authority op signed by `pevo.admin` via `broadcastAdminCustomJson`, `issued_by` the acting human, then (b) upserts the `admins` table (set `revoked_at` on demote; insert/reactivate on promote). Broadcast-first-then-table or table-after-confirm ordering must leave the table reconstructable from chain.
- [ ] **Lockout guard.** Cannot demote `root`. Cannot demote the last avenue of control (e.g. removing the final `super_admin` such that no human can manage the roster) — reject with a clear, emdash-free error string. Root is always present via bootstrap config so this guard is about not orphaning `super_admin`-tier management.
- [ ] **`admin_grant` / `admin_revoke` wire format.** Define and document inline in `types/hive.ts`:
  - `AdminGrantAction`: `{ action: "admin_grant"; account: string; level: "admin" | "super_admin"; issued_by: string; timestamp: string }`
  - `AdminRevokeAction`: `{ action: "admin_revoke"; account: string; level: "admin" | "super_admin"; reason: string; issued_by: string; timestamp: string }`
  - Both signed by `pevo.admin`; `issued_by` is the acting `super_admin`/`root`. TENURE/ordering semantics read from CHAIN BLOCK TIME, not the payload `timestamp` (mirrors the accredit tenure convention) — the latest non-revoked grant per account is the live level.
- [ ] **Rebuild / backfill path.** The `admins` table is a runtime cache. Provide a rebuild routine (CLI script or admin-only endpoint) that scans `admin_grant` / `admin_revoke` ops (custom_json `id = config.appTag`, `required_posting_auths` contains `config.hiveAdminAccount`) in chain order and reconstructs the table. Anchor the read on the same singular-`?` JSONB containment pattern already used in `hafsql.ts` for admin-signed ops. Document it as the recovery path if the table is lost.
- [ ] **Tests.** Tier gating (a plain `admin` is rejected from roster management; a `super_admin` is rejected from demoting another `super_admin`; `update_weights` rejected for non-`root`); `issued_by` present and correct on each authority op payload (and the `"wot"` marker on WoT auto-grants); the on-chain `admin_grant` / `admin_revoke` audit trail is emitted on promote/demote and the rebuild routine reconstructs the table from those ops. For tests whose focus is NOT cryptographic verification, the `MOCK_VERIFY_SIGNATURE` fixture (`backend/tests/fixtures/mock-auth.ts`) is permitted under the CLAUDE.md carve-out with the required header acknowledgement; at least one real-path companion must exercise real `verifyHiveSignature` on a gated authority route so the re-auth invariant (§6.5 #1) is covered for real.

## Comment / doc cleanup (REVERSES nothing about the signer)

- [ ] Update the "admin account is singular by design" comment in `hafsql.ts` (the retracted-papers / admin-op JSONB containment fragment, near the `params: [config.appTag, config.hiveAdminAccount]` query — singular `?` not `?|`) to clarify the distinction: the *signer* (`pevo.admin`) stays singular by design; the *human admin roster* is a new, separate authorization layer in front of it. Do not anchor the new comment on line numbers — anchor on the stable function/query identity.
- [ ] Update the root `CLAUDE.md` "admin is singular by design" note (and the `project_admin_is_singular` memory if surfaced) to record: the SIGNER and `config.accreditationAuthorities` / `config.hiveAdminAccount` stay singular and un-widened; the new `admins` roster is the human-authorization layer and does NOT widen the on-chain signer. (Architect owns `CLAUDE.md` edits — file a note/TODO rather than editing it directly if the boundary blocks you.)

## Coordination

This task touches shared code with two sibling accreditation tasks:

- **Authority-op payloads (`issued_by` shape).** The `issued_by` field added here is shared with `backend-editable-accreditation-metadata` (accredit re-broadcast carries `issued_by`) and `backend-revoke-sanction-wot-membership` (the sanction/`type:"sanction"` payload carries `issued_by`; WoT auto-grant uses the `"wot"` system marker). Agree the field name (`issued_by`), the system-marker string for WoT, and the `types/hive.ts` shape with both tasks before landing so the `AccreditAction` / `RevokeAction` interfaces are edited once, not thrice. Whoever lands first defines the field; the others extend.
- **Sanction authorization.** The tier-authorization layer added here (plain `admin` may issue a sanction) is *consumed by* `backend-revoke-sanction-wot-membership` — that task implements the sanction semantics (`type:"sanction"` stickiness, the ever-sanctioned guard in `broadcastWotAccreditation`, live-threshold WoT membership); this task only gates *who* may trigger the authority-sanction op and stamps `issued_by`. Do not implement sanction stickiness or the WoT membership rewrite here.
- **`hafsql.ts` membership CTEs.** `activeAccreditationsCteBody` / `accreditationStatusCteBody` / `activeVouchesCteBody` are edited by BOTH `backend-editable-accreditation-metadata` (latest-vs-earliest accredit op, tenure anchor) and `backend-revoke-sanction-wot-membership` (sanction filtering + live-threshold). This task only touches the retracted-papers / admin-op containment comment and adds the `admin_grant`/`admin_revoke` rebuild query — coordinate CTE edits with those tasks to avoid clobbering, and prefer landing the rebuild read as a new fragment rather than editing the accreditation CTEs.

## Implementation notes

- Resolver order: `root` (bootstrap config) → latest non-revoked `admins` row for the caller → unauthorized. The lockout guard runs before broadcast on demote.
- Keep the table write idempotent against re-broadcast (a re-emitted `admin_grant` should not create a duplicate live row).
- All user-facing error strings (lockout, insufficient tier) must be emdash-free per project convention.
