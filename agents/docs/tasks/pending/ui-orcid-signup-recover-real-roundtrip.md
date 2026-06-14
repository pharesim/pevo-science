# UI-ORCID-SIGNUP-RECOVER-REAL-ROUNDTRIP — drive the ORCID signup/recover E2E specs through a real backend round-trip

**Owner:** UI (owns `frontend/tests/e2e/`)
**Created:** 2026-06-09 (split out of ui-orcid-stub-real-roundtrip-unfixme)
**Priority:** P3

## Context

`ui-orcid-stub-real-roundtrip-unfixme` un-fixme'd the ORCID **fresh_auth /
set_password** real round-trip against the `orcid-stub` OAuth sidecar (see
`settings-orcid-factor.spec.js`'s third test). Two `test.fixme` blocks in
`frontend/tests/e2e/orcid-no-password.spec.js` remain, both driving the ORCID
**signup** mode:

- `ORCID signup with password: null creates an account with password_hash = NULL`
- `ORCID recovery with new_password: null preserves password_hash = NULL`

## Why the existing stub does not unblock them

The signup-mode backend handler (`handleSignup` in `backend/src/routes/orcid.ts`)
calls `countExternalWorks(orcidId, ...)`, which fetches from a hardcoded
`pub.orcid.org` works URL and gates on `config.orcidMinWorks`. The `orcid-stub`
sidecar in `docker-compose.test.override.yml` only serves `POST /oauth/token`
(reflecting the submitted `code` back as the `orcid` field). It does NOT serve
the `pub.orcid.org` works endpoint, so the signup-mode works-count gate cannot be
satisfied in-network. The fresh_auth/set_password round-trip does not hit that
endpoint, which is why it was un-fixme'able and these are not.

## What this needs

A second in-network stub for the ORCID works API (the `pub.orcid.org` works URL
`handleSignup` reads), wired so the backend reaches it in the compose network the
same way `ORCID_BASE_URL` points at `orcid-stub`. Then drive both specs:
- signup ORCID branch end-to-end -> real `/api/auth/signup` accepts `password:
  null` -> `accounts.password_hash IS NULL` -> password login 403
  `NO_PASSWORD_SET` -> ORCID login succeeds.
- recover ORCID branch with `new_password: null` -> `password_hash` unchanged.

Confirm whether the works fetch host is configurable (env) or hardcoded; if
hardcoded, the stub wiring will need a backend-side seam (coordinate with the
backend agent before changing route code — UI does not edit `backend/`).

## References

- `frontend/tests/e2e/orcid-no-password.spec.js` — the two `test.fixme` blocks.
- `backend/src/routes/orcid.ts` — `handleSignup` / `countExternalWorks`.
- `docker-compose.test.override.yml` — the `orcid-stub` token sidecar to mirror.
- Parent: `ui-orcid-stub-real-roundtrip-unfixme` (the fresh_auth/set_password half).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## [BLOCKED by Backend] (2026-06-09, UI)

Verified the open question in "What this needs": the ORCID works-count fetch
host is **hardcoded**, not env-configurable. `countExternalWorks` in
`backend/src/routes/orcid.ts` issues the works fetch with the host baked into
the template literal: `fetchWithOrcidTimeout(\`https://pub.orcid.org/v3.0/${orcidId}/works\`)`.
`config.orcidBaseUrl` (`ORCID_BASE_URL`, default `https://orcid.org`) controls
ONLY the OAuth host (`/oauth/authorize`, `/oauth/token`); it does not touch the
`pub.orcid.org` works API. So no compose-only wiring can redirect the works
fetch in-network, and a host-alias hack would also fail TLS (the URL is
`https://`). The fetch is server-side, so a Playwright `page.route` mock cannot
intercept it either. There is no UI-only path.

**What Backend must provide (the seam):** a config-driven works-API base, e.g.
`config.orcidApiBaseUrl` from a new `ORCID_API_BASE_URL` env (default
`https://pub.orcid.org`), and rebuild the URL in `countExternalWorks` from it
(`\`${config.orcidApiBaseUrl}/v3.0/${orcidId}/works\``). This is `backend/`
zone — UI cannot edit it.

**Layered downstream dependency (Architect zone) — re-check before returning to
pending/:** once the seam lands, `docker-compose.test.override.yml` (architect-
owned per `.githooks/commit-msg`) needs a second E2E sidecar serving the works
endpoint (`GET /v3.0/:orcidId/works`) returning a payload with at least
`ORCID_MIN_WORKS` externally-sourced works (a `group[]` whose
`work-summary[].source.source-orcid.path` differs from the profile orcid),
plus `ORCID_API_BASE_URL: http://<works-stub-host>:<port>` wired onto the
backend service. The existing `orcid-stub` only serves `/oauth/token` and
reflects the `code` back as the orcid iD; mirror that pattern. Whoever resolves
the Backend seam should re-tag this `[BLOCKED by Architect]` for the compose
stub rather than moving straight to pending/ (the seam alone does not unblock
the UI spec work).

**Then UI proceeds:** replace the two `test.fixme` blocks in
`frontend/tests/e2e/orcid-no-password.spec.js` with real bodies driving signup
(`password: null` -> `accounts.password_hash IS NULL` -> password login 403
`NO_PASSWORD_SET` -> ORCID login OK) and recover (`new_password: null` ->
`password_hash` unchanged), seeding the per-run `code`/orcid iD to satisfy the
works stub the same way `settings-orcid-factor.spec.js` drives the OAuth stub.

## [BLOCKED by Architect] (2026-06-11, Backend) — seam landed, re-tagged for the compose works stub

The Backend seam above is RESOLVED: `config.orcidApiBaseUrl` (env
`ORCID_API_BASE_URL`, default `https://pub.orcid.org`) now exists in
`backend/src/config.ts`, and `countExternalWorks` builds the works-fetch URL
from it. Default preserves production behavior and the existing test stubs'
`pub.orcid.org` URL matching (orcid + settings-email-fresh-auth suites green).

Re-tagged `[BLOCKED by Architect]` per this task's own layered-dependency
instruction (the seam alone does not unblock the UI spec work). What Architect
must provide before this returns to `pending/`:

- `docker-compose.test.override.yml`: a second E2E sidecar serving
  `GET /v3.0/:orcidId/works` with at least `ORCID_MIN_WORKS` externally-sourced
  works (a `group[]` whose `work-summary[].source.source-orcid.path` differs
  from the profile orcid), mirroring the existing `orcid-stub` pattern, plus
  `ORCID_API_BASE_URL: http://<works-stub-host>:<port>` wired onto the backend
  service.
- `.env.example` (root, architect-zone): optional `ORCID_API_BASE_URL` template
  line documenting the default (`https://pub.orcid.org`). Backend cannot edit
  files outside `backend/`.

Once the compose stub + wiring land, move this file back to `tasks/pending/`
for the UI to replace the two `test.fixme` blocks.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

## [Architect] (2026-06-14) — UNBLOCKED; compose works-stub + env landed, moved to pending/

Both architect-zone prerequisites above are in:

- **`docker-compose.test.override.yml`** gains an `orcid-works-stub` sidecar
  (node:20-alpine, port 8098, compose-network only) serving
  `GET /v3.0/<orcidId>/works` with **five externally-sourced works** (each
  `work-summary[].source.source-orcid.path` is a fixed constant distinct from the
  requested iD — with a fallback constant if a spec ever seeds that exact value
  as its profile — so every work counts as external). Five is a margin over
  `ORCID_MIN_WORKS` (default 3), so any seeded per-run iD clears the gate. The
  backend service now sets `ORCID_API_BASE_URL: http://orcid-works-stub:8098`
  and `depends_on` the new sidecar; `countExternalWorks` reads
  `<ORCID_API_BASE_URL>/v3.0/<orcidId>/works`. Verified: YAML parses, the inline
  script `node --check`s clean and carries no `$`, and a live request returns a
  payload `countExternalWorks` counts as 5 (gate PASS), including the
  profile==constant fallback case; a non-works path 404s.
- **`.env.example`** documents the optional `ORCID_API_BASE_URL` (default
  `https://pub.orcid.org`) in the ORCID block.

**UI proceeds:** replace the two `test.fixme` blocks in
`frontend/tests/e2e/orcid-no-password.spec.js` with real bodies — signup
(`password: null` -> `accounts.password_hash IS NULL` -> password login 403
`NO_PASSWORD_SET` -> ORCID login OK) and recover (`new_password: null` ->
`password_hash` unchanged) — seeding the per-run `code`/orcid iD the same way
`settings-orcid-factor.spec.js` drives the OAuth stub. The works stub serves any
iD, so no extra per-run seeding is needed for the works gate; just keep the
seeded profile iD different from the stub's `source-orcid` constants (it will be
— those are reserved `0000-0003-0000-000X` values).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

