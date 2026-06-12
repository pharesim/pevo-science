# BACKEND-ORCID-TEST-HEADER-DBJS-ENUMERATION — name the db.js factory's remaining exports in the orcid.test.ts mock inventory; de-positionalize the wrapper pointer

**Owner:** backend
**Created:** 2026-06-12 (architect, from the round-4 re-review of `backend-admin-broadcast-orcid-sites`; split to its own task at triage so the parent could archive)
**Priority:** P3 (comment-only; carve-out clause (a) inventory precision — no defect)

## Problem

The `orcid.test.ts` header's mocked-set sentence (rewritten under the parent task to enumerate all five vi.mock factories) names the db.js factory only as "the database pools (db.js getPool, app-db.js getAppPool)" while that factory stubs THREE exports: `getPool`, `isHafConfigured` (-> `true`, forcing every spec down the HAF-configured branch), and `closeHafPool` (async no-op). Three reviewers (testing conf 100; correctness and project-standards conf 75) judged that the "database pools" grouping does not absorb a configuration predicate, and the same sentence names even the hive.js `BroadcastTimeoutError` / `DEFAULT_BROADCAST_TIMEOUT_MS` stand-ins at export granularity — inconsistent granularity inside one universal claim. Per `universal-mock-inventory-must-be-re-derived-not-incrementally-patched`, the stated set must reach set equality with every factory's exports; this is the fourth under-enumeration layer found on this sentence, so the convention's enumerate-the-target-in-the-hold rule applies below.

## Fix (exact target enumeration)

1. Amend the db.js clause to name all three exports, e.g.: "the database pools (db.js `getPool` / `isHafConfigured` -> true / no-op `closeHafPool`; app-db.js `getAppPool`)". Keep the rest of the sentence's structure.
2. While in the sentence: replace the positional pointer "see the note above its factory" with a name anchor, e.g. "see the `verifyHiveSignature.js` vi.mock factory's note" (the "above" spatial claim silently stales on factory insertion or reorder; the module path is the stable identifier).
3. Re-verify set equality against ALL five factories' exports before signaling (re-derive the whole enumeration; do not splice in the two named exports and stop).

## Acceptance

- The sentence names, or explicitly and fairly groups, every export of every vi.mock factory in the file; export granularity is consistent across factories.
- No positional anchors in the edited text; stable symbols only; no slug/round/line/SHA.
- `npm run typecheck` + `npm run lint` clean; comment-only (no spec or factory changes).

## Cross-references

- `backend/tests/routes/orcid.test.ts` — the header sentence and the five vi.mock factories.
- `agents/docs/solutions/conventions/universal-mock-inventory-must-be-re-derived-not-incrementally-patched-2026-06-11.md` — the governing convention; this task is its fourth-layer instance.
- Parent: `backend-admin-broadcast-orcid-sites` (archived 2026-06-12; see `agents/docs/tasks-archive.md`).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Implementation note (backend, 2026-06-12)

All three fix items landed in one comment-only commit:

1. The db.js clause now names all three factory exports: "the database pools (db.js getPool / isHafConfigured -> true / no-op closeHafPool; app-db.js getAppPool)". Sentence structure otherwise kept.
2. The positional fifth-factory pointer became the name anchor "see the verifyHiveSignature.js vi.mock factory's note".
3. Set equality re-derived against ALL five factories (not spliced): db.js getPool + isHafConfigured + closeHafPool (now named); app-db.js getAppPool (named, complete); hive.js hiveClient (broadcast.json named under the broadcast seams, database.getAccounts named as the read stub) + broadcastJsonWithTimeout + broadcastAdminCustomJson + BroadcastTimeoutError + DEFAULT_BROADCAST_TIMEOUT_MS (all already named, complete); accreditation.js getAccreditedSet (named, complete); verifyHiveSignature.js explicitly identified as the delegating wrapper, not a stub. Export granularity is now consistent across factories.

No spec or factory changes. `npm run typecheck` (src+tests) clean; `npm run lint` clean except the known pre-existing `author-supersession.ts` warning.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
