# BACKEND-ORCID-TRIM-PARITY — close SQL/JS whitespace asymmetry on chain `orcid` (the sibling of the hive-side reject-at-boundary fix)

**Owner:** Backend Agent
**Created:** 2026-05-19 (architect, surfaced by combined `/ce-code-review` of the supersession cluster — task 3 round-3 + task 4 round-2; cross-corroborated by correctness, security, adversarial, maintainability)
**Priority:** P2

## Problem

Round-3 of `backend-papers-canonical-orcid-resolution` (commit `ed7dfa9`) closed the SQL TRIM (U+0020-only) vs JS `.trim()` (full Unicode whitespace) asymmetry on the `hive` field by adopting reject-at-boundary: a new `trimAsciiSpace` helper that mirrors PostgreSQL TRIM semantics + a `[a-z0-9.-]+` charset regex on both SQL and JS paths. Per `agents/docs/solutions/conventions/sql-trim-vs-js-trim-whitespace-character-set-asymmetry-2026-05-19.md`.

The same convention governs the chain `orcid` field; the round-3 fix did NOT close it there. `computeSupersession` still calls `chainOrcid.trim()` (full Unicode) while `authorsWithSupersessionSelect` uses `BTRIM` (U+0020-only) at two sites: the `NULLIF(BTRIM(...), '')` no-claim guard AND the `aa.orcid <> BTRIM(...)` equality check.

### Reproducer

Broadcaster posts `{hive: 'alice', orcid: '\t0000-0001-1234-5678'}` (tab-prefixed). alice accredited with on-chain orcid `'0000-0001-1234-5678'`.

| Surface | Path | Result |
|---|---|---|
| `GET /api/papers` (list) | SQL `authorsWithSupersessionSelect` | `orcid_discrepancy: true` (BTRIM no-op on tab → `<>` true) |
| `GET /api/papers/:author/:permlink` single-link | SQL `authorsWithSupersessionSelect` | `orcid_discrepancy: true` (same as list) |
| `GET /api/papers/:author/:permlink` chain | JS `buildCumulativeAuthorsForChain` → `computeSupersession` | `orcid_discrepancy: false` (`.trim()` strips tab → claimed = attested) |
| `GET /api/papers/:author/:permlink?version=N` | JS `applyAuthorSupersession` → `computeSupersession` | `orcid_discrepancy: false` |
| `GET /api/papers/:author/:permlink` `metadata_restored` fallback | JS `applyAuthorSupersession` → `computeSupersession` | `orcid_discrepancy: false` |
| `GET /api/profile/:username/papers` | JS `toPaperSummary` → `applyAuthorSupersession` → `computeSupersession` | `orcid_discrepancy: false` |

Same paper, same broadcaster claim, two different `orcid_discrepancy` values across surfaces. Frontend's discrepancy badge renders inconsistently for the same paper depending on which endpoint loaded the row.

## Severity framing

**This is cross-surface display inconsistency, NOT a security spoof bypass.** Both paths still resolve the correct `orcid_verified` value (the on-chain attested ORCID) for accredited targets via server-override. The `orcid_claim_mismatch` audit event only fires from `buildCumulativeAuthorsForChain` (JS chain-detail path) and behaves correctly (no event when JS `.trim()` resolves the claim to match the attested value); SQL surfaces don't emit audit events regardless. So the audit-signal asymmetry is bounded to whether the operator-visible discrepancy badge shows up for whitespace-padded matching claims.

P2 severity reflects: cross-surface UX inconsistency + convention drift + low-frequency real-world trigger (publishers who copy-paste their ORCID with leading/trailing whitespace).

## Design choice

Two defensible fix shapes; architect picks one before implementation:

### (a) Make SQL match JS — "semantically equal text wins"

Wrap the chain-orcid side of the equality in a stripper that matches JS `.trim()`. Options:

