# BACKEND-PIN-SHARED-BROADCAST-VALUES — pin per-flavor evidence_hash + the real broadcastAdminCustomJson envelope so a future shared-value drift goes RED

**Owner:** Backend Agent
**Created:** 2026-06-09 (architect, from `/ce-code-review` triage of the broadcast-envelope cluster — folds finding #1 from `backend-broadcast-opts-derive-from-routeflavor` and finding #2 from `backend-admin-broadcast-helper-extraction`)
**Priority:** P2 (test-coverage gap on two high-stakes, currently-correct shared values; no live defect)

## Background

Two just-reviewed refactors each moved a load-bearing value into a shared constant/helper, but no test asserts that value *through the real code path*. The refactors are themselves behavior-clean (review byte-verified both as identical to the prior inline form). The gap is the regression net: a future hand-edit to either shared value would silently change runtime / on-chain behavior and pass the whole suite green. This is the `dedup-shared-constant-defeats-test-value-pin` class (`agents/docs/solutions/conventions/dedup-shared-constant-defeats-test-value-pin-2026-05-26.md`) — the independent value-pin must be a literal in the test, not the constant the production code reads.

## Goal

### F1 — per-flavor evidence_hash pin (signup-verify)

`ROUTE_FLAVOR_DERIVATION` (`backend/src/routes/signup-verify.ts`) is now the single source of the evidence-hash domain suffix (`confirm → 'signup'`, `link → 'link'`). The hash is `${account.email}:${username}:${evidenceSuffix}` and goes on-chain as the accreditation attestation's `evidence_hash` — irreversible. Every existing broadcast test `mockReject`s **before** the hash-computation branch runs, so the naive "fix" `'signup' → 'confirm'` would corrupt every on-chain signup `evidence_hash` and stay green.

Add, for **both** `/confirm` and `/link` (per-flavor — a one-route pin leaves the other suffix undefended):
1. Drive the broadcast path to completion (make the broadcast spy **resolve**, not reject), capture the broadcast op's `json`, and assert the decoded `evidence_hash` equals `sha256(`${account.email}:${username}:signup`)` for `/confirm` and `…:link` for `/link`.
2. A direct literal pin: assert the suffix is exactly `'signup'` / `'link'` and that the two differ. Pin the **literal strings** in the test (do not import `ROUTE_FLAVOR_DERIVATION` as the expected value, or the dedup defeats the pin).

### F2 — real broadcastAdminCustomJson envelope + throw pin (hive)

All call-site tests for the admin-broadcast helper mock `broadcastAdminCustomJson` and rebuild the envelope in-test, so a regression in the **real** helper's `required_posting_auths` / `id` / `required_auths` passes green, and the `AdminKeyNotConfiguredError` throw branch is never exercised.

Add to `backend/tests/hive-broadcast-timeout.test.ts` (the file already spies `hiveClient.broadcast.json` to exercise the real `broadcastJsonWithTimeout` body — same pattern):
1. Happy path — set a valid `config.pevoAdminPostingKey`, call the **real** `broadcastAdminCustomJson`, assert the spied broadcast op saw `id === config.appTag`, `required_auths === []`, `required_posting_auths === [config.hiveAdminAccount]`.
2. Unset-key path — set `config.pevoAdminPostingKey = ''`, assert the real helper throws `AdminKeyNotConfiguredError` and the broadcast spy was **not** called.

## Acceptance

1. **Mutation-kill F1:** reverting `confirm.evidenceSuffix` from `'signup'` to `'confirm'` (or `link` from `'link'`) turns an F1 test RED.
2. **Mutation-kill F2:** reverting the real helper's `required_posting_auths` to a wrong value turns the F2 happy-path test RED; removing the unset-key guard turns the F2 throw test RED.
3. Both pins are independent literals (no importing the production constant as the expected value).
4. **Carve-out (clause a):** F2's happy path may spy `hiveClient.broadcast.json` (hive-API client — carve-out-eligible) and set a valid WIF locally; the FOCUS is envelope shape, not crypto/auth, so no `MOCK_VERIFY_SIGNATURE` is involved (these are helper unit tests, not route tests). Document the spy in the test header per clause (a).
5. `npm run typecheck` (src + tests) + `npm run lint` clean; the signup-verify and hive-broadcast-timeout suites green.

## Out of scope

- The 502 `recoveryHint` body-text pin (pre-existing gap, never asserted before either; raise separately if wanted).
- Any behavior change to the refactors themselves — both are byte-verified correct; this is pins only.

## References

- `backend/src/routes/signup-verify.ts` — `ROUTE_FLAVOR_DERIVATION`, the `${account.email}:${username}:${evidenceSuffix}` hash construction inside `broadcastAccreditationAndSeed`.
- `backend/tests/routes/signup-verify.test.ts` — existing broadcast-rejection harnesses (the place to make the broadcast resolve for the hash pin).
- `backend/src/hive.ts` — `broadcastAdminCustomJson`, `AdminKeyNotConfiguredError`.
- `backend/tests/hive-broadcast-timeout.test.ts` — existing `hiveClient.broadcast.json` spy pattern for real-body assertions.
- `agents/docs/solutions/conventions/dedup-shared-constant-defeats-test-value-pin-2026-05-26.md`.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

---

## Backend completion note (2026-06-09, commit `c791654d`)

Both regression pins landed. Test-only, with one production change: `ROUTE_FLAVOR_DERIVATION` became a one-keyword `export` so the F1 literal pin can read the production map as the subject under test (no behavior change).

- **F1 (`signup-verify.test.ts`):** drives `/confirm` and `/link` broadcast to completion, decodes the captured op `json`, and asserts `evidence_hash === sha256(email:username:signup)` / `...:link`; plus a standalone literal pin of the two suffixes (`'signup'` / `'link'`, hard-coded, not imported). Reverting either suffix in the production map turns these RED.
- **F2 (`hive-broadcast-timeout.test.ts`):** calls the real `broadcastAdminCustomJson` into a spied `hiveClient.broadcast.json`, asserting `id === appTag`, `required_auths === []`, `required_posting_auths === [hiveAdminAccount]`; a second spec pins the `AdminKeyNotConfiguredError` throw on an unset key with the broadcast spy never called. Carve-out header documents the hive-API-client spy per clause (a).

**Verification (main checkout):** typecheck (src+tests) + lint clean; `signup-verify.test.ts` 14/14, `hive-broadcast-timeout.test.ts` 26/26 green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Architect re-review (2026-06-09) — HELD PENDING FIXES (1 item)

`/ce-code-review` fan-out on commit `c791654d` (correctness + security on Opus; testing, maintainability, project-standards, learnings on Sonnet; ce-agent-native skipped per PEvO). **The core deliverable is sound.** Both pins are byte-verified and genuinely mutation-killing — the correctness reviewer ran each spec live, applied the actual mutations, and confirmed each turns RED: reverting `confirm.evidenceSuffix`/`link` flips the F1 evidence-hash specs and the literal pin; a wrong `required_posting_auths` or a removed unset-key guard flips the F2 specs. Security confirmed the per-flavor `evidence_hash` domain separation (`sha256(email:username:signup|link)`) and the admin-broadcast authority shape (`required_posting_auths === [config.hiveAdminAccount]`, `required_auths === []`, active-key escalation would go RED). The carve-out clause (a) header in `hive-broadcast-timeout.test.ts` documents the `hiveClient.broadcast.json` spy; F1's literal pin reads `ROUTE_FLAVOR_DERIVATION` as the subject and asserts hard-coded literals (the dedup cannot defeat it). The one-keyword `export` is visibility-only.

**Dismissed at triage (not held):**
- *Boilerplate duplication* — `EVIDENCE_RUN_ID`/`EVIDENCE_SUFFIX` are a third copy of the module's `RUN_ID`/`SUFFIX` + `PII_RUN_ID`/`PII_SUFFIX` per-run-entropy idiom (maintainability, conf 65, below the gate). Discretionary; the username prefixes already prevent collisions. You may optionally collapse it to the module-level pair while addressing the held item below, but it is not required.
- *F2 unset-key spy has no mock implementation* (a guard regression would call through to real dhive — noisy, but still RED) and *`findAccreditOp` scans all broadcast calls* (the per-test mock-reset clears pollution — safe). Both theoretical-only.

### Item held (must fix before archive)

1. **(P3, learnings — `account-state-fixture-must-satisfy-all-dimensions`) The two new F1 evidence-hash fixtures seed an unreachable account state.** Both new `describe` blocks (the `/confirm` and `/link` evidence-hash specs) `INSERT` an `accounts` row with `email` SET, `verify_token = 'confirmed:<hex>'`, `password_hash = NULL`, **and** `orcid = NULL` (username/custody/upgraded_at left at defaults). A confirmed-signup-pending row is reachable only via the email path (which sets `password_hash`) or the ORCID path (which sets `orcid`); a row with neither identity anchor is not a reachable state. It passes today only because `/confirm` and `/link` do not gate on `password_hash`/`orcid` for the broadcast path, but the fixture-reachability convention applies regardless of which columns the route reads. This is the same class the sibling reissuedAt round-trip task was held on (its round-1 item 2), fixed there with a sentinel `password_hash`. Note the existing ORCID-path broadcast-rejection harnesses in this same file correctly seed `orcid` SET — the new specs deviated by needing `email` SET (for the hash) while dropping both anchors.

   **Fix:** seed a sentinel (non-NULL) `password_hash` in both new F1 fixtures, making each a reachable email-path signup-pending row (email set, password set, no ORCID, username/custody unset, `verify_token = 'confirmed:'`). The `evidence_hash` pins stay green — the hash is `sha256(email:username:suffix)`, independent of `password_hash`. Name the seeded state in the fixture comment by its dimension description (email-path signup-pending, password set, no ORCID) — NOT a `§ N.M` section anchor, per the comment-anchor convention.

When the fix lands, `git mv` this file back to `tasks/review/`; the move is the re-review signal (the next pass scopes to the fix commit only).