## [BLOCKED by Backend] (2026-06-14, UI) — signup half exposed a real backend bug; recover half DONE

Both `test.fixme` blocks were replaced with real round-trip bodies and run
against the test stack (orcid-stub + orcid-works-stub, `ORCID_API_BASE_URL`
wired). The shared OAuth-stub bridge was extracted to
`frontend/tests/e2e/fixtures/orcid.js` (now used by `settings-orcid-factor.spec.js`
too). Final run of the affected specs: **10 passed, 1 failed**.

**RECOVER spec — DONE, passing.** Seeds a finalized passwordless ORCID account,
drives the real `/api/orcid/start` -> authorize -> `/api/orcid/callback` round-trip,
submits real `/api/auth/recover` with `new_password: null`, asserts
`password_hash` stays NULL + email rotated + password login still 403
`NO_PASSWORD_SET`. (The read-only `/api/accreditations/<username>` status that
gates the ORCID method tab is HAF/on-chain, impractical to seed per-test, so it
is `page.route`-stubbed — same as the SEC-004 recover test; every recover hop
stays real.)

**SIGNUP spec — BLOCKED on a backend schema bug.** The signup ORCID round-trip
reaches a real `POST /api/auth/signup` carrying `password: null` (the SEC-004
frontend contract) and gets **400 VALIDATION_ERROR "Invalid request body"**.
Root cause: `SignupBodySchema` in `backend/src/routes/auth.ts` declares
`password: z.string().optional()`, which rejects `null` (Zod `.optional()`
accepts `string | undefined`, not `null`). The signup *handler* already treats
null as no-password (`hasPassword = !!(password && password.length > 0)`), and
the sibling recover schema already does the right thing:
`new_password: z.string().min(1).optional().nullable()` in
`backend/src/routes/recover.ts`. So ORCID signup currently 400s in production
before the handler runs.

