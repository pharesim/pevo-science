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

## [UI] (2026-06-14) — built non-blocked surfaces against contract; integration-verify deferred (backend endpoints unlanded)

Built the full console UI shell. The user opted into build-ahead despite the
backend being unlanded and the roster design having changed to chain-derived
this session. Landed:
- `frontend/src/pages/admin.js` (new) — `/admin` route, tier-gated rendering
  (admin < super_admin < root), not-authorized state (show, do not bounce),
  chain-derived roster list, promote/demote with lockout-safety (root never
  demotable, no self-demote, manageable-levels gate), and authority-action forms
  (grant accreditation, retract paper, revoke authorship, approve bridged-paper
  author). Each routes through a shared confirm panel that surfaces the
  `issued_by` attribution (the acting admin) before commit, then per-action fresh
  re-auth via the existing `withSettingsFreshAuth` orchestrator (§ 6.4).
- `frontend/src/api.js` — `/admin/*` client functions (documented as the
  admin-signed path, distinct from the self-service user-signed retract/revoke/
  approve routes).
- Route wiring: `router.js` (+`/admin` pattern + title) and `pages/index.js`.
- `settings.js` — a discoverability entry link gated on a silent best-effort
  tier probe (renders nothing, no log spam, until the roster endpoint lands).
- i18n: 51 `admin.*` keys + `settings.adminConsoleLink` across all 16 locales +
  STUBS.md sweep.
- Tests: `pages-admin.test.js` (19, covering tier gates, lockout-safety, load,
  validation, confirm staging, runConfirmed outcomes, sanitization). Full
  frontend suite green (1563); production build OK; `/ce-simplify` pass applied
  (custody-gated email fetch, JSDoc widen, form reset, comment trim).

**Sanction action: STUBBED** per the task — rendered disabled with a
"coming soon" badge, no API call. It depends on the `type:"sanction"` revoke op
+ sticky semantics that the revoke-sanction backend task defines; wiring it would
mean guessing the payload shape.

**Contract assumptions to reconcile when the backend lands** (UI consumes, does
not define — the backend owns final shapes; these are documented guesses):
- Roster/tier read: `GET /api/admin/roster` -> `{ tier, roster:[{account, level,
  granted_by, granted_at}] }`, `tier: null` when not in roster.
- Promote/demote: `POST /api/admin/roster/grant|revoke` `{ account, level }`.
- Authority actions: `POST /api/admin/accreditation/grant`,
  `/api/admin/papers/retract`, `/api/admin/authorship/revoke|approve`.
