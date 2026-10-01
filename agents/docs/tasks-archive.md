## The custody broadcast admits a light account's vouch and vouch retraction (archived 2026-10-01) — archived clean at 519e6597 on the first pass

### Architect archive note (2026-10-01)

Reviewed 519e6597 against its parent with /ce-code-review (correctness, security, adversarial
in-process, testing, project-standards on root CLAUDE.md, learnings): zero findings in the diff,
all nine requirements (Scope 1-4, AC 1-5) met. The testing lens re-ran the spec in a copy of
519e6597 (19 passed, exit 0) and six of the probe-table mutants (all killed); correctness traced
every probe row against head and base. Signer binding agrees with the read-side signer gate, and
vouch ops skip the gated-op scan, so they take the session-kind consume.

One pre-existing P2 surfaced (security and adversarial, independently): the read-side WoT count
admits a self-vouch from an accred_pinned account, so a WoT member one vouch short of threshold
can stay accredited. Filed as backend-wot-read-side-drops-self-vouch. The custody.md contract
update and the root CLAUDE.md "(comment, vote only)" line stay with the archive of
backend-custody-allowlist-comment-options, which is still pending and so archives later.

**Owner:** backend
**Created:** 2026-10-01

## Why

Light accounts are meant to vouch (user decision, 2026-10-01). They cannot today, at two layers:
the custody broadcast refuses the ops, and the profile page hides the forms. This task lifts the
backend layer; `ui-light-account-vouch` lifts the frontend one after it.

In `backend/src/routes/custody.ts`, the `custom_json` arm of `POST /api/custody/broadcast`
admits only the actions in its `allowedActions` list (`revote`, the three credit ops and the two
consent ops). A light account's `vouch` or `retract_vouch` gets 403 `FORBIDDEN`. That limit dates
from when light accounts were introduced and server-side signing covered comments and votes
only; nothing records a reason to keep vouches out.

Nothing else blocks the path. Both ops carry `required_posting_auths: [voucher]`
(`hive-schemas.md` § 2.5, § 2.6), so the stored posting key signs them. `POST /api/wot/vouch`
and `POST /api/wot/retract` already accept a JWT through `verifyHiveSignature` and check that the
voucher is accredited. Light accounts meet the accreditation criteria from signup
(`ARCHITECTURE.md` "Accredited-Only Data Policy").

## Scope

1. Add `vouch` and `retract_vouch` to `allowedActions` in the `custom_json` arm.
2. **Proof kind: the session window** (`ARCHITECTURE.md` § 6.4, the non-consent broadcast row,
   decided 2026-10-01). Do NOT add them to the consent or credit gated sets, and do not add a
   fresh-auth target for them. They go through the session-kind consume like a vote.
3. **Bind the payload to the signer.** For both actions, refuse with 403 `FORBIDDEN` unless
   the payload's `voucher` equals the authenticated username, as the `vote` arm does for
   `voter`. Refuse with 400 `VALIDATION_ERROR` when `vouchee` is not a non-empty string or
   equals the voucher (§ 2.5: a researcher cannot vouch for themselves). The read side already
   ignores a vouch whose signer is not its `voucher` (the signer gate in
   `activeVouchesCteBody`), so this binding is about the server not signing an op that is inert
   or that claims someone else, not about closing a forgery path.
4. Update the `allowedActions` refusal message, which lists the permitted actions.

## Out of scope

- The frontend gate (`ui-light-account-vouch`).
- `agents/docs/api-contracts/custody.md`. Its permitted-action list is already out of date, and
  the architect corrects it once, at the archive of `backend-custody-allowlist-comment-options`
  or of this task, whichever is later.
- The `revocation_outcome` values the frontend's retract handler branches on, which the
  `/api/wot/retract` route no longer returns. That is a separate frontend cleanup.

## Coordination

`backend-custody-allowlist-comment-options` (in `pending/` with a hold) also edits
`custody.ts`, in the `comment_options` arm and its own test file. This task touches only the
`custom_json` arm. Stage your own hunks only.

## Acceptance criteria

1. A light account's `vouch` and `retract_vouch` bundles, each with a valid session-kind
   proof, are broadcast (200), and without a proof they get 401 `FRESH_AUTH_REQUIRED`.
2. A `voucher` other than the signer is 403, and a missing, non-string or self `vouchee` is
   400. Each case is checked before the fresh-auth gate and asserts no broadcast.
3. An unknown `custom_json` action is still 403.
4. Each assertion is probed by reverting its own site; list probe and spec in the signal block.
5. New comments follow root `CLAUDE.md` "Comment anchors".

## Backend implementation signal (2026-10-01, commit 519e6597)

Landed in `519e6597` (verified: `git merge-base --is-ancestor 519e6597 main`).

