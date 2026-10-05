## Custody routes trust a token's light claim for a row that was never light (archived 2026-10-05) — one review round; the four light-claim custody routes gate on the row's derived claim; R1 and R3 filed as backend-custody-row-gate-overclaim-and-upgrade-write-predicate; R2 and R4 dismissed

### Architect archive note (2026-10-05)

Review of c18d37cf with /ce-code-review (full: correctness, security, in-process adversarial,
testing, project-standards, learnings; the validator batch was empty). Clean: no primary findings,
Scope 1 to 3 and AC 1 to 4 met. Orchestrator probe on a git-archive copy of c18d37cf:
custody-state-g-light-claim.test.ts 4/4 green, and 4/4 red with the four row checks disabled
(broadcast 500, fresh-auth 200, session-auth 200, upgrade 401), matching the signal block.
Security and correctness reproduced that control; correctness ran the AC 2 suites green.

Triage (user: "as recommended"):
- Filed backend-custody-row-gate-overclaim-and-upgrade-write-predicate (low). R1: the two
  custodyClaimFor docblock sentences and the orcid.ts handleLogin sentence say every light-claim
  route re-reads the row and refuses it, while /broadcast answers an idempotency hit with 200
  already_landed before its row read. R3: the /upgrade UPDATE has no state predicate, so a G row
  swapped in during the getAccounts await would still be moved to D.
- Dismissed: R2 (AC 1's wording against the /broadcast idempotency-hit path; the specified
  outcome, nothing signed or written); R4 (the SPA upgrade wizard under a stale light claim for a
  G row broadcasts account_update and then gets the 403; it needs two devices plus a delete and a
  Keychain re-add inside one JWT's life, and the wizard confirms the new seed first).
- [TODO Architect] ARCHITECTURE.md § 6.2 State G and the § 6.4 /fresh-auth and /upgrade rows:
  rewritten in the archive commit to describe the row-derived gate.
- Compound: no (the stale-light-JWT path is recorded in ARCHITECTURE.md § 6.2 State G).

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Surfaced by the architect re-review of the state-G account-state comments task and approved
for filing by the user on 2026-10-05.

## Why

The four custody routes that act on a light claim (`POST /api/custody/broadcast`,
`/fresh-auth`, `/session-auth`, `/upgrade`) gate on `req.hiveCustody === 'light'`.
`verifyHiveSignature` takes that value from the presented JWT. From the row, each route reads
`upgraded_at` (plus `password_hash` on the two proof routes, and the encrypted posting key on
`/broadcast`) and refuses a row with an epoch. That refuses every upgraded row. It does not
refuse a row that was never light. A state G row (ARCHITECTURE.md § 6.1) has `custody` NULL and
no `upgraded_at`, so only the token's claim stands between it and these routes.

A `'light'` JWT can reach a G row:

1. A light account (A, B or C) is deleted through `DELETE /api/settings/email`. Deleting the row
   deletes its `sessions_invalidated_at` with it, so `verifyHiveSignature` has no epoch to
   revoke the account's JWTs against.
2. `POST /api/auth/session` re-mints whatever claim the presented token carries, with a new
   `iat` and a full expiry, so the token can be kept alive.
3. The same username registers an email through the settings add flow (Keychain signature
   path). The INSERT stamps no `sessions_invalidated_at`, so the old token is still live.
4. Once the G row's email is verified and it has a password (ORCID linked, then
   `POST /api/settings/set-password`), the light JWT plus that password mints a consent-kind
   proof at `/fresh-auth` (for example `change_email` or `delete_account`, which the settings
   mechanism check accepts because it reads only `password_hash` and `orcid`) or opens a
   session window at `/session-auth`.
