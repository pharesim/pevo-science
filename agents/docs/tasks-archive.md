## Eleven learnings name one canary, and the cite graph between them is partial (archived 2026-09-23) — decided: catalog README, no suffix on new filenames; no implementer rounds

### Architect decision (2026-09-23)

Shape chosen: a catalog `README.md` at `agents/docs/solutions/README.md`, with a section for the
canary listing the eleven and the question each answers, ordered by date. Not a hub entry: a hub is
a refresh candidate every pass, fits neither track template, and duplicates the `CONCEPTS.md` term
"Source-discipline canary", which already carries the cluster's substance in prose. Not a header
block in the canary: the file is backend zone, the newest entries came from all three roles, and
the refresh never edits product code, so the author of entry twelve usually could not maintain it.
The catalog is the one artifact in the store the refresh maintains mechanically (rows rewritten on
rename, move, consolidate, delete). `/ce-compound` has no catalog handling, so the obligation to
add a row lives in root `CLAUDE.md` "Documented Solutions", which every run reads: the run that
writes the entry appends the row in the same commit, and the architect reconciles at each refresh.
A backend task (`backend-canary-docblock-points-at-solutions-catalog`) adds a stable pointer from
the canary's docblock to the catalog section, by path only, so it never changes when an entry lands.

Category shape: not a signal. One artifact attracting many entries is the norm in a flat store of
224; `routes/papers.ts` is named in 61 and the canary in 11, rank 15. Directory moves would break
code citations the refresh does not rewrite. The decision is written in the README's header, which
is where a refresh meets it; the observation itself stays report-only and is dismissed against it.

Filename suffix: new entries carry none, per the creation skill's explicit rule (plugin updated
2026-08-31; the five undated names all date 2026-09-22, and a dated one landed today, which is the
flip-flop). The 219 dated names are not renamed. No citation anywhere used the wrong spelling for
any of the five. Recorded in the README and in `CLAUDE.md`.

Graph evidence: 55 pairs among the eleven, 8 mutual, 15 one-way, 32 silent; one hop from a door
reaches a median of 3 siblings; following links transitively reaches 9 or 10 from every door but
the oldest, which cites none of the others. The frontmatter already groups the set (`module`
containing `backend/tests/eslint` on 13 entries in five spellings; tag `canary-tests` on 15); the
spellings were left alone, the catalog names them as query keys.

**Owner:** architect
**Created:** 2026-09-23

Filed by backend out of the `/ce-compound-refresh` pass over the `backend/tests/eslint`
cluster, at the user's direction. Two investigation batches raised it independently and
neither would recommend a shape, because neither had evidence for one. The refresh applied
its per-doc edits and left this open.

## Why

Eleven entries under `agents/docs/solutions/conventions/` name
`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`. That
is the most-documented artifact in the store, out of 224 convention entries, and it is
still accreting at roughly one entry per review round.

Each entry is individually well-differentiated. The refresh tested every merge candidate
against the retrieval-value test and every one failed it: the entries answer genuinely
different questions about the same file (should this fact be hand-lexed, how are the
parser's per-line answers consumed, how is a cost probe read, how is a bound described in
prose, what does a differential's regression list mean, which assertion shape is
fail-closed, and so on). Consolidation is the wrong instrument here and the refresh did
not apply it.

What is weak is retrieval and the cross-reference graph, not the content:

- A maintainer who arrives with "why is my canary green" meets eleven doors into one room,
  and the door they pick decides which siblings they learn about, because each entry
  cross-references a different subset.
- The graph is partial in both directions. The refresh closed two gaps it had evidence
  for, and left others standing: the fail-closed sentinel entry and the restated-bound
  entry describe the same reader's machinery and are mutually silent.
- Three of the eleven landed within the last week, so whatever shape is chosen has to
  survive the next round rather than describe this one.

## Scope

1. Decide whether this cluster wants a shape beyond per-entry cross-links, and say which
   on the evidence rather than on taste. The two candidates the refresh surfaced are a hub
   entry for the file's learning ladder, and a standing "read these together" block in the
   canary's own header. They are not equivalent: a hub is one more entry that can itself go
   stale, while a header block sits in the file every implementer already opens and is
   maintained by whoever edits the canary.
2. If the answer is neither, say so in a form later refreshes can read, so the question is
   not re-raised every pass. The category-shape observation is report-only for a refresh,
   which means it returns until something settles it.
3. Whichever shape is chosen, decide who maintains it when entry twelve lands, and where
   that obligation is written down.