- `backend/src/routes/custody.ts`, `custom_json` arm: `vouch` and `retract_vouch` added to
  `allowedActions` (the refusal message is built from the list, so it names both). For both
  actions, before the fresh-auth gate: `voucher !== username` is 403 `FORBIDDEN`
  (`<action> voucher must be '<user>'`), and a `vouchee` that is not a string, is empty, or
  equals the voucher is 400 `VALIDATION_ERROR` (`<action> vouchee must be a Hive username
  other than the voucher`). Not added to the consent or credit gated sets, and no fresh-auth
  target, so they take the session-kind consume like a vote.
- `backend/tests/routes/custody-vouch-ops.test.ts` (new, 19 specs, run per action): admit with a
  session proof (200, ops unchanged), second op in the same window (proof not spent), no proof
  (401 `FRESH_AUTH_REQUIRED`, reason `missing`), six pre-gate refusals (each sends no proof and
  asserts no broadcast), and an unknown action (`accredit`) still 403.
- Red before the route change: 19/19 failed. After: green, plus the six sibling custody test
  files (117 tests across 7 files). `npm run typecheck` and eslint clean.
- Wider regression: every test file that references the custody broadcast, `routes/custody`
  or `routes/wot` (33 files ran): 493 passed, 12 failed in 3 files (`idempotency-real-haf`,
  `accreditation-idempotency`, `accreditation`), exit 1. The same 3 files on a copy of
  `519e6597^` (before this change) fail 17 specs, which covers 11 of the 12. The twelfth
  (`findCustodyBroadcastByIdempotencyKey`, another-username scoping) is in the known-failing
  real-HAF file and tests the HAF SQL helper, not the route. None of the three reaches the
  `custom_json` arm.

Mutation probes (AC 4), each run on a scratchpad copy built from `519e6597`, against
`custody-vouch-ops.test.ts`; baseline 19/19 green:

| Probe (site reverted) | Killed by |
|---|---|
| drop `'vouch'` from `allowedActions` | all 9 `vouch` specs + the unknown-action message spec |
| drop `'retract_vouch'` from `allowedActions` | all 9 `retract_vouch` specs + the unknown-action message spec |
| voucher binding off | `a voucher other than the signer is 403`, `a missing voucher is 403` (both actions) |
| drop the `typeof vouchee` check | `a missing vouchee is 400`, `a non-string vouchee is 400` (both actions) |
| drop the empty-vouchee check | `an empty vouchee is 400` (both actions) |
| drop the self-vouchee check | `a self vouchee is 400` (both actions) |
| bind `vouch` only, not `retract_vouch` | all six `retract_vouch` refusal specs |
| route vouch ops through the per-op gate instead of the session window | `with a session-kind proof broadcasts the op unchanged`, `the session-kind proof is not spent...` (both actions) |

[TODO Architect] `agents/docs/api-contracts/custody.md` permitted-action list: add `vouch` and
`retract_vouch` (session-kind proof), and the two new refusals (403 voucher binding, 400 vouchee
shape), per this task's "Out of scope" note.

## The ORCID-factor e2e cache assertion compares five keys against a seven-key entry (archived 2026-10-01) — archived clean at 660f2703 on the first pass

### Architect archive note (2026-10-01)

Reviewed 660f2703 against its parent with /ce-code-review (correctness, testing,
project-standards on root CLAUDE.md, learnings; adversarial skipped, the diff is an ordinary
per-feature assertion): zero findings in the diff, zero malformed returns. Reviewers read the
reviewed commit, since 3c9f3b10 and 795f6df0 later edited the same spec. Verified: the writer
stores seven keys with authorIndex and claimer normalized to null, the stub echoes no credit
fields, and the backend /orcid/callback spreads author_index and claimer only when the target
binds them, so the new comment is true on the real path too. Scope 2 (three CONSENT_OP_KEY
read-backs, all in this file) was confirmed by three reviewers. AC 3 rests on the implementer's
run; e2e was not re-run.

One pre-existing P3 surfaced: the stubbed case's comment still points real verification at "the
test.fixme below", which has not existed since 66a46ec1. It is already Scope item 1 of the
pending ui-settings-orcid-factor-test-pointers task, so nothing new was filed.

**Owner:** ui
**Created:** 2026-09-14

Surfaced by the implementer of the consent-op eviction parity task as a residual,
deliberately not fixed there, and verified at architect review. Pre-existing and
independent of that change; this is not a hold on it.

## Why

In `tests/e2e/settings-orcid-factor.spec.js`, the stubbed-callback case reads the
consent-op slot back and asserts it with `toEqual` against a five-key object:
`token`, `expiresAt`, `action`, `rootAuthor`, `rootPermlink`. `cacheConsentOpProof`
has written seven keys since the credit-op extension, normalizing the two optional
fields to `authorIndex: null, claimer: null`. `toEqual` treats a missing key as equal
to `undefined` but not to `null`, so the assertion cannot pass. It fails on any e2e
run of that file and will be read as fallout from whatever landed last.

## Scope

1. Make the assertion match the writer's real shape. Preferred: add
   `authorIndex: null, claimer: null` to the expected object, so the spec keeps
   pinning the exact entry shape. Do not loosen to `toMatchObject`; that would stop
   catching an extra key.
