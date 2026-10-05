## The loose-claim guard accuses the prose its own docblock cites as protected (archived 2026-10-05) — one hold; archived at 3b98e303 with two findings dismissed

### Architect archive note (2026-10-05)

Re-reviewed 3b98e303 against its parent with /ce-code-review (focused: orchestrator correctness,
standards and requirements read plus one independent in-process adversarial read). All three
items of the 2026-10-01 hold are fixed as prescribed. Canary 11/11, exit 0, on an isolated copy.
Narrowings (a) and (b), rebuilt from the header's own wording, reproduce the signal exactly:
alone red at the accusedProse pin, re-pinned red at droppedNearMiss, loop removed green. The
new `unparsed` message is true: ratchetClass returns exempt before unparsed.

Two findings, both dismissed by the user ("as recommended", 2026-10-05): (P2) a lower-case-only
variant of narrowings (b) and (c) keeps every pin green while dropping `with an argon2
companion:`. That is a narrowing no code makes, so it is preemptive hardening. (P3) header
bullet (c), built as worded with a lower-case `the`, also drops three existing sentence-break
pins, so "each narrowing on its own turns the canary red" credits the new pins with a red that
other pins produce. That is prose about a declined alternative, with no reader consequence.
The sibling tasks on the same file (reverse declaration, mixed-script) were held the same day.

**Owner:** backend
**Created:** 2026-10-01

## Why

