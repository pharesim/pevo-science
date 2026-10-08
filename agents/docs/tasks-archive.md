## Port the after-close brace rule into the frontend enclosingSymbol walk, and correct its docblock (archived 2026-10-08): clean review; three residuals dismissed, the backend twin list folded into the open backend docblock task, one low ui follow-up filed

### Architect archive note (2026-10-08)

- **Review:** `/ce-code-review` full path on `78abead8` and `a2085733` (branch-remote, base `a5b139f5`): correctness, adversarial (in-process, no cross-model peer), testing, project-standards, learnings. Verdict "Ready to merge", 0 findings; AC1 to AC5 met. The orchestrator ran the full frontend unit suite at `a2085733` in an isolated copy (91 files / 2135 tests, exit 0) and checked the testing mutants against the brief (5 of 6 killed; the survivor is the `!inTemplate` guard, a hardening candidate). Correctness: the four table rows resolve to module scope in both copies, and a 150k-file differential found 0 divergences outside template-literal declarations. Adversarial: a base-vs-head A/B over `frontend/src`, `backend/src` and both test trees gives 0 symbol, region and comment diffs.
- **Dismissed:** R1, the line-leading close arm has no template guard (it matches the backend rule, fails closed against the current allowed maps, and neither tree has the shape); R2, the `isCommentLine` clause "a member the consuming set-equality can see" (it says a key is minted and weighed, not that the check fails closed, which is true); the missing probe for re-entry after an untracked close (covered by the 2026-10-05 dismissal of that mutant).
- **Folded:** the signal's seven backend twin sentences into `backend-enclosing-symbol-brace-gloss-and-suite-citation` as items 3 to 9, each checked against the backend code at `5404b32c`.
- **Filed:** `ui-enclosing-symbol-planted-probe-sentence-names-own-suite` (low), the frontend twin of that backend task's item 2.
- **Learnings checkpoint:** no solutions entry is contradicted. The composite-probe entry enumerates the tracked-region decision points, which the port left unchanged, and the fail-closed entry already sends the reader to each copy's own SET-EQUALITY bullet. Nothing for `/ce-compound` or `/ce-compound-refresh`.

**Owner:** ui
**Created:** 2026-10-05
**Priority:** low

Routed out of the architect re-review of `backend-enclosing-symbol-port-backreference`
(archived 2026-10-05). The two enclosing-symbol copies stay separate by ratified decision
(dialect divergence, no shared module). This task brings the shared brace walk back in
line where the backend copy moved, and fixes three frontend docblock statements.
User decision 2026-10-05: port the rule rather than decline it.

## Why

1. **The brace walks split at a comment close.** Since `146ce7de` (2026-10-01) the
   backend `enclosingSymbol` in `backend/tests/support/enclosing-symbol.ts` reads a
   comment close that begins its trimmed line even when no tracked region is open, and
   takes a `}` leading the code after any close it reads, at any indentation
   (`afterClose || indentOf(line) <= declIndent`). The frontend walk in
   `frontend/tests/unit/eslint/enclosing-symbol.js` only takes a `}` at or left of the
   declaration's indentation. Measured on both files at HEAD `9e731556`:

   | Shape (target line after the block) | Correct | Backend | Frontend |
   |---|---|---|---|
   | `ok(); /* note` then `  */ }` ending the function | module | module | inner (INWARD) |
   | `/* note` then `   */ }`, indented right of the declaration | module | module | inner (INWARD) |
   | `   */ }` closing an inner `if`, target still inside `f` | `f` | module (OUTWARD) | `f` |
   | control: `*/ }` at the declaration's indentation | module | module | module |

   INWARD is the direction a set-equality canary absorbs silently when the inner
   declaration is a licensed key. OUTWARD fails closed unless the allowlist holds the
   enclosing scope. The backend took the third row's OUTWARD cost on purpose, and its
   docblock's OUTWARD bullet names it ("a `}` after a read close ends the declaration even
   where it really closes an inner block"). No line in `frontend/src` or `backend/src`
   has a line-leading comment close followed by code today, so the exposure is latent.