Reproduced directly against the running backend:
- `{"...","password":null,"orcid_token":"fake"}` -> 400 VALIDATION_ERROR.
- same body with `password` omitted -> 200 (clears the schema).

**What Backend must do:** make `SignupBodySchema.password` accept null —
`password: z.string().optional().nullable()` (mirroring `recover.ts`
`new_password`). No handler change needed (the null path is already handled).
Then move this file back to `tasks/pending/`; the signup spec should pass
end-to-end (works gate -> `/api/auth/signup` 200 -> `password_hash` NULL ->
password login 403 `NO_PASSWORD_SET` -> finalized-account ORCID login). The
spec's only test-DB shim is a direct `UPDATE accounts SET username = ...` to
simulate the out-of-scope Hive-account-creation step that sets `username`
(handleLogin needs `username IS NOT NULL`); every backend hop is real.

UI work is committed; nothing further for UI until the schema accepts null.

**[RESOLVED by Backend 2026-06-14]** `SignupBodySchema.password` now accepts null
(`backend/src/routes/auth.ts`: `z.string().optional().nullable()`, committed), with
real-path coverage in `tests/routes/auth.test.ts` (`password: null` + `orcid_token`
-> 200, lands `password_hash IS NULL`). The signup `password: null` -> 400 is gone.
Moving back to `pending/` per rule #6 so UI can re-enable the signup half of
`frontend/tests/e2e/orcid-no-password.spec.js`. The older 06-09 seam / 06-11
compose-stub blockers were already resolved (works-stub + `ORCID_API_BASE_URL`
wired per the 06-14 note above); this schema fix was the sole remaining blocker.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## [UI] (2026-06-14) — VERIFIED end-to-end, both real round-trips green; moving to review/

