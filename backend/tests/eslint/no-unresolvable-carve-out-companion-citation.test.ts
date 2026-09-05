/**
 * Standing source-discipline canary for the clause-(c) real-path companion
 * citations the test-mock carve-out requires (root `CLAUDE.md` "Carve-out for
 * deterministic edge-case coverage"). Scans every `.ts` under `backend/tests/`
 * and fails when a citation names a companion that cannot witness the risk
 * class it was cited for, or when a companion claim is written in a form that
 * nothing can check.
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
 * A block comment is recognised only when its opener STARTS a line, the same
 * rule the support module's `isCommentedOut` applies. An opener inside a string
 * literal is code, and this corpus has such fixtures (a sentinel whose value is
 * the SQL block comment `search.reviews.branch`): a stripper that honoured it
 * would delete code up to the next closer and turn a CORRECT citation red with
 * the most misleading message this file can produce, which is how a guard gets
 * marked allow or deleted. The cost is that a block comment trailing a code
 * line is no longer stripped, the same accepted blind spot as the trailing `//`
 * comment below.
 *
 * SCOPE: VALIDATION IS WHOLE-TREE. Any structured citation, anywhere under
 * `backend/tests`, is resolved and checked, in every file, exempt or not.
 *
 * THE RATCHET. Every comment block carrying the companion label is making a
 * clause-(c) claim, and a claim is checkable only in the structured form. So a
 * block must carry one structured citation per label, and once it does, the
 * prose left over must not name a test file, because one checked citation
 * beside one unchecked filename is the half-true compound again. A block that
 * fails either test is a violation unless it carries the ALLOW_MARKER or is
 * covered by the backlog below. A claim that names no file at all ("the
 * settings suites cover it") is rejected, not validated: nothing can resolve
 * it, which is an argument against checking it and no argument for admitting
 * it. Such a claim either cites a file or carries the marker with its reason.
 *
 * THE BACKLOG. The corpus predates the structured form, so the blocks that were
 * already unstructured when this ratchet landed are carried in two per-file
 * count maps: DEFERRED_FREE_PROSE for blocks that name a test file in prose
 * (convert them), and DEFERRED_FILELESS for blocks that name no file (decide:
 * cite a file, or mark the block allow). Each map pins the file's count
 * EXACTLY, and each is bounded by a frozen snapshot of the landing state that
 * is never edited. Together those give the properties a bare file list and a
 * bare ceiling did not:
 *
 *   - a file absent from the snapshot can never enter the backlog, so a new
 *     file, or one file swapped for another, writes the structured form;
 *   - a listed file whose count rises above its pin is red, so a new prose
 *     claim in a backlog file is caught even though the file is listed;
 *   - a listed file whose count falls below its pin is red until the pin is
 *     lowered, so a conversion (or a deletion) is a visible edit and never a
 *     slot quietly freed for the next prose claim;
 *   - a pin cannot exceed its landing count and cannot be zero, so the maps
 *     only shrink, and the ceiling on their size is the snapshot itself rather
 *     than a number kept in step by hand.
 *
 * The frozen snapshot is the root of trust and the one thing this file cannot
 * verify. The entry-count and block-count tripwires on it mean an edit to it
 * needs a second edit in a second spelling. That is friction, not a guarantee,
 * and the docblock on the snapshot says so.
 *
 * WHAT IS NOT RATCHETED. Detection keys on the canonical
 * `real-path <adjective>? companion` label. The corpus also carries a long
 * tail of one-off nouns for the same idea (sibling coverage, real-HAF variant,
 * no-mock companion); those are not ratcheted, because catching them needs an
 * unbounded phrase list that rots. Precision over recall is the same trade the
 * pre-commit anchor gate makes when it scopes detection to known slug prefix
 * families. The ALLOW_MARKER is likewise unbounded and uncounted: it is the
 * lowest-friction answer to any red bar this file produces, and it is a review
 * judgement, not a mechanical one, whether a given use of it is honest.
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
 * Narrower blind spots, all accepted for zero false positives: a token sitting
 * in a trailing end-of-line comment on a code line still counts, and so does
 * one inside a block comment that trails code on the same line; a token inside
 * a multi-line `vi.mock` factory body counts unless it is on the `vi.mock(`
 * line itself; and a companion whose specs sit behind a
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

/** Per-block escape hatch for a legitimate claim that cannot take the
 *  structured form: an anti-citation stating that NO real-path companion exists
 *  and why, or a claim whose referent is a behaviour rather than a file.
 *  Mirrors the `anchor-allow` marker in `.githooks/pre-commit`. Unbounded and
 *  uncounted by design; see WHAT IS NOT RATCHETED in the header. */
