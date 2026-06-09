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
