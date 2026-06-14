# Editable Accreditation Metadata — Settings UI & First-Accreditation Tenure Anchor

**Owner:** ui
**Created:** 2026-06-14

Let accredited users edit their displayed metadata (full name, institution, field of research) from Settings, and source the "accredited since" display from the backend's first-accreditation tenure anchor so the displayed tenure does not drift when metadata is re-broadcast.

## Why

Per ARCHITECTURE.md § 2 ("Accreditation Lifecycle & Sanctions"), the `accredit` op is re-broadcastable: displayed METADATA (name/institution/field) reads from the LATEST accredit op so edits show, while TENURE ("accredited since") reads from the EARLIEST accredit op's chain block time. Today the frontend has no way to trigger a metadata edit post-accreditation, and every "accredited since" surface renders `accreditation.timestamp` — which is the LATEST op's timestamp and therefore rewrites itself on each re-broadcast. ORCID-accredited users currently land with empty institution/field and no way to fill them in. This task adds the Settings editor and repoints the tenure surfaces at the stable anchor.

## What / acceptance criteria

- [ ] **Settings editor for accredited users.** Add an editable-metadata section in `frontend/src/pages/settings.js` (alongside the existing ORCID, set-password, change-email, and custody-upgrade sections) with text inputs for full name / institution / field of research. Gate visibility on the user being accredited (`Alpine.store('auth').accreditation` present, mirroring how `currentOrcid` reads `Alpine.store('auth').accreditation?.orcid`).
- [ ] **Pre-fill with current values.** Initialize the inputs from the current accreditation (`accreditation.name`, `accreditation.institution`, `accreditation.field` as consumed in `accreditation.js` and `profile.js`). ORCID-accredited users whose institution/field are empty see empty inputs they can fill in for the first time via the same form — no separate code path.
- [ ] **Validation mirrors backend bounds.** Match `accreditationRequestSchema` in `backend/src/validation.ts`: full name 1–200, institution 1–200, field 1–100 chars (trim before length check). Disable Save when any field is empty or over-length; surface inline validation parallel to the existing set-password / change-email error handling.
- [ ] **Save calls the new backend edit endpoint via a new `api.js` method.** Add an `api.js` export (e.g. `submitAccreditationMetadata(values, freshAuthProof)`) shaped like the existing `submitEmail(email, freshAuthProof)` / `setPassword(password, freshAuthProof)` exports — it threads a fresh-auth proof and POSTs the merged `{ full_name, institution, field }` to the backend edit endpoint defined by the backend task.
- [ ] **Fresh re-auth, no user-signed op (works for both custody types).** The broadcast is admin-signed (the user does NOT sign the accredit op). The user only completes the endpoint's fresh re-auth proof per ARCHITECTURE.md § 6.4. Reuse the existing settings orchestrator: call `withSettingsFreshAuth(<action>, this._freshAuthCtx(), (proof) => submitAccreditationMetadata(values, proof))`, exactly as `handleEmailSubmit` does for `change_email`. This yields the correct behavior for free on both custody types — `_freshAuthCtx()` already gates whether a body proof is sent (light → password/ORCID proof on the JWT path; self-custody → per-request Keychain signature is already fresh). Handle the orchestrator outcome fields (`redirect`, `cancelled`, `sessionInconsistent`, `freshAuthFailed`) the same way the email/set-password handlers do, including `this.$t('settings.reauthFailed')` on `freshAuthFailed`.
- [ ] **Refresh local state after save.** On success, update `Alpine.store('auth').accreditation` (or re-fetch accreditation status) so the Settings inputs, profile, and accreditation pages reflect the new values without a full reload.
- [ ] **"Accredited since" sources the first-accreditation anchor.** Repoint both tenure surfaces off the rewritable `accreditation.timestamp` and onto the new stable anchor field the backend exposes (per the backend task: `accredited_since`, derived from the EARLIEST accredit op's chain block time):
  - `frontend/src/pages/accreditation.js` — the "Accredited" row currently renders `formatDate(accreditation.timestamp)`.
  - `frontend/src/pages/profile.js` — the `profile.accreditedVia` line currently renders `formatDate(profile.accreditation.timestamp)`.
  Use the new anchor field for the tenure/date display; leave `timestamp` (latest-op) only where a genuinely "last updated" semantic is wanted (none today — both current consumers mean tenure). Verify no other frontend surface reads `accreditation.timestamp` for a tenure meaning.
- [ ] **i18n.** Add the new labels/placeholders/messages (section heading, three field labels, save button, success/error strings, validation messages) to the locale files, following the `settings.*` and `accreditation.*` key conventions already used (`accreditation.fullName`, `accreditation.institution`, `accreditation.fieldOfResearch`, `settings.reauthFailed`, etc.).

## Dependency

Requires **backend-editable-accreditation-metadata** (the new admin-signed metadata-edit endpoint + the `accredited_since` first-accreditation anchor field on the accreditation status/profile responses). Build the UI against the ARCHITECTURE.md § 2 contract (latest-op metadata, earliest-op tenure) and the endpoint's fresh-auth re-auth contract (§ 6.4). Do not integration-verify until the backend lands; once it does, confirm end-to-end that (a) a metadata edit is admin-signed with no user signature, (b) the edit shows on profile/accreditation pages, and (c) "accredited since" stays fixed across an edit.

## Implementation notes

- The fresh-auth plumbing already exists: `withSettingsFreshAuth` (`frontend/src/lib/settings-fresh-auth.js`), `_freshAuthCtx()`, and the `api.js` proof-threading pattern (`submitEmail` / `setPassword` / `deleteEmail`). The new action just needs a distinct action name passed to the orchestrator (coordinate the exact string with the backend's expected fresh-auth `action`).
- Pre-fill source: the auth store already holds the current accreditation (`auth.js` `accreditation` field, persisted and restored), so the Settings page can read name/institution/field without an extra fetch on mount; fall back to re-fetch if the store is empty.
- Keep the editor section's markup/error-handling structure consistent with the set-password section (`data-testid` hooks, inline `x-show` error `<p>`, disabled-while-submitting button) so e2e selectors stay uniform.

## Coordination

The hafsql.ts membership CTEs and the accreditation status/profile response shape are shared code touched by sibling tasks:
- **backend-editable-accreditation-metadata** (the backend half of this task) owns the new edit endpoint and the `accredited_since` tenure anchor on the response — this UI task consumes that field and must not define its name/shape independently. Anchor the "accredited since" repoint on whatever field the backend task ships.
- The **revoke-sanction / live-threshold** task also touches the membership CTEs (`activeAccreditationsCteBody`, `accreditationStatusCteBody`, `activeVouchesCteBody` in `backend/src/hafsql.ts`) for sanction stickiness and live WoT threshold evaluation. Both that task and this one read accreditation status through the same response surface; coordinate so the `accredited_since` anchor and any sanction/method fields land without clobbering each other.
- The **admin-roster** task adds `issued_by` to authority-op payloads (including the `accredit` op this feature re-broadcasts). No frontend payload change here (the user does not sign the op), but be aware the admin-signed metadata edit's `accredit` op carries `issued_by:<admin>` set backend-side.

## [UI] (2026-06-14) — built against contract; integration-verify deferred (backend endpoint unlanded)

Built the full UI against the ARCHITECTURE.md § 2 contract (latest-op metadata,
earliest-op `accredited_since` tenure anchor) and the § 6.4 fresh-auth flow.
Landed:
- `frontend/src/api.js` — `submitAccreditationMetadata(values, freshAuthProof)`.
- `frontend/src/pages/settings.js` — editable-metadata section (gated on
  `isAccredited`), pre-fill from the auth store (one-shot, late-load `$watch`),
  client validation mirroring `accreditationRequestSchema` bounds, and
  `handleMetadataSubmit` routed through `withSettingsFreshAuth` exactly as
  `handleEmailSubmit`; optimistic auth-store refresh on success.
- Tenure repoint to `accredited_since` (fallback to latest-op `timestamp` until
  the backend exposes the field) in `accreditation.js` + `profile.js`; audited
  that no other frontend surface reads `accreditation.timestamp` as tenure.
- i18n: 12 `settings.metadata*` keys across all 16 locales + STUBS.md sweep.
- Unit tests: +12 in `pages-settings.test.js` (validation, prefill one-shot,
  submit plumbing + trim, optimistic refresh, freshAuthFailed/redirect/error).
  103/103 settings tests pass; profile/accreditation green; production build OK.

**Contract assumptions to verify when the backend lands** (UI consumes, does not
define API shape — these follow the backend task's documented shape):
- Endpoint/method `PATCH /api/accreditation/metadata`. (Backend task wrote the
  same as an "e.g."; the UI task's loose "POST/submitEmail-shaped" wording
  conflicts — backend owns the shape, so I matched the backend's.)
- Fresh-auth action string `edit_accreditation_metadata` (the union member the
  backend task names). Must be added to the backend's fresh-auth mint + edit
  endpoint and the orchestrator's JSDoc union.
- Tenure anchor field name `accredited_since`. The fallback keeps the date
  rendering correct until the field appears.

Integration-verify (real edit is admin-signed/no user signature; edit shows on
profile/accreditation; "accredited since" fixed across an edit) deferred per the
task until the backend half lands. Moving to review/.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Architect re-review (2026-06-14) — HELD PENDING FIXES

`/ce-code-review` on commit 65a9f938 (10 personas: correctness, security,
adversarial, testing, maintainability, project-standards, api-contract,
julik-frontend-races, reliability, + learnings). Verified clean: the fresh-auth
wiring (byte-for-byte the `handleEmailSubmit` pattern, distinct action string,
proof threaded, no JWT-only bypass), client validation (trim-before-empty, `<=`
boundary, UTF-16 consistent with the Zod schema), the synchronous double-submit
guard, the `x-text` (no-XSS) rendering, the optimistic-merge field carry-forward
(orcid/method/timestamp preserved), and i18n (12 keys × 16 locales, no emdashes,
STUBS swept). The "type-before-store-loads clobbers" race is structurally blocked
by the `x-if` gate (inputs do not exist until accredited).

**RESOLVED in this commit (architect) — contract ratified.** The cross-agent
contract this UI was built against is now pinned in ARCHITECTURE.md, so the
assumed names are no longer unilateral. Build the fixes below against these
canonical names:
- Tenure anchor response field: **`accredited_since`** (§ 2 "Tenure anchor").
- Endpoint / action / body: **`PATCH /api/accreditation/metadata`**, fresh-auth
  action **`edit_accreditation_metadata`**, body `{ full_name?, institution?,
  field? }` (§ 6.4 new row). Authorization is the owner's own current
  accreditation (self-service), admin-key-signed — not roster-gated.

**UI fixes required before archive:**
1. **(P2) Third tenure surface missed — `frontend/src/pages/researchers.js`.**
   The accredited-researchers directory card renders the accreditation date via
   `formatDate(r.timestamp)` (latest-op), so it was NOT repointed and the
   commit's "no other frontend surface reads accreditation.timestamp as tenure"
   audit is incomplete. Repoint to `formatDate(r.accredited_since || r.timestamp)`
   for parity with accreditation.js / profile.js. The `|| r.timestamp` fallback
   keeps current rendering correct until the directory endpoint exposes the anchor.
2. **(P2) Extract a shared `accredited_since` accessor.** The anchor is now read
   in three templates (accreditation.js, profile.js, researchers.js). Factor a
   single helper (e.g. `getAccreditedSince(acc)`) so the field name lives in one
   place — the silent `|| timestamp` fallback otherwise masks a rename across
   three files.
3. **(P2) Poll-clobbers-optimistic-write race (`settings.js`).** A background
   accreditation poll in flight when the optimistic store write lands can resolve
   with pre-edit values and revert the display on /profile and /accreditation.
   After a successful edit, bump the polling generation (or re-fetch / write from
   the response's canonical metadata) so the in-flight stale poll drops itself.
4. **(P2) Success toast fires when the store update is skipped (`settings.js`).**
   When `auth.accreditation` is null at success, the `if (auth.accreditation)`
   guard skips the refresh but the "saved" toast still shows — misleading success
   with stale display. Guard the toast on the update having happened.
5. **(P3) Tenure-fallback + outcome test coverage** (`pages-settings.test.js`
   plus accreditation/profile tests). Add a test asserting the rendered date
   reads `accredited_since` and FAILS if only `timestamp` is present (so a
   wrong-name backend landing breaks CI instead of shipping silently). Add the
   missing cases: `field` > 100 bound, `institution` > 200 bound, `cancelled` /
   `sessionInconsistent` outcomes, the null-accreditation success branch, and the
   `metadataSubmitting` reset on the non-error paths.
6. **(P3) Bind template `maxlength` to METADATA_MAX (`settings.js`).** The
   `maxlength="200"/"100"` attributes are hardcoded literals while the
   METADATA_MAX comment claims a bound change is "a one-line edit." Bind
   `:maxlength` to the constant, or drop the claim.
7. **(P3) De-rot the api.js comment.** Replace the deployment-state note
   ("integration-verify once the backend edit endpoint lands (the endpoint does
   not exist yet)") and the `§ 2` section-number cite with the behavioral
   invariant (latest-op metadata, earliest-op `accredited_since` tenure) so the
   comment survives the backend landing and a doc renumber.

Integration verification (real admin-signed edit, no user signature; edit shows
on profile / accreditation / researchers; "accredited since" fixed across an
edit) stays deferred until backend-editable-accreditation-metadata lands.

When fixes 1–7 are in, `git mv` this file back to `tasks/review/` for re-review
(scoped to the post-hold commits).

Note for the admin-roster task owner: this ratification also corrected
ARCHITECTURE.md § "Authorization enforcement" — the self-service metadata-edit
endpoint was wrongly listed among roster-gated admin authority actions; it is now
documented as owner-authorized (not roster-gated). Reconcile if
backend-admin-roster touches that endpoint.

## UI re-review signal (2026-06-14, working tree) — hold fixes 1–7 landed

All seven held fixes are in. Built against the ratified contract names
(`accredited_since`, `PATCH /api/accreditation/metadata`,
`edit_accreditation_metadata`); integration-verify still deferred until
backend-editable-accreditation-metadata lands.

1. **Third tenure surface repointed.** `researchers.js` directory card now renders
   `formatDate(getAccreditedSince(r))` instead of `formatDate(r.timestamp)`.
2. **Shared accessor extracted.** New `frontend/src/lib/accreditation-tenure.js`
   exports `getAccreditedSince(acc)` (prefers `accredited_since`, falls back to
   `timestamp`). All three surfaces (accreditation.js, profile.js, researchers.js)
   import it and expose it on their Alpine factory. Independently re-grepped the
   whole `frontend/src` tree: the only `.timestamp` read left is the accessor's
   own fallback — no fourth surface.
3. **Poll-clobbers-optimistic-write race fixed.** Moved the optimistic merge into
   a new `auth.applyAccreditationMetadata({name,institution,field})` that merges,
   bumps `_pollingGeneration` (so any in-flight `_checkAccreditation` drops itself
   at the stale-fetch guard), saves the session, and returns a bool. It does NOT
   re-fetch (HAF lags the broadcast). settings.js calls it instead of writing the
   store inline.
4. **Success toast guarded.** settings.js shows the "saved" toast only when
   `applyAccreditationMetadata` returns true (an edit with no current
   accreditation to merge into no longer shows a misleading success).
5. **Tests.** New `lib-accreditation-tenure.test.js` (prefers anchor / fallback /
   null). Tenure guards added to accreditation/profile/researchers tests:
   template-string assertions that FAIL if a surface reverts to a bare
   `*.timestamp`, plus factory-exposure identity checks. settings tests:
   `field`>100, `institution`>200, `cancelled`, `sessionInconsistent`,
   null-accreditation no-toast, and `metadataSubmitting` reset on the non-error
   paths; merge assertions repointed to `applyAccreditationMetadata`. auth tests:
   merge/preserve-tenure/generation-bump/persist/null-no-op.
6. **maxlength bound to the constant.** settings.js exposes `metadataMax`
   (= METADATA_MAX) and the three inputs bind `:maxlength` to it.
7. **api.js comment de-rotted.** Dropped the "endpoint does not exist yet"
   deployment-state note and the `§ 2` section cite; kept the behavioral
   invariant (latest-op metadata, earliest-op `accredited_since` tenure).

Verification: 6 affected unit files green (207 tests; settings 103→108) plus the
two sibling settings files (32 tests); `npm run build` OK. No new i18n strings
(no STUBS.md change).
