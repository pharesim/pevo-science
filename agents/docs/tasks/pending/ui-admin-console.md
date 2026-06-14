# Admin Console (Roster Management & Authority Actions)

**Owner:** ui
**Created:** 2026-06-14

A gated admin console for accounts in the app-level `admins` roster. It surfaces two capability groups, each filtered by the viewer's tier (`admin` < `super_admin` < `root`) per the settled power matrix:

1. **Roster management** — promote/demote admins (super-admin+) and super-admins (root only).
2. **Authority actions** — the operational moderation ops that the single `pevo.admin` signer broadcasts on an admin's behalf: grant accreditation, sanction (with reason), retract a paper, revoke authorship, approve a bridged-paper author.

Every action routes through the backend, which is the only component holding the `pevo.admin` posting key (`broadcastAdminCustomJson`, `backend/src/hive.ts`). The console never signs an authority op itself; it only re-auths the request and lets the backend sign. The acting admin's Hive account is recorded as `issued_by` on each op payload by the backend — the console shows that attribution context to the operator before they confirm.

**Why:** The roster is the human-authorization layer in front of the single on-chain signer. Authority moderation today is reachable only by ad-hoc API calls / the bridge-account `isAdmin === config.hiveAdminAccount` check in `routes/claims.ts`; there is no operator surface for a multi-person admin roster, and no UI for the tier-gated power matrix. This console is that surface.

**Explicitly lean scope.** This is a minimal functional console, NOT a polished moderation dashboard. No analytics, no audit-log timeline view, no bulk operations, no search-and-filter over the roster, no rich previews. A list of roster members with tier badges, a small set of action forms, per-action re-auth, and clear success/error feedback. Polish is out of scope and should be deferred to a follow-up if requested.

## Acceptance criteria

