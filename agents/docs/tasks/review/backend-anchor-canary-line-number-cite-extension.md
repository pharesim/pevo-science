# BACKEND-ANCHOR-CANARY-LINE-NUMBER-CITE-EXTENSION — extend the standing comment-anchor canary to catch line-number cross-reference cites

**Owner:** backend
**Created:** 2026-06-14 (architect, surfaced at triage of the two residual comment-anchor cites)
**Priority:** P3 (detection-gap hardening; no behavioral defect)

## Problem

The standing canary `backend/tests/eslint/no-stale-comment-anchors.test.ts` detects three rot
classes in `backend/src/` comments: `round-N hold` ordinals, `Option X.N` labels, and
role-prefixed task slugs (`(backend|ui|architect)-<kebab>`, with the durable-path carve-out).
It does NOT detect **line-number cross-reference cites** — e.g. `reputation.ts:371`, `now ~337`,
`see lines 555-560`, `(see the HAF pool config at line 125)`. That class is a documented rot form
per `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15`, and the gap let a file-path/line
cite in `lib/idempotency.ts` survive the big `src/` sweep until it was cleared by hand in a
residual follow-up. With the known instances now fixed, the canary should be extended so the class
cannot silently recur.

## Goal

Add a line-number-cite detection regex to the canary, with planted-positive/negative coverage
matching the existing self-test block, tuned to avoid false-positives on legitimate numeric content.

## Acceptance

- A new detection regex (e.g. `LINE_CITE_RE`) flags line-number cross-reference forms in `src/`
  comments: `<symbol/file>.ts:<n>`, `line <n>` / `lines <n>-<n>`, and the `~<n>`
  tilde-approximation form. Tune carefully: the sweep deliberately KEPT non-rot numeric content
  (timing/latency estimates, block-stride quantities, hex `encode()` example outputs, pool config
  values like `max:3` / `connectionTimeoutMillis:5000`). Those must NOT trip the new check — a
  false-positive that forces rewriting legitimate numbers is itself a regression.
- Planted-POSITIVE and planted-NEGATIVE assertions added to the existing self-test `it()` block so
  the new regex cannot silently no-op if a future edit mangles it (the `no-bridge-paper-literal`
  self-test precedent; mirror the existing positives/negatives shape). Positives: at least one of
  each detected form. Negatives: at least one legitimate numeric string the sweep intentionally
  kept.
- OPTIONAL (implementer's call, surface the decision): a non-role-prefix tracking-id check
  (`SEC-NNN`, `BE-NNN`). If added, it MUST exempt durable knowledge-store references the same way
  the slug check does — a `SEC-NNN` that resolves to a persistent `solutions/`/`api-contracts/`
  record is NOT rot. The residual review confirmed `SEC-003-BE` resolves to a durable `solutions/`
  incident doc and the `claims.test.ts` suite, so a naive `SEC-` ban would false-flag a live
  durable reference. If this is too noisy to scope safely, leave it out and note why.
- Re-enumerate `backend/src/` for any remaining line-number cites before finishing (the big sweep
  plus the residual follow-up cleared the known ones; confirm none remain, or fix what is found in
  the same commit).
- Per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17`, audit the new regex/test
  text for any new rot class, and confirm the synthetic fixtures stay under `tests/` (the canary
  scans only `src/`, so test-tree fixtures do not self-trip).
- `npm run typecheck` + `npm run lint` clean; the canary stays green (now N+1 assertion groups).

## Cross-references

- `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`
- The standing canary: `backend/tests/eslint/no-stale-comment-anchors.test.ts`.
- Origin: the 2026-06-14 review of the two residual comment-anchor cites. The `idempotency.ts`
  `getPool()` re-anchor cleared the one known line-cite instance; the `SEC-003-BE` site was
  confirmed a durable reference (not dead), which is why any non-role-prefix id check must carry the
  durable-path exemption.

## Backend implementation note (2026-06-14, working tree)

Landed in `backend/tests/eslint/no-stale-comment-anchors.test.ts`:

- New combined `LINE_CITE_RE` detects all three documented forms in `src/` comments:
  `<file>.(ts|tsx|js|mjs|cjs|sql):<n>` path cites, `line <n>` / `lines <n>-<n>` references, and the
  bare `~<n>` tilde approximation. Wired into the scan loop as a fourth class (alongside round-N
  hold / Option X.N / task-slug). The `it()` title now reads "...Option X.N, or line-number-cite...".
- **Tilde tuning — the load-bearing design choice.** `backend/src/` carries ~80 legitimate `~<n>`
  approximations (latency `~50ms`/`~3s`, strides `~28,800 blocks`/`~201,600-block`, sizes
  `~4096 bytes`, ranges `~5-30s`, decimals `~3.5 days`, `~2×`, `~95%`, counts `~5 concurrent`). A
  naive `~\d+` would red-bar every one. Rather than a fragile unit denylist (which would have forced
  embedding `×`/en-dash/em-dash literals — Edit-tool unicode-corruption risk), the tilde arm fires
  ONLY when the `~<n>` is **terminal**: followed by EOL or clause punctuation (`)`, `]`, `;`, `:`,
  `}`, or a `.`/`,` that does not open a decimal/thousands group). Every legitimate quantity is
  instead followed by a unit letter, digit, hyphen, `%`, or `×`, so none trip. Rationale is captured
  in the test header (LINE-CITE TUNING) so a future maintainer does not broaden it back to `~\d+`.
  - Accepted, documented blind spot: a cite immediately followed by a word (`~337 in foo`) is
    indistinguishable from `~5 concurrent` and is NOT caught. The documented rot form (`now ~337`)
    is terminal, so this is a deliberate trade for zero false positives.
- **Re-enumeration of `backend/src/` (acceptance item): zero remaining line-number cites.** Forms 1
  and 2 (`.ts:<n>`, `line <n>`) have zero instances; the `idempotency.ts` `getPool()` re-anchor had
  already cleared the last one. All ~80 tilde instances are legitimate and spared. Verified by
  running the final regex against every `.ts` line under `src/`: 0 hits.
- **Planted self-test:** 7 positives (one per form + the three terminal-tail variants) and 12
  negatives (one representative of each kept numeric class, including the `~2×`/`~28,800`/`~3.5`
  edge cases and the `lines`-inside-a-word negatives) added to the existing self-test `it()`, mirroring
  the `no-bridge-paper-literal` precedent. Fixtures are synthetic and live under `tests/`, which the
  scan does not walk, so they cannot self-trip (audit-own-new-code convention satisfied).
- **OPTIONAL SEC-NNN/BE-NNN tracking-id check: OMITTED, by design.** `grep -rE '\b(SEC|BE)-[0-9]+'
  src` returns zero instances, so the check would catch nothing today while introducing a real
  false-positive hazard: a durable id reference (the residual review's `SEC-003-BE` → a persistent
  `solutions/` incident doc + the `claims.test.ts` suite) does not necessarily appear on a line that
  also cites a `solutions/`/`api-contracts/` path, so the `DURABLE_PATH_RE` exemption could not
  reliably rescue it. Net-negative (zero catch, live-reference false-positive risk), so left out per
  the task's "leave it out and note why" clause.
- Verification: `npm run typecheck` clean (src + tests), `npm run lint` clean (the lone warning is a
  pre-existing unused-eslint-disable in `src/lib/author-supersession.ts`, untouched here), canary
  green (3 test groups: walker guard + 4-class scan + expanded self-test).
