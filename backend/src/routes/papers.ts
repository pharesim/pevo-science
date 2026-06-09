import crypto from 'crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { PrivateKey } from '@hiveio/dhive';
import { getPool, HafQueryError, isRetriableHafError } from '../db.js';
import { broadcastJsonWithTimeout } from '../hive.js';
import { handleBroadcastError } from '../lib/broadcast-error.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import {
  parseMeta,
  isPevoAnyPaper,
  isPevoBridgePaper,
  parsePageLimit,
  parseSort,
  parseOrder,
  extractAbstract,
  extractAuthorizedContinuationAuthors,
  pevoString,
  pevoStringArray,
  type SortField,
} from '../helpers.js';
import { getAccreditedSet, getAllAccreditedAccounts, getAccreditedOrcidsByAccount, getAccreditedNamesByAccount, getAllEverAccreditedOrcidsWithStatus } from '../accreditation.js';
import type { AccreditationStatus } from '../accreditation.js';
import { getReputationScore, getReputationScores } from '../reputation.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { validatedCid } from '../lib/ipfs-validation.js';
import {
  normalizeHiveAccount,
  computeSupersession,
  resolveAuthorName,
  applyAuthorSupersession,
  trimAsciiCWhitespace,
} from '../lib/author-supersession.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { rateLimit, byAccount } from '../middleware/rateLimit.js';
import { HIVE_ACCOUNT_NAME_REGEX } from '../lib/hive-account-name.js';
import { HIVE_PERMLINK_FORMAT_REGEX, HIVE_PERMLINK_MAX_LEN } from '../lib/hive-permlink.js';
import { LINE_TERMINATORS } from '../lib/line-terminators.js';
import { paperDisciplineField } from '../types/disciplines.js';
import type { PaperAuthor } from '../types/domain.js';
import {
  T,
  accreditedVoteCount,
  activeAccreditationsCteBody,
  authorshipClaimsCteBody,
  authorsWithSupersessionSelect,
  retractedPapersCteBody,
  buildWith,
  validPevoPaperWhere,
  validReviewWhere,
  excludeSelfReviewWhere,
  excludeClaimedSelfWhere,
} from '../hafsql.js';
import { validateDisciplineFilter } from '../types/disciplines.js';

const router = Router();

// ─── Vote strength tiers ────────────────────────────────────────
function voteStrengthTier(avgWeight: number): string {
  if (avgWeight > 6000) return 'strong_endorsement';
  if (avgWeight > 2500) return 'endorsement';
  if (avgWeight > 0) return 'mild_endorsement';
  if (avgWeight === 0) return 'neutral';
  if (avgWeight >= -2500) return 'mild_concerns';
  if (avgWeight >= -6000) return 'reject';
  return 'strong_reject';
}

interface ResolvedVotes {
  net_votes: number;
  vote_strength: string | null;
}

/**
 * Compute resolved vote counts for a set of papers using parallel native + revote queries.
 * Returns a Map keyed by "author/permlink" with net_votes and vote_strength.
 *
 * Exported so the cross-channel claimer self-vote exclusion (the `claimedSet`
 * skip that must hold across BOTH the native-vote and revote channels) can be
 * exercised directly against a controlled (native + revote + claims) rowset.
 */
export async function batchResolveVotes(
  pool: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  papers: Array<{ author: string; permlink: string }>,
  accreditedArr: string[],
): Promise<Map<string, ResolvedVotes>> {
  if (papers.length === 0) return new Map();

  // Build (author, permlink) pairs for the batch native vote query
  const pairValues: string[] = [];
  const pairParams: unknown[] = [];
  let pIdx = 1;
  for (const p of papers) {
    pairValues.push(`($${pIdx++}, $${pIdx++})`);
    pairParams.push(p.author, p.permlink);
  }
  const accreditedParam = `$${pIdx++}`;
  pairParams.push(accreditedArr);

  // Accepted authorship-claim claimers must not have their self-vote on the paper
  // they are credited for counted toward the displayed net_votes — mirrors the
  // reputation cycle's accepted_claims gate and excludeClaimedSelfWhere on the
  // review surfaces. Claims are low-cardinality, so fetch them unscoped and skip
  // the matching (paper, voter) pairs in the merge loop below.
  const claimsCte = buildWith(1, activeAccreditationsCteBody, (idx) => authorshipClaimsCteBody(idx));

  const [nativeResult, revoteResult, claimsResult] = await Promise.all([
    // Batch native votes: latest per voter per paper, accredited only, excluding self-votes
    pool.query(
      `SELECT DISTINCT ON (v.author, v.permlink, v.voter)
              v.author, v.permlink, v.voter, v.weight, v.block_num
       FROM ${T.voteOps} v
       WHERE (v.author, v.permlink) IN (${pairValues.join(', ')})
         AND v.voter = ANY(${accreditedParam}::text[])
         AND v.voter != v.author
       -- Same-block tie-breaker: v.id (operation_vote_view has no trx_in_block;
       -- v.id is the monotonic HAF op id) per
       -- agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md Rule 2
       ORDER BY v.author, v.permlink, v.voter, v.block_num DESC, v.id DESC`,
      pairParams,
    ),
    // All revotes for APP_TAG. The `block_num >= $genesis` floor was dropped
    // (matching the 285e7c14 fix on `activeAccreditationsCteBody`): combining
    // `custom_id = $appTag` with `block_num >= $genesis` triggers a BitmapAnd
    // plan that scans tens of millions of operation rows on
    // `hive_operations_block_num_id_idx`. `custom_id` alone is selective enough
    // on Mahdi's HAF (the pevotest namespace has on the order of dozens of
    // revote rows); pre-genesis pevotest custom_jsons do not exist by
    // construction, so the floor was redundant and plan-toxic.
    pool.query(
      `SELECT cj.json::jsonb ->> 'author' AS author,
              cj.json::jsonb ->> 'permlink' AS permlink,
              cj.required_posting_auths ->> 0 AS voter,
              -- {1,9} bounds the digit count for overflow safety: an unbounded match admits a value that overflows ::int and aborts the whole query (max Hive vote weight is 10000).
              CASE WHEN (cj.json::jsonb ->> 'weight') ~ '^-?[0-9]{1,9}$' THEN (cj.json::jsonb ->> 'weight')::int END AS weight,
              cj.block_num
       FROM ${T.customJson} cj
       WHERE cj.custom_id = $1
         AND cj.json::jsonb ->> 'action' = 'revote'`,
      [config.appTag],
    ),
    // Accepted authorship claims (credited claimers per chain post).
    pool.query(
      `${claimsCte.sql} SELECT claimer, paper_author, paper_permlink FROM authorship_claims WHERE status = 'accepted'`,
      claimsCte.params,
    ),
  ]);

  // (paper_author/paper_permlink::claimer) keys whose self-vote is dropped.
  const claimedSet = new Set<string>();
  for (const r of claimsResult.rows) {
    claimedSet.add(`${r.paper_author}/${r.paper_permlink}::${r.claimer}`);
  }

  // Index native votes: paper_key -> voter -> { weight, block_num }
  const accreditedSet = new Set(accreditedArr);
  type VoteSignal = { weight: number; block_num: number };
  const nativeByPaper = new Map<string, Map<string, VoteSignal>>();
  for (const r of nativeResult.rows) {
    const key = `${r.author}/${r.permlink}`;
    if (!nativeByPaper.has(key)) nativeByPaper.set(key, new Map());
    nativeByPaper.get(key)!.set(r.voter as string, {
      weight: Number(r.weight),
      block_num: Number(r.block_num),
    });
  }

  // Index revotes: paper_key -> voter -> { weight, block_num } (latest per voter per paper)
  const revoteByPaper = new Map<string, Map<string, VoteSignal>>();
  // Revote rows are not ordered, so we track latest block_num manually
  for (const r of revoteResult.rows) {
    const voter = r.voter as string;
    const weight = Number(r.weight);
    if (!voter || isNaN(weight) || weight < -10000 || weight > 10000) continue;
    const rAuthor = r.author as string;
    if (!rAuthor || !accreditedSet.has(voter) || voter === rAuthor) continue;
    const key = `${rAuthor}/${r.permlink}`;
    if (!revoteByPaper.has(key)) revoteByPaper.set(key, new Map());
    const existing = revoteByPaper.get(key)!.get(voter);
    const blockNum = Number(r.block_num);
    if (!existing || blockNum > existing.block_num) {
      revoteByPaper.get(key)!.set(voter, { weight, block_num: blockNum });
    }
  }

  // Merge: for each paper, resolve votes
  const results = new Map<string, ResolvedVotes>();
  for (const p of papers) {
    const key = `${p.author}/${p.permlink}`;
    const nativeVotes = nativeByPaper.get(key) || new Map<string, VoteSignal>();
    const revotes = revoteByPaper.get(key) || new Map<string, VoteSignal>();

    // Collect all voters across both sources
    const allVoters = new Set([...nativeVotes.keys(), ...revotes.keys()]);
    let upvotes = 0;
    let downvotes = 0;
    let weightSum = 0;
    let voterCount = 0;

    for (const voter of allVoters) {
      // Drop a credited claimer's self-vote on the paper they are credited for.
      if (claimedSet.has(`${key}::${voter}`)) continue;
      const native = nativeVotes.get(voter);
      const revote = revotes.get(voter);

      let effectiveWeight: number;
      if (native && revote) {
        effectiveWeight = revote.block_num > native.block_num ? revote.weight : native.weight;
      } else if (revote) {
        effectiveWeight = revote.weight;
      } else {
        effectiveWeight = native!.weight;
      }

      if (effectiveWeight === 0) continue; // retracted
      if (effectiveWeight > 0) upvotes++;
      else downvotes++;
      weightSum += effectiveWeight;
      voterCount++;
    }

    const net_votes = upvotes - downvotes;
    const vote_strength = voterCount > 0 ? voteStrengthTier(weightSum / voterCount) : null;
    results.set(key, { net_votes, vote_strength });
  }

  return results;
}

/** Safely extract the pevo metadata sub-object with runtime validation. */
function safePevoMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const pevo = meta[config.appTag];
  if (pevo != null && typeof pevo === 'object' && !Array.isArray(pevo)) {
    return pevo as Record<string, unknown>;
  }
  return {};
}

/**
 * Emit an `orcid_claim_mismatch` audit warn event with the shared payload
 * skeleton + per-(rootAuthor, rootPermlink, hive) dedup discipline.
 *
 * Three call sites inside `buildCumulativeAuthorsForChain` previously
 * inlined this skeleton (active-arm case b override + audit, active-arm
 * case d suppress + audit, revoked-arm pass-through + audit). They share:
 *   - same event name (`orcid_claim_mismatch`)
 *   - same payload shape (rootAuthor / rootPermlink / hive / claimedOrcid /
 *     accreditedOrcid / accreditationStatus / claimSource)
 *   - same dedup-key construction (`${rootAuthor}/${rootPermlink}/${hive}`)
 *
 * The arms differ only in `accreditationStatus` literal, `accreditedOrcid`
 * source, and the human-readable log message. The helper consolidates
 * emission + dedup only; the surrounding decision-tree branching (override
 * vs suppress vs pass-through) stays inline at each call site so the audit
 * primitive does not couple to display-mutation policy.
 *
 * @param args - the audit payload fields.
 * @param auditedKeys - request-scoped dedup set; the helper consults it
 *   before emitting and updates it after.
 */
function emitOrcidClaimMismatchAudit(
  args: {
    status: AccreditationStatus;
    accreditedOrcid: string | null;
    claimedOrcid: string | null;
    hive: string;
    rootAuthor: string;
    rootPermlink: string;
    claimSource: string;
    message: string;
  },
  auditedKeys: Set<string>,
): void {
  const auditKey = `${args.rootAuthor}/${args.rootPermlink}/${args.hive}`;
  if (auditedKeys.has(auditKey)) return;
  auditedKeys.add(auditKey);
  logger.warn(
    {
      event: 'orcid_claim_mismatch',
      rootAuthor: args.rootAuthor,
      rootPermlink: args.rootPermlink,
      hive: args.hive,
      claimedOrcid: args.claimedOrcid,
      accreditedOrcid: args.accreditedOrcid,
      accreditationStatus: args.status,
      claimSource: args.claimSource,
    },
    args.message,
  );
}

/**
 * Composite dedup key for a Hive-less author entry: normalized `orcid` when
 * present, else normalized `name`. Returns null when the entry carries
 * neither (it names no one and is skipped). The `orcid:`/`name:` prefix
 * keeps the two sub-tracks distinct AND namespaces the key away from the
 * Hive-keyed track's `hive:<account>` first-occurrence key. Normalization is
 * JS-local — this dedup lives entirely inside the cumulative union and never
 * crosses to SQL, so trim + lowercase suffices for display-credit dedup,
 * where over/under-merge is an accepted cosmetic outcome.
 */
function hivelessCompositeKey(entry: Record<string, unknown>): string | null {
  const orcid = typeof entry.orcid === 'string' ? entry.orcid.trim().toLowerCase() : '';
  if (orcid.length > 0) return `orcid:${orcid}`;
  const name = typeof entry.name === 'string' ? entry.name.trim().toLowerCase() : '';
  if (name.length > 0) return `name:${name}`;
  return null;
}

/**
 * Build the cumulative-union authors[] for a multi-link continuation chain
 * per `agents/docs/ARCHITECTURE.md § 2 "Multi-Author Trust Model"`. The
 * displayed `authors[]` unions author entries across all chain posts on
 * TWO separate, never-merging tracks:
 *
 *   - **Hive-keyed track.** Entries with a normalizable `hive` dedup on the
 *     lowercased/trimmed hive. Per-hive sub-fields (`name`, `orcid`,
 *     `affiliation`) resolve to the most-recent self-claim (a chain post
 *     whose `chain-author === hive` claiming itself) or, absent a
 *     self-claim, the most-recent claim across the chain. ORCID is
 *     server-overridden for accredited hives whose claimed ORCID disagrees
 *     with the on-chain accredited ORCID; mismatch emits a structured
 *     `orcid_claim_mismatch` audit warn for post-incident triage.
 *
 *   - **Hive-less track.** Entries with no normalizable `hive` (a co-author
 *     who has no Hive account — a display-only credit; they can never sign
 *     a continuation, so they only ever appear in some broadcaster's
 *     `authors[]`). They are CARRIED, not dropped, deduped on a composite
 *     key (normalized `orcid` when present, else normalized `name`). This
 *     upholds the "authors can't be dropped" invariant from the Hive-less
 *     side: a multi-link paper whose head broadcaster omitted a Hive-less
 *     co-author still surfaces that credit.
 *
 * The two tracks NEVER merge. Auto-linking a display-only credit to a Hive
 * account by matching name or ORCID is forbidden by the trust model
 * (`ARCHITECTURE.md` § 2 "Bridge papers"); the explicit bridge-author-claim
 * attestation flow is the only path that links a Hive-less credit to a Hive
 * identity. The same human appearing once with a handle and once without
 * may double-list until that attestation lands — accepted. Over-merge (two
 * people sharing a normalized name) and under-merge are accepted cosmetic
 * outcomes on informational-only credits.
 *
 * Drops are forbidden by construction: both track maps only grow, so a
 * later chain post cannot remove an entry an earlier post added.
 *
 * Name resolution: every output entry's `name` is resolved via
 * `resolveAuthorName` — name-supersession (an accredited author's attested
 * name supersedes the broadcaster claim, silently) plus the read-time
 * fallback chain (attested → broadcaster → hive handle → orcid). `name` is
 * therefore total across the output, which is what makes the exit-boundary
 * guard sound on `name`.
 *
 * Ordering: both tracks share one first-occurrence counter, so Hive-keyed
 * and Hive-less entries interleave in displayed order by first appearance
 * across the chain.
 *
 * @param chainPosts - chain links with their latest reconstructed pevo
 *   metadata, in chain order (root first, head last).
 * @param rootAuthor / rootPermlink - the canonical paper coordinates,
 *   used as audit-event payload anchors.
 * @param accreditedAccounts - membership set of accredited Hive accounts
 *   (loaded once per request via `getAllAccreditedAccounts`).
 * @param accreditedOrcids - per-accredited-account ORCID map (loaded once
 *   per request via `getAccreditedOrcidsByAccount`); `null` value means
 *   the account is accredited but the on-chain attestation does not
 *   carry an ORCID — pass-through is the policy in that case.
 * @param accreditationOrcidStatus - per-ever-accredited-account
 *   `{orcid, status}` map (loaded once per request via
 *   `getAllEverAccreditedOrcidsWithStatus`); union of active + revoked.
 *   Drives the `accreditationStatus` field on the audit-event payload and
 *   the revoked-arm pass-through behavior. See the in-function comment
 *   under "ORCID server-override + audit emission" for the active vs
 *   revoked split.
 * @param accreditedNames - per-currently-accredited-account attested-name
 *   map (loaded once per request via `getAccreditedNamesByAccount`); drives
 *   silent name-supersession. Only currently-accredited accounts appear.
 */
