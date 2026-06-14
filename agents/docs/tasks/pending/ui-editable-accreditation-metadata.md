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