- `REGEXP_REPLACE(a.elem ->> 'orcid', '\s+', '', 'g')` — strips ALL whitespace (interior + boundary). Closes the asymmetry but also collapses interior whitespace, which isn't what JS `.trim()` does.
- `BTRIM(a.elem ->> 'orcid', E' \t\n\r\v\f')` — PG `BTRIM` with explicit ASCII C-whitespace charset. Matches the trim-the-boundary semantics; doesn't strip NBSP / U+2028 / U+2029 (still asymmetric on extended Unicode whitespace, but covers the common attack vectors).
- Both NULLIF and `<>` sites need the same wrapper. The widened CASE becomes `CASE WHEN aa.orcid IS NOT NULL AND NULLIF(<wrapper>(a.elem ->> 'orcid'), '') IS NOT NULL AND aa.orcid <> <wrapper>(a.elem ->> 'orcid') THEN true ELSE false END`.

Default to (a) — fewer false-positive discrepancy badges; matches the `pevo.authors[].orcid` field's "free-text claim" semantics where whitespace padding is sloppiness, not intent.

### (b) Make JS match SQL — "exact text difference is the signal"

Replace `chainOrcid.trim()` in `computeSupersession` with `trimAsciiSpace(chainOrcid)` (the helper already extracted for the hive path). The length-guard becomes `trimAsciiSpace(chainOrcid).length > 0`. The claim value uses `trimAsciiSpace`.

Architect's papers.md note "the discrepancy is the authoritative audit signal regardless of apparent equality" suggests this interpretation — text-difference IS the signal, not semantic-equality. But this widens the false-positive surface (any non-U+0020 whitespace flips discrepancy true on JS surfaces too).

### Convention symmetry

Whichever shape is chosen, the parity contract must be documented inline at both `computeSupersession` (JS) and `authorsWithSupersessionSelect` (SQL) so future edits stay in lockstep. The hive path's pattern is the reference: JSDoc on `normalizeHiveAccount` describes the contract; SQL JSDoc on `authorsWithSupersessionSelect` cross-references the JS symbol.

## Acceptance

1. **One of the two design shapes lands** at both SQL sites (`NULLIF(BTRIM(...), '')` + `aa.orcid <> BTRIM(...)`) and the JS site (`chainOrcid.trim()` in `computeSupersession`).
2. **Parity test added** to `backend/tests/routes/papers-canonical-orcid-resolution.test.ts`: feed `{hive: 'alice', orcid: '\t<attested>'}` against an accredited alice through both SQL and JS paths; assert identical `orcid_discrepancy` value (whichever value the chosen shape produces). Architect-prescribed parity-input matrix mirrors the hive-side test: `'\t' + attested`, `' ' + attested`, `attested + '\n'`, `attested` (no padding).
3. **JSDoc on `computeSupersession` and `authorsWithSupersessionSelect`** explicitly documents the chosen invariant. Anchor on stable behavioral statements per `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`.
4. **SQL-shape canary** asserts the new BTRIM-charset (or REGEXP_REPLACE) literal appears in both list+detail SQL fragments. Mirrors the round-3 hive-side canary pattern.
5. **Mutation-kill verification:** reverting either side's stripper to the pre-fix form fails the parity test red.

## Out of scope