function buildCumulativeAuthorsForChain(
  chainPosts: Array<{ author: string; permlink: string; pevo: Record<string, unknown> }>,
  rootAuthor: string,
  rootPermlink: string,
  accreditedAccounts: Set<string>,
  accreditedOrcids: Map<string, string | null>,
  accreditationOrcidStatus: Map<string, { orcid: string | null; status: AccreditationStatus }>,
  accreditedNames: Map<string, string>,
): PaperAuthor[] {
  // Per-(rootAuthor, rootPermlink, hive) dedup set for the
  // `orcid_claim_mismatch` audit emission. The cumulative-union loop iterates
  // chain posts and resolves one winning entry per hive; the audit only
  // needs to fire once per (paper, hive) combination regardless of how
  // many chain posts contributed a spoofed claim. Per architect ratification
  // 2026-05-16 (`backend-orcid-claim-mismatch-post-revocation-audit.md`):
  // dedup by (rootAuthor, rootPermlink, hive); future volume data drives
  // any further gating (e.g., per-hive-per-cycle rate limit, persistent
  // store). The Set is request-scoped — no cross-request leakage.
  const auditedKeys = new Set<string>();
  // Per-hive winning claim: latest self-claim wins (most-recent self-claim
  // by the hive's own continuation post about itself); else latest claim
  // across the chain wins (the most-recent broadcaster's claim about that
  // hive). `isSelf` tracks whether the winning claim is a self-claim so
  // a later non-self claim does not overwrite an earlier self-claim.
  const winning = new Map<string, {
    entry: Record<string, unknown>;
    sourceAuthor: string;
    sourcePermlink: string;
    isSelf: boolean;
  }>();
  // Hive-less track: display-only co-author credits with no normalizable
  // Hive account, deduped on a composite key (normalized orcid when present,
  // else normalized name) so a multi-link paper does not structurally drop
  // them. Most-recent occurrence wins the entry content — these are
  // informational credits with no self-claim authority, so over/under-merge
  // is accepted per the trust model. Kept strictly separate from `winning`:
  // the two tracks never merge (no auto-linking a Hive-less credit to a Hive
  // identity by name/ORCID).
  const winningHiveless = new Map<string, Record<string, unknown>>();
  // First-occurrence index, shared across BOTH tracks so Hive-keyed and
  // Hive-less entries interleave in displayed order by first appearance.
  // Keys are namespaced (`hive:<account>` for the Hive-keyed track, the
  // `orcid:`/`name:`-prefixed composite key for the Hive-less track) so a
  // hive value and a composite key cannot collide on one order slot.
  const firstOccurrence = new Map<string, number>();
  let occurrenceCounter = 0;

  for (const post of chainPosts) {
    const authorsArr = Array.isArray(post.pevo.authors) ? post.pevo.authors : [];
    for (const e of authorsArr) {
      if (!e || typeof e !== 'object') continue;
      const entry = e as Record<string, unknown>;
      const hive = normalizeHiveAccount(entry.hive);

      if (hive === null) {
        // Hive-less co-author: carry via the composite-key track. An entry
        // with neither a normalizable orcid nor a name names no one and is
        // skipped (it would also fail the name-based exit guard below).
        const compositeKey = hivelessCompositeKey(entry);
        if (compositeKey === null) continue;
        if (!firstOccurrence.has(compositeKey)) {
          firstOccurrence.set(compositeKey, occurrenceCounter++);
        }
        winningHiveless.set(compositeKey, entry);
        continue;
      }

      const orderKey = `hive:${hive}`;
      if (!firstOccurrence.has(orderKey)) {
        firstOccurrence.set(orderKey, occurrenceCounter++);
      }

      const isSelfClaim = post.author === hive;
      const existing = winning.get(hive);

      if (!existing) {
        winning.set(hive, {
          entry,
          sourceAuthor: post.author,
          sourcePermlink: post.permlink,
          isSelf: isSelfClaim,
        });
      } else if (isSelfClaim) {
        // Most-recent self-claim wins.
        winning.set(hive, {
          entry,
          sourceAuthor: post.author,
          sourcePermlink: post.permlink,
          isSelf: true,
        });
      } else if (!existing.isSelf) {
        // No self-claim seen yet; take the most-recent fallback claim.
        winning.set(hive, {
          entry,
          sourceAuthor: post.author,
          sourcePermlink: post.permlink,
          isSelf: false,
        });
      }
      // else: existing winner is a self-claim; current is non-self — keep
      // the self-claim (it outranks any non-self claim regardless of
      // recency).
    }
  }

  // Project one Hive-keyed winning entry: ORCID server-override + audit,
  // supersession fields, name-supersession + fallback, enumerated output.
  const projectHiveAuthor = (hive: string): Record<string, unknown> => {
    const w = winning.get(hive)!;
    // Clone the winning entry so we can override sub-fields (ORCID) without
    // mutating the source `pevo.authors[]` array.
    const out: Record<string, unknown> = { ...w.entry };
    // Normalize the displayed `hive` to the lowercased canonical form.
    out.hive = hive;

    // ORCID server-override (rule #3). For accredited hives, the on-chain
    // accreditation attestation is the authoritative ORCID; broadcaster
    // claims about an accredited account's ORCID are at most a second-best
    // signal. Mismatch emits an audit event so accreditation-revocation
    // triage can correlate spoof attempts; missing-claim prefills from
    // accreditation; matching claim passes through.
    // Capture the chain-claimed ORCID BEFORE the existing server-override
    // mutates `out.orcid`. The supersession fields (`orcid_verified`,
    // `orcid_discrepancy`) per `hive-schemas.md` § 1.1 compare attestation
    // against the chain-claimed value; if we sampled `out.orcid` after the
    // override, the discrepancy signal would always be false on
    // overridden chain papers (a known constraint of running both layers
    // simultaneously, called out in the task body).
    const preOverrideChainOrcid = typeof out.orcid === 'string' && (out.orcid as string).length > 0
      ? (out.orcid as string)
      : null;

    // ORCID server-override + audit emission. Two distinct branches:
    //
    //  1. ACTIVE accreditation (rule #3 of cumulative-union): the on-chain
    //     accreditation attestation is the authoritative ORCID; mismatch
    //     fires `orcid_claim_mismatch` audit AND server-overrides the
    //     displayed ORCID. Prefill applies when the broadcaster's claim is
    //     absent. Match passes through unchanged.
    //
    //  2. REVOKED accreditation
    //     (`backend-orcid-claim-mismatch-post-revocation-audit.md`):
    //     the operator has retired this account's accreditation. The
    //     account no longer has authoritative ORCID standing, so the
    //     server does NOT override the broadcaster's claim. BUT the audit
    //     fires anyway when the broadcaster's claim disagrees with the
    //     last-attested ORCID, carrying `accreditationStatus: 'revoked'`
    //     so operators can distinguish active-spoof from post-revocation
    //     residual during triage.
    //
    // The `accreditationOrcidStatus` map carries both active and revoked
    // entries; `accreditedAccounts` (membership set) still only carries
    // active. Branch selection: `accreditedAccounts.has(hive)` for the
    // active arm; `accreditationOrcidStatus.get(hive)?.status === 'revoked'`
    // for the revoked arm.
    //
    // Normalize the chain claim for comparison via `trimAsciiCWhitespace`
    // so the audit-emit + override path stays in lockstep with the SQL
    // supersession projection (`authorsWithSupersessionSelect` BTRIM with
    // `CHAIN_ORCID_BTRIM_CHARSET`) and the JS supersession helper
    // (`computeSupersession`'s `chainOrcid.trim()`). Without the strip,
    // `{orcid: '\t<attested>'}` would emit `orcid_claim_mismatch` here
    // while `orcid_discrepancy=false` on the same response — three
    // cross-site interpretations of the same payload. The raw value
    // still goes into the audit event's `claimedOrcid` field for
    // forensic visibility; only the equality compare consults the
    // normalized form.
    const claimedOrcid = preOverrideChainOrcid;
    const claimedOrcidNormalized = claimedOrcid !== null ? trimAsciiCWhitespace(claimedOrcid) : null;
    // After trim, all-whitespace claims collapse to ''; treat as
    // "no claim" to mirror `computeSupersession`'s `length > 0` guard
    // and the SQL NULLIF.
    const claimedOrcidForCompare = claimedOrcidNormalized && claimedOrcidNormalized.length > 0
      ? claimedOrcidNormalized
      : null;
    const statusEntry = accreditationOrcidStatus.get(hive);

    if (accreditedAccounts.has(hive)) {
      const accreditedOrcid = accreditedOrcids.get(hive) ?? null;
      // Five branches of the "accredited ORCID is authoritative" rule
      // (see agents/docs/ARCHITECTURE.md § 2 "Multi-Author Trust Model"):
      //   (a) accreditedOrcid set, claim matches    → pass through
      //   (b) accreditedOrcid set, claim mismatches → override + audit
      //   (c) accreditedOrcid set, no claim         → prefill from accreditation
      //   (d) accreditedOrcid null, claim present   → suppress + audit
      //       (the accredited user opted not to share ORCID; a broadcaster
      //       claim must not surface as authoritative — the accredited
      //       user's silence IS the authority)
      //   (e) accreditedOrcid null, no claim        → no-op
      if (accreditedOrcid) {
        if (claimedOrcidForCompare && claimedOrcidForCompare !== accreditedOrcid) {
          // Case (b): broadcaster's claim disagrees with the on-chain
          // accredited ORCID. Audit emission consolidated via
          // `emitOrcidClaimMismatchAudit`; server-override stays inline.
          // Audit event carries the raw `claimedOrcid` so operators see
          // the as-broadcast value; comparison uses the normalized form
          // for SQL/JS supersession parity.
          emitOrcidClaimMismatchAudit(
            {
              status: 'active',
              accreditedOrcid,
              claimedOrcid,
              hive,
              rootAuthor,
              rootPermlink,
              claimSource: `${w.sourceAuthor}/${w.sourcePermlink}`,
              message: 'broadcaster-claimed ORCID for accredited hive differs from accredited ORCID; server-overriding',
            },
            auditedKeys,
          );
          out.orcid = accreditedOrcid;
        } else if (!claimedOrcidForCompare) {
          // Prefill: accredited carries an ORCID, the chain-claim is
          // absent or whitespace-only.
          out.orcid = accreditedOrcid;
        }
        // else: claimedOrcidForCompare === accreditedOrcid — pass through unchanged.
      } else if (claimedOrcidForCompare) {
        // Case (d): accredited target with no on-chain ORCID + broadcaster
        // claim present. Suppress the claim (set to null) and emit audit
        // event so operators see the spoof attempt. Categorically an
        // active-arm spoof — payload MUST carry `accreditationStatus: 'active'`
        // and MUST consult the same `auditedKeys` dedup set as case (b);
        // otherwise dashboards filtering by `accreditationStatus === 'active'`
        // silently miss case-d spoofs.
        emitOrcidClaimMismatchAudit(
          {
            status: 'active',
            accreditedOrcid: null,
            claimedOrcid,
            hive,
            rootAuthor,
            rootPermlink,
            claimSource: `${w.sourceAuthor}/${w.sourcePermlink}`,
            message: 'broadcaster-claimed ORCID for accredited hive that has no on-chain ORCID; suppressing claim',
          },
          auditedKeys,
        );
        out.orcid = null;
      }
      // else (e): accredited but accreditation attestation has no on-chain
      // ORCID AND no broadcaster claim — pass through unchanged (null).
    } else if (statusEntry && statusEntry.status === 'revoked') {
      // Post-revocation residual: account was once accredited, now revoked.
      // The last-attested ORCID (from the most-recent prior `accredit`) is
      // the comparison anchor. Server does NOT override (the revoked
      // actor has no authoritative ORCID standing anymore); the audit
      // fires on mismatch for triage visibility.
      const lastAttestedOrcid = statusEntry.orcid;
      if (lastAttestedOrcid && claimedOrcidForCompare && claimedOrcidForCompare !== lastAttestedOrcid) {
        emitOrcidClaimMismatchAudit(
          {
            status: 'revoked',
            accreditedOrcid: lastAttestedOrcid,
            claimedOrcid,
            hive,
            rootAuthor,
            rootPermlink,
            claimSource: `${w.sourceAuthor}/${w.sourcePermlink}`,
            message: 'broadcaster-claimed ORCID for revoked-but-previously-accredited hive differs from last-attested ORCID; passing through (no override)',
          },
          auditedKeys,
        );
      }
      // No override: broadcaster's claim passes through unchanged. Other
      // missing/match cases are silent (no audit signal worth firing).
    }

    // Supersession fields (BACKEND-PAPERS-CANONICAL-ORCID-RESOLUTION). The
    // attested ORCID and discrepancy signal must be computed against the
    // PRE-override chain claim so consumers can see when the publisher's
    // broadcast value diverged from the eventual attestation — even on
    // chain papers where `out.orcid` has been server-overridden.
    const supersession = computeSupersession(hive, preOverrideChainOrcid, accreditedOrcids);
    out.orcid_verified = supersession.orcid_verified;
    out.orcid_discrepancy = supersession.orcid_discrepancy;

    // Name-supersession + fallback. The attested name (if `hive` is currently
    // accredited with a non-empty attested name) supersedes the broadcaster
    // claim silently — no discrepancy field, no audit (name variation is
    // benign, unlike an ORCID mismatch). Otherwise the fallback chain
    // (broadcaster name → hive handle → orcid) keeps `name` populated. The
    // hive handle always satisfies arm 3 for a Hive-keyed entry, so `name`
    // is total here. Mirrors the SQL `name` COALESCE in
    // `authorsWithSupersessionSelect`.
    const resolvedName = resolveAuthorName(hive, out.name, out.orcid, accreditedNames);

    // Enumerated projection to exactly PaperSummary's contract fields plus
    // `affiliation`. The detail surface legitimately renders `affiliation`;
    // the listing/profile consumers strip it. Dropping every other key a
    // broadcaster may inject into `pevo.authors[i]` (email, url, arbitrary
    // metadata) keeps multi-link `authors[]` shape-identical to the
    // single-link SQL/JS projection, which only ever emits the enumerated
    // set. Without it the same endpoint returns wider author objects on
    // multi-link papers and the extra keys survive into the per-root cache.
    const projected: Record<string, unknown> = {
      name: resolvedName,
      hive: out.hive,
      orcid: out.orcid,
      orcid_verified: out.orcid_verified,
      orcid_discrepancy: out.orcid_discrepancy,
    };
    if (out.affiliation !== undefined) projected.affiliation = out.affiliation;
    return projected;
  };

  // Project one Hive-less display-only credit. No Hive account means no
  // ORCID server-override, no audit, and no name-supersession (all gated on
  // a Hive account); `computeSupersession(null, …)` yields the
  // no-attestation defaults. The emitted shape mirrors the Hive-keyed
  // enumerated set so multi-link `authors[]` stays shape-identical to the
  // single-link SQL/JS projection (which carries Hive-less entries with a
  // null `hive`). The chain `hive`/`orcid` values pass through raw (or
  // undefined when absent), matching the SQL projection's raw passthrough.
  const projectHivelessAuthor = (entry: Record<string, unknown>): Record<string, unknown> => {
    const chainOrcid = typeof entry.orcid === 'string' ? entry.orcid : null;
    const supersession = computeSupersession(null, chainOrcid, accreditedOrcids);
    const projected: Record<string, unknown> = {
      name: resolveAuthorName(
        typeof entry.hive === 'string' ? entry.hive : null,
        entry.name,
        entry.orcid,
        accreditedNames,
      ),
      hive: typeof entry.hive === 'string' ? entry.hive : undefined,
      orcid: typeof entry.orcid === 'string' ? entry.orcid : undefined,
      orcid_verified: supersession.orcid_verified,
      orcid_discrepancy: supersession.orcid_discrepancy,
    };
    if (entry.affiliation !== undefined) projected.affiliation = entry.affiliation;
    return projected;
  };

  // Emit both tracks interleaved by shared first-occurrence order.
  const slots: Array<{ order: number; project: () => Record<string, unknown> }> = [];
  for (const hive of winning.keys()) {
    slots.push({ order: firstOccurrence.get(`hive:${hive}`) ?? 0, project: () => projectHiveAuthor(hive) });
  }
  for (const [compositeKey, entry] of winningHiveless) {
    slots.push({ order: firstOccurrence.get(compositeKey) ?? 0, project: () => projectHivelessAuthor(entry) });
  }
  slots.sort((a, b) => a.order - b.order);

  return slots
    .map((s) => s.project())
    // Sound name-based exit guard (not an `as` cast). `name` is now total
    // across both tracks via `resolveAuthorName`'s fallback chain — a
    // Hive-keyed entry always resolves at least its hive handle, and a
    // Hive-less entry resolves its broadcaster name / orcid. Only a
    // fully-empty entry (no name, hive, or orcid) yields no `name`, and such
    // an entry names no one and is correctly dropped. The intersection
    // predicate keeps the result assignable to the map output's
    // `Record<string, unknown>` element type while narrowing to PaperAuthor[].
    .filter((a): a is Record<string, unknown> & PaperAuthor => typeof a.name === 'string');
}

/**
 * Shared `{ authors, accredited_authors }` projection used by the detail,
 * listing, and profile surfaces. `authors` is the cumulative-union output
 * of `buildCumulativeAuthorsForChain`; `accredited_authors` is the
 * intersection of `authors[].hive` with the current `accreditedAccounts`
 * set. Cached as a single value so a Redis hit serves the whole enrichment.
 */
export interface ChainCumulativeAuthorsResult {
  authors: PaperAuthor[];
  accredited_authors: string[];
}

interface ResolveChainCumulativeAuthorsOptions {
  accreditedAccounts: Set<string>;
  accreditedOrcids: Map<string, string | null>;
  accreditationOrcidStatus: Map<string, { orcid: string | null; status: AccreditationStatus }>;
  accreditedNames: Map<string, string>;
  /**
   * Pre-built chain posts (with per-link latest pevo metadata) if the caller
   * has already done the work. The detail surface passes this to avoid the
   * `resolveContinuationChain` + `reconstructVersionsFromHaf` round-trip;
   * listing and profile pass only the root pair and let the helper resolve
   * internally.
   */
  prebuiltChainPosts?: Array<{ author: string; permlink: string; pevo: Record<string, unknown> }>;
  memo?: HeadAuthorsMemo;
  signal?: AbortSignal;
}

/**
 * Cache TTL for the per-root cumulative-authors entry. Aligned with the
 * documented ORCID supersession staleness window on `PaperSummary`
 * (`api-contracts/papers.md`): an accreditation revocation or new claim
 * propagates to listing/profile within this window. The detail surface
 * computes live and writes-through to this cache, so any detail hit on a
 * paper effectively re-warms the listing entry for free.
 */
const CHAIN_CUMULATIVE_AUTHORS_TTL_MS = 1_800_000;

/**
 * Resolve the cumulative-union `{ authors, accredited_authors }` for a
 * continuation chain rooted at `(rootAuthor, rootPermlink)`. The cumulative
 * union is per `agents/docs/ARCHITECTURE.md § 2 "Multi-Author Trust Model"`:
 * `authors[]` is the union of `pevo.authors[].hive` across all chain posts
 * (drops are forbidden by construction), and `accredited_authors[]` is the
 * intersection of that union with the currently-accredited account set.
 *
 * Surfaces:
 *   - Detail: passes `prebuiltChainPosts` to share the already-resolved
 *     chain + per-link metadata. The helper short-circuits the HAF round-
 *     trip and writes-through to the per-root Redis cache so listing/profile
 *     hits stay warm.
 *   - Listing / profile: pass only the root pair. The helper checks the
 *     per-root Redis cache, then on miss walks the chain via
 *     `resolveContinuationChain` (+ `reconstructVersionsFromHaf` for
 *     `chain.length > 1` so the carry-forward `lastGoodMeta` semantics
 *     match the detail surface exactly), builds the cumulative union, and
 *     caches the pair under
 *     `${appTag}:cache:chain-authors:<root-author>:<root-permlink>`.
 *
 * Returns `null` when HAF is unreachable or the chain cannot be resolved;
 * callers fall back to the head-metadata projection they already had.
 */
export async function resolveChainCumulativeAuthors(
  rootAuthor: string,
  rootPermlink: string,
  options: ResolveChainCumulativeAuthorsOptions,
): Promise<ChainCumulativeAuthorsResult | null> {
  const cacheKey = `chain-authors:${rootAuthor}:${rootPermlink}`;

  if (options.prebuiltChainPosts && options.prebuiltChainPosts.length > 0) {
    // Single-link short-circuit on the prebuilt path, symmetric with the HAF
    // path's `chain.length === 1` guard: a single-link paper has no
    // cross-link union to compute, so its own supersession projection (SQL
    // `authorsWithSupersessionSelect` for listing/detail, JS
    // `applyAuthorSupersession` for profile) is authoritative — it already
    // carries every author entry (Hive-keyed AND Hive-less) with
    // name-supersession + fallback applied. Returning null lets the caller
    // use that projection directly. This also avoids a needless cached/live
    // shape divergence: the cumulative union normalizes the displayed `hive`
    // and emits an absent hive as `undefined`, whereas the head-meta
    // projection passes `hive` through raw (SQL emits `null`). Without the
    // guard the prebuilt path would cache the normalized shape and a later
    // listing/profile call would serve it instead of the head-meta shape.
    if (options.prebuiltChainPosts.length === 1) return null;
    // Route through getOrSet so the epoch guard suppresses the cache write
    // when /invalidate fires between fetcher-start and resolve. Single-flight
    // coalescing is a free side-effect: two concurrent same-key callers
    // (typical for detail-surface write-through racing a listing cold-path)
    // converge on one fetcher invocation.
    return hafCache.getOrSet(
      cacheKey,
      async () => buildChainCumulativeFromPosts(
        options.prebuiltChainPosts!,
        rootAuthor,
        rootPermlink,
        options,
      ),
      CHAIN_CUMULATIVE_AUTHORS_TTL_MS,
    );
  }

  return hafCache.getOrSet(
    cacheKey,
    async () => computeChainCumulativeFromHaf(rootAuthor, rootPermlink, options),
    CHAIN_CUMULATIVE_AUTHORS_TTL_MS,
  );
}

function buildChainCumulativeFromPosts(
  chainPosts: Array<{ author: string; permlink: string; pevo: Record<string, unknown> }>,
  rootAuthor: string,
  rootPermlink: string,
  options: ResolveChainCumulativeAuthorsOptions,
): ChainCumulativeAuthorsResult {
  const authors = buildCumulativeAuthorsForChain(
    chainPosts,
    rootAuthor,
    rootPermlink,
    options.accreditedAccounts,
    options.accreditedOrcids,
    options.accreditationOrcidStatus,
    options.accreditedNames,
  );
  // `accredited_authors` is the Hive-keyed intersection only — Hive-less
  // entries have no account to be accredited (their `hive` does not
  // normalize), so they never enter this set.
  const accredited = authors
    .map((a) => normalizeHiveAccount(a.hive))
    .filter((hive): hive is string => hive !== null && options.accreditedAccounts.has(hive));
  // `authors` is already `PaperAuthor[]`. `buildCumulativeAuthorsForChain`
  // enumerates each output entry to the contract fields and narrows with a
  // real type guard on `name` (total via the name-resolution fallback) at
  // its return boundary, so no cast is needed here and broadcaster-injected
  // keys cannot reach the consumers or the per-root cache.
  return { authors, accredited_authors: accredited };
}

async function computeChainCumulativeFromHaf(
  rootAuthor: string,
  rootPermlink: string,
  options: ResolveChainCumulativeAuthorsOptions,
): Promise<ChainCumulativeAuthorsResult | null> {
  const pool = getPool();
  if (!pool) return null;

  const { chain, degraded } = await resolveContinuationChain(rootAuthor, rootPermlink, options.memo, options.signal);
  if (chain.length === 0) return null;

  // A degraded (truncated) forward walk yields a partial chain whose
  // cumulative author-union is missing the truncated tail; caching that
  // partial union would serve an under-enriched authors[] for the full TTL.
  // Return null so the surrounding getOrSet skips the write and the caller
  // falls back to its head-meta projection, recomputing next request. This
  // subsumes the abort variant (previously covered only by the empty-versions
  // guard below) and closes the mid-walk non-abort truncation gap (swallowed
  // SQL error, cycle, depth cap) for chains longer than the root; the
  // chain.length === 1 short-circuit already covers root-only degraded walks
  // (e.g. an empty/failed root head-authors fetch).
  if (degraded) return null;

  // Single-link short-circuit: when the chain is just the root, there is no
  // cumulative work to do — the head metadata IS the only contribution. The
  // listing / profile / detail surfaces each have their own supersession-
  // aware projection of `pevo.authors[]` (SQL `authorsWithSupersessionSelect`
  // for listing+detail; JS `applyAuthorSupersession` for profile via
  // `toPaperSummary`) that already carries every author entry — Hive-keyed
  // and Hive-less (bridge-paper `hive: null` carriers included) — with
  // name-supersession + fallback applied, passing `hive`/`orcid` through raw.
  // Returning `null` here signals "no override needed" so callers keep that
  // projection (whose raw passthrough is the canonical single-link shape).
  // Multi-link papers go through the full cumulative path below, which now
  // carries Hive-less entries via the composite-key track.
  if (chain.length === 1) return null;

  // Multi-link: replay version history to pick up per-link latest metadata
  // with the `lastGoodMeta` carry-forward, matching the detail surface's
  // construction exactly. The chain is passed through to dedupe the
  // `resolveContinuationChain` query the version reconstructor would
  // otherwise re-issue.
  const fullVersions = await reconstructVersionsFromHaf(
    rootAuthor,
    rootPermlink,
    chain,
    options.memo,
    options.signal,
  );
  // Empty-versions guard. `reconstructVersionsFromHaf` swallows internal
  // failures and returns an empty array; without this guard, the
  // cumulative-union loop downstream would yield an empty authors array
  // and the surrounding `getOrSet` would treat that non-null value as
  // cacheable. A subsequent caller would then hit a warm cache returning
  // an empty authors[] for 30 min — even after HAF recovered. Returning
  // null here makes `getOrSet` skip the cache write and lets the caller
  // fall back to the head-meta projection.
  if (fullVersions.length === 0) return null;
  const latestMetaByLink = new Map<string, Record<string, unknown>>();
  for (const v of fullVersions) {
    latestMetaByLink.set(`${v.post_author}/${v.post_permlink}`, v.json_metadata);
  }
  const chainPosts = chain.map((link) => ({
    author: link.author,
    permlink: link.permlink,
    pevo: safePevoMeta(latestMetaByLink.get(`${link.author}/${link.permlink}`) ?? {}),
  }));

  return buildChainCumulativeFromPosts(chainPosts, rootAuthor, rootPermlink, options);
}

// skipFailedRequests: a HAF outage emits 503 with `details.retriable: true`
// and the SPA retries on it. Without `skipFailed`, each retry consumes one
// of the legitimate user's 5 slots/hour, and a single outage event burns
// the entire hour budget — when HAF recovers, the user is locked out of
// retract until the rolling-window head ages out. The middleware refunds
// the slot on every >= 400 response (4xx and 5xx). On /retract this is
// safe: the 422 "already retracted" and 404 "paper not found" paths only
// fire for a verified-signature request matching `username === URL author`,
// so the per-account refund is bounded by the attacker's own paper set
// (no unbounded probe surface). The 502 BROADCAST_FAILED and 504
// BROADCAST_TIMEOUT paths carry `verify_before_retry: true` so the SPA
// doesn't auto-retry on them.
const retractLimiter = rateLimit({
  name: 'paper-retract',
  windowMs: 3_600_000,
  max: 5,
  keyFn: byAccount,
  skipFailedRequests: true,
});

/** URL-param shape validator for POST /api/papers/:author/:permlink/retract.
 *  Mounted BEFORE both `verifyHiveSignature` and `retractLimiter` so a spray of
 *  structurally-invalid slugs is rejected without paying ECDSA recovery, the
 *  Postgres point-lookup on `accounts.sessions_invalidated_at`, or the HAF
 *  walker (`fetchPaperDetailFromHaf` runs the forward continuation-chain
 *  resolver, bounded by `hafWalkerWallClockMs`). The route is URL-keyed (the
 *  target is the slug pair, not the authenticated principal), so it differs
 *  from the body-shape validators on `/upgrade`, `/fresh-auth`, `/session-auth`
 *  where the limiter is `byAccount`-keyed and the validator must run AFTER
 *  `verifyHiveSignature` to attribute the error to an authenticated user.
 *  Permlinks are derived from post titles on Hive, so a slug outside the
 *  canonical character class cannot resolve to a real paper — rejecting
 *  up-front is safe. */
function validateRetractParams(req: Request, res: Response, next: NextFunction): void {
  const author = req.params.author;
  const permlink = req.params.permlink;
  if (typeof author !== 'string' || !HIVE_ACCOUNT_NAME_REGEX.test(author)) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Invalid author format');
    return;
  }
  if (
    typeof permlink !== 'string' ||
    permlink.length === 0 ||
    permlink.length > HIVE_PERMLINK_MAX_LEN ||
    !HIVE_PERMLINK_FORMAT_REGEX.test(permlink)
  ) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Invalid permlink format');
    return;
  }
  next();
}
// ──────────────────────────────────────────────
// HAF SQL implementation for paper listing
// ──────────────────────────────────────────────