Both `test.fixme` blocks were already real bodies (committed earlier); the signup
half was the only thing still blocked, on the backend schema bug now resolved. No
further spec edits were needed — the blocker was a backend rebuild away.

Ran `frontend/tests/e2e/orcid-no-password.spec.js` against the full test stack
(`./deploy.sh restart` to pick up the committed `auth.ts` null-password fix — the
running container predated it — then `test-db-up` + `test-up`, orcid-stub +
orcid-works-stub both up, `ORCID_API_BASE_URL` wired): **7/7 passed**, including:
- `real-backend ... ORCID signup with password: null creates an account with
  password_hash = NULL` (the previously-blocked spec) — PASS.
- `real-backend ... ORCID recovery with new_password: null preserves
  password_hash = NULL` — PASS.

Signup round-trip confirmed end-to-end: works gate -> `/api/auth/signup` 200 ->
`password_hash IS NULL` -> password login 403 `NO_PASSWORD_SET` -> finalized-account
ORCID login bounces to /papers. Dev routing restored (`./deploy.sh up`). No code
change in this move — verification only.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

---

## Architect re-review (2026-06-14) — HELD PENDING FIXES:

`/ce-code-review` on the implementing commit (the real round-trip bodies + the
`fixtures/orcid.js` extraction) came back strong: the signup and recover
round-trips are GENUINELY real (every `/api/orcid/start` -> `/orcid/callback` ->
`/api/auth/signup`|`/recover` -> `/api/auth/login` hop hits the real backend;
only network-topology bridges + two out-of-scope shims), the assertions verify
the real end state via real DB reads (`password_hash IS NULL`, 403
`NO_PASSWORD_SET`, ORCID login -> /papers), the tests have teeth (a regression
reintroducing password persistence fails the real-DB `toBeNull()` checks), and
the `fixtures/orcid.js` extraction is behavior-preserving for
`settings-orcid-factor.spec.js` (byte-identical bridge, three call sites
unchanged). Two P3 polish items before archive:

1. **Username-finalization shim comment understates the write.** The signup
   spec's test-DB shim comment says it finalizes "that one column" (username),
   but the `UPDATE accounts SET ...` actually sets THREE activation columns
   (`username`, `custody = 'light'`, `verify_token = NULL`). The UPDATE itself is
   CORRECT — it faithfully mirrors the real activation `UPDATE` in
   `backend/src/routes/signup-verify.ts` (after ORCID signup the row still has
   `verify_token = 'confirmed:<hex>'` and `custody` NULL, so both must be
   finalized for `handleLogin`'s `username IS NOT NULL` gate plus a consistent
   activated state). Only the comment is misleading. Reword it to name all three
   out-of-scope activation columns so the extra writes don't read as stray.

2. **Carve-out clause (a) wants the shim justification in the FILE HEADER.** The
   two real-backend-test shims — the `page.route` stub of the read-only
   `/api/accreditations/<username>` HAF status, and the direct `UPDATE accounts
   SET username...` test-DB seed — are documented inline at the call sites but
   not in the file header. Per root `CLAUDE.md` "Carve-out for deterministic
   edge-case coverage" clause (a), the justification belongs in the test file
   header; the sibling `settings-orcid-factor.spec.js` is the project precedent
   (it carries an explicit clause-a/b/c header block). Lift a short clause-(a)
   paragraph into this spec's header naming both shims (which real path each
   replaces and why it is impractical), and stating every HTTP hop stays real.
   The shims are legitimate and non-hollowing — this is a documentation-location
   fix, not a re-architecture.

Reviewed-and-dismissed (no action): a `"the SEC-004 recover test"` comment
reference (confidence 25, gate-suppressed) — it is a within-file behavioral
pointer that resolves to the in-file `SEC-004 Tester` literals, not an
archived-task redirect.

Both items are comment/header-doc only — no spec-logic change. When they land,
`git mv` this file back to `tasks/review/`; the move is the re-review signal. Do
not edit this block.
