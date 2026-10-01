/**
 * Standing source-discipline canary for the clause-(c) real-path companion
 * citations the test-mock carve-out requires (root `CLAUDE.md` "Carve-out for
 * deterministic edge-case coverage"). Scans every `.ts` under `backend/tests/`
 * and fails when a citation names a companion that cannot witness the risk
 * class it was cited for, or when a labelled companion claim is written in a
 * form that nothing can check.
 *
 * Why a standing test and not review: the citation is the ONLY artifact tying a
 * permitted mock to its justification, and it is free prose. When it rots the
 * carve-out is voided silently — the mock stays, the justification evaporates,
 * and the mocked test keeps passing, which is the whole problem, because it was
 * passing precisely because it was mocked. The rot has been found three times
 * across two incidents: a header naming a file that contains zero assertions
 * about the claimed risk class; two headers naming a suite FAMILY that resolves
 * to no file at all; and a header naming a companion that hoists the very mock
 * fixture it was cited for covering. Every existing guard is blind to it — the
 * `no-stale-comment-anchors` canary scans only `backend/src`, and both it and
 * the `.githooks/pre-commit` gate match anchor SHAPES, under which a bare
 * filename in prose is perfectly legal. Rationale, the observed rot classes and
 * the design obstacles are recorded in
 * `agents/docs/solutions/conventions/carve-out-clause-c-companion-citations-are-unverified-prose-2026-09-02.md`.
 *
 * THE STRUCTURED FORM. A checkable citation is one line inside the header
 * docblock's clause-(c) block, naming exactly one companion:
 *
 *     (c) Real-path companion: `backend/tests/routes/some-route.test.ts` [SOME_TOKEN]
 *         Real-path companion: `backend/tests/lib/other.test.ts` [otherToken]
 *
 * The path is repo-relative and backtick-delimited. The risk-class token is
 * bracket-delimited, whitespace-free, and closes the line (a short
 * parenthetical or a full stop may follow the bracket, nothing else). Repeat
 * the label for a second companion; never fuse two claims into one sentence,
 * because a half-true compound is the shape that survives review — the reader
 * spot-checks the half that holds.
 *
 * A real-path suite that declares ITSELF the companion, which the convention
 * entry recommends so that both ends of the link are visible, writes the
 * reverse form, naming the mocked suite it serves:
 *
 *     Real-path companion for: `backend/tests/routes/some-route-mocked.test.ts`
 *
 * That resolves the path and then resolves the LINK, by parsing the named
 * suite's own comments and requiring a forward citation there naming this
 * file. A one-sided declaration is red on the side that forgot.
 *
 * The reverse form carries no risk-class token, and the citation that answers
 * it must be a forward one. Those are the two halves of one decision. A
 * reverse declaration discharges no clause of its own: the file writing it
 * mocks nothing, so it is a signpost rather than a justification, and what has
 * to be checkable about a signpost is that it points somewhere. The forward
 * citation it points at is resolved and token-checked in its own right, so
 * the risk class is already witnessed once, by the end that owes the
 * justification; spelling it a second time on the reverse form would raise the
 * cost of the declaration the convention entry recommends and give the same
 * fact a second place to rot. Requiring that answer to be FORWARD is what
 * closes mutual vouching, where two files declare each other companions and no
 * token is named at either end.
 *
 * What that link does NOT establish: that the two files stand in a mocked /
 * real-path relationship at all. Two files can cite each other honestly in
 * form while neither mocks anything, and the forward citation's token then
 * witnesses a risk class in a suite nobody needed a companion for. Whether a
 * carve-out was owed in the first place is a review judgement, as it is for
 * every citation here.
 *
 * WHAT IS CHECKED, per structured citation:
 *
 *   1. The path has the repo-relative `backend/tests/**.test.ts` shape and,
 *      for a FORWARD citation, does not point into `tests/eslint/` or
 *      `tests/support/`, whose files scan sources and run no route. (A reverse
 *      declaration may name one: there the path is the mocked suite being
 *      served, not the witness.) A `./`-prefixed or tests-relative spelling
 *      fails here with a message that names the required form, rather than as
 *      a confusing missing-file error. A forward citation's token must also be
 *      a single whitespace-free code token, which is what a second citation
 *      fused onto the same line leaves in the bracket.
 *   2. The path resolves on disk.
 *   3. The companion is not the citing file itself. A mocked test of a surface
 *      normally spells that surface's tokens in its own code, so a
 *      self-citation would pass the token arm while proving nothing.
 *   4. The token occurs in the companion's CODE, as a whole word: every
 *      comment is removed first, then every vitest mocking call with its
 *      factory or stub body (`vi.mock`, `vi.doMock`, `vi.hoisted`, `vi.spyOn`,
 *      `vi.stubGlobal`, `vi.fn`, the `mockResolvedValue` family), then every
 *      `describe`/`it`/`test` title string.
 *   5. The token is not so generic that any file would satisfy it: it may
 *      occur, as a whole word in code so defined, in at most TOKEN_FILE_CAP
 *      files under `backend/tests`.
 *
 * Arms 4 and 5 are about a risk-class token, which the reverse form does not
 * carry; in its place it is checked that the named file cites this one back
 * with a FORWARD citation, which is then resolved and token-checked in its own
 * right (THE STRUCTURED FORM, arms 1 to 5), so the risk class is witnessed at
 * the end that owes the justification rather than on the reverse declaration.
 *
 * WHY THE TOKEN AND NOT THE FILENAME. A check built on finding the cited
 * FILENAME inherits the exact blindness it exists to remove: the filename is
 * present, the assertion is not. Grep what the companion must assert, in the
 * companion. The rule holds for the reverse form's link too, which is why that
 * link is resolved by parsing the named file's citations rather than by asking
 * whether its text contains this file's name: hundreds of ordinary
 * cross-mentions under `backend/tests` would satisfy the second question.
 *
 * WHY THE DETECTORS READ A REJOINED BLOCK AND THE MATCH'S OWN CAPTURES. Twice
 * a guard here has been defeated not by an attacker but by the corpus's own
 * authoring style. A claim-shaped span was matched with a line-bounded window,
 * and these docblocks wrap near 76 columns, so the wrapped spelling of a claim
 * — the default one for anything longer than a line — was invisible while the
 * one-line spelling was caught. A citation's prose surround was computed by
 * sweeping backticked and bracketed spans out of it, and backticking a path is
 * this convention's house style, so a second filename in a citation's trailer
 * was erased when written the natural way and kept when written the unusual
 * way. The rule both fixes follow: a detector reads either a view of the text
 * that is invariant under the house style (`rejoined`, `glued`) or the spans
 * the parser already captured, never a re-scan of the surrounding text with a
 * pattern that assumes one spelling of it.
 *
 * Rejoining has a cost of its own, paid for where it is taken. A whole
 * docblock becomes one line, so prose at the top of a header is suddenly
 * adjacent to a citation at the bottom, and a bounded window that was safe
 * within a line is not safe across a block. The claim-shaped scan therefore
 * runs on the block with its own structured citations cut out (plus each
 * citation's surround, so a claim inside a trailer is not cut away with it),
 * and keeps its room between the noun and the colon tight. Without that, the
 * corpus's own clause-(a) wording standing above a correct clause-(c) citation
 * is accused, and the message blames the citation.
 *
 * Gaps left open on purpose, each where closing it would open a worse hole in
 * the other direction:
 *
 *   - A SUFFIX-LESS name broken at its own dot (`settings.` / `test`) is read
 *     only on the spaced view of `namesATestFile`, because the glued view
 *     cannot tell it from a sentence ending `e.g.` above a line beginning
 *     `test-only`, and that abbreviation is the commoner write.
 *
 *   - The claim-shaped span in `LOOSE_CLAIM_SRC` gives the room BETWEEN the
 *     noun `companion` and its colon a bounded run (`{0,8}`). A NEAR-MISS
 *     whose colon lands nine or more characters past `companion` matches
 *     neither the label nor the loose claim, so the block yields labels=0 and
 *     unparsed=0 and is dropped before any class is assigned — a claim gone
 *     unaudited, the same silent-drop outcome the wrapped-qualifier fix
 *     closed. Both arms have to fail for that. A far colon on its own silences
 *     nothing, because a claim whose label still parses is classified whatever
 *     its colon does; it is the near-miss, where something in the qualifier
 *     slot has already stopped the label, that the far colon then hides.
 *     Worked escape, pinned by the `nearMissGap` probe: an eight-character gap
 *     is caught, a nine-character one is not. Any finite bound can be stepped
 *     over, and widening THIS window was measured (the corpus stays green well
 *     past `{0,8}`, though one of this file's own prose probes does not) and
 *     declined, because every character of extra room after the noun accuses
 *     more ordinary prose about a real code path and some unrelated companion
 *     thing, and this file is deliberately precision-biased for the same
 *     reason the pre-commit anchor gate scopes itself to known slug prefixes.
 *     The run BEFORE the noun (`{0,80}`) is bounded for the mirror reason; it
 *     is wide because a real qualifier phrase can be long, and a qualifier
 *     longer than that is simply not claim-shaped here.
 *
 *   - The label and loose-claim detectors read the raw and rejoined (spaced)
 *     views only, never the glued one, so a wrap falling INSIDE any of the
 *     label's own words (`compan` / `ion`, and equally `Re` / `al-path` or
 *     `Real-pa` / `th`) is invisible to them: rejoined, `compan ion` is not
 *     `companion`. Only `namesATestFile` reads the glued view, because that
 *     view exists to repair a wrapped FILENAME, and gluing the label and loose
 *     detectors instead would fuse `companion` into the word the wrap put
 *     beside it (`companionfixtures`) and mangle every ordinary wrapped label
 *     rather than catch the rare word-internal one. What the corpus actually
 *     writes is a wrap at the label's own hyphen (`Real-` / `path`), which the
 *     dash-or-space run absorbs; no word is broken inside itself here, and the
 *     gap is recorded, not closed.
 *
 *   - A near-miss whose own QUALIFIER carries a phrase break is dropped by
 *     the same sentence-break refusal. The trigger set is the refusal's own,
 *     not abbreviations: any `.`, `;`, `!` or `?` followed by one whitespace
 *     and anything that is not an ASCII lower-case letter, wherever it falls
 *     inside the qualifier. An abbreviation before a backtick is one member
 *     (`Real-path (e.g. <a backticked path>) companion: covered` breaks at
 *     the full stop inside `e.g.`), `(i.e. (routes/foo.test.ts))` breaks the
 *     same way before its parenthesis, and no abbreviation is needed at all:
 *     a semicolon joining two backticked paths, a two-sentence qualifier,
 *     `(SQL; HAF)` and `(mocked? No, ...)` all break the same way. The
 *     span stops inside the qualifier, so the block yields labels=0 and
 *     unparsed=0 and is dropped, exactly as the far-colon escape above is.
 *     Closing the whole family means firing the refusal only before a capital,
 *     which was measured and declined: it accuses an honest header in the
 *     corpus and moves a backlog pin. Recorded by the `abbrevNearMiss` probe,
 *     which pins the gap at its current width, at one abbreviation member and
 *     one semicolon member, so that widening it later is a visible probe edit
 *     rather than a silent change of recall.
 *
 *   - The opposite direction, a PRECISION cost: a sentence that mentions a
 *     real code path and then, with no sentence break, some unrelated
 *     companion thing followed by a colon within the room after the noun is
 *     accused by `LOOSE_CLAIM_SRC` as an unparsed claim, and its block goes
 *     red. That docblock gives the worked example. The author's way through
 *     is to reword the sentence or to carry the ALLOW_MARKER in the block.
 *     Sparing that prose means telling it from a near-miss claim by the words
 *     around `companion`. Three narrowings were measured for that, and each
 *     drops a claim-shaped spelling unaudited (labels=0, unparsed=0):
 *       * refusing a whitespace followed by a lower-case letter in the room
 *         after the noun spares only the `accusedProse` sentence that has
 *         ` here` before its colon, and drops the near-miss ending
 *         `companion here: covered`;
 *       * refusing a filler that opens on an article, optionally after
 *         `with`, `against`, `through`, `via` or `using`, unless the word
 *         after the article is `real`, spares both `accusedProse` sentences
 *         and drops `Real-path with a Postgres companion:` whether a prose
 *         word or a backticked path and a bracketed token follows it;
 *       * refusing a `companion` led by an article and at most one word (a
 *         lookbehind on the noun) spares both, and drops both of those
 *         spellings and the shouted `THE COMPANION:` as well.
 *     The `droppedNearMiss` probe pins each of those exact spellings at one
 *     unparsed span, so each narrowing on its own turns the canary red. A
 *     false accusation with a marker as its remedy is the cheaper error, so
 *     the shape is recorded, not closed, and the `accusedProse` probe pins it
 *     at one unparsed span.
 *
 * WHY COMMENTS, MOCK BODIES AND TITLES DO NOT COUNT (arm 4). Risk-class tokens
 * appear constantly in prose, including prose that pins the OPPOSITE of the
 * citation — a header sentence explaining that this file deliberately does not
 * assert the code, or that the fixture is not used. Counting those would let a
 * citation point at a file whose only trace of the risk class is a sentence
 * saying it is covered elsewhere. A mock's factory body is the same thing in
 * code: the historical false companion's single surviving occurrence of the
 * token it was cited for was the stub that mocked it, and a spec title is
 * prose in a string. The whole-word rule stops a companion's own
 * `<token>Mock` identifier from satisfying `<token>`.
 *
 * WHAT COUNTS AS A COMMENT, on both sides. TypeScript's own parser decides:
 * every comment is trivia attached to some token, so walking the tokens and
 * asking for the leading and trailing comment ranges at each finds them all,
 * and nothing inside a string, a template literal or a regular expression is
 * ever one. That is deliberately not a line-prefix heuristic, because an
 * attacker writes code: a claim in a trailing comment on the `vi.mock(` line,
 * inside a gutter-less block comment, after a template literal's closing
 * backtick, or beside a regex containing a quote is a comment to the reader
 * and must be one here; and a `/*` inside a template-literal fixture or a
 * regex character class is code and must not open a phantom comment that
 * swallows a correct citation. On the citing side the ranges become blocks: a
 * block comment is one block; a run of `//` lines is one block; comment runs
 * separated only by blank lines are one block, so a `//` note under a header
 * cannot hide beside it; a trailing comment on a code line stands alone
 * unless the next line's trailing comment continues it. On the companion side
 * the same ranges are what arm 4 removes.
 *
 * Every block is Unicode-normalised (compatibility form, format characters and
 * combining marks dropped, every dash to `-`, every space separator to a
 * space), and a word that mixes the Latin script with another is a violation
 * in any comment, labelled or not. A look-alike character is therefore either
 * folded to what it renders as or refused outright; the residual is a
 * confusable that is a single-script word of its own, which no comment in
 * this corpus has a reason to contain.
 *
 * SCOPE: VALIDATION IS WHOLE-TREE. Any structured citation, in any comment,
 * anywhere under `backend/tests`, is resolved and checked, in every file,
 * marked allow or not.
 *
 * THE RATCHET. Every comment block carrying the companion label is making a
 * clause-(c) claim, and a claim is checkable only in the structured form. So a
 * block must carry one structured citation per label, and once it does, the
 * prose left over must not name a test file, because one checked citation
 * beside one unchecked filename is the half-true compound again; a filename
 * tucked into the label's own qualifier slot counts as that prose. A block
 * that fails the first test is a violation unless it carries the ALLOW_MARKER
 * or its shortfall is pinned in the backlog below; a block that fails the
 * second (`leaky`) is a violation unless it carries the marker, and no backlog
 * covers it. A LABELLED claim that names no file at all ("the settings suites
 * cover it") is rejected, not validated: nothing can resolve it, which is an
 * argument against checking it and no argument for admitting it. Such a claim
 * either cites a file or carries the marker. And a line that reads as a
 * citation to a person, `real-path ... companion:` with a colon, but does not
 * parse as the label (a filename or a sentence in the qualifier slot, say) is
 * a violation of its own rather than a skipped block.
 *
 * What the ratchet cannot see is prose without the label. An unlabelled
 * sentence naming no file beside a structured citation ("the settings suites
 * cover the happy path too") is invisible, and so is an unlabelled sentence
 * naming a test file in a block that is neither the labelled one nor adjacent
 * to it, and so is a file named without `.test`/`.spec` and without a
 * `tests/<dir>/` path in front of it. Nor does the citation-shaped test reach
 * across a sentence break, and it reads a break BROADLY: `.`, `;`, `!` or `?`
 * followed by one whitespace ends the span unless what comes next is an ASCII
 * lower-case letter. A capital ends it, and so do a digit, a backtick, a
 * bracket, a dash, a quote, a second space, a letter outside ASCII, and the
 * end of the text. So a span whose words run `real ... path. The ...
 * companion ...:` is two sentences here and no claim, while the ONE crossed
 * continuation, a lower-case one, is the wrapped filename `ops.` / `test.ts`
 * rejoining as `. test.ts`. That single exception is load-bearing only because
 * `looseClaimPattern` omits the `i` flag; under `i` the refusal's `(?![a-z])`
 * folds to accept capitals too and the lower-case arm stops discriminating,
 * which is why the pattern's own literal words are spelt a class per letter
 * instead of matched under the flag. The refusal, the tight room between the
 * noun and the colon, and cutting the block's own citations out before the
 * scan are the three things that keep it off ordinary technical prose, which
 * mentions a real code path constantly. The label is the only anchor; recall
 * beyond it would need an unbounded phrase list that rots. The
 * label pattern accepts `real`, `path` and `companion(s)` joined by dashes or
 * spaces (or nothing), up to two qualifying words before the noun (a word, not
 * a stop word, not a path, optionally wrapped in brackets, quotes or
 * emphasis), and emphasis around either word, after normalisation. One-off
 * nouns for the same idea (sibling coverage, real-HAF variant, no-mock
 * companion) are not labels and are not ratcheted.
 *
 * THE BACKLOG. The corpus predates the structured form, so the claims that
 * were already unstructured when this ratchet landed are carried in two
 * per-file count maps: DEFERRED_FREE_PROSE for blocks whose prose names a test
 * file (convert them), and DEFERRED_FILELESS for blocks that name no file
 * (decide: cite a file, or mark the block allow). The count is the file's
 * label DEFICIT, labels minus structured citations, summed over its blocks in
 * that class, so a second label line inside an existing block counts as much
 * as a new block does. Each pin is EXACT against the tree, and each map is
 * bounded by a frozen snapshot of the landing state that is never edited.
 * What those give, precisely:
 *
 *   - a file absent from the snapshot can never enter the backlog, so a new
 *     file, or one file swapped for another, writes the structured form;
 *   - a listed file's deficit cannot exceed its pin, and a pin cannot exceed
 *     its landing count, so a new claim in a listed file, in a new block or
 *     inside an existing one, is red unless a claim left in the same edit or
 *     the pin still had room below its landing count;
 *   - a deficit below its pin is red until the pin follows it, so a conversion
 *     (or a deletion) is a visible edit in the map;
 *   - the ceiling on the maps' size is the snapshot itself, entry by entry and
 *     count by count, rather than a number kept in step by hand.
 *
 * And what they do NOT give, stated so the header does not outrun the code:
 * the reconciler is stateless. A pin lowered after a conversion can later be
 * raised back to its landing count, and an entry removed at zero can be
 * re-added, as long as the tree agrees; a claim replaced by a different claim
 * at constant deficit changes nothing here at all. Each of those leaves a diff
 * on the block or on the map, and reading that diff is a review matter, not a
 * mechanical one.
 *
 * The frozen snapshot is the root of trust and the one thing this file cannot
 * verify. A digest of its entries is pinned as a literal, so a change to any
 * entry or count needs a recomputed digest alongside (a reorder is a no-op);
 * that is friction, since anyone can recompute it, and the docblock on the
 * snapshot says so.
 *
 * The ALLOW_MARKER is unbounded and uncounted: it is the lowest-friction answer
 * to any red bar this file produces, and whether a given use of it is honest
 * is a review judgement. Nothing checks that a reason accompanies it.
 *
 * PICK THE TIGHTEST HONEST TOKEN. The token names the risk class as the
 * companion spells it in code: an error code, a claim name, a column, a route
 * path. Prefer one whose occurrences in the companion are the assertion itself
 * — `SESSION_INVALIDATED` resolves once in each of the revocation companions
 * and that once IS the assertion, so deleting it turns the citation red. A
 * token that also appears in fixtures, payload literals and helper plumbing
 * still pins the risk class, but it survives the assertion being deleted, and
 * that is a weaker citation rather than a passing one.
 *
 * KNOWN TRADE. Token presence in code is necessary, not sufficient. This canary
 * does not catch "the companion asserts it, but weakly", and it cannot tell an
 * assertion from a fixture literal or a projection expression: a token that
 * sits in a fixture row outside any mocking call, or in a string that is not a
 * spec title, still counts. That stays a review judgement under the
 * carve-out's definitional convention. Two narrower blind spots are accepted
 * too: a companion whose specs sit behind a `describe.skipIf(!dbReachable)`
 * guard, or whose only spec is an `it.todo`, satisfies every arm here while
 * contributing no coverage at all. This canary proves the assertion is in the
 * companion's source, never that it ran — a citation whose companion
 * self-skips is worth pairing with one that fails loudly instead.
 *
 * SELF-EXCLUSION. Every other canary in this directory scans `backend/src` and
 * keeps its fixtures under `backend/tests`, so its own planted-bad strings are
 * outside its own corpus. This canary's corpus IS its own directory, so that
 * protection is gone. Three things replace it: the scan drops this file by
 * `rel` (pinned by an assertion that it was found before it was dropped), the
 * probe fixtures are synthetic in-memory sources whose text never reaches a
 * scanned file, and any legitimate prose citation that must stay prose can
 * carry the ALLOW_MARKER token in its block.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { sourcesUnder, type ScannedSource } from '../support/enclosing-symbol.js';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const testsRoot = path.resolve(__dirname, '..', '..', 'tests');

/** This file's own `rel` under the walk root. It is excluded from the scan;
 *  see SELF-EXCLUSION in the header. */
