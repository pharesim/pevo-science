/**
 * Standing source-discipline canary for the clause-(c) real-path companion
 * citations the test-mock carve-out requires (root `CLAUDE.md` "Carve-out for
 * deterministic edge-case coverage"). Scans every `.ts` under `backend/tests/`
 * and fails when a citation names a companion that cannot witness the risk
 * class it was cited for.
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
 * bracket-delimited, whitespace-free, and closes the line. Repeat the label for
 * a second companion; never fuse two claims into one sentence, because a
 * half-true compound is the shape that survives review — the reader spot-checks
 * the half that holds.
 *
 * WHAT IS CHECKED, per structured citation:
 *
 *   1. The path has the repo-relative `backend/tests/**.test.ts` shape. A
 *      `./`-prefixed or tests-relative spelling fails here with a message that
 *      names the required form, rather than as a confusing missing-file error.
 *   2. The path resolves on disk.
 *   3. The companion is not the citing file itself. A self-citation contains
 *      its own risk-class token by construction, so it would otherwise pass
 *      every other arm while proving nothing.
 *   4. The token occurs in the companion's CODE. Comment text is stripped
 *      first, and lines carrying a `vi.mock(` call do not count.
 *   5. The token is not so generic that any file would satisfy it: it may
 *      resolve in at most TOKEN_FILE_CAP files under `backend/tests`.
 *
 * WHY THE TOKEN AND NOT THE FILENAME. A check built on finding the cited
 * FILENAME inherits the exact blindness it exists to remove: the filename is
 * present, the assertion is not. Grep what the companion must assert, in the
 * companion.
 *
 * WHY COMMENT LINES DO NOT COUNT (arm 4). Risk-class tokens appear constantly
 * in prose, including prose that pins the OPPOSITE of the citation — a header
 * sentence explaining that this file deliberately does not assert the code, or
 * that the fixture is not used. Counting those would let a citation point at a
 * file whose only trace of the risk class is a sentence saying it is covered
 * elsewhere. The `vi.mock(` exclusion in the same arm is what turns the
 * historical incident red: the false companion's single surviving occurrence of
 * the token it was cited for was the line that mocked it.
 *
 * SCOPE AND THE DEFERRED SET. The validation above runs whole-tree: any
 * structured citation, anywhere under `backend/tests`, is resolved and checked.
 * That is green on landing because the structured form is new.
 *
 * The second half is a ratchet, and it is what makes the form spread. A comment
 * block that carries the companion label AND names a `*.test.ts` file is making
 * a mechanically checkable claim, so it must use the structured form — unless
 * the file is listed in DEFERRED_FREE_PROSE below. That list is the deferred
 * migration: the citations that were already free prose when this canary
 * landed. It can only shrink (see DEFERRED_CEILING), every entry must still
 * carry an unstructured citation, and a file that leaves the list by any route
 * other than conversion goes red rather than draining the ratchet quietly.
 *
 * The `.githooks/pre-commit` diff-gate arm that the anchor classes use was
 * considered and NOT taken: `.githooks/` is outside the backend zone, and the
 * in-tree ratchet is the stronger mechanism anyway — it sees the whole tree
 * rather than one diff, and no environment variable turns it off.
 *
 * DETECTION IS DELIBERATELY NARROW. The ratchet fires only on the canonical
 * `real-path <adjective>? companion` label. The corpus also carries a long tail
 * of one-off nouns for the same idea (sibling coverage, real-HAF variant,
 * no-mock companion) and a large class of citations whose referent is prose
 * rather than a file ("the lifecycle suites", "every real-HAF query in this
 * file"). Neither is ratcheted: the first would need an unbounded phrase list
 * that rots, and the second is unresolvable by any parser. Precision over
 * recall is the same trade the pre-commit anchor gate makes when it scopes
 * detection to known slug prefix families instead of maintaining an allowlist
 * of legitimate hyphenated tokens.
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
 * assertion from a fixture literal or a projection expression without an AST.
 * That stays a review judgement under the carve-out's definitional convention.
 * Three narrower blind spots, all accepted for zero false positives: a token
 * sitting in a trailing end-of-line comment on a code line still counts; a
 * token inside a multi-line `vi.mock` factory body counts unless it is on the
 * `vi.mock(` line itself; and a companion whose specs sit behind a
 * `describe.skipIf(!dbReachable)` guard satisfies every arm here while
 * contributing no coverage at all in an environment without the app database.
 * This canary proves the assertion is in the companion's source, never that it
 * ran — a citation whose companion self-skips is worth pairing with one that
 * fails loudly instead.
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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sourcesUnder, type ScannedSource } from '../support/enclosing-symbol.js';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const testsRoot = path.resolve(__dirname, '..', '..', 'tests');

/** This file's own `rel` under the walk root. It is excluded from the scan;
 *  see SELF-EXCLUSION in the header. */