async function fetchPapersFromHaf(
  req: Request,
  discipline: string | undefined,
): Promise<{ rows: unknown[]; total: number } | null> {
  const pool = getPool();
  if (!pool) return null;

  const { limit, offset } = parsePageLimit(req);
  const sort = parseSort(req);
  const order = parseOrder(req);
  // `discipline` is pre-validated + lowercased by the route handler. Bound
  // as-is into `LOWER(column) = $N`; the `if (discipline)` gate below
  // suppresses the WHERE clause when absent.
  const keyword = req.query.keyword as string | undefined;
  const author = req.query.author as string | undefined;
  const language = req.query.language as string | undefined;
  const includeRetracted = req.query.include_retracted === 'true'; // default false
  const source = req.query.source as string | undefined; // 'native', 'bridge', or omit for both

  // Build CTEs with parameterized appTag. authorship_claims (unscoped — claim
  // ops are low-cardinality) lets the review-agg LATERAL drop a credited
  // claimer's self-review from the displayed avg_rating / review_count, mirroring
  // the reputation cycle's accepted_claims gate. active_accreditations is listed
  // first because authorshipClaimsCteBody's ORCID auto-accept arm references it.
  const cte = buildWith(1, activeAccreditationsCteBody, retractedPapersCteBody, (idx) => authorshipClaimsCteBody(idx));
  let paramIdx = cte.nextIdx;
  const cteParams: unknown[] = [...cte.params];

  // appTag params for WHERE conditions
  const appTagParam = `$${paramIdx++}`;
  const appLikeParam = `$${paramIdx++}`;
  const bridgeAccountParam = `$${paramIdx++}`;
  cteParams.push(config.appTag, `${config.appTag}/%`, config.hiveBridgeAccount);

  const paperSource: 'native' | 'bridge' | 'all' =
    source === 'native' ? 'native' : source === 'bridge' ? 'bridge' : 'all';
  const typeFilter = validPevoPaperWhere({ commentAlias: 'c', appTagParam, bridgeAccountParam, source: paperSource });

  const conditions: string[] = [
    `c.parent_permlink = ${appTagParam}`,
    "c.parent_author = ''",
    typeFilter,
    `c.json_metadata ->> 'app' LIKE ${appLikeParam}`,
  ];
  const filterParams: unknown[] = [];

  if (discipline) {
    // LOWER() on both sides so case-variant on-chain values match.
    conditions.push(`LOWER(c.json_metadata -> ${appTagParam} ->> 'discipline') = $${paramIdx++}`);
    filterParams.push(discipline);
  }
  if (keyword) {
    conditions.push(`c.json_metadata -> ${appTagParam} -> 'keywords' ? $${paramIdx++}`);
    filterParams.push(keyword);
  }
  if (author) {
    conditions.push(`c.author = $${paramIdx++}`);
    filterParams.push(author);
  }
  if (language) {
    conditions.push(`(c.json_metadata -> ${appTagParam} ->> 'language') = $${paramIdx++}`);
    filterParams.push(language);
  }
  // Accreditation gate is unconditional. Bridge papers are posted by the
  // system bridge account, not the original author, so they are exempt from
  // the accredited-only filter — but ONLY when authored by
  // config.hiveBridgeAccount. The bridge arm of validPevoPaperWhere() pins
  // the author; we reuse it as the OR-arm here to share the predicate shape.
  // The legacy `?accredited_only=false` opt-out is silently ignored — Express
  // convention for unknown query params (api-contracts/common.md).
  const bridgeArm = validPevoPaperWhere({ commentAlias: 'c', appTagParam, bridgeAccountParam, source: 'bridge' });
  conditions.push(`(c.author IN (SELECT account FROM active_accreditations) OR ${bridgeArm})`);
  if (!includeRetracted) {
    conditions.push(`NOT EXISTS (SELECT 1 FROM retracted_papers rp WHERE rp.author = c.author AND rp.permlink = c.permlink)`);
  }
  // E3: Hide continuation posts — they are revisions of existing papers, not separate papers
  conditions.push(`(c.json_metadata -> ${appTagParam} -> 'continues') IS NULL`);

  const where = conditions.join(' AND ');

  // anonParam is the pevo.anon account name, referenced only by the rev_agg
  // review-aggregate LATERAL (its accreditation-OR-anon gate on review authors),
  // never in the WHERE clause. The citation arm uses the paper_citation_counts
  // CTE and does not reference anonParam.
  const anonParam = `$${paramIdx++}`;
  const dataParams = [...cteParams, ...filterParams, config.hiveAnonAccount || ''];

  const sortMap: Record<SortField, string> = {
    date: 'c.created',
    votes: 'net_votes',
    reputation: 'author_reputation',
  };
  const safeOrder = order === 'asc' ? 'ASC' : 'DESC';
  const orderBy = `${sortMap[sort]} ${safeOrder}`;

  // Only compute the expensive vote subquery when sorting by votes
  const voteSelect = sort === 'votes'
    ? `${accreditedVoteCount('c.author', 'c.permlink')} AS net_votes`
    : '0 AS net_votes';

  // Review count + average review rating from ONE correlated scan of the
  // accredited-review row set. The two aggregates previously lived in two
  // independent correlated subqueries (`review_count` and `avg_rating`) that
  // each re-scanned the SAME `hafsql.comments` rows under the SAME predicate
  // (parent-pair match + validReviewWhere + excludeSelfReviewWhere +
  // accreditation/anon gate) — doubling the per-page-row review-table scans.
  // A single LATERAL subquery returns both, so a 20-row page issues one
  // accredited-review scan per row instead of two.
  //
  // validReviewWhere supplies the type+rating-shape gate (display↔reputation
  // parity); accreditation stays inline as it does at every review-aggregating
  // site (see validReviewWhere docstring). excludeSelfReviewWhere drops
  // self-reviews — the outer paper row `c` IS the paper, so the helper
  // composes against it directly without a JOIN. The rating-shape regex inside
  // validReviewWhere guarantees each dimension is `[1-5]` text, so the
  // `::float` casts cannot crash on attacker-controlled JSON. count(*) over the
  // gated rows yields the review count; round(avg(...),1) over the per-row
  // four-dimension mean yields the average; COALESCE degrades each to 0 when
  // no review row matches (count(*)=0, avg over zero rows = NULL).
  const reviewAggSelect = `COALESCE(rev_agg.review_count, 0) AS review_count,
    COALESCE(rev_agg.avg_rating, 0) AS avg_rating`;
  const reviewAggLateral = `LEFT JOIN LATERAL (
    SELECT
      count(*)::int AS review_count,
      round(avg(
        (
          (r.json_metadata -> ${appTagParam} -> 'rating' ->> 'methodology')::float +
          (r.json_metadata -> ${appTagParam} -> 'rating' ->> 'novelty')::float +
          (r.json_metadata -> ${appTagParam} -> 'rating' ->> 'clarity')::float +
          (r.json_metadata -> ${appTagParam} -> 'rating' ->> 'significance')::float
        ) / 4.0
      )::numeric, 1)::float AS avg_rating
    FROM ${T.comments} r
    WHERE r.parent_author = c.author AND r.parent_permlink = c.permlink
      AND ${validReviewWhere({ commentAlias: 'r', appTagParam })}
      AND ${excludeSelfReviewWhere({ commentAlias: 'r', paperRowAlias: 'c', appTagParam })}
      AND ${excludeClaimedSelfWhere({ authorExpr: 'r.author', paperAuthorExpr: 'c.author', paperPermlinkExpr: 'c.permlink' })}
      AND (EXISTS (SELECT 1 FROM active_accreditations aa WHERE aa.account = r.author) OR r.author = ${anonParam})
  ) rev_agg ON true`;

  // Citation count: accredited papers that cite this one (native papers only;
  // bridge papers use Semantic Scholar). Sourced from the
  // `paper_citation_counts` CTE (appended to the WITH clause in the data query
  // below) and LEFT JOINed onto the page row, NOT a per-row correlated
  // containment subquery. The prior shape ran one full PEvO-paper scan per
  // output row (N scans per cold-cache page), each constructing a fresh
  // `jsonb_build_array(jsonb_build_object(...))` from the outer row that
  // defeated constant folding and could not use any index. The CTE unnests
  // every accredited paper's `pevo.citations` ONCE and groups by the cited
  // (author, permlink). Empty-citation papers have no CTE row, so the LEFT JOIN
  // yields NULL and COALESCE degrades to 0.
  const citationCountSelect = `COALESCE(pcc.citation_count, 0) AS citation_count`;

  try {
    const limitParam = `$${paramIdx++}`;
    const offsetParam = `$${paramIdx++}`;

    // Single-pass count+data via `count(*) OVER ()`: the window function
    // computes total across all rows matching WHERE in the same scan that
    // materializes the page, eliminating the prior parallel count query
    // (and its duplicate `active_accreditations + retracted_papers` CTE
    // materialization + `accred_ranked` ROW_NUMBER scan). Empty-page case
    // returns zero rows so `dataResult.rows[0]?.total ?? 0` degrades to 0.
    // Matches the shape established at `fetchAccreditationsFromHaf`.
    const dataResult = await pool.query(
      `${cte.sql},
       paper_citation_counts AS (
         -- Inverted citation aggregation (replaces a per-row correlated @>
         -- containment): unnest every accredited PEvO paper's pevo.citations
         -- ONCE and group by the cited (author, permlink), so a page render
         -- scans the corpus a single time instead of once per page row. The
         -- jsonb_typeof array guard is a cascade-fail defense — a chain post
         -- broadcasting a non-array pevo.citations (null, string, object) would
         -- otherwise raise "cannot extract elements from a scalar" and fail the
         -- whole listing (per the pg-jsonb-null-vs-sql-null convention). The
         -- inner DISTINCT collapses a citation listed twice within one citing
         -- paper so it counts the citing paper once, matching the prior @>
         -- containment (which counted citing papers, not citation elements).
         -- The per-element jsonb_typeof(cit -> 'author'/'permlink') = 'string'
         -- guards preserve the old @> containment's JSONB-type sensitivity: the
         -- ->> extraction text-coerces a numeric or boolean citation value, so a
         -- citation {"author":"victim","permlink":123} would otherwise count
         -- against a real paper victim/123 (all-digit permlinks are valid on
         -- Hive) where the type-sensitive @> counted 0. The string-type guards
         -- subsume the prior IS NOT NULL element checks (a string is non-null).
         SELECT cited_author, cited_permlink, count(*)::int AS citation_count
         FROM (
           SELECT DISTINCT
             ci.author AS citing_author,
             ci.permlink AS citing_permlink,
             cit ->> 'author' AS cited_author,
             cit ->> 'permlink' AS cited_permlink
           FROM ${T.comments} ci
           JOIN active_accreditations aa ON aa.account = ci.author
           CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(ci.json_metadata -> ${appTagParam} -> 'citations') = 'array'
               THEN ci.json_metadata -> ${appTagParam} -> 'citations'
               ELSE '[]'::jsonb
             END
           ) cit
           WHERE ci.parent_author = '' AND ci.parent_permlink = ${appTagParam}
             AND (ci.json_metadata -> ${appTagParam} ->> 'type') = 'paper'
             AND ci.json_metadata ->> 'app' LIKE ${appLikeParam}
             AND jsonb_typeof(cit) = 'object'
             AND jsonb_typeof(cit -> 'author') = 'string'
             AND jsonb_typeof(cit -> 'permlink') = 'string'
         ) deduped
         GROUP BY cited_author, cited_permlink
       )
       SELECT
        c.author,
        c.permlink,
        c.title,
        LEFT(c.body, 300) AS abstract,
        c.json_metadata,
        c.created,
        ${voteSelect},
        ${reviewAggSelect},
        ${citationCountSelect},
        ${authorsWithSupersessionSelect('c', appTagParam, { includeAffiliation: false })} AS authors_with_supersession,
        0 AS author_reputation,
        count(*) OVER ()::int AS total
      FROM ${T.comments} c
      LEFT JOIN paper_citation_counts pcc ON pcc.cited_author = c.author AND pcc.cited_permlink = c.permlink
      ${reviewAggLateral}
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
      [...dataParams, limit, offset],
    );

    const total = dataResult.rows[0]?.total ?? 0;
    const authors = dataResult.rows.map((r: Record<string, unknown>) => r.author as string);

    // Use batch reputation scores only (no on-demand HAF computation).
    // Returns 0 for users not yet in the batch — profile page has full scores.
    const paperKeys = dataResult.rows.map((r: Record<string, unknown>) => ({
      author: r.author as string,
      permlink: r.permlink as string,
    }));

    // Parallel: batch reputation + per-row accredited set + full-accredited
    // set + resolved votes + accreditation ORCID maps (used by the
    // cumulative-authors helper for per-row enrichment). `batchResolveVotes`
    // needs `allAccreditedArr`, so it chains on `getAllAccreditedAccounts`
    // within the same Promise.all — total cold-cache latency is bounded by
    // the slowest sibling rather than serialized fetches.
    const allAccreditedPromise = getAllAccreditedAccounts();
    const [batchScores, accreditedSet, voteData, allAccredited, accreditedOrcidsByAccount, accreditationOrcidStatus, accreditedNamesByAccount] = await Promise.all([
      getReputationScores(authors),
      getAccreditedSet(authors),
      allAccreditedPromise.then(set => batchResolveVotes(pool, paperKeys, [...set])),
      allAccreditedPromise,
      getAccreditedOrcidsByAccount(),
      getAllEverAccreditedOrcidsWithStatus(),
      getAccreditedNamesByAccount(),
    ]);

    // Cross-surface cumulative-union enrichment: for each row, fetch the
    // chain-level cumulative `authors` + `accredited_authors` so multi-link
    // papers carry the same dropped-author-preserving projection the detail
    // surface uses. Per-root Redis cache (30 min) absorbs warm pages; cold
    // pages walk in parallel via `Promise.all`. `is_accredited` stays
    // row-author-scoped (singular bool used for filter/sort).
    //
    // Wall-clock budget: each per-row helper threads the same `AbortSignal`
    // bounded by `config.hafWalkerWallClockMs`. The signal stops NEW queries
    // from being dispatched once the budget fires; it does NOT cancel an
    // in-flight `pool.query` — pg v8.x has no `AbortSignal` integration, so
    // the last query a row issued runs to PostgreSQL's `statement_timeout`
    // (30s). Real per-row worst case = `hafWalkerWallClockMs` +
    // `statement_timeout`; `Promise.all` parallelises across rows so the page
    // is bounded by the slowest row's sum, not their total. Mirrors the
    // budget pattern in `fetchPaperDetailFromHaf`, the canonical-root walker,
    // and the `/retract` handler.
    const enrichmentAbort = new AbortController();
    const enrichmentBudget = setTimeout(() => enrichmentAbort.abort(), config.hafWalkerWallClockMs);
    const chainAuthorsByKey = new Map<string, ChainCumulativeAuthorsResult>();
    try {
      await Promise.all(
        dataResult.rows.map(async (r: Record<string, unknown>) => {
          const key = `${r.author}/${r.permlink}`;
          try {
            const result = await resolveChainCumulativeAuthors(
              r.author as string,
              r.permlink as string,
              {
                accreditedAccounts: allAccredited,
                accreditedOrcids: accreditedOrcidsByAccount,
                accreditationOrcidStatus,
                accreditedNames: accreditedNamesByAccount,
                signal: enrichmentAbort.signal,
              },
            );
            if (result !== null) chainAuthorsByKey.set(key, result);
          } catch (err) {
            // Chain-walk failure for one row must not take down the whole
            // listing. Fall back to the head-meta projection below.
            logger.warn({ err, author: r.author, permlink: r.permlink }, 'chain cumulative authors enrichment failed');
          }
        }),
      );
    } finally {
      clearTimeout(enrichmentBudget);
    }

    const rows = dataResult.rows.map((r: Record<string, unknown>) => {
      const meta = parseMeta(r.json_metadata);
      const pevo = safePevoMeta(meta);
      // Supersession-aware authors from SQL (per
      // BACKEND-PAPERS-CANONICAL-ORCID-RESOLUTION + `hive-schemas.md` § 1.1).
      // The SQL helper LEFT JOINs each author against `active_accreditations`
      // in a single query so the per-author lookup doesn't multiply by
      // result-set size. The `pevoAuthors` raw projection below is kept for
      // the `accredited_authors` filter (which only needs the hive list)
      // and the `is_accredited` check.
      const authorsWithSupersession = Array.isArray(r.authors_with_supersession)
        ? (r.authors_with_supersession as Array<Record<string, unknown>>)
        : [];
      const pevoAuthors: Array<{ hive?: string }> = (pevo.authors || []) as Array<{ hive?: string }>;
      const voteKey = `${r.author}/${r.permlink}`;
      const resolved = voteData.get(voteKey);
      // Bridge identity must be author-pinned. isPevoBridgePaper(meta, author)
      // checks both the metadata type AND author === config.hiveBridgeAccount;
      // the SQL gate already enforces this, so this JS-level check is
      // defense-in-depth for any future call path that bypasses the gate.
      const isBridge = isPevoBridgePaper(meta, r.author as string);
      // Cumulative-union takeover: when the helper returned a result, use it
      // for `authors` + `accredited_authors` so multi-link papers reflect
      // the union across chain posts. When the helper returned null
      // (chain walk failed, HAF unreachable), keep the head-meta projection
      // — same shape as the pre-helper behavior.
      const chainResult = chainAuthorsByKey.get(`${r.author}/${r.permlink}`);
      const headAccreditedAuthors = pevoAuthors
        .map((a) => normalizeHiveAccount(a.hive))
        .filter((hive): hive is string => hive !== null && allAccredited.has(hive));
      // PaperSummary's contract excludes `affiliation` (that field is
      // PaperDetail-only). The head-meta projection `authorsWithSupersession`
      // is already affiliation-free because the SQL helper uses
      // `includeAffiliation: false` on the listing surface; the cumulative-
      // union path strips inline here so both branches emit the same shape.
      // Stripping at the consumer (not in the helper) preserves the detail
      // surface's legitimate use of `affiliation` on `PaperDetail.authors[]`.
      // Single guard so `authors` and `accredited_authors` are taken from the
      // cumulative result together or fall back together. The `length > 0`
      // check also routes an empty cumulative array (e.g. a chain whose posts
      // carry no valid-hive author entries) back to the head-meta projection
      // instead of serving an empty authors list.
      const cumulative = chainResult && chainResult.authors.length > 0 ? chainResult : null;
      const cumulativeAuthors = cumulative
        ? cumulative.authors.map((a) => {
            const { affiliation: _affiliation, ...rest } = a;
            return rest;
          })
        : null;
      return {
        author: r.author,
        permlink: r.permlink,
        title: r.title,
        abstract: r.abstract,
        discipline: paperDisciplineField(pevo.discipline),
        keywords: pevoStringArray(pevo, 'keywords'),
        authors: cumulativeAuthors ?? authorsWithSupersession,
        ipfs_cid: validatedCid(pevoString(pevo, 'ipfs_cid'), {
          author: r.author as string,
          permlink: r.permlink as string,
        }),
        created: r.created,
        net_votes: resolved?.net_votes ?? (r.net_votes as number),
        vote_strength: resolved?.vote_strength ?? null,
        review_count: (r.review_count as number) ?? 0,
        avg_rating: (r.avg_rating as number) ?? 0,
        citation_count: (r.citation_count as number) ?? 0,
        // is_accredited is the row author's accreditation; cumulative-union
        // extends `accredited_authors[]` (the multi-author display set) but
        // is_accredited remains row-author-scoped (the singular bool used
        // for listing filter / sort).
        is_accredited: accreditedSet.has(r.author as string),
        author_reputation: accreditedSet.has(r.author as string)
          ? (batchScores.get(r.author as string) ?? 0)
          : 0,
        accredited_authors: cumulative ? cumulative.accredited_authors : headAccreditedAuthors,
        source_type: isBridge
          ? ((pevo.source as Record<string, unknown>)?.type as 'arxiv' | 'crossref') || 'arxiv'
          : 'native',
        doi: isBridge
          ? ((pevo.source as Record<string, unknown>)?.doi as string) || null
          : null,
      };
    });

    // Re-sort by resolved vote counts when sorting by votes (revotes may change order)
    if (sort === 'votes') {
      const dir = order === 'asc' ? 1 : -1;
      rows.sort((a, b) => (a.net_votes - b.net_votes) * dir);
    }

    // Enrich bridge papers with external citation counts
    const bridgeDois = rows.filter(r => r.doi).map(r => r.doi!);
    if (bridgeDois.length > 0) {
      const extCounts = await fetchExternalCitationCounts(bridgeDois);
      for (const row of rows) {
        if (row.doi && extCounts[row.doi] !== undefined) {
          row.citation_count = extCounts[row.doi];
        }
      }
    }

    return { rows, total };
  } catch (err) {
    // Intentional swallow-to-null: listing contract serves [] on outage;
    // outage indistinguishable from "no papers match this filter" is the
    // accepted cost for listings. Route maps null → 200 [] at the
    // envelope layer (GET `/`). Sibling-resource detail surfaces
    // (`fetchPaperDetailFromHaf`) loud-fail with `HafQueryError` because
    // a single-resource lookup CAN distinguish outage from "no row".
    logger.error({ err }, 'HAF papers query failed');
    return null;
  }
}

// ──────────────────────────────────────────────
// GET /api/papers — list papers
// ──────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const { page, limit } = parsePageLimit(req);
  const sort = parseSort(req);
  const order = parseOrder(req);
  // Cache key uses `discipline ?? ''` so absent/invalid coalesces to the
  // empty fragment `d=`, while the SQL gate uses `discipline ?? undefined`
  // so the `if (discipline)` predicate suppresses the WHERE clause entirely.
  // Same value, two coalesce shapes, on purpose.
  const filterResult = validateDisciplineFilter(req.query.discipline);
  if (filterResult && !filterResult.ok) {
    return sendError(res, 400, 'BAD_REQUEST', filterResult.message);
  }
  const discipline: string | null = filterResult?.ok ? filterResult.value : null;
  const keyword = req.query.keyword || '';
  const author = req.query.author || '';
  const language = req.query.language || '';
  const includeRetracted = req.query.include_retracted === 'true';
  const source = req.query.source || '';
  // Sibling fields (keyword, author, language, source) flow in unvalidated;
  // a `:` in any of them collides with the delimiter and lets a crafted
  // `?keyword=:a=alice` poison-cache against `?author=:a=alice`. sha256-wrap
  // the raw fragments so the namespace is collision-stable. Mirrors
  // search.ts.
  const rawKey = `p=${page}:l=${limit}:s=${sort}:o=${order}:d=${discipline ?? ''}:k=${keyword}:a=${author}:lang=${language}:ir=${includeRetracted}:src=${source}`;
  const cacheKey = `papers:${crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 32)}`;
  const result = await hafCache.getOrSetSWR(cacheKey, () => fetchPapersFromHaf(req, discipline ?? undefined));
  if (result) {
    return sendOk(res, result.rows, { page, limit, total: result.total });
  }

  sendOk(res, [], { page, limit, total: 0 });
});

// ──────────────────────────────────────────────
// Semantic Scholar external citation counts (cached 24h)
// ──────────────────────────────────────────────

async function fetchExternalCitationCounts(dois: string[]): Promise<Record<string, number>> {
  if (dois.length === 0) return {};

  const results: Record<string, number> = {};
  const uncached: string[] = [];

  for (const doi of dois) {
    const cached = await hafCache.get<number>(`ext-citations:${doi}`);
    if (cached !== undefined) {
      results[doi] = cached;
    } else {
      uncached.push(doi);
    }
  }

  if (uncached.length > 0) {
    try {
      const response = await fetch('https://api.semanticscholar.org/graph/v1/paper/batch?fields=citationCount', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: uncached.map((d) => `DOI:${d}`) }),
      });

      if (response.ok) {
        const data = await response.json() as Array<{ citationCount?: number } | null>;
        for (let i = 0; i < uncached.length; i++) {
          const count = data[i]?.citationCount ?? 0;
          results[uncached[i]] = count;
          await hafCache.set(`ext-citations:${uncached[i]}`, count, 86_400_000); // 24h
        }
      } else {
        logger.warn({ status: response.status }, 'Semantic Scholar batch request failed');
        for (const doi of uncached) results[doi] = 0;
      }
    } catch (err) {
      logger.warn({ err }, 'Semantic Scholar fetch failed');
      for (const doi of uncached) results[doi] = 0;
    }
  }

  return results;
}

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink — single paper
// ──────────────────────────────────────────────

async function fetchPaperDetailFromHaf(
  author: string,
  permlink: string,
  memo?: HeadAuthorsMemo,
  signal?: AbortSignal,
) {
  const pool = getPool();
  if (!pool) return null;

  try {
    // Fast path: fetch paper content + versions + retraction only.
    // Accreditation-dependent data (votes, reviews, citations) is loaded
    // lazily via the /enrichment endpoint.
    //
    // The WHERE clause uses validPevoPaperWhere() so a spoofed bridge paper
    // (an unaccredited author posting type=bridge_paper) cannot reach the
    // post-fetch isPevoAnyPaper(meta, author) check — bridge identity is
    // enforced at the SQL layer for defense in depth.
    //
    // Wraps the paper SELECT with `activeAccreditationsCteBody` so the
    // `authorsWithSupersessionSelect` projection (per
    // BACKEND-PAPERS-CANONICAL-ORCID-RESOLUTION + `hive-schemas.md` § 1.1)
    // can LEFT JOIN per-author against the `active_accreditations` CTE
    // in-query. Param layout: $1=author, $2=permlink, $3=bridgeAccount,
    // $4=appTag (CTE), $5=authorities (CTE), $6=genesis (CTE). The
    // author+permlink positions stay at $1+$2 to preserve the responder
    // contract with existing tests; the CTE params anchor at $4 via
    // `activeAccreditationsCteBody(4)`. `appTag` ($4) is reused for
    // `parent_permlink`, the detailWhere helper, and the
    // authors-projection's JSON path — same value, single bind position.
    const detailCte = activeAccreditationsCteBody(4);
    const detailWhere = validPevoPaperWhere({ commentAlias: 'c', appTagParam: '$4', bridgeAccountParam: '$3', source: 'all' });
    // Resolve the continuation chain ONCE up-front and hand it to
    // reconstructVersionsFromHaf to avoid duplicate
    // `fetchHeadAuthorizedAuthors` + chain-walk queries (one each from this
    // function and reconstructVersionsFromHaf). Per task hold-block item 4d.
    // The optional `memo` parameter lets the caller share the
    // per-`(author, permlink)` metadata cache with the backward
    // canonical-root walker (see `findCanonicalRoot`).
    // Live detail surface: use the resolved chain as-is. A degraded (partial)
    // walk shows fewer versions but is not negative-cached, so no degraded gate
    // here — only the negative-caching callers gate on it.
    const { chain } = await resolveContinuationChain(author, permlink, memo, signal);
    // Hoist the accreditation lookups so the cumulative-union construction
    // (further down) and the `accredited_authors` rebuild share the same
    // request-scoped fetches. Both helpers cache 10 min via hafCache so
    // the parallel call is typically free; parallelizing with paperResult
    // / fullVersions / retraction avoids serial latency on cold cache.
    const [paperResult, fullVersions, retraction, accreditedAccountSet, accreditedOrcidsByAccount, accreditationOrcidStatus, accreditedNamesByAccount, authorReputation] = await Promise.all([
      // Not buildWith: the CTE params bind AFTER the outer author/permlink/bridge
      // params, and $4 (the appTag) is reused as both the parent_permlink filter and
      // the authorsWithSupersessionSelect / detailWhere appTag slot. A byte-identical
      // buildWith adoption (CTE params first) would renumber every $N in detailWhere
      // and the supersession select; kept manual to preserve the exact param layout
      // on this hot detail query.
      pool.query(
        `WITH ${detailCte.sql}
         SELECT c.author, c.permlink, c.title, c.body, c.json_metadata,
                c.created, c.last_edited,
                ${authorsWithSupersessionSelect('c', '$4', { includeAffiliation: true })} AS authors_with_supersession
         FROM ${T.comments} c
         WHERE c.author = $1 AND c.permlink = $2
           AND c.parent_author = '' AND c.parent_permlink = $4
           AND ${detailWhere}`,
        [author, permlink, config.hiveBridgeAccount, ...detailCte.params],
      ),
      reconstructVersionsFromHaf(author, permlink, chain, memo, signal),
      getRetractionInfo(author, permlink),
      getAllAccreditedAccounts(),
      getAccreditedOrcidsByAccount(),
      getAllEverAccreditedOrcidsWithStatus(),
      getAccreditedNamesByAccount(),
      // List-view (and profile-view) parity per BACKEND-REPUTATION-SSOT
      // AC #1: every reputation value displayed in the UI must derive
      // from the same `${appTag}:reputation:batch:${user}` value. Paper
      // detail previously hardcoded `author_reputation: 0` (round-2
      // hold #6).
      getReputationScore(author),
    ]);

    if (paperResult.rows.length === 0) return null;

    const row = paperResult.rows[0];
    const meta = parseMeta(row.json_metadata);
    if (!isPevoAnyPaper(meta, row.author as string)) return null;

    const detail = buildPaperDetail(row, meta, []);
    // Supersession-aware authors from the SQL LEFT JOIN against
    // `active_accreditations` (per `hive-schemas.md` § 1.1). Overrides
    // `buildPaperDetail`'s raw `pevo.authors || []` so the response carries
    // `orcid_verified` + `orcid_discrepancy`. Continuation-chain papers
    // override this again further down via `buildCumulativeAuthorsForChain`,
    // which populates the same fields from the request-scoped
    // `accreditedOrcidsByAccount` map.
    if (Array.isArray(row.authors_with_supersession)) {
      detail.authors = row.authors_with_supersession as Array<Record<string, unknown>>;
    }
    const versions = fullVersions.map(({ body: _body, json_metadata: _meta, post_author: _pa, post_permlink: _pp, ...entry }) => entry);
    detail.versions = versions.length > 0 ? versions : [{ version_number: 1, block_num: 0, created: detail.created as string, title: detail.title as string, is_content_revision: true }];
    detail.is_retracted = retraction.is_retracted;
    detail.retraction_reason = retraction.retraction_reason ?? null;
    detail.retraction_timestamp = retraction.retraction_timestamp ?? null;

    // E7: Use the (already-resolved) continuation chain to set head
    // author/permlink and use the latest version's content/metadata as
    // the displayed paper. `chain` was hoisted above and reused by
    // reconstructVersionsFromHaf to dedupe HAF queries.
    if (chain.length > 1) {
      const head = chain[chain.length - 1];
      detail.head_author = head.author;
      detail.head_permlink = head.permlink;

      // Replace displayed content with the latest version from the chain
      if (fullVersions.length > 0) {
        const latest = fullVersions[fullVersions.length - 1];
        detail.title = latest.title;
        detail.body = latest.body;
        detail.abstract = extractAbstract(latest.body);
        detail.last_update = latest.created;

        // Cumulative-union display construction
        // (see `agents/docs/ARCHITECTURE.md § 2 "Multi-Author Trust Model"`).
        //   - `detail.authors[]` is the cumulative union of
        //     `pevo.authors[].hive` across all chain posts (in
        //     first-occurrence order); per-hive sub-fields resolve to the
        //     most-recent self-claim or, absent a self-claim, the
        //     most-recent claim across the chain. ORCID is server-
        //     overridden for accredited hives whose claim diverges from
        //     the on-chain accredited ORCID. Drops are forbidden by
        //     construction (the union only grows; no chain post can
        //     remove a hive that another chain post added) — a structural
        //     invariant replaces the prior inversion-prone explicit check.
        //     See `agents/docs/ARCHITECTURE.md` section 2 "Multi-Author
        //     Trust Model" (architect-rewritten at archive of this task).
        //   - `pevo.ipfs_cid` / `pevo.document_hash` / `pevo.ipfs_filename`
        //     apply per-version: each chain post's pointers describe that
        //     version's PDF (alice's v1 has CID_A, bob's v2 may have
        //     CID_B). The default `/api/papers/:author/:permlink` view
        //     reads from the chain head, falling back to the root when
        //     the head doesn't carry the field. `?version=N` reads the
        //     N-th version's metadata via the dedicated
        //     `reconstructVersionsFromHaf` path. All historical CIDs are
        //     preserved on chain (Hive immutability); the pinner agent
        //     retains them per the "Pinner constraint" subsection of the
        //     ARCH spec.
        //   - The risk of bob spoofing his continuation's `ipfs_cid` to a
        //     different paper is treated identically to body-spoof:
        //     accepted risk under the broadcaster-attributed reputation
        //     model with on-chain audit trail and accreditation
        //     revocation as the deterrent.
        //   - Other fields (title, body, abstract, discipline, keywords,
        //     citations, language, supplementary_files) evolve normally
        //     as part of legitimate version progression and are
        //     head-preferred.
        // The accept/resign consent layer (read-time vouched-status decay)
        // is a separate dimension layered on top of this cumulative union:
        // the union is monotonic membership, vouched-status decays under
        // resign — orthogonal. The `computeVouchedAuthors` primitive exists
        // but no read path applies it yet (membership-only reconstruction).
        const headMeta = latest.json_metadata;
        if (isPevoAnyPaper(headMeta, latest.post_author)) {
          const rootPevo = safePevoMeta(meta);
          const headPevo = safePevoMeta(headMeta);

          // Build per-link latest pevo metadata for the cumulative-union
          // construction. `fullVersions` carries per-version metadata
          // already (each entry tagged with `post_author` / `post_permlink`);
          // the latest version per chain link is whichever entry came
          // last in the version-ordered scan. Iterating `fullVersions` in
          // its existing block_num-ascending order and overwriting on
          // each post-key collision yields the per-link latest metadata
          // without an extra query.
          const latestMetaByLink = new Map<string, Record<string, unknown>>();
          for (const v of fullVersions) {
            latestMetaByLink.set(
              `${v.post_author}/${v.post_permlink}`,
              v.json_metadata,
            );
          }
          const chainPosts = chain.map((link) => ({
            author: link.author,
            permlink: link.permlink,
            pevo: safePevoMeta(latestMetaByLink.get(`${link.author}/${link.permlink}`) ?? {}),
          }));

          // Route through the shared cumulative-authors helper so the
          // detail, listing, and profile surfaces share one construction.
          // The prebuiltChainPosts shortcut skips the helper's HAF round-trip
          // (detail already has the chain + per-link metadata) and writes
          // through to the per-root Redis cache, warming listing/profile
          // for subsequent requests within the TTL window.
          const cumulativeAuthors = (await resolveChainCumulativeAuthors(
            row.author as string,
            row.permlink as string,
            {
              accreditedAccounts: accreditedAccountSet,
              accreditedOrcids: accreditedOrcidsByAccount,
              accreditationOrcidStatus,
              accreditedNames: accreditedNamesByAccount,
              prebuiltChainPosts: chainPosts,
              memo,
              signal,
            },
          ))?.authors ?? [];

          detail.json_metadata = headMeta;
          detail.authors = cumulativeAuthors;
          detail.discipline = paperDisciplineField(headPevo.discipline);
          detail.keywords = pevoStringArray(headPevo, 'keywords');
          detail.citations = headPevo.citations || [];
          // Per-version display: the IPFS triple (ipfs_cid /
          // ipfs_filename / document_hash) is treated atomically.
          // Either head expresses a per-version triple (any of the
          // three keys is set on head — even to null, '', or a
          // non-string) and the displayed triple is read entirely
          // from head, OR head expresses no opinion (none of the
          // three keys present on head) and the entire triple falls
          // back to root.
          //
          // Why atomic: per-field fallback creates Frankenstein
          // composition (e.g. head's CID + root's filename + root's
          // hash) where the displayed triple never existed on chain
          // in any single version. The block comment above commits
          // to "each post's pointers describe that version's PDF";
          // an atomic triple preserves that invariant.
          //
          // Why sentinel-aware (`'in'` rather than non-null check):
          // a head explicitly clearing the triple (alice's v2 short
          // correction with no PDF, inline body only) is a supported
          // product shape. Distinguishing "head cleared" (key
          // present, value null) from "head omitted" (key absent)
          // preserves that signal end-to-end so a future per-version
          // display surface can read "no PDF for this version" from
          // the chain truthfully — without that distinction, a head
          // explicitly clearing its triple would be indistinguishable
          // from a head that simply didn't restate root's triple, and
          // the displayed CID would silently fall back to root.
          //
          // Note: no current API consumer relies on the head-cleared
          // vs head-omitted distinction (the response surfaces both
          // as `ipfs_cid: null`); the sentinel-aware shape is
          // preemptive future-proofing aligned with the atomic-triple
          // invariant.
          //
          // ipfs_cid is additionally passed through `validatedCid`
          // so attacker-controlled chain values that flow from
          // pevo.ipfs_cid through pevoString to the response are
          // shape-checked at the emit boundary; whitespace, control
          // characters, zero-width spaces, and arbitrary garbage
          // are scrubbed to null with a structured warn.
          const headHasAnyTripleKey =
            'ipfs_cid' in headPevo
            || 'ipfs_filename' in headPevo
            || 'document_hash' in headPevo;
          if (headHasAnyTripleKey) {
            detail.ipfs_cid = validatedCid(pevoString(headPevo, 'ipfs_cid'), {
              author,
              permlink,
            });
            detail.ipfs_filename = pevoString(headPevo, 'ipfs_filename');
            detail.document_hash = pevoString(headPevo, 'document_hash');
          } else {
            detail.ipfs_cid = validatedCid(pevoString(rootPevo, 'ipfs_cid'), {
              author,
              permlink,
            });
            detail.ipfs_filename = pevoString(rootPevo, 'ipfs_filename');
            detail.document_hash = pevoString(rootPevo, 'document_hash');
          }
          detail.language = pevoString(headPevo, 'language') ?? 'en';
          detail.supplementary_files = headPevo.supplementary_files || [];
        }
      }
    }

    // Accreditation: is_accredited + accredited_authors. Use the
    // already-loaded `accreditedAccountSet` (hoisted into the parallel
    // fetch block above) so this rebuild does not re-issue the
    // `getAllAccreditedAccounts` HAF query. `accredited_authors` reads
    // from `detail.authors` (the cumulative-union'd list for chain.length
    // > 1, or `pevo.authors[]` for single-link papers) rather than from
    // `detail.json_metadata`. Reading the union ensures by construction
    // that a head post that drops a chain author from its own
    // `pevo.authors[]` cannot leak the shrunken set into accreditation —
    // the union still carries the dropped author.
    detail.is_accredited = accreditedAccountSet.has(author);
    // Symmetric chain pre-check: non-accredited author shows score 0 even
    // if a stale batch entry survives in Redis (per BACKEND-REPUTATION-SSOT
    // direction-of-truth: chain is SSoT, batch map is a perf cache).
    detail.author_reputation = detail.is_accredited ? authorReputation.score : 0;
    const detailAuthors = (detail.authors as Array<Record<string, unknown>>) || [];
    detail.accredited_authors = detailAuthors
      .map((a) => normalizeHiveAccount(a.hive))
      .filter((hive): hive is string => hive !== null && accreditedAccountSet.has(hive));

    // Citation count
    const pevo = safePevoMeta(meta);
    if (isPevoBridgePaper(meta, row.author as string)) {
      // External citation count for bridge papers
      const doi = ((pevo.source as Record<string, unknown>)?.doi as string) || null;
      if (doi) {
        const extCounts = await fetchExternalCitationCounts([doi]);
        if (extCounts[doi] !== undefined) detail.citation_count = extCounts[doi];
      }
    } else {
      // Native paper citation count from accredited authors
      const citCte = buildWith(1, activeAccreditationsCteBody);
      const citAppTag = `$${citCte.nextIdx}`;
      const citAppLike = `$${citCte.nextIdx + 1}`;
      const citJson = `$${citCte.nextIdx + 2}`;
      const citResult = await pool.query(
        `${citCte.sql}
         SELECT count(*)::int AS cnt FROM ${T.comments} ci
         JOIN active_accreditations aa ON aa.account = ci.author
         WHERE ci.parent_author = '' AND ci.parent_permlink = ${citAppTag}
           AND (ci.json_metadata -> ${citAppTag} ->> 'type') = 'paper'
           AND ci.json_metadata ->> 'app' LIKE ${citAppLike}
           AND ci.json_metadata -> ${citAppTag} -> 'citations' @> ${citJson}::jsonb`,
        [...citCte.params, config.appTag, `${config.appTag}/%`, JSON.stringify([{ author, permlink }])],
      );
      detail.citation_count = citResult.rows[0]?.cnt ?? 0;
    }

    // Cache-poisoning defense: if the wall-clock budget tripped during
    // this fetcher's walker calls (`resolveContinuationChain` /
    // `reconstructVersionsFromHaf`), the chain may be partial. The detail
    // object built from a partial chain has wrong `head_author` /
    // `head_permlink` / `versions[]`. Returning it would let `hafCache`
    // cache the bad shape for 30 min. Return null so the cache layer's
    // null-skip rule in `hafCache.getOrSet` leaves the cache cold and the next
    // request retries against (hopefully recovered) HAF. The route handler
    // then surfaces 503 to the client via its own `signal.aborted` check.
    if (signal?.aborted) return null;

    return detail;
  } catch (err) {
    // Re-throw walker-abort errors as null is the cache-poisoning defense
    // above; this catch only fires for actual query failures (pg pool
    // exhausted, statement_timeout, network blip, hosting outage) or for
    // upstream throws from `getAllAccreditedAccounts` /
    // `getAccreditedOrcidsByAccount` / `getAllEverAccreditedOrcidsWithStatus`
    // (all three loud-fail per their docstrings).
    //
    // Tag the error class so the route layer can translate to
    // `503 SERVICE_UNAVAILABLE` with `details.retriable: true`. Pre-fix,
    // this catch returned `null` and the route handler treated `null` as
    // `404 NOT_FOUND`, making HAF outage indistinguishable from
    // "paper does not exist" to clients.
    logger.error({ err }, 'HAF paper detail query failed');
    throw new HafQueryError('fetchPaperDetailFromHaf', { cause: err });
  }
}

// ──────────────────────────────────────────────
// Version history resolution (on-chain edits)
// ──────────────────────────────────────────────

import { diff_match_patch as DiffMatchPatch } from 'diff-match-patch';

const dmp = new DiffMatchPatch();

interface PaperVersionEntry {
  version_number: number;
  block_num: number;
  created: string;
  title: string;
  is_content_revision: boolean;
  author?: string;
  permlink?: string;
  addresses_reviews?: Array<{ author: string; permlink: string }>;
}

// ──────────────────────────────────────────────
// E1 — Continuation chain resolution
// ──────────────────────────────────────────────

interface ChainLink {
  author: string;
  permlink: string;
}

/**
 * Discriminated result of a forward continuation-chain walk. `degraded` is
 * true unless the walk reached its clean natural end — no further post
 * continues the current head, i.e. the terminating `rows.length === 0` break.
 * Every other exit leaves `degraded` true and the accumulated `chain`
 * partial/unverified: pool unavailable, wall-clock abort, an empty or failed
 * root head-authors fetch, a swallowed inner-loop SQL error, cycle detection,
 * or MAX_HOPS truncation. Callers that negative-cache a result derived from
 * the chain (the canonical-root negative cache in `findCanonicalRoot`, the
 * cumulative-authors cache in `computeChainCumulativeFromHaf`) MUST NOT write
 * the cache when `degraded` — otherwise a transient HAF blip locks a false
 * negative or a partial author-union in for the full TTL.
 */
interface ChainResolution {
  chain: ChainLink[];
  degraded: boolean;
}

/**
 * Per-request memo for `fetchHeadAuthorizedAuthors` results, keyed by
 * `"author/permlink"`. Threaded into the forward (`resolveContinuationChain`)
 * and backward (`findCanonicalRoot`) walkers so the two halves of a single
 * request reuse the same metadata fetches. Bounded by request lifetime
 * (a fresh map per route handler invocation; map drops out of scope when
 * the handler returns) so there is no cross-request leak. Stores `null`
 * for posts that are not valid PEvO papers (negative cache) so a repeat
 * lookup does not re-issue the SQL query.
 */
type HeadAuthorsMemo = Map<string, Set<string> | null>;

function makeHeadAuthorsMemo(): HeadAuthorsMemo {
  return new Map();
}

function memoKey(author: string, permlink: string): string {
  return `${author}/${permlink}`;
}

/**
 * Fetch the head (root) paper's authorized continuation-author set: the
 * `hive` field values from the head paper's `pevo.authors[]`, narrowed to
 * the case where the row at `(author, permlink)` is a valid PEvO paper
 * (native or bridge, identity-pinned via `isPevoAnyPaper`).
 *
 * Returns `null` if the head is not a valid PEvO paper (no chain to admit
 * into) — callers should treat this as "no continuations admitted".
 *
 * Optionally accepts a per-request `HeadAuthorsMemo` so forward + backward
 * walkers within the same request reuse fetched metadata. Both `null` and
 * `Set` results are cached.
 *
 * This is the per-resource vouched-identity set the continuation gate
 * checks against. See
 * `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`.
 */
async function fetchHeadAuthorizedAuthors(
  pool: NonNullable<ReturnType<typeof getPool>>,
  author: string,
  permlink: string,
  memo?: HeadAuthorsMemo,
  signal?: AbortSignal,
): Promise<Set<string> | null> {
  const key = memoKey(author, permlink);
  if (memo && memo.has(key)) {
    return memo.get(key) ?? null;
  }
  // Defense-in-depth abort check. The walker loops check `signal?.aborted`
  // at iteration boundaries (the primary gate), but a future caller
  // outside a walker loop should still self-protect against an exhausted
  // budget. Fail-closed (return null) matches the existing "head is not a
  // valid PEvO paper" return shape, so callers handle abort identically
  // to a benign no-result.
  if (signal?.aborted) {
    memo?.set(key, null);
    return null;
  }
  try {
    const result = await pool.query(
      `SELECT c.author, c.json_metadata
       FROM ${T.comments} c
       WHERE c.author = $1 AND c.permlink = $2
         AND c.parent_author = '' AND c.parent_permlink = $3`,
      [author, permlink, config.appTag],
    );
    if (result.rows.length === 0) {
      memo?.set(key, null);
      return null;
    }
    const row = result.rows[0] as Record<string, unknown>;
    // Type-narrow row.author: HAF could in principle return NULL; the
    // gate must fail-closed. A bare `as string` would silently coerce
    // undefined/null and let downstream identity checks evaluate against
    // a non-string — better to bail explicitly.
    if (typeof row.author !== 'string') {
      memo?.set(key, null);
      return null;
    }
    const meta = parseMeta(row.json_metadata);
    if (!isPevoAnyPaper(meta, row.author)) {
      memo?.set(key, null);
      return null;
    }
    const pevo = safePevoMeta(meta);
    const set = extractAuthorizedContinuationAuthors(pevo, row.author);
    memo?.set(key, set);
    return set;
  } catch (err) {
    logger.error({ err }, 'Head authorized-authors lookup failed');
    // Memoize the null on failure too. Documented contract on lines
    // 826-827 says "Both null and Set results are cached"; without this
    // set, a single request hitting canonical-walker + a second
    // `fetchPaperDetailFromHaf` + `reconstructVersionsFromHaf` re-fires
    // the failing query 3+ times under degraded HAF, each blocking for
    // the full statement_timeout.
    memo?.set(key, null);
    return null;
  }
}

/**
 * Resolve the continuation chain starting from a canonical (root) post.
 * Follows `json_metadata -> appTag -> 'continues'` pointers iteratively.
 * Returns `{ chain, degraded }` (see `ChainResolution`): the ordered chain
 * starting with the root post and ending at the chain head, plus a `degraded`
 * flag that is false only on a clean natural end and true on any
 * truncation/abort/error exit. Uses block_num to resolve collisions (earliest
 * wins). 50-hop safety cap.
 *
 * **Author-consent gate (cumulative-union under
 * `agents/docs/ARCHITECTURE.md § 2 "Multi-Author Trust Model"`).** A candidate
 * continuation
 * post `C` is admitted at hop N only if BOTH:
 *
 *   1. `C.author` (chain-level) is in the cumulative union of
 *      `pevo.authors[].hive` extracted from chain posts `0..N-1` (i.e., all
 *      predecessors). The cumulative starts at the root's contribution and
 *      grows as each admitted candidate's `pevo.authors[]` contributes new
 *      hives. This encodes the equal-rights authorship policy: any author
 *      currently in the chain's authors[] can broadcast continuations
 *      regardless of when they were added; trust is dynamic and the cost
 *      of a bad invitation falls on the introducer via accreditation
 *      cascade.
 *
 *   2. `C` is itself a valid PEvO paper class — native paper, or the
 *      bridge-paper variant pinned to `config.hiveBridgeAccount` (per
 *      `validPevoPaperWhere` / `isPevoAnyPaper`). Without this
 *      object-identity check, a named co-author could post a review-typed
 *      comment with `pevo.continues={...}` and have the review content
 *      surface as the paper's apparent body via the version walker. The
 *      convention is "every gate enforces author + type identity
 *      together"; see
 *      `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`.
 *
 * Both predicates are enforced SQL-side (the DB never returns disallowed
 * candidates) AND JS-side as defense in depth. The cumulative `$N::text[]`
 * parameter regenerates each iteration with the union built so far. If the
 * root paper is not a valid PEvO paper or has no named authors, the chain
 * degenerates to the root only — no continuations are admitted.
 *
 * **Bridge-paper Option-b** is preserved by construction: the root's
 * contribution for `pevo.type === 'bridge_paper'` is `{bridgeAccount}` (per
 * `extractAuthorizedContinuationAuthors`); each admitted bridge-paper
 * candidate's contribution is also `{bridgeAccount}`, so the cumulative
 * stays locked to `{bridgeAccount}` for bridge chains. Bridge papers are
 * immutable post-publish, which makes `chain.length === 1` for bridge
 * papers in practice; the cumulative-extension path here is defense-in-depth.
 */
async function resolveContinuationChain(
  author: string,
  permlink: string,
  memo?: HeadAuthorsMemo,
  signal?: AbortSignal,
): Promise<ChainResolution> {
  const pool = getPool();
  if (!pool) return { chain: [{ author, permlink }], degraded: true };

  // Capture entry time so wall-clock-exceeded warns carry the elapsed
  // signal that operators need to distinguish "budget tripped early"
  // from "budget tripped after legitimate slow hops".
  const startedAt = Date.now();

  const chain: ChainLink[] = [{ author, permlink }];

  // Degraded unless the walk reaches its clean natural end (the
  // `rows.length === 0` break below flips this to false). Every other exit —
  // abort, empty/failed root head-authors, swallowed SQL error, cycle, depth
  // cap — leaves it true so negative-caching callers skip the write.
  let degraded = true;

  // Pre-loop abort check. The route-handler-bounded `AbortController`
  // could already have fired before we issued the seed fetch (e.g., a
  // sibling backward-walker call burned the budget); fail-closed to a
  // root-only chain rather than starting a forward walk we can't finish.
  if (signal?.aborted) {
    logger.warn(
      {
        event: 'continuation_chain_wall_clock_exceeded',
        startAuthor: author,
        startPermlink: permlink,
        hopIndex: 0,
        elapsedMs: Date.now() - startedAt,
        budgetMs: config.hafWalkerWallClockMs,
      },
      'continuation chain walker aborted: wall-clock budget exceeded before seed fetch',
    );
    return { chain, degraded };
  }

  // Seed the cumulative admit-set from the root's contribution. The root's
  // contribution is the full cumulative for hop 0 (no predecessors beyond
  // the root itself).
  const rootAuthorizedAuthors = await fetchHeadAuthorizedAuthors(pool, author, permlink, memo, signal);
  if (!rootAuthorizedAuthors || rootAuthorizedAuthors.size === 0) {
    // Root is not a valid PEvO paper, has no named authors, OR its
    // head-authors fetch failed/returned empty under a transient HAF read
    // (eventual consistency). These are indistinguishable here, so the
    // root-only chain is marked degraded — a negative-caching caller must not
    // lock in a false negative built on a possibly-transient empty fetch.
    return { chain, degraded };
  }

  // Cumulative admit-set, seeded from root. Extended in-place after each
  // admitted hop with the candidate's contribution.
  const cumulative = new Set<string>(rootAuthorizedAuthors);

  let currentAuthor = author;
  let currentPermlink = permlink;

  // Per-walker-call visited set for cycle detection. Keys match the
  // `memoKey` shape so cycle short-circuit happens at O(N_unique_nodes)
  // instead of O(MAX_HOPS) on attacker-posted cycles (mutually authorized
  // co-authors broadcast continuations covering each other: A → B → A).
  // Seeded with the root (the chain's first entry, which is also the
  // initial `currentAuthor/currentPermlink`), so a 2-cycle short-circuits
  // at the first advancement. The depth cap is the attacker-amplifier
  // backstop; cycle detection is the structural short-circuit on top.
  const visited = new Set<string>([memoKey(currentAuthor, currentPermlink)]);

  // MAX_HOPS = 50. Per-request worst-case latency under degraded HAF:
  // 50 hops × ≥1 sequential SQL query × 30s statement_timeout (`db.ts:22`)
  // = up to 1500s (~25 min) per request before the depth cap exits.
  // The depth cap is the attacker-amplifier defense; the wall-clock
  // budget threaded via `signal?: AbortSignal` (and the route-handler
  // `config.hafWalkerWallClockMs`-bounded `AbortController`) bounds the
  // degraded-HAF tail independently of hop count. Both signals coexist
  // because a long legitimate chain under fast HAF is depth-bounded but
  // not wall-clock-pressured. See
  // `verify-resource-knob-math-before-load-bearing-security-margins-2026-04-22.md`.
  const MAX_HOPS = 50;

  try {
    for (let i = 0; i < MAX_HOPS; i++) {
      // Wall-clock budget check at each iteration boundary. When BOTH the
      // depth cap and the wall-clock budget would fire on the same
      // request, the wall-clock signal takes priority (operator-actionable
      // degraded-HAF signal vs the depth cap's attacker-amplifier signal)
      // because we check the budget BEFORE the depth-cap exit condition
      // at line `i < MAX_HOPS`. See task acceptance section 3.
      if (signal?.aborted) {
        logger.warn(
          {
            event: 'continuation_chain_wall_clock_exceeded',
            startAuthor: author,
            startPermlink: permlink,
            hopIndex: i,
            elapsedMs: Date.now() - startedAt,
            budgetMs: config.hafWalkerWallClockMs,
          },
          'continuation chain walker aborted: wall-clock budget exceeded mid-walk',
        );
        return { chain, degraded };
      }
      const cumulativeArr = Array.from(cumulative);
      // Find any post whose continues field points to the current head AND
      // whose author is in the cumulative authorized-authors set built from
      // the chain so far AND whose pevo.type is a valid PEvO paper class
      // (native paper or the bridge-paper variant pinned to the bridge
      // account, per validPevoPaperWhere). SQL-side filtering via
      // $4::text[] (cumulative author-set) + validPevoPaperWhere
      // (object-identity) is the primary gate; the JS-side re-checks below
      // are defense in depth. The $4 array is rebuilt each iteration to
      // reflect the cumulative grown by prior hops.
      const validPaperPredicate = validPevoPaperWhere({
        commentAlias: 'c',
        appTagParam: '$3',
        bridgeAccountParam: '$5',
        source: 'all',
      });
      const result = await pool.query(
        `SELECT c.author, c.permlink, c.json_metadata, co.block_num
         FROM ${T.comments} c
         JOIN ${T.commentOps} co ON co.author = c.author AND co.permlink = c.permlink
         WHERE c.parent_author = ''
           AND c.parent_permlink = $3
           AND c.json_metadata -> $3 -> 'continues' ->> 'author' = $1
           AND c.json_metadata -> $3 -> 'continues' ->> 'permlink' = $2
           AND c.author = ANY($4::text[])
           AND ${validPaperPredicate}
         ORDER BY co.block_num ASC
         LIMIT 1`,
        [currentAuthor, currentPermlink, config.appTag, cumulativeArr, config.hiveBridgeAccount],
      );

      if (result.rows.length === 0) {
        // Clean natural end: no post continues the current head. This is the
        // ONLY non-degraded exit — the chain is fully resolved.
        degraded = false;
        break;
      }

      const next = result.rows[0];
      const candidateAuthor = next.author;
      // Type-narrow: HAF could in principle return NULL author. Bare
      // `as string` would coerce undefined/null silently. Bail explicitly
      // (fail-closed: chain ends at the previous hop).
      if (typeof candidateAuthor !== 'string') break;

      // Defense in depth: re-verify (a) author in cumulative authorized
      // set, (b) the candidate's pevo.type is a valid paper class. A drift
      // between the JS gate and the SQL gate (e.g. a future SQL refactor
      // that drops one of the predicates) would be caught here.
      if (!cumulative.has(candidateAuthor)) {
        logger.warn(
          { rootAuthor: author, rootPermlink: permlink, candidateAuthor },
          'continuation candidate slipped past SQL cumulative author-set gate; rejecting at JS layer',
        );
        break;
      }
      const candidateMeta = parseMeta(next.json_metadata);
      if (!isPevoAnyPaper(candidateMeta, candidateAuthor)) {
        logger.warn(
          { rootAuthor: author, rootPermlink: permlink, candidateAuthor, candidatePermlink: next.permlink },
          'continuation candidate slipped past SQL pevo-type gate; rejecting at JS layer',
        );
        break;
      }
      currentAuthor = candidateAuthor;
      currentPermlink = next.permlink as string;

      // Cycle detection: revisiting an already-touched `(author, permlink)`
      // node means the continuation-pointer graph contains a cycle. The
      // SQL gate admits when both authors are mutually in each other's
      // `pevo.authors[]` (cumulative-union), which is exactly the setup
      // that lets a cycle form. Stop the walk before pushing the cycle
      // terminus into `chain` so downstream consumers
      // (`reconstructVersionsFromHaf` and friends) do not fetch operations
      // for the duplicate post. Without this short-circuit the walker
      // runs to `MAX_HOPS = 50` on any cycle.
      const visitedKey = memoKey(currentAuthor, currentPermlink);
      if (visited.has(visitedKey)) {
        logger.warn(
          {
            event: 'continuation_chain_cycle_detected',
            startAuthor: author,
            startPermlink: permlink,
            cycleAuthor: currentAuthor,
            cyclePermlink: currentPermlink,
            hopIndex: i,
          },
          'continuation chain walker detected cycle in continuation pointers',
        );
        return { chain, degraded };
      }
      visited.add(visitedKey);

      chain.push({ author: currentAuthor, permlink: currentPermlink });

      // Extend cumulative with the admitted candidate's contribution.
      // For bridge-paper candidates, the contribution is `{bridgeAccount}`
      // (no change to cumulative since bridge roots already seed it).
      // For native paper candidates, the contribution is their
      // `pevo.authors[].hive` set — admitting authors invited mid-chain
      // for subsequent hops.
      const candidateContrib = extractAuthorizedContinuationAuthors(
        safePevoMeta(candidateMeta),
        candidateAuthor,
      );
      for (const a of candidateContrib) cumulative.add(a);
    }
  } catch (err) {
    // Swallowed inner-loop SQL error (e.g. statement_timeout 57014): the
    // chain is partial and `degraded` stays true. MAX_HOPS exhaustion (loop
    // exits without the clean break) likewise leaves `degraded` true.
    logger.error({ err }, 'Continuation chain resolution failed');
  }

  return { chain, degraded };
}

/**
 * Maximum hops the backward canonical-root walker is allowed to take.
 *
 * The walker walks attacker-controlled `pevo.continues` pointers, one SQL
 * query per hop. Without a cap, an attacker can post a chain of 51+
 * continuation posts and induce that many DB queries per request to the
 * deepest one — a per-request DoS amplifier. The PEvO-realistic
 * version-chain depth is in the low single digits; 10 is a generous
 * ceiling that absorbs unusual edit cadences without giving an attacker a
 * 50× amplification factor. Beyond the cap the walker stops at the current
 * node and emits a structured warn so operators can detect attack patterns.
 *
 * Per-request worst-case latency under degraded HAF: 10 hops × 1
 * sequential SQL query × 30s statement_timeout = up to 300s (5 min) per
 * request before the depth cap exits. The depth cap is the
 * attacker-amplifier defense; the wall-clock budget threaded via
 * `signal?: AbortSignal` (and the route-handler
 * `config.hafWalkerWallClockMs`-bounded `AbortController`) bounds the
 * degraded-HAF tail independently of hop count. Both signals coexist
 * because a long legitimate chain under fast HAF is depth-bounded but not
 * wall-clock-pressured. See
 * `verify-resource-knob-math-before-load-bearing-security-margins-2026-04-22.md`.
 */
const CANONICAL_ROOT_MAX_HOPS = 10;

/**
 * Discriminator for `event: 'canonical_root_walker_start_invalid'` log
 * payloads. Named-literal-union so misspellings fail at compile time and
 * any future bail path is the obvious extension point.
 */
type CanonicalRootBailReason =
  | 'sql_filter_or_missing'
  | 'js_is_pevo_any_paper'
  | 'cont_columns_invalid';

/**
 * Cached canonical-root lookup payload. Encodes both the positive ("this
 * leaf resolves to root R") and negative ("this leaf is not a
 * continuation") cases in a single object shape so the cache layer's
 * skip-on-null rule (see `cache.ts`'s `getOrSet` docblock) does not
 * silently drop the negative-case entry — instead we cache the wrapper
 * object and read `.root` to recover the original `ChainLink | null`
 * return shape.
 */
interface CanonicalRootCacheEntry {
  root: ChainLink | null;
}

/**
 * Walk backward from a continuation post to find the canonical (root) post.
 * Returns null if the given post is not a continuation.
 *
 * **Two-phase forward-walker delegation.** The previous
 * implementation enforced a strict per-hop author-consent gate during the
 * backward walk, which produced a different canonical root from the
 * forward walker's cumulative-union admit-set in chains where an
 * intermediate author dropped a prior chain author from their own
 * `pevo.authors[]`. This split caused cache-data inconsistency between
 * detail-surface requests entering at different points of the same chain.
 *
 * The current shape resolves the canonical root by delegating to the
 * forward walker, which is the SSoT for "what chain a leaf belongs to":
 *
 *   1. **Backward unconstrained walk.** Walk `pevo.continues` pointers
 *      from `(author, permlink)` backward to find a candidate root `R`
 *      (the topmost ancestor with no `continues`). No per-hop
 *      author-consent gate on this pass — purely structural. Cycle
 *      detection (visited-Set keyed on `${author}/${permlink}`) and the
 *      `CANONICAL_ROOT_MAX_HOPS` depth cap are retained as DoS
 *      defenses. Emits `canonical_root_walker_cycle_detected` on cycle
 *      hit (consistent event vocabulary with the forward walker's
 *      `continuation_chain_cycle_detected`).
 *
 *   2. **Forward verify.** Call `resolveContinuationChain(R.author,
 *      R.permlink, memo, signal)` — the cumulative-aware forward walker.
 *      The resulting chain is exactly the set of posts the forward
 *      walker admits.
 *
 *   3. **Membership check (fail-CLOSED).** Test whether `(author,
 *      permlink)` is in the resulting chain using the SAME key shape as
 *      the forward walker's admit-set: `normalizeHiveAccount`-style
 *      lowercased + trimmed `(author, permlink)`. If yes, return `R` as
 *      canonical root. If not, the leaf is outside the forward walker's
 *      cumulative admit-set (attacker-injected continuation that breaks
 *      the cumulative gate); fail-CLOSED to `(author, permlink)` itself
 *      so the URL displays only the leaf's own content, never the
 *      attacker-pointed predecessor's. Mirrors the original
 *      unauthorized-hop fall-through shape: same security property,
 *      enforced by the forward walker's cumulative gate rather than a
 *      duplicated backward gate.
 *
 *   4. **Cache.** Store the resolved `(leaf → root | null)` mapping in
 *      Redis at `${appTag}:cache:canonical-root:<leaf-author>:<leaf-permlink>`
 *      (cache class adds the `${appTag}:cache:` prefix). TTL matches
 *      `CHAIN_CUMULATIVE_AUTHORS_TTL_MS` (30 min) so the canonical-root
 *      cache and the cumulative-authors cache drift on the same window
 *      and post-edit staleness closes uniformly across the chain
 *      caching surface.
 *
 * **Depth cap.** Hard-bounded at `CANONICAL_ROOT_MAX_HOPS` to prevent
 * attacker-induced DoS amplification on the backward walk.
 *
 * **Per-request memo.** Threads `HeadAuthorsMemo` into the forward
 * verify step so the per-`(author, permlink)` metadata fetched here is
 * shared with the request's other walker calls (the detail-surface
 * `resolveContinuationChain` / `reconstructVersionsFromHaf` / forward
 * walk for `fetchPaperDetailFromHaf`). Without the shared memo, the
 * forward verify would refetch metadata the detail surface also needs.
 */
async function findCanonicalRoot(
  author: string,
  permlink: string,
  memo?: HeadAuthorsMemo,
  signal?: AbortSignal,
): Promise<ChainLink | null> {
  const pool = getPool();
  if (!pool) {
    // Level discipline for canonical_root_walker_* events:
    //   - logger.warn — rare attack-signal or data-integrity paths worth
    //     operator alerting at default LOG_LEVEL=info.
    //   - logger.debug — high-frequency benign paths where warn would
    //     drown signal in noise; production must opt in via LOG_LEVEL=debug
    //     (see pino-spy-level-filter-ordering-trap-2026-05-07.md).
    // The CanonicalRootBailReason type alias is the single source of truth
    // for which reasons exist; pick the level per-reason against this rule.
    // Peer walker events (depth_exceeded, cycle_detected, walker_error)
    // follow the same rule, similarly graduated by frequency vs severity.
    logger.warn(
      {
        event: 'canonical_root_walker_no_pool',
        startAuthor: author,
        startPermlink: permlink,
      },
      'canonical-root walker bailed: HAF pool unavailable',
    );
    return null;
  }

  // Membership-check + SQL-probe key shape — lowercased + trimmed
  // `(author, permlink)` matches the forward walker's admit-set
  // construction in `extractAuthorizedContinuationAuthors` (which
  // canonicalises author values via `normalizeHiveAccount`). Hive
  // consensus restricts both account names and permlinks to lowercase
  // ascii + a small symbol set, so the HAF rows always carry lowercased
  // identifiers — the only way mixed-case can enter is through the route
  // param. The leaf-coord normalisation here serves three coupled
  // purposes:
  //
  //   1. The cache key uses the normalised shape so different-case URLs
  //      for the same chain hit the same cache entry — closing the
  //      cache-data inconsistency window between entry URLs.
  //   2. The SQL probes below pass the normalised coords as bind
  //      parameters, so a mixed-case URL still finds the corresponding
  //      HAF row (whose `c.author`/`c.permlink` values are lowercased).
  //   3. The step-3 membership check normalises both sides of the
  //      comparison so an uppercase URL still matches the lowercased
  //      chain entry.
  //
  // Without normalisation, `/api/papers/Carol/V3` would fail-CLOSE to
  // itself even when the underlying chain entry `carol/v3` is a
  // legitimate chain member — a soft-fail (URL serves the leaf as
  // standalone instead of the chain root) but still a parity bug
  // between entry URLs.
  const leafAuthorKey = (author ?? '').toLowerCase().trim();
  const leafPermlinkKey = (permlink ?? '').toLowerCase().trim();

  // Cache check: see if we've already resolved this leaf's canonical root
  // within the TTL window. The cache key uses the normalised leaf coords
  // so different-case URLs for the same chain hit the same cache entry —
  // closing the cache-data inconsistency window the previous strict
  // backward gate produced. Cache values are wrapped in
  // `CanonicalRootCacheEntry` so the negative case (`root: null`) is
  // cacheable (the cache layer's `getOrSet` drops `null` resolutions, so
  // we use raw `get`/`set` here instead).
  const cacheKey = `canonical-root:${leafAuthorKey}:${leafPermlinkKey}`;
  const cached = await hafCache.get<CanonicalRootCacheEntry>(cacheKey);
  if (cached !== undefined) {
    return cached.root;
  }

  // Capture entry time so wall-clock-exceeded warns carry the elapsed
  // signal that operators need to distinguish "budget tripped early"
  // from "budget tripped after legitimate slow hops".
  const startedAt = Date.now();

  // Pre-initial-probe abort check. The route handler's `AbortController`
  // could already have fired before we issued any SQL (e.g., a sibling
  // forward-walker call burned the budget); fail-closed to "no canonical
  // root" rather than issuing a probe we can't honor. Returning null
  // matches the existing "not a continuation post" return shape, so
  // callers handle abort identically to a benign no-result. Walker-level
  // wall-clock warn is emitted at the abort site so operators see a
  // discriminating event tag rather than just a silent return. The
  // result is NOT cached — a wall-clock-aborted resolution carries no
  // verified semantics, and caching it would lock in a degraded result
  // for the next 30 min.
  if (signal?.aborted) {
    logger.warn(
      {
        event: 'canonical_root_walker_wall_clock_exceeded',
        startAuthor: author,
        startPermlink: permlink,
        hopIndex: 0,
        elapsedMs: Date.now() - startedAt,
        budgetMs: config.hafWalkerWallClockMs,
      },
      'canonical-root walker aborted: wall-clock budget exceeded before initial probe',
    );
    return null;
  }

  try {
    // ──────────────────────────────────────────────────────────────────
    // STEP 1 — Backward unconstrained walk.
    // ──────────────────────────────────────────────────────────────────
    // Walk `pevo.continues` pointers from the leaf backward to find a
    // candidate root R (the topmost ancestor whose own post has no
    // `continues` pointer). No per-hop author-consent gate on this pass —
    // the forward verify in step 2 is the gate. The walk does retain:
    //   - Initial probe with `validPevoPaperWhere` SQL filter +
    //     `isPevoAnyPaper` JS re-check, so a type-spoofed leaf
    //     (e.g. pevo.type='review' with `continues={...}`) is rejected
    //     before any backward hops. Without this gate a vouched co-author
    //     could post a review-typed comment with `pevo.continues={...}` and
    //     the URL would surface the paper's content under the review's
    //     URL.
    //   - Cycle detection via per-call `Set<string>` keyed on
    //     `${author}/${permlink}` (consistent with the forward walker's
    //     primitive). Cycle hit emits
    //     `canonical_root_walker_cycle_detected` and stops the walk at
    //     the cycle node.
    //   - Depth cap at `CANONICAL_ROOT_MAX_HOPS` to bound the DoS
    //     amplifier surface area on the backward path.
    const startTypeFilter = validPevoPaperWhere({
      commentAlias: 'c',
      appTagParam: '$3',
      bridgeAccountParam: '$4',
      source: 'all',
    });
    const result = await pool.query(
      `SELECT c.author, c.json_metadata,
              c.json_metadata -> $3 -> 'continues' ->> 'author' AS cont_author,
              c.json_metadata -> $3 -> 'continues' ->> 'permlink' AS cont_permlink
       FROM ${T.comments} c
       WHERE c.author = $1 AND c.permlink = $2
         AND c.parent_author = '' AND c.parent_permlink = $3
         AND c.json_metadata -> $3 -> 'continues' IS NOT NULL
         AND ${startTypeFilter}`,
      [leafAuthorKey, leafPermlinkKey, config.appTag, config.hiveBridgeAccount],
    );

    if (result.rows.length === 0) {
      // Either the post does not exist, has no `continues` pointer, or
      // the SQL-side `validPevoPaperWhere` filter rejected it (e.g.
      // type-spoof: pevo.type='review' on a post claiming to continue a
      // paper). Tagged `sql_filter_or_missing` so a layer-pinning canary
      // can pin the SQL filter as the kill mechanism.
      //
      // Emitted at debug because this fires on every 404 lookup of a
      // non-PEvO post. Production observability requires `LOG_LEVEL=debug`.
      // See `agents/docs/solutions/conventions/pino-spy-level-filter-ordering-trap-2026-05-07.md`.
      const reason: CanonicalRootBailReason = 'sql_filter_or_missing';
      logger.debug(
        {
          event: 'canonical_root_walker_start_invalid',
          reason,
          startAuthor: author,
          startPermlink: permlink,
        },
        'canonical-root walker rejected START: SQL filter rejected or no row',
      );
      // Negative cache: the leaf is not a continuation post. Re-checking
      // on every request would be wasteful for the common case
      // (single-link papers, ~95% of corpus).
      await hafCache.set(cacheKey, { root: null }, CHAIN_CUMULATIVE_AUTHORS_TTL_MS);
      return null;
    }

    // JS-side defense-in-depth re-check that the START is itself a valid
    // PEvO paper (native or bridge, identity-pinned). A drift between the
    // SQL `validPevoPaperWhere` filter and the JS `isPevoAnyPaper` check
    // (e.g. a future SQL refactor that drops the type predicate, or a
    // future HAF column-shape change) would be caught here.
    const startRow = result.rows[0] as Record<string, unknown>;
    const startMeta = parseMeta(startRow.json_metadata);
    if (typeof startRow.author !== 'string' || !isPevoAnyPaper(startMeta, startRow.author)) {
      const reason: CanonicalRootBailReason = 'js_is_pevo_any_paper';
      logger.warn(
        {
          event: 'canonical_root_walker_start_invalid',
          reason,
          startAuthor: author,
          startPermlink: permlink,
        },
        'canonical-root walker rejected START: JS isPevoAnyPaper re-check failed',
      );
      // Negative cache (same rationale as the sql_filter_or_missing
      // branch above).
      await hafCache.set(cacheKey, { root: null }, CHAIN_CUMULATIVE_AUTHORS_TTL_MS);
      return null;
    }

    // Type-narrow the cont_author / cont_permlink columns. HAF could in
    // principle return NULL columns; bare `as string` would silently
    // coerce undefined/null and let downstream identity checks evaluate
    // against a non-string. Mirrors the forward walker's typed-narrow
    // discipline at `fetchHeadAuthorizedAuthors`.
    if (typeof startRow.cont_author !== 'string' || typeof startRow.cont_permlink !== 'string') {
      const reason: CanonicalRootBailReason = 'cont_columns_invalid';
      logger.warn(
        {
          event: 'canonical_root_walker_start_invalid',
          reason,
          startAuthor: author,
          startPermlink: permlink,
        },
        'canonical-root walker rejected START: cont_author/cont_permlink not string',
      );
      await hafCache.set(cacheKey, { root: null }, CHAIN_CUMULATIVE_AUTHORS_TTL_MS);
      return null;
    }

    // Tracks the deepest verified backward-walk node — initially the
    // post directly pointed at by the leaf's `continues` field, advanced
    // on each accepted hop.
    let currentAuthor: string = startRow.cont_author;
    let currentPermlink: string = startRow.cont_permlink;

    // Per-walker-call visited set for cycle detection. Keys match the
    // `memoKey` shape so cycle short-circuit happens at O(N_unique_nodes)
    // instead of O(CANONICAL_ROOT_MAX_HOPS) on attacker-posted cycles
    // (mutually authorized co-authors broadcast continuations covering
    // each other: A → B → A). Seeded with the leaf (the node the walker
    // is descending from) AND the initial predecessor (the first node
    // `cont_author/cont_permlink` resolves to), because both are nodes
    // the walker has touched before the loop. Without seeding both, a
    // 2-cycle A → B → A burns 2-3 SQL queries before detection; with
    // both seeded, it short-circuits at the first advancement. The
    // depth cap is the attacker-amplifier backstop; cycle detection is
    // the structural short-circuit on top.
    const visited = new Set<string>([
      memoKey(leafAuthorKey, leafPermlinkKey),
      memoKey(currentAuthor, currentPermlink),
    ]);

    // Backward-walk depth cap loop. The loop runs at most
    // `CANONICAL_ROOT_MAX_HOPS` iterations; on each iteration it either
    // finds the root (no further continues pointer) or advances one hop
    // further back. The depth cap is the DoS-amplifier defense; the
    // structural cycle short-circuit lives inside the loop.
    for (let i = 0; i < CANONICAL_ROOT_MAX_HOPS; i++) {
      if (signal?.aborted) {
        logger.warn(
          {
            event: 'canonical_root_walker_wall_clock_exceeded',
            startAuthor: author,
            startPermlink: permlink,
            hopIndex: i,
            elapsedMs: Date.now() - startedAt,
            budgetMs: config.hafWalkerWallClockMs,
          },
          'canonical-root walker aborted: wall-clock budget exceeded mid-walk',
        );
        // Wall-clock abort — step 2 forward verify cannot proceed. Skip
        // it and fall through to a fail-CLOSED return of the original
        // leaf coords. The result is NOT cached (per the same rationale
        // as the pre-walk abort branch above).
        return null;
      }

      // Probe the current node's continues pointer.
      const parentResult = await pool.query(
        `SELECT c.json_metadata -> $3 -> 'continues' ->> 'author' AS cont_author,
                c.json_metadata -> $3 -> 'continues' ->> 'permlink' AS cont_permlink
         FROM ${T.comments} c
         WHERE c.author = $1 AND c.permlink = $2
           AND c.parent_author = '' AND c.parent_permlink = $3
           AND c.json_metadata -> $3 -> 'continues' IS NOT NULL`,
        [currentAuthor, currentPermlink, config.appTag],
      );

      if (parentResult.rows.length === 0 || !parentResult.rows[0].cont_author) {
        // currentAuthor/currentPermlink is the candidate root R for
        // step 2's forward verify.
        break;
      }

      const parentRow = parentResult.rows[0] as Record<string, unknown>;
      if (typeof parentRow.cont_author !== 'string' || typeof parentRow.cont_permlink !== 'string') {
        // HAF data-integrity surprise; treat current as the candidate
        // root (fail-closed: do not advance with an undefined identity).
        break;
      }

      currentAuthor = parentRow.cont_author;
      currentPermlink = parentRow.cont_permlink;

      const visitedKey = memoKey(currentAuthor, currentPermlink);
      if (visited.has(visitedKey)) {
        logger.warn(
          {
            event: 'canonical_root_walker_cycle_detected',
            startAuthor: author,
            startPermlink: permlink,
            cycleAuthor: currentAuthor,
            cyclePermlink: currentPermlink,
            hopIndex: i,
          },
          'canonical-root walker detected cycle in continuation pointers',
        );
        // Cycle hit — break out and let step 2 forward verify decide
        // whether the cycle node admits the leaf. Forward walker's own
        // cycle detection will catch the cycle on the verify pass too;
        // both halves emit their own discriminating event.
        break;
      }
      visited.add(visitedKey);

      // Continue the walk only if the depth budget remains. On the
      // final iteration we hit this point and fall through to the
      // depth-cap warn below.
      if (i === CANONICAL_ROOT_MAX_HOPS - 1) {
        logger.warn(
          {
            event: 'canonical_root_walker_depth_exceeded',
            startAuthor: author,
            startPermlink: permlink,
            stopAuthor: currentAuthor,
            stopPermlink: currentPermlink,
            maxHops: CANONICAL_ROOT_MAX_HOPS,
          },
          'canonical-root walker exceeded depth cap; stopping walk',
        );
        break;
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // STEP 2 — Forward verify.
    // ──────────────────────────────────────────────────────────────────
    // Resolve the chain that the candidate root admits via the
    // cumulative-aware forward walker. This is the SSoT for "what chain
    // a leaf belongs to"; any divergence between forward and backward
    // walker semantics dissolves by construction because the backward
    // walker no longer maintains its own admit-set. Threads the shared
    // `HeadAuthorsMemo` so per-`(author, permlink)` metadata fetched
    // here is reused by the request's subsequent detail-surface walker
    // calls.
    if (signal?.aborted) {
      logger.warn(
        {
          event: 'canonical_root_walker_wall_clock_exceeded',
          startAuthor: author,
          startPermlink: permlink,
          hopIndex: CANONICAL_ROOT_MAX_HOPS,
          elapsedMs: Date.now() - startedAt,
          budgetMs: config.hafWalkerWallClockMs,
        },
        'canonical-root walker aborted: wall-clock budget exceeded before forward verify',
      );
      return null;
    }
    const { chain: forwardChain, degraded: forwardDegraded } = await resolveContinuationChain(
      currentAuthor,
      currentPermlink,
      memo,
      signal,
    );

    // Post-forward-verify abort re-check. The forward walker swallows its
    // own wall-clock abort by returning whatever chain it has accumulated
    // so far (possibly just the candidate root). If we fall through to the
    // membership check with a truncated chain, a legitimate deep-chain
    // leaf evaluates `isMember === false` and the negative-result branch
    // would cache `{root: null}` for the full TTL. Skip the cache write on
    // abort, mirroring the pre-step-2 abort branch (and the mid-loop abort
    // branch inside the backward walk).
    if (signal?.aborted) {
      logger.warn(
        {
          event: 'canonical_root_walker_wall_clock_exceeded',
          startAuthor: author,
          startPermlink: permlink,
          forwardChainLength: forwardChain.length,
          elapsedMs: Date.now() - startedAt,
          budgetMs: config.hafWalkerWallClockMs,
        },
        'canonical-root walker aborted: wall-clock budget exceeded during forward verify',
      );
      return null;
    }

    // ──────────────────────────────────────────────────────────────────
    // STEP 3 — Membership check (fail-CLOSED).
    // ──────────────────────────────────────────────────────────────────
    // The forward chain entries carry `c.author` / `c.permlink` straight
    // from HAF, which Hive consensus stores in normalised form
    // (lowercase ascii, no whitespace). Apply the same normalisation to
    // the leaf coords (which arrive from the route params and may carry
    // uppercase chars or surrounding whitespace) so a mixed-case URL
    // hits a lowercased chain entry. Without this, a
    // `/api/papers/Carol/V3` URL would fail-CLOSE to itself even when
    // carol/v3 is a legitimate member of the chain.
    const isMember = forwardChain.some((link) =>
      link.author.toLowerCase().trim() === leafAuthorKey &&
      link.permlink.toLowerCase().trim() === leafPermlinkKey,
    );

    let resolved: ChainLink | null;
    if (isMember && forwardChain.length > 0) {
      // The leaf belongs to the forward walker's admit-set. The chain's
      // first entry is the canonical root by construction
      // (`resolveContinuationChain` walks from root to head).
      resolved = { author: forwardChain[0].author, permlink: forwardChain[0].permlink };
    } else {
      // Fail-CLOSED: the leaf is outside the forward walker's admit-set
      // (attacker-injected continuation pointer, or a cumulative-gate
      // rejection). Surface the leaf's own content at its URL, never
      // the attacker-pointed predecessor's. The same security property
      // the previous per-hop backward gate enforced, now enforced via
      // the forward walker's cumulative gate.
      logger.warn(
        {
          event: 'canonical_root_walker_membership_failed',
          startAuthor: author,
          startPermlink: permlink,
          candidateRootAuthor: currentAuthor,
          candidateRootPermlink: currentPermlink,
          forwardChainLength: forwardChain.length,
        },
        'canonical-root walker rejected leaf: not in forward verify chain (fail-CLOSED)',
      );
      // Return null rather than `{author, permlink}` because the route
      // handler treats a null return identically (uses the original
      // leaf coords). Mirrors the previous "not a continuation post"
      // sentinel.
      resolved = null;
    }

    // ──────────────────────────────────────────────────────────────────
    // STEP 4 — Cache.
    // ──────────────────────────────────────────────────────────────────
    // Stable for the 30-min TTL window. Continuation pointers can be
    // edited within Hive's 7-day edit window, which can shift the
    // forward walker's resolution; matching the cumulative-authors
    // cache TTL (`CHAIN_CUMULATIVE_AUTHORS_TTL_MS`) means both caches
    // drift on the same window and post-edit staleness closes
    // uniformly. The membership-failed branch is also cached so a
    // repeated attacker-URL request does not re-walk on each hit.
    //
    // Negative-cache gate: a membership-failed negative (`resolved === null`)
    // is only cached when the forward verify walk terminated cleanly. A
    // degraded forward walk (swallowed SQL error, empty/failed head-authors
    // fetch, cycle, or depth-cap truncation — NOT abort, which the
    // signal?.aborted re-check above already handles) can drop a legitimate
    // deep-chain leaf from the chain, so membership fails for a real member
    // and `{ root: null }` would lock a false negative in for the full TTL,
    // even after HAF recovers within seconds. Positive resolutions are always
    // cached (the leaf was found, and truncation beyond it does not change
    // root = chain[0]); a clean negative (the leaf genuinely outside a fully
    // walked chain) still caches.
    if (resolved !== null || !forwardDegraded) {
      await hafCache.set(cacheKey, { root: resolved }, CHAIN_CUMULATIVE_AUTHORS_TTL_MS);
    } else {
      logger.debug(
        {
          event: 'canonical_root_walker_degraded_negative_uncached',
          startAuthor: author,
          startPermlink: permlink,
          forwardChainLength: forwardChain.length,
        },
        'canonical-root walker skipped negative cache: forward verify chain degraded (partial), not a clean miss',
      );
    }
    return resolved;
  } catch (err) {
    logger.error(
      {
        event: 'canonical_root_walker_error',
        err,
        startAuthor: author,
        startPermlink: permlink,
      },
      'Canonical root lookup failed',
    );
    return null;
  }
}

/** A fully reconstructed version with body content. */
interface ReconstructedVersion extends PaperVersionEntry {
  body: string;
  json_metadata: Record<string, unknown>;
  /** Author of the post this version came from (for continuation chains). */
  post_author: string;
  /** Permlink of the post this version came from (for continuation chains). */
  post_permlink: string;
}

/**
 * Apply a Hive `@@`-format diff patch to a base string.
 * If the body does NOT start with `@@`, it's treated as a full replacement.
 */
function applyHivePatch(base: string, raw: string): string {
  if (!raw.startsWith('@@')) return raw;
  const patches = dmp.patch_fromText(raw);
  const [result] = dmp.patch_apply(patches, base);
  return result;
}

/**
 * Fetch all comment operations and reconstruct full body at each version
 * by replaying `@@` diff patches. Resolves continuation chains: fetches
 * operations for all posts in the chain, ordered by block_num.
 * Continuation post first operations are always full body (not diffs of
 * the previous chain link). Returns versions in chronological order.
 *
 * @param prefetchedChain - optionally pass the already-resolved continuation
 *   chain to avoid duplicate `resolveContinuationChain`/`fetchHeadAuthorizedAuthors`
 *   queries. `fetchPaperDetailFromHaf` resolves the chain itself; passing it
 *   in here halves the HAF query count for an uncached paper-detail request.
 * @param memo - optional per-request `HeadAuthorsMemo` so the internal
 *   `resolveContinuationChain` call shares cached metadata fetches with the
 *   request's other walkers (the backward `findCanonicalRoot` and the
 *   primary `fetchPaperDetailFromHaf` forward walk). Without this, the
 *   `?version=N` cache-miss branch and the metadata-restored fallback both
 *   re-fire the head-authors lookup, defeating the per-request memo.
 */
async function reconstructVersionsFromHaf(
  author: string,
  permlink: string,
  prefetchedChain?: ChainLink[],
  memo?: HeadAuthorsMemo,
  signal?: AbortSignal,
): Promise<ReconstructedVersion[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    // Resolve continuation chain to get all (author, permlink) pairs.
    // Caller may pass it in to avoid the duplicate fetch.
    const chain = prefetchedChain ?? (await resolveContinuationChain(author, permlink, memo, signal)).chain;

    // Defense-in-depth abort check before the per-chain version replay
    // query. The forward walker (`resolveContinuationChain`) emits its
    // own wall-clock warn on abort; if budget tripped during that walk
    // the chain is partial — proceed with the partial chain rather than
    // throwing, mirroring how the function handles other no-result paths.
    if (signal?.aborted) return [];

    // Build a query that fetches operations for ALL posts in the chain
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;
    for (const link of chain) {
      conditions.push(`(co.author = $${paramIdx++} AND co.permlink = $${paramIdx++})`);
      params.push(link.author, link.permlink);
    }

    const result = await pool.query(
      `SELECT
         ROW_NUMBER() OVER (ORDER BY co.block_num)::int AS version_number,
         co.block_num,
         co.author,
         co.permlink,
         co.title,
         co.body,
         co.timestamp AS created,
         co.json_metadata
       FROM ${T.commentOps} co
       WHERE ${conditions.join(' OR ')}
       ORDER BY co.block_num ASC`,
      params,
    );

    const rows = result.rows as Array<Record<string, unknown>>;
    const versions: ReconstructedVersion[] = [];
    // Track per-post body state for diff application (diffs are per-post, not cross-post)
    const bodyByPost = new Map<string, string>();
    let prevTitle = '';
    let lastGoodMeta: Record<string, unknown> | null = null;
    // Track which posts we've seen their first operation for
    const seenFirstOp = new Set<string>();
    // Track per-post pevo.authors[] state for the audit-log: emit a warn
    // event whenever a paper edit mutates pevo.authors[] (TOCTOU residual
    // mitigation per task hold-block item 4b — operators correlate
    // post-incident).
    const authorsByPost = new Map<string, string>();

    for (const r of rows) {
      const postKey = `${r.author}/${r.permlink}`;
      const rawBody = (r.body as string) || '';
      const rawTitle = (r.title as string) || '';

      const isFirstOpForPost = !seenFirstOp.has(postKey);
      seenFirstOp.add(postKey);

      const prevBodyForPost = bodyByPost.get(postKey) || '';
      let body: string;

      if (isFirstOpForPost && chain.length > 1 && postKey !== `${chain[0].author}/${chain[0].permlink}`) {
        // Continuation post first operation: always full body (not diff of previous chain link)
        body = rawBody;
      } else {
        // Same-post edit: apply diff against previous body of THIS post
        body = applyHivePatch(prevBodyForPost, rawBody);
      }
      bodyByPost.set(postKey, body);

      const title = rawTitle || prevTitle;

      const isContentRevision =
        versions.length === 0 || body !== prevBodyForPost || title !== prevTitle || isFirstOpForPost;

      let meta = parseMeta(r.json_metadata);

      if (isPevoAnyPaper(meta, r.author as string)) {
        lastGoodMeta = meta;
      } else if (lastGoodMeta) {
        meta = { ...meta, app: lastGoodMeta.app, [config.appTag]: lastGoodMeta[config.appTag] };
      }

      // Extract addresses_reviews from version metadata
      const pevo = safePevoMeta(meta);
      const addressesReviews = (pevo.addresses_reviews as Array<{ author: string; permlink: string }>) || undefined;

      // Audit log: emit a structured warn whenever a paper edit mutates
      // `pevo.authors[]`. Pairs with the head-meta override subset-check
      // above to provide post-incident operator correlation for the
      // TOCTOU author-set-expansion concern (task hold-block item 4b).
      // Compare structurally (JSON stringify) so any change to the array
      // shape — add, remove, reorder, hive-rename — surfaces an event.
      const authorsRaw = Array.isArray(pevo.authors) ? pevo.authors : [];
      const authorsKey = JSON.stringify(authorsRaw);
      const prevAuthorsKey = authorsByPost.get(postKey);
      if (prevAuthorsKey !== undefined && prevAuthorsKey !== authorsKey) {
        logger.warn(
          {
            event: 'paper_authors_metadata_edit',
            postAuthor: r.author as string,
            postPermlink: r.permlink as string,
            blockNum: Number(r.block_num),
            prevAuthors: prevAuthorsKey,
            newAuthors: authorsKey,
          },
          'paper edit mutated pevo.authors[]',
        );
      }
      authorsByPost.set(postKey, authorsKey);

      versions.push({
        version_number: r.version_number as number,
        block_num: Number(r.block_num),
        created: r.created as string,
        title,
        body,
        is_content_revision: isContentRevision,
        json_metadata: meta,
        post_author: r.author as string,
        post_permlink: r.permlink as string,
        author: r.author as string,
        permlink: r.permlink as string,
        addresses_reviews: addressesReviews,
      });

      prevTitle = title;
    }

    return versions;
  } catch (err) {
    logger.error({ err }, 'HAF version reconstruction failed');
    return [];
  }
}

/** Return version metadata only (no bodies). */
async function resolveVersionsFromHaf(
  author: string,
  permlink: string,
  memo?: HeadAuthorsMemo,
  signal?: AbortSignal,
): Promise<PaperVersionEntry[]> {
  const versions = await reconstructVersionsFromHaf(author, permlink, undefined, memo, signal);
  return versions.map(({ body: _body, json_metadata: _meta, post_author: _pa, post_permlink: _pp, ...entry }) => entry);
}

interface RetractionEntry {
  author: string;
  permlink: string;
  reason: string | null;
  timestamp: string | null;
}

async function loadRetractedPapers(): Promise<RetractionEntry[]> {
  const pool = getPool();
  if (!pool) return [];

  const result = await pool.query(
    `SELECT
       cj.json::jsonb ->> 'author' AS author,
       cj.json::jsonb ->> 'permlink' AS permlink,
       cj.json::jsonb ->> 'reason' AS reason,
       cj.json::jsonb ->> 'timestamp' AS ts
     FROM ${T.customJson} cj
     WHERE cj.custom_id = $1
       AND cj.json::jsonb ->> 'action' = 'retract_paper'
       AND cj.required_posting_auths ? $2`,
    [config.appTag, config.hiveAdminAccount],
  );
  return result.rows.map((r: Record<string, unknown>) => ({
    author: r.author as string,
    permlink: r.permlink as string,
    reason: (r.reason as string) || null,
    timestamp: (r.ts as string) || null,
  }));
}

async function getRetractionInfo(author: string, permlink: string): Promise<{ is_retracted: boolean; retraction_reason?: string | null; retraction_timestamp?: string | null }> {
  try {
    const allRetracted = await hafCache.get<RetractionEntry[]>('retracted-papers') ?? [];
    const entry = allRetracted.find((r) => r.author === author && r.permlink === permlink);
    if (entry) {
      return { is_retracted: true, retraction_reason: entry.reason, retraction_timestamp: entry.timestamp };
    }
  } catch (err) {
    logger.error({ err }, 'Failed to load retracted papers');
  }
  return { is_retracted: false, retraction_reason: null, retraction_timestamp: null };
}

/** Register periodic refresh for retracted papers cache. */
export async function startRetractionCache(): Promise<void> {
  await hafCache.registerPeriodicRefresh('retracted-papers', loadRetractedPapers, 24 * 60 * 60_000);
  logger.info('Retracted papers cache loaded');
}

function buildPaperDetail(
  post: Record<string, unknown>,
  meta: Record<string, unknown>,
  reviews: unknown[],
) {
  const pevo = safePevoMeta(meta);
  return {
    author: post.author,
    permlink: post.permlink,
    title: post.title,
    body: post.body,
    abstract: extractAbstract(post.body as string),
    json_metadata: meta,
    created: post.created,
    last_update: post.last_edited || post.last_update || post.created,
    net_votes: post.net_votes ?? 0,
    discipline: paperDisciplineField(pevo.discipline),
    keywords: pevoStringArray(pevo, 'keywords'),
    authors: pevo.authors || [],
    ipfs_cid: validatedCid(pevoString(pevo, 'ipfs_cid'), {
      author: post.author as string,
      permlink: post.permlink as string,
    }),
    ipfs_filename: pevoString(pevo, 'ipfs_filename'),
    document_hash: pevoString(pevo, 'document_hash'),
    language: pevoString(pevo, 'language') ?? 'en',
    citations: pevo.citations || [],
    citation_count: 0,
    author_reputation: 0,
    is_accredited: false,
    accredited_authors: [] as string[],
    reviews,
    versions: [] as PaperVersionEntry[],
    is_retracted: false,
    retraction_reason: null as string | null,
    retraction_timestamp: null as string | null,
    supplementary_files: pevo.supplementary_files || [],
    metadata_restored: false,
    // E7: For non-continuation papers, canonical = head = self
    canonical_author: post.author as string,
    canonical_permlink: post.permlink as string,
    head_author: post.author as string,
    head_permlink: post.permlink as string,
  };
}

router.get('/:author/:permlink', async (req: Request, res: Response) => {
  let author = req.params.author as string;
  let permlink = req.params.permlink as string;
  const requestedVersion = req.query.version ? parseInt(req.query.version as string, 10) : null;

  if (requestedVersion !== null && isNaN(requestedVersion)) {
    return sendError(res, 400, 'BAD_REQUEST', 'version must be an integer');
  }

  // Per-request memo for `fetchHeadAuthorizedAuthors`. Shared between the
  // backward walker (`findCanonicalRoot`) and the forward walker
  // (`resolveContinuationChain` via `fetchPaperDetailFromHaf`) so they do
  // not re-fetch metadata for the same `(author, permlink)`.
  const headAuthorsMemo = makeHeadAuthorsMemo();

  // Per-request wall-clock budget for the chain walkers. Bounds
  // worker-thread starvation under degraded HAF (each per-query
  // statement_timeout=30s × walker hop cap = up to 10/25-minute tail
  // before the depth cap exits). The signal threads through both
  // walkers (`findCanonicalRoot` backward, `resolveContinuationChain`
  // forward via `fetchPaperDetailFromHaf`/`reconstructVersionsFromHaf`)
  // so the budget covers the full per-request walker-chain
  // (cascading helper calls included). On abort the walkers emit
  // `canonical_root_walker_wall_clock_exceeded` or
  // `continuation_chain_wall_clock_exceeded` and stop at the deepest
  // verified node / return the chain so far.
  //
  // **Real worst-case per request = `hafWalkerWallClockMs` + `statement_timeout`.**
  // The signal stops NEW queries from starting; in-flight `pool.query`
  // continues until PostgreSQL's `statement_timeout` (30s) resolves it —
  // pg v8.x does NOT support `AbortSignal` in `pool.query`. At the 3000ms
  // default the per-request ceiling is ~33s rather than 3s, still 18-45×
  // improvement over the pre-fix 10/25-min tail. See `config.ts`'s
  // `hafWalkerWallClockMs` docblock for tuning guidance.
  //
  // Knob: `config.hafWalkerWallClockMs` (`HAF_WALKER_WALL_CLOCK_MS` env).
  // Default 3000ms (typical HAF response 50-200ms × 10-15-query depth).
  const walkerAbort = new AbortController();
  const walkerBudget = setTimeout(() => walkerAbort.abort(), config.hafWalkerWallClockMs);
  try {
    // E4: If this is a continuation post, redirect to the canonical root paper
    const canonicalRoot = await findCanonicalRoot(author, permlink, headAuthorsMemo, walkerAbort.signal);
    if (canonicalRoot) {
      author = canonicalRoot.author;
      permlink = canonicalRoot.permlink;
    }

    if (requestedVersion !== null) {
      const cacheKey = `paper-detail:${author}:${permlink}:v${requestedVersion}`;
      const cached = await hafCache.getOrSet(cacheKey, async () => {
        const versions = await reconstructVersionsFromHaf(author, permlink, undefined, headAuthorsMemo, walkerAbort.signal);
        if (versions.length === 0) return null;

        // Paper identity is established by the first version (original publication).
        // External edits may overwrite json_metadata, so don't check later versions.
        if (!isPevoAnyPaper(versions[0].json_metadata, versions[0].post_author)) return null;

        const target = versions.find((v) => v.version_number === requestedVersion);
        if (!target) return null;

        // Use this version's metadata (IPFS CID, authors, etc.) but fall back to
        // the original publication's PEvO metadata for fields external edits may strip.
        const meta = target.json_metadata;
        const post = { author, permlink, title: target.title, body: target.body, json_metadata: meta, created: target.created, last_edited: target.created };
        const detail = buildPaperDetail(post, meta, []);
        detail.versions = versions.map(({ body: _b, json_metadata: _m, ...entry }) => entry);

        // Supersession (`hive-schemas.md` § 1.1) on the JS-reconstructed
        // authors array: this branch builds `detail` from a version row
        // without running the SQL-side `authorsWithSupersessionSelect`
        // projection, so apply the same rule in JS via the per-request
        // ORCID + attested-name maps (ORCID + name supersession and the
        // name fallback chain).
        const [orcidMapForVersion, nameMapForVersion] = await Promise.all([
          getAccreditedOrcidsByAccount(),
          getAccreditedNamesByAccount(),
        ]);
        detail.authors = applyAuthorSupersession(detail.authors, orcidMapForVersion, nameMapForVersion);

        const retraction = await getRetractionInfo(author, permlink);
        detail.is_retracted = retraction.is_retracted;
        detail.retraction_reason = retraction.retraction_reason ?? null;
        detail.retraction_timestamp = retraction.retraction_timestamp ?? null;

        return detail;
      }, 30 * 60_000, true);

      if (walkerAbort.signal.aborted) {
        return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'HAF walker budget exceeded; please retry', { retriable: true });
      }
      if (cached) return sendOk(res, cached);
      return sendError(res, 404, 'NOT_FOUND', 'Version not found');
    }

    const cacheKey = `paper-detail:${author}:${permlink}`;
    const cached = await hafCache.getOrSet(cacheKey, async () => {
      const hafResult = await fetchPaperDetailFromHaf(author, permlink, headAuthorsMemo, walkerAbort.signal);
      if (hafResult) return hafResult;

      // If current metadata was stripped by an external edit, reconstruct from
      // version history. The first version establishes paper identity; later
      // versions inherit PEvO metadata when the editing frontend dropped it.
      const versions = await reconstructVersionsFromHaf(author, permlink, undefined, headAuthorsMemo, walkerAbort.signal);
      if (versions.length > 0 && isPevoAnyPaper(versions[0].json_metadata, versions[0].post_author)) {
        const latest = versions[versions.length - 1];
        const meta = latest.json_metadata;
        const post = { author, permlink, title: latest.title, body: latest.body, json_metadata: meta, created: versions[0].created, last_edited: latest.created };
        const detail = buildPaperDetail(post, meta, []);
        detail.versions = versions.map(({ body: _b, json_metadata: _m, ...entry }) => entry);
        detail.metadata_restored = true;

        // Supersession on the metadata-restored fallback. Same shape as
        // the ?version=N branch above.
        const [orcidMapForRestored, nameMapForRestored] = await Promise.all([
          getAccreditedOrcidsByAccount(),
          getAccreditedNamesByAccount(),
        ]);
        detail.authors = applyAuthorSupersession(detail.authors, orcidMapForRestored, nameMapForRestored);

        const retraction = await getRetractionInfo(author, permlink);
        detail.is_retracted = retraction.is_retracted;
        detail.retraction_reason = retraction.retraction_reason ?? null;
        detail.retraction_timestamp = retraction.retraction_timestamp ?? null;

        return detail;
      }

      return null;
    }, 30 * 60_000, true);

    if (walkerAbort.signal.aborted) {
      return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'HAF walker budget exceeded; please retry', { retriable: true });
    }
    if (cached) return sendOk(res, cached);
    sendError(res, 404, 'NOT_FOUND', 'Paper not found');
  } catch (err) {
    if (err instanceof HafQueryError && isRetriableHafError(err)) {
      // Cause-discriminated retriable envelope. Deterministic pg failures
      // (syntax error, permission error, data-type mismatch) fall through
      // to the central 500 handler so the SPA's retry-on-503-retriable
      // loop doesn't hammer a dead query.
      return sendError(
        res,
        503,
        'SERVICE_UNAVAILABLE',
        'Paper detail temporarily unavailable. Please retry shortly.',
        { retriable: true },
      );
    }
    throw err;
  } finally {
    clearTimeout(walkerBudget);
  }
});

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink/enrichment
// ──────────────────────────────────────────────

async function fetchEnrichmentFromHaf(author: string, permlink: string, signal?: AbortSignal) {
  const pool = getPool();
  if (!pool) return null;

  // Per-request memo for `fetchHeadAuthorizedAuthors`. Threaded into
  // `resolveVersionsFromHaf` so that within a single enrichment request, the
  // forward-walker lookups initiated by `reconstructVersionsFromHaf` share the
  // catch-block negative-cache benefit (third call site for memo threading,
  // paralleling the `?version=N` branch and the metadata-restored fallback
  // in the GET /:author/:permlink handler).
  const headAuthorsMemo = makeHeadAuthorsMemo();

  try {
    const accreditedAccounts = await getAllAccreditedAccounts();
    const accreditedArr = [...accreditedAccounts];
    // Include anonymous posting account so anonymous reviews appear
    const reviewAuthors = config.hiveAnonAccount
      ? [...accreditedArr, config.hiveAnonAccount]
      : accreditedArr;

    // authorship_claims scoped to THIS paper, so excludeClaimedSelfWhere can drop
    // a credited claimer's self-review (ORCID / name-only slot — absent from
    // authors[].hive) from the enrichment review list, mirroring the cycle gate.
    // Param indices for the reviews query derive from this CTE's nextIdx via the
    // counter below so the prepended CTE params shift them automatically.
    const detailCte = buildWith(1, activeAccreditationsCteBody, (idx) => authorshipClaimsCteBody(idx, { paperAuthor: author, paperPermlink: permlink }));
    let drIdx = detailCte.nextIdx;
    const drAuthorIdx = drIdx++;
    const drPermlinkIdx = drIdx++;
    const drAppTagIdx = drIdx++;
    const drAccreditedIdx = drIdx++;
    const drReviewAuthorsIdx = drIdx++;
    const drBridgeIdx = drIdx++;
    // The vote query binds only 3 trailing params (author, permlink, accreditedArr),
    // so accreditedArr lands at drAuthorIdx + 2 — numerically equal to drAppTagIdx
    // by coincidence of the current layout, not by design. Bind it through its own
    // named slot so a future param insertion cannot silently mis-bind it.
    const drVoteAccreditedIdx = drAuthorIdx + 2;

    const [voteResult, reviewsResult, versions, claimsResult] = await Promise.all([
      // Accredited voters (excluding self-votes AND credited-claimer self-votes)
      // — use vote operations to survive payout. Params (after the detailCte CTE
      // params): author, permlink, accreditedArr.
      pool.query(
        `${detailCte.sql}
         SELECT DISTINCT ON (v.voter) v.voter, v.weight, v.timestamp, v.block_num FROM ${T.voteOps} v
         WHERE v.author = $${drAuthorIdx} AND v.permlink = $${drPermlinkIdx}
           AND v.voter = ANY($${drVoteAccreditedIdx}::text[])
           AND v.voter != v.author
           AND ${excludeClaimedSelfWhere({ authorExpr: 'v.voter', paperAuthorExpr: `$${drAuthorIdx}`, paperPermlinkExpr: `$${drPermlinkIdx}` })}
         -- Same-block tie-breaker: v.id (operation_vote_view has no trx_in_block;
         -- v.id is the monotonic HAF op id) per
         -- agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md Rule 2
         ORDER BY v.voter, v.block_num DESC, v.id DESC`,
        [...detailCte.params, author, permlink, accreditedArr],
      ),
      // Reviews from accredited reviewers (+ anon account) with accredited vote count.
      // $4 = accreditedArr (used for net_votes voter gate), $5 = reviewAuthors
      // (used for c.author gate on the review row itself, includes anon proxy),
      // $6 = hiveBridgeAccount (for validPevoPaperWhere bridge-author pin).
      // The JOIN against `p` materializes the parent paper row so the
      // excludeSelfReviewWhere helper can read p.json_metadata -> authors[].
      // The JOIN is a single-row lookup keyed on (author, permlink) — the
      // planner folds it into a constant against `c`'s scan.
      //
      // Display↔reputation parity (cross-surface): without validPevoPaperWhere
      // on `p`, a directly-addressed (author, permlink) pair that isn't a
      // PEvO paper-class post (a peakd blog post, a non-paper comment) would
      // surface as an enrichment review-set while reputation correctly
      // excludes such rows via the user_reviews CTE that composes
      // validPevoPaperWhere. The route at /api/papers/<author>/<permlink>/enrichment
      // reaches this fetcher directly without the upstream paper-class gate
      // that `fetchPaperFromHaf` applies, so the gate must compose here. See
      // `agents/docs/solutions/conventions/cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md`.
      pool.query(
        `${detailCte.sql}
         SELECT c.author, c.permlink, c.body, c.json_metadata, c.created,
                (SELECT COALESCE(SUM(CASE WHEN lv.weight > 0 THEN 1 WHEN lv.weight < 0 THEN -1 ELSE 0 END), 0)::int FROM (
                   SELECT DISTINCT ON (v.voter) v.weight FROM ${T.voteOps} v
                   WHERE v.author = c.author AND v.permlink = c.permlink
                     AND v.voter = ANY($${drAccreditedIdx}::text[]) AND v.voter != v.author
                   -- Same-block tie-breaker: v.id (operation_vote_view has no trx_in_block;
                   -- v.id is the monotonic HAF op id) per
                   -- agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md Rule 2
                   ORDER BY v.voter, v.block_num DESC, v.id DESC
                 ) lv WHERE lv.weight != 0) AS net_votes
         FROM ${T.comments} c
         JOIN ${T.comments} p ON p.author = $${drAuthorIdx} AND p.permlink = $${drPermlinkIdx}
         WHERE c.parent_author = $${drAuthorIdx} AND c.parent_permlink = $${drPermlinkIdx}
           AND c.author = ANY($${drReviewAuthorsIdx}::text[])
           AND ${validReviewWhere({ commentAlias: 'c', appTagParam: `$${drAppTagIdx}` })}
           AND ${validPevoPaperWhere({ commentAlias: 'p', appTagParam: `$${drAppTagIdx}`, bridgeAccountParam: `$${drBridgeIdx}`, source: 'all' })}
           AND ${excludeSelfReviewWhere({ paperRowAlias: 'p', appTagParam: `$${drAppTagIdx}` })}
           AND ${excludeClaimedSelfWhere({ authorExpr: 'c.author', paperAuthorExpr: `$${drAuthorIdx}`, paperPermlinkExpr: `$${drPermlinkIdx}` })}
         ORDER BY c.created DESC`,
        [...detailCte.params, author, permlink, config.appTag, accreditedArr, reviewAuthors, config.hiveBridgeAccount || ''],
      ),
      // Version history (needed for review outdated computation)
      resolveVersionsFromHaf(author, permlink, headAuthorsMemo, signal),
      // Authorship claims
      (async () => {
        const cte = buildWith(1, activeAccreditationsCteBody, (idx) => authorshipClaimsCteBody(idx, { paperAuthor: author, paperPermlink: permlink }));
        return pool.query(
          `${cte.sql}
           SELECT claimer, paper_author, paper_permlink, author_index, status, claimed_at
           FROM authorship_claims
           WHERE paper_author = $${cte.nextIdx}
             AND paper_permlink = $${cte.nextIdx + 1}
             AND status != 'revoked'`,
          [...cte.params, author, permlink],
        );
      })(),
    ]);

    const latestVersion = versions.length > 0 ? versions[versions.length - 1].version_number : 1;

    // Always query revote custom_json ops for this paper. The
    // `block_num >= $genesis` floor was dropped to match the 285e7c14 fix on
    // `activeAccreditationsCteBody`: combining `custom_id = $appTag` with
    // `block_num >= $genesis` triggers a BitmapAnd plan that scans tens of
    // millions of operation rows on `hive_operations_block_num_id_idx`. This
    // query runs sequentially after the parallel batch, so its full latency
    // adds to the per-request walker budget; on the live HAF it exhausted the
    // 3000ms budget and surfaced 503 SERVICE_UNAVAILABLE on the enrichment
    // endpoint (reviews, voters, claims all silently empty on the SPA).
    const revoteResult = await pool.query(
      `SELECT cj.required_posting_auths ->> 0 AS voter,
              -- {1,9} bounds the digit count for overflow safety: an unbounded match admits a value that overflows ::int and aborts the whole query (max Hive vote weight is 10000).
              CASE WHEN (cj.json::jsonb ->> 'weight') ~ '^-?[0-9]{1,9}$' THEN (cj.json::jsonb ->> 'weight')::int END AS weight,
              cj.json::jsonb ->> 'version' AS version,
              cj.timestamp AS revote_ts,
              cj.block_num
       FROM ${T.customJson} cj
       WHERE cj.custom_id = $1
         AND cj.json::jsonb ->> 'action' = 'revote'
         AND cj.json::jsonb ->> 'author' = $2
         AND cj.json::jsonb ->> 'permlink' = $3
       ORDER BY cj.block_num DESC`,
      [config.appTag, author, permlink],
    );
    const revoteMap = new Map<string, { weight: number; timestamp: Date; block_num: number; version: number }>();
    for (const r of revoteResult.rows) {
      const voter = r.voter as string;
      const weight = Number(r.weight);
      const version = r.version;
      // Validation: required fields (author/permlink/version) and weight range
      if (!voter || version == null || isNaN(weight) || weight < -10000 || weight > 10000) {
        logger.debug({ voter, weight, author, permlink }, 'Ignoring invalid revote custom_json');
        continue;
      }
      // Only include accredited voters (excluding self-votes)
      if (!accreditedAccounts.has(voter) || voter === author) continue;
      // Keep only the latest revote per voter (already ordered by block_num DESC)
      if (!revoteMap.has(voter)) {
        revoteMap.set(voter, { weight, timestamp: new Date(r.revote_ts as string), block_num: Number(r.block_num), version: Number(version) });
      }
    }

    const reviews = reviewsResult.rows.map((r: Record<string, unknown>) => {
      const rMeta = parseMeta(r.json_metadata);
      const pevo = safePevoMeta(rMeta);
      const rating = pevo.rating as Record<string, number> | undefined;
      // Compute reviewed_version from timestamps: latest version created before this review
      const reviewCreated = new Date(r.created as string);
      let reviewedVersion = 1;
      for (const v of versions) {
        if (new Date(v.created) <= reviewCreated) {
          reviewedVersion = v.version_number;
        }
      }

      // E5: Review outdated — if paper has been updated since review
      const outdated = reviewedVersion < latestVersion;

      // E5: Find if any version explicitly addresses this review
      const reviewAuthor = r.author as string;
      const reviewPermlink = r.permlink as string;
      let addressedByVersion: number | undefined;
      for (const v of versions) {
        if (v.addresses_reviews) {
          const found = v.addresses_reviews.some(
            (ar) => ar.author === reviewAuthor && ar.permlink === reviewPermlink,
          );
          if (found) {
            addressedByVersion = v.version_number;
            break;
          }
        }
      }

      return {
        author: reviewAuthor,
        permlink: reviewPermlink,
        body: r.body as string,
        rating: rating || { methodology: 0, novelty: 0, clarity: 0, significance: 0 },
        is_anonymous: pevo.is_anonymous ?? false,
        created: r.created as string,
        net_votes: r.net_votes as number,
        reviewer_reputation: 0,
        is_accredited: accreditedAccounts.has(reviewAuthor) || (pevo.is_anonymous === true),
        reviewed_version: reviewedVersion,
        outdated,
        addressed_by_version: addressedByVersion,
      };
    });

    // Accepted-claimer self-vote exclusion. A credited claimer (ORCID / name-only
    // slot, absent from authors[].hive) must not have their self-vote on this paper
    // counted toward the displayed net_votes. The native vote SQL query already
    // drops them via excludeClaimedSelfWhere, but the revote custom_json channel is
    // resolved in JS and carries no SQL gate — so skip accepted claimers in BOTH
    // vote loops below, mirroring batchResolveVotes' claimedSet skip on the listing
    // surface. claimsResult is scoped to this paper, so the claimer name is the key.
    const acceptedClaimers = new Set<string>();
    for (const r of claimsResult.rows) {
      if (r.status === 'accepted') acceptedClaimers.add(r.claimer as string);
    }

    // Vote resolution: for each voter, pick the signal with the highest block_num
    // across native votes and revote custom_json. Handle weight=0 as retraction.
    const processedVoters = new Set<string>();
    const voters: Array<{ voter: string; weight: number; effective_weight: number; voted_version: number }> = [];

    // Build sorted version block_nums for voted_version inference
    const versionBlocks = versions
      .map(v => ({ version_number: v.version_number, block_num: v.block_num }))
      .sort((a, b) => a.block_num - b.block_num);

    // Infer voted version from a vote's block_num: latest version where version_block <= vote_block
    function inferVotedVersion(voteBlockNum: number): number {
      let result = 1;
      for (const vb of versionBlocks) {
        if (vb.block_num <= voteBlockNum) result = vb.version_number;
        else break;
      }
      return result;
    }

    // Process voters with native votes
    for (const r of voteResult.rows) {
      const voter = r.voter as string;
      // Defense-in-depth: the native SQL already excludes accepted claimers, but
      // skip here too so the revote-override branch below cannot reintroduce one.
      if (acceptedClaimers.has(voter)) continue;
      const nativeWeight = Number(r.weight);
      const nativeBlock = Number(r.block_num);
      processedVoters.add(voter);

      const revote = revoteMap.get(voter);
      // Pick latest signal by block_num
      const useRevote = revote && revote.block_num > nativeBlock;
      const effectiveSignalWeight = useRevote ? revote.weight : nativeWeight;

      // weight=0 means retracted
      if (effectiveSignalWeight === 0) continue;

      // Determine voted_version: revote has explicit version, native uses block_num inference
      const votedVersion = useRevote ? revote.version : inferVotedVersion(nativeBlock);

      voters.push({
        voter,
        weight: effectiveSignalWeight,
        effective_weight: effectiveSignalWeight,
        voted_version: votedVersion,
      });
    }

    // Process revote-only voters (no native Hive vote)
    for (const [voter, revote] of revoteMap) {
      if (processedVoters.has(voter)) continue;
      // Drop a credited claimer's self-revote: the revote channel has no SQL gate,
      // so without this an accepted claimer's revote inflates the paper-detail
      // net_votes (the listing path already excludes them via batchResolveVotes).
      if (acceptedClaimers.has(voter)) continue;
      if (revote.weight === 0) continue;

      voters.push({
        voter,
        weight: revote.weight,
        effective_weight: revote.weight,
        voted_version: revote.version,
      });
    }

    const net_votes = voters.reduce((sum, v) => sum + (v.effective_weight > 0 ? 1 : v.effective_weight < 0 ? -1 : 0), 0);
    const effectiveVoters = voters.filter(v => v.effective_weight !== 0);
    const avgWeight = effectiveVoters.length > 0
      ? effectiveVoters.reduce((sum, v) => sum + v.effective_weight, 0) / effectiveVoters.length
      : 0;
    const vote_strength = effectiveVoters.length > 0 ? voteStrengthTier(avgWeight) : null;

    const authorship_claims = claimsResult.rows.map((r: Record<string, unknown>) => ({
      claimer: r.claimer as string,
      author_index: r.author_index as number | null,
      status: r.status as string,
      claimed_at: r.claimed_at as string,
    }));

    // Cache-poisoning defense: if the wall-clock budget tripped during
    // the embedded `resolveVersionsFromHaf` walker call, `versions` is
    // empty (the version-history walker bails on abort) and `latestVersion`
    // collapses to 1. The enrichment payload would still serialize but
    // misreports review.outdated booleans against the truncated version
    // chain. Return null so `hafCache.getOrSet` leaves the cache cold;
    // the route surfaces 503 via its own `signal.aborted` check.
    if (signal?.aborted) return null;

    return {
      net_votes,
      vote_strength,
      voters,
      reviews,
      authorship_claims,
    };
  } catch (err) {
    // Loud-fail on HAF query failure so the route handler can translate
    // to `503 SERVICE_UNAVAILABLE` with `details.retriable: true` rather
    // than the pre-fix `null → 404` collapse that masked outage as
    // "paper not found".
    logger.error({ err }, 'HAF enrichment query failed');
    throw new HafQueryError('fetchEnrichmentFromHaf', { cause: err });
  }
}

router.get('/:author/:permlink/enrichment', async (req: Request, res: Response) => {
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;

  // Per-request wall-clock budget. The route reaches the walker amplifier
  // via `fetchEnrichmentFromHaf → resolveVersionsFromHaf →
  // reconstructVersionsFromHaf → resolveContinuationChain` (forward
  // walker, depth cap 50). Without this wrapper, attacker-posted long
  // chains under degraded HAF can starve worker threads for tens of
  // minutes per request, replicating the DoS amplifier closed on the
  // primary `GET /:author/:permlink` handler.
  const walkerAbort = new AbortController();
  const walkerBudget = setTimeout(() => walkerAbort.abort(), config.hafWalkerWallClockMs);
  try {
    const cacheKey = `paper-enrichment:${author}:${permlink}`;
    const cached = await hafCache.getOrSet(cacheKey, () =>
      fetchEnrichmentFromHaf(author, permlink, walkerAbort.signal),
    5 * 60_000, true);

    if (walkerAbort.signal.aborted) {
      return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'HAF walker budget exceeded; please retry', { retriable: true });
    }
    if (!cached) return sendError(res, 404, 'NOT_FOUND', 'Paper not found');
    sendOk(res, cached);
  } catch (err) {
    if (err instanceof HafQueryError && isRetriableHafError(err)) {
      // Cause-discriminated retriable envelope. Deterministic pg failures
      // (syntax error, permission error, data-type mismatch) fall through
      // to the central 500 handler so the SPA's retry-on-503-retriable
      // loop doesn't hammer a dead query.
      return sendError(
        res,
        503,
        'SERVICE_UNAVAILABLE',
        'Paper enrichment temporarily unavailable. Please retry shortly.',
        { retriable: true },
      );
    }
    throw err;
  } finally {
    clearTimeout(walkerBudget);
  }
});