2. **Three frontend docblock statements are false or one-directional.**
   - "The ordinary single-boundary form of that second shape, a close sharing its line
     with the real closing brace, IS handled: the walk reads the code after the close."
     Today this holds only when the close's line sits at or left of the declaration's
     indentation and the comment opened at a line start (rows 1 and 2 above are not
     handled).
   - The SET-EQUALITY bullet says set-equality assertions "fail closed: a wrong symbol is
     a new member and therefore a red bar, never a silent pass." That contradicts the
     same docblock's INWARD bullet, which says the multi-boundary miss "resolves INWARD,
     which is the direction a licensed key can absorb." An INWARD answer that names a
     licensed declaration is absorbed. The backend copy's SET-EQUALITY bullet was
     rewritten to say so.
   - The frontend file names its sibling only as "the backend's declaration shapes" and
     "the backend port", with no path. The backend file docblock carries a path pointer
     to this file and a two-way obligation; this file has no pointer back, so a change made
     only here never prompts a reader to check the backend copy. (Held out of scope for the
     backend task at its 2026-09-08 review as ui-zone; picked up here because this task
     edits the same docblock.)

## Scope

1. Port the backend's line-leading close read and after-close brace arm into the frontend
   `enclosingSymbol`, keeping the frontend's own dialect machinery (the template-literal
   declaration branch and the rest). Pin rows 1 to 3 as planted probes in the suite that
   pins the walk, row 3 as the accepted OUTWARD residual.
2. Update the frontend file docblock: the statement(s) of which brace the walk sees,
   including the OUTWARD cost the port takes on; the "IS handled" sentence; the
   SET-EQUALITY bullet; and a reciprocal pointer naming
   `backend/tests/support/enclosing-symbol.ts` by path with the obligation that a change
   to the walk, the region pass, or the comment predicate in either file is a prompt to
   read the other.

## Acceptance criteria

1. The four shapes in the table resolve the same in both copies.
2. Every frontend docblock sentence about which brace the walk sees is true against the
   code at the HEAD you land on.
3. The SET-EQUALITY bullet no longer claims a wrong symbol can never be a silent pass.
4. The frontend file docblock names `backend/tests/support/enclosing-symbol.ts` by path
   and states the two-way obligation.
5. The frontend unit suite passes, including every canary built on this module, with no
   change to an allowlist (the port must not newly absorb an existing occurrence).
   No anchor-rot form in added lines; the `.githooks/pre-commit` gate passes.

## Notes

- Do not add a "which copy is ahead" claim to the frontend docblock. The backend paragraph
  sends the reader to the sibling for that on purpose, because the direction has flipped
  twice already.
- A backend task (`backend-enclosing-symbol-brace-gloss-and-suite-citation`) corrects the
  backend docblock's description of the shared brace test. The two can land in either
  order. Do not cite either task, or any slug or SHA, in the docblock.
- Do not edit `backend/`.

UI implementation signal (2026-10-05, commits `78abead8`, `a2085733`):

- `78abead8`: the port (line-leading close read, `afterClose`, brace condition
  `afterClose || indentOf(line) <= declIndent`, textually the backend walk apart from the
  template-literal branch), the docblock rewrite, and the suite probes. `a2085733`: the canary
  header narrowing below (user-approved fold-in). Both verified on main
  (`git merge-base --is-ancestor`), file lists match.
- AC1: the four table rows give module/module/module/module on both copies (HEAD frontend gave
  f/f/f/module). A differential over about 12M generated files (37M + 25M targets) found 0 walk
  divergences between the copies outside dialect-only declaration shapes; a mixed-dialect corpus
  attributes every divergence to a declaration only one dialect recognizes.
