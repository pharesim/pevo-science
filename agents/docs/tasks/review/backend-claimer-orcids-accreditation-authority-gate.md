# BACKEND-CLAIMER-ORCIDS-ACCREDITATION-AUTHORITY-GATE — gate the reputation-cycle ORCID auto-accept on the accreditation authority signer

**Owner:** backend
**Created:** 2026-05-26 (architect, surfaced by `/ce-code-review` adversarial during the `backend-orcid-trim-parity` round-3 re-review; verified at the code level by the architect)
**Priority:** P1 (reputation integrity)

## Problem

The reputation cycle's authorship-claim auto-accept reads accreditation-attested ORCIDs from a CTE that does **not** verify the accreditation op was signed by the platform authority. The `claimer_orcids` CTE in `reputation.ts` (`computeReputationBatch`) is:

```sql
claimer_orcids AS (
  SELECT
    cj.json::jsonb ->> 'account' AS account,
    cj.json::jsonb ->> 'orcid'   AS orcid,
    ROW_NUMBER() OVER (PARTITION BY cj.json::jsonb ->> 'account' ORDER BY cj.block_num DESC) AS rn
  FROM <custom_json> cj
  WHERE cj.custom_id = $3
    AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
    AND cj.block_num >= $7
)
```

It filters only on `custom_id`, `action`, and `block_num` — `account` and `orcid` are read straight from the broadcaster-controlled JSON payload, with **no `required_posting_auths` gate**. Contrast the canonical accreditation read `activeAccreditationsCteBody` (`hafsql.ts`), which gates on `cj.required_posting_auths ?| $::text[]` against `config.accreditationAuthorities` — i.e. an `accredit`/`revoke` op is only trusted when signed by the platform authority.

**Core principle (ratified):** a user must never be able to send a *valid* accreditation op. Accreditation/attestation is only valid when signed by an accreditation authority. `claimer_orcids` violates this.

### Exploit (verified reachable at the code level)