// ──────────────────────────────────────────────
// E6: POST /api/papers/:author/:permlink/invalidate
// ──────────────────────────────────────────────

const invalidateLimiter = rateLimit({ name: 'cache-invalidate', windowMs: 60_000, max: 10, keyFn: byAccount });

router.post('/:author/:permlink/invalidate', verifyHiveSignature, invalidateLimiter, async (req: Request, res: Response) => {
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;

  // Invalidate all cache keys for this paper, including versioned-view
  // keys `paper-detail:{author}:{permlink}:v{N}`. Without the prefix
  // sweep, an edit to `pevo.authors[]` (which gates continuation admit)
  // would serve stale results from versioned views for up to 30 min.
  await Promise.all([
    hafCache.invalidate(`paper-detail:${author}:${permlink}`),
    hafCache.invalidate(`paper-enrichment:${author}:${permlink}`),
    // Versioned keys live under `paper-detail:{author}:{permlink}:v*`.
    // The unversioned key was already handled above; this prefix sweep
    // catches the v1, v2, ... variants.
    hafCache.invalidatePrefix(`paper-detail:${author}:${permlink}:v`),
    // Canonical-root mappings are leaf-keyed (any leaf in any chain whose
    // topology shifts post-edit can resolve differently). The leaf→root
    // function lookup is cheap to recompute, so a broad app-wide prefix
    // flush is safe. Without this, an edit to a mid-chain post's
    // `pevo.continues` pointer or `pevo.authors[]` within Hive's 7-day
    // edit window would refresh the detail cache immediately but leave
    // the canonical-root mapping cached for up to the full TTL.
    hafCache.invalidatePrefix('canonical-root:'),
    // Chain-authors cumulative-union entries are root-keyed. The
    // per-paper invalidate above does not know which root a given paper
    // belongs to (a continuation post invalidates its own detail but the
    // chain-authors entry sits under the root pair), so a broad app-wide
    // prefix flush is the only correct shape. Recompute is cheap and
    // happens lazily on the next listing/profile/detail call per root.
    hafCache.invalidatePrefix('chain-authors:'),
  ]);

  sendOk(res, { message: 'Cache invalidated' });
});