5. `/upgrade` needs no password. The light JWT plus a signature from a key in the account's
   on-chain key set moves the G row to `custody = 'self'` with `upgraded_at` set: the UPDATE
   is `WHERE username = $1` with no state predicate. § 6.3 lists no G → D transition. If the G
   row's email is still unverified, the result carries a hex `verify_token` and an epoch, a
   combination § 6.1 does not enumerate (§ 6.5 invariant #4).

Nothing is escalated today. Step 4 needs the G row's password, step 5 needs the owner's key,
and `/broadcast` fails for a G row because it holds no encrypted posting key. The defect is
that the routes rest their authority on a claim the row no longer backs, and the code's own
descriptions state a rule the code does not implement:

- `routes/settings.ts`, both fresh-auth factor tables (the POST /email and DELETE /email
  headers), the State G line: "'orcid' when linked (the password issuer refuses its non-light
  claim)". This wording came from an architect hold, not from an implementer miss. It becomes
  true once the issuer refuses the row.
- `lib/custody-claim.ts`, the `custodyClaimFor` docblock: "Every route that ACTS on a light
  claim re-reads `upgraded_at` itself and refuses a row that carries one", and the closing
  paragraph's "each of those re-reads the epoch and refuses the row the copy names". Both hold
  for an upgraded row and say nothing true about a G row, which has no epoch to re-read.
- ARCHITECTURE.md § 6.2 (State G) and § 6.4 (the password fresh-auth row and the upgrade row)
  now record this divergence and the intended gate.

## Scope

1. In each of the four routes, refuse the row unless `custodyClaimFor(row) === 'light'`: add
   `custody` to the row SELECT the route already makes and call the helper on that row. Keep
   the token-claim check where it is (it answers a `'self'` token without a row read), and keep
   each route's existing `upgraded_at` branch and its response unchanged, so a D row answers
   exactly as it does today. The new refusal sits after the `upgraded_at` branch and answers
   with the response the route already gives a non-light token claim: no new status, code or
   message, and no write.
2. Re-read the settings.ts State G line in both tables against the new gate, and correct the
   `custodyClaimFor` docblock so it states the rule the routes now apply (the row's derived
   claim, with the epoch branch answering first). Sweep `backend/src` and `backend/tests` for
   other comments that say these routes refuse by `upgraded_at` alone or that a G row's JWTs
   cannot carry a light claim, and report what the sweep found.
3. Tests: for each of the four routes, a G row (username set, `custody` NULL, no
   `upgraded_at`) presented with a `'light'`-claim JWT is refused with the non-light response,
   and the row is unchanged afterwards (for `/upgrade`, `custody` and `upgraded_at` still
   NULL). The existing light-row and upgraded-row cases must keep passing unchanged.

## Acceptance criteria

1. A G row presented with a `'light'` JWT gets the route's non-light refusal from
   `/broadcast`, `/fresh-auth`, `/session-auth` and `/upgrade`: no proof, no session window, no
   broadcast, no row write.
2. A/B/C rows with a light JWT and D rows behave exactly as before (same statuses, codes and
   messages).
3. Every comment that describes these gates is true against the new code, including the
   settings.ts State G line and the `custodyClaimFor` docblock.
4. Comment-anchor conventions hold (root CLAUDE.md "Comment anchors").

## Backend implementation signal (2026-10-05, commit c18d37cf)

**Gate (AC 1, 2).** In `POST /api/custody/broadcast`, `/fresh-auth`, `/session-auth` and
`/upgrade` the row SELECT now reads `custody`, and after the unchanged `upgraded_at` branch the
route refuses the row unless `custodyClaimFor(row) === 'light'`. Each handler declares one
`refuseNonLight` closure that both the token-claim check (still first, still before any row
read) and the new row check call, so the two answers are identical by construction. No write
precedes either refusal. `/broadcast` keeps its existing order: the fresh-auth proof is consumed
before the row read, as it already was for a D row.

**Tests (AC 1, 2).**
- New `backend/tests/routes/custody-state-g-light-claim.test.ts`, mock-free. Per route: a
  verified G row with a password and an ORCID, the same request under a `'self'` and a `'light'`
  JWT. It asserts both answers are the route's 403 FORBIDDEN non-light envelope, byte-equal, and
  that a row snapshot (custody, upgraded_at, password_hash, orcid, verify_token,
  sessions_invalidated_at, updated_at, both key columns) is unchanged. `/fresh-auth` and
  `/session-auth` also pass `expectNoSessionProof`; `/upgrade` also asserts custody and
  upgraded_at still NULL.