const SELF_REL = 'eslint/no-unresolvable-carve-out-companion-citation.test.ts';

/** Per-block escape hatch for a legitimate citation that cannot take the
 *  structured form (an anti-citation naming a file that is explicitly NOT the
 *  companion, say). Mirrors the `anchor-allow` marker in `.githooks/pre-commit`. */
const ALLOW_MARKER = 'carve-out-citation-allow';

/** A token resolving in more than this many files under `backend/tests` proves
 *  nothing about the companion. Sized off the corpus: the risk-class tokens
 *  actually worth citing land in single digits, while `verifyHiveSignature` —
 *  the most authoritative-sounding token available, and therefore the most
 *  tempting — is satisfied by well over half the tree. */
const TOKEN_FILE_CAP = 40;

/** The deferred set's ceiling. The exact-membership check below already goes
 *  red when an entry is added, but a grow has no sympathetic cover story while
 *  a shrink does ("I converted it"), so the ceiling is what makes the direction
 *  one-way: adding a file requires raising this number in a second spelling,
 *  which cannot ride along inside a mechanical list edit. */
const DEFERRED_CEILING = 102;

/** The migration backlog: files whose companion citations were already free
 *  prose when this canary landed. Ratchet-exempt, NOT validation-exempt — a
 *  structured citation in one of these files is still resolved and checked.
 *  Remove an entry when its file's citations are fully converted; the hygiene
 *  check below fails if a converted file is still listed. */
