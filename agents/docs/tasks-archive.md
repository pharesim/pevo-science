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

Rationale, the two rot classes observed, and the design obstacles are recorded in
`agents/docs/solutions/conventions/carve-out-clause-c-companion-citations-are-unverified-prose-2026-09-02.md`.

## Scope

1. Adopt a structured, resolvable citation form for clause-(c) companions: a
   repo-relative path that resolves, paired with a risk-class token that occurs
   in that file. The convention doc proposes one shape; the exact spelling is
   this task's to settle.
2. Add a canary that resolves each citation and asserts the named file contains
   the named token. A vitest canary under `backend/tests/eslint/` is the likely
   home rather than a `.githooks` arm, because resolving a path and grepping the
   target requires repo reads that a fast pre-commit hook should not do.
3. Decide the scoping. `grep -rl "carve-out" backend/tests --include=*.ts`
   returns 114 files and `grep -rl "[Rr]eal-path companion" backend/tests
   --include=*.ts` returns 111 of them, all free prose, so a whole-tree
   assertion fails 111 files on the day it lands. A diff gate first (new and
   edited headers must use the structured form) with the whole-tree assertion
   deferred mirrors how the anchor classes were staged.
4. Fix the one known live violation, carried deliberately as a documented
   example: the clause (c) block in
   `backend/tests/middleware/verifyHiveSignature-session-invalidation-failclosed.test.ts`
   still attributes happy-path JWT acceptance to "the settings password-reset
   suites" as a category. The claim is true and no single file is the obvious
   referent, which is exactly why it needs a decision rather than a rewrite: pick
   the file that best witnesses it, or drop that half of the sentence.

## Acceptance criteria

1. A citation naming a file that does not exist fails the canary.
2. A citation naming a file that exists but does not contain the risk-class
   token fails the canary.
3. A correct citation passes, and the canary is shown to go red when the
   citation is mutated in each of the two directions above.
4. The parser handles a filename wrapped mid-token across a ` * ` docblock
   continuation line. This occurs in the current corpus, and a line-based
   extractor silently truncates such a name and then reports a nonexistent file.
5. Whatever scoping is chosen, the suite is green when it lands, and what was
   deferred is stated.
6. The known violation in scope item 4 is resolved.

## Notes

Grep the risk-class TOKEN inside the named file, never the cited filename. A
check built on finding the filename inherits the exact blindness it exists to
remove: the filename is present, the assertion is not.

Token presence is necessary, not sufficient. It catches the observed rot classes
and does not catch "the companion asserts it, but weakly"; that stays a review
judgement.

The follow-up-task branch of clause (c) cannot be checked this way. Task files
archive and the archive trims, so a task-slug citation is a dead pointer by
construction and must not appear in test source at all. Those citations should
name the uncovered risk class in behavioural terms and nothing else.

## Backend completion note (2026-09-02)

**Structured form settled** (scope 1). One companion per label occurrence, inside
the clause-(c) block:

```
 *   (c) Real-path companion: `backend/tests/routes/some-route.test.ts` [SOME_TOKEN]
```

Path repo-relative and backtick-delimited; risk-class token bracket-delimited,
whitespace-free, closing the line. The path may wrap mid-token across a ` * `
continuation (all whitespace inside the backticks is stripped on parse); the
token may not.

**Canary** (scope 2):
`backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts`.
Five arms per citation: repo-relative path shape, path resolves, not a
self-citation, the token occurs in the companion's CODE (block comments and
comment-only lines stripped, `vi.mock(` lines excluded), and the token is not
generic enough to resolve in more than 40 files under `backend/tests`.

**Scoping decided** (scope 3). Validation of structured citations is whole-tree.
The "must be structured" requirement is an in-tree ratchet rather than a
`.githooks/pre-commit` arm, for two reasons: `.githooks/` is architect zone and
outside backend's boundary, and the in-tree list is the stronger mechanism
anyway (whole-tree rather than one diff, and no env var turns it off). A comment
block that carries the canonical `real-path <adjective>? companion` label AND
names a `*.test.ts` file must use the structured form unless its file is in
`DEFERRED_FREE_PROSE` or the block carries the `carve-out-citation-allow`
marker. `DEFERRED_CEILING` makes the list one-way, and a listed file that stops
carrying an unstructured citation fails the hygiene arm, so a citation cannot be
deleted to escape the ratchet quietly.

**Deferred, explicitly** (scope 5): 102 files still carry free-prose citations
(104 at landing, minus the two converted below). Also not ratcheted, and stated
in the canary header: the one-off label nouns the corpus uses for the same idea
(sibling coverage, real-HAF variant, no-mock companion) and the citations whose
referent is prose rather than a file, which no parser can resolve. Detection is
deliberately precision-biased for the same reason the pre-commit anchor gate
scopes itself to known slug prefix families.

**Known violation resolved** (scope 4 / AC 6). The compound sentence in
`verifyHiveSignature-session-invalidation-failclosed.test.ts` is split. The
happy-path half was re-derived from the code rather than repaired in prose: it
now cites `verifyHiveSignature-authmethod.test.ts` [hiveAuthMethod], which
admits a real Bearer JWT through the real middleware with `getAppPool` unmocked.
That sidesteps the referent ambiguity in "the settings password-reset suites"
(a reviewer pass found it could plausibly mean either the settings set-password
suites or the `/api/auth/reset` suites, so repairing the prose would have
hardened a guess). The revocation half keeps its three companions, now
structured with `SESSION_INVALIDATED`. The sibling
`verifyHiveSignature-replay-revocation-hardening.test.ts` was converted too,
since it is the other half of the documented exemplar pair.

**Verification.** Five mutation probes, each observed red and then restored:
cited path mutated to a nonexistent file; token mutated to one absent from the
companion; companion swapped to a file where the token appears only in comments;
a converted citation reverted to free prose; a brand-new file added carrying a
prose citation. Control green after each. Probe one also exercised the wrapped
path on real content, since the mutation landed on the continuation half and the
failure message named the rejoined path (AC 4). `npm run typecheck` passes.
`tests/eslint/` plus the two converted suites: 10 files, 113 tests, all passing.
`npm run lint` not run: it lints `src/` only and no `src/` file changed.

**[TODO Architect]** `agents/docs/solutions/conventions/carve-out-clause-c-companion-citations-are-unverified-prose-2026-09-02.md`