- Red before the gate (first draft, chain key set stubbed): `/broadcast` 500 "Posting key not
  available", `/fresh-auth` 200 with a proof, `/session-auth` 200 with a window, `/upgrade` 200
  with the row moved to custody 'self'. The committed mock-free file, probed with the four row
  checks disabled: 500 / 200 / 200 / 401 (the live chain lookup), all four red.
- AC 2: the 27 files that drive these routes or the helper passed (453 tests) with no assertion
  changed. Four mocked-pool fixtures modelled a light row without the `custody` column and so now
  derive `'self'`; they gained `custody: 'light'` (`custody.test.ts` default row,
  `custody-idempotency.test.ts`, `custody-session-auth-argon-errors.test.ts` seed).
- `no-custody-claim-derivation-outside-helper.test.ts` pins the helper's caller set; the four
  routes join `ALLOWED_HELPER_CALL_SITES`. That file is also the subject of
  `backend-custody-canary-unpinned-surfaces` in `review/`; this commit touches only the caller
  list, its docblock, the mint-list docblock's first sentence and one assertion message.

**Comments (AC 3, 4).** Rewritten: the `custodyClaimFor` docblock (the "what per-read excludes"
paragraph and the closing paragraph now state the derived-claim rule with the epoch branch
answering first), both settings.ts State G lines ("its" became "the row's"), and the
`handleLogin` sentence in orcid.ts that gave the `upgraded_at` re-read as the reason a minted
claim needs no re-check.

Sweep, as asked: four read-only finders (by route path, by the epoch, by the claim, by state G)
over `backend/src`, `backend/tests` and, report-only, `agents/docs/api-contracts/`, 228 comment
sites judged, then two skeptics per flagged site. Nine sites upheld, two refuted.
- Fixed in this commit:
  - `custody.test.ts` `/upgrade` outer-catch spec: "SELECTs only `upgraded_at`" deleted (its
    task-slug prefix went with it).
  - `custody-upgrade.test.ts` missing-row spec: "after the SELECT shape change to just
    `upgraded_at`" deleted (its hold ordinal went with it).
  - `custody-session-auth-argon-errors.test.ts`: the header's column list deleted.
  - `no-custody-claim-derivation-outside-helper.test.ts`: "The helper callers that also mint" is
    no longer true now that `/upgrade` calls the helper and mints a literal; narrowed to "whose
    mint binds the helper's result", and one assertion message to "mints a variable claim".
  - `custody-non-consent-fresh-auth.test.ts` header: "State D: broadcast -> 403
    ALREADY_UPGRADED regardless of proof" became "403 FORBIDDEN". Pre-existing and false before
    this change (ALREADY_UPGRADED is `/upgrade`'s 409, and a missing proof answers 401 first);
    fixed under AC 3 because it describes the `/broadcast` gate.
- Refuted, true as written: orcid.ts "in steady state the shape reaches them only on a state C
  row", and the `custody-fresh-auth-null-hash.test.ts` header.
- No comment says a G row's JWTs cannot carry a light claim.
  `orcid-state-g-unverified-email.test.ts` "Keychain-derived JWTs carry the self claim" is scoped
  to Keychain-derived tokens and true.
- Only the four custody routes read `req.hiveCustody` to grant anything; `POST /api/auth/session`
  carries it forward. No other route has this defect.

**[TODO Architect] ARCHITECTURE.md now describes the old behaviour** (architect zone, not
edited):
- § 6.2 State G: the "Intended: ... Divergence today: ... A backend task moves those gates onto
  the row's derived claim" passage.
- § 6.4 password fresh-auth row: "A G row is refused only through the token's claim today ...;
  the intended gate is the row's derived claim."
- § 6.4 upgrade row: "but today a `'light'` JWT left over from an earlier light row of the same
  username passes the claim gate".

**Verification.**
- `npm run typecheck` clean. `npm run lint`: 0 errors, one pre-existing warning in
  `lib/author-supersession.ts`.
- Full backend suite, run once before the sweep and simplify edits: 20 failed / 2710 passed in
  10 files.
  - Seven of those files fail on clean main per earlier baselines: idempotency-real-haf,
    papers-enrichment-parity-gate, accreditation-idempotency, profile-auth-bypass,
    cast-hardening-author-index-weight, accreditation (the two cap specs), reviews (the two gate
    specs).
  - `signup-verify-orcid-binding-guard` passes alone.
  - `fresh-auth-consent-op-burn-offline-queue` fails alone too, but its import graph (config,
    redis, lib/fresh-auth, logger, response, body-record, hive-permlink) holds no file this
    commit changes.
  - `no-unresolvable-carve-out-companion-citation` was this change's (the first draft's clause
    (c) prose); fixed by making the new file mock-free.