- Audit-event coverage asymmetry across surfaces (SQL surfaces don't emit `orcid_claim_mismatch`; JS-only emission is intentional per the round-1 architect design). Pre-existing; not in scope here.
- The four-branch supersession lattice rule #3 itself (this task is normalization-parity, not lattice-shape).
- Other broadcaster-controlled fields that may have similar SQL/JS parity gaps (name, affiliation) — file separate tasks if those become measurable issues.

## Cross-references

- `agents/docs/solutions/conventions/sql-trim-vs-js-trim-whitespace-character-set-asymmetry-2026-05-19.md` — the convention this task closes for the orcid field.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — analogous pattern for the hive-side normalizer adoption.
- Cluster review 2026-05-19 (architect-context, post-supersession-cluster): correctness P1/80 + security P1/75 + adversarial P1/75 + maintainability residual = cross-corroborated anchor 100. Severity narrowed to P2 at architect triage (display inconsistency, not spoof).
- `backend/src/lib/author-supersession.ts:126-128` — JS site.
- `backend/src/hafsql.ts:824-825` — SQL sites (NULLIF + `<>`).

## Architect re-review (2026-05-20) — HELD PENDING FIXES:

Verified empirically against the running Postgres at architect-context review time: `encode((E' \t\n\r\v\f')::bytea, 'hex')` → `20090a0d760c` (literal `v` byte 0x76 in the charset), expected `20090a0d0b0c` (vertical tab 0x0B). PostgreSQL E-strings do not recognize `\v`; the unrecognized escape silently drops the backslash and passes the next character literally. The fix's JSDoc on `authorsWithSupersessionSelect` and the SQL-shape canary at `papers-canonical-orcid-resolution.test.ts:583-617` both assert behavior the code does not exhibit.

1. **`backend/src/hafsql.ts:872-873`** — replace `E' \t\n\r\v\f'` with `E' \t\n\r\x0B\f'` at both the NULLIF no-claim guard AND the `aa.orcid <> BTRIM(...)` equality check. (Equivalently, drop `\v` entirely if vertical tab is judged not a realistic copy-paste vector; the architect-prescribed charset can stand without it.) Two real consequences of the bug today: (a) the vertical-tab split-brain the fix targeted remains open for `{orcid:'<attested>'}` inputs — JS strips the VT → match → discrepancy=false; SQL leaves the VT (because `\v` is not in the actual charset) → mismatch → discrepancy=true; (b) a NEW inverse asymmetry — `{orcid:'v<attested>'}` returns discrepancy=false on SQL (the charset strips the literal `v`) but discrepancy=true on JS (`.trim()` does not strip letters). Same split-brain class the fix aimed to close, just at different inputs.

2. **Extend the BTRIM widening to sibling sites** so the four-surface contract is uniform on whitespace-padded chain orcid:
   - `backend/src/hafsql.ts:644-656` — the `authorshipClaimsCteBody` hive-username auto-accept arm still raw-byte-compares `(c.json_metadata ... ->> 'orcid') = aa.orcid`. Apply the same BTRIM wrapper here.
   - `backend/src/routes/papers.ts:403-446` — the chain server-override + audit emission path still raw-compares `claimedOrcid !== accreditedOrcid` where `claimedOrcid = preOverrideChainOrcid` (no trim). Apply `trimAsciiSpace` (or the equivalent) on the JS side so the comparison matches `computeSupersession`'s post-fix shape.

   Same `{orcid:'\t<v>'}` payload currently produces three different cross-site interpretations: badge says discrepancy=false (post-fix supersession projection), audit fires `orcid_claim_mismatch` with `status:active` (raw-compare path), claim auto-accept misses → claim stays pending (raw-compare path). Adversarial-corroborated cluster-review finding.

3. **Extract the BTRIM charset literal to a module-level constant** in `hafsql.ts` (or wherever shared between the supersession projection and the auto-accept arm). With #1 + #2 lifted, the charset literal will appear at 4 SQL sites. The existing JSDoc warning "Both NULLIF and `<>` sites MUST use the SAME wrapper — drift between them would reintroduce the cross-site split" is enforced only by canary + human discipline. A named constant referenced at each interpolation site (e.g. `const ASCII_C_WS_BTRIM_CHARSET = String.raw\` \t\n\r\x0B\f\`;` then interpolated into each template) makes charset drift a compile-visible diff.

4. **SQL-shape canary must exercise real Postgres** for at least one input to prove the BTRIM charset bytes-on-the-wire match the docblock. The current canary at `backend/tests/routes/papers-canonical-orcid-resolution.test.ts:583-617` is a literal-text `toContain` against the captured SQL string and would not catch #1. Add a targeted test that runs `pool.query("SELECT BTRIM($1, E'...')", ['<v>'])` against real Postgres asserting the VT was stripped. Also extend the 4-input parity matrix to include the all-VT input AND a `v<attested>` regression case (post-#1) so the new inverse asymmetry is locked from now on. Real-DB target is fine per CLAUDE.md "Running Tests" carve-out — no HAF dependency for this targeted assertion.

5. **`backend/tests/routes/papers-canonical-orcid-resolution.test.ts:6-7`** — test file header cites "the four cases enumerated in the task body". The task file archives into `tasks-archive.md` and trims at 250 lines; the phrase becomes a dead pointer. Per `task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`, rewrite the anchor to enumerate the cases by name + helper symbol — e.g., "covering the four whitespace-padding cases (tab-prefixed, space-prefixed, lf-suffixed, unpadded) for `authorsWithSupersessionSelect` and `computeSupersession`."

6. **JSDoc gap-documentation** — while updating the JSDoc on `computeSupersession` (JS) and `authorsWithSupersessionSelect` (SQL) for the #1 fix, enumerate the exact remaining whitespace-class gaps post-fix: NBSP (U+00A0), BOM (U+FEFF), U+2028, U+2029. JS `.trim()` strips these; SQL BTRIM does not. The task body's "acceptable residual" stance survives unchanged; the JSDoc just makes the gap explicit so a future re-review doesn't re-flag it. Anchor on the stable convention — `agents/docs/solutions/conventions/sql-trim-vs-js-trim-whitespace-character-set-asymmetry-2026-05-19.md`.

## Backend re-review signal (2026-05-20, commit a4ab008):

All 6 hold items landed in a single backend commit. Per-item summary:

1. **`hafsql.ts` BTRIM charset fix.** Replaced `E' \t\n\r\v\f'` with `E' \t\n\r\x0B\f'` at the supersession projection's NULLIF no-claim guard AND `<>` equality check via the new `CHAIN_ORCID_BTRIM_CHARSET` constant (see item 3). Both sites interpolate the same constant, so charset drift is compile-visible. Real-Postgres verification matches the architect's empirical claim (`20090a0d760c` pre-fix, `20090a0d0b0c` post-fix).

2. **Sibling-site BTRIM widening.**
   - `hafsql.ts` `authorshipClaimsCteBody` ORCID auto-accept arm — now uses `aa.orcid = BTRIM(<chain orcid expression>, E'${CHAIN_ORCID_BTRIM_CHARSET}')` instead of raw `=`. Inline comment cross-references the supersession projection's parity contract.
   - `routes/papers.ts` chain server-override + audit-emission path — new `claimedOrcidForCompare` derived via `trimAsciiCWhitespace(claimedOrcid)` (the JS sibling of the SQL charset), with collapse-to-null on all-whitespace claims to mirror the SQL `NULLIF`. All four equality compares (case b active-mismatch, case c prefill check, case d suppression, revoked-arm mismatch) now use the normalized form. The audit event still carries the raw `claimedOrcid` for forensic visibility; only the equality compare and override-decision consult the normalized form. Cumulative-orcid-audit tests (5/5) confirm the audit emission shape is unchanged.

3. **BTRIM charset constant.** New module-level export `CHAIN_ORCID_BTRIM_CHARSET = " \\t\\n\\r\\x0B\\f"` in `backend/src/hafsql.ts` (placed under the `T` tables block, top of the module). Referenced at three SQL sites (supersession NULLIF, supersession `<>`, authorshipClaims ORCID-equality) plus the JS sibling helper `trimAsciiCWhitespace` in `lib/author-supersession.ts`. JSDoc on the constant calls out the `\v`-vs-`\x0B` Postgres parse trap and includes the empirical verification recipe.

4. **Real-Postgres byte-level canary.** New test file `backend/tests/hafsql-btrim-charset-real-postgres.test.ts` (3 tests, 3/3 pass against `pevo-postgres-1`). Three assertions: (a) every charset byte (space/tab/LF/CR/VT/FF) gets stripped on real Postgres; (b) the literal alphabet letter `v` does NOT get stripped post-fix (i.e., the charset is byte 0x0B, not 0x76); (c) the charset hex-decodes to `20090a0d0b0c`. The mocked-pool SQL-shape canary cannot distinguish `E'\v'` from `E'\x0B'` because both produce identical captured SQL text; only real Postgres exposes the parse-time difference. Skip-if-no-Postgres guard mirrors the `idempotency-real-haf` pattern. Also extended the JS parity matrix in `papers-canonical-orcid-resolution.test.ts` with two VT inputs (vt-prefixed, vt-suffixed) and an inverse-asymmetry regression test (leading literal `v` → discrepancy=true) so the post-fix surface is locked from now on.

5. **Test file header anchor.** Rewrote `papers-canonical-orcid-resolution.test.ts` lines 4-11 to enumerate the four supersession outcome cases by behavior (no hive, hive unaccredited, hive accredited with no attested ORCID, hive accredited with attestation differing from chain claim) AND the four whitespace-padding inputs (tab-prefixed, space-prefixed, lf-suffixed, unpadded) plus the helper symbols (`authorsWithSupersessionSelect`, `computeSupersession`). No task-slug or task-body redirect remains.

6. **JSDoc gap documentation.** Both `computeSupersession` (JS, `lib/author-supersession.ts`) and `authorsWithSupersessionSelect` (SQL, `hafsql.ts`) now enumerate the residual extended-Unicode-whitespace asymmetry explicitly: NBSP (U+00A0), BOM (U+FEFF), U+2028 (line separator), U+2029 (paragraph separator). JS `.trim()` strips these; SQL BTRIM with the ASCII C-whitespace charset does not. Both JSDocs cross-reference `agents/docs/solutions/conventions/sql-trim-vs-js-trim-whitespace-character-set-asymmetry-2026-05-19.md`. The `\v`-vs-`\x0B` Postgres parse trap is called out inline on the SQL JSDoc and on the `CHAIN_ORCID_BTRIM_CHARSET` constant.

**Tests run:**
- `tests/hafsql-btrim-charset-real-postgres.test.ts` → 3/3 pass (real Postgres byte-level)
- `tests/routes/papers-canonical-orcid-resolution.test.ts` `-t "parity"` → 18/18 pass (12 skipped via filter)
- `tests/hafsql.test.ts` → 27/27 pass (2 skipped, pre-existing)
- `tests/routes/papers-cumulative-orcid-audit.test.ts` → 5/5 pass (audit emission shape unchanged)
- `npm run typecheck:src` → clean

7 pre-existing failures on `papers-canonical-orcid-resolution.test.ts` (case 4b / `?version=N` / `metadata_restored` returning 503) are unrelated to this round — they reproduce identically at HEAD before my changes and look like transient HAF unavailability in the shared test infra.

---

## Architect re-review (2026-05-21, round-2 → round-3) — HELD PENDING FIXES

`/ce-code-review` ran with the always-on personas + security/adversarial/data-migrations (skipped — no migration)/reliability/kieran-typescript. Round-2's six hold items land correctly: `CHAIN_ORCID_BTRIM_CHARSET = " \\t\\n\\r\\x0B\\f"` produces the documented bytes (`20 09 0A 0D 0B 0C`) on real Postgres; the three SQL sites + JS sibling adoption are consistent; new real-Postgres byte-level canary, parity matrix VT-extensions, header rewrite, and JSDoc gap docs all hold up. One item held — cross-component parity break the round-2 exhaustive-audit claim missed.

### Item held (must fix before archive)

**1. (P1, conf 90, adversarial — confirmed against the production source) `reputation.ts` ORCID auto-accept arm not widened, recreating the cross-surface parity break this task was filed to close.** A structurally-identical ORCID auto-accept arm to the one widened at `authorshipClaimsCteBody` in `hafsql.ts` lives in `reputation.ts` (search by symbol: the CTE inside `getCurrentReputationScores` or its sibling helpers that resolves co-author claim acceptance for reputation accrual). It stays a raw `(c.json_metadata -> ... ->> 'orcid') = co.orcid` equality compare.

Reproducer: broadcaster posts `{orcid: '\t<attested>'}` for accredited co-author alice. Read surfaces (`/api/papers`, `/api/papers/:author/:permlink`, claims API, paper-detail) report claim auto-accepted via the widened `hafsql.ts` arm. The reputation cycle (1 day in testing, 7 days in production target) runs the `reputation.ts` arm with raw `=`, the tab-padded value byte-mismatches against accredited canonical, alice's claim is NOT counted in reputation accrual. Per-cycle drift: alice gets zero co-author reputation credit for a paper publicly listed as accepted; reapplies every cycle.

This is exactly the `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` failure mode the round-2 task narrative claimed to close. The round-2 signal block enumerated 3 SQL sites + 1 JS site but the convention's grep step at signal-block-write-time was not run for the sibling reputation module.

Fix shape:
- Widen the reputation-side ORCID auto-accept arm with `aa.orcid = BTRIM(<chain orcid expression>, E'${CHAIN_ORCID_BTRIM_CHARSET}')` mirroring the `authorshipClaimsCteBody` pattern. Import `CHAIN_ORCID_BTRIM_CHARSET` from `hafsql.ts`.
- Re-run the dual-grep audit at signal-block-write-time per rule 12 of the convention:
  - SQL side: `grep -rnE "BTRIM\\b" backend/src/ ; grep -rnE "->>[[:space:]]*'orcid'" backend/src/`
  - JS side: `grep -rn "\\.trim(" backend/src/ ; grep -rn "chainOrcid" backend/src/`
  - Verify every BTRIM-on-orcid site imports `CHAIN_ORCID_BTRIM_CHARSET`; every JS chain-orcid trim site uses `trimAsciiCWhitespace`.
- Add a behavioral test pinning the abuse vector: feed `{orcid: '\t<attested>'}` for accredited alice through a reputation-cycle path (synthetic-VALUES + real Postgres if real-HAF is impractical) and assert alice's reputation accrues credit for the paper post-fix. A targeted revert of the new BTRIM widening on this arm must turn the assertion red.

### Items dismissed at architect triage

- **(P2, testing) `authorshipClaimsCteBody` ORCID auto-accept arm widening lacks a SQL-shape canary and a behavioral test.** Dismissed per preemptive-test-hardening posture — the failure mode is a hypothetical targeted revert of one of six sites; the convention's per-layer canary requirement is satisfied collectively across the real-Postgres byte canary + parity matrix.
- **(P2, testing) `claimedOrcidForCompare` audit-emission path lacks a whitespace-padded behavioral test pinning the raw-vs-normalized field-shape asymmetry.** Dismissed per preemptive-test-hardening; the inline JSDoc at the derivation site documents the asymmetry.
- **(P3 advisory, adversarial) `papers.ts` JSDoc claim of lockstep parity between `trimAsciiCWhitespace` and `computeSupersession.trim()` is technically inaccurate on extended Unicode whitespace** (narrow ASCII C-whitespace ≠ broad ECMA-262). For NBSP-prefixed claims, audit fires + override applies + discrepancy=false. The architect-acknowledged residual gap documented in the JSDoc gap docs covers operational severity; PEvO has no known broadcaster input shape with NBSP/BOM/U+2028/U+2029.

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. Round-3 architect review scopes `/ce-code-review` to the round-3 commit only.

Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;