// ──────────────────────────────────────────────
// POST /api/papers/:author/:permlink/retract
// ──────────────────────────────────────────────

async function isRetracted(author: string, permlink: string): Promise<boolean> {
  const pool = getPool();
  if (pool) {
    try {
      const result = await pool.query(
        `SELECT 1 FROM ${T.customJson} cj
         WHERE cj.custom_id = $3
           AND cj.json::jsonb ->> 'action' = 'retract_paper'
           AND cj.json::jsonb ->> 'author' = $1
           AND cj.json::jsonb ->> 'permlink' = $2
           AND cj.required_posting_auths ? $4
         LIMIT 1`,
        [author, permlink, config.appTag, config.hiveAdminAccount],
      );
      return result.rows.length > 0;
    } catch (err) {
      logger.error({ err }, 'HAF retraction check failed');
    }
  }
  return false;
}

// validateRetractParams runs BEFORE verifyHiveSignature: this route's limiter
// is URL-keyed, so a structurally-invalid slug spray must be rejected without
// paying ECDSA recovery. The custody routes mount their body-shape validators
// AFTER verifyHiveSignature because their limiters are byAccount-keyed; that
// asymmetry is intentional and is documented in the validateRetractParams JSDoc.
router.post('/:author/:permlink/retract', validateRetractParams, verifyHiveSignature, retractLimiter, async (req: Request, res: Response) => {
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;
  const username = req.hiveUsername!;
  const reason = (req.body.reason as string) || '';

  // Canonical-root walker is intentionally NOT invoked here. /cite and /retract
  // operate on the URL's own (author, permlink) — citation targets the URL post
  // directly; retraction authorizes username === URL author then broadcasts on
  // the URL's coords. Canonicalization is a display concern handled by the GET
  // handler. New /api/papers/:author/:permlink/<verb> routes that want canonical
  // resolution must call findCanonicalRoot themselves; do not pattern-match this
  // handler without checking.

  // Per-request wall-clock budget. `fetchPaperDetailFromHaf` calls the
  // forward walker (`resolveContinuationChain`); without this wrapper,
  // attacker-posted long chains under degraded HAF would saturate the
  // pool here too, identical threat model to the primary GET handler.
  const walkerAbort = new AbortController();
  const walkerBudget = setTimeout(() => walkerAbort.abort(), config.hafWalkerWallClockMs);
  let detail: Record<string, unknown> | null;
  try {
    detail = await fetchPaperDetailFromHaf(author, permlink, undefined, walkerAbort.signal) as Record<string, unknown> | null;
  } catch (err) {
    if (err instanceof HafQueryError && isRetriableHafError(err)) {
      // Cause-discriminated retriable envelope. Deterministic pg failures
      // fall through to the central 500 handler.
      return sendError(
        res,
        503,
        'SERVICE_UNAVAILABLE',
        'Retraction temporarily unavailable. Please retry shortly.',
        { retriable: true },
      );
    }
    throw err;
  } finally {
    clearTimeout(walkerBudget);
  }
  if (walkerAbort.signal.aborted) {
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'HAF walker budget exceeded; please retry', { retriable: true });
  }
  if (!detail) {
    return sendError(res, 404, 'NOT_FOUND', 'Paper not found');
  }

  // Authorization: paper author, pevo.admin, or (for bridge papers) registerer or original preprint author
  let authorized = username === author || username === config.hiveAdminAccount;
  if (!authorized) {
    const meta = (detail.json_metadata || {}) as Record<string, unknown>;
    const pevo = (meta[config.appTag] || {}) as Record<string, unknown>;
    if (isPevoBridgePaper(meta, author)) {
      const source = (pevo.source || {}) as Record<string, unknown>;
      const registeredBy = source.registered_by as string | undefined;
      if (registeredBy === username) {
        authorized = true;
      } else {
        const paperAuthors = (pevo.authors || []) as Array<{ hive?: string | null }>;
        // Canonicalize the broadcaster-controlled `authors[i].hive` via
        // `normalizeHiveAccount` before comparing against the chain-validated
        // (always-lowercase) `username`. A `pevo.authors[]` entry posted as
        // `{hive: 'Alice'}` would otherwise byte-mismatch and reject a
        // legitimate original-author's retract request on a bridge paper.
        authorized = paperAuthors.some((a) => normalizeHiveAccount(a.hive) === username);
      }
    }
  }
  if (!authorized) {
    return sendError(res, 403, 'FORBIDDEN', `Only the paper author, ${config.hiveAdminAccount}, or (for bridge papers) the registerer or an original author can retract`);
  }

  // Check not already retracted
  if (await isRetracted(author, permlink)) {
    return sendError(res, 422, 'VALIDATION_ERROR', 'Paper is already retracted');
  }

  // Broadcast retract_paper custom_json
  if (!config.pevoAdminPostingKey) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'Admin posting key not configured');
  }

  const payload = {
    action: 'retract_paper',
    author,
    permlink,
    reason,
    timestamp: new Date().toISOString(),
  };

  try {
    const key = PrivateKey.fromString(config.pevoAdminPostingKey);
    const result = await broadcastJsonWithTimeout(
      { id: config.appTag, json: JSON.stringify(payload), required_auths: [], required_posting_auths: [config.hiveAdminAccount] },
      key,
    );
    // Invalidate retraction cache so the change is visible immediately
    void hafCache.invalidate('retracted-papers');
    sendOk(res, { message: 'Paper retracted', tx_id: result.id });
  } catch (err) {
    handleBroadcastError(res, err, {
      timeoutMsg: 'Broadcasting paper retraction timed out',
      failMsg: 'Failed to broadcast retraction to Hive',
      logContext: { author, permlink },
      routeLabel: 'papers.retract',
    });
  }
});

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink/cite
// ──────────────────────────────────────────────