1. Attacker is already accredited (required to enter `target_users` and to satisfy `accepted_claims`'s `ce.claimer IN target_users` and the `co.account = ce.claimer` join).
2. Attacker reads a target paper's public on-chain `pevo.authors[i].orcid = V`.
3. Attacker self-broadcasts `custom_json { id: <appTag>, json: { action: 'accredit', account: <self>, orcid: V } }` signed with their **own** posting key (not the authority). `activeAccreditationsCteBody` correctly drops it (authority gate), but `claimer_orcids` accepts it — and because it is the most recent block for `<self>`, it wins `rn = 1`, overriding the attacker's real attested ORCID with `V`.
4. Attacker broadcasts `claim_authorship(target_author, target_permlink, author_index = i)`.
5. The `accepted_claims` ORCID auto-accept arm matches (`co.account = <self>`, `co.orcid = V`, `BTRIM(authors[i].orcid) = V`) → claim auto-accepted → attacker accrues co-author reputation credit on a paper they did not author, re-applying every cycle.

The ORCID arm is the bypassable path: the hive-username arm requires `authors[i].hive = ce.claimer` (which the attacker cannot forge on a victim's paper), but the ORCID arm lets the attacker self-attest any ORCID and match any paper listing it.

This is **pre-existing** (predates the `backend-orcid-trim-parity` BTRIM widening; that task only normalized whitespace on the comparison). No fund loss (PEvO has no token), but reputation is the platform's core trust signal.

## Goal

Make `claimer_orcids` trust only authority-signed accreditation, mirroring `activeAccreditationsCteBody`:

1. **Authority-gate `claimer_orcids`.** Add the `required_posting_auths ?| config.accreditationAuthorities` gate (the same predicate `activeAccreditationsCteBody` uses) so only authority-signed `accredit`/`revoke` ops feed the auto-accept ORCID set. Prefer reusing the existing authority-gated accreditation CTE/source rather than re-reading raw `accredit` ops — a single gated source removes the divergence class entirely. Confirm `revoke` handling stays correct (a revoke must still clear the prior attestation).
2. **Exhaustive call-site audit** (per `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`): grep every read of `accredit`/`revoke` custom_json across `backend/src/` and confirm each applies the `required_posting_auths` authority gate, or document why a given read legitimately does not. Include the grep output in the re-review signal block.
3. **Behavioral regression test** (real Postgres, synthetic rows, per the no-mock-DB stance): seed a self-signed (non-authority `required_posting_auths`) `accredit` op setting `orcid = V` for an accredited attacker, plus a victim paper listing `V` at the attacker's claimed `author_index`, and assert the attacker's claim is **NOT** auto-accepted post-fix. A targeted revert of the new authority gate must turn the assertion red. Also assert a legitimately authority-signed attestation still auto-accepts (control).

## Acceptance criteria

- `claimer_orcids` (or its replacement source) admits only `accredit`/`revoke` ops whose `required_posting_auths` contains an entry of `config.accreditationAuthorities`.
- The exploit above no longer auto-accepts the forged claim; a legitimate authority-attested ORCID still auto-accepts.
- Reputation remains reproducible from public on-chain data (the authority set is `config.accreditationAuthorities`, itself derivable from config/on-chain attestations) — no off-chain state introduced.
- The call-site audit (item 2) is recorded in the re-review signal with grep output.
- Comments anchor on stable symbols (no task slugs, round numbers, line numbers, or SHAs in production/test source).

## Notes

- `config.hiveAdminAccount` is singular by design; the accreditation authority set is `config.accreditationAuthorities` (the `?|` array form `activeAccreditationsCteBody` already uses). Do not conflate the two.
- This is reputation-trust-model work; if the fix shape touches the reputation algorithm's documented inputs, update `agents/docs/reputation-algorithm.md` accordingly (architect-zone — flag via a note, do not edit it from a backend commit).

---

## Backend implementation summary (2026-05-26)

**Item 1 — authority-gate the auto-accept ORCID source.** Replaced the hand-rolled ungated `claimer_orcids` CTE entirely. The `accepted_claims` ORCID auto-accept arm now joins `active_accreditations` (composed into the reputation WITH via `activeAccreditationsCteBody(20)`), whose `accred_ranked` CTE applies `required_posting_auths ?| accreditationAuthorities`. This is the single gated source the read-surface `authorshipClaimsCteBody` ORCID arm already joins, so the cycle and read surfaces agree on which attestations are valid — the divergence class is removed, not merely re-gated. New params `$20 = config.appTag`, `$21 = config.accreditationAuthorities` (param docstring updated).

**Revoke handling confirmed correct:** a revoked account is excluded from `active_accreditations` (`rn = 1 AND action = 'accredit'`), so a revoke clears the prior attestation and the claim stops auto-accepting — strictly better than the old code, which read the orcid off whatever the most-recent accredit/revoke op carried. No off-chain state introduced; the authority set is `config.accreditationAuthorities`, reproducible from config/on-chain attestations.

**Item 2 — exhaustive call-site audit.** Grep over `backend/src/` for SQL reads of `accredit`/`revoke` custom_json:

```
grep -rnE "IN \('accredit', ?'revoke'\)|->> 'action'\) = 'accredit'" backend/src/
```

| Site | Authority-gated? |
|---|---|
| `accreditation.ts` getAccreditedSet | yes — `required_posting_auths ?\| $2::text[]` |
| `hafsql.ts` activeAccreditationsCteBody | yes — `required_posting_auths ?\| $::text[]` |
| `routes/profile.ts` accreditation read | yes — `required_posting_auths ?\| $4::text[]` |
| `routes/accreditations.ts` (list + per-account status) | yes — both `?\| authorities` |
| `lib/idempotency.ts` (findAccreditationBroadcastByIdempotencyKey + findExistingAccreditation) | yes — both `?\| authorities` |
| `reputation.ts` accepted_claims ORCID arm | yes — now via `activeAccreditationsCteBody` (this fix) |
| `hafsql.ts` getGenesisBlock | **ungated — legitimate.** Namespace-wide `MIN(block_num)` perf floor; reads no `account`/`orcid`, makes no trust decision. A forged earlier accredit could only lower the scan floor (perf), not forge accreditation. |
| `notification-queries.ts` accreditation-update feed | **ungated — out of reputation scope.** Drives a user-visible `accreditation_update` notification; a self-signed `accredit` op naming a victim's account yields a spurious notification (nuisance), but grants no trust. Surfaced for triage; NOT fixed here (out of this task's reputation-integrity scope). |

JS payload-construction sites (`wot.ts`, `routes/signup-verify.ts`, `routes/orcid.ts`, `lib/broadcast-error.ts`, `digest.ts`) are writes / mode discriminators, not trust reads — out of scope.

**Item 3 — behavioral regression** (`tests/routes/reputation-orcid-auto-accept-authority-gate.test.ts`, synthetic-VALUES against real Postgres, carve-out clause-(c) header documents why). Runs the production `activeAccreditationsCteBody` fragment (HAF view redirected to a synthetic CTE, mirroring `hafsql.test.ts`'s retraction-authority-gate test): a self-signed (non-authority `required_posting_auths`) `accredit` op setting `orcid = V` for an accredited attacker against a victim paper listing `V` does **NOT** auto-accept; an authority-signed attestation does (control). Mutation-kill: reverting the `?|` gate admits the self-signed op into `active_accreditations`, flipping the attacker assertion red.

**Verification.** `npm run typecheck` (src + tests) clean; `npm run lint` clean on touched files. `tests/routes/reputation-orcid-auto-accept-authority-gate.test.ts` 1/1; `reputation-lifecycle.test.ts`, `hafsql.test.ts`, `papers-cumulative-orcid-audit.test.ts` green. Full backend suite: my blast radius (reputation, hafsql) green; pre-existing/environmental failures elsewhere (`reviews.test.ts` mock coupled to a prior gate-SQL change; `startup-checks.test.ts` `PEVO_BRIDGE_POSTING_KEY` network-id; transient real-HAF contention) are unchanged by this work (files byte-identical to the pre-work base).

**Self-audit on added lines:** no task-slug citations, round-N markers, line-number anchors, SHA refs, date anchors, or relative positional anchors in production/test source. Inline comments anchor on stable symbols (`active_accreditations`, `activeAccreditationsCteBody`, `authorshipClaimsCteBody`, `required_posting_auths`, `accred_ranked`).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