const DEFERRED_FREE_PROSE: readonly string[] = [
  'backend/tests/consent-ops.test.ts',
  'backend/tests/consented-authors-bridge-orcid-exclusion-real-postgres.test.ts',
  'backend/tests/consented-authors-cte-real-postgres.test.ts',
  'backend/tests/digest-window-cursor.test.ts',
  'backend/tests/fetch-notifications-asc-whole-block.test.ts',
  'backend/tests/hafsql-btrim-charset-real-postgres.test.ts',
  'backend/tests/hafsql.test.ts',
  'backend/tests/ipfs-cleanup-backend-dispatch.test.ts',
  'backend/tests/jobs/custody-audit-retention-sweep.test.ts',
  'backend/tests/lib/accreditation-names-loader-whitespace.test.ts',
  'backend/tests/lib/bridge-worker.test.ts',
  'backend/tests/lib/cache-invalidation.test.ts',
  'backend/tests/lib/cache.test.ts',
  'backend/tests/lib/fresh-auth-consent-op-burn-offline-queue.test.ts',
  'backend/tests/lib/fresh-auth-redis-unavailable-burn.test.ts',
  'backend/tests/lib/idempotency.test.ts',
  'backend/tests/lib/ipfs-image-srf-guard.test.ts',
  'backend/tests/me-pending-authorships-real-postgres.test.ts',
  'backend/tests/middleware/verifyHiveSignature-authmethod.test.ts',
  'backend/tests/middleware/verifyHiveSignature-reissuedat-orcid-roundtrip.test.ts',
  'backend/tests/middleware/verifyHiveSignature-reissuedat-roundtrip.test.ts',
  'backend/tests/middleware/verifyHiveSignature-replay-timestamp.test.ts',
  'backend/tests/notification-queries-lateral-guard-canary.test.ts',
  'backend/tests/reputation-consented-credit-cycle-behavioral.test.ts',
  'backend/tests/routes/accreditation.test.ts',
  'backend/tests/routes/accreditations-likeguard-mocked.test.ts',
  'backend/tests/routes/admin-endpoints.test.ts',
  'backend/tests/routes/admin-fresh-auth-real-path-verifyhivesignature.test.ts',
  'backend/tests/routes/admin.test.ts',
  'backend/tests/routes/anonymousReview.test.ts',
  'backend/tests/routes/app-ssr-jsonld-script-breakout.test.ts',
  'backend/tests/routes/authorship-approve-signer-gate.test.ts',
  'backend/tests/routes/authorship-revoke-signer-gate.test.ts',
  'backend/tests/routes/bridge-haf-lag-locks.test.ts',
  'backend/tests/routes/bridge-register-enqueue.test.ts',
  'backend/tests/routes/bridge-register-rate-limit-skip-failed.test.ts',
  'backend/tests/routes/bridge.test.ts',
  'backend/tests/routes/citations-lateral-guard-canary.test.ts',
  'backend/tests/routes/custody-consent-ops.test.ts',
  'backend/tests/routes/custody-credit-ops.test.ts',
  'backend/tests/routes/custody-limiter-cpu-amplification.test.ts',
  'backend/tests/routes/custody-session-auth-argon-errors.test.ts',
  'backend/tests/routes/custody-session-auth.test.ts',
  'backend/tests/routes/custody-upgrade.test.ts',
  'backend/tests/routes/custody.test.ts',
  'backend/tests/routes/display-consented-self-dealing-exclusion.test.ts',
  'backend/tests/routes/haf-outage-translation-canaries.test.ts',
  'backend/tests/routes/ipfs-gateway-hardening.test.ts',
  'backend/tests/routes/ipfs-pin-durability.test.ts',
  'backend/tests/routes/ipfs-upload-real-path-verifyhivesignature.test.ts',
  'backend/tests/routes/ipfs-upload-token.test.ts',
  'backend/tests/routes/listing-count-window-function-shape.test.ts',
  'backend/tests/routes/me-authorships-pending.test.ts',
  'backend/tests/routes/notifications-arm-sql-shape.test.ts',
  'backend/tests/routes/notifications-window-cursor.test.ts',
  'backend/tests/routes/orcid.test.ts',
  'backend/tests/routes/papers-canonical-orcid-resolution.test.ts',
  'backend/tests/routes/papers-canonical-root-walker.test.ts',
  'backend/tests/routes/papers-consented-badge.test.ts',
  'backend/tests/routes/papers-cumulative-cross-surface-parity-mocked.test.ts',
  'backend/tests/routes/papers-cumulative-orcid-audit.test.ts',
  'backend/tests/routes/papers-cumulative-route-error-isolation-mocked.test.ts',
  'backend/tests/routes/papers-enrichment-parity-gate.test.ts',
  'backend/tests/routes/papers-haf-error-vs-not-found.test.ts',
  'backend/tests/routes/papers-retract-real-path-verifyhivesignature.test.ts',
  'backend/tests/routes/papers-retract-url-shape-validator.test.ts',
  'backend/tests/routes/profile-papers-cid-validate.test.ts',
  'backend/tests/routes/profile-papers-empty-cumulative-fallback.test.ts',
  'backend/tests/routes/profile-papers-supersession.test.ts',
  'backend/tests/routes/profile-reviews-accred-gate.test.ts',
  'backend/tests/routes/profile-stats-parity-gate.test.ts',
  'backend/tests/routes/recover-two-phase.test.ts',
  'backend/tests/routes/reputation-approve-signer-gate-cycle-sql-shape.test.ts',
  'backend/tests/routes/reputation-batch-cycle-boundary.test.ts',
  'backend/tests/routes/reputation-batch-internals.test.ts',
  'backend/tests/routes/reputation-batch-sql-failure.test.ts',
  'backend/tests/routes/reputation-calc-version-recompute.test.ts',
  'backend/tests/routes/reputation-citing-coauthor-exclusion-canary.test.ts',
  'backend/tests/routes/reputation-consented-credit-cycle-sql-shape.test.ts',
  'backend/tests/routes/reputation-lifecycle.test.ts',
  'backend/tests/routes/reputation-orcid-auto-accept-authority-gate.test.ts',
  'backend/tests/routes/reputation-orcid-auto-accept-trim-canary.test.ts',
  'backend/tests/routes/reputation-paper-reviews-self-exclusion-canary.test.ts',
  'backend/tests/routes/reputation-revoke-signer-gate-cycle-sql-shape.test.ts',
  'backend/tests/routes/retract-rate-limit-skip-failed.test.ts',
  'backend/tests/routes/review-agg-single-scan.test.ts',
  'backend/tests/routes/reviews.test.ts',
  'backend/tests/routes/search-partial-degradation.test.ts',
  'backend/tests/routes/search-reviews-parity-gate.test.ts',
  'backend/tests/routes/settings-email-fresh-auth.test.ts',
  'backend/tests/routes/settings-set-password-argon-error-translation.test.ts',
  'backend/tests/routes/settings-set-password-fresh-auth.test.ts',
  'backend/tests/routes/settings.test.ts',
  'backend/tests/routes/signup-verify-activation-lock-unavailable.test.ts',
  'backend/tests/routes/signup-verify-activation-recovery.test.ts',
  'backend/tests/routes/signup-verify-orcid-binding-guard.test.ts',
  'backend/tests/routes/signup-verify-postbroadcast-severity.test.ts',
  'backend/tests/routes/signup-verify-stuck-recovery.test.ts',
  'backend/tests/routes/signup-verify.test.ts',
  'backend/tests/routes/wot-retract-poll.test.ts',
  'backend/tests/routes/wot-vouch-poll.test.ts',
  'backend/tests/wot-vouch-status-select-real-postgres.test.ts',
];

