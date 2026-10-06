# The profile authority-filter specs pin a query the route stopped running in June, so nothing pins the profile gate

**Owner:** backend
**Created:** 2026-10-06
**Priority:** normal

Filed at the user's request after a root-cause pass on 2026-10-06. Each of the seven backend files
that fail when run alone on clean main was diagnosed by one agent and re-checked by a second; the
failing spec sets were identical at 342f2820 and 74488ad5. This file fails 3/3. Priority is normal,
not low: it is the route-level pin on a security gate, and since 11039c47 it has pinned nothing, so
a regression of the profile authority filter would have hidden inside a file already known red.

## Why

`backend/tests/routes/profile-auth-bypass.test.ts` mocks `getPool()` and checks that
`GET /api/profile/:username` takes accreditation only from authority-signed ops. The file is
byte-identical to its state at `11039c47~1` (last touched by 1ab97151).

11039c47 "backend(accreditation): reclassify revoke as sticky sanction; live-threshold WoT
membership" rewrote `getAccreditationFromHaf` in `backend/src/routes/profile.ts`. The inline query
(`'account' = $1`, `required_posting_auths ?| $3::text[]`, params `[username, appTag,
authorities]`, `ORDER BY ... LIMIT 1`, then a JS `payload.action === 'revoke'` branch returning
null) became a read of the shared membership CTE. 4cb51286 and ad831073 later added the tenure
anchor. At HEAD the read is
`buildWith(1, activeAccreditationsCteBody, (idx) => firstAccreditedAnchorCteBody(idx, username))`
followed by `SELECT ... FROM active_accreditations aa LEFT JOIN first_accredited_at fa ...
WHERE aa.account = $6`. Params are `[appTag, authorities, appTag, authorities, username,
username]` (from the code, and captured from the real route). The gate on the accredit/revoke scan
(`accred_ranked` in `activeAccreditationsCteBody`) is `?| $2::text[]`. The same text also sits on
the `update_params` scan (`aa_params_latest`), and the tenure anchor (`first_accredit_block`)
gates on `?| $4::text[]`.

All three specs pass at `11039c47~1` and fail at 11039c47 (measured by bisect). All three are test
drift:

1. "rejects a self-broadcast fake accredit (is_accredited:false, accreditation:null)". The mock
   guard needs `'account' = $1`, which the new SQL lacks. The response assertions still pass on
   the fall-through `{ rows: [] }`. The spec fails at the call-shape matcher
   `stringContaining('required_posting_auths ?| $3::text[]')`. Its positional pin reads params[2],
   which is now the app tag.
2. "accepts an authority-signed accredit (is_accredited:true, accreditation payload)". The guard
   misses, so the mock returns no rows and the route answers `is_accredited: false`
   (`expected false to be true`). The mocked row is also stale. It carries a `json` payload, but
   the route now maps column-shaped rows (`researcher_name`, `institution`, `field`, `method`,
   `orcid`, `event_timestamp`, `event_id`, `accredited_since`). The matcher and pin have the same
   drift as spec 1.