- AC2: one rule statement (WHICH BRACE THE WALK SEES) with OUTWARD/INWARD bullets replaces the
  two-boundary paragraph and the "IS handled" sentence; the OUTWARD bullet carries the port's
  inner-block cost. Three adversarial verification rounds planted every shape the bullets name.
  Sentences the port or the new bullet made false were narrowed or deleted beyond the three the
  task names: the walk comment (tracking, re-entry, after-close brace, "fails closed" now per
  allowed key, "silent" dropped from the inward label); the region-pass docblock's "Openers are
  recognized at line start only, which is the same boundary the rest of this module draws"
  (deleted: the walk now also reads after an untracked line-leading close); the rule summary
  ("demonstrably" dropped, "a close the walk reads"); "two shapes the backend copy does not"; the
  isCommentLine cross-reference; sourcesUnder "a deliberate divergence"; in the suite, the
  header's false "both resolve outward to module scope" rationale and "and no other", plus three
  probe comments (width-pin "absorbs", "The residual resolves outward", "every declaration the
  walk tests") and the region-pass OPENER comment's "same boundary the brace walk draws".
- AC3: the SET-EQUALITY bullet now says set-equality fails closed when the wrong key is not
  allowed, that keys alone absorb an allowed wrong key, and that a per-key count pin turns an
  absorbed addition into a moved count.
- AC4: a "Hand-ported sibling." paragraph names `backend/tests/support/enclosing-symbol.ts` and
  the two-way obligation; no which-copy-is-ahead claim, no slug or SHA.
- AC5: eslint dir 2 files / 18 tests green; full frontend unit suite 91 files / 2135 tests green
  (two-level scratch copy; later edits were comment-only); no allowlist change; A/B of the HEAD
  and ported walk over all 88 `frontend/src` files gives symbolDiff=0; zero line-leading closes
  followed by code in `frontend/src` or `backend/src`; the anchor gate on added lines is clean
  (control line fires); babel parse shows the block-comment count unchanged (no escaped close
  ended a docblock early).
- User decisions (2026-10-05): (1) four surviving mutants of the new arm (close read widened to
  `includes`, `afterClose` hoisted out of the per-line loop, the opener test skipped after an
  untracked close, `lastIndexOf` in the slice) are DISMISSED as preemptive hardening; the backend
  suite has the same gaps. (2) The canary header's "an unresolvable or wrongly resolved symbol
  fails closed as an unexpected member" overclaim was folded in (`a2085733`, "or wrongly
  resolved" deleted).
- Code review: not run here; agents/ui/CLAUDE.md assigns it to the architect at intake.
- Out of scope, for follow-up filing (backend twins of sentences narrowed here, all in
  `backend/tests/support/`): `blockCommentInterior`'s "Openers are recognized at line start only,
  which is the same boundary the rest of this module draws" (false there since the backend walk
  reads after an untracked line-leading close); the WHICH BRACE tracking sentence lacks
  "multi-line" (a self-contained `/* note */ }` reads as tracked); the walk comment's "A `}`
  leading the code after a close ends the declaration WHATEVER the line's indentation" lacks
  "the walk reads"; the rule summary's "demonstrably" and its unqualified "after a comment
  close"; the INWARD item "the close of a comment opened mid-line" and the walk comment's "does
  not see a comment opened mid-line" lack "after other code"; the INWARD item "a `}` indented
  right of its own declaration" (a `}` after a read close is taken at any indentation); the suite
  comment "OPENER, line start only: the same boundary the brace walk draws". The frontend twin of
  the backend sibling task's item 2 also stands: the file docblock's "in the canary that consumes
  it" omits the module's own suite (incomplete, not false).

## The WoT auto-accredit decides "already accredited" from a stale cache (archived 2026-10-08): clean review; one P3 contract-doc line fixed in place, five follow-ups folded into open tasks, three items already covered

### Architect archive note (2026-10-08)