const VALID_CITE_FORMATS = new Set(['bibtex', 'ris', 'apa']);

// `LINE_TERMINATORS` is the shared 10-character separator alphabet (CR, LF, VT,
// FF, FS, GS, RS, NEL, LS, PS) imported from `../lib/line-terminators.js`. `bibtexEscape`,
// `risEscape`, and `singleLine` below all flatten it so the citation-export and
// email-digest paths cannot drift to different separator alphabets; see that
// module's docblock for the file-format-injection rationale.

/**
 * Escape a free-form chain-sourced string for safe interpolation into a BibTeX
 * `@article{...}` field value. BibTeX/TeX treats `{` `}` as grouping, `\` as an
 * escape introducer, and `#$%&_^~` as specials; an un-escaped `}` (or a smuggled
 * `} @article{evil,...`) closes the entry early and lets an attacker-controlled
 * title forge additional records. Line terminators (the full LINE_TERMINATORS
 * alphabet, not just CR/LF) are flattened to a space since field values are
 * written one-per-line. Backslash is rewritten first so the escape sequences
 * this helper introduces are not themselves re-escaped. A non-string input (null/undefined or a wrong-typed chain field) coerces
 * to '' so a missing chain field cannot 500 the export at `.replace`.
 */
export function bibtexEscape(s: unknown): string {
  // Flatten line terminators first, then escape every metacharacter in a SINGLE
  // pass. A multi-pass approach (backslash -> braces -> specials) re-processes
  // the braces this helper itself emits for `\textbackslash{}`, double-escaping
  // them into `\textbackslash\{\}`. One pass over the original string avoids
  // touching any character the replacement introduces.
  const v = typeof s === 'string' ? s : '';
  return v.replace(LINE_TERMINATORS, ' ').replace(/[\\{}#$%&_^~]/g, (c) => {
    if (c === '\\') return '\\textbackslash{}';
    return `\\${c}`;
  });
}