- [ ] **Gated surface.** The console is reachable only by accounts present in the `admins` roster (or root). Non-roster accounts get no entry point and a direct-URL visit shows a not-authorized state (do not hard-redirect; mirror the unaccredited-banner convention — show, don't bounce). The viewer's tier is read from the backend roster/tier endpoint, never inferred client-side from a hardcoded list.
- [ ] **Tier-conditional rendering.** Controls render per the power matrix:
  - `admin`: all operational authority actions (grant accreditation, sanction, retract paper, revoke authorship, approve bridged-paper author). No roster controls.
  - `super_admin`: the above PLUS promote/demote `admin`.
  - `root`: the above PLUS promote/demote `super_admin`. (`update_weights` reputation governance is root-only but is NOT part of this console — out of scope here.)
  - The client gate is UX-only; the backend re-enforces every tier check. Do not treat the hidden control as the security boundary.
- [ ] **Roster management UI.** Render the roster (account, level, granted_by, granted_at). Super-admins can promote/demote admins; root can promote/demote super-admins. Calls the backend promotion/demotion endpoints (which broadcast `admin_grant` / `admin_revoke`). **Lockout-safe:**
  - Root is never demotable (root is bootstrap config, not a table row) — render no demote control against it.
  - The acting viewer cannot demote themselves out of the capability they're currently using (no self-lockout).
  - Surface the backend's authoritative rejection if the client guard is bypassed; never assume the client guard is sufficient.
- [ ] **Authority-action UI**, each as a small confirm-then-submit form:
  - **Grant accreditation** — target account + metadata (name/institution/field/method). Note: this is the same admin-signed `accredit` path used for edits (latest op is authoritative); a re-grant lifts a prior sanction per the lifecycle. Surface that consequence in the confirm copy when re-granting a sanctioned account.
  - **Sanction** — target account + required `reason`. Confirm copy must state that a sanction is STICKY: it suppresses accreditation regardless of vouch support and refuses the WoT auto-accreditation path until a later authority `accredit` lifts it.
  - **Retract paper** — target permlink/author + reason. Broadcasts `retract_paper` (`routes/papers.ts`).
  - **Revoke authorship** — target post + author slot. Broadcasts `revoke_authorship` (`routes/claims.ts`).
  - **Approve bridged-paper author** — approve an author on a bridge-account paper. Broadcasts `approve_authorship` (`routes/claims.ts`); this is the bridged-paper author-approval the matrix assigns to plain admins.
  - Each action displays the `issued_by` attribution (the acting admin's Hive account) in the confirm step so the operator sees what will be permanently attributed on chain.
- [ ] **Per-action fresh re-auth (§ 6.4), not JWT alone.** Roster mutations and every authority action are critical actions per § 6.5 invariant #1; the console must collect a fresh re-auth proof appropriate to the viewer's auth mechanism (password re-prompt for password accounts, fresh ORCID OAuth round-trip for ORCID-authed accounts, fresh Hive signature for self-custody) and pass it with the request — reuse the existing settings-page re-auth proof pattern (`settings.reauthFailed` flow in `frontend/src/pages/settings.js`) rather than inventing a new one. A JWT-only submit must be rejectable by the backend and the UI must surface that rejection.
- [ ] **i18n.** All operator-facing copy goes through the `$t(...)` translation layer (see existing `settings.*` keys). No em-dashes in user-facing strings (project convention).
- [ ] **Integration-verify after backend lands.** Build against the documented endpoint/payload contract; once `backend-admin-roster-and-authority-attribution` lands, integration-verify the real tier gate, roster endpoints, and `issued_by` attribution end-to-end.

## Dependencies

- **`backend-admin-roster-and-authority-attribution`** (blocking): provides the roster/tier read endpoint (the chain-derived `active_admins` read, Redis-cached — no persistent table), the promotion/demotion endpoints, the backend tier-enforcement middleware, and the `issued_by` attribution field on authority op payloads. This console cannot integration-verify until that lands — but the UI can be built against the documented contract in the interim.
- **`backend-revoke-sanction-wot-membership`** (blocking for the Sanction action specifically): defines the `type:"sanction"` revoke op and its sticky/self-healing semantics. The Sanction form's confirm copy and behavior must match that contract; do not ship the Sanction action's wording until the discriminator and stickiness rules are final.

If either backend contract is unavailable or ambiguous when this task is picked up, build the non-blocked surfaces (roster view, the authority actions whose ops already exist — retract/revoke-authorship/approve-authorship/accredit) and stub the Sanction action behind a documented TODO rather than guessing the payload shape.

## Coordination

This task shares no production source files with the backend tasks, but it consumes contracts that two backend tasks define concurrently — verify against the code, not against an in-flight task description:

- **`issued_by` attribution** is added to the authority-op payloads by BOTH `backend-revoke-sanction-wot-membership` (the revoke/sanction payload) and `backend-admin-roster-and-authority-attribution` (all authority payloads + the new `admin_grant`/`admin_revoke` ops). The console reads `issued_by` for display; confirm the final field name and that the acting-admin vs. `wot` system-marker distinction matches what the backend emits before wiring the attribution display.
- **Membership/tier reads.** The roster/tier endpoint this console gates on is defined by `backend-admin-roster-and-authority-attribution`. Separately, the accreditation-membership CTEs in `backend/src/hafsql.ts` (`activeAccreditationsCteBody`, `accreditationStatusCteBody`, `activeVouchesCteBody`) are being changed by BOTH the editable-metadata task (tenure anchor → earliest-op/block-time) and the revoke-sanction task (sticky sanction + live-threshold WoT). The console's accreditation-grant and sanction actions surface state derived from those CTEs; if this console shows any "accredited since" / membership-status context, read it from the backend's response, do not recompute it client-side, and integration-verify after both CTE-touching tasks land.
- **Sibling UI tasks.** The `ui-editable-accreditation-metadata` task adds a user-facing profile/accreditation metadata-edit form; coordinate so the admin console's grant-accreditation form and that user-facing metadata-edit form converge on the same admin-signed `accredit` request shape and the same § 6.4 re-auth helper, rather than duplicating two divergent forms.

## Implementation notes

- Likely a new page/store under `frontend/src/pages/` reached from an admin-only entry in settings or a dedicated route; keep it isolated from the normal accredited-user surfaces.
- Reuse the existing re-auth proof collection from `frontend/src/pages/settings.js` (the `settings.reauthFailed` paths around the email/password/seed flows) rather than authoring a parallel mechanism.
- Treat all tier gating as UX affordance only; the backend tier-enforcement middleware is the security boundary, and every form must render the backend's rejection cleanly.
- Keep forms minimal: target identifier + required reason/metadata + re-auth proof + confirm. No optimistic UI; reflect the broadcast result the backend returns.