const SELF_REL = 'eslint/no-unresolvable-carve-out-companion-citation.test.ts';
/** The same, repo-relative. No citation may name this file: it is dropped from
 *  the scan, so its own header's worked examples would otherwise read as live
 *  citations and answer any reverse declaration that named it. A file excluded
 *  from validation vouches for nothing. */
const SELF_REPO_PATH = `backend/tests/${SELF_REL}`;

/** Per-block escape hatch for a legitimate claim that cannot take the
 *  structured form: an anti-citation stating that NO real-path companion exists
 *  and why, or a claim whose referent is a behaviour rather than a file.
 *  Mirrors the `anchor-allow` marker in `.githooks/pre-commit`. Unbounded and
 *  uncounted by design, and nothing checks for a reason beside it; see the
 *  header. */
const ALLOW_MARKER = 'carve-out-citation-allow';

/** A token occurring, as a whole word in code, in more than this many files
 *  under `backend/tests` proves nothing about the companion. Sized off the
 *  corpus: the risk-class tokens actually worth citing land in single digits,
 *  while `createApp` — every route suite's first line — is spelt in code by
 *  well over a hundred files. (`verifyHiveSignature`, the most
 *  authoritative-sounding token available, is spelt in CODE by only a handful:
 *  nearly every suite that names it does so inside the call that mocks it.) */
const TOKEN_FILE_CAP = 40;

/** The one accepted spelling, quoted in the backlog messages. */
const STRUCTURED_FORM = 'Real-path companion: `backend/tests/<dir>/<name>.test.ts` [RISK_CLASS_TOKEN]';

// --- the landing snapshot: NEVER EDIT ----------------------------------------

/**
 * The state of the corpus on the day the ratchet landed, per file: the label
 * deficit (labels minus structured citations) of its blocks whose prose names
 * a test file (LANDING_FREE_PROSE), and of its blocks that name no file at all
 * (LANDING_FILELESS). These two maps are the root of trust for the backlog
 * below and are NEVER EDITED, in either direction. The live maps must be a
 * subset of them, entry by entry and count by count; that subset rule is what
 * stops a converted file's slot being reused by a new one, a deleted claim
 * freeing room for a fresh prose claim in another file, or one file being
 * swapped for another under an unchanged total.
 *
 * LANDING_DIGEST below is a hash of both maps' entries, pinned as a literal, so
 * a change to any entry or count here needs a recomputed digest beside it (a
 * reorder is a no-op). That is friction, not a guarantee: anyone can recompute
 * it, and nothing in this file can tell a recomputed digest from the original.
 * Treat a diff that touches these maps or the digest as a defect in its own
 * right.
 */
const LANDING_FREE_PROSE: Readonly<Record<string, number>> = {
  'backend/tests/consent-ops.test.ts': 1,
  'backend/tests/consented-authors-bridge-orcid-exclusion-real-postgres.test.ts': 1,
  'backend/tests/consented-authors-cte-real-postgres.test.ts': 1,
  'backend/tests/digest-window-cursor.test.ts': 1,
  'backend/tests/fetch-notifications-asc-whole-block.test.ts': 1,
  'backend/tests/hafsql-btrim-charset-real-postgres.test.ts': 2,
  'backend/tests/hafsql.test.ts': 2,
  'backend/tests/ipfs-cleanup-backend-dispatch.test.ts': 1,
  'backend/tests/jobs/custody-audit-retention-sweep.test.ts': 2,
  'backend/tests/lib/accreditation-names-loader-whitespace.test.ts': 1,
  'backend/tests/lib/bridge-worker.test.ts': 1,
  'backend/tests/lib/cache-invalidation.test.ts': 1,
  'backend/tests/lib/cache.test.ts': 1,
  'backend/tests/lib/fresh-auth-consent-op-burn-offline-queue.test.ts': 1,
  'backend/tests/lib/fresh-auth-redis-unavailable-burn.test.ts': 1,
  'backend/tests/lib/idempotency.test.ts': 2,
  'backend/tests/lib/ipfs-image-srf-guard.test.ts': 1,
  'backend/tests/me-pending-authorships-real-postgres.test.ts': 1,
  'backend/tests/middleware/verifyHiveSignature-authmethod.test.ts': 2,
  'backend/tests/middleware/verifyHiveSignature-reissuedat-orcid-roundtrip.test.ts': 1,
  'backend/tests/middleware/verifyHiveSignature-reissuedat-roundtrip.test.ts': 2,
  'backend/tests/middleware/verifyHiveSignature-replay-timestamp.test.ts': 1,
  'backend/tests/notification-queries-lateral-guard-canary.test.ts': 1,
  'backend/tests/reputation-consented-credit-cycle-behavioral.test.ts': 1,
  'backend/tests/routes/accreditation.test.ts': 3,
  'backend/tests/routes/accreditations-likeguard-mocked.test.ts': 2,
  'backend/tests/routes/admin-endpoints.test.ts': 1,
  'backend/tests/routes/admin-fresh-auth-real-path-verifyhivesignature.test.ts': 3,
  'backend/tests/routes/admin.test.ts': 1,
  'backend/tests/routes/anonymousReview.test.ts': 1,
  'backend/tests/routes/app-ssr-discipline-real-path.test.ts': 1,
  'backend/tests/routes/app-ssr-jsonld-script-breakout.test.ts': 1,
  'backend/tests/routes/authorship-approve-signer-gate.test.ts': 1,
  'backend/tests/routes/authorship-revoke-signer-gate.test.ts': 1,
  'backend/tests/routes/bridge-haf-lag-locks.test.ts': 1,
  'backend/tests/routes/bridge-register-enqueue.test.ts': 1,
  'backend/tests/routes/bridge-register-rate-limit-skip-failed.test.ts': 1,
  'backend/tests/routes/bridge.test.ts': 1,
  'backend/tests/routes/citations-lateral-guard-canary.test.ts': 1,
  'backend/tests/routes/custody-consent-ops.test.ts': 1,
  'backend/tests/routes/custody-credit-ops.test.ts': 1,
  'backend/tests/routes/custody-limiter-cpu-amplification.test.ts': 2,
  'backend/tests/routes/custody-session-auth-argon-errors.test.ts': 1,
  'backend/tests/routes/custody-session-auth.test.ts': 1,
  'backend/tests/routes/custody-upgrade.test.ts': 1,
  'backend/tests/routes/custody.test.ts': 2,
  'backend/tests/routes/display-consented-self-dealing-exclusion.test.ts': 1,
  'backend/tests/routes/haf-outage-translation-canaries.test.ts': 1,
  'backend/tests/routes/ipfs-gateway-hardening.test.ts': 1,
  'backend/tests/routes/ipfs-pin-durability.test.ts': 3,
  'backend/tests/routes/ipfs-upload-real-path-verifyhivesignature.test.ts': 1,
  'backend/tests/routes/ipfs-upload-token.test.ts': 1,
  'backend/tests/routes/listing-count-window-function-shape.test.ts': 2,
  'backend/tests/routes/me-authorships-pending.test.ts': 1,
  'backend/tests/routes/notifications-arm-sql-shape.test.ts': 2,
  'backend/tests/routes/notifications-window-cursor.test.ts': 2,
  'backend/tests/routes/orcid.test.ts': 2,
  'backend/tests/routes/papers-canonical-orcid-resolution.test.ts': 1,
  'backend/tests/routes/papers-canonical-root-walker.test.ts': 1,
  'backend/tests/routes/papers-consented-badge.test.ts': 1,
  'backend/tests/routes/papers-cumulative-cross-surface-parity-mocked.test.ts': 1,
  'backend/tests/routes/papers-cumulative-orcid-audit.test.ts': 1,
  'backend/tests/routes/papers-cumulative-route-error-isolation-mocked.test.ts': 1,
  'backend/tests/routes/papers-enrichment-parity-gate.test.ts': 1,
  'backend/tests/routes/papers-haf-error-vs-not-found.test.ts': 1,
  'backend/tests/routes/papers-retract-real-path-verifyhivesignature.test.ts': 3,
  'backend/tests/routes/papers-retract-url-shape-validator.test.ts': 2,
  'backend/tests/routes/profile-papers-cid-validate.test.ts': 1,
  'backend/tests/routes/profile-papers-empty-cumulative-fallback.test.ts': 1,
  'backend/tests/routes/profile-papers-supersession.test.ts': 1,
  'backend/tests/routes/profile-reviews-accred-gate.test.ts': 1,
  'backend/tests/routes/profile-stats-parity-gate.test.ts': 1,
  'backend/tests/routes/recover-two-phase.test.ts': 1,
  'backend/tests/routes/reputation-approve-signer-gate-cycle-sql-shape.test.ts': 1,
  'backend/tests/routes/reputation-batch-cycle-boundary.test.ts': 1,
  'backend/tests/routes/reputation-batch-internals.test.ts': 1,
  'backend/tests/routes/reputation-batch-sql-failure.test.ts': 1,
  'backend/tests/routes/reputation-calc-version-recompute.test.ts': 1,
  'backend/tests/routes/reputation-citing-coauthor-exclusion-canary.test.ts': 1,
  'backend/tests/routes/reputation-consented-credit-cycle-sql-shape.test.ts': 1,
  'backend/tests/routes/reputation-lifecycle.test.ts': 1,
  'backend/tests/routes/reputation-orcid-auto-accept-authority-gate.test.ts': 1,
  'backend/tests/routes/reputation-orcid-auto-accept-trim-canary.test.ts': 1,
  'backend/tests/routes/reputation-paper-reviews-self-exclusion-canary.test.ts': 1,
  'backend/tests/routes/reputation-revoke-signer-gate-cycle-sql-shape.test.ts': 1,
  'backend/tests/routes/retract-rate-limit-skip-failed.test.ts': 1,
  'backend/tests/routes/review-agg-single-scan.test.ts': 1,
  'backend/tests/routes/reviews.test.ts': 3,
  'backend/tests/routes/search-partial-degradation.test.ts': 1,
  'backend/tests/routes/search-reviews-parity-gate.test.ts': 1,
  'backend/tests/routes/settings-email-fresh-auth.test.ts': 2,
  'backend/tests/routes/settings-set-password-argon-error-translation.test.ts': 3,
  'backend/tests/routes/settings-set-password-fresh-auth.test.ts': 1,
  'backend/tests/routes/settings.test.ts': 1,
  'backend/tests/routes/signup-verify-activation-lock-unavailable.test.ts': 1,
  'backend/tests/routes/signup-verify-activation-recovery.test.ts': 1,
  'backend/tests/routes/signup-verify-orcid-binding-guard.test.ts': 1,
  'backend/tests/routes/signup-verify-postbroadcast-severity.test.ts': 3,
  'backend/tests/routes/signup-verify-stuck-recovery.test.ts': 1,
  'backend/tests/routes/signup-verify.test.ts': 1,
  'backend/tests/routes/wot-retract-poll.test.ts': 1,
  'backend/tests/routes/wot-vouch-poll.test.ts': 1,
  'backend/tests/wot-vouch-status-select-real-postgres.test.ts': 2,
};

const LANDING_FILELESS: Readonly<Record<string, number>> = {
  'backend/tests/hafsql.test.ts': 1,
  'backend/tests/lib/flush-and-exit.test.ts': 1,
  'backend/tests/lib/fresh-auth.test.ts': 3,
  'backend/tests/lib/redis-command-timeout.test.ts': 1,
  'backend/tests/notification-arm-semantics.test.ts': 1,
  'backend/tests/routes/accreditation-idempotency.test.ts': 1,
  'backend/tests/routes/admin-fresh-auth-real-path-verifyhivesignature.test.ts': 1,
  'backend/tests/routes/citation-count-inverted-cte.test.ts': 1,
  'backend/tests/routes/display-claimer-self-review-exclusion.test.ts': 1,
  'backend/tests/routes/display-claimer-self-vote-revote-exclusion.test.ts': 1,
  'backend/tests/routes/ipfs.test.ts': 1,
  'backend/tests/routes/orcid.test.ts': 1,
  'backend/tests/routes/reputation-weights-signer-gate.test.ts': 1,
  'backend/tests/wot-broadcast-timeout.test.ts': 1,
};

/** sha256 of the two landing maps above, in the order they are declared. */
const LANDING_DIGEST = 'bac471e2d7237037723bd6bd36baefd553dd11cf524bdc506210fb5b4e52cbf5';

// --- the live backlog: bounded by the snapshot, pinned exactly ---------------

/**
 * The migration backlog, per file: the label deficit (labels minus structured
 * citations) still standing in that file's blocks of each class.
 * DEFERRED_FREE_PROSE holds the blocks whose prose names a test file, which
 * convert mechanically to the structured form. DEFERRED_FILELESS holds the
 * blocks that carry the label but name no file at all: anti-citations ("no
 * real-path companion exists because ..."), suite families, behaviourally-named
 * uncovered risk classes. Each of those needs a decision rather than a
 * rewrite: cite the file that witnesses it, or keep the prose and mark the
 * block with the ALLOW_MARKER.
 *
 * A listed file is deficit-pinned, not exempt: one more label in it is red,
 * one fewer is red until the pin follows, its `leaky` blocks are violations
 * regardless, and a structured citation in it is still resolved and checked.
 * When a claim in a listed file is converted (or deleted), lower that file's
 * pin, and remove the entry when it would reach zero. A pin can never exceed
 * its landing count, and a file outside the landing snapshot can never appear
 * here; the reconciliation test names the entry and the direction whenever the
 * tree and this map disagree.
 */
const DEFERRED_FREE_PROSE: Readonly<Record<string, number>> = {
  'backend/tests/consent-ops.test.ts': 1,
  'backend/tests/consented-authors-bridge-orcid-exclusion-real-postgres.test.ts': 1,
  'backend/tests/consented-authors-cte-real-postgres.test.ts': 1,
  'backend/tests/digest-window-cursor.test.ts': 1,
  'backend/tests/fetch-notifications-asc-whole-block.test.ts': 1,
  'backend/tests/hafsql-btrim-charset-real-postgres.test.ts': 2,
  'backend/tests/hafsql.test.ts': 2,
  'backend/tests/ipfs-cleanup-backend-dispatch.test.ts': 1,
  'backend/tests/jobs/custody-audit-retention-sweep.test.ts': 2,
  'backend/tests/lib/accreditation-names-loader-whitespace.test.ts': 1,
  'backend/tests/lib/bridge-worker.test.ts': 1,
  'backend/tests/lib/cache-invalidation.test.ts': 1,
  'backend/tests/lib/cache.test.ts': 1,
  'backend/tests/lib/fresh-auth-consent-op-burn-offline-queue.test.ts': 1,
  'backend/tests/lib/fresh-auth-redis-unavailable-burn.test.ts': 1,
  'backend/tests/lib/idempotency.test.ts': 2,
  'backend/tests/lib/ipfs-image-srf-guard.test.ts': 1,
  'backend/tests/me-pending-authorships-real-postgres.test.ts': 1,
  'backend/tests/middleware/verifyHiveSignature-authmethod.test.ts': 2,
  'backend/tests/middleware/verifyHiveSignature-reissuedat-orcid-roundtrip.test.ts': 1,
  'backend/tests/middleware/verifyHiveSignature-reissuedat-roundtrip.test.ts': 2,
  'backend/tests/middleware/verifyHiveSignature-replay-timestamp.test.ts': 1,
  'backend/tests/notification-queries-lateral-guard-canary.test.ts': 1,
  'backend/tests/reputation-consented-credit-cycle-behavioral.test.ts': 1,
  'backend/tests/routes/accreditation.test.ts': 3,
  'backend/tests/routes/accreditations-likeguard-mocked.test.ts': 2,
  'backend/tests/routes/admin-endpoints.test.ts': 1,
  'backend/tests/routes/admin-fresh-auth-real-path-verifyhivesignature.test.ts': 3,
  'backend/tests/routes/admin.test.ts': 1,
  'backend/tests/routes/anonymousReview.test.ts': 1,
  'backend/tests/routes/app-ssr-discipline-real-path.test.ts': 1,
  'backend/tests/routes/app-ssr-jsonld-script-breakout.test.ts': 1,
  'backend/tests/routes/authorship-approve-signer-gate.test.ts': 1,
  'backend/tests/routes/authorship-revoke-signer-gate.test.ts': 1,
  'backend/tests/routes/bridge-haf-lag-locks.test.ts': 1,
  'backend/tests/routes/bridge-register-enqueue.test.ts': 1,
  'backend/tests/routes/bridge-register-rate-limit-skip-failed.test.ts': 1,
  'backend/tests/routes/bridge.test.ts': 1,
  'backend/tests/routes/citations-lateral-guard-canary.test.ts': 1,
  'backend/tests/routes/custody-consent-ops.test.ts': 1,
  'backend/tests/routes/custody-credit-ops.test.ts': 1,
  'backend/tests/routes/custody-limiter-cpu-amplification.test.ts': 2,
  'backend/tests/routes/custody-session-auth-argon-errors.test.ts': 1,
  'backend/tests/routes/custody-session-auth.test.ts': 1,
  'backend/tests/routes/custody-upgrade.test.ts': 1,
  'backend/tests/routes/custody.test.ts': 2,
  'backend/tests/routes/display-consented-self-dealing-exclusion.test.ts': 1,
  'backend/tests/routes/haf-outage-translation-canaries.test.ts': 1,
  'backend/tests/routes/ipfs-gateway-hardening.test.ts': 1,
  'backend/tests/routes/ipfs-pin-durability.test.ts': 3,
  'backend/tests/routes/ipfs-upload-real-path-verifyhivesignature.test.ts': 1,
  'backend/tests/routes/ipfs-upload-token.test.ts': 1,
  'backend/tests/routes/listing-count-window-function-shape.test.ts': 2,
  'backend/tests/routes/me-authorships-pending.test.ts': 1,
  'backend/tests/routes/notifications-arm-sql-shape.test.ts': 2,
  'backend/tests/routes/notifications-window-cursor.test.ts': 2,
  'backend/tests/routes/orcid.test.ts': 2,
  'backend/tests/routes/papers-canonical-orcid-resolution.test.ts': 1,
  'backend/tests/routes/papers-canonical-root-walker.test.ts': 1,
  'backend/tests/routes/papers-consented-badge.test.ts': 1,
  'backend/tests/routes/papers-cumulative-cross-surface-parity-mocked.test.ts': 1,
  'backend/tests/routes/papers-cumulative-orcid-audit.test.ts': 1,
  'backend/tests/routes/papers-cumulative-route-error-isolation-mocked.test.ts': 1,
  'backend/tests/routes/papers-enrichment-parity-gate.test.ts': 1,
  'backend/tests/routes/papers-haf-error-vs-not-found.test.ts': 1,
  'backend/tests/routes/papers-retract-real-path-verifyhivesignature.test.ts': 3,
  'backend/tests/routes/papers-retract-url-shape-validator.test.ts': 2,
  'backend/tests/routes/profile-papers-cid-validate.test.ts': 1,
  'backend/tests/routes/profile-papers-empty-cumulative-fallback.test.ts': 1,
  'backend/tests/routes/profile-papers-supersession.test.ts': 1,
  'backend/tests/routes/profile-reviews-accred-gate.test.ts': 1,
  'backend/tests/routes/profile-stats-parity-gate.test.ts': 1,
  'backend/tests/routes/recover-two-phase.test.ts': 1,
  'backend/tests/routes/reputation-approve-signer-gate-cycle-sql-shape.test.ts': 1,
  'backend/tests/routes/reputation-batch-cycle-boundary.test.ts': 1,
  'backend/tests/routes/reputation-batch-internals.test.ts': 1,
  'backend/tests/routes/reputation-batch-sql-failure.test.ts': 1,
  'backend/tests/routes/reputation-calc-version-recompute.test.ts': 1,
  'backend/tests/routes/reputation-citing-coauthor-exclusion-canary.test.ts': 1,
  'backend/tests/routes/reputation-consented-credit-cycle-sql-shape.test.ts': 1,
  'backend/tests/routes/reputation-lifecycle.test.ts': 1,
  'backend/tests/routes/reputation-orcid-auto-accept-authority-gate.test.ts': 1,
  'backend/tests/routes/reputation-orcid-auto-accept-trim-canary.test.ts': 1,
  'backend/tests/routes/reputation-paper-reviews-self-exclusion-canary.test.ts': 1,
  'backend/tests/routes/reputation-revoke-signer-gate-cycle-sql-shape.test.ts': 1,
  'backend/tests/routes/retract-rate-limit-skip-failed.test.ts': 1,
  'backend/tests/routes/review-agg-single-scan.test.ts': 1,
  'backend/tests/routes/reviews.test.ts': 3,
  'backend/tests/routes/search-partial-degradation.test.ts': 1,
  'backend/tests/routes/search-reviews-parity-gate.test.ts': 1,
  'backend/tests/routes/settings-email-fresh-auth.test.ts': 2,
  'backend/tests/routes/settings-set-password-argon-error-translation.test.ts': 3,
  'backend/tests/routes/settings-set-password-fresh-auth.test.ts': 1,
  'backend/tests/routes/settings.test.ts': 1,
  'backend/tests/routes/signup-verify-activation-lock-unavailable.test.ts': 1,
  'backend/tests/routes/signup-verify-activation-recovery.test.ts': 1,
  'backend/tests/routes/signup-verify-orcid-binding-guard.test.ts': 1,
  'backend/tests/routes/signup-verify-postbroadcast-severity.test.ts': 3,
  'backend/tests/routes/signup-verify-stuck-recovery.test.ts': 1,
  'backend/tests/routes/signup-verify.test.ts': 1,
  'backend/tests/routes/wot-retract-poll.test.ts': 1,
  'backend/tests/routes/wot-vouch-poll.test.ts': 1,
  'backend/tests/wot-vouch-status-select-real-postgres.test.ts': 2,
};