- After the final edits: the 13 affected files (the new suite, the four route suites whose
  fixtures or comments changed, the session-auth, null-hash, orcid and settings-email suites, and
  the derivation, citation and comment-anchor canaries) pass, 230 tests. The one orcid.test.ts
  lock-release spec that failed in that batch passes alone; the orcid.ts diff is comment-only.
- `/ce-simplify-code` ran (reuse, quality, efficiency): 7 applied, 2 skipped (hoisting a message
  literal that was already duplicated before this change; the two NULL asserts AC 1 names).
- Code review: not run by backend; the architect runs `/ce-code-review` at intake.

## Pin the custody-derivation canary's unpinned surfaces (archived 2026-10-05) — two review rounds; four scope items landed with a 43-mutant record; four prose hold items fixed; one confirmed P3 and three implementer triage items filed as backend-custody-canary-docblocks-overclaim-coverage

### Architect archive note (2026-10-05)

Re-review of ab6fe37b with /ce-code-review (full: correctness, in-process adversarial, testing,
maintainability, project-standards, learnings, one validator). Hold items 1 to 4 (the 2026-10-01
hold and the 2026-10-05 addendum) are all met, and the user-approved deletions and narrowings
are true at ab6fe37b. Orchestrator run on a git-archive copy of ab6fe37b: tests/eslint/ 9 files,
146 tests, exit 0. One confirmed P3: the STATEMENT_JOIN_CAP docblock ("steps over comment lines
for free", "stepping over prose costs nothing there") and one probe comment still claim every
comment line is free, while statementFrom joins a line isCommentLine reads as live, such as an
unstarred line inside a block comment.

Triage (user: "as recommended"):
- Filed backend-custody-canary-docblocks-overclaim-coverage (low): the P3, plus three items from
  the implementer's "for architect triage" list: the typed destructure against "absolute" and
  "every spelling", parenthesised and cast ternary branches against the two ternary descriptions
  (prose only), and the walk-cap "twelve or more consecutive comment lines" sentence.
- Dismissed: the EPOCH_TERNARY_RE pattern change (no instance in backend/src); the scan-2
  over-matches (safe direction, the listed examples unseen as written); the adversarial note that
  the signal's "a derivation REPLACING a helper call is red in scan 1" fails at POST /recover (the
  code text is true there, only the signal's rationale was wrong); the "four row-reading mints"
  count (true at HEAD, and the hold prescribed it).
- Compound: no (a-readers-bound-restated-at-n-sites-reads-as-sufficient-at-each.md covers it).

**Owner:** backend
**Created:** 2026-09-08
**Priority:** low

Routed out of the round-5 architect review of
`backend-custody-column-self-alignment`. All four items are pre-existing, on
surfaces that task's diff never touched. Filed separately rather than held so
a task otherwise finished after two small fixes does not grow two more rounds.

## Why

`backend/tests/eslint/no-custody-claim-derivation-outside-helper.test.ts` is a
merge-blocking guard: it scans `backend/src` and refuses a second derivation of
the JWT `custody` claim outside `custodyClaimFor`, and refuses a row-reading
mint that does not use it. Its failure mode is not a crash. It is going green
while the guard is dead.

Four of its surfaces are currently unpinned, each verified by execution during
the round-5 review rather than reasoned about:

1. `JWT_MINT_RE` is referenced exactly twice, at its definition and at the mint
   scan. Every other scanner in the file carries planted positives and
   negatives, and the sibling canary
   `no-session-proof-mint-outside-reauth-routes.test.ts` pins its identical