// --- parsing -----------------------------------------------------------------

const COMMENT_LINE_RE = /^\s*(?:\/\*+|\*+\/|\*|\/\/)/;
const COMMENT_PREFIX_RE = /^\s*(?:\/\*+|\*+\/|\*|\/\/)[ \t]?/;

/** Fresh objects on every call. Both are `g`-flagged, and a shared instance
 *  carries `lastIndex` between calls, which silently skips matches. */
const labelPattern = (): RegExp => /real[\s-]path\s+(?:[a-z]+\s+)?companions?/gi;
const citationPattern = (): RegExp =>
  /real[\s-]path\s+(?:[a-z]+\s+)?companions?\s*:\s*`([^`]+)`\s*\[([^\n]+?)\]\s*(?=\n|$)/gi;

/** Does the block name a test file at all? Only a claim that names a file is
 *  mechanically checkable, so only that class is ratcheted. */
const NAMES_A_TEST_FILE_RE = /[\w.-]+\.test\.ts/;

/** The one accepted spelling of a companion path: repo-relative, under the
 *  backend test tree, a test file. */
const COMPANION_PATH_RE = /^backend\/tests\/[\w./-]+\.test\.ts$/;

export interface CommentBlock {
  /** 1-based index of the block's opening comment line, for the failure text. */
  readonly firstLine: number;
  /** The block with comment prefixes stripped, still newline-separated so a
   *  citation that wraps can be rejoined inside a captured span. */
  readonly text: string;
}

/**
 * Contiguous runs of comment lines, prefixes stripped. Whole-file rather than
 * header-only on purpose: citations live in `//` comments and far below the
 * imports in this corpus, and a header-scoped scan would let any author evade
 * the ratchet by moving the block down the file.
 */