/**
 * Escape a free-form chain-sourced string for a single RIS line. RIS is strictly
 * line-oriented (`XX  - value`) with no quoting mechanism, so any embedded line
 * terminator would split one field into multiple records or inject
 * attacker-crafted tag lines (`AU  - Fake`, `ER  -`). Stripping line terminators
 * (the full LINE_TERMINATORS alphabet) to spaces is the only safe option;
 * trailing/leading whitespace is trimmed for a clean record. A non-string input (null/undefined or a wrong-typed chain field)
 * coerces to ''.
 */
export function risEscape(s: unknown): string {
  const v = typeof s === 'string' ? s : '';
  return v.replace(LINE_TERMINATORS, ' ').trim();
}

/**
 * Flatten a free-form chain-sourced string to a single line for plain-text
 * citation output (APA). Prevents a line terminator (the full LINE_TERMINATORS
 * alphabet) in a title or author name from breaking the one-line citation into
 * multiple lines. A non-string input (null/undefined or a wrong-typed chain field) coerces to ''.
 */
export function singleLine(s: unknown): string {
  const v = typeof s === 'string' ? s : '';
  return v.replace(LINE_TERMINATORS, ' ').trim();
}

/**
 * Co-author display names for a citation export. The reliable name source is
 * `detail.authors`, NOT `detail.json_metadata.pevo` — `detail.json_metadata`
 * IS the raw chain metadata (PEvO data lives under `meta[config.appTag]`, read
 * via `safePevoMeta`), so a `.pevo` sub-key is never populated. `detail.authors`
 * carries a total `name` on every build path: the single-link projection
 * (`{name, hive, orcid}` from `safePevoMeta(meta).authors`), the SQL
 * `authorsWithSupersessionSelect` projection (COALESCE researcher_name → name →
 * hive → orcid), and the continuation/cumulative projection
 * (`buildCumulativeAuthorsForChain`, name resolved via `resolveAuthorName` and
 * filtered to entries that have a name). Non-string names are coerced to '' by
 * the escape helpers downstream.
 */