2. Check the other e2e specs that read this slot back for the same five-key shape
   and fix any that share it.
3. A ui session has an untracked `tests/e2e/consent-op-fresh-auth.spec.js` in
   flight. If that work lands first and touches the same assertion, fold this fix
   into it and say so here; otherwise fix in place.

## Acceptance criteria

1. The stubbed-callback case in `settings-orcid-factor.spec.js` passes against the
   real writer.
2. No e2e spec asserts the consent-op entry with the five-key shape.
3. That e2e file is green under the E2E recipe in `agents/ui/CLAUDE.md`; any
   pre-existing failures elsewhere in the run are noted, not chased.

## UI implementation signal (2026-09-30, commit 660f2703)

- **Scope 1.** `660f2703` adds `authorIndex: null, claimer: null` to the expected
  object in the stubbed-callback case of `tests/e2e/settings-orcid-factor.spec.js`.
  The assertion stays `toEqual`, so an extra key still fails it.
- **Scope 2.** Re-enumerated from the code: `CONSENT_OP_KEY` is read back at three
  sites, all in that one file. The stubbed-callback case was the only five-key
  `toEqual`. The real-backend case uses `toMatchObject` on the triple plus a token
  type check (the token and deadline are backend-minted, so an exact match is not
  available there), and the mismatch case asserts `toBeNull`. No other e2e spec
  reads the slot.
- **Scope 3.** `tests/e2e/consent-op-fresh-auth.spec.js` has landed and does not
  read the slot, so there was nothing to fold into; fixed in place.
- **Verification.** Under the E2E recipe (restart, test-db-up, test-up):
  `npx playwright test tests/e2e/settings-orcid-factor.spec.js` ran 4 passed,
  exit 0. Only that file was run, so there are no elsewhere-failures to note. The
  pre-fix red was not re-observed in this session; it follows from `toEqual`
  not equating a missing key with `null`. Dev routing restored with
  `./deploy.sh up`.
- SHA self-verified: `git merge-base --is-ancestor 660f2703 main` exits 0.

## Make clause-(c) companion citations resolvable and check them (archived 2026-10-01) — eight review rounds, seven holds; archived clean at 486caedb

### Architect archive note (2026-10-01)

Reviewed 486caedb against its parent with /ce-code-review (correctness, project-standards on
root CLAUDE.md, testing, learnings; adversarial skipped, the diff is comment-only): zero
surviving findings, zero malformed returns. One correctness P3 (the re-split clause does not
name QUALIFIER's bounded reach) was suppressed at anchor 50. Every clause of the rewritten
space-run sentence was measured true by four reviewers and the architect independently: with
the emphasis-group `[\s-]{0,4}` reverted to `[\s-]*`, both dash shapes double per doubling
(about 140 ms at 400 to about 2.8 s at 6400) and the space shape stays near 0 ms through
100,000. The anchor gate finds zero hits on the added lines.

The deferred [TODO Architect] is discharged in a85669fb via /ce-compound-refresh: the
2026-09-14 backtracking entry (three lengths with the shortest sized against the costliest
regression, `<[a-z]{1,16}>`, the space-run lesson as work per character), the 2026-09-16
terminator entry (a linear curve is not a clean result), the clause-(c) entry (the ratchet as
landed, bounded rather than monotonic; the backticked citation form; the stale push and
"proposed" notes), and CONCEPTS.md's source-discipline canary entry.

Still open, recorded in the canary header and not filed: the NFKC micro-sign fold in the
mixed-script scan, a reverse declaration written in a file that itself mocks, and
`real path with a mocked companion here:` read as citation-shaped. The free-prose backlog
(103 files) and the file-less backlog (14 files) are the ratchet's deferred conversion work.

**Owner:** backend
**Created:** 2026-09-02

## Why

The test-mock carve-out permits targeted mocking only if, among other clauses,
clause (c) holds: the same risk class is covered by a real-path test elsewhere,
or a follow-up task is filed. The compliance artifact for that clause is a
sentence in the mocked test file's header naming the companion. It is free
prose. Nothing resolves the named file, and nothing checks that it asserts
anything in the claimed risk class.

Three headers have now been found citing companions that do not cover what they
were cited for, across two separate incidents. In one, a header named
`recover.test.ts` as the real-path `reissuedAt` companion and that file contains
zero `reissuedAt` assertions. In another, two headers named "the settings
password-reset suites" as the live `SESSION_INVALIDATED` companion when no
settings suite asserts that code at all. An earlier incident had a header naming
a companion that hoists `MOCK_VERIFY_SIGNATURE`, so it mocked the very surface
it was cited for covering.

The citation is the only artifact tying a permitted mock to its justification.
When it is false the carve-out is voided silently: the mock stays, the
justification evaporates, and nothing goes red. The existing guards do not see
it. The `no-stale-comment-anchors` canary scans only `backend/src`, and both it
and the `.githooks/pre-commit` gate match anchor SHAPES (slugs, ordinals, line
cites, archive redirects); a bare filename in prose is a legal shape under both.