const DEFERRED_FILELESS: Readonly<Record<string, number>> = {
  'backend/tests/hafsql.test.ts': 1,
  'backend/tests/lib/flush-and-exit.test.ts': 1,
  'backend/tests/lib/fresh-auth.test.ts': 3,
  'backend/tests/lib/redis-command-timeout.test.ts': 1,
  'backend/tests/notification-arm-semantics.test.ts': 1,
  'backend/tests/routes/accreditation-idempotency.test.ts': 1,
  'backend/tests/routes/admin-fresh-auth-real-path-verifyhivesignature.test.ts': 1,
  'backend/tests/routes/citation-count-inverted-cte.test.ts': 1,
  'backend/tests/routes/display-claimer-self-review-exclusion.test.ts': 1,
  'backend/tests/routes/display-claimer-self-vote-revote-exclusion.test.ts': 1,
  'backend/tests/routes/ipfs.test.ts': 1,
  'backend/tests/routes/orcid.test.ts': 1,
  'backend/tests/routes/reputation-weights-signer-gate.test.ts': 1,
  'backend/tests/wot-broadcast-timeout.test.ts': 1,
};

// --- parsing -----------------------------------------------------------------

/**
 * Comment text as a reader sees it: compatibility-normalised, format
 * characters (soft hyphens, zero-width joiners) and combining marks (grapheme
 * joiners, variation selectors) dropped, every dash mapped to `-`, every space
 * separator mapped to a space. Applied to every collected block before any
 * pattern looks at it, so a look-alike character cannot make the label or a
 * path read one way and match another. Look-alike LETTERS are not folded; the
 * mixed-script check below refuses them instead.
 */
function normalizeCommentText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{M}/gu, '')
    .replace(/[\p{Pd}\u2212]/gu, '-')
    .replace(/\p{Zs}/gu, ' ');
}

/** Words that spell letters from the Latin script together with letters from
 *  any other script. A Cyrillic `а` inside `Real-path` is how a label hides
 *  from a regex while rendering identically.
 *
 *  This is a blunt instrument and it over-reaches: NFKC folds the micro sign
 *  U+00B5 to Greek mu, so the SI spelling of microseconds (`250µs`) is a
 *  mixed-script word here, as is `Δt`. Neither is a look-alike for anything
 *  Latin, and the ASCII spelling is the only remedy: the scan runs before the
 *  ratchet's exempt test, so the ALLOW_MARKER does not cover this verdict, and
 *  no backlog does either. Left as it is rather than narrowed on the way past,
 *  because which scripts are confusable is a decision worth taking
 *  deliberately; a symbol-carrying comment in a timing-sensitive suite is the
 *  shape that will hit it. */
function mixedScriptWords(text: string): string[] {
  const out: string[] = [];
  for (const word of text.match(/\p{L}+/gu) ?? []) {
    if (/\p{Script=Latin}/u.test(word) && /(?!\p{Script=Latin})\p{L}/u.test(word)) out.push(word);
  }
  return out;
}

interface Parsed {
  readonly sf: ts.SourceFile;
  readonly text: string;
  /** Every comment range, in source order, from the parser. */
  readonly comments: readonly ts.CommentRange[];
  /** The source with every comment blanked to spaces, newlines kept, so a
   *  position in it is a position in the source. */
  readonly code: string;
}

/**
 * TypeScript's parse of one file, with its comment ranges. Every comment is
 * trivia attached to some token, so walking to each token and asking for the
 * leading and trailing ranges at its edges finds them all, and nothing inside
 * a string, template or regular-expression literal is ever reported. JSDoc
 * subtrees are skipped: their child tokens sit INSIDE the comment, and asking
 * for trivia there would read prose as code. A node is a leaf once its JSDoc
 * children are set aside, which is what reaches a comment closing the file:
 * the end-of-file token's only child is the JSDoc it carries, so skipping the
 * subtree without asking the token itself would lose the block, and a claim
 * appended below the last statement would be invisible.
 */
function parse(text: string): Parsed {
  const sf = ts.createSourceFile('scanned.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const byPos = new Map<number, ts.CommentRange>();
  const add = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const r of ranges ?? []) if (!byPos.has(r.pos)) byPos.set(r.pos, r);
  };
  const isJSDoc = (n: ts.Node): boolean =>
    n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode;
  const walk = (node: ts.Node): void => {
    if (isJSDoc(node)) return;
    const children = node.getChildren(sf).filter((c) => !isJSDoc(c));
    if (children.length === 0) {
      add(ts.getLeadingCommentRanges(text, node.getFullStart()));
      add(ts.getTrailingCommentRanges(text, node.getEnd()));
      return;
    }
    for (const child of children) walk(child);
  };
  walk(sf);
  const comments = [...byPos.values()].sort((a, b) => a.pos - b.pos);
  const parts: string[] = [];
  let last = 0;
  for (const r of comments) {
    parts.push(text.slice(last, r.pos), text.slice(r.pos, r.end).replace(/[^\n]/g, ' '));
    last = r.end;
  }
  parts.push(text.slice(last));
  return { sf, text, comments, code: parts.join('') };
}

export interface CommentBlock {
  /** 1-based index of the block's opening line, for the failure text. */
  readonly firstLine: number;
  /** The block's text, delimiters and gutters stripped, normalised, still
   *  newline-separated so a citation that wraps can be rejoined inside a
   *  captured span. */
  readonly text: string;
}

/** A block comment's interior with its `*` gutter removed line by line; a
 *  `//` comment's text. Leading and trailing blank lines dropped, interior
 *  ones kept. */