function citeAuthorNames(detail: Record<string, unknown>): string[] {
  const authors = Array.isArray(detail.authors)
    ? (detail.authors as Array<Record<string, unknown>>)
    : [];
  return authors.map((a) => (typeof a.name === 'string' ? a.name : ''));
}

/**
 * DOI for a citation export. Read from `safePevoMeta(detail.json_metadata).source.doi`
 * — the same `meta[config.appTag].source.doi` accessor the listing/detail
 * citation-count path uses. `detail.doi` is never assigned on the live path.
 */
function citeDoi(detail: Record<string, unknown>): string | undefined {
  const pevo = safePevoMeta((detail.json_metadata as Record<string, unknown>) ?? {});
  const doi = (pevo.source as Record<string, unknown>)?.doi;
  return typeof doi === 'string' && doi.length > 0 ? doi : undefined;
}

export function generateBibtex(detail: Record<string, unknown>): string {
  // Chain fields are coerced from their `as string` casts defensively: a
  // wrong-typed or absent title is unreachable today via Hive's chain-string
  // convention, but the cast is otherwise crash-reachable at `.split`.
  const author = typeof detail.author === 'string' ? detail.author : '';
  const title = typeof detail.title === 'string' ? detail.title : '';
  const created = detail.created as string;
  const year = new Date(created).getFullYear();
  const names = citeAuthorNames(detail);
  const firstWord = title.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') || 'paper';
  const key = `${author}_${firstWord}_${year}`;
  const authorStr = names.length > 0
    ? names.join(' and ')
    : author;
  const doi = citeDoi(detail);

  // The cite key is composed from a Hive username, a [a-z]-sanitized title word,
  // and a numeric year, so it cannot already contain BibTeX-breaking chars; the
  // escape is a defensive backstop in case any component widens.
  let bib = `@article{${bibtexEscape(key)},\n`;
  bib += `  title = {${bibtexEscape(title)}},\n`;
  bib += `  author = {${bibtexEscape(authorStr)}},\n`;
  bib += `  year = {${year}},\n`;
  bib += `  publisher = {PEvO (Publish and Evaluate Onchain)},\n`;
  bib += `  url = {https://pevo.science/papers/${author}/${detail.permlink}}`;
  if (doi) bib += `,\n  doi = {${bibtexEscape(doi)}}`;
  bib += `\n}`;
  return bib;
}

export function generateRis(detail: Record<string, unknown>): string {
  const author = typeof detail.author === 'string' ? detail.author : '';
  const title = typeof detail.title === 'string' ? detail.title : '';
  const created = detail.created as string;
  const year = new Date(created).getFullYear();
  const names = citeAuthorNames(detail);
  const doi = citeDoi(detail);

  const lines: string[] = [
    'TY  - JOUR',
    `TI  - ${risEscape(title)}`,
  ];
  if (names.length > 0) {
    for (const name of names) lines.push(`AU  - ${risEscape(name)}`);
  } else {
    lines.push(`AU  - ${risEscape(author)}`);
  }
  lines.push(`PY  - ${year}`);
  lines.push('PB  - PEvO (Publish and Evaluate Onchain)');
  lines.push(`UR  - https://pevo.science/papers/${author}/${detail.permlink}`);
  if (doi) lines.push(`DO  - ${risEscape(doi)}`);
  lines.push('ER  - ');
  return lines.join('\n');
}

export function generateApa(detail: Record<string, unknown>): string {
  const author = typeof detail.author === 'string' ? detail.author : '';
  const title = typeof detail.title === 'string' ? detail.title : '';
  const created = detail.created as string;
  const year = new Date(created).getFullYear();
  const names = citeAuthorNames(detail);

  const authorStr = names.length > 0
    ? names.map((name) => singleLine(name)).join(', ')
    : author;

  return `${singleLine(authorStr)} (${year}). ${singleLine(title)}. PEvO (Publish and Evaluate Onchain). https://pevo.science/papers/${author}/${detail.permlink}`;
}

router.get('/:author/:permlink/cite', async (req: Request, res: Response) => {
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;
  const format = (req.query.format as string || '').toLowerCase();

  if (!VALID_CITE_FORMATS.has(format)) {
    return sendError(res, 400, 'BAD_REQUEST', 'format must be one of: bibtex, ris, apa');
  }

  // Canonical-root walker is intentionally NOT invoked here. /cite and /retract
  // operate on the URL's own (author, permlink) — citation targets the URL post
  // directly; retraction authorizes username === URL author then broadcasts on
  // the URL's coords. Canonicalization is a display concern handled by the GET
  // handler. New /api/papers/:author/:permlink/<verb> routes that want canonical
  // resolution must call findCanonicalRoot themselves; do not pattern-match this
  // handler without checking.

  // Per-request wall-clock budget — same DoS-amplifier closure as the
  // primary GET handler and /retract. `fetchPaperDetailFromHaf` calls
  // the forward walker via `resolveContinuationChain`.
  const walkerAbort = new AbortController();
  const walkerBudget = setTimeout(() => walkerAbort.abort(), config.hafWalkerWallClockMs);
  let detail: Record<string, unknown> | null;
  try {
    detail = await fetchPaperDetailFromHaf(author, permlink, undefined, walkerAbort.signal) as Record<string, unknown> | null;
  } catch (err) {
    if (err instanceof HafQueryError && isRetriableHafError(err)) {
      // Cause-discriminated retriable envelope. Deterministic pg failures
      // fall through to the central 500 handler.
      return sendError(
        res,
        503,
        'SERVICE_UNAVAILABLE',
        'Citation export temporarily unavailable. Please retry shortly.',
        { retriable: true },
      );
    }
    throw err;
  } finally {
    clearTimeout(walkerBudget);
  }
  if (walkerAbort.signal.aborted) {
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'HAF walker budget exceeded; please retry', { retriable: true });
  }
  if (!detail) {
    return sendError(res, 404, 'NOT_FOUND', 'Paper not found');
  }

  const generators: Record<string, (d: Record<string, unknown>) => string> = {
    bibtex: generateBibtex,
    ris: generateRis,
    apa: generateApa,
  };

  const content = generators[format](detail);
  sendOk(res, { format, content });
});

export default router;
