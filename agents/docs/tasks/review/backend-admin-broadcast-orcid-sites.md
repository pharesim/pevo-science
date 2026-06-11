# BACKEND-ADMIN-BROADCAST-ORCID-SITES — migrate the two orcid admin custom_json sites to broadcastAdminCustomJson (TOCTOU-lock-careful)

**Owner:** backend
**Created:** 2026-06-09 (split from `backend-admin-broadcast-envelope-sweep-remaining-sites` per that task's explicit "split orcid into its own task" provision; the three straightforward sites — papers / accreditation / signup-verify — landed there)
**Priority:** P3 (maintainability dedup; no defect — the sites are correct inline today)

## Background

`broadcastAdminCustomJson` (`backend/src/hive.ts`) centralizes the admin custom_json envelope (`id: appTag`, `required_auths: []`, `required_posting_auths: [config.hiveAdminAccount]`, `json`) + `PrivateKey.fromString(config.pevoAdminPostingKey)` + the `AdminKeyNotConfiguredError` guard. The parent sweep migrated `papers.ts` (retraction), `accreditation.ts`, and `signup-verify.ts`. The two orcid sites were split here because they need care (the SEC-002-TOCTOU-LOCK failure shape) that the three straightforward sites did not.

Residual inline sites (confirm with `grep -rn "PrivateKey.fromString(config.pevoAdminPostingKey)" backend/src` and `grep -rn "required_posting_auths.*hiveAdminAccount" backend/src`; `hafsql.ts` hits are HAF validity-rule doc comments, not broadcast sites — exclude):

- `routes/orcid.ts` `handleAccredit` (admin attestation broadcast).
- `routes/orcid.ts` `handleLink` (admin attestation broadcast).

## The orcid constraint (do NOT migrate naively)

Both orcid sites keep `PrivateKey.fromString(config.pevoAdminPostingKey)` **OUTSIDE** the inner `try`, so a key-construction throw escapes synchronously to the `withOrcidBindingLock` wrapper → **504 ambiguous-outcome + lock release**. The `SEC-002-TOCTOU-LOCK` describe block (`tests/routes/orcid.test.ts`) pins exactly this shape. Folding the async helper in parses the key INSIDE the inner `try`, converting that synchronous throw into an inner-catch rejection → **502 BROADCAST_FAILED on the lock-acquired branch** — a security-tested failure-shape change.

To migrate safely:
- Validate/parse the admin key OUTSIDE the inner `try` before the `broadcastAdminCustomJson` call (so a key-parse / unset-key fault still escapes synchronously to the wrapper → 504 + lock release), OR re-map `AdminKeyNotConfiguredError` / key-parse errors back onto the wrapper-escape path.
- Update the matching `SEC-002-TOCTOU-LOCK` specs deliberately if the shape changes, as a conscious, reviewed change.

## Acceptance

1. Each orcid site calls `broadcastAdminCustomJson`; no `required_posting_auths: [config.hiveAdminAccount]` inline construction remains in `orcid.ts`. After this lands, the envelope literal exists ONLY in `hive.ts` (the parent sweep removed it everywhere else).
2. The 504+lock-release boundary holds: `SEC-002-TOCTOU-LOCK` specs stay green, OR are updated as a conscious, reviewed change with the new shape documented.
3. `AdminKeyNotConfiguredError` handling is correct for each site: either the key is pre-validated outside the inner try (preserving the synchronous-escape → 504 shape) or the helper's throw is mapped to the intended response.
4. Comment anchors clean (stable symbols only; no slug/line/SHA/§). `npm run typecheck` + `npm run lint` clean; the orcid suite (incl. `SEC-002-TOCTOU-LOCK`) green. NOTE: `orcid.test.ts` mocks `../../src/hive.js`; its factory must provide `broadcastAdminCustomJson` (route it through the suite's existing broadcast mock, mirroring the parent sweep's mock-factory additions in `retract` / `accreditation` / `signup-verify` suites).

## References

- `backend/src/hive.ts` — `broadcastAdminCustomJson`, `AdminKeyNotConfiguredError`.
- `backend/src/routes/orcid.ts` — `handleAccredit`, `handleLink` (the two inline sites); `withOrcidBindingLock` (the wrapper whose 504+lock-release shape the key-parse placement protects).
- `backend/tests/routes/orcid.test.ts` — `SEC-002-TOCTOU-LOCK` describe block.
- Parent: `backend-admin-broadcast-envelope-sweep-remaining-sites` (the three straightforward sites + helper docblock; archived/in-review).
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` (grep both directions to confirm the migration is exhaustive).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

---

## Backend completion note (2026-06-09, commit `7c6f756c` worktree worker, cherry-picked to main as `d29f9708`)

Both orcid sites (`handleAccredit`, `handleLink`) migrated to `broadcastAdminCustomJson` via the task's option 1 (pre-validate outside the inner try):

- **504+lock-release boundary preserved:** each site keeps a `PrivateKey.fromString(config.pevoAdminPostingKey)` validation parse inside `withOrcidBindingLock`'s `fn` but OUTSIDE the inner `try` (result discarded; in-code comment documents the failure-shape invariant), then calls `broadcastAdminCustomJson` inside the inner `try`. A malformed-key throw still escapes synchronously to the wrapper → 504 ambiguous-outcome + lock release. The helper's `AdminKeyNotConfiguredError` is unreachable at both sites because the existing pre-lock `if (!config.pevoAdminPostingKey)` 500-guard runs first (documented in code). This also keeps the suite's `vi.spyOn(PrivateKey, 'fromString')` injection point live.
- **SEC-002-TOCTOU-LOCK specs: zero behavioral changes.** Only comment prose inside the describe block was updated (helper rename in descriptions; three pre-existing stale line-number anchors replaced with stable-symbol anchors per the comment-anchor convention).
- **Exhaustiveness greps (both directions):** `required_posting_auths.*hiveAdminAccount` → only `hive.ts` (the helper) + the `hafsql.ts` doc comment (task-excluded); the envelope literal now exists only in `hive.ts`. `PrivateKey.fromString(config.pevoAdminPostingKey)` → the helper + the two sanctioned validation parses in `orcid.ts` (no envelope, key discarded). Reverse: `broadcastAdminCustomJson(` call sites cover orcid (2), papers, accreditation, signup-verify, claims, wot (3).
- **Mock factory:** `orcid.test.ts`'s hive.js mock factory now provides `broadcastAdminCustomJson`, routed through the existing `broadcastJsonMock`, mirroring the retract/accreditation/signup-verify factories.

Verification: orcid suite 102/102 green vs real Redis/Postgres (incl. all SEC-002-TOCTOU-LOCK specs in both accredit and link modes); typecheck + lint clean. Post-merge combined-tree verification with the concurrently-landed accred-state lint rule (which scans the migrated `orcid.ts`): lint + typecheck clean, 152/152 across orcid + tiebreaker + eslint suites.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

---

## Architect re-review (2026-06-10) — HELD PENDING FIXES (1 item)

`/ce-code-review` fan-out on commit `d29f9708` (correctness + security + adversarial on the session model; testing/maintainability/project-standards/reliability/kieran-typescript/learnings on Sonnet; ce-agent-native skipped per PEvO). **The migration is verified CORRECT with zero behavioral change** — correctness, security, project-standards, and reliability each returned zero findings. The validation parse occupies the exact statement position of the removed key construction (inside `withOrcidBindingLock`'s fn, outside the inner try), so the full key-state × lock-state matrix (malformed/unset/valid × acquired/unavailable/timeout) lands in byte-identical envelopes; `BroadcastTimeoutError` crosses the helper boundary with class identity intact (same-module import), so the instanceof discrimination and the lock-TTL-extend + skipRelease path are untouched; the pre-lock 500-guard ordering keeps `AdminKeyNotConfiguredError` unreachable as the in-code comment claims; envelope parity exact; deleting the validation parse is mutation-killed by the SEC-002 specs (spy never fires, broadcast resolves, the 504/not-called/lock assertions all fail). The de-rotted comment anchors are convention-clean with no new rot class introduced. Architect-verified orcid suite 102/102 green vs real Postgres/Redis.

Dismissed at triage: the fabricated mock envelope divergence (cluster-wide dismissal — compensated by the real-helper envelope pin in `hive-broadcast-timeout.test.ts`); a `void` prefix on the discarded validation parse (`no-unused-expressions` is not enabled in `backend/eslint.config.mjs`, and `void` is this codebase's floating-promise idiom, not a sync-discard marker). Pre-existing round/slug anchors in unchanged `orcid.test.ts` lines are out of scope (known rot class, separate sweep territory).

One item before archive (comment-only):

1. **(P3) `orcid.test.ts` header carve-out inventory is stale.** The header's "Only the database pools and broadcast.json are mocked" claim no longer matches the factory, which now also mocks `broadcastAdminCustomJson` (routed through `broadcastJsonMock`). Extend the header's enumerated mock set so the stated set matches the factory contents, per the carve-out clause (a) documentation requirement. The inline factory comment already carries the rationale; only the header enumeration is stale.

When the item lands, `git mv` this file back to `tasks/review/`; the move is the re-review signal, scoped to the fix commit only. Do not edit this hold block — the commit diff is the evidence; the architect updates it at re-review.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Backend re-review signal (2026-06-11, the commit performing this mv)

Hold item landed, comment-only: the `orcid.test.ts` header carve-out inventory now states "Only the database pools and the broadcast seams (broadcast.json, broadcastJsonWithTimeout, broadcastAdminCustomJson — all routed through the one broadcastJsonMock) are mocked", matching the hive.js mock factory contents per carve-out clause (a). No spec or factory changes.

Verification: `npm run typecheck` + `npm run lint` clean (known pre-existing `author-supersession.ts` unused-directive warning only); orcid suite 102/102 green vs real Postgres/Redis with the edit in place.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Architect re-review (2026-06-11) — HELD PENDING FIXES (1 item)

Scoped re-review of the round-2 fix commit `338eb188` via `/ce-code-review` (correctness on the session model; testing/maintainability/project-standards/learnings on Sonnet; ce-agent-native skipped per PEvO). **The round-2 held item is VERIFIED LANDED and accurate as far as it goes:** the three broadcast seams named in the new header text are genuinely all routed through the one `broadcastJsonMock`, the commit is comment-only, and no anchor rot was introduced. But three reviewers independently (conf 100/100/75) found the refreshed sentence is STILL not a truthful clause (a) inventory. One item before archive (comment-only):

1. **(P2) The "Only the database pools and the broadcast seams (...) are mocked" enumeration omits two mocked surfaces.** The file's vi.mock set is five modules: `db.js`, `app-db.js`, `hive.js`, `accreditation.js`, and the `verifyHiveSignature.js` wrapper (delegates to real by default; fairly covered by the header's "STILL UNMOCKED" lines). The rewritten sentence accounts for the pools and the hive.js broadcast seams but omits: (a) `accreditation.js` — `getAccreditedSet` fully stubbed to `new Set()`, no real delegation; (b) the `hiveClient.database.getAccounts` -> `[]` read stub inside the same hive.js factory the broadcast-seam parenthetical describes. Extend the enumeration so the stated set matches the factory contents (name `getAccreditedSet` and `getAccounts` alongside the broadcast seams; the inline factory comments already carry the rationale). This is the same staleness class as the round-2 item, one layer deeper — the round-2 hold scoped only the `broadcastAdminCustomJson` omission, so this is a new round-3 finding, not a missed instruction. Mind `convention-enforcing-fix-must-audit-its-own-new-code`: before signaling, re-verify the rewritten sentence against ALL five vi.mock factories so the inventory cannot be wrong a third time.

Dismissed at triage: the "Confirmed STILL UNMOCKED: verifyHiveSignature" phrasing being technically contradicted by the delegating wrapper (pre-existing, conf 50; the wrapper runs real by default and the characterization is behaviorally fair).

When the item lands, `git mv` this file back to `tasks/review/`; the move is the re-review signal, scoped to the fix commit only. Do not edit this hold block — the commit diff is the evidence; the architect updates it at re-review.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Backend re-review signal (2026-06-11, the commit performing this mv) — round-3 item landed

Comment-only: the header's mocked-set enumeration now inventories all five vi.mock factories: the database pools (db.js `getPool`, app-db.js `getAppPool`); the hive.js factory's broadcast seams (broadcast.json, `broadcastJsonWithTimeout`, `broadcastAdminCustomJson`, all routed through the one `broadcastJsonMock`) plus its `hiveClient.database.getAccounts` -> `[]` read stub and the `BroadcastTimeoutError` / `DEFAULT_BROADCAST_TIMEOUT_MS` stand-ins; and accreditation.js `getAccreditedSet`, stubbed to an empty accredited set. A closing parenthetical notes the fifth vi.mock (verifyHiveSignature.js) is the delegating wrapper, not a stub, pointing at its own factory note (whose "STILL UNMOCKED" characterization the round-3 triage upheld as behaviorally fair).

Per `convention-enforcing-fix-must-audit-its-own-new-code`, the rewritten sentence was re-verified against the contents of ALL five vi.mock factories before this signal: every export the factories provide (`getPool`, `isHafConfigured`, `closeHafPool`, `getAppPool`, `hiveClient` with `getAccounts` + `broadcast.json`, `broadcastJsonWithTimeout`, `broadcastAdminCustomJson`, `BroadcastTimeoutError`, `DEFAULT_BROADCAST_TIMEOUT_MS`, `getAccreditedSet`, `verifyHiveSignature`) is either named in the enumeration, covered by the database-pools grouping, or covered by the wrapper parenthetical. No spec or factory changes; no new anchor rot (stable symbols only).

Verification: `npm run typecheck` + `npm run lint` clean (known pre-existing `author-supersession.ts` unused-directive warning only); orcid suite 105/105 green vs real Postgres/Redis with the edit in place.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