function pieceText(text: string, r: ts.CommentRange): string[] {
  const raw = text.slice(r.pos, r.end);
  if (r.kind !== ts.SyntaxKind.MultiLineCommentTrivia) return [raw.slice(2).trim()];
  const lines = raw.slice(2, -2).split('\n').map((l) => l.replace(/^[ \t]*\*(?!\/)[ \t]?/, '').trim());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Every comment in the file, as blocks. A block comment is one block; a run of
 * `//` lines is one block; comment runs separated only by blank lines are one
 * block; a trailing comment on a code line stands alone unless the next
 * line's trailing comment continues it. Whole-file rather than header-only on
 * purpose: citations live in `//` comments and far below the imports in this
 * corpus, and a header-scoped scan would let any author evade the ratchet by
 * moving the block down the file. See WHAT COUNTS AS A COMMENT in the header
 * for why the parser, and the probes below for each shape.
 */
export function commentBlocks(lines: readonly string[]): CommentBlock[] {
  const parsed = parse(lines.join('\n'));
  const { sf, text, code } = parsed;
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line;
  const lineStart = (line: number): number => sf.getPositionOfLineAndCharacter(line, 0);
  interface Group { firstLine: number; pieces: string[]; end: number; endLine: number; trailing: boolean }
  const groups: Group[] = [];
  let current: Group | null = null;
  for (const r of parsed.comments) {
    const startLine = lineOf(r.pos);
    const endLine = lineOf(Math.max(r.pos, r.end - 1));
    const trailing = code.slice(lineStart(startLine), r.pos).trim() !== '';
    const pieces = pieceText(text, r);
    const continues =
      current !== null &&
      (code.slice(current.end, r.pos).trim() === '' ||
        (current.trailing && trailing && startLine === current.endLine + 1));
    if (current !== null && continues) {
      current.pieces.push(...pieces);
      current.end = r.end;
      current.endLine = endLine;
    } else {
      if (current !== null) groups.push(current);
      current = { firstLine: startLine + 1, pieces, end: r.end, endLine, trailing };
    }
  }
  if (current !== null) groups.push(current);
  return groups.map((g) => ({ firstLine: g.firstLine, text: normalizeCommentText(g.pieces.join('\n')) }));
}

/**
 * The two views of a block's text every prose detector reads, instead of the
 * raw block. Docblocks in this corpus wrap near 76 columns, so a claim or a
 * filename longer than a line is spelt across a wrap and a pattern with a
 * line-bounded window sees half of one: `rejoined` puts the halves back with
 * the space the wrap stood for, and `glued` puts them back with nothing, which
 * is what repairs a name the wrap broke INSIDE its last segment. Wrapping is
 * the corpus's default spelling rather than an unusual one, so a detector that
 * reads the raw block is defeated by the house style it is meant to police.
 */
const rejoined = (text: string): string => text.replace(/\s*\n\s*/g, ' ');
const glued = (text: string): string => text.replace(/\s*\n\s*/g, '');

/** Words that may not fill the label's qualifier slot: the label's own words
 *  (so two adjacent labels never fuse into one), and English connectives (so
 *  "the real path and companion fixtures" is prose, not a claim). */
const STOP_WORDS =
  'real|path|companions?|and|or|an?|the|its?|of|to|in|as|for|is|are|was|were|has|have|had|no|not|any|' +
  'every|each|this|that|these|those|which|by|on|at|from|only|also|still|then|than|but|so|if|be|it';

/** One qualifying word: a plain word, optionally wrapped in brackets, quotes
 *  or emphasis, followed by whitespace or a dash. Never a path or a sentence:
 *  `.` and `/` are not word characters, so a filename cannot fill the slot.
 *
 *  Every run inside a qualifier is bounded: the wrappers on either side, and
 *  the word between them. Those are cost bounds rather than taste, and the
 *  partition argument behind them is in `LABEL_SRC`'s docblock. The lengths
 *  sit well clear of any honest spelling here, whose longest qualifier word is
 *  ten characters and whose deepest wrapping is one bracket, so bounding them
 *  changes what parses as a label in no case this corpus or these probes
 *  contain. What a bound does cost is at its far side: a qualifier word longer
 *  than the bound is not a qualifier, so a claim carrying one is no longer a
 *  label, and if it also carries no colon within reach it is dropped rather
 *  than counted. Every finite bound has that edge; this one is placed past
 *  every identifier the codebase can name so that nothing honest reaches it.
 *
 *  The stop-word refusal rejects a qualifier that IS a stop word, not one that
 *  merely begins with one: `\b` falls between the `no` and the hyphen of
 *  `no-mock`, so under a `\b` the corpus's own commonest qualifier read as the
 *  stop word `no`, the label did not parse, and `Real-path no-mock companion
 *  \`some.test.ts\`` was neither a label nor (lacking a colon) a citation-shaped
 *  claim, so the block was dropped unaudited. Changing one word of it
 *  (`mock-free`) was caught. */
const QUALIFIER = String.raw`(?:(?!(?:${STOP_WORDS})(?![\w-]))[(\[\x60'"*_]{0,4}[\w-]{1,64}[)\]\x60'"*_]{0,4}[\s-]{1,4})`;

/**
 * The label, as a pattern source shared by the label count and both citation
 * parsers so they cannot drift: `real`, `path`, up to two qualifiers, optional
 * emphasis, `companion(s)`, joined by dashes or spaces or nothing. Matched
 * case-insensitively on normalised text, so `Real-path companion`, `real-path
 * SQL companion`, `Realpath companion`, `real-path-companion`, `Real-path
 * (Postgres) companion`, `Real-path \`argon2\` companion`, `**Real-path**
 * companion`, `Real-path \`companion\`` and `@realPathCompanion` all count.
 *
 * A section underline or separator written directly against `real-path`
 * (`real-path--------...`, or the same run in underscores, asterisks or
 * backticks) is the adversarial input here. Every way of splitting that run
 * between the label's own quantifiers is a partition the match explores before
 * it fails for want of `companion`, so the cost is set by how many partitions
 * the quantifiers admit between them. EVERY run in the label is therefore
 * bounded: `{0,4}` between the words, the emphasis run on either side of the
 * qualifier slot, the tag name in the markup alternative (`{1,16}`, clear of
 * every HTML element name), and, in QUALIFIER above, a qualifier word and its
 * wrappers. The tag name could not partition even unbounded, sitting between
 * literal `<` and `>`, so its bound exists to make this sentence true by
 * construction rather than to remove a cost.
 * The word's bound is `{1,64}`, comfortably clear of the longest exported
 * symbol name in `backend/src` (42 characters), so a qualifier that names an
 * identifier is never refused; a hyphenated compound is longer still and
 * splits across the two qualifier slots at its own dashes.
 *
 * Bounding only the dash-or-space runs was measured and is not enough. With
 * the qualifier's own word left unbounded the match stayed quadratic in the
 * length of a dash run: 6400 dashes cost about nine seconds through
 * `labelCount` and about nineteen through `citationsIn`, which embeds this
 * same source. Leaving the emphasis runs or a qualifier's wrappers unbounded
 * moves the same cost onto a run of underscores, asterisks or backticks, and
 * makes it worse, because an underscore is both a word character and an
 * emphasis character and two unbounded runs can split one between them: 800
 * underscores did not finish inside a minute. Fully unbounded (`[\s-]*` /
 * `[\s-]+`), 180 dashes already cost seconds. With every run bounded the work
 * is constant per starting position, measured flat from 6400 to 120,000
 * characters. A canary slow enough to look hung gets disabled, which is why
 * the separator-run timing spec puts a run of each of those shapes through
 * both `labelCount` and `citationsIn`, at three lengths, shortest first. The
 * lengths are not interchangeable: the worst regression class, QUALIFIER's
 * trailing separator reverted to `[\s-]+`, does not return at 6400 at all,
 * and a synchronous regex cannot be pre-empted by a test timeout, so only the
 * shortest pass turns that hang into a failure in seconds; quadratic growth
 * is invisible at the shortest length and needs the middle one; the cheapest
 * shapes grow so slowly that only the longest exposes them.
 */
const LABEL_SRC =
  String.raw`real[\s-]{0,4}path[\s-]{0,4}(?:[*_\x60]{1,4}[\s-]{0,4})?${QUALIFIER}{0,2}(?:<[a-z]{1,16}>|[*_\x60]{1,4})?companions?(?:\(s\))?`;

/** Anything that keeps a phrase going: a comma, a bracket, the dots inside a
 *  filename. Not a sentence break, which ends the phrase and begins an
 *  unrelated one, and without which "runs on the real path. The
 *  companion: covered" reads as a claim. (The longer spelling, "the companion
 *  suites pin it:", is held off by each arm on its own: the refusal ends the
 *  span at `. T` before the room after the noun is ever consulted, and that
 *  room alone is too tight for the fourteen characters between its noun and
 *  its colon. It therefore demonstrates neither arm in isolation, which is
 *  why the probes use the short spelling.) Load-bearing now
 *  that the span is matched across the wraps of a whole block rather than
 *  within one line.
 *
 *  The refusal is a lower-case-CONTINUATION rule, not capital detection, and
 *  it is broader than a sentence: `[.;!?]` plus one whitespace ends the phrase
 *  unless the very next character is an ASCII lower-case letter. A capital
 *  ends it, and so do a digit, a backtick, a bracket, a dash, a quote, a
 *  second space, a letter outside ASCII, and the end of the text. The one
 *  crossing is what earns the rule: a filename the docblock wrapped at its own
 *  dot (`custody-consent-ops.` / `test.ts`) rejoins as `. test.ts`, and that
 *  lower-case continuation is not a break, so the wrapped name is still seen.
 *
 *  That single exception is the whole point of the `(?![a-z])`, so the pattern
 *  this appears in (`looseClaimPattern`) is built WITHOUT the `i` flag: under
 *  `i`, `[a-z]` folds to match `A-Z` too, the lookahead can no longer tell a
 *  capital from a lower-case letter, and `real path. The companion:` is read
 *  as a claim. (The rest of the refusal survives `i`; only the letter arm
 *  collapses.) The literal words in `LOOSE_CLAIM_SRC` are spelt a class per
 *  letter by `anyCase` so that dropping the flag costs no casing recall.
 *
 *  The breadth is deliberate and is pinned in both directions by probes.
 *  Firing only before a capital would let prose above a `(c)` clause marker
 *  reach the claim below it, and that narrowing was measured against the
 *  corpus: it accuses an honest header and moves a backlog pin. What the
 *  breadth costs is the phrase-break near-miss family recorded in the
 *  header's list of gaps left open on purpose: a qualifier carrying any of
 *  `.`, `;`, `!` or `?` before a whitespace and a non-lower-case character,
 *  an abbreviation before a backtick and a semicolon joining two backticked
 *  paths alike. */
const CLAIM_SPAN = String.raw`(?:(?![.;!?]\s(?![a-z]))[^\n])`;

/** A plain lower-case word as a pattern source that matches in ANY casing
 *  without an `i` flag: one two-member class per letter, so `anyCase('real')`
 *  is `[Rr][Ee][Aa][Ll]`. `looseClaimPattern` cannot carry the flag, because
 *  the sentence-break refusal in `CLAIM_SPAN` needs `[a-z]` to keep meaning
 *  lower-case, so every literal letter it matches has to spell both of its own
 *  cases. Written out by hand only the LEADING letter of each word got a
 *  class, which left the loose guard with less casing recall than the label
 *  pattern it backs up: a near-miss written `REAL-PATH ... COMPANION:`, a
 *  spelling this corpus's own clause-(c) blocks use, matched neither, so its
 *  block yielded labels=0 and unparsed=0 and went unaudited. Building the
 *  classes makes "every letter, both cases" mechanical instead of something a
 *  later editor has to remember. */
const anyCase = (word: string): string =>
  [...word].map((letter) => `[${letter.toUpperCase()}${letter}]`).join('');

/** What a reader takes for a citation even when the label does not parse: the
 *  words `real`/`path` and `companion`, then a colon at most eight characters
 *  past the noun and any plural ending, with no sentence break between. Every
 *  such span must also be a label, or the block is a violation of its own.
 *  Matched on the rejoined block, because a qualifier odd enough to stop the
 *  label parsing is exactly the one the docblock wraps.
 *
 *  Ordinary prose of that shape is NOT spared. "running on the real path with
 *  a mocked companion here: the pool is stubbed" is accused, because ` here`
 *  is five characters and sits inside the room after the noun, and so is the
 *  same sentence with the colon straight after `companion`. Its block is
 *  classed `unparsed`, which is red. The author's remedy is to reword the
 *  sentence or to mark the block with the ALLOW_MARKER, which `blockShape`
 *  reads anywhere in the block, wrapped at one of its own hyphens or not. The
 *  room after the noun is kept tight because every extra character of slack
 *  accuses more of this prose, not because the tight room spares it. The
 *  header's list of gaps left open on purpose records the shape as a known
 *  precision cost, and the `accusedProse` probe pins it.
 *
 *  The literal words are spelt a class per LETTER by `anyCase`, not
 *  `real`/`path`/`companion` under an `i` flag, because the sentence-break
 *  refusal inside `CLAIM_SPAN` needs `(?![a-z])` to mean lower-case only; see
 *  that docblock. Every casing therefore reads here exactly as it does under
 *  `labelPattern`'s `i`, which is the point: a guard that exists to catch what
 *  the label pattern misses must not read fewer spellings than the label does.
 *  Both halves of the plural need it, the `s` and the `(s)`. The dash-or-space
 *  run between the words is bounded for the same reason `LABEL_SRC`'s is. */
const LOOSE_CLAIM_SRC =
  String.raw`${anyCase('real')}[\s-]{0,4}${anyCase('path')}${CLAIM_SPAN}{0,80}?${anyCase('companion')}[Ss]?(?:\([Ss]\))?${CLAIM_SPAN}{0,8}?:`;

/** Fresh objects on every call. All are `g`-flagged, and a shared instance
 *  carries `lastIndex` between calls, which silently skips matches.
 *  `looseClaimPattern` alone omits `i`: its source spells every letter of the
 *  label words as its own class (`anyCase`) so that `CLAIM_SPAN`'s `(?![a-z])`
 *  keeps meaning lower-case. */
const labelPattern = (): RegExp => new RegExp(LABEL_SRC, 'giu');
const labelAt = (): RegExp => new RegExp(`^${LABEL_SRC}`, 'iu');
const looseClaimPattern = (): RegExp => new RegExp(LOOSE_CLAIM_SRC, 'gu');
const AFTER_LABEL = String.raw`(?:</[a-z]+>|[*_\x60]+)?`;
const LINE_END = String.raw`(?:\s*\([^\n()]*\))?\.?[ \t]*(?=\n|$)`;
const forwardPattern = (): RegExp =>
  new RegExp(String.raw`${LABEL_SRC}${AFTER_LABEL}\s*:\s*\x60([^\x60]+)\x60\s*\[([^\n]+?)\]${LINE_END}`, 'giu');
const reversePattern = (): RegExp =>
  new RegExp(String.raw`${LABEL_SRC}${AFTER_LABEL}\s+for\s*:\s*\x60([^\x60]+)\x60${LINE_END}`, 'giu');

/** The one accepted spelling of a companion path: repo-relative, under the
 *  backend test tree, a test file. */
const COMPANION_PATH_RE = /^backend\/tests\/[\w./-]+\.test\.ts$/;
/** Test-tree directories whose files scan sources and run no route, so they
 *  can witness no risk class. */
const NON_RUNTIME_DIR_RE = /^backend\/tests\/(?:eslint|support)\//;

export interface Citation {
  /** `forward` names the real-path companion; `reverse` is a real-path suite
   *  naming the mocked suite it serves. */
  readonly kind: 'forward' | 'reverse';
  readonly companionPath: string;
  /** Empty for the reverse form. */
  readonly token: string;
  /** The citation's own text minus its path and token, each removed as the
   *  literal span it was captured as: the label, its qualifiers, and whatever
   *  trailed the bracket. A filename in here is prose beside the citation, not
   *  part of it, in whatever spelling — bare, backticked or bracketed. */
  readonly surround: string;
}

/**
 * Every structured citation in a block, forward and reverse.
 *
 * The path capture spans newlines and then has ALL whitespace removed. That is
 * what repairs a filename the docblock wrapped mid-token across a continuation
 * line — the corpus breaks paths after a hyphen and after a directory slash,
 * and a line-based extractor silently truncates the name and then reports a
 * file that does not exist. Paths never contain whitespace, so the strip is
 * lossless. The token capture stops at the line's end, so a second citation
 * on the same line is swallowed into the first's token and then rejected by
 * the validator's whitespace-free rule; the block is red either way.
 */
export function citationsIn(text: string): Citation[] {
  /** The citation's own path and token cut out of it as the LITERAL spans the
   *  match captured, never by sweeping the span for backticked or bracketed
   *  text. A sweep also erases a second path in the citation's trailer, and
   *  backticking a path is this convention's house style, so under a sweep the
   *  evading spelling of a half-true compound is the natural one and the caught
   *  spelling the unusual one. */
  const without = (span: string, part: string): string => {
    const i = span.indexOf(part);
    return i < 0 ? span : `${span.slice(0, i)} ${span.slice(i + part.length)}`;
  };
  const forward = [...text.matchAll(forwardPattern())].map((m) => ({
    kind: 'forward' as const,
    companionPath: m[1].replace(/\s+/g, ''),
    token: m[2].trim(),
    surround: without(without(m[0], `\x60${m[1]}\x60`), `[${m[2]}]`),
  }));
  const reverse = [...text.matchAll(reversePattern())].map((m) => ({
    kind: 'reverse' as const,
    companionPath: m[1].replace(/\s+/g, ''),
    token: '',
    surround: without(m[0], `\x60${m[1]}\x60`),
  }));
  return [...forward, ...reverse];
}

/** Every structured citation in a whole file's comments, wherever they sit.
 *  This is how the reverse form's link is resolved: by finding the citation
 *  that points back, not by testing whether the named file's text happens to
 *  contain the citing file's name. */
export function citationsInSource(source: string): Citation[] {
  return commentBlocks(source.split('\n')).flatMap((b) => citationsIn(b.text));
}

/** How many companion claims the block makes, structured or not. */
export function labelCount(text: string): number {
  return (text.match(labelPattern()) ?? []).length;
}

/**
 * Citation-shaped spans that do not parse as the label: the text a reader takes
 * for a claim, which the ratchet would otherwise skip in silence.
 *
 * Read off the rejoined block, so a claim the docblock wrapped is one span here
 * exactly as it is one claim to the reader, and the label test runs on that same
 * view so a wrapped LABEL stays a label. But read off the block with its
 * structured citations CUT OUT, plus each citation's own surround, rather than
 * off the block whole. Rejoining makes the whole docblock one line, and a
 * citation's own `companion:` would then terminate a span that began in
 * unrelated prose far above it: the corpus's standard clause-(a) wording ("any
 * case where exercising the real path per-test is impractical") sitting over a
 * perfectly written clause-(c) citation was accused, and the message blamed the
 * citation. Scanning the surround as well keeps a claim tucked into a citation's
 * trailing parenthetical visible, since that text is inside the citation's match
 * and would otherwise be cut away with it.
 */
function unparsedClaims(text: string): string[] {
  const scan = (span: string): string[] => {
    const one = rejoined(span);
    const out: string[] = [];
    for (const m of one.matchAll(looseClaimPattern())) {
      if (!labelAt().test(one.slice(m.index ?? 0))) out.push(m[0].trim());
    }
    return out;
  };
  return [...scan(proseRemainder(text)), ...citationsIn(text).flatMap((c) => scan(c.surround))];
}

/** Text that is not a filename however it is spelt: mail addresses, URL scheme
 *  and host, the reserved `example.test` domain, and a `RE.test(...)` method
 *  call. Only the scheme and authority of a URL go, never its path: a `.test`
 *  HOST is a domain and not a file, but a link whose path ends in a test file
 *  names that file as surely as the repo-relative spelling does, and blanking
 *  the whole token let the half-true compound be written as a link. */
function scrubNonFiles(text: string): string {
  return text
    .replace(/\S+@\S+/g, ' ')
    .replace(/\b\w+:\/\/[^/\s]*/g, ' ')
    .replace(/\bexample\.(?:test|spec)\b/g, ' ')
    // `.env.test` is an env file, and root `CLAUDE.md` gives `frontend/.env.test`
    // a paragraph of its own, so a header naming it is an ordinary write. The
    // suffix-less pattern starts happily on the dot and read it as a test file.
    .replace(/(?<!\w)\.env\.(?:test|spec)(?:\.\w+)?\b/g, ' ')
    .replace(/\.(?:test|spec)\s*\(/g, ' (');
}
const NAMED_WITH_EXTENSION_RE = /[\w.-]*[\w.*)\]}-]\.(?:test|spec)\.[cm]?[jt]sx?\b/;
const NAMED_WITHOUT_EXTENSION_RE = /[\w.-]+\.(?:test|spec)\b(?!\.[cm]?[jt]sx?\b)/;
const TESTS_TREE_PATH_RE = /\btests\/(?!(?:fixtures|support)\/)[\w-]+\/[\w-]+(?:\/[\w-]+)*(?![\w./-])/;

/**
 * Does a span of prose name a test file? `name.test.ts` (a glob or an
 * alternation such as `custody-*.test.ts` included), the suffix-less
 * `name.test`, a spec, a frontend `.test.js`, or a `tests/<dir>/<name>` path
 * with no extension, since a reader takes each of those for a file; not a
 * fixture or support module, a mail address, a URL, or a method call. Read off
 * both rejoined views: the spaced one keeps a word's boundary before `tests/`,
 * the glued one repairs a name the docblock wrapped inside its last segment.
 */
function namesATestFile(text: string): boolean {
  const spaced = scrubNonFiles(rejoined(text));
  const unwrapped = scrubNonFiles(glued(text));
  return (
    NAMED_WITH_EXTENSION_RE.test(spaced) ||
    NAMED_WITH_EXTENSION_RE.test(unwrapped) ||
    NAMED_WITHOUT_EXTENSION_RE.test(spaced) ||
    TESTS_TREE_PATH_RE.test(spaced) ||
    TESTS_TREE_PATH_RE.test(unwrapped)
  );
}

/** The block with every structured citation cut out. What remains is prose,
 *  and prose that still names a test file is a claim nothing checks. */
function proseRemainder(text: string): string {
  return text.replace(forwardPattern(), ' ').replace(reversePattern(), ' ');
}

// --- validation --------------------------------------------------------------

/** Calls whose bodies are a mock, a stub or a spy rather than the code under
 *  test, and calls whose first argument is a spec title. */
const MOCK_CALL_RE =
  /^vi\.(?:mock|doMock|unmock|doUnmock|hoisted|spyOn|stubGlobal|stubEnv|mocked|fn|importMock)$|\.mock(?:ResolvedValue|RejectedValue|ReturnValue|Implementation|ReturnThis|Name)(?:Once)?$/;
const SPEC_CALL_RE = /^(?:describe|it|test)\b/;

/**
 * The companion's code: the source with every comment removed (the parser's
 * ranges, so a `/*` inside a string or template literal deletes nothing), then
 * every vitest mocking call together with its factory or stub body, then every
 * `describe`/`it`/`test` title string. See WHY COMMENTS, MOCK BODIES AND
 * TITLES DO NOT COUNT in the header.
 */