3. "treats a revoke row as unaccredited (is_accredited:false, accreditation:null)". It targets the
   JS revoke branch, which 11039c47 deleted on purpose. Revokes are now decided in SQL, and only a
   `type: "sanction"` revoke suppresses (ARCHITECTURE.md "Legacy revokes", "Sanctions are
   sticky"). The spec's mocked revoke has no `type`, so behind an authority accredit production
   would report the account accredited. Its comment cites `profile.ts:51` and
   `accreditations-revoke.test.ts`, which 11039c47 deleted (it added
   `accreditations-status-route.test.ts`).

**The protected behavior holds (measured).** Two independent probes drove the real
`GET /api/profile/:username` route and the real production SQL on local Postgres. Only the HAF
custom_json view and blocks table were redirected to synthetic VALUES CTEs (the `hafsql.test.ts`
precedent). The results:
- An accredit signed by the victim, one signed by a third party, and one with empty auths each
  gave `is_accredited: false, accreditation: null`.
- An authority accredit followed by a victim-signed overwrite kept the authority's metadata and
  tx_id.
- A self-signed `wot` accredit with three accredited vouchers was false.
- An authority sanction gave false, and a sanction signed by a non-authority was ignored.
- A forged `update_params` threshold of 1 was ignored.
- A forged accredit at an earlier block did not backdate `accredited_since`.

Dropping the `accred_ranked` gate flipped the forged cases to true with the attacker's name and
ORCID, so the probes were not vacuous.

**A naive fix passes vacuously.**
- On the accredited path the route also runs `getProfileStats`, whose query composes the same
  gated CTE (authorities at `$2`) and binds the username. A route-local mutant that strips only
  the `accred_ranked` gate inside `getAccreditationFromHaf` still satisfies
  `toHaveBeenCalledWith(stringMatching(gate), arrayContaining([user, authorities]))` (measured).
  Only an assertion on the accreditation read's own call catches it.
- A bare `?| $2::text[]` matcher survives a dropped `accred_ranked` gate, because
  `aa_params_latest` carries the same text (from the code).

## Scope

Test-only, in `backend/tests/routes/profile-auth-bypass.test.ts`. A draft of this shape passed 2/2
at HEAD with eslint clean (measured). The exact matcher text is the implementer's to confirm.

1. Mock guard and call lookup: `sql.includes('FROM active_accreditations aa')`. Among the queries
   `GET /api/profile/:username` sends to `getPool()`, only `getAccreditationFromHaf`'s contains it
   (from the code; `getReputationScore` reads Redis, which this file mocks to null).
2. Gate matcher, scoped to the accredit/revoke scan, for example
   `/'action' IN \('accredit', 'revoke'\)\s+AND cj\.required_posting_auths \?\| \$2::text\[\]/`.
   Use it in `toHaveBeenCalledWith(expect.stringMatching(...), ...)`, and also in a `toMatch` on
   the call found in item 1. That scoped `toMatch` is the assertion that catches the route-local
   mutant, so any simplification must keep it.
3. Positional pin: `params[1]` (the `$2` bind) `toEqual(config.accreditationAuthorities)`, read
   from the call found in item 1. Today the pin reads `params[2]`.
4. Positive spec: return a column-shaped row, for example `{ researcher_name: 'Real Scientist',
   institution: 'MIT', field: 'Physics', method: 'email', orcid: '0000-0001-2222-3333',
   event_timestamp: '2026-01-01T00:00:00.000Z', event_id: 42, accredited_since: null }`. The
   existing `toMatchObject` (including `tx_id: '42'`) then holds unchanged.
5. Delete "treats a revoke row as unaccredited". The route has no revoke branch left. A mocked
   pool cannot evaluate the SQL sanction rule, and an empty result is spec 1 again.
6. Header and comments. The header's own (a)/(b)/(c) list is the spec's assertion list. Its (b)
   becomes params[1] / `$2`. The header names no real-path companion today, which the root
   CLAUDE.md carve-out (c) asks for. Add one structured citation line per companion, in the form `backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts` checks: `Real-path companion: `backend/tests/<dir>/<name>.test.ts` [TOKEN]`, with a token that is a whole word in the companion's code (for example `activeAccreditationsCteBody`, which both companions call; the implementer confirms). This file is outside that canary's landing snapshot, so a labelled free-prose claim turns it red (from the code, not run). The diagnosis draft's one-sentence "Real-path companions:" is such a claim. Prose left beside the citations must not name a test file. The companions:
   - `backend/tests/routes/reputation-orcid-auto-accept-authority-gate.test.ts`, which runs the production
     `activeAccreditationsCteBody` on real Postgres with synthetic rows and shows a self-signed
     accredit is dropped;
   - `backend/tests/accreditation-membership-cte.test.ts`, which covers sanctions and legacy revokes the
     same way.

   Both were green in the 2026-10-06 full-suite run. Keep the existing justification and the
   statement that `verifyHiveSignature` is untouched because the endpoint is unauthenticated. Fix
   the in-spec comments that still say `$3` or params[2].

## Acceptance criteria

1. The file has two specs, green at HEAD by exit code and the Errors line.
   "treats a revoke row as unaccredited" is gone.
2. Both specs find the accreditation read by `FROM active_accreditations aa`. On that call they
   assert the scoped gate matcher and pin `params[1]` to `config.accreditationAuthorities`.
3. The signal block carries mutation evidence from a scratch copy, one mutant at a time, each
   reverted. Each mutant turns both specs red:
   - M1: drop `AND cj.required_posting_auths ?| ...` from `accred_ranked` in
     `activeAccreditationsCteBody`;
   - M2: `getAccreditationFromHaf` binds something other than the authorities at `$2` (for example
     the username);
   - M3: `getAccreditationFromHaf` reads an inline accredit query with no authority gate;
   - M4: `getAccreditationFromHaf` strips only the `accred_ranked` gate from `cte.sql` (for
     example with `cte.sql.replace(...)`), leaving `getProfileStats` gated. This is the
     vacuous-pass check.
4. No comment in the file cites `$3`, params[2], `profile.ts:51` or
   `accreditations-revoke.test.ts`. The header names the two real-path companions.
5. No change under `backend/src/`. tsc and eslint are clean, and `backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts` passes with no ledger edit. The pre-commit anchor gate passes
   without `anchor-allow` or `PEVO_ANCHOR_GATE=off`.

## Notes

- Overlap. No open task fixes this file. `backend-state-g-unverified-row-lifecycle` names it only
  in its signal block's list of the known clean-main red bar. These open tasks edit or audit
  `activeAccreditationsCteBody`, whose `accred_ranked` WHERE text the gate matcher reads:
  - `backend-accreditation-release-op` adds a release predicate;
  - `backend-wot-read-side-drops-self-vouch` edits `aa_vouch_ranked`;
  - `architect-audit-hafsql-and-chain-walkers` audits it.

  Whichever lands after this task re-runs this file.
- The gate matcher follows the order of `accred_ranked`'s conjuncts (action filter, then gate). A
  cosmetic reorder would turn it red with no real defect, but it cannot pass a dropped gate.
- Not proposed:
  - Route-level sanction or legacy-revoke specs. Those rules are SQL-level and pinned on real
    Postgres by `accreditation-membership-cte.test.ts`.
  - A forged-row pin on the tenure anchor's own gate (`first_accredit_block`, `?| $4::text[]`).
    No test pins it at any level. It holds today (measured: a self-signed accredit at an earlier
    block did not move `accredited_since`), and a drop would affect only the displayed tenure.
- Doc follow-up for the architect: `agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md`
  still describes this file's earlier pins (`$4`, params[3]). Refresh it at the next
  `/ce-compound-refresh` if wanted.
- Residual outside this file, from the code, comment-only, same root commit. Two test docblocks
  still describe `getAccreditationFromHaf` as an inline latest-wins accredit/revoke read:
  - the "Scope note" in `tests/window-cte-deterministic-tiebreaker.test.ts`;
  - `tests/eslint/no-accred-state-read-missing-id-tiebreaker.test.ts`, which calls its
    `getAccreditationFromHafLiteral` fixture (an inline `?| $3`, `LIMIT 1` read) "the REAL
    getAccreditationFromHaf literal".

  Since 11039c47 the function composes the CTE and has no `ORDER BY` or `LIMIT 1` of its own. Not
  in scope here; for the architect to triage.
- Once this file is green, drop it from any "known red bar" lists used in verification notes.