4. Consider whether this is a category-shape signal rather than a per-file one. If one
   artifact can accrete eleven entries in a directory of 224, the question of when
   `conventions/` wants sub-structure is the general form, and it is the architect's to
   answer.

## Acceptance criteria

1. A decision is recorded where the next refresh will meet it, naming which shape was
   chosen and why the alternatives were not.
2. If a shape is adopted, it exists: the hub entry, or the header block, with the eleven
   entries reachable from it.
3. The decision says what happens when the next entry on this file lands.

## Notes

The eleven at filing time:

- `a-parsers-line-is-not-the-readers-line-unless-built-from-the-same-split`
- `a-readers-bound-restated-at-n-sites-reads-as-sufficient-at-each`
- `backtracking-probe-terminator-must-defeat-the-pattern-tail`
- `belt-and-braces-guard-absorbs-upstream-mutation-pins`
- `canary-reader-takes-typescript-facts-from-the-parser-not-a-hand-written-lexer`
- `differential-fuzz-regressions-after-removing-a-compensating-misread-are-triaged-by-trigger`
- `new-fail-closed-outcome-must-not-reuse-an-existing-sentinel`
- `shared-constant-unification-is-not-membership-coverage`
- `source-discipline-canaries-must-assert-at-call-site-not-file-granularity`
- `source-discipline-canary-comment-normalization-and-lens-vs-probe-coverage`
- `sql-grammar-questions-are-settled-against-a-nonexistent-relation`

A related observation, same pass, that may or may not belong with this decision: five of
the 224 convention entries carry no date suffix in their filename, all written on
2026-09-22, by all three roles. The `/ce-compound` skill instructs no suffix while the
corpus overwhelmingly carries one, nothing enforces either, and each run's context
analyzer resolves the conflict on its own. Cross-links are by filename, so the store now
has two spellings a citation can take.

## UI-HASPASSWORD-FACTOR-RESOLUTION-DIVERGENCE — Reconcile the hasPassword re-auth factor resolution across surfaces (archived 2026-09-23) — 5 rounds; consolidation at 5cd378dc + 6a1ac9f1; holds landed at ab5a2fac + bc3d6095 (r2), 46463131 (r3), e8948317 + a8e54b2b + 44f7b27b + 9d617808 (r4); round-5 re-review clean ✓

### Architect archive note (2026-09-23, round 5)

Reviewed via `/ce-code-review` on `e8948317`, `a8e54b2b`, `44f7b27b`, `9d617808`
(frontend paths only): correctness, project-standards, testing, security,
in-process adversarial, frontend-races, learnings, plus one independent validator.
Every probe ran in an isolated copy of the reviewed head, never the shared tree.

**Both round-4 items are verified genuinely landed.** Independently confirmed, not
taken from the signal: the retirement is exactly "second consecutive UNAUTHORIZED
under an observed factor" (reachable only past the first catch's non-UNAUTHORIZED
throw and the assumed-branch return), sits after the teardown check, and is
inherited by all three mint surfaces because the only `reauthModal` prompt in
`src/` lives inside `mintViaPasswordFactor`, so no re-prompt ladder can bypass it.
`clearPasswordFactorMemo` has exactly the two production callers the docblock
names. Write-on-success is asserted on all three surfaces. All five disclosed
mutation kill sets reproduced exactly (three reviewers, independently); baseline
186 across the six named suites; full suite 83 files / 1847 tests and a clean
build in an isolated archive (the three unhandled rejections are the disclosed
pre-existing `pages/edit.js` ones). Standards clean (anchor gate replayed over
all 212 added lines); security clean (every producer of `UNAUTHORIZED` at the
retry mint traced; both factors verified server-side per § 6.5 #2, so a stale or
retired memo is neither an oracle nor a bypass). The `_adoptSubject` same-subject
claim in the auth.js comment is accurate.

**One finding raised, dismissed by the user with the mechanism verified.** Three
lenses converged on the same line: a second, independent mint flow for the same
account that opens its prompt inside the first flow's retry-mint round-trip (the
singleton modal frees its slot on submit, before the mint settles) has its
freshly verified memo nulled by the first flow's second rejection, or its
pending write vetoed by that clear's generation bump. Cost: one status re-read
on the next resolution; the compounding case (that re-read rate-limited, then
one more mistype navigating to ORCID) is the single-flow trade rounds 3 and 4
already accepted. Not reachable at human speed: the second re-auth action must
be triggered, typed, and minted inside a sub-second network window. Mirror image
of round 4's dismissed joiner-carries-assumed race. If it ever needs closing, the
minimal shape is a dedicated mint-success counter captured at helper entry,
retiring only if unchanged and without bumping the generation, plus one
two-overlapping-flights test; widening the generation to bump on writes is sound
but invasive.