export function codeOf(source: string): string {
  const parsed = parse(source);
  const spans: Array<[number, number]> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(parsed.sf);
      if (MOCK_CALL_RE.test(callee)) {
        spans.push([node.getStart(parsed.sf), node.getEnd()]);
        return;
      }
      const title = node.arguments[0];
      if (SPEC_CALL_RE.test(callee) && title !== undefined && (ts.isStringLiteralLike(title) || ts.isTemplateExpression(title))) {
        spans.push([title.getStart(parsed.sf), title.getEnd()]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed.sf);
  let code = parsed.code;
  for (const [start, end] of spans) {
    code = code.slice(0, start) + code.slice(start, end).replace(/[^\n]/g, ' ') + code.slice(end);
  }
  return code;
}

/** The token as a whole word: not preceded or followed by an identifier
 *  character where the token itself begins or ends with one, so `hafQuery`
 *  is not satisfied by `hafQueryMock`. Tokens that begin or end in
 *  punctuation (`rows[0].author_index`, `/api/settings/set-password`) keep
 *  their own edges. */
export function tokenMatcher(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const lead = /^[\w$]/.test(token) ? '(?<![\\w$])' : '';
  const trail = /[\w$]$/.test(token) ? '(?![\\w$])' : '';
  return new RegExp(`${lead}${escaped}${trail}`);
}

const codeCache = new WeakMap<ScannedSource, string>();
function codeOfSource(source: ScannedSource): string {
  let code = codeCache.get(source);
  if (code === undefined) {
    code = codeOf(source.lines.join('\n'));
    codeCache.set(source, code);
  }
  return code;
}

/** Files under the walk root whose CODE (comments, mock bodies and titles
 *  removed) spells the token as a whole word. */
export function tokenReach(token: string, sources: readonly ScannedSource[]): number {
  const matcher = tokenMatcher(token);
  return sources.filter((s) => matcher.test(codeOfSource(s))).length;
}

/**
 * Validate one structured citation. Returns the reasons it fails, empty when it
 * holds. `citingRepoPath` is repo-relative so a self-citation is detectable and
 * the reverse form can look for this file's name in the suite it names.
 */
export function citationViolations(
  citingRepoPath: string,
  citation: Citation,
  sources: readonly ScannedSource[],
  readSource: (repoPath: string) => string | null,
): string[] {
  const { companionPath, token } = citation;
  const out: string[] = [];

  if (!COMPANION_PATH_RE.test(companionPath) || path.posix.normalize(companionPath) !== companionPath) {
    // The shape test alone admits `//`, `/./` and `/../` segments, because `.`
    // and `/` are both inside its character class. Every arm below then works
    // on one of two different notions of the path: the self-citation compare
    // and the reverse back-link filter are string equality, while reading the
    // file canonicalises. So `routes//self.test.ts` is not the citing file to
    // arm 3 and is exactly it to the reader, and `backend/tests/../x.test.ts`
    // is a witness in a directory this canary never walks, whose own citations
    // are never audited and whose token scores zero against the reach cap.
    out.push(
      `companion path ${JSON.stringify(companionPath)} is not repo-relative; ` +
        'write it as `backend/tests/<dir>/<name>.test.ts`',
    );
    return out;
  }
  if (companionPath === SELF_REPO_PATH) {
    out.push(
      `companion ${companionPath} is this canary, which is excluded from its own ` +
        'scan; the worked examples in its header are documentation, not citations',
    );
    return out;
  }
  if (companionPath === citingRepoPath) {
    out.push('cites itself as its own real-path companion, which proves nothing');
    return out;
  }
  if (citation.kind === 'forward' && NON_RUNTIME_DIR_RE.test(companionPath)) {
    out.push(`companion ${companionPath} is a source-scanning canary or a support module, which runs no route and witnesses nothing`);
    return out;
  }
  if (citation.kind === 'forward' && (!/^\S+$/.test(token) || token.length > 80)) {
    out.push(
      `risk-class token ${JSON.stringify(token)} must be a single whitespace-free code token`,
    );
    return out;
  }

  const source = readSource(companionPath);
  if (source === null) {
    out.push(`companion ${companionPath} does not exist`);
    return out;
  }
  if (citation.kind === 'reverse') {
    // The back-link is resolved by comparing PATHS, and a path parsed out of
    // the named file has not been through the canonicalisation arm above (that
    // arm guards the citing side). Canonicalise both sides here rather than
    // trusting the caller to, so the link holds structurally and not by
    // call-site position: `backend/tests/routes/./this.test.ts` written as a
    // back-citation still answers a declaration this file makes, and a `..`
    // spelling that resolves elsewhere still does not.
    const citingCanonical = path.posix.normalize(citingRepoPath);
    const back = citationsInSource(source).filter((c) => path.posix.normalize(c.companionPath) === citingCanonical);
    if (back.length === 0) {
      out.push(
        `${companionPath} is named as the suite this file is the companion for, but it ` +
          `carries no companion citation naming ${citingRepoPath}. The link is resolved ` +
          'by path from both ends; a mention of this file\'s name in its prose or code is ' +
          'not one, and hundreds of such cross-mentions already exist under backend/tests',
      );
      return out;
    }
    if (!back.some((c) => c.kind === 'forward')) {
      out.push(
        `${companionPath} answers this declaration with the reverse form as well, so ` +
          'neither end names a risk class and nothing is witnessed. The suite taking the ' +
          `carve-out writes the forward form: ${STRUCTURED_FORM}`,
      );
    }
    return out;
  }
  if (!tokenMatcher(token).test(codeOf(source))) {
    const inSource = source.includes(token);
    out.push(
      `companion ${companionPath} does not assert ${JSON.stringify(token)} in code` +
        (inSource
          ? ' (the only occurrences are in comments, in a mocking call, in a spec title, or inside a longer identifier, which is how a' +
            ' companion that mocks the surface it was cited for reads)'
          : ' (the token does not occur there at all)'),
    );
  }
  const reach = tokenReach(token, sources);
  if (reach > TOKEN_FILE_CAP) {
    out.push(
      `risk-class token ${JSON.stringify(token)} is spelt in code by ${reach} files under ` +
        'backend/tests, so it witnesses nothing specific; cite the code token the ' +
        'companion actually asserts',
    );
  }
  return out;
}

// --- the ratchet -------------------------------------------------------------

/** The facts about a labelled block that the ratchet decides on. A plain shape,
 *  so the planted probes below can drive `ratchetClass` with synthetic inputs
 *  and prove each branch, the exempt one included, is live. */
interface BlockShape {
  readonly labels: number;
  readonly citations: number;
  /** Citation-shaped spans that did not parse as the label. */
  readonly unparsed: number;
  /** A test filename in what is left once the structured citations are cut,
   *  or inside a citation's own surround. */
  readonly remainderNamesAFile: boolean;
  readonly exempt: boolean;
}

/** The scan and the probes derive a block's shape through this one function,
 *  so a mangled pattern is caught by the probes rather than emptying a class. */
function blockShape(text: string): BlockShape {
  const citations = citationsIn(text);
  return {
    labels: labelCount(text),
    citations: citations.length,
    unparsed: unparsedClaims(text).length,
    remainderNamesAFile: namesATestFile(proseRemainder(text)) || citations.some((c) => namesATestFile(c.surround)),
    // Read on both views: the marker is long enough to be wrapped, and it
    // breaks at one of its own hyphens when it is. A marker that fails to
    // match does not fail open, it fails RED on a block whose author did
    // everything asked of them.
    exempt: text.includes(ALLOW_MARKER) || glued(text).includes(ALLOW_MARKER),
  };
}

/**
 * What the ratchet makes of a block:
 *
 *   - `exempt`: carries the ALLOW_MARKER; skipped by the ratchet only.
 *   - `unparsed`: carries a citation-shaped span that is not a label. Always a
 *     violation; nothing else about the block is judged.
 *   - `structured`: one structured citation per label and no filename left in
 *     the prose. The only shape that passes on its own merits.
 *   - `leaky`: fully structured, but the prose beside the citations still
 *     names a test file. The half-true compound; always a violation.
 *   - `free-prose`: fewer citations than labels, and the prose names a test
 *     file. Convertible, and pinned in DEFERRED_FREE_PROSE for now.
 *   - `fileless`: fewer citations than labels, and no file named in the prose.
 *     Unresolvable by any parser, hence rejected rather than validated, and
 *     pinned in DEFERRED_FILELESS for now.
 */
type RatchetClass = 'exempt' | 'unparsed' | 'structured' | 'leaky' | 'free-prose' | 'fileless';

function ratchetClass(b: BlockShape): RatchetClass {
  if (b.exempt) return 'exempt';
  if (b.unparsed > 0) return 'unparsed';
  if (b.citations < b.labels) return b.remainderNamesAFile ? 'free-prose' : 'fileless';
  return b.remainderNamesAFile ? 'leaky' : 'structured';
}

interface BlockAudit {
  readonly repoPath: string;
  readonly block: CommentBlock;
  readonly citations: Citation[];
  readonly shape: BlockShape;
  readonly cls: RatchetClass;
}

const repoPathOf = (rel: string): string => `backend/tests/${rel}`;

/** Every labelled block in the given sources, classified, plus every
 *  mixed-script word in any comment. The whole-tree scan and the synthetic
 *  probes go through this one function. */
function auditSources(from: readonly ScannedSource[]): { audits: BlockAudit[]; mixed: string[] } {
  const audits: BlockAudit[] = [];
  const mixed: string[] = [];
  for (const source of from) {
    for (const block of commentBlocks(source.lines)) {
      const repoPath = repoPathOf(source.rel);
      for (const word of mixedScriptWords(block.text)) {
        mixed.push(`${repoPath} (comment block opening at line ${block.firstLine}) — ${JSON.stringify(word)}`);
      }
      const shape = blockShape(block.text);
      if (shape.labels === 0 && shape.unparsed === 0) continue;
      audits.push({ repoPath, block, citations: citationsIn(block.text), shape, cls: ratchetClass(shape) });
    }
  }
  return { audits, mixed };
}

/** Per-file label deficit (labels minus structured citations) summed over the
 *  blocks of one ratchet class; files with none are absent. */
function deficitByFile(cls: RatchetClass, from: readonly BlockAudit[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of from) {
    if (a.cls !== cls) continue;
    out.set(a.repoPath, (out.get(a.repoPath) ?? 0) + (a.shape.labels - a.shape.citations));
  }
  return out;
}

const at = (a: BlockAudit): string => `${a.repoPath} (comment block opening at line ${a.block.firstLine})`;

/** Every structured citation in every block, whatever its class, validated. */
function validationViolations(
  from: readonly BlockAudit[],
  sources: readonly ScannedSource[],
  readSource: (repoPath: string) => string | null,
): string[] {
  const out: string[] = [];
  for (const audit of from) {
    for (const citation of audit.citations) {
      for (const reason of citationViolations(audit.repoPath, citation, sources, readSource)) {
        out.push(`${at(audit)} — ${reason}`);
      }
    }
  }
  return out;
}

const hasOwn = (o: Readonly<Record<string, number>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, key);

/**
 * Reconcile one backlog class against the tree. `actual` is the per-file label
 * deficit in that class as scanned (files with none are absent); `live` is the
 * editable pin map; `frozen` is the never-edited landing snapshot. Returns
 * every way the three disagree, each naming the file and the direction. Own
 * properties only, so a prototype entry admits nothing; a pin is a positive
 * integer, so `NaN` switches no arm off.
 */
function reconcileBacklog(
  actual: ReadonlyMap<string, number>,
  live: Readonly<Record<string, number>>,
  frozen: Readonly<Record<string, number>>,
): string[] {
  const out: string[] = [];
  for (const [file, pin] of Object.entries(live)) {
    if (!Number.isInteger(pin) || pin < 1) {
      out.push(`${file} — pinned at ${String(pin)}; a pin is a positive integer (remove the entry rather than pinning zero)`);
      continue;
    }
    if (!hasOwn(frozen, file)) {
      out.push(
        `${file} — pinned at ${pin} but absent from the landing snapshot. The backlog ` +
          'admits no new files; write the structured form instead',
      );
      continue;
    }
    if (pin > frozen[file]) {
      out.push(`${file} — pin ${pin} exceeds its landing count of ${frozen[file]}; a pin never exceeds its landing count`);
    }
  }
  const files = [...new Set([...Object.keys(live), ...actual.keys()])].sort();
  for (const file of files) {
    const n = actual.get(file) ?? 0;
    if (!hasOwn(live, file)) {
      out.push(
        `${file} — ${n} unstructured companion claim(s) and no backlog entry. ` +
          `Write each one as: ${STRUCTURED_FORM}`,
      );
      continue;
    }
    const pin = live[file];
    if (!Number.isInteger(pin)) continue;
    if (n > pin) {
      out.push(
        `${file} — ${n} unstructured companion claim(s), pinned at ${pin}. The backlog ` +
          `admits no new claims; the new one(s) are written as: ${STRUCTURED_FORM}`,
      );
    } else if (n < pin) {
      out.push(
        `${file} — ${n} unstructured companion claim(s) remain, pinned at ${pin}. Lower ` +
          'the pin (remove the entry at zero). If a claim was deleted rather than ' +
          'converted, this edit is what makes that visible',
      );
    }
  }
  return out;
}

/** sha256 over the maps' sorted own entries, in declaration order. */
function snapshotDigest(...maps: Array<Readonly<Record<string, number>>>): string {
  const canonical = maps.map((m) => Object.entries(m).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// --- the scan ----------------------------------------------------------------

const allSources = sourcesUnder(testsRoot);
const sources = allSources.filter((s) => s.rel !== SELF_REL);
const readFromRepo = (repoPath: string): string | null => {
  const abs = path.resolve(repoRoot, repoPath);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
};
const scanned = auditSources(sources);
const audits = scanned.audits;

describe('carve-out clause-(c) companion citations resolve and are witnessed', () => {
  it('walks a plausible number of test files, symlinks included (guards against a broken walker)', () => {
    // Without this, a walker that returned nothing makes every assertion below
    // vacuously true and the canary enforces nothing.
    expect(sources.length).toBeGreaterThan(200);
    const rels = sources.map((s) => s.rel);
    expect(rels).toContain('routes/custody-upgrade.test.ts');
    expect(rels).toContain('middleware/verifyHiveSignature-session-invalidation-failclosed.test.ts');
    // The self-exclusion must exclude something. An exclusion that silently
    // matches nothing is the same vacuity class as a broken walker.
    expect(
      allSources.map((s) => s.rel),
      'this canary was renamed; update SELF_REL or it starts scanning its own fixtures',
    ).toContain(SELF_REL);
    expect(rels).not.toContain(SELF_REL);
    // Anti-vacuity for the audit set itself: a mangled label pattern would
    // empty it and pass everything.
    expect(audits.length).toBeGreaterThan(100);

    // vitest's file glob follows symlinks, so a symlinked test file or
    // directory runs as part of the suite; a walker that skipped it would
    // leave a whole file outside both the ratchet and validation. A dangling
    // link is skipped rather than thrown on.
    const tmp = mkdtempSync(path.join(tmpdir(), 'pevo-companion-walker-'));
    try {
      mkdirSync(path.join(tmp, 'sub'));
      writeFileSync(path.join(tmp, 'sub', 'real.test.ts'), 'export {};\n');
      symlinkSync(path.join(tmp, 'sub', 'real.test.ts'), path.join(tmp, 'linked.test.ts'));
      symlinkSync(path.join(tmp, 'sub'), path.join(tmp, 'linkdir'));
      symlinkSync(path.join(tmp, 'nowhere.test.ts'), path.join(tmp, 'dangling.test.ts'));
      expect(sourcesUnder(tmp).map((s) => s.rel).sort()).toEqual([
        'linkdir/real.test.ts',
        'linked.test.ts',
        'sub/real.test.ts',
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('every structured citation resolves and its risk-class token is asserted in the companion', () => {
    const violations = validationViolations(audits, sources, readFromRepo);
    expect(
      violations,
      'a clause-(c) companion citation names a companion that cannot witness the ' +
        'risk class it was cited for. The citation is the only artifact tying the ' +
        'mock to its justification, so a false one voids the carve-out silently:\n' +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('every citation-shaped line parses as the label, and no comment word mixes scripts', () => {
    const unparsed = audits.filter((a) => a.cls === 'unparsed').map(at);
    expect(
      unparsed,
      'a line reads as a companion citation (real-path ... companion:) but does not ' +
        'parse as one: a filename, a path or a sentence sits in the qualifier slot. ' +
        `Write it as: ${STRUCTURED_FORM}. A line that is prose and not a claim is ` +
        `reworded, or its block is marked ${ALLOW_MARKER}:\n${unparsed.join('\n')}`,
    ).toEqual([]);
    expect(
      scanned.mixed,
      'a comment spells a word in mixed scripts. A look-alike letter renders as the ' +
        `plain label or filename and hides it from every pattern:\n${scanned.mixed.join('\n')}`,
    ).toEqual([]);
  });

  it('a structured block names no test file in the prose beside its citations', () => {
    const leaky = audits.filter((a) => a.cls === 'leaky').map(at);
    expect(
      leaky,
      'a block whose companion claims are all structured still names a test file ' +
        'in its prose (or inside a citation\'s own qualifier slot). That is one checked ' +
        'citation vouching for an unchecked one, which is the half-true compound this ' +
        'canary exists to reject. Either cite the file in the structured form or drop ' +
        `the filename from the prose:\n${leaky.join('\n')}`,
    ).toEqual([]);
  });

  it('every file-naming prose claim is in the backlog at exactly its pin, bounded by the landing snapshot', () => {
    const disagreements = reconcileBacklog(deficitByFile('free-prose', audits), DEFERRED_FREE_PROSE, LANDING_FREE_PROSE);
    expect(
      disagreements,
      'the tree and DEFERRED_FREE_PROSE disagree. A new file, or a new claim in a ' +
        `listed file, is written as ${STRUCTURED_FORM} rather than added here; a ` +
        'converted claim lowers its file\'s pin. (A citation whose token bracket does ' +
        'not close its line does not parse and counts as a claim.)\n' +
        disagreements.join('\n'),
    ).toEqual([]);
  });

  it('every file-less companion claim is in its backlog at exactly its pin, bounded by the landing snapshot', () => {
    const disagreements = reconcileBacklog(deficitByFile('fileless', audits), DEFERRED_FILELESS, LANDING_FILELESS);
    expect(
      disagreements,
      'the tree and DEFERRED_FILELESS disagree. A companion claim that names no ' +
        'file is unresolvable by any parser and is not admitted: either cite the ' +
        `file that witnesses it as ${STRUCTURED_FORM}, a real-path suite declares ` +
        'itself with `Real-path companion for: `backend/tests/<dir>/<mocked>.test.ts``, ' +
        `or keep the prose and mark the block ${ALLOW_MARKER}:\n${disagreements.join('\n')}`,
    ).toEqual([]);
  });

  it('the landing snapshot is unchanged (a digest tripwire, not a guarantee)', () => {
    // A change to any entry or count in either snapshot map changes the digest,
    // so it needs a recomputed literal beside it. That is the most this file can
    // do about its own root of trust; see the snapshot docblock.
    expect(Object.keys(LANDING_FREE_PROSE).length).toBe(103);
    expect(Object.keys(LANDING_FILELESS).length).toBe(14);
    expect(snapshotDigest(LANDING_FREE_PROSE, LANDING_FILELESS)).toBe(LANDING_DIGEST);
    // A `__proto__` key in an object literal sets its prototype rather than an
    // own entry, which no digest of own entries would see.
    for (const m of [LANDING_FREE_PROSE, LANDING_FILELESS, DEFERRED_FREE_PROSE, DEFERRED_FILELESS]) {
      expect(Object.getPrototypeOf(m)).toBe(Object.prototype);
    }
  });

  it('the collector reads comments as the language does', () => {
    const texts = (lines: string[]): string[] => commentBlocks(lines).map((b) => b.text);

    // A block closing the file, below the last statement, is collected: the
    // end-of-file token carries it as its own JSDoc child, so a walk that
    // skipped every JSDoc subtree without asking that token would lose it and
    // a claim appended to any file would be invisible.
    expect(texts(['const a = 1;', '', '/**', ' * (c) Real-path companion: nothing-here.test.ts covers it.', ' */']))
      .toEqual(['(c) Real-path companion: nothing-here.test.ts covers it.']);
    expect(texts(['const a = 1;', '// a trailing note'])).toEqual(['a trailing note']);

    // A `//` run and a docblock separated by CODE are separate blocks; a
    // header-only parser would see neither of the `//` ones.
    expect(texts([
      '/**', ' * Real-path companion: `backend/tests/a.test.ts` [ALPHA]', ' */',
      'const x = 1;',
      '// Real-path companion: `backend/tests/b.test.ts` [BETA]',
    ])).toEqual([
      'Real-path companion: `backend/tests/a.test.ts` [ALPHA]',
      'Real-path companion: `backend/tests/b.test.ts` [BETA]',
    ]);

    // Separated only by a blank line, they are ONE block, so a note under a
    // header cannot hide a filename beside the header's citations.
    expect(texts([
      '/**', ' * Real-path companion: `backend/tests/a.test.ts` [ALPHA]', ' */',
      '',
      '// see also b.test.ts',
      'import x from "y";',
    ])).toEqual(['Real-path companion: `backend/tests/a.test.ts` [ALPHA]\nsee also b.test.ts']);

    // A trailing comment on a code line is a block of its own, and two on
    // consecutive code lines are one block, so a claim split across the
    // comment column is still one claim.
    expect(texts(["vi.mock('../../src/app-db.js', () => ({})); // (c) Real-path companion: routes/a.test.ts covers it"]))
      .toEqual(['(c) Real-path companion: routes/a.test.ts covers it']);
    expect(texts([
      "vi.mock('../../src/app-db.js', () => ({})); // (c) Real-path",
      "vi.mock('../../src/redis.js', () => ({}));  //     companion: routes/a.test.ts covers it",
    ])).toEqual(['(c) Real-path\ncompanion: routes/a.test.ts covers it']);

    // A block comment opened at the END of a code line spans lines as one
    // block, so a structured citation inside it is parsed and validated.
    expect(texts([
      "vi.mock('../../src/app-db.js', () => ({})); /* Carve-out clause (c).",
      '   Real-path companion: `backend/tests/a.test.ts` [ALPHA]',
      '   drives it. */',
    ])).toEqual(['Carve-out clause (c).\nReal-path companion: `backend/tests/a.test.ts` [ALPHA]\ndrives it.']);

    // A block comment without a `*` gutter, a docblock with a bare continuation
    // line, and a docblock with a blank line inside: each is one block, with
    // every interior line in it.
    expect(texts(['/*', '  (c) Real-path companion: routes/a.test.ts drives it.', '*/']))
      .toEqual(['(c) Real-path companion: routes/a.test.ts drives it.']);
    expect(texts(['/**', ' * Real-path companion: `backend/tests/a.test.ts` [ALPHA]', '     and b.test.ts too', ' */']))
      .toEqual(['Real-path companion: `backend/tests/a.test.ts` [ALPHA]\nand b.test.ts too']);
    expect(texts(['/**', ' * Real-path companion: `backend/tests/a.test.ts` [ALPHA]', '', ' * and b.test.ts too', ' */']))
      .toEqual(['Real-path companion: `backend/tests/a.test.ts` [ALPHA]\n\nand b.test.ts too']);

    // A one-line block comment parses cleanly, closer removed, so the
    // end-of-line anchor on the token still holds.
    expect(citationsIn(texts(['/* Real-path companion: `backend/tests/a.test.ts` [ALPHA] */'])[0]).map((c) => c.token))
      .toEqual(['ALPHA']);

    // Markers inside literals are code. These are the shapes that broke a
    // line-prefix heuristic: a sentinel whose VALUE is a SQL block comment, a
    // predicate testing for the opener, a URL, a template literal whose
    // closing line carries a trailing claim with backticks in it, a regex
    // holding a quote before a claim with an apostrophe, and a regex holding
    // `/*`, which must open no phantom block.
    expect(texts(["const SENTINEL = '/* search.reviews.branch */';", 'const ALPHA = 1;'])).toEqual([]);
    expect(texts(["if (trimmed.startsWith('/*')) return true;", 'const ALPHA = 1; // tail'])).toEqual(['tail']);
    expect(texts(["const u = 'https://example.test/x'; // note"])).toEqual(['note']);
    expect(texts([
      'const SQL = `',
      '  SELECT 1',
      '`; // (c) Real-path companion: `backend/tests/a.test.ts` runs this shape against real Postgres',
    ])).toEqual(['(c) Real-path companion: `backend/tests/a.test.ts` runs this shape against real Postgres']);
    expect(texts(["const RE = /'/g; // (c) Real-path companion: routes/a.test.ts asserts the companion's escaping"]))
      .toEqual(["(c) Real-path companion: routes/a.test.ts asserts the companion's escaping"]);
    expect(texts([
      'const TRAILING = /\\/*$/;',
      '// Real-path companion: `backend/tests/a.test.ts` [ALPHA]',
      "const ALLOWED = ['routes/b.test.ts'];",
    ])).toEqual(['Real-path companion: `backend/tests/a.test.ts` [ALPHA]']);
    // And a labelled line INSIDE a template-literal fixture is data, not a
    // claim: a canary-style test holding synthetic source text makes no
    // clause-(c) claim by holding it.
    expect(texts([
      'const FIXTURE = `',
      '/**',
      ' * (c) Real-path companion: routes/settings.test.ts drives the live path.',
      ' */',
      '`;',
      'const ALPHA = 1;',
    ])).toEqual([]);

    // Normalisation: a look-alike hyphen, a non-breaking space, an invisible
    // zero-width space, a soft hyphen, a combining grapheme joiner and a
    // fullwidth letter all read as the plain label.
    const spellings = [
      'Real\u2011path companion', 'Real\u00A0path companion', 'Re\u200Bal-path companion',
      'Real\u00ADpath companion', 'Real\u034Fpath companion', '\uFF32eal-path companion',
    ];
    for (const spelt of spellings) {
      expect(labelCount(texts(['/**', ` * ${spelt}: x`, ' */'])[0]), JSON.stringify(spelt)).toBe(1);
    }
    // A look-alike LETTER is refused rather than folded: a Cyrillic `а` in
    // `Reаl-path` and a Cyrillic `е` in `settings.tеst.ts` are mixed-script
    // words; plain Latin and a whole-word non-Latin name are not.
    expect(mixedScriptWords('Re\u0430l-path companion: settings.t\u0435st.ts')).toEqual(['Re\u0430l', 't\u0435st']);
    expect(mixedScriptWords('Real-path companion: settings.test.ts, per M\u00FCller and \u041F\u0435\u0442\u0440\u043E\u0432')).toEqual([]);
  });

  it('the parser and validators fire on planted-bad citations and spare legitimate ones', () => {
    // Planted probes go through the SAME functions the scan above calls. Without
    // them, an edit that mangles a pattern leaves every set empty, the canary
    // stays green, and it enforces nothing. The citation strings here are
    // synthetic fixtures held as string literals; this file is excluded from the
    // walk, so they cannot self-trip.
    const block = (...lines: string[]): string => lines.join('\n');
    const tokens = (text: string): string[] => citationsIn(text).map((c) => c.token);
    const classOfText = (text: string): RatchetClass => ratchetClass(blockShape(text));

    // Parser POSITIVES.
    expect(citationsIn(block(' (c) Real-path companion: `backend/tests/routes/custody-upgrade.test.ts` [SESSION_INVALIDATED]')))
      .toEqual([{
        kind: 'forward', companionPath: 'backend/tests/routes/custody-upgrade.test.ts', token: 'SESSION_INVALIDATED',
        surround: expect.stringContaining('Real-path companion'),
      }]);

    // Two companions, the second on a continuation line with no `(c)` marker.
    // A non-global match, or one that requires the clause marker, checks only
    // the first and under-checks the rest in silence.
    expect(tokens(block(
      ' (c) Real-path companion: `backend/tests/a.test.ts` [ALPHA]',
      '     Real-path companion: `backend/tests/b.test.ts` [BETA]',
    ))).toEqual(['ALPHA', 'BETA']);

    // A path wrapped MID-TOKEN across a continuation line. This is the form a
    // line-based extractor truncates into a nonexistent file, and it occurs in
    // this corpus at a hyphen and after a directory slash.
    expect(citationsIn(block(
      ' (c) Real-path companion: `backend/tests/routes/ipfs-upload-real-path-',
      '     verifyhivesignature.test.ts` [uploadToken]',
    )).map((c) => c.companionPath)).toEqual(['backend/tests/routes/ipfs-upload-real-path-verifyhivesignature.test.ts']);

    // A trailing full stop or a short parenthetical after the bracket is an
    // ordinary way to close a line and still parses; a second citation on the
    // same line does not, and is then rejected by the validator.
    expect(tokens(' Real-path companion: `backend/tests/a.test.ts` [ALPHA].')).toEqual(['ALPHA']);
    expect(tokens(' Real-path companion: `backend/tests/a.test.ts` [ALPHA] (the 401 arm)')).toEqual(['ALPHA']);
    expect(tokens(' Real-path companion(s): `backend/tests/a.test.ts` [ALPHA]')).toEqual(['ALPHA']);
    expect(tokens(' Real-path companion: `backend/tests/a.test.ts` [A] Real-path companion: `backend/tests/b.test.ts` [B]'))
      .toEqual(['A] Real-path companion: `backend/tests/b.test.ts` [B']);

    // The reverse form: a real-path suite naming the mocked suite it serves.
    expect(citationsIn(' Real-path companion for: `backend/tests/routes/a-mocked.test.ts`'))
      .toEqual([{ kind: 'reverse', companionPath: 'backend/tests/routes/a-mocked.test.ts', token: '', surround: expect.any(String) }]);

    // A markup-emphasised label still parses as a CITATION, not just as a
    // label: the label count and the citation parsers share their pattern but
    // not what follows it, so the closing-tag spelling needs its own case at
    // the parser or it silently starts counting as an unstructured claim.
    expect(tokens(' Real-path <em>companion</em>: `backend/tests/a.test.ts` [ALPHA]')).toEqual(['ALPHA']);
    expect(tokens(' Real-path **companion**: `backend/tests/a.test.ts` [ALPHA]')).toEqual(['ALPHA']);
    expect(citationsIn(' Real-path <em>companion</em> for: `backend/tests/routes/a-mocked.test.ts`').map((c) => c.kind))
      .toEqual(['reverse']);

    // The label itself wrapping, which is nastier than a wrapped path because a
    // line-based label match misses the citation entirely rather than mangling it.
    expect(labelCount(block(' Real-path', ' companion coverage of the middleware'))).toBe(1);

    // Every spelling of the label a reader would take for the label.
    for (const spelt of [
      'Real-path companion: x', 'Real-path companions: x and y', 'Real-path SQL companion: x',
      'Realpath companion: x', 'the real-path-companion is x', 'Real-path argon2 companion: x',
      'Real-path (Postgres) companion: x', '@realPathCompanion x', 'Real-path <em>companion</em>: x',
      'Real-path **companion**: x', 'Real-path HAF-backed SQL companion: x', 'Real-path `argon2` companion: x',
      '**Real-path** companion: x', 'Real-path `companion`: x', 'Real-path companion(s): x',
      'Real-path "no-mock" companion: x', 'Real-path [Postgres] companion: x',
      // A qualifier whose first syllable is a stop word. The word boundary
      // falls inside `no-mock`, so a `\b`-anchored refusal read it as the stop
      // word `no` and the label vanished. `no-mock` is this corpus's commonest
      // qualifier, and a claim carrying it and no colon was neither a label
      // nor citation-shaped, so its block was dropped unaudited.
      'Real-path no-mock companion: x', 'Real-path not-mocked companion: x',
      'Real-path no-mock companion `backend/tests/routes/a.test.ts` pins it',
    ]) {
      expect(labelCount(spelt), spelt).toBe(1);
    }
    // Two adjacent labels are two, never one label with the first inside the
    // second's qualifier slot.
    expect(labelCount(block('a further real-path companion', 'Real-path companion: `backend/tests/a.test.ts` [A]'))).toBe(2);
    // And the prose that is not a claim: a stop word or a sentence break in
    // the qualifier slot, or three words between `path` and `companion`.
    for (const prose of [
      'real-path tests and their companion suites', 'the real path and companion fixtures',
      'runs on the real path. The companion suites above pin it', 'the real path with a companion test',
    ]) {
      expect(labelCount(prose), prose).toBe(0);
    }
    // A citation-shaped line that is not a label is reported, not skipped.
    expect(unparsedClaims(' (c) Real-path (also routes/custody-consent-ops.test.ts) companion: `backend/tests/a.test.ts` [A]'))
      .toHaveLength(1);
    expect(unparsedClaims(' (c) Real-path, no-mock companion: routes/a.test.ts covers it')).toHaveLength(1);
    expect(unparsedClaims(' (c) Real-path SQL companion: `backend/tests/a.test.ts` [A]')).toHaveLength(0);
    // The same claim WRAPPED, which is how the corpus spells anything longer
    // than a line, so the wrapped form is the one an author writes by default.
    // A window that cannot cross the wrap sees no claim at all and the block
    // is dropped before any class is assigned.
    expect(unparsedClaims(block(' (c) Real-path, no-mock', '     companion: routes/a.test.ts covers it'))).toHaveLength(1);
    expect(unparsedClaims(block(' (c) Real-path (also routes/custody-consent-ops.test.ts)', '     companion: `backend/tests/a.test.ts` [A]'))).toHaveLength(1);
    // A qualifier broken mid-word by the wrap.
    expect(unparsedClaims(block(' (c) Real-path, no-', '     mock companion: routes/a.test.ts covers it'))).toHaveLength(1);
    // A filename in the qualifier broken at its OWN dot. Rejoined, the wrap
    // spells `ops. test.ts`, which reads as a sentence break in the middle of
    // a name; the claim, and with it the whole block including any structured
    // citation beside it, went unaudited. A lower-case word after the stop is
    // what tells the two apart.
    expect(unparsedClaims(block(' (c) Real-path (also routes/custody-consent-ops.', '     test.ts) companion: `backend/tests/a.test.ts` [ALPHA]'))).toHaveLength(1);
    expect(unparsedClaims(block(' (c) Real-path (also routes/custody-consent-ops.test.ts)', '     companion: `backend/tests/a.test.ts` [ALPHA]'))).toHaveLength(1);
    // A wrapped LABEL is still a label, not an unparsed claim: both tests read
    // the same rejoined view, so widening one does not accuse the other.
    expect(unparsedClaims(block(' (c) Real-path SQL', '     companion: `backend/tests/a.test.ts` [A]'))).toHaveLength(0);
    // And prose whose sentence merely ENDS in the word `path` before an
    // unrelated one begins is not a claim, on one line or across a wrap. The
    // two are held off by different arms, which is why both are here: widening
    // the room after the noun alone starts accusing the second, while the
    // first needs the refusal AND that room removed together before it reads
    // as a claim.
    for (const prose of [
      'runs on the real path. The companion suites above pin it: see below',
      'exercised on the real path; the companion fixtures live here: see below',
    ]) {
      expect(unparsedClaims(prose), prose).toHaveLength(0);
      expect(unparsedClaims(prose.replace('. ', '.\n     ').replace('; ', ';\n     ')), prose).toHaveLength(0);
    }
    // The sentence-break refusal, in both directions. It ends the span after a
    // break on anything that is NOT an ASCII lower-case letter, so
    // `. The companion:` is two sentences and no claim; the lower-case
    // continuation is the one thing it crosses (a filename the wrap broke at
    // its own dot), so `. the companion:` is read as one claim. That single
    // exception works only because `looseClaimPattern` omits the `i` flag:
    // under `i` the `(?![a-z])` folds to accept capitals too and the
    // `. The companion:` assertion flips to 1.
    expect(unparsedClaims('runs on the real path. The companion: covered')).toHaveLength(0);
    expect(unparsedClaims('runs on the real path. the companion: covered')).toHaveLength(1);
    // The same distinction across a wrap, so it is not an artifact of one line.
    expect(unparsedClaims(block(' runs on the real path.', '     The companion: covered'))).toHaveLength(0);
    expect(unparsedClaims(block(' runs on the real path.', '     the companion: covered'))).toHaveLength(1);
    // Dropping the flag must cost no casing recall, which is what `anyCase`
    // buys: a class per LETTER rather than per word. With only the leading
    // letter classed, a near-miss carrying an interior capital matched neither
    // the label nor the loose claim, so its block yielded labels=0 and
    // unparsed=0 and went unaudited, while `labelPattern`, which does carry
    // `i`, read the honest spelling beside it. The shouted form is one member
    // of that set and the corpus writes it, so the whole set is pinned.
    for (const shout of [
      ' (c) REAL-PATH (also routes/foo.test.ts) COMPANION: covered',
      ' (c) REAL-PATH (also routes/foo.test.ts) COMPANIONS: covered',
      ' (c) REAL-PATH (also routes/foo.test.ts) COMPANION(S): covered',
      ' (c) REAL-path (also routes/foo.test.ts) companion: covered',
      ' (c) real-PATH (also routes/foo.test.ts) companions: covered',
    ]) {
      expect(unparsedClaims(shout), shout).toHaveLength(1);
      expect(labelCount(shout), shout).toBe(0);
    }
    expect(unparsedClaims(block(' (c) REAL-PATH (also routes/foo.test.ts)', '     COMPANION: covered'))).toHaveLength(1);
    // The bracketed plural is a second literal and needs classing in its own
    // right. It only shows once the room after it is spent: with `(S)` matched
    // by the plural group the eight characters of slack still reach the colon,
    // and with the group matching nothing they have to cover `(S)` as well and
    // fall three short. The lower-case twin is caught either way, which is
    // what makes this an assertion about the CASING rather than the group.
    expect(unparsedClaims(' (c) REAL-PATH (also routes/foo.test.ts) COMPANION(S)xxxxxxxx: covered')).toHaveLength(1);
    expect(unparsedClaims(' (c) Real-path (also routes/foo.test.ts) companion(s)xxxxxxxx: covered')).toHaveLength(1);
    // The bare plural `S` is the same kind of second literal and needs its own
    // class, and it shows the same way, once the room after it is spent: with
    // `[Ss]` matching the `S` the eight characters of slack still reach the
    // colon, and with a lower-case-only `s?` they have to cover the `S` as
    // well and fall one short. The lower-case twin is caught either way, which
    // again makes this an assertion about the CASING rather than the group.
    expect(unparsedClaims(' (c) REAL-PATH (also routes/foo.test.ts) COMPANIONSxxxxxxxx: covered')).toHaveLength(1);
    expect(unparsedClaims(' (c) Real-path (also routes/foo.test.ts) companionsxxxxxxxx: covered')).toHaveLength(1);
    // Casing does not defeat the refusal either, which is the one thing
    // omitting the flag buys: a capital after the stop still ends the phrase
    // whatever the casing of the words around it.
    expect(unparsedClaims('runs on the REAL PATH. The COMPANION: covered')).toHaveLength(0);
    expect(unparsedClaims('runs on the REAL PATH. the COMPANION: covered')).toHaveLength(1);
    // And the shouted label the corpus does write parses as the label, so the
    // wider loose guard must not turn those honest headers into claims against
    // themselves.
    expect(unparsedClaims(block(
      ' (c) REAL-PATH COMPANION: `custody-session-auth.test.ts` exercises the',
      '     same route against real argon2 and real Postgres.',
    ))).toHaveLength(0);
    // The refusal's BREADTH, pinned so that narrowing it is a visible probe
    // edit. It ends the span on any non-lower-case continuation and not only
    // on a capital, which is what keeps prose above a `(c)` clause marker out
    // of reach of the claim that follows it. Firing only before a capital
    // (`\s\p{Lu}` in place of the negative lookahead) flips this to 1, and
    // accuses a header in the corpus into the bargain.
    expect(unparsedClaims('preserved real-path because every spec issues a call. (c) Real-path SQL companion: x')).toHaveLength(0);
    // What the breadth costs, recorded rather than closed: a near-miss whose
    // own qualifier carries a phrase break, any of `.`, `;`, `!` or `?`
    // followed by a whitespace and a non-lower-case character, breaks there
    // and the claim is dropped unaudited. An abbreviation before a backtick or
    // a parenthesis is one member; a semicolon joining two backticked paths
    // needs no abbreviation at all and pins the gap at a non-abbreviation
    // member. The header lists this family among the gaps left open on
    // purpose; these three pin its current width, so widening it later cannot
    // happen silently.
    for (const abbrevNearMiss of [
      ' (c) Real-path (e.g. `backend/tests/routes/foo.test.ts`) companion: covered',
      ' (c) Real-path (i.e. (routes/foo.test.ts)) companion: covered',
      ' (c) Real-path (see `a.test.ts`; `b.test.ts`) companion: covered',
    ]) {
      expect(unparsedClaims(abbrevNearMiss), abbrevNearMiss).toHaveLength(0);
      expect(labelCount(abbrevNearMiss), abbrevNearMiss).toBe(0);
    }

    // The room between the noun and its colon is `{0,8}`: a near-miss claim (a
    // path in the qualifier slot stops it parsing as the label) whose colon
    // lands nine or more characters past `companion` matches neither the label
    // nor the loose claim, so its block yields labels=0 and unparsed=0 and is
    // dropped unaudited. Eight characters are caught, nine are not. The gap is
    // recorded in the header, not closed.
    const nearMissGap = (afterNoun: string): string =>
      ` (c) Real-path (also routes/foo.test.ts) companion${afterNoun}: covered`;
    expect(unparsedClaims(nearMissGap('x'.repeat(8))), '8-char gap').toHaveLength(1);
    expect(unparsedClaims(nearMissGap('x'.repeat(9))), '9-char gap').toHaveLength(0);
    // The precision cost in the other direction, recorded rather than closed:
    // prose about a real code path and an unrelated companion thing, with a
    // colon inside the room after the noun, IS accused, and the ALLOW_MARKER
    // is its way through. `LOOSE_CLAIM_SRC`'s docblock says so of the first
    // sentence here. A narrowing that spares it turns the count to 0, and must
    // then keep every `unparsedClaims` near-miss pin in this spec at its count,
    // the `droppedNearMiss` pins included.
    for (const accusedProse of [
      'running on the real path with a mocked companion here: the pool is stubbed',
      'This drives the real path with a mocked companion: getAppPool is stubbed.',
    ]) {
      const normalised = normalizeCommentText(accusedProse);
      expect(unparsedClaims(normalised), accusedProse).toHaveLength(1);
      expect(labelCount(normalised), accusedProse).toBe(0);
      expect(classOfText(normalised), accusedProse).toBe('unparsed');
      expect(classOfText(`${normalised} (${ALLOW_MARKER}: prose, not a claim)`), accusedProse).toBe('exempt');
    }
    // Why that cost stays open: each narrowing measured for sparing the
    // `accusedProse` sentences drops one of these near-miss claims to labels=0
    // and unparsed=0, so its block would go unaudited. The header's list of
    // gaps left open on purpose names which narrowing drops which spelling.
    for (const droppedNearMiss of [
      ' (c) Real-path (also routes/foo.test.ts) companion here: covered',
      ' (c) Real-path with a Postgres companion: covered',
      ' (c) Real-path with a Postgres companion: `backend/tests/a.test.ts` [A]',
      ' (c) Real-path (also routes/foo.test.ts) THE COMPANION: covered',
    ]) {
      expect(unparsedClaims(droppedNearMiss), droppedNearMiss).toHaveLength(1);
      expect(labelCount(droppedNearMiss), droppedNearMiss).toBe(0);
    }

    // `labelAt`'s `^`: a citation-shaped near-miss is still reported when a
    // later, UNSTRUCTURED label (no citation, so `proseRemainder` keeps it)
    // sits in the same rejoined span. Without the `^`, `labelAt` would find
    // that later label anywhere in the slice and wrongly read the near-miss as
    // parsed, so the near-miss would pass unseen.
    expect(unparsedClaims(block(
      ' (c) Real-path (also routes/foo.test.ts) companion: covered elsewhere',
      '     and the Real-path companion pins it for real',
    ))).toHaveLength(1);

    // Rejoining the block makes it one line, so a citation's own `companion:`
    // is within reach of any earlier mention of a real path. These are honest
    // headers a real author writes, and each was accused when the scan ran on
    // the whole block: the corpus's own clause-(a) wording above a correct
    // citation, and a correct citation whose PATH contains `real-path` sitting
    // above a second correct one. The message blamed the citation, which is
    // the one thing in the block that was right.
    expect(unparsedClaims(block(
      ' (a) `getVouchStatus` is covered by the carve-out catch-all ("any case',
      '     where exercising the real path per-test is impractical"), mocked at',
      '     the `wot.js` module boundary',
      ' (c) Real-path companion: `backend/tests/routes/a.test.ts` [ALPHA]',
    ))).toHaveLength(0);
    expect(unparsedClaims(block(
      ' (c) Real-path companion: `backend/tests/routes/papers-retract-real-path-verifyhivesignature.test.ts` [ALPHA]',
      '     Real-path companion: `backend/tests/routes/settings.test.ts` [BETA]',
    ))).toHaveLength(0);
    // But a claim tucked into a citation's own trailing parenthetical is a
    // claim of its own: it lives inside the citation's match, so cutting the
    // citation out without also scanning its surround would lose it.
    expect(unparsedClaims(' Real-path companion: `backend/tests/a.test.ts` [ALPHA] (Real-path, no-mock companion: the settings suites)'))
      .toHaveLength(1);

    // The prose surround keeps a second filename in the citation's trailer in
    // EVERY spelling: bare, backticked (this convention's house style for a
    // path, so the spelling an author reaches for first) and bracketed. A
    // global sweep for backticked or bracketed spans erased the last two.
    for (const trailer of [
      '(see also backend/tests/routes/custody-upgrade.test.ts)',
      '(see also `backend/tests/routes/custody-upgrade.test.ts`)',
      '(see also [backend/tests/routes/custody-upgrade.test.ts])',
    ]) {
      const cited = citationsIn(` Real-path companion: \x60backend/tests/a.test.ts\x60 [ALPHA] ${trailer}`);
      expect(cited.map((c) => c.token), trailer).toEqual(['ALPHA']);
      expect(cited[0].surround, trailer).toContain('custody-upgrade.test.ts');
      expect(cited[0].surround, trailer).not.toContain('backend/tests/a.test.ts');
    }
    // The reverse form's trailer too, whose path is removed the same way.
    expect(citationsIn(' Real-path companion for: `backend/tests/routes/a-mocked.test.ts` (and `backend/tests/routes/b.test.ts`)')[0].surround)
      .toContain('b.test.ts');
    // A token that IS its own trailer's text is removed once, at its own
    // position, so the citation does not eat the prose beside it.
    expect(citationsIn(' Real-path companion: `backend/tests/a.test.ts` [ALPHA] (ALPHA again)')[0].surround)
      .toContain('ALPHA again');

    // A token carrying brackets or a slash survives: the closing bracket is
    // anchored at end-of-line, so a non-greedy match backtracks to the last one.
    expect(tokens(' Real-path companion: `backend/tests/a.test.ts` [rows[0].author_index]')).toEqual(['rows[0].author_index']);
    expect(tokens(' Real-path companion: `backend/tests/a.test.ts` [/api/settings/set-password]')).toEqual(['/api/settings/set-password']);

    // Parser NEGATIVES — free prose extracts nothing, so it falls to the ratchet
    // rather than being silently accepted as a checked citation.
    expect(citationsIn(' (c) Real-path companion: routes/notifications.test.ts exercises the same SQL')).toEqual([]);
    expect(citationsIn(' (c) Real-path companion: the settings suites cover it')).toEqual([]);

    // Spellings the citation parser declines, each of which FAILS CLOSED: the
    // label goes unsatisfied, so the block falls to the ratchet as a claim
    // rather than passing as a checked citation. A trailer that wraps, one
    // holding a nested parenthesis, a trailing comma joining two claims, and
    // emphasis closing the line. The direction is what matters here, so it is
    // pinned rather than left to be rediscovered as a hole.
    for (const declined of [
      block(' Real-path companion: `backend/tests/a.test.ts` [ALPHA] (see also', '     backend/tests/routes/settings.test.ts)'),
      ' Real-path companion: `backend/tests/a.test.ts` [ALPHA] (see also (settings.test.ts))',
      ' Real-path companion: `backend/tests/a.test.ts` [ALPHA], and settings.test.ts too',
      ' *Real-path companion: `backend/tests/a.test.ts` [ALPHA]*',
    ]) {
      expect(citationsIn(declined), declined).toEqual([]);
      expect(classOfText(declined), declined).not.toBe('structured');
    }

    // What counts as naming a test file in prose: the full name, the
    // suffix-less name, a spec, a frontend `.test.js`, a name wrapped inside
    // its last segment, a bare `tests/<dir>/<name>` path, and such a path at
    // a line start after a wrap; not a suite, a word ending in `test`, a
    // fixture or support module, a mail address, a URL, the reserved
    // `example.test` domain, a `RE.test(...)` call, or a bare directory.
    for (const prose of [
      'pinned by settings.test.ts', 'pinned by settings.test', 'pinned by settings.spec.ts',
      'pinned by frontend/tests/unit/x.test.js', 'pinned by routes/settings.\n        test.ts',
      // Both rejoined views are load-bearing and neither subsumes the other.
      // The glued view repairs a name the wrap broke inside its last segment
      // (`routes/settings.` + `test.ts`); the spaced view keeps the word
      // boundary after a name the wrap followed with more prose, which gluing
      // would run together into `.tsand`.
      'pinned by settings.test.ts\n        and by its sibling suite',
      'pinned by `backend/tests/routes/settings-real-pool-admit`',
      // A `tests/<dir>/<name>` path the docblock wrapped at its own directory
      // slash. The spaced view puts the wrap's space back in the middle of the
      // path, so this arm needs the glued view exactly as the extension arm
      // does.
      'pinned for real by tests/routes/\n        settings-real-pool-admit against real Postgres',
      // A link whose PATH ends in a test file names that file. Blanking the
      // whole URL token let the half-true compound be written as a link.
      'pinned by https://github.com/pevo/pevo/blob/main/backend/tests/routes/settings.test.ts',
      'the consent-op branch of the\n        tests/routes/custody-consent-ops suite stamps it',
    ]) {
      expect(namesATestFile(prose), prose).toBe(true);
    }
    for (const prose of [
      'the settings suite', 'a contest.ts helper', 'foo.tests', 'testing.ts',
      'the `MOCK_VERIFY_SIGNATURE` fixture at `backend/tests/fixtures/mock-auth.ts`',
      'the helper in `backend/tests/support/haf-query.ts`', 'seeded as alice@example.test',
      'hosted at https://gw.example.test/x', 'the reserved `example.test` domain',
      // A `.test` TLD outside the reserved domain, so the mail and URL arms
      // are each the only thing standing between it and a false accusation.
      'seeded as reviewer@u-porto.test', 'hosted at https://gw.pevo.test/x',
      'the gate is `NUMERIC_IAT_RE.test(String(payload.iat))`', 'run `npx vitest run tests/routes`',
      'the E2E-only secret lives in `frontend/.env.test`, never in the deployment `.env`',
      'the template is `frontend/.env.test.example`',
      'hosted at https://gw.pevo.test/ipfs/QmX',
      'e.g.\ntest-only fixtures', 'the first.\ntest.each table',
    ]) {
      expect(namesATestFile(prose), prose).toBe(false);
    }

    // Validator: comment occurrences, mock bodies, spec titles and longer
    // identifiers do not count; code does. Each is a real rot class or a real
    // false-positive class, not a hypothetical.
    expect(codeOf('/** asserts SESSION_INVALIDATED */\nconst a = 1;')).not.toMatch(tokenMatcher('SESSION_INVALIDATED'));
    expect(codeOf('// not SESSION_INVALIDATED here\nconst a = 1;')).not.toMatch(tokenMatcher('SESSION_INVALIDATED'));
    expect(codeOf("vi.mock('../../src/middleware/verifyHiveSignature.js', () => ({\n  verifyHiveSignature: (req, res) => res.status(401),\n}));\nconst a = 1;"))
      .not.toMatch(tokenMatcher('verifyHiveSignature'));
    expect(codeOf("vi.doMock('../../src/x.js', () => ({ decryptKey: () => 'k' }));")).not.toMatch(tokenMatcher('decryptKey'));
    expect(codeOf("vi.spyOn(redis, 'get').mockRejectedValue(Object.assign(new Error('x'), { code: 'SESSION_INVALIDATED' }));"))
      .not.toMatch(tokenMatcher('SESSION_INVALIDATED'));
    expect(codeOf("queryMock.mockResolvedValue({\n  rows: [{ sessions_invalidated_at: 1 }],\n});")).not.toMatch(tokenMatcher('sessions_invalidated_at'));
    expect(codeOf("vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));")).not.toMatch(tokenMatcher('Uint8Array'));
    // Every member of MOCK_CALL_RE strips its call, so a token occurring only
    // inside a mocking call does not count as an assertion. One representative
    // call per member, so removing any single member from the pattern turns
    // its probe red. `mock`, `doMock`, `spyOn`, `stubGlobal`, `fn`,
    // `mockResolvedValue` and `mockRejectedValue` are pinned by the shaped
    // cases above; these are the remaining members and the `Once` suffix.
    for (const call of [
      "vi.unmock('../ALPHA.js');",
      "vi.doUnmock('../ALPHA.js');",
      'const h = vi.hoisted(() => ({ ALPHA: 1 }));',
      "vi.stubEnv('ALPHA', '1');",
      'const m = vi.mocked(ALPHA);',
      "const im = vi.importMock('../ALPHA.js');",
      'stub.mockReturnValue(ALPHA);',
      'stub.mockImplementation(() => ALPHA);',
      'ALPHA.mockReturnThis();',
      "stub.mockName('ALPHA');",
      'stub.mockReturnValueOnce(ALPHA);',
    ]) {
      expect(codeOf(call), call).not.toMatch(tokenMatcher('ALPHA'));
    }
    expect(codeOf("describe('requireFreshAdminAuth - JWT path', () => {\n  it('rejects recordAccreditationCompletion', () => {});\n});"))
      .not.toMatch(tokenMatcher('requireFreshAdminAuth'));
    // A spec title built as a template, which is how a table-driven suite
    // names its cases, is a title like any other. All three members of
    // SPEC_CALL_RE (`describe`, `it`, `test`) title-strip, so `test` gets its
    // own case rather than riding on the `describe`/`it` ones above.
    expect(codeOf('it(`rejects ${name} for requireFreshAdminAuth`, () => {});')).not.toMatch(tokenMatcher('requireFreshAdminAuth'));
    expect(codeOf("test('asserts requireFreshAdminAuth in the JWT path', () => {});")).not.toMatch(tokenMatcher('requireFreshAdminAuth'));
    expect(codeOf("it('x', () => { expect(hafQueryMock).toHaveBeenCalled(); });")).not.toMatch(tokenMatcher('hafQuery'));
    // The same boundary at the other end: a token that is only the TAIL of a
    // longer identifier is not spelt by it either, so citing `AuthMethod` is
    // not discharged by a companion that spells `hiveAuthMethod`.
    expect(codeOf('expect(res.body.method).toBe(hiveAuthMethod);')).not.toMatch(tokenMatcher('AuthMethod'));
    expect(codeOf('expect(res.body.method).toBe(hiveAuthMethod);')).toMatch(tokenMatcher('hiveAuthMethod'));
    expect(codeOf("expect(res.body.error.code).toBe('SESSION_INVALIDATED');")).toMatch(tokenMatcher('SESSION_INVALIDATED'));
    expect(codeOf("const row = await realQuery('SELECT sessions_invalidated_at FROM accounts');")).toMatch(tokenMatcher('sessions_invalidated_at'));

    // Code that a line-prefix stripper mangled and the parser does not: a
    // sentinel whose value is a SQL block comment, a predicate testing for the
    // opener, a `*`-led SQL continuation line, a generator method, a `/*` at
    // line start inside a template literal, and a BOM before a real comment.
    expect(codeOf("const SENTINEL = '/* search.reviews.branch */';\nexpect(sql).toContain(SENTINEL);")).toMatch(tokenMatcher('search.reviews.branch'));
    expect(codeOf("if (trimmed.startsWith('/*')) return true;\nconst ALPHA = 1; /* closer */")).toMatch(tokenMatcher('ALPHA'));
    expect(codeOf('const SQL = `\n  SELECT $1::numeric\n    * weight_factor AS weighted\n`;')).toMatch(tokenMatcher('weight_factor'));
    expect(codeOf("const scan = {\n  *[Symbol.iterator]() { yield { code: 'SESSION_INVALIDATED' }; },\n};")).toMatch(tokenMatcher('SESSION_INVALIDATED'));
    expect(codeOf('const fixture = `\n/* an opener with no closer\nconst x = 1;\n`;\nexpect(a).toBe(ALPHA);\n/* real */\nconst q = 1;')).toMatch(tokenMatcher('ALPHA'));
    expect(codeOf('\uFEFF/* pins SESSION_INVALIDATED end to end */\nconst a = 1;')).not.toMatch(tokenMatcher('SESSION_INVALIDATED'));
    expect(codeOf('  /* ALPHA is not asserted */\nconst x = 1;')).not.toMatch(tokenMatcher('ALPHA'));
    expect(codeOf('/**\n * ALPHA\n */\nconst x = 1;')).not.toMatch(tokenMatcher('ALPHA'));
    expect(codeOf("const redis = get(); /* clause (c) mirror:\n   pins the live 401 SESSION_INVALIDATED path.\n*/\nconst b = 2;")).not.toMatch(tokenMatcher('SESSION_INVALIDATED'));

    // Validator arms, each exercised through the real entry point.
    const synthetic: ScannedSource[] = [{ rel: 'synthetic.ts', lines: ['const ALPHA = 1;'] }];
    const stub = (body: string) => (): string | null => body;
    const citing = 'backend/tests/routes/synthetic.test.ts';
    const forward = (companionPath: string, token: string): Citation => ({ kind: 'forward', companionPath, token, surround: '' });

    // Nonexistent companion.
    expect(citationViolations(citing, forward('backend/tests/routes/absent.test.ts', 'ALPHA'), synthetic, () => null))
      .toEqual([expect.stringContaining('does not exist')]);
    // Exists, token absent.
    expect(citationViolations(citing, forward('backend/tests/routes/present.test.ts', 'ALPHA'), synthetic, stub('const unrelated = 1;')))
      .toEqual([expect.stringContaining('does not occur there at all')]);
    // Exists, token present only in prose — the "verified to exist" verdict
    // that this canary exists to stop being mistaken for coverage.
    expect(citationViolations(citing, forward('backend/tests/routes/present.test.ts', 'ALPHA'), synthetic,
      stub('// ALPHA is deliberately not asserted here\nconst x = 1;')))
      .toEqual([expect.stringContaining('in comments, in a mocking call, in a spec title, or inside a longer identifier')]);
    // Exists, token present only as a mock stub: the historical incident.
    expect(citationViolations(citing, forward('backend/tests/routes/present.test.ts', 'ALPHA'), synthetic,
      stub("vi.mock('../../src/a.js', () => ({\n  ALPHA: () => 1,\n}));\nconst x = 1;")))
      .toEqual([expect.stringContaining('in a mocking call')]);
    // Correct citation passes.
    expect(citationViolations(citing, forward('backend/tests/routes/present.test.ts', 'ALPHA'), synthetic, stub('expect(code).toBe(ALPHA);')))
      .toEqual([]);
    // Self-citation.
    expect(citationViolations(citing, forward(citing, 'ALPHA'), synthetic, stub('ALPHA;')))
      .toEqual([expect.stringContaining('cites itself')]);
    // A source-scanning canary or a support module is no companion. Both
    // alternatives of NON_RUNTIME_DIR_RE are probed in the FORWARD direction:
    // the eslint one, and the support one, so removing either half of the
    // alternation turns a probe red rather than passing unseen.
    expect(citationViolations(citing, forward('backend/tests/eslint/no-foo.test.ts', 'ALPHA'), synthetic, stub('ALPHA;')))
      .toEqual([expect.stringContaining('witnesses nothing')]);
    expect(citationViolations(citing, forward('backend/tests/support/helper.test.ts', 'ALPHA'), synthetic, stub('ALPHA;')))
      .toEqual([expect.stringContaining('witnesses nothing')]);
    // Path shape: tests-relative and `./`-prefixed forms are rejected before the
    // filesystem is touched, so the message names the required form.
    for (const bad of [
      'routes/notifications.test.ts', './backend/tests/routes/a.test.ts', 'backend/src/db.ts',
      // A file under the test tree that is not a `.test.ts` file: the shape
      // pattern's `\.test\.ts` tail is the only arm rejecting it (the prefix
      // and canonicalisation arms both pass), so without this entry that tail
      // can be neutered unseen.
      'backend/tests/routes/helper.ts',
      // Interior segments satisfy the shape pattern textually (`.` and `/` are
      // both word-ish there) while resolving somewhere else. Each of these is
      // the CITING file spelt so the self-citation arm cannot see it, and the
      // last leaves the scanned tree altogether, where nothing is walked,
      // nothing is ratcheted and the reach cap can never fire.
      'backend/tests/routes//synthetic.test.ts',
      'backend/tests/routes/./synthetic.test.ts',
      'backend/tests/routes/../routes/synthetic.test.ts',
      'backend/tests/../witness.test.ts',
    ]) {
      expect(citationViolations(citing, forward(bad, 'ALPHA'), synthetic, stub('ALPHA;')), bad)
        .toEqual([expect.stringContaining('not repo-relative')]);
    }
    // No citation may name this canary: it is dropped from its own scan, so the
    // worked examples in its header would otherwise answer a reverse
    // declaration naming it, with no risk-class token anywhere in the link.
    expect(citationViolations(citing, forward(SELF_REPO_PATH, 'ALPHA'), synthetic, stub('ALPHA;')))
      .toEqual([expect.stringContaining('is this canary, which is excluded from its own scan')]);
    // The token-shape arm, which rejects what a second citation fused onto the
    // line leaves in the bracket, and a token too long to be one. Both halves,
    // since either alone leaves the other unpinned.
    for (const shapeless of [
      'A] Real-path companion: `backend/tests/b.test.ts` [B',
      'SESSION INVALIDATED',
      'x'.repeat(81),
    ]) {
      expect(citationViolations(citing, forward('backend/tests/routes/present.test.ts', shapeless), synthetic, stub('ALPHA;')), shapeless)
        .toEqual([expect.stringContaining('must be a single whitespace-free code token')]);
    }

    // The reverse form: the named suite must CITE this file back, resolved by
    // path. A file that merely mentions this file's name does not answer the
    // declaration — that is the filename-presence blindness one level up, and
    // hundreds of such cross-mentions exist under backend/tests.
    const reverse = (companionPath: string): Citation => ({ kind: 'reverse', companionPath, token: '', surround: '' });
    const backCite = '/**\n * Real-path companion: `backend/tests/routes/synthetic.test.ts` [ALPHA]\n */\nconst x = 1;';
    expect(citationViolations(citing, reverse('backend/tests/routes/mocked.test.ts'), synthetic, stub(backCite)))
      .toEqual([]);
    expect(citationViolations(citing, reverse('backend/tests/routes/mocked.test.ts'), synthetic,
      stub('// see synthetic.test.ts for the live path\nconst x = 1;')))
      .toEqual([expect.stringContaining('carries no companion citation naming backend/tests/routes/synthetic.test.ts')]);
    expect(citationViolations(citing, reverse('backend/tests/routes/mocked.test.ts'), synthetic, stub('const x = 1;')))
      .toEqual([expect.stringContaining('carries no companion citation naming')]);
    // A citation back to a DIFFERENT file is not an answer either.
    expect(citationViolations(citing, reverse('backend/tests/routes/mocked.test.ts'), synthetic,
      stub('/**\n * Real-path companion: `backend/tests/routes/other.test.ts` [ALPHA]\n */\nconst x = 1;')))
      .toEqual([expect.stringContaining('carries no companion citation naming')]);
    // The back-link is resolved by CANONICAL path on both sides, so a back
    // citation written with a `/./` segment still answers this declaration.
    // Reverting the filter to string equality (dropping the
    // `path.posix.normalize` canonicalisation) would miss it and falsely
    // accuse an honest link.
    expect(citationViolations(citing, reverse('backend/tests/routes/mocked.test.ts'), synthetic,
      stub('/**\n * Real-path companion: `backend/tests/routes/./synthetic.test.ts` [ALPHA]\n */\nconst x = 1;')))
      .toEqual([]);
    // The named file's citations are read as COMMENTS, by the same collector
    // that reads this one's, rather than off its raw text. The corpus wraps a
    // path across a docblock's continuation, and raw text carries the ` * `
    // gutter into the middle of the path, so the answering citation would
    // resolve to a file that does not exist and an honest declaration would be
    // accused of pointing nowhere.
    expect(citationViolations(citing, reverse('backend/tests/routes/mocked.test.ts'), synthetic,
      stub('/**\n * Real-path companion: \x60backend/tests/routes/\n *   synthetic.test.ts\x60 [ALPHA]\n */\nconst x = 1;')))
      .toEqual([]);
    // And a citation-shaped line held in a string fixture is data, not a
    // declaration: a canary carrying synthetic source text answers for nobody.
    expect(citationViolations(citing, reverse('backend/tests/routes/mocked.test.ts'), synthetic,
      stub("const FIXTURE = '/** Real-path companion: \x60backend/tests/routes/synthetic.test.ts\x60 [ALPHA] */';\nconst x = 1;")))
      .toEqual([expect.stringContaining('carries no companion citation naming')]);
    // Two reverse declarations pointing at each other name no risk class at
    // either end, so the pair witnesses nothing however visible the link is.
    expect(citationViolations(citing, reverse('backend/tests/routes/mocked.test.ts'), synthetic,
      stub('/**\n * Real-path companion for: `backend/tests/routes/synthetic.test.ts`\n */\nconst x = 1;')))
      .toEqual([expect.stringContaining('answers this declaration with the reverse form as well')]);
    expect(citationViolations(citing, reverse('backend/tests/routes/mocked.test.ts'), synthetic, () => null))
      .toEqual([expect.stringContaining('does not exist')]);
    expect(citationViolations(citing, reverse(citing), synthetic, stub(backCite)))
      .toEqual([expect.stringContaining('cites itself')]);
    // The reverse form is how this canary's own worked examples would be
    // reached: it is excluded from the scan, so nothing it contains is a
    // citation, and naming it discharges nothing.
    expect(citationViolations(citing, reverse(SELF_REPO_PATH), synthetic, stub(backCite)))
      .toEqual([expect.stringContaining('is this canary, which is excluded from its own scan')]);
    // The forward-only guard on the source-scanning-directory arm. In the
    // reverse form the named path is the MOCKED suite being served, not the
    // witness, so a declaration naming one there is legitimate and must not
    // draw the "witnesses nothing" verdict the forward form draws.
    expect(citationViolations(citing, reverse('backend/tests/eslint/no-foo.test.ts'), synthetic, stub(backCite)))
      .toEqual([]);
    expect(citationViolations(citing, reverse('backend/tests/support/helper.test.ts'), synthetic, stub(backCite)))
      .toEqual([]);

    // Over-generic token, through the real entry point and against the real
    // tree, so the cap stays calibrated to the corpus it guards. The companion
    // asserts the token, so the reach arm is the only one that can fire. A
    // punctuation suffix on the token (`verifyHiveSignature:`) no longer dodges
    // the cap by selecting the lines that MOCK the surface, because mock bodies
    // are not code here: it fails the token arm instead (probed above).
    expect(citationViolations(citing, forward('backend/tests/routes/present.test.ts', 'createApp'), sources,
      stub('const app = createApp();')))
      .toEqual([expect.stringMatching(/is spelt in code by \d+ files under backend\/tests/)]);
    expect(tokenReach('createApp', sources)).toBeGreaterThan(TOKEN_FILE_CAP);
    expect(tokenReach('SESSION_INVALIDATED', sources)).toBeLessThanOrEqual(TOKEN_FILE_CAP);
    expect(tokenReach('SESSION_INVALIDATED', sources)).toBeGreaterThan(0);
  });

  it('the label and both citation parsers stay flat on a separator run', () => {
    // A section underline or separator written directly against `real-path` is
    // the adversarial input: the label partitions that run between its own
    // quantifiers and explores every partition before it fails for want of
    // `companion`. Bounding only the dash-or-space runs left the match
    // quadratic in a DASH run (6400 dashes: about 9s through `labelCount`,
    // about 19s through `citationsIn`), and leaving a qualifier's wrappers or
    // the emphasis run before it unbounded moved the same cost onto
    // UNDERSCORES, ASTERISKS and BACKTICKS, where it is worse, since an
    // underscore is both a word character and an emphasis character. Each
    // shape is a `[prefix, run]` pair, because no suffix-only shape puts a
    // LONG homogeneous separator run behind an emphasis character: the mixed
    // run's own leading `_` does reach the `[\s-]{0,4}` INSIDE the emphasis
    // group, but hands it at most one dash before the next emphasis
    // character, so nothing in that slot grows with the run. The two prefixed
    // shapes, `real-path_` and `real-path*`, each before a DASH run, are the
    // ones that put a whole run in that slot, and they are what pin that
    // bound. The run has to be dashes: a dash is in that bound's class and in
    // QUALIFIER's `[\w-]` word class, so the run splits between the two. A
    // space is outside the word class, so a space run behind an emphasis
    // character cannot split that way. With the bound removed both runs cost
    // time linear in their length; what separates them is the work per
    // character. Each dash is a point where the run can stop and hand the
    // dashes after it to the two qualifier slots to re-split, while each
    // space is a point where the qualifier fails at once, so the space run
    // stays far under the threshold and pins nothing.
    //
    // THREE LENGTHS, SHORT FIRST, and each exists for a regression class the
    // others miss. These failures differ in cost by orders of magnitude, and
    // a canary that hangs gets disabled as surely as a slow one. The SHORTEST
    // pass exists for the class that stops returning at the middle length:
    // reverting QUALIFIER's trailing separator `[\s-]{1,4}` to `[\s-]+` gives
    // no verdict at 6400 in 90s, and vitest's testTimeout cannot pre-empt a
    // synchronous regex, so without this pass the whole file hangs instead of
    // failing; at 400 the same revert fails in two to three seconds while the
    // committed pattern stays in single-digit milliseconds on every shape. The
    // MIDDLE pass catches quadratic growth the shortest cannot see: the
    // qualifier word-class revert is green at 400 and fails at 6400 in about
    // ten seconds. The
    // LONG pass catches the cheap shapes, where an unbounded emphasis run
    // costs about 53ms at 6400 (green under any bound this side of flaky) and
    // about 4.4s at 100,000. Bounded, every shape stays in single-digit
    // milliseconds at every length on this host, so the threshold sits well
    // over an order of magnitude clear of green.
    // `citationsIn` is timed as well as `labelCount` because `forwardPattern`
    // and `reversePattern` embed the same `LABEL_SRC` and run first on every
    // block.
    for (const runLength of [400, 6_400, 100_000]) {
      for (const [prefix, sep] of [
        ['', '-'], ['', '_'], ['', '*'], ['', '`'], ['', 'a-'], ['', 'a_'], ['', '_-*`'],
        ['_', '-'], ['*', '-'],
      ] as const) {
        const adversarial = `real-path${prefix}${sep.repeat(Math.ceil(runLength / sep.length))}x`;
        for (const [name, run] of [
          ['labelCount', (): void => expect(labelCount(adversarial)).toBe(0)],
          ['citationsIn', (): void => expect(citationsIn(adversarial)).toHaveLength(0)],
        ] as const) {
          const start = performance.now();
          run();
          const elapsed = performance.now() - start;
          expect(elapsed, `${name} took ${elapsed.toFixed(1)}ms on a ${runLength}-character run of ${JSON.stringify(sep)}${prefix ? ` prefixed ${JSON.stringify(prefix)}` : ''}`)
            .toBeLessThan(250);
        }
      }
    }
  });

  it('the ratchet classifies planted blocks correctly and the backlog reconciler names every disagreement', () => {
    const block = (...lines: string[]): string => lines.join('\n');
    const classOf = (text: string): RatchetClass => ratchetClass(blockShape(text));

    // Structured: one citation per label, nothing else named.
    expect(classOf(block(
      ' (c) Real-path companion: `backend/tests/a.test.ts` [ALPHA]',
      '     Real-path companion: `backend/tests/b.test.ts` [BETA]',
    ))).toBe('structured');
    // A back-reference to the citation as a noun is a second label, so it is
    // written as prose that does not spell the label ("the companion above").
    expect(classOf(block(
      ' (c) Real-path companion: `backend/tests/a.test.ts` [ALPHA]',
      '     The companion above drives the revocation branch for real.',
    ))).toBe('structured');

    // Leaky: every label structured, but a filename survives in the prose
    // beside them, or inside a citation's own qualifier slot or trailer.
    expect(classOf(block(
      ' (c) Real-path companion: `backend/tests/a.test.ts` [ALPHA]',
      '     The happy path is also pinned by settings.test.ts and recover.test.ts.',
    ))).toBe('leaky');
    expect(classOf(block(
      ' (c) Real-path companion: `backend/tests/a.test.ts` [ALPHA]',
      '     The admitted branch is pinned by `backend/tests/routes/settings-real-pool-admit`.',
    ))).toBe('leaky');
    expect(classOf(block(
      ' (c) Real-path companion: `backend/tests/a.test.ts` [ALPHA]',
      '     The admit path is pinned for real by routes/settings.',
      '     test.ts against real Postgres.',
    ))).toBe('leaky');
    // The trailer, in every spelling a reader would write a path in: bare,
    // backticked (the house style, so the one an author reaches for) and
    // bracketed. A sweep for backticked or bracketed spans erased the
    // backticked and bracketed spellings, re-admitting the half-true compound
    // in its most natural form while catching the unusual one.
    expect(classOf(' (c) Real-path companion: `backend/tests/a.test.ts` [ALPHA] (see settings.test.ts)')).toBe('leaky');
    expect(classOf(' (c) Real-path companion: `backend/tests/a.test.ts` [ALPHA] (see `settings.test.ts`)')).toBe('leaky');
    expect(classOf(' (c) Real-path companion: `backend/tests/a.test.ts` [ALPHA] (see [settings.test.ts])')).toBe('leaky');
    expect(classOf(' Real-path companion for: `backend/tests/routes/a-mocked.test.ts` (also `settings.test.ts`)')).toBe('leaky');
    expect(classOf(block(
      ' (c) Real-path companion: `backend/tests/a.test.ts` [ALPHA]',
      '     The custody-*.test.ts family pins the same 401 at the route layer.',
    ))).toBe('leaky');
    // But the fixture path CLAUDE.md asks a MOCK_VERIFY_SIGNATURE user to name
    // is not a test file, so an honest header stays structured.
    expect(classOf(block(
      ' (a) Cryptographic verification is bypassed via the project-wide',
      '     `MOCK_VERIFY_SIGNATURE` fixture at `backend/tests/fixtures/mock-auth.ts`.',
      ' (c) Real-path companion: `backend/tests/a.test.ts` [ALPHA]',
    ))).toBe('structured');

    // A citation-shaped line that does not parse is its own class, whether it
    // sits on one line or across a wrap. Wrapped, it used to yield labels=0 and
    // unparsed=0 and be dropped before any class was assigned, which let a
    // brand-new free-prose claim land in a file in neither backlog.
    expect(classOf(' (c) Real-path (also routes/custody-consent-ops.test.ts) companion: `backend/tests/a.test.ts` [ALPHA]'))
      .toBe('unparsed');
    expect(classOf(block(' (c) Real-path, no-mock', '     companion: routes/a.test.ts covers it'))).toBe('unparsed');
    expect(classOf(block(' (c) Real-path (also routes/custody-consent-ops.test.ts)', '     companion: `backend/tests/a.test.ts` [ALPHA]'))).toBe('unparsed');
    // And the audit KEEPS it, rather than skipping the block for having no
    // label and no unparsed claim.
    expect(auditSources([{ rel: 'routes/wrapped.test.ts', lines: [
      '/**', ' * (c) Real-path, no-mock', ' *     companion: routes/a.test.ts covers it', ' */', 'const a = 1;',
    ] }]).audits.map((a) => a.cls)).toEqual(['unparsed']);

    // Partial conversion: two claims, one structured, is free-prose, which is
    // what stops a partial conversion from reading as a complete one.
    expect(classOf(block(
      ' (c) Real-path companion: `backend/tests/a.test.ts` [ALPHA]',
      '     Real-path companion: b.test.ts covers the rest',
    ))).toBe('free-prose');
    // A structured citation beside a file-less label routes on the PROSE, not
    // on the citation's own path, so it lands in the file-less backlog and its
    // message offers the marker or the reverse form.
    expect(classOf(block(
      ' (c) Real-path companion: `backend/tests/a.test.ts` [ALPHA]',
      '     Real-path companion: the lifecycle suites cover the rest',
    ))).toBe('fileless');
    // The reverse form satisfies its label.
    expect(classOf(' Real-path companion for: `backend/tests/routes/a-mocked.test.ts`')).toBe('structured');

    // Free prose naming a file, and a claim naming no file at all. The second
    // is verbatim the shape a removed violation had, and it is rejected rather
    // than passed through as unresolvable.
    expect(classOf(' (c) Real-path companion: routes/notifications.test.ts exercises the same SQL')).toBe('free-prose');
    expect(classOf(' (c) Real-path companion: the settings password-reset suites cover the live happy path')).toBe('fileless');

    // The exempt gate, in both directions and for every failure. A mismatch
    // with the marker is skipped; the same mismatch without it is not; a leaky
    // or unparsed block with the marker is skipped too.
    const prose = ' (c) Real-path companion: the settings suites cover it';
    expect(classOf(`${prose} (${ALLOW_MARKER}: no single file is the referent)`)).toBe('exempt');
    expect(classOf(prose)).toBe('fileless');
    // The marker is long enough that a docblock wraps it, and it breaks at one
    // of its own hyphens. Failing to read it there is a red bar on a block
    // whose author did exactly what the message asked.
    expect(classOf(block(`${prose} (carve-out-citation-`, `     allow: no single file is the referent)`))).toBe('exempt');
    const shape = (o: Partial<BlockShape>): BlockShape =>
      ({ labels: 1, citations: 0, unparsed: 0, remainderNamesAFile: true, exempt: false, ...o });
    expect(ratchetClass(shape({ exempt: true }))).toBe('exempt');
    expect(ratchetClass(shape({}))).toBe('free-prose');
    expect(ratchetClass(shape({ citations: 1, exempt: true }))).toBe('exempt');
    expect(ratchetClass(shape({ citations: 1 }))).toBe('leaky');
    expect(ratchetClass(shape({ unparsed: 1, exempt: true }))).toBe('exempt');
    expect(ratchetClass(shape({ unparsed: 1 }))).toBe('unparsed');

    // The scan loop itself, on a synthetic source, so the loop and every
    // consumer of a class (the deficit sums, the class lists, validation, the
    // mixed-script words) are proven live rather than only the predicate.
    // Deficits count LABELS, so the two-label block below weighs two.
    const syn: ScannedSource[] = [{
      rel: 'routes/syn.test.ts',
      lines: [
        '/**',
        ' * (c) Real-path companion: `backend/tests/routes/absent.test.ts` [ALPHA]',
        ` * ${ALLOW_MARKER}: kept for the validation probe below`,
        ' */',
        'const a = 1;',
        '// Real-path companion: b.test.ts covers it',
        '// Real-path companion: c.test.ts covers it too',
        'const b = 2;',
        '/* Real-path companion: `backend/tests/routes/present.test.ts` [ALPHA]',
        '   and also y.test.ts */',
        'const c = 3;',
        '// Real-path companion: the lifecycle suites cover the rest',
        'const d = 4;',
        '// Real-path (see x.test.ts) companion: `backend/tests/routes/present.test.ts` [ALPHA]',
        'const e = 5;',
        '// a Re\u0430l-path note with a look-alike letter, no label',
      ],
    }];
    const { audits: audited, mixed } = auditSources(syn);
    expect(audited.map((a) => a.cls)).toEqual(['exempt', 'free-prose', 'leaky', 'fileless', 'unparsed']);
    expect(audited.map((a) => a.block.firstLine)).toEqual([1, 6, 9, 12, 14]);
    expect(deficitByFile('free-prose', audited)).toEqual(new Map([['backend/tests/routes/syn.test.ts', 2]]));
    expect(deficitByFile('fileless', audited)).toEqual(new Map([['backend/tests/routes/syn.test.ts', 1]]));
    expect(mixed).toHaveLength(1);
    expect(mixed[0]).toMatch(/^backend\/tests\/routes\/syn\.test\.ts \(comment block opening at line \d+\) — "Re\u0430l"$/);
    // Validation ignores the class: the exempt block's citation to a missing
    // file is still a violation, and the leaky block's correct one is not.
    // (The unparsed block parses no citation at all, so it has nothing to
    // validate; its violation is its class.)
    const validated = validationViolations(audited, syn, (p) => (p.endsWith('present.test.ts') ? 'expect(ALPHA);' : null));
    expect(validated).toHaveLength(1);
    expect(validated[0]).toMatch(/^backend\/tests\/routes\/syn\.test\.ts \(comment block opening at line \d+\) — /);
    expect(validated[0]).toMatch(/companion backend\/tests\/routes\/absent\.test\.ts does not exist$/);

    // Reconciler arms. Two files in the frozen snapshot; every disagreement
    // between the tree, the live map, and the snapshot has its own message.
    const A = 'backend/tests/routes/a.test.ts';
    const B = 'backend/tests/routes/b.test.ts';
    const C = 'backend/tests/routes/c.test.ts';
    const frozen = { [A]: 2, [B]: 1 };
    const tree = (...pairs: Array<[string, number]>): Map<string, number> => new Map(pairs);

    // Exact agreement passes.
    expect(reconcileBacklog(tree([A, 2], [B, 1]), { [A]: 2, [B]: 1 }, frozen)).toEqual([]);
    // A file that was fully converted and removed from the map passes.
    expect(reconcileBacklog(tree([A, 2]), { [A]: 2 }, frozen)).toEqual([]);
    // A brand-new file with a prose claim and no entry.
    expect(reconcileBacklog(tree([A, 2], [B, 1], [C, 1]), { [A]: 2, [B]: 1 }, frozen))
      .toEqual([expect.stringContaining(`${C} — 1 unstructured companion claim(s) and no backlog entry`)]);
    // A listed file that gained a prose claim.
    expect(reconcileBacklog(tree([A, 3], [B, 1]), { [A]: 2, [B]: 1 }, frozen))
      .toEqual([expect.stringContaining(`${A} — 3 unstructured companion claim(s), pinned at 2`)]);
    // A listed file that lost one (converted or deleted) with the pin not lowered.
    expect(reconcileBacklog(tree([A, 1], [B, 1]), { [A]: 2, [B]: 1 }, frozen))
      .toEqual([expect.stringContaining(`${A} — 1 unstructured companion claim(s) remain, pinned at 2`)]);
    // A listed file that no longer carries any, entry still present.
    expect(reconcileBacklog(tree([A, 2]), { [A]: 2, [B]: 1 }, frozen))
      .toEqual([expect.stringContaining(`${B} — 0 unstructured companion claim(s) remain, pinned at 1`)]);
    // The freed-slot and swap routes: B converted and dropped, C parked in its
    // place with the same total. C is outside the snapshot, so it is red even
    // though the map is the same length and the tree agrees with the map.
    expect(reconcileBacklog(tree([A, 2], [C, 1]), { [A]: 2, [C]: 1 }, frozen))
      .toEqual([expect.stringContaining(`${C} — pinned at 1 but absent from the landing snapshot`)]);
    // A pin raised above its landing count, with the tree agreeing.
    expect(reconcileBacklog(tree([A, 3], [B, 1]), { [A]: 3, [B]: 1 }, frozen))
      .toEqual([expect.stringContaining(`${A} — pin 3 exceeds its landing count of 2`)]);
    // A zero pin left in place of a removal, and a NaN pin that would switch
    // every arithmetic arm off.
    expect(reconcileBacklog(tree([A, 2]), { [A]: 2, [B]: 0 }, frozen))
      .toEqual([expect.stringContaining(`${B} — pinned at 0; a pin is a positive integer`)]);
    expect(reconcileBacklog(tree([A, 5]), { [A]: NaN }, frozen))
      .toEqual([expect.stringContaining(`${A} — pinned at NaN; a pin is a positive integer`)]);
    // NaN alone does not pin the SECOND loop's integer guard: every comparison
    // against NaN is false, so both arms there are silent either way. A
    // fractional pin is the value that reaches them, and it must still produce
    // exactly the one shape complaint rather than a second, arithmetic one.
    expect(reconcileBacklog(tree([A, 5]), { [A]: 2.5 }, frozen))
      .toEqual([expect.stringContaining(`${A} — pinned at 2.5; a pin is a positive integer`)]);
    // A prototype entry is not an entry: the file it names has no pin. (A
    // `__proto__` key in an object literal sets the prototype; this builds the
    // same shape without writing that key.)
    const withProto = Object.assign(Object.create({ [C]: 1 }) as Record<string, number>, { [A]: 2 });
    expect(withProto[C]).toBe(1);
    expect(reconcileBacklog(tree([A, 2], [C, 1]), withProto, frozen))
      .toEqual([expect.stringContaining(`${C} — 1 unstructured companion claim(s) and no backlog entry`)]);

    // The digest is a function of the entries, not of their order or of
    // reference identity, and any change to an entry changes it.
    expect(snapshotDigest({ [A]: 2, [B]: 1 })).toBe(snapshotDigest({ [B]: 1, [A]: 2 }));
    expect(snapshotDigest({ [A]: 2, [B]: 1 })).not.toBe(snapshotDigest({ [A]: 2, [C]: 1 }));
    expect(snapshotDigest({ [A]: 2, [B]: 1 })).not.toBe(snapshotDigest({ [A]: 2, [B]: 2 }));
  });
});