- Fresh-auth action strings: `admin_grant_role`, `admin_revoke_role`,
  `admin_grant_accreditation`, `admin_retract_paper`, `admin_revoke_authorship`,
  `admin_approve_authorship` (each target-bound to the acting admin's username).
  These need backend support in the fresh-auth mint + the edit endpoints.
- `issued_by` attribution: read from the backend response for display; confirm
  the field name + acting-admin-vs-system marker convention before relying on it.

Integration-verify (real tier gate, roster reads, promotion/demotion, the
authority broadcasts, and `issued_by`) deferred until the backend admin-roster
task lands. Moving to review/.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Architect re-review (2026-06-14) — HELD PENDING FIXES

Reviewed the build-ahead console (`ea48d8e0`) via `/ce-code-review` (correctness,
security, adversarial, api-contract, reliability, frontend-races, testing,
maintainability, project-standards, learnings) reconciled against the now-landed
backend (`routes/admin.ts`, `validation.ts`, `lib/fresh-auth.ts`,
`admin-roster.ts`). Contract reconciliation is otherwise clean — endpoint paths,
payload field names (`full_name` correct), all six `admin_*` fresh-auth action
strings, the tier/lockout matrix, the fresh-auth mint co-land, and `issued_by`
attribution all match. Security cleared the gate (per-action fresh proof,
per-actor target binding, server-attributed `issued_by`, no XSS). The items below
block archive.

**Required fixes:**

1. `method:'admin'` breaks every grant-accreditation. `requestGrantAccreditation`
   (`admin.js`) sends `method: 'admin'`, not in the backend enum
   `['manual','email','orcid']` (`adminAccreditationGrantSchema`) — the request
   422s before the handler. Send `'manual'` (or omit; backend defaults to
   `'manual'`). The unit test (`pages-admin.test.js`) asserts `method: 'admin'`,
   pinning the bug — fix the assertion in the same change so the suite would catch
   a regression.
2. Surface backend rejections instead of a blanket toast. `runConfirmed` and
   `loadRoster` map every non-fresh-auth error to the generic
   `admin.actionFailed`/`loadFailed` string. This is what hid fix #1 and would
   hide non-bridge-author (422), already-retracted (422), not-in-roster (422), and
   root-not-demotable (422). Render the backend `error.message`/`code` in
   `actionError`.
3. Gate the action forms while a confirm is staged/in-flight. The authority-action
   forms and the demote button render outside any `pendingConfirm`/`submitting`
   gate, and `_stageConfirm` does not early-return while busy, so a second submit
   overwrites `pendingConfirm` while the first `run` closure executes.
   Early-return from `_stageConfirm` when `submitting || pendingConfirm` is set
   (and/or add `submitting` to the form buttons' `:disabled`).
4. Don't swallow the post-success roster re-read. After a successful action,
   `runConfirmed` calls `loadRoster()` whose rejection lands in the action catch,
   leaving a stale roster with no indicator. Route a re-read failure to `loadError`
   so the roster panel shows its Try-again affordance.
5. Close the self-downgrade lockout via promote. `requestPromote` accepts any
   account incl. the viewer's own; a super_admin granting themselves `admin`
   self-downgrades out of roster controls (the self-lockout guard exists only on
   demote, in `canDemoteRow` and the backend revoke handler). Mirror the
   self-check in `requestPromote` and warn when the target already holds an
   equal-or-higher tier (a grant rewrites/downgrades them).
6. Add the missing tests. Three of five authority actions (retract, revoke,
   approve) have no confirm-staging or payload-pin tests, and the
   `cancelled`/`sessionInconsistent` `runConfirmed` branches plus
   `canSubmitRetract`/`canSubmitRevoke` are untested. Add staging + exact-payload
   assertions for the three actions (the payload-pin test is specifically what
   would have caught #1) and the missing outcome branches.
7. Drop the redundant `root` guard in `canDemoteRow`. The `member.level !== 'root'`
   clause is dead — `manageableLevels` never contains `root` — and contradicts the
   documented "root excluded via manageableLevels" model in-body.
8. Integration-verify (now unblocked). The backend admin-roster endpoints have
   landed. Run the deferred end-to-end verification: real tier gate
   (admin/super_admin/root + null), roster read, promote/demote, each authority
   broadcast, and `issued_by` attribution.

**Recommended (non-blocking — address in this pass or note for follow-up):**

- ORCID-factor form loss. The ORCID fresh-auth redirect wipes Alpine form state;
  the cached consent-op proof lets a re-entered action complete, but there is no
  resume/re-enter affordance, so an ORCID-factor admin must re-type the whole form
  after the round-trip. Preserve form state across the redirect or show a resume
  hint. Password-factor and self-custody admins are unaffected.
- `canSubmit*` stricter than contract. `canSubmitGrant` requires
  `institution`+`field` and `canSubmitApprove` requires `author_index`, all
  optional server-side; `adminRevokeAuthorship` sends no `reason` so the op records
  the default `'Revoked'`. Relax the getters to the contract, or keep as deliberate
  UX and leave a one-line note.
- Broadcast-timeout UX. A 504 `BROADCAST_TIMEOUT` shows as a definite failure;
  latest-op-wins makes a re-broadcast harmless on chain, but a distinct
  "uncertain — verify before retry" message avoids confusing the operator.

**Dismissed (no action):**

- Concurrent `loadRoster` (init + `$watch`): the `_mounted` guard plus the admin
  surface's low traffic make the last-write-wins window negligible; an in-flight
  boolean is optional polish, not required.
- Non-integer `approveAuthorIndex` and the demote `level` field the backend
  re-derives: the backend rejects/ignores them safely; no live breakage.
- Maintainability nits (`api.js` proof-spread dedup, settings/admin import
  coupling, repeated Tailwind input class, cross-module comment reference): out of
  scope for the deliberately-lean console.
- Pre-existing em-dashes in `router.js` `ROUTE_TITLES` (`settings`,
  `settings-verify-email`, `my-imports`): not introduced by this task; the new
  `admin` entry is compliant. Separate standards cleanup if desired.

Moving to `pending/` for the UI agent. Land the required fixes, then `git mv` back
to `review/` (the move is the re-review signal).

## Architect addendum (2026-06-14, from the backend-admin-roster review) — one additional held item:

The `/ce-code-review` of the now-landed backend `backend-admin-roster-and-authority-attribution`
surfaced one console gap not named in the hold above. (The `method:'admin'` enum break and the
self-downgrade-via-promote lockout are ALREADY covered above; this is a distinct third item,
user-triaged 2026-06-14.)

9. **(P2) Self-custody admins cannot satisfy the § 6.4 fresh-auth gate.** Every admin client
   function in `frontend/src/api.js` (`fetchAdminRoster`, `promoteAdmin`, `demoteAdmin`,
   `adminGrantAccreditation`, `adminRetractPaper`, `adminRevokeAuthorship`, `adminApproveAuthorship`)
   uses `authenticatedRequest` (Bearer JWT). The backend's `requireFreshAdminAuth` only treats the
   per-request Hive signature as a satisfied fresh-proof when `hiveAuthMethod === 'signature'`; a JWT
   request must carry a minted single-use proof. A self-custody (Keychain) admin therefore arrives as
   JWT, the console mints no proof for non-light custody, and the backend rejects with
   `FRESH_AUTH_REQUIRED`. This contradicts the per-action fresh-re-auth AC ("fresh Hive signature for
   self-custody"). Fix: for self-custody admins, route the admin mutations through the Hive-signature
   path (`signRequest`) so the backend sees `hiveAuthMethod === 'signature'` and the per-request
   signature satisfies the gate; OR, if the console is deliberately scoped to light / password+ORCID
   admins, enforce and document that and show a clear "self-custody admins sign with Keychain"
   affordance. The backend is correct (it accepts both the signature and JWT+proof paths) — the gap is
   the console always using JWT. Confirm this case under the existing integration-verify item.

Fold this into the same re-review cycle as the items above; `git mv` back to `review/` once all land.

## UI re-review signal (2026-06-14) — required fixes landed; item 8 operator-gated

All required fixes landed in the working tree (this commit). Adversarially re-verified
via a 4-reviewer workflow (correctness 1/2/7, gating 3/5, security 9, tests/i18n 4/6):
11/11 checks pass, 0 problems.

- **1. method enum.** `requestGrantAccreditation` (`admin.js`) sends `method:'manual'`
  (in the backend enum `['manual','email','orcid']`); the unit payload-pin assertion was
  updated to `'manual'`, so a regression re-fails.
- **2. surface backend rejections.** New `_errorMessage(err, fallbackKey)` wired into both
  `runConfirmed` and `loadRoster`: shows the structured backend `error.message` when an
  envelope `code` is present, an "uncertain, verify before retry" message on a 504
  `details.outcome:'uncertain'`, and the generic localized fallback for unstructured/
  transport errors (raw error stays in `console.warn`; the sanitization tests still pass).
- **3. gate while a confirm is staged/in-flight.** `_stageConfirm` early-returns when
  `submitting || pendingConfirm`; all five authority submit buttons + promote + the demote
  button carry `:disabled="… || pendingConfirm || submitting"`.
- **4. post-success re-read failure.** Verified `loadRoster` self-catches and routes a
  re-read failure to `loadError` (with Try-again); it never throws into the action catch,
  so the described swallow path was not reachable. Added a regression test pinning that a
  post-success reload 503 surfaces via `loadError`, not the (invisible) `actionError`.
- **5. self-downgrade via promote.** `requestPromote` refuses a self-promotion (toast
  `admin.cannotPromoteSelf`, no stage) and warns with `admin.confirmPromoteOverwrite` when
  the target already holds an equal-or-higher tier (a grant rewrites their level).
- **6. tests.** Added staging + exact-payload-pin tests for retract/revoke/approve, the
  `cancelled` and `sessionInconsistent` `runConfirmed` branches, and `canSubmitRetract`/
  `canSubmitRevoke`. The payload-pin tests are what catch item 1.
- **7. dead root guard.** Dropped `member.level !== 'root'` from `canDemoteRow` (root is
  excluded via `manageableLevels`); the "never demote root" test still passes.
- **9. self-custody fresh-auth.** New `adminMutation(path, body)` in `api.js` routes
  `custody==='light'` through `authenticatedRequest` (JWT + body `fresh_auth_proof`) and
  self-custody through `signRequest` (X-Hive-Signature, no Bearer, no body proof) so the
  backend sees `hiveAuthMethod==='signature'` and the per-request signature satisfies
  `requireFreshAdminAuth`. All six mutations route through it; `fetchAdminRoster` stays JWT.
  Added `api.test.js` dispatch tests (light → Bearer+proof; self → signed, no Bearer).

Recommended: broadcast-timeout "uncertain" message (done via the item-2 helper);
`canSubmitGrant` stricter-than-contract kept as deliberate operator UX with an in-code note.
ORCID-factor form-loss across the redirect NOT addressed — left as a follow-up (preserving
Alpine form state across a full-page OAuth round-trip is out of the lean-console scope).

i18n: 3 new keys (`cannotPromoteSelf`, `confirmPromoteOverwrite`, `broadcastUncertain`)
added to all 16 locales as English stubs; STUBS.md sweep `### Added 2026-06-14
(UI-ADMIN-CONSOLE)`. No em-dashes in user-facing strings.

Tests: `pages-admin` 33 green, `api` 46 green, full frontend unit suite 1598 green (the 3
unhandled rejections are pre-existing in untouched `pages-edit.test.js`). Production build OK.

**Item 8 (integration-verify) — OPERATOR-GATED, deferred.** The deployed backend image
404s on `/api/admin/roster` (predates the landed routes); a stack rebuild would carry the
sibling backend agent's uncommitted WIP, and each authority action broadcasts an
irreversible `custom_json` op to chain via the server-held `pevo.admin` key. A live run also
requires authenticating AS a roster admin (light JWT or self-custody Keychain), unavailable
headlessly. Per the user (2026-06-14): do not broadcast on chain from this session. Deferred
to an operator-driven session on a clean deploy with real admin credentials: real tier gate
(admin/super_admin/root + null), roster read, promote/demote, each authority broadcast,
`issued_by` attribution, and the self-custody signature path.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Architect re-review #2 (2026-06-14) — items 1-9 verified FIXED; ONE new HELD item

Re-reviewed the held-fix commit via `/ce-code-review` across 10 reviewers (correctness,
security, adversarial, julik-frontend-races, testing, maintainability, project-standards,
api-contract, reliability, learnings; `ce-agent-native-reviewer` skipped per root CLAUDE.md).

**Items 1-9 are all genuinely fixed (not papered over).** Highlights independently traced:
- Item 1: `method:'manual'` is in the backend `z.enum(['manual','email','orcid'])`; the
  payload-pin test asserts the exact value.
- Item 3: the double-submit window is closed — `_stageConfirm` early-returns on
  `submitting||pendingConfirm`, `runConfirmed` sets `submitting=true` synchronously before
  the first `await`, and all seven interactive surfaces carry the `:disabled` gate.
- Item 4: `loadRoster` is self-contained (own try/catch); a post-success reload failure
  routes to `loadError`, never the action catch. Confirmed not reachable as a swallow.
- Item 9 (security CLEARED): self-custody routes through `request()` with the per-request
  Hive signature and NO Bearer, so the backend sees `hiveAuthMethod==='signature'` and
  `requireFreshAdminAuth` is satisfied; light routes JWT + single-use body proof. The
  signature binds the correct `/api/...` path; `issued_by` is server-set and unspoofable;
  no XSS sink (all surfaces render via auto-escaped `x-text`). A stolen self-custody JWT
  alone cannot broadcast.
- Item 8 remains OPERATOR-GATED/deferred as documented above — not a hold. (The current
  `/api/admin/roster` 404 is a stale-image artifact: the route is defined, mounted, and
  committed in HEAD; the running container serves a pre-admin-routes bundle until a clean
  `./deploy.sh restart`.)

**Required fix (blocks archive):**

10. `_errorMessage` leaks an untranslated transport string instead of its localized
    fallback. `request()` synthesizes an `ApiRequestError` with `code:'INTERNAL_ERROR'` and
    `message:"Request failed with status N"` for any non-enveloped response (a bare
    404/502/proxy error). `_errorMessage`'s structured-error branch
    (`typeof err?.code === 'string' && err?.message`) then returns that raw English string,
    contradicting its own docstring promise to fall back to a generic localized string for
    unstructured/transport errors. Reachable now: while the backend image is stale and
    `/api/admin/roster` 404s, an admin's first screen shows "Request failed with status 404"
    rather than `admin.loadFailed`. Fix: exclude the synthetic transport code from the
    message-surfacing branch (treat `INTERNAL_ERROR` as unstructured so it falls through to
    the localized fallback), mirroring the `bridge.js` sibling that maps `INTERNAL_ERROR` to
    a localized key. Add a regression test that rejects with a synthetic `INTERNAL_ERROR`
    error and asserts the localized fallback (not the raw string) reaches `loadError`/
    `actionError`. Genuine backend errors carry their real codes (`NOT_FOUND`,
    `SERVICE_UNAVAILABLE`, …) with real messages, so this only narrows the synthetic
    fallback case.

**Recommended (non-blocking — fix in this pass or note for follow-up):**

- ORCID-factor proof target-rebind. The light+ORCID minted proof is bound to
  `(action, acting-admin, '')`, not the specific target. After the OAuth full-page round-trip
  wipes `pendingConfirm`, an operator who re-stages a DIFFERENT target of the SAME action
  gets a cache hit and completes against the new payload. Backend re-enforces tier (not an
  escalation), and ORCID form-loss is already an accepted follow-up — fold the rebind into
  the deferred item-8 verification.
- Case-sensitive self-promote guard: `requestPromote`'s `account === this.username` check
  runs on trimmed-but-not-lowercased free text; typing your own name with capitals bypasses
  the client guard (backend still rejects — Hive names are lowercase-only). One-char fix
  (`.toLowerCase()`) if you want it tight.

**Dismissed / informational (no action):**

- `adminMutation` self-custody `auth.username` lacks optional chaining (light branch uses
  `auth?.custody`) — unreachable behind the `isConnected` template gate.
- `/admin/roster/revoke` `level` is validated-but-unused (backend derives tier from chain) —
  no contract break.
- STUBS.md has two identical `### Added 2026-06-14 (UI-ADMIN-CONSOLE)` headings — not a rule
  violation; minor translator-confusion note.

Moving to `pending/` for the UI agent. Land item 10 (and optionally the two recommended
items), then `git mv` back to `review/` (the move is the re-review signal).

(Architect-owned, separate from this task: the solutions entry
`admin-account-locked-by-hive-create-claimed-account-semantics-2026-05-19.md` named its own
re-opening trigger — a non-root admin-elevation surface — which this roster work is. The code
correctly closes the gap via `requireFreshAdminAuth`, so this is solutions-store maintenance
to handle via `/ce-compound-refresh`, not a code defect.)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## UI re-review signal (2026-06-15) — item 10 landed; recommended self-promote casing landed; ORCID rebind + item 8 deferred

Required item 10 and the case-sensitive self-promote recommended item landed (this
commit). Full frontend unit suite green; production build OK.

- **10. INTERNAL_ERROR transport string no longer leaks.** `_errorMessage`
  (`admin.js`) now excludes the synthetic `INTERNAL_ERROR` code from its
  structured-message branch (`err.code !== 'INTERNAL_ERROR'`), so the
  `request()`-minted "Request failed with status N" string falls through to the
  localized fallback (`admin.loadFailed` / `admin.actionFailed`) instead of
  reaching the operator. This mirrors the `bridge.js` `handleLookup` mapping of
  `INTERNAL_ERROR` to a localized key. Genuine backend errors keep their real
  codes (`NOT_FOUND`, `VALIDATION_ERROR`, `SERVICE_UNAVAILABLE`, the
  `details.outcome:'uncertain'` 504) and still surface their messages. The
  docstring above the helper was updated to describe the synthetic-code exclusion.
  Two regression tests added (one per call site): a synthetic `INTERNAL_ERROR`
  rejection routed through `loadRoster` asserts `loadError === 'admin.loadFailed'`
  and `not.toContain('Request failed')`; the same through `runConfirmed` asserts
  `actionError === 'admin.actionFailed'`. The second is placed directly after the
  existing genuine-`VALIDATION_ERROR` test so the structured-vs-synthetic boundary
  is pinned by contrast.

- **(recommended) Case-sensitive self-promote guard closed.** `requestPromote`'s
  self-check now compares `account.toLowerCase() === this.username` (Hive names are
  lowercase-only; `this.username` is the canonical lowercase auth-store value), so
  an operator typing their own name with capitals is still refused client-side.
  One-char behavioral fix; a regression test (`promoteAccount = 'Alice'` vs viewer
  `alice`) pins it.

**Not addressed (deferred, per the architect's own framing):**
- ORCID-factor minted-proof target-rebind — the architect folded this into the
  deferred item-8 integration-verify; preserving Alpine form state across a
  full-page OAuth round-trip remains out of the lean-console scope.
- Item 8 (integration-verify) stays OPERATOR-GATED/deferred as documented in the
  prior signal: a live run broadcasts irreversible `custom_json` ops via the
  server-held `pevo.admin` key and requires authenticating as a roster admin on a
  clean deploy, unavailable headlessly. No on-chain broadcast from this session
  (per the user, 2026-06-14).

No new i18n keys (item 10 reuses `admin.loadFailed`/`admin.actionFailed`; the
self-promote fix reuses `admin.cannotPromoteSelf`), so no STUBS.md sweep. No
em-dashes in user-facing strings.

Tests: `pages-admin` 36 green (33 prior + 3 new), full frontend unit suite 1601
green (the 3 unhandled rejections are pre-existing in untouched
`pages-edit.test.js`). Production build OK.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Architect addendum (2026-06-15) — one recommended item to settle at re-review

Surfaced during the 2026-06-15 `/ce-compound-refresh` of the `frontend-error-sanitization`
convention (which ran clean otherwise). Tracking it here so it is not lost; it does NOT block
archive on its own.

- (recommended, non-blocking) **Reconcile `_errorMessage`'s genuine-backend-`err.message`
  passthrough with the `frontend-error-sanitization` convention.** That convention forbids
  surfacing raw `err.message` to a DOM-bound field (it prescribes `err.code`-driven localized
  keys), and its acceptance grep (`= err.message` / `err.message ||`) does NOT catch the
  `return err.message` form `_errorMessage` uses, so the divergence is invisible to the gate.
  The item-10 fix landed this cycle (excluding the synthetic `INTERNAL_ERROR` code) removes the
  clearest leak, but `_errorMessage` still returns genuine backend messages (`NOT_FOUND`,
  `VALIDATION_ERROR`, `SERVICE_UNAVAILABLE`) to the operator. The security/standards reviewers
  accepted that as deliberate operator UX (admin-route messages are developer-controlled and
  render via auto-escaped `x-text`) — but that is the "safe today" reasoning the convention
  rejects. Resolution is an architect call at re-review: either the convention gains a
  documented structured-operator-error-passthrough carve-out, or the admin code maps codes to
  localized keys. Flag and settle; do not silently diverge.

Note: the UI agent has already moved this task back to `review/` with item 10 and the
case-insensitive self-promote guard landed (the re-review signal above). A re-review of that
commit is now pending; this addendum item folds into that pass.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