export function commentBlocks(lines: string[]): CommentBlock[] {
  const out: CommentBlock[] = [];
  let start = -1;
  let buf: string[] = [];
  const flush = (): void => {
    if (buf.length > 0) out.push({ firstLine: start + 1, text: buf.join('\n') });
    buf = [];
    start = -1;
  };
  lines.forEach((line, i) => {
    if (COMMENT_LINE_RE.test(line)) {
      if (buf.length === 0) start = i;
      buf.push(line.replace(COMMENT_PREFIX_RE, ''));
    } else {
      flush();
    }
  });
  flush();
  return out;
}

export interface Citation {
  readonly companionPath: string;
  readonly token: string;
}

/**
 * Every structured citation in a block.
 *
 * The path capture spans newlines and then has ALL whitespace removed. That is
 * what repairs a filename the docblock wrapped mid-token across a continuation
 * line — the corpus breaks paths after a hyphen and after a directory slash,
 * and a line-based extractor silently truncates the name and then reports a
 * file that does not exist. Paths never contain whitespace, so the strip is
 * lossless. The token, by contrast, is required to sit on one physical line and
 * to be whitespace-free, so that a runaway bracket cannot swallow the citation
 * that follows it.
 */
export function citationsIn(text: string): Citation[] {
  return [...text.matchAll(citationPattern())].map((m) => ({
    companionPath: m[1].replace(/\s+/g, ''),
    token: m[2].trim(),
  }));
}

/** How many companion claims the block makes, structured or not. */
export function labelCount(text: string): number {
  return (text.match(labelPattern()) ?? []).length;
}

// --- validation --------------------------------------------------------------

/**
 * The companion's code, comments removed. Block comments go first, then any
 * line that is only a comment, then any line carrying a `vi.mock(` call. See
 * WHY COMMENT LINES DO NOT COUNT in the header.
 */
export function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*)/.test(line) && !/\bvi\.mock\s*\(/.test(line))
    .join('\n');
}

/** Files under the walk root whose text contains the token anywhere. */
export function tokenReach(token: string, sources: readonly ScannedSource[]): number {
  return sources.filter((s) => s.lines.some((line) => line.includes(token))).length;
}

/**
 * Validate one structured citation. Returns the reasons it fails, empty when it
 * holds. `citingRepoPath` is repo-relative so a self-citation is detectable.
 */