const ALLOW_MARKER = 'carve-out-citation-allow';

/** A token resolving in more than this many files under `backend/tests` proves
 *  nothing about the companion. Sized off the corpus: the risk-class tokens
 *  actually worth citing land in single digits, while `verifyHiveSignature` —
 *  the most authoritative-sounding token available, and therefore the most
 *  tempting — is satisfied by well over half the tree. */
const TOKEN_FILE_CAP = 40;

/** The one accepted spelling, quoted in every ratchet message. */
const STRUCTURED_FORM = 'Real-path companion: `backend/tests/<dir>/<name>.test.ts` [RISK_CLASS_TOKEN]';

// --- the landing snapshot: NEVER EDIT ----------------------------------------

/**
 * The state of the corpus on the day the ratchet landed, per file: how many
 * labelled blocks named a test file in prose without the structured form
 * (LANDING_FREE_PROSE), and how many carried the label but named no file at all
 * (LANDING_FILELESS). These two maps are the root of trust for the backlog
 * below and are NEVER EDITED, in either direction. The live maps must be a
 * subset of them, entry by entry and count by count; that subset rule is what
 * stops a converted file's slot being reused by a new one, a deleted claim
 * freeing room for a fresh prose claim, or one file being swapped for another
 * under an unchanged total.
 *
 * The tripwire test below pins these maps' entry and block totals as literals.
 * That makes an edit here need a second edit elsewhere; it does not make one
 * impossible, and nothing in this file can. Treat a diff that touches these
 * maps as a defect in its own right.
 */