- **Review:** `/ce-code-review` full path on `dc14b5e6`, `72e96c3a`, `e07c3716`, `4f47b955` and the learnings commit `cc3c3498` (branch-remote, base `905a3d7d`): correctness, security, adversarial (in-process, no cross-model peer), testing, project-standards, api-contract, reliability, learnings. Verdict "Ready with fixes", no code defect; every scope item and AC met. Adversarial reproduced AC1 (base src with the head spec broadcasts for the email, wot and method-less cases; head skips). Testing killed all nine planted mutants; the orchestrator checked the mutation script against the brief. Security found the regex equivalent to hived's account-name rule and linear on a 1M-char input; `self_pinned` never leaves the process.
- **Fixed in place (`545e02e9`):** the `/vouch` and `/retract` `BAD_REQUEST` lines and the `accreditation_method` null clause in `api-contracts/accreditation.md`; ARCHITECTURE § 2 gains "WoT auto-accreditation" in the implementer's narrower wording (the skip misses an op not yet indexed), and the whitelist paragraph plus CONCEPTS "Vouch", "Accreditation Authority Whitelist", "Active Accreditations" and "Accreditation Method" now say vouches count against `accred_pinned` holders, not the live membership view.
- **Folded into open tasks:** the `VouchStatus.accreditation_method` docblock (item 21 of `backend-accreditation-wot-comment-and-dead-code-pass`); line-number anchors in `wot-vouch-broadcast-outcomes.test.ts` and two inaccurate comments in `wot-broadcast-timeout.test.ts` (`backend-wot-comments-cite-deleted-retract-suite`); the clause (c) companion for the `hasUnliftedSanction` mock (note on `backend-failed-sanction-read-is-not-a-sanction`); release must leave `accred_pinned` (note on `backend-accreditation-release-op`). `backend-wot-enrollment-has-a-single-trigger` moved to `pending/` with a name-check and fresh-read note.
- **Dismissed as covered:** the dead `wot-retract-cascaderevocation` citation (`backend-wot-comments-cite-deleted-retract-suite`), the same-block sanction tie in `hasUnliftedSanction` (`backend-accreditation-release-op` Scope 2 and item 14 of the comment pass), the SHA and slug in the vouch-three-senses entry (`architect-solutions-entries-carry-coordination-context`). Dismissed: the "Vouch Threshold" symmetry edit, listing `routes/wot.ts` in the limiter-convention entry, a `/vouch` twin of the limiter-slot spec (declined in the implementer's triage).
- **Learnings checkpoint:** no solutions entry is contradicted by the change; the implementer's `cc3c3498` refresh of two entries holds against the code. Nothing new for `/ce-compound`.

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Filed from the accreditation and Web of Trust audit (finding 5, with finding 20 and one item from
its residual list). Five reviewers reported it independently and the validator confirmed it from
the code. It was read from code, not exercised against a chain.

## Why

`broadcastWotAccreditation` (`backend/src/wot.ts`) skips the broadcast when
`getAccreditedSet([vouchee])` contains the vouchee. `getAccreditedSet`
(`backend/src/accreditation.ts`) answers from the `accredited_accounts_all` cache entry whenever
that entry is present. The entry is in the stable tier with a 10-minute TTL: `clearVolatile` does
not flush it, and no `hafCache.invalidate` call in `backend/src` names it. So for up to 10 minutes
after an account's accredit op is indexed, the cached set can still lack that account.

Inside that window, for a vouchee at or above the vouch threshold:

1. Every `POST /api/wot/vouch` that names the vouchee, from any accredited caller, broadcasts
   another admin-signed `method: 'wot'` accredit op. The route calls `broadcastWotAccreditation`
   whether or not the caller's own vouch surfaced in the poll, and `wotWriteLimiter` admits 10
   calls per minute per account.
2. If the vouchee's current accredit op is authority-pinned (`email`, `orcid` or `manual`), the new
   `wot` op becomes the account's latest accredit op. `accred_latest` in
   `activeAccreditationsCteBody` (`backend/src/hafsql.ts`) takes method and metadata from the
   latest accredit op, so the account becomes a WoT member: its name is its username, its
   institution is "Web of Trust", its field is empty, and its membership follows the live vouch
   count. When those vouches are retracted the account is no longer accredited.

## Scope

1. `broadcastWotAccreditation` broadcasts only when the vouchee has no row in `accred_pinned`,
   that is, no current, not-sanctioned accredit op of any method. Take that from HAF in the same
   read that decides eligibility, not from `getAccreditedSet`. `getVouchStatus` already reads
   `accred_pinned` for the vouchee (the `self_method` subquery in `vouchStatusSelect`), and
   `pollForVouch` busts that cache entry before the route calls `broadcastWotAccreditation`.

   Carry row presence, not the method value. `self_method` is the op's `method`, which is SQL
   NULL for an accredit op that carries no method, while `accred_pinned` still holds that account
   (`activeAccreditationsCteBody` treats an absent method as an authority op). A check on
   `accreditation_method !== null` alone would broadcast over such an op.

   Why a row means "do not broadcast": an authority-pinned row is accredited, and a `wot` row is
   already enrolled, with its standing recomputed from the vouch graph on every membership read.
2. Keep the `hasUnliftedSanction` refusal. A sanctioned account has no `accred_pinned` row, so it
   still reaches that guard.
3. Delete the `getPool()` fetch and its `skipped` return that sit between the sanction guard and
   the `try` block. Nothing reads `pool` there.
4. `POST /api/wot/vouch` and `POST /api/wot/retract` check `vouchee` for type and length (at most
   50 characters) only, and their 400 message says it "must be a valid Hive username". Given
   threshold vouches on chain from accredited accounts that name an arbitrary string, the admin
   key signs an accredit op whose `account` is that string. Validate `vouchee` with `HIVE_ACCOUNT_NAME_REGEX`
   (`backend/src/lib/hive-account-name.ts`) in both handlers.
5. The docblock on `broadcastWotAccreditation` says the broadcast "only fires on the FIRST
   threshold crossing". Cut that sentence down to what the new guard does. Delete rather than
   extend.

## Out of scope

- The seconds between a broadcast and HAF indexing it. A second call in that gap can still
  broadcast. Do not add an in-process guard for it, and do not write a comment that says the gap
  is closed.
- `getAccreditedSet` itself and its other callers. The voucher gate on `/vouch` and `/retract`
  keeps its cached read. `handleAccredit` in `routes/orcid.ts` and the resume probe in
  `routes/signup-verify.ts` read the same set for the caller's own account and stay as they are.
- A periodic enrollment sweep. That is `backend-wot-enrollment-has-a-single-trigger`, sequenced
  behind this task.
- `VouchStatus.accreditation_method` stays in the response.

## Acceptance criteria

1. With `accredited_accounts_all` warm and lacking the vouchee, an eligible vouchee that holds
   (a) an authority-pinned accredit op, (b) a `wot` accredit op gets no broadcast. The spec runs
   the real `getAccreditedSet`, not a mock of it. State in the signal block that the same spec
   broadcasts in both cases against the code before this change.
2. An eligible vouchee with no accredit op and no sanction gets exactly one broadcast. A
   sanctioned vouchee still gets `reason: 'sanctioned'`.
3. `/vouch` and `/retract` answer 400 for a `vouchee` that fails `HIVE_ACCOUNT_NAME_REGEX`.
4. Comments follow root `CLAUDE.md` "Comment anchors".

## [TODO Architect] at archive

- State in `ARCHITECTURE.md` § 2 that the WoT auto-accreditation never broadcasts over an
  existing accredit op.
- Move `backend-wot-enrollment-has-a-single-trigger` from `blocked/` to `pending/`.