export function citationViolations(
  citingRepoPath: string,
  citation: Citation,
  sources: readonly ScannedSource[],
  readSource: (repoPath: string) => string | null,
): string[] {
  const { companionPath, token } = citation;
  const out: string[] = [];

  if (!COMPANION_PATH_RE.test(companionPath)) {
    out.push(
      `companion path ${JSON.stringify(companionPath)} is not repo-relative; ` +
        'write it as `backend/tests/<dir>/<name>.test.ts`',
    );
    return out;
  }
  if (companionPath === citingRepoPath) {
    out.push('cites itself as its own real-path companion, which proves nothing');
    return out;
  }
  if (!/^\S+$/.test(token) || token.length > 80) {
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
  if (!codeOf(source).includes(token)) {
    const inProse = source.includes(token);
    out.push(
      `companion ${companionPath} does not assert ${JSON.stringify(token)} in code` +
        (inProse
          ? ' (the only occurrences are in comments or on a `vi.mock(` line, which is how a' +
            ' companion that mocks the surface it was cited for reads)'
          : ' (the token does not occur there at all)'),
    );
  }
  const reach = tokenReach(token, sources);
  if (reach > TOKEN_FILE_CAP) {
    out.push(
      `risk-class token ${JSON.stringify(token)} resolves in ${reach} files under ` +
        'backend/tests, so it witnesses nothing specific; cite the code token the ' +
        'companion actually asserts',
    );
  }
  return out;
}

// --- the scan ----------------------------------------------------------------

const allSources = sourcesUnder(testsRoot);
const sources = allSources.filter((s) => s.rel !== SELF_REL);
const deferred = new Set(DEFERRED_FREE_PROSE);
const repoPathOf = (rel: string): string => `backend/tests/${rel}`;
const readFromRepo = (repoPath: string): string | null => {
  const abs = path.resolve(repoRoot, repoPath);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
};

interface BlockAudit {
  readonly repoPath: string;
  readonly block: CommentBlock;
  readonly citations: Citation[];
  readonly labels: number;
  readonly namesAFile: boolean;
  readonly exempt: boolean;
}

const audits: BlockAudit[] = [];
for (const source of sources) {
  for (const block of commentBlocks(source.lines)) {
    const labels = labelCount(block.text);
    if (labels === 0) continue;
    audits.push({
      repoPath: repoPathOf(source.rel),
      block,
      citations: citationsIn(block.text),
      labels,
      namesAFile: NAMES_A_TEST_FILE_RE.test(block.text.replace(/\n/g, '')),
      exempt: block.text.includes(ALLOW_MARKER),
    });
  }
}

const at = (a: BlockAudit): string => `${a.repoPath} (comment block opening at line ${a.block.firstLine})`;

describe('carve-out clause-(c) companion citations resolve and are witnessed', () => {
  it('walks a plausible number of test files (guards against a broken walker)', () => {
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
  });

  it('every structured citation resolves and its risk-class token is asserted in the companion', () => {
    const violations: string[] = [];
    for (const audit of audits) {
      for (const citation of audit.citations) {
        for (const reason of citationViolations(audit.repoPath, citation, sources, readFromRepo)) {
          violations.push(`${at(audit)} — ${reason}`);
        }
      }
    }
    expect(
      violations,
      'a clause-(c) companion citation names a companion that cannot witness the ' +
        'risk class it was cited for. The citation is the only artifact tying the ' +
        'mock to its justification, so a false one voids the carve-out silently:\n' +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('every file-naming companion claim is structured, deferred, or explicitly exempt', () => {
    const violations: string[] = [];
    for (const audit of audits) {
      if (audit.exempt) continue;
      if (deferred.has(audit.repoPath)) continue;
      if (!audit.namesAFile) continue;
      if (audit.citations.length === audit.labels) continue;
      violations.push(
        `${at(audit)} — ${audit.labels} companion claim(s), ` +
          `${audit.citations.length} in the structured form. Write each one as: ` +
          'Real-path companion: `backend/tests/<dir>/<name>.test.ts` [RISK_CLASS_TOKEN]',
      );
    }
    expect(
      violations,
      'a companion citation names a file but is not checkable. Use the structured ' +
        `form, or mark the block ${ALLOW_MARKER} if it genuinely cannot take one:\n` +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('the deferred set only shrinks, and every entry still carries an unstructured citation', () => {
    expect(
      DEFERRED_FREE_PROSE.length,
      'the deferred set grew. It is a migration backlog, not a parking space: a new ' +
        'mocked test writes the structured form.',
    ).toBeLessThanOrEqual(DEFERRED_CEILING);

    const unstructuredFiles = new Set(
      audits
        .filter((a) => a.namesAFile && !a.exempt && a.citations.length < a.labels)
        .map((a) => a.repoPath),
    );
    const stale = DEFERRED_FREE_PROSE.filter((entry) => !unstructuredFiles.has(entry));
    expect(
      stale,
      'these deferred entries no longer carry an unstructured file-naming citation. ' +
        'Either the file was converted (remove the entry, and lower DEFERRED_CEILING ' +
        'to the new length) or its citation was deleted rather than fixed, which is ' +
        'how a file leaves the ratchet without ever becoming checkable:\n' +
        stale.join('\n'),
    ).toEqual([]);
  });

  it('the parser and validators fire on planted-bad citations and spare legitimate ones', () => {
    // Planted probes go through the SAME functions the scan above calls. Without
    // them, an edit that mangles a pattern leaves every set empty, the canary
    // stays green, and it enforces nothing. The citation strings here are
    // synthetic fixtures held as string literals; this file is excluded from the
    // walk, so they cannot self-trip.
    const block = (...lines: string[]): string => lines.join('\n');

    // Parser POSITIVES.
    const one = citationsIn(
      block(' (c) Real-path companion: `backend/tests/routes/custody-upgrade.test.ts` [SESSION_INVALIDATED]'),
    );
    expect(one).toEqual([
      { companionPath: 'backend/tests/routes/custody-upgrade.test.ts', token: 'SESSION_INVALIDATED' },
    ]);

    // Two companions, the second on a continuation line with no `(c)` marker.
    // A non-global match, or one that requires the clause marker, checks only
    // the first and under-checks the rest in silence.
    const two = citationsIn(
      block(
        ' (c) Real-path companion: `backend/tests/a.test.ts` [ALPHA]',
        '     Real-path companion: `backend/tests/b.test.ts` [BETA]',
      ),
    );
    expect(two.map((c) => c.token)).toEqual(['ALPHA', 'BETA']);

    // A path wrapped MID-TOKEN across a continuation line. This is the form a
    // line-based extractor truncates into a nonexistent file, and it occurs in
    // this corpus at a hyphen and after a directory slash.
    const wrapped = citationsIn(
      block(
        ' (c) Real-path companion: `backend/tests/routes/ipfs-upload-real-path-',
        '     verifyhivesignature.test.ts` [uploadToken]',
      ),
    );
    expect(wrapped).toEqual([
      {
        companionPath: 'backend/tests/routes/ipfs-upload-real-path-verifyhivesignature.test.ts',
        token: 'uploadToken',
      },
    ]);

    // The label itself wrapping, which is nastier than a wrapped path because a
    // line-based label match misses the citation entirely rather than mangling it.
    expect(labelCount(block(' Real-path', ' companion coverage of the middleware'))).toBe(1);

    // An adjective inside the label (`real-path SQL companion`) and the plural.
    expect(labelCount('Real-path SQL companion: x')).toBe(1);
    expect(labelCount('Real-path companions: x and y')).toBe(1);

    // A token carrying brackets or a slash survives: the closing bracket is
    // anchored at end-of-line, so a non-greedy match backtracks to the last one.
    expect(citationsIn(' Real-path companion: `backend/tests/a.test.ts` [rows[0].author_index]')[0].token)
      .toBe('rows[0].author_index');
    expect(citationsIn(' Real-path companion: `backend/tests/a.test.ts` [/api/settings/set-password]')[0].token)
      .toBe('/api/settings/set-password');

    // Parser NEGATIVES — free prose extracts nothing, so it falls to the ratchet
    // rather than being silently accepted as a checked citation.
    expect(citationsIn(' (c) Real-path companion: routes/notifications.test.ts exercises the same SQL')).toEqual([]);
    expect(citationsIn(' (c) Real-path companion: the settings suites cover it')).toEqual([]);

    // Block splitting: a `//` run and a docblock are separate blocks, and both
    // are scanned. A header-only parser would see neither of the `//` ones.
    const blocks = commentBlocks([
      '/**', ' * Real-path companion: `backend/tests/a.test.ts` [ALPHA]', ' */',
      'const x = 1;',
      '// Real-path companion: `backend/tests/b.test.ts` [BETA]',
    ]);
    expect(blocks.map((b) => citationsIn(b.text).map((c) => c.token))).toEqual([['ALPHA'], ['BETA']]);

    // Validator: comment-only occurrences do not count, and a `vi.mock(` line
    // does not count. Both are real rot classes, not hypotheticals.
    expect(codeOf('/** asserts SESSION_INVALIDATED */\nconst a = 1;')).not.toContain('SESSION_INVALIDATED');
    expect(codeOf('// not SESSION_INVALIDATED here\nconst a = 1;')).not.toContain('SESSION_INVALIDATED');
    expect(codeOf("vi.mock('../../src/middleware/verifyHiveSignature.js', () => ({}));\nconst a = 1;"))
      .not.toContain('verifyHiveSignature');
    expect(codeOf("expect(res.body.error.code).toBe('SESSION_INVALIDATED');")).toContain('SESSION_INVALIDATED');

    // Validator arms, each exercised through the real entry point.
    const synthetic: ScannedSource[] = [{ rel: 'synthetic.ts', lines: ['const ALPHA = 1;'] }];
    const stub = (body: string) => (): string | null => body;
    const citing = 'backend/tests/routes/synthetic.test.ts';

    // Nonexistent companion.
    expect(
      citationViolations(citing, { companionPath: 'backend/tests/routes/absent.test.ts', token: 'ALPHA' },
        synthetic, () => null),
    ).toEqual([expect.stringContaining('does not exist')]);

    // Exists, token absent.
    expect(
      citationViolations(citing, { companionPath: 'backend/tests/routes/present.test.ts', token: 'ALPHA' },
        synthetic, stub('const unrelated = 1;')),
    ).toEqual([expect.stringContaining('does not occur there at all')]);

    // Exists, token present only in prose — the "verified to exist" verdict
    // that this canary exists to stop being mistaken for coverage.
    expect(
      citationViolations(citing, { companionPath: 'backend/tests/routes/present.test.ts', token: 'ALPHA' },
        synthetic, stub('// ALPHA is deliberately not asserted here\nconst x = 1;')),
    ).toEqual([expect.stringContaining('in comments or on a `vi.mock(` line')]);

    // Correct citation passes.
    expect(
      citationViolations(citing, { companionPath: 'backend/tests/routes/present.test.ts', token: 'ALPHA' },
        synthetic, stub('expect(code).toBe(ALPHA);')),
    ).toEqual([]);

    // Self-citation.
    expect(
      citationViolations(citing, { companionPath: citing, token: 'ALPHA' }, synthetic, stub('ALPHA;')),
    ).toEqual([expect.stringContaining('cites itself')]);

    // Path shape: tests-relative and `./`-prefixed forms are rejected before the
    // filesystem is touched, so the message names the required form.
    for (const bad of ['routes/notifications.test.ts', './backend/tests/routes/a.test.ts', 'backend/src/db.ts']) {
      expect(
        citationViolations(citing, { companionPath: bad, token: 'ALPHA' }, synthetic, stub('ALPHA;')),
      ).toEqual([expect.stringContaining('not repo-relative')]);
    }

    // Over-generic token: measured against the real tree, not a fixture, so the
    // cap stays calibrated to the corpus it guards.
    expect(tokenReach('verifyHiveSignature', sources)).toBeGreaterThan(TOKEN_FILE_CAP);
    expect(tokenReach('SESSION_INVALIDATED', sources)).toBeLessThanOrEqual(TOKEN_FILE_CAP);
    expect(tokenReach('SESSION_INVALIDATED', sources)).toBeGreaterThan(0);

    // Ratchet arithmetic: a block making two claims with one structured citation
    // is a violation, which is what stops a partial conversion from reading as
    // a complete one.
    const partial = block(
      ' (c) Real-path companion: `backend/tests/a.test.ts` [ALPHA]',
      '     Real-path companion: b.test.ts covers the rest',
    );
    expect(labelCount(partial)).toBe(2);
    expect(citationsIn(partial).length).toBe(1);
  });
});