The `LOOSE_CLAIM_SRC` docblock in
`backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts`
reads: "The room after the noun stays tight: prose about a real code path and
some unrelated companion thing ("running on the real path with a mocked
companion here:") is common, and every extra character of slack there accuses
more of it." A reader takes that example as prose the tight room protects.

It is not protected. Measured on 2026-10-01 against an isolated copy of HEAD,
on the normalised text:

| Input | `labelCount` | `unparsedClaims` | `ratchetClass(blockShape(...))` |
|---|---|---|---|
| `running on the real path with a mocked companion here: the pool is stubbed` | 0 | `["real path with a mocked companion here:"]` | `unparsed` |
| `This drives the real path with a mocked companion: getAppPool is stubbed.` | 0 | `["real path with a mocked companion:"]` | `unparsed` |

The window after the noun is `{0,8}`, and ` here` is five characters, so the
colon is in reach. A block carrying either sentence is an `unparsed` violation.
The ALLOW_MARKER exempts it, so an author has a way through, but the docblock
gives no hint that the marker is needed. No corpus file contains this shape
today. The previous implementation round recorded it as found and not fixed,
and confirmed it predates that round.

The finding here is the sentence, not only the behaviour. A docblock that
implies a guarantee the code does not provide is the defect class this canary
has been held for in nearly every round.

## Scope

1. Correct the `LOOSE_CLAIM_SRC` docblock to measured behaviour. Either its
   example becomes one the guard actually refuses, or the docblock says
   plainly that this prose shape is accused and names the marker as the
   author's remedy.
2. Decide whether to narrow the guard so that prose shaped like the example is
   not accused. The constraint is recall: every existing near-miss probe must
   keep its current `unparsedClaims` count. Note that the obvious filter,
   refusing a span whose filler's first word is a stop word, would drop the
   pinned near-miss `(c) REAL-PATH (also routes/foo.test.ts) COMPANION: covered`
   (one of the casing-recall probes, pinned at 1), whose filler's first word
   is `also`. If no narrowing preserves every near-miss
   probe and the corpus census, keep the behaviour, fix the docblock, and add
   this shape to the header's list of known precision costs.

## Acceptance criteria

1. The docblock's example and wording match measured behaviour, and a probe
   pins the example at its stated count: 0 if the guard now refuses it, 1 if
   the docblock names it as accused.
2. If the guard is narrowed, every existing `unparsedClaims` near-miss probe
   returns its current count, the whole-tree census is unchanged, and the new
   arm has a probe that goes red when the arm alone is neutered.
3. The canary is green. `LANDING_FREE_PROSE`, `LANDING_FILELESS`, both
   deferred maps and `LANDING_DIGEST` are untouched.

## Notes

This task and two sibling tasks edit the same canary file:
`backend-carve-out-canary-mixed-script-confusable-set` and
`backend-carve-out-canary-reverse-declaration-in-mocking-file`. Land them one
at a time. Anchor any comment you write on stable symbols, never on line
numbers, task slugs or round numbers.

Reproduce on a probe copy built per the backend probe recipe, never in the
shared checkout. Apply `normalizeCommentText` before calling `unparsedClaims`,
`labelCount` or `blockShape`, as `auditSources` does. Console output is
silenced in this suite, so write results to a file with the already-imported
`writeFileSync`.

## Backend implementation signal (2026-10-01, commit 615d77ce)

Decision: keep the behaviour, fix the docblock (scope item 2's fallback).
Three narrowings were measured on isolated copies of `d90204fa`, each green
against every existing pin and the non-self census, and each dropped a
plausible claim-shaped near-miss unaudited (labels=0, unparsed=0):

| Narrowing | Prose spared | Near-miss dropped |
|---|---|---|
| refuse whitespace + lower-case word after the noun | P1 only (not the colon-straight-after variant) | `(also routes/foo.test.ts) companion here:` |
| refuse (preposition +) article before the noun, `real` excepted | both examples | `Real-path with a Postgres companion:` |
| refuse an article-led noun phrase (lookbehind) | both examples | `Real-path with a Postgres companion: <backticked path> [A]`, `THE COMPANION:` family |

Three independent judges (recall, precision/scope, docblock truth) all chose
keep-behaviour. Landed:

- `LOOSE_CLAIM_SRC` docblock: the room is stated as measured (colon at most
  eight characters past the noun and any plural ending, no sentence break),
  the example is named as accused, and ALLOW_MARKER is named as the remedy.
- Header "Gaps left open on purpose": new precision-cost entry naming the
  three measured narrowings and what each drops.
- `accusedProse` probe beside `nearMissGap`: both task sentences, after
  `normalizeCommentText`, pin at unparsed 1, labels 0, class `unparsed`, and
  `exempt` with the marker (AC 1, "names it as accused" branch).

AC 2 not applicable (no narrowing). AC 3: canary green (11/11, exit 0),
`typecheck:tests` clean; `LANDING_*`, deferred maps and `LANDING_DIGEST`
untouched.

Side finding, not acted on (for triage): the `unparsed` failure message asks
for the structured form and never mentions ALLOW_MARKER, so prose accused this
way is pointed at a fix it cannot take.

## Architect re-review (2026-10-01) — HELD PENDING FIXES:

Reviewed `615d77ce` via `/ce-code-review` (focused: orchestrator correctness
and standards read plus one independent adversarial read). Verified on an
isolated copy of `615d77ce`: canary green, 11/11, exit 0. A narrowing that
spares the example sentence fails only the `accusedProse` assertion, so the
probe can go red. AC 1 and AC 3 are met. Three prose and message items remain,
all in `backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts`.

1. **The `accusedProse` comment states a bar that every declined narrowing
   meets.** The comment says a narrowing that spares the example "must then
   keep every `unparsedClaims` near-miss pin in this spec at its count". Your
   signal table records each of the three declined narrowings as green against
   every existing pin, so that bar does not stop any of them. Reproduced in
   review: with "refuse whitespace + lower-case word after the noun" added to
   `LOOSE_CLAIM_SRC` and the first `accusedProse` sentence re-pinned at 0 as the
   comment directs, the canary is 11/11 green, while
   `' (c) Real-path (also routes/foo.test.ts) companion here: covered'` yields
   labels 0 and unparsed 0, so it is dropped unaudited. The spellings each
   narrowing drops are named only in header prose; no probe pins them.
   Fix: beside `accusedProse`, pin each near-miss from your table's "Near-miss
   dropped" column, as the exact string you measured, at `unparsedClaims`
   length 1 and `labelCount` 0. Show that each declined narrowing, applied on
   its own with `accusedProse` re-pinned to 0, turns the canary red (one
   mutant per narrowing), and state the result in the signal. Then reword the
   `accusedProse` comment so its bar names these pins, not only the existing
   near-miss pins.

2. **The header's precision-cost entry lists a narrowing that was not
   measured and would not spare the example.** The clause "refusing a filler
   whose first word is a stop word drops the pinned shouted `(also ...)` set"
   comes from this task file's Scope item 2. That wording was mine, not yours.
   It is not one of the narrowings your signal records as measured. `STOP_WORDS`
   in this file has no `with`, so refusing a span whose filler starts with a
   `STOP_WORDS` member spares neither `accusedProse` sentence (the adversarial
   probe kept both at 1). It therefore is not a narrowing "measured for that".
   It also drops every `(also ...)` near-miss pin, not only the shouted set.
   Meanwhile the entry leaves out a narrowing you did measure: refusing an
   article-led noun phrase before the noun (the lookbehind). Fix: make the
   entry's list exactly the narrowings you measured, each with the prose it
   spares and the near-miss it drops, matching the pins from item 1. Drop the
   stop-word clause, or keep it only with a statement that it was not measured
   as a sparing narrowing, what it actually does under `STOP_WORDS`, and that
   it drops every `(also ...)` pin.

3. **The `unparsed` failure message never names the remedy the new docblock
   gives.** In the spec "every citation-shaped line parses as the label, and
   no comment word mixes scripts", the `unparsed` assertion message tells the
   author to write `STRUCTURED_FORM` and does not mention `ALLOW_MARKER`, which
   the `LOOSE_CLAIM_SRC` docblock now names as the author's remedy for accused
   prose. The `DEFERRED_FILELESS` disagreement message already names the
   marker. Fix: add a sentence to the `unparsed` message saying that a line
   which is prose and not a claim is reworded or its block is marked with
   `${ALLOW_MARKER}`. This is message text only, so guard behaviour and the
   census are unchanged.

Keep AC 3 as it stands: `LANDING_FREE_PROSE`, `LANDING_FILELESS`, both
deferred maps and `LANDING_DIGEST` untouched, and canary green by exit code.
Anchor any new comment on stable symbols only, as the task Notes say.

## Backend re-review signal (2026-10-01, commit 3b98e303)

1. `droppedNearMiss` probe beside `accusedProse` pins, at unparsed 1 and
   labels 0: `(also routes/foo.test.ts) companion here: covered`,
   `with a Postgres companion: covered`, the same with a backticked path and
   `[A]`, and `(also routes/foo.test.ts) THE COMPANION: covered` (each with
   the ` (c) Real-path` prefix, exact strings as measured). Mutants, each on
   an isolated copy of the working tree with `accusedProse` re-pinned to
   what the mutant spares; unmodified copy 11/11 exit 0:

   | Narrowing alone | Canary | First failing pin | Control (`droppedNearMiss` loop removed) |
   |---|---|---|---|
   | after-noun `(?!\s[a-z])` | red, exit 1 | `... companion here: covered` | green, exit 0 |
   | article lookahead before noun | red, exit 1 | `... with a Postgres companion: covered` | green, exit 0 |
   | article-led-noun lookbehind | red, exit 1 | `... with a Postgres companion: covered` | green, exit 0 |

   Per-string counts under each mutant (unparsed): after-noun drops pin 1
   only; the lookahead drops pins 2 and 3; the lookbehind drops pins 2, 3
   and 4. The `accusedProse` comment's bar now names these pins.
2. Header precision-cost entry rewritten to list exactly those three
   narrowings, the prose each spares and the pinned spellings each drops,
   matching the per-string counts. The stop-word clause is gone.
3. The `unparsed` assertion message adds: a line that is prose and not a
   claim is reworded, or its block is marked `${ALLOW_MARKER}`.

Canary green (11/11, exit 0) and `typecheck:tests` clean. `LANDING_*`, the
deferred maps and `LANDING_DIGEST` are untouched.

## The custody broadcast admits a light account's vouch and vouch retraction (archived 2026-10-01) — archived clean at 519e6597 on the first pass

### Architect archive note (2026-10-01)

Reviewed 519e6597 against its parent with /ce-code-review (correctness, security, adversarial
in-process, testing, project-standards on root CLAUDE.md, learnings): zero findings in the diff,
all nine requirements (Scope 1-4, AC 1-5) met. The testing lens re-ran the spec in a copy of
519e6597 (19 passed, exit 0) and six of the probe-table mutants (all killed); correctness traced
every probe row against head and base. Signer binding agrees with the read-side signer gate, and
vouch ops skip the gated-op scan, so they take the session-kind consume.

One pre-existing P2 surfaced (security and adversarial, independently): the read-side WoT count
admits a self-vouch from an accred_pinned account, so a WoT member one vouch short of threshold
can stay accredited. Filed as backend-wot-read-side-drops-self-vouch. The custody.md contract
update and the root CLAUDE.md "(comment, vote only)" line stay with the archive of
backend-custody-allowlist-comment-options, which is still pending and so archives later.

**Owner:** backend
**Created:** 2026-10-01

## Why

Light accounts are meant to vouch (user decision, 2026-10-01). They cannot today, at two layers:
the custody broadcast refuses the ops, and the profile page hides the forms. This task lifts the
backend layer; `ui-light-account-vouch` lifts the frontend one after it.

In `backend/src/routes/custody.ts`, the `custom_json` arm of `POST /api/custody/broadcast`
admits only the actions in its `allowedActions` list (`revote`, the three credit ops and the two
consent ops). A light account's `vouch` or `retract_vouch` gets 403 `FORBIDDEN`. That limit dates
from when light accounts were introduced and server-side signing covered comments and votes
only; nothing records a reason to keep vouches out.

Nothing else blocks the path. Both ops carry `required_posting_auths: [voucher]`
(`hive-schemas.md` § 2.5, § 2.6), so the stored posting key signs them. `POST /api/wot/vouch`
and `POST /api/wot/retract` already accept a JWT through `verifyHiveSignature` and check that the
voucher is accredited. Light accounts meet the accreditation criteria from signup
(`ARCHITECTURE.md` "Accredited-Only Data Policy").