const LANDING_FREE_PROSE: Readonly<Record<string, number>> = {
  'backend/tests/consent-ops.test.ts': 1,
  'backend/tests/consented-authors-bridge-orcid-exclusion-real-postgres.test.ts': 1,
  'backend/tests/consented-authors-cte-real-postgres.test.ts': 1,
  'backend/tests/digest-window-cursor.test.ts': 1,
  'backend/tests/fetch-notifications-asc-whole-block.test.ts': 1,
  'backend/tests/hafsql-btrim-charset-real-postgres.test.ts': 1,
  'backend/tests/hafsql.test.ts': 2,
  'backend/tests/ipfs-cleanup-backend-dispatch.test.ts': 1,
  'backend/tests/jobs/custody-audit-retention-sweep.test.ts': 1,
  'backend/tests/lib/accreditation-names-loader-whitespace.test.ts': 1,
  'backend/tests/lib/bridge-worker.test.ts': 1,
  'backend/tests/lib/cache-invalidation.test.ts': 1,
  'backend/tests/lib/cache.test.ts': 1,
  'backend/tests/lib/fresh-auth-consent-op-burn-offline-queue.test.ts': 1,
  'backend/tests/lib/fresh-auth-redis-unavailable-burn.test.ts': 1,
  'backend/tests/lib/idempotency.test.ts': 1,
  'backend/tests/lib/ipfs-image-srf-guard.test.ts': 1,
  'backend/tests/me-pending-authorships-real-postgres.test.ts': 1,
  'backend/tests/middleware/verifyHiveSignature-authmethod.test.ts': 1,
  'backend/tests/middleware/verifyHiveSignature-reissuedat-orcid-roundtrip.test.ts': 1,
  'backend/tests/middleware/verifyHiveSignature-reissuedat-roundtrip.test.ts': 1,
  'backend/tests/middleware/verifyHiveSignature-replay-timestamp.test.ts': 1,
  'backend/tests/notification-queries-lateral-guard-canary.test.ts': 1,
  'backend/tests/reputation-consented-credit-cycle-behavioral.test.ts': 1,
  'backend/tests/routes/accreditation.test.ts': 2,
  'backend/tests/routes/accreditations-likeguard-mocked.test.ts': 1,
  'backend/tests/routes/admin-endpoints.test.ts': 1,
  'backend/tests/routes/admin-fresh-auth-real-path-verifyhivesignature.test.ts': 1,
  'backend/tests/routes/admin.test.ts': 1,
  'backend/tests/routes/anonymousReview.test.ts': 1,
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
  'backend/tests/routes/custody-limiter-cpu-amplification.test.ts': 1,
  'backend/tests/routes/custody-session-auth-argon-errors.test.ts': 1,
  'backend/tests/routes/custody-session-auth.test.ts': 1,
  'backend/tests/routes/custody-upgrade.test.ts': 1,
  'backend/tests/routes/custody.test.ts': 1,
  'backend/tests/routes/display-consented-self-dealing-exclusion.test.ts': 1,
  'backend/tests/routes/haf-outage-translation-canaries.test.ts': 1,
  'backend/tests/routes/ipfs-gateway-hardening.test.ts': 1,
  'backend/tests/routes/ipfs-pin-durability.test.ts': 1,
  'backend/tests/routes/ipfs-upload-real-path-verifyhivesignature.test.ts': 1,
  'backend/tests/routes/ipfs-upload-token.test.ts': 1,
  'backend/tests/routes/listing-count-window-function-shape.test.ts': 1,
  'backend/tests/routes/me-authorships-pending.test.ts': 1,
  'backend/tests/routes/notifications-arm-sql-shape.test.ts': 1,
  'backend/tests/routes/notifications-window-cursor.test.ts': 1,
  'backend/tests/routes/orcid.test.ts': 2,
  'backend/tests/routes/papers-canonical-orcid-resolution.test.ts': 1,
  'backend/tests/routes/papers-canonical-root-walker.test.ts': 1,
  'backend/tests/routes/papers-consented-badge.test.ts': 1,
  'backend/tests/routes/papers-cumulative-cross-surface-parity-mocked.test.ts': 1,
  'backend/tests/routes/papers-cumulative-orcid-audit.test.ts': 1,
  'backend/tests/routes/papers-cumulative-route-error-isolation-mocked.test.ts': 1,
  'backend/tests/routes/papers-enrichment-parity-gate.test.ts': 1,
  'backend/tests/routes/papers-haf-error-vs-not-found.test.ts': 1,
  'backend/tests/routes/papers-retract-real-path-verifyhivesignature.test.ts': 1,
  'backend/tests/routes/papers-retract-url-shape-validator.test.ts': 1,
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
  'backend/tests/routes/settings-set-password-argon-error-translation.test.ts': 1,
  'backend/tests/routes/settings-set-password-fresh-auth.test.ts': 1,
  'backend/tests/routes/settings.test.ts': 1,
  'backend/tests/routes/signup-verify-activation-lock-unavailable.test.ts': 1,
  'backend/tests/routes/signup-verify-activation-recovery.test.ts': 1,
  'backend/tests/routes/signup-verify-orcid-binding-guard.test.ts': 1,
  'backend/tests/routes/signup-verify-postbroadcast-severity.test.ts': 1,
  'backend/tests/routes/signup-verify-stuck-recovery.test.ts': 1,
  'backend/tests/routes/signup-verify.test.ts': 1,
  'backend/tests/routes/wot-retract-poll.test.ts': 1,
  'backend/tests/routes/wot-vouch-poll.test.ts': 1,
  'backend/tests/wot-vouch-status-select-real-postgres.test.ts': 1,
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

// --- the live backlog: shrinks toward empty ----------------------------------

/**
 * The migration backlog, per file: how many labelled blocks in that file are
 * still unstructured. DEFERRED_FREE_PROSE holds the blocks that name a test
 * file in prose, which convert mechanically to the structured form.
 * DEFERRED_FILELESS holds the blocks that carry the label but name no file at
 * all: anti-citations ("no real-path companion exists because ..."), suite
 * families, behaviourally-named uncovered risk classes. Each of those needs a
 * decision rather than a rewrite: cite the file that witnesses it, or keep the
 * prose and mark the block with the ALLOW_MARKER and its reason.
 *
 * Both maps are ratchet-exempt and NOT validation-exempt: a structured citation
 * in a listed file is still resolved and checked. The count is EXACT. When a
 * block in a listed file is converted (or deleted), lower that file's pin, and
 * remove the entry when it would reach zero. A pin can never rise, an entry can
 * never be added, and a file outside the landing snapshot can never appear
 * here; the reconciliation test names the entry and the direction whenever the
 * tree and this map disagree.
 */
const DEFERRED_FREE_PROSE: Readonly<Record<string, number>> = {
  'backend/tests/consent-ops.test.ts': 1,
  'backend/tests/consented-authors-bridge-orcid-exclusion-real-postgres.test.ts': 1,
  'backend/tests/consented-authors-cte-real-postgres.test.ts': 1,
  'backend/tests/digest-window-cursor.test.ts': 1,
  'backend/tests/fetch-notifications-asc-whole-block.test.ts': 1,
  'backend/tests/hafsql-btrim-charset-real-postgres.test.ts': 1,
  'backend/tests/hafsql.test.ts': 2,
  'backend/tests/ipfs-cleanup-backend-dispatch.test.ts': 1,
  'backend/tests/jobs/custody-audit-retention-sweep.test.ts': 1,
  'backend/tests/lib/accreditation-names-loader-whitespace.test.ts': 1,
  'backend/tests/lib/bridge-worker.test.ts': 1,
  'backend/tests/lib/cache-invalidation.test.ts': 1,
  'backend/tests/lib/cache.test.ts': 1,
  'backend/tests/lib/fresh-auth-consent-op-burn-offline-queue.test.ts': 1,
  'backend/tests/lib/fresh-auth-redis-unavailable-burn.test.ts': 1,
  'backend/tests/lib/idempotency.test.ts': 1,
  'backend/tests/lib/ipfs-image-srf-guard.test.ts': 1,
  'backend/tests/me-pending-authorships-real-postgres.test.ts': 1,
  'backend/tests/middleware/verifyHiveSignature-authmethod.test.ts': 1,
  'backend/tests/middleware/verifyHiveSignature-reissuedat-orcid-roundtrip.test.ts': 1,
  'backend/tests/middleware/verifyHiveSignature-reissuedat-roundtrip.test.ts': 1,
  'backend/tests/middleware/verifyHiveSignature-replay-timestamp.test.ts': 1,
  'backend/tests/notification-queries-lateral-guard-canary.test.ts': 1,
  'backend/tests/reputation-consented-credit-cycle-behavioral.test.ts': 1,
  'backend/tests/routes/accreditation.test.ts': 2,
  'backend/tests/routes/accreditations-likeguard-mocked.test.ts': 1,
  'backend/tests/routes/admin-endpoints.test.ts': 1,
  'backend/tests/routes/admin-fresh-auth-real-path-verifyhivesignature.test.ts': 1,
  'backend/tests/routes/admin.test.ts': 1,
  'backend/tests/routes/anonymousReview.test.ts': 1,
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
  'backend/tests/routes/custody-limiter-cpu-amplification.test.ts': 1,
  'backend/tests/routes/custody-session-auth-argon-errors.test.ts': 1,
  'backend/tests/routes/custody-session-auth.test.ts': 1,
  'backend/tests/routes/custody-upgrade.test.ts': 1,
  'backend/tests/routes/custody.test.ts': 1,
  'backend/tests/routes/display-consented-self-dealing-exclusion.test.ts': 1,
  'backend/tests/routes/haf-outage-translation-canaries.test.ts': 1,
  'backend/tests/routes/ipfs-gateway-hardening.test.ts': 1,
  'backend/tests/routes/ipfs-pin-durability.test.ts': 1,
  'backend/tests/routes/ipfs-upload-real-path-verifyhivesignature.test.ts': 1,
  'backend/tests/routes/ipfs-upload-token.test.ts': 1,
  'backend/tests/routes/listing-count-window-function-shape.test.ts': 1,
  'backend/tests/routes/me-authorships-pending.test.ts': 1,
  'backend/tests/routes/notifications-arm-sql-shape.test.ts': 1,
  'backend/tests/routes/notifications-window-cursor.test.ts': 1,
  'backend/tests/routes/orcid.test.ts': 2,
  'backend/tests/routes/papers-canonical-orcid-resolution.test.ts': 1,
  'backend/tests/routes/papers-canonical-root-walker.test.ts': 1,
  'backend/tests/routes/papers-consented-badge.test.ts': 1,
  'backend/tests/routes/papers-cumulative-cross-surface-parity-mocked.test.ts': 1,
  'backend/tests/routes/papers-cumulative-orcid-audit.test.ts': 1,
  'backend/tests/routes/papers-cumulative-route-error-isolation-mocked.test.ts': 1,
  'backend/tests/routes/papers-enrichment-parity-gate.test.ts': 1,
  'backend/tests/routes/papers-haf-error-vs-not-found.test.ts': 1,
  'backend/tests/routes/papers-retract-real-path-verifyhivesignature.test.ts': 1,
  'backend/tests/routes/papers-retract-url-shape-validator.test.ts': 1,
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
  'backend/tests/routes/settings-set-password-argon-error-translation.test.ts': 1,
  'backend/tests/routes/settings-set-password-fresh-auth.test.ts': 1,
  'backend/tests/routes/settings.test.ts': 1,
  'backend/tests/routes/signup-verify-activation-lock-unavailable.test.ts': 1,
  'backend/tests/routes/signup-verify-activation-recovery.test.ts': 1,
  'backend/tests/routes/signup-verify-orcid-binding-guard.test.ts': 1,
  'backend/tests/routes/signup-verify-postbroadcast-severity.test.ts': 1,
  'backend/tests/routes/signup-verify-stuck-recovery.test.ts': 1,
  'backend/tests/routes/signup-verify.test.ts': 1,
  'backend/tests/routes/wot-retract-poll.test.ts': 1,
  'backend/tests/routes/wot-vouch-poll.test.ts': 1,
  'backend/tests/wot-vouch-status-select-real-postgres.test.ts': 1,
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

const COMMENT_LINE_RE = /^\s*(?:\/\*+|\*+\/|\*|\/\/)/;
const COMMENT_PREFIX_RE = /^\s*(?:\/\*+|\*+\/|\*|\/\/)[ \t]?/;

/** Fresh objects on every call. Both are `g`-flagged, and a shared instance
 *  carries `lastIndex` between calls, which silently skips matches. */
const labelPattern = (): RegExp => /real[\s-]path\s+(?:[a-z]+\s+)?companions?/gi;
const citationPattern = (): RegExp =>
  /real[\s-]path\s+(?:[a-z]+\s+)?companions?\s*:\s*`([^`]+)`\s*\[([^\n]+?)\]\s*(?=\n|$)/gi;

/** Does a span of prose name a test file? Decides which backlog an
 *  unstructured block belongs to, and catches a filename left in prose beside
 *  a structured citation. */
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

/** Newlines are removed first so a name the docblock wrapped mid-token still
 *  reads as one name. */
function namesATestFile(text: string): boolean {
  return NAMES_A_TEST_FILE_RE.test(text.replace(/\n/g, ''));
}

/** The block with every structured citation cut out. What remains is prose,
 *  and prose that still names a test file is a claim nothing checks. */
function proseRemainder(text: string): string {
  return text.replace(citationPattern(), '');
}

// --- validation --------------------------------------------------------------

/**
 * The companion's code, comments removed. Block comments whose opener starts a
 * line go first, then any line that is only a comment, then any line carrying
 * a `vi.mock(` call. The opener is anchored to line start on purpose: a `/*`
 * inside a string literal is code, and honouring it would delete real code up
 * to the next closer. See WHY COMMENT LINES DO NOT COUNT in the header.
 */
export function codeOf(source: string): string {
  return source
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
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

// --- the ratchet -------------------------------------------------------------

/** The facts about a labelled block that the ratchet decides on. A plain shape,
 *  so the planted probes below can drive `ratchetClass` with synthetic inputs
 *  and prove each branch, the exempt one included, is live. */
interface BlockShape {
  readonly labels: number;
  readonly citations: number;
  /** Any test filename anywhere in the block. */
  readonly namesAFile: boolean;
  /** A test filename in what is left once the structured citations are cut. */
  readonly remainderNamesAFile: boolean;
  readonly exempt: boolean;
}

/** The scan and the probes derive a block's shape through this one function,
 *  so a mangled pattern is caught by the probes rather than emptying a class. */
function blockShape(text: string): BlockShape {
  return {
    labels: labelCount(text),
    citations: citationsIn(text).length,
    namesAFile: namesATestFile(text),
    remainderNamesAFile: namesATestFile(proseRemainder(text)),
    exempt: text.includes(ALLOW_MARKER),
  };
}

/**
 * What the ratchet makes of a block:
 *
 *   - `exempt`: carries the ALLOW_MARKER; skipped by the ratchet only.
 *   - `structured`: one structured citation per label and no filename left in
 *     the prose. The only shape that passes on its own merits.
 *   - `leaky`: fully structured, but the prose beside the citations still
 *     names a test file. The half-true compound; always a violation.
 *   - `free-prose`: fewer citations than labels, and the block names a test
 *     file. Convertible, and pinned in DEFERRED_FREE_PROSE for now.
 *   - `fileless`: fewer citations than labels, and no file named at all.
 *     Unresolvable by any parser, hence rejected rather than validated, and
 *     pinned in DEFERRED_FILELESS for now.
 */
type RatchetClass = 'exempt' | 'structured' | 'leaky' | 'free-prose' | 'fileless';

function ratchetClass(b: BlockShape): RatchetClass {
  if (b.exempt) return 'exempt';
  if (b.citations < b.labels) return b.namesAFile ? 'free-prose' : 'fileless';
  return b.remainderNamesAFile ? 'leaky' : 'structured';
}

/**
 * Reconcile one backlog class against the tree. `actual` is the per-file count
 * of blocks in that class as scanned (files with none are absent); `live` is
 * the editable pin map; `frozen` is the never-edited landing snapshot. Returns
 * every way the three disagree, each naming the file and the direction.
 */
function reconcileBacklog(
  actual: ReadonlyMap<string, number>,
  live: Readonly<Record<string, number>>,
  frozen: Readonly<Record<string, number>>,
): string[] {
  const out: string[] = [];
  for (const [file, pin] of Object.entries(live)) {
    if (!(file in frozen)) {
      out.push(
        `${file} — pinned at ${pin} but absent from the landing snapshot. The backlog ` +
          'admits no new files; write the structured form instead',
      );
      continue;
    }
    if (pin > frozen[file]) {
      out.push(`${file} — pin ${pin} exceeds its landing count of ${frozen[file]}; pins only move down`);
    }
    if (pin < 1) out.push(`${file} — pinned at ${pin}; remove the entry rather than pinning zero`);
  }
  const files = [...new Set([...Object.keys(live), ...actual.keys()])].sort();
  for (const file of files) {
    const n = actual.get(file) ?? 0;
    const pin = live[file];
    if (pin === undefined) {
      out.push(
        `${file} — ${n} unstructured companion claim(s) and no backlog entry. ` +
          `Write each one as: ${STRUCTURED_FORM}`,
      );
    } else if (n > pin) {
      out.push(
        `${file} — ${n} unstructured companion claim(s), pinned at ${pin}. The backlog ` +
          `does not grow; the new one(s) are written as: ${STRUCTURED_FORM}`,
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

// --- the scan ----------------------------------------------------------------

const allSources = sourcesUnder(testsRoot);
const sources = allSources.filter((s) => s.rel !== SELF_REL);
const repoPathOf = (rel: string): string => `backend/tests/${rel}`;
const readFromRepo = (repoPath: string): string | null => {
  const abs = path.resolve(repoRoot, repoPath);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
};

interface BlockAudit {
  readonly repoPath: string;
  readonly block: CommentBlock;
  readonly citations: Citation[];
  readonly cls: RatchetClass;
}

const audits: BlockAudit[] = [];
for (const source of sources) {
  for (const block of commentBlocks(source.lines)) {
    const shape = blockShape(block.text);
    if (shape.labels === 0) continue;
    audits.push({
      repoPath: repoPathOf(source.rel),
      block,
      citations: citationsIn(block.text),
      cls: ratchetClass(shape),
    });
  }
}

const at = (a: BlockAudit): string => `${a.repoPath} (comment block opening at line ${a.block.firstLine})`;

/** Per-file count of blocks in one ratchet class; files with none are absent. */
function countByFile(cls: RatchetClass): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of audits) {
    if (a.cls === cls) out.set(a.repoPath, (out.get(a.repoPath) ?? 0) + 1);
  }
  return out;
}

const sumOf = (m: Readonly<Record<string, number>>): number =>
  Object.values(m).reduce((acc, n) => acc + n, 0);

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

  it('a structured block names no test file in the prose beside its citations', () => {
    const leaky = audits.filter((a) => a.cls === 'leaky').map(at);
    expect(
      leaky,
      'a block whose companion claims are all structured still names a test file ' +
        'in its prose. That is one checked citation vouching for an unchecked one, ' +
        'which is the half-true compound this canary exists to reject. Either cite ' +
        `the file in the structured form or drop the filename from the prose:\n${leaky.join('\n')}`,
    ).toEqual([]);
  });

  it('every file-naming prose claim is in the backlog at exactly its pin, and the backlog only shrinks', () => {
    const disagreements = reconcileBacklog(countByFile('free-prose'), DEFERRED_FREE_PROSE, LANDING_FREE_PROSE);
    expect(
      disagreements,
      'the tree and DEFERRED_FREE_PROSE disagree. A new file, or a new block in a ' +
        `listed file, is written as ${STRUCTURED_FORM} rather than added here; a ` +
        `converted block lowers its file's pin:\n${disagreements.join('\n')}`,
    ).toEqual([]);
  });

  it('every file-less companion claim is in its backlog at exactly its pin, and that backlog only shrinks', () => {
    const disagreements = reconcileBacklog(countByFile('fileless'), DEFERRED_FILELESS, LANDING_FILELESS);
    expect(
      disagreements,
      'the tree and DEFERRED_FILELESS disagree. A companion claim that names no ' +
        'file is unresolvable by any parser and is not admitted: either cite the ' +
        `file that witnesses it as ${STRUCTURED_FORM}, or keep the prose and mark ` +
        `the block ${ALLOW_MARKER} with the reason no file can be cited:\n${disagreements.join('\n')}`,
    ).toEqual([]);
  });

  it('the landing snapshot is unchanged (tripwire, not a guarantee)', () => {
    // A second spelling of the snapshot's size. An edit to the snapshot maps
    // then needs an edit here too, which is the most this file can do about
    // its own root of trust; see the snapshot docblock.
    expect(Object.keys(LANDING_FREE_PROSE).length).toBe(102);
    expect(sumOf(LANDING_FREE_PROSE)).toBe(108);
    expect(Object.keys(LANDING_FILELESS).length).toBe(14);
    expect(sumOf(LANDING_FILELESS)).toBe(16);
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

    // A block-comment opener inside a string literal is code, not a comment.
    // Both shapes are real fixtures in this corpus: a sentinel whose VALUE is a
    // SQL block comment, and a predicate testing for the opener. A stripper
    // that honoured the opener would cut everything to the next closer and fail
    // a correct citation with the "only in comments" message.
    expect(codeOf("const SENTINEL = '/* search.reviews.branch */';\nexpect(sql).toContain(SENTINEL);"))
      .toContain('search.reviews.branch');
    expect(codeOf("if (trimmed.startsWith('/*')) return true;\nconst ALPHA = 1; /* closer */"))
      .toContain('ALPHA');
    // A block comment that starts a line is still stripped, indented or not.
    expect(codeOf('  /* ALPHA is not asserted */\nconst x = 1;')).not.toContain('ALPHA');
    expect(codeOf('/**\n * ALPHA\n */\nconst x = 1;')).not.toContain('ALPHA');

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

    // Over-generic token, through the real entry point and against the real
    // tree, so the cap stays calibrated to the corpus it guards. The companion
    // asserts the token, so the reach arm is the only one that can fire.
    expect(
      citationViolations(citing, { companionPath: 'backend/tests/routes/present.test.ts', token: 'verifyHiveSignature' },
        sources, stub('app.use(verifyHiveSignature);')),
    ).toEqual([expect.stringMatching(/resolves in \d+ files under backend\/tests/)]);
    expect(tokenReach('verifyHiveSignature', sources)).toBeGreaterThan(TOKEN_FILE_CAP);
    expect(tokenReach('SESSION_INVALIDATED', sources)).toBeLessThanOrEqual(TOKEN_FILE_CAP);
    expect(tokenReach('SESSION_INVALIDATED', sources)).toBeGreaterThan(0);
  });

  it('the ratchet classifies planted blocks correctly and the backlog reconciler names every disagreement', () => {
    const block = (...lines: string[]): string => lines.join('\n');
    const classOf = (text: string): RatchetClass => ratchetClass(blockShape(text));

    // Structured: one citation per label, nothing else named.
    expect(classOf(block(
      ' (c) Real-path companion: `backend/tests/a.test.ts` [ALPHA]',
      '     Real-path companion: `backend/tests/b.test.ts` [BETA]',
    ))).toBe('structured');

    // Leaky: every label structured, but a filename survives in the prose
    // beside them. This is the half-true compound with one half converted.
    expect(classOf(block(
      ' (c) Real-path companion: `backend/tests/a.test.ts` [ALPHA]',
      '     The happy path is also pinned by settings.test.ts and recover.test.ts.',
    ))).toBe('leaky');

    // Partial conversion: two claims, one structured, is free-prose, which is
    // what stops a partial conversion from reading as a complete one.
    expect(classOf(block(
      ' (c) Real-path companion: `backend/tests/a.test.ts` [ALPHA]',
      '     Real-path companion: b.test.ts covers the rest',
    ))).toBe('free-prose');

    // Free prose naming a file, and a claim naming no file at all. The second
    // is verbatim the shape a removed violation had, and it is rejected rather
    // than passed through as unresolvable.
    expect(classOf(' (c) Real-path companion: routes/notifications.test.ts exercises the same SQL')).toBe('free-prose');
    expect(classOf(' (c) Real-path companion: the settings password-reset suites cover the live happy path')).toBe('fileless');

    // The exempt gate, in both directions. A mismatch with the marker is
    // skipped; the same mismatch without it is not.
    const prose = ' (c) Real-path companion: the settings suites cover it';
    expect(classOf(`${prose} (${ALLOW_MARKER}: no single file is the referent)`)).toBe('exempt');
    expect(classOf(prose)).toBe('fileless');
    expect(ratchetClass({ labels: 1, citations: 0, namesAFile: true, remainderNamesAFile: true, exempt: true }))
      .toBe('exempt');
    expect(ratchetClass({ labels: 1, citations: 0, namesAFile: true, remainderNamesAFile: true, exempt: false }))
      .toBe('free-prose');

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
    // A zero pin left in place of a removal.
    expect(reconcileBacklog(tree([A, 2]), { [A]: 2, [B]: 0 }, frozen))
      .toEqual([expect.stringContaining(`${B} — pinned at 0; remove the entry`)]);
  });
});