**Residuals recorded, not held:** a dead-JWT 401 on both attempts retires the
memo (one read after the re-login the user needs anyway); the `_passwordFactorMemo`
docblock's "pays one extra status read" sentence holds only when the status
endpoint answers; the hold's "three-way coincidence" is two-way in practice (tab
B's recovery writes SESSION_KEY, tab A's storage event runs `_adoptSubject(same)`
with no scrub), which makes the landed eraser more valuable than the hold argued;
a coded non-UNAUTHORIZED retry rejection is not pinned as leaving the memo
standing (a `retryErr?.code` truthiness mutant survives; both real outcomes
benign); the "leaves the memo standing" negative is pinned on one surface only
(defensible: shared helper, no per-caller branching).

**Architect follow-ups at archive:** the § 6.4 doc pass reserved since round 2
(unknown-status fallback direction, assumed-401 ORCID fallback, mint-success memo
upgrade, second-consecutive-rejection retirement) and `/ce-compound-refresh` of
`solutions/conventions/fail-closed-guard-must-replace-the-recovery-a-round-trip-provided-2026-09-07.md`,
whose one-caller count for `clearPasswordFactorMemo` is stale (two callers now;
conclusion intact).

---

# Reconcile the hasPassword re-auth factor resolution across surfaces

**Owner:** ui
**Created:** 2026-08-27

Routed out of the architect review of `e9512840` (light-account re-auth window).
Not held on that task: the code it landed is on the *correct* side of this
divergence, and the surfaces that need changing are outside its scope.

## Why

Four places independently resolve whether an account has a password, and they
disagree about what to do when the answer is unavailable. The re-auth factor a
user is offered therefore depends on which surface they happen to be on.

- `lib/fresh-auth.js` (`accountHasPassword`): only an explicit `hasPassword === false`
  routes to ORCID. An unknown or failed status falls through to the password
  prompt and lets the backend reject a genuinely passwordless account.
- `lib/settings-fresh-auth.js` (`usesPasswordFactor`): returns
  `action !== 'set_password' && hasPassword`, so a falsy value routes to ORCID.
- `pages/settings.js`: reads `hasPassword === true` strictly, and on a failed
  status fetch substitutes `{ hasEmail: false, custody: 'self', hasPassword: false }`.
- `pages/admin.js`: initialises `hasPassword: false` and sets
  `hasPassword: emailRes?.data?.hasPassword === true`.

So one transient `fetchEmailStatus` failure sends a state-B user to a password
modal on publish and to a full-page ORCID redirect on change-email. The redirect
is the destructive branch: it discards page state, which is precisely what the
window work set out to stop doing to people.

`fresh-auth.js` has the posture the project wants. The others predate it.

## Scope

1. Make one resolver canonical. `accountHasPassword` in `lib/fresh-auth.js` is
   the natural home; it already memoises per username for the tab. Have the
   settings, admin, and settings-fresh-auth paths consume it rather than each
   fetching and caching their own answer.
2. Reconcile the failure direction to the password-prompt posture: only an
   explicit `false` may route to ORCID. Unknown, failed, or absent falls through
   to the password prompt and lets the backend reject.
3. Preserve the one legitimate exception: `set_password` targets a null-hash
   account by definition, so ORCID is its only registered factor regardless of
   what the status says. Keep that branch, and make it read as the deliberate
   exception it is rather than as a case of the general rule.

## Acceptance criteria

1. Exactly one function in the frontend resolves `hasPassword` for factor
   selection; the settings, admin, and settings-fresh-auth surfaces call it.
2. With `fetchEmailStatus` failing, a state-B user attempting change-email gets
   the password prompt, not an ORCID redirect.
3. `set_password` still routes to ORCID for a passwordless account.
4. The memo cannot be inherited across a logout and re-login as a different
   account (it is username-keyed today; keep that property under the unification).

## Notes

Consider clearing the memo in `auth.disconnect()` alongside the window cache
while in the area. It is username-keyed so cross-account inheritance is not
reachable, but a stale positive can outlive the only transition that drops a
password (`recover(orcid, no new_password)`, which moves B to C per
`ARCHITECTURE.md` § 6.3). That transition runs through a real navigation today,
which resets module state, so this is tidiness rather than a live bug.

---

**UI implementation note (2026-08-31):**

Landed at `5cd378dc` (+ a comment-tightening follow-up commit).

Scope grew by one surface. The task enumerates four resolvers; the code had
