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
