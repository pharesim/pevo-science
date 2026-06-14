import { getPool } from '../db.js';
import { logger } from '../logger.js';
import { hafCache } from '../cache.js';
import { safePevoMeta } from '../helpers.js';
import {
  normalizeHiveAccount,
  computeSupersession,
  resolveAuthorName,
  trimAsciiCWhitespace,
} from './author-supersession.js';
import type { PaperAuthor } from '../types/domain.js';
import type { AccreditationStatus } from '../accreditation.js';
import {
  resolveContinuationChain,
  reconstructVersionsFromHaf,
  CHAIN_CUMULATIVE_AUTHORS_TTL_MS,
  type HeadAuthorsMemo,
} from './chain-walkers.js';

/**
 * Cumulative-union author resolution (chain domain).
 *
 * Lifted out of `routes/papers.ts` so the listing (`fetchPapersFromHaf`),
 * profile (`fetchUserPapersFromHaf`), and detail surfaces consume one neutral
 * lib module instead of a route-to-route import. The forward/backward chain
 * walkers this builds on live in `./chain-walkers.js`; this module imports
 * from there (routes -> lib, no lib -> routes edges). Behavior is unchanged
 * from the route-embedded original.
 */

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
 * SQL twin: `consentChainCteBody` (`hafsql.ts`) ports this construction —
 * together with the chain resolution in `resolveContinuationChain` — to a
 * recursive CTE consumed by the consent stack (reputation cycle, consented
 * badge, pending-authorships discovery). Five invariants must stay mirrored
 * between the JS and SQL sides or the displayed `authors[]` and the
 * credited set drift: the cumulative-admission gate (a continuation is
 * admitted only if its chain author is in the union built from its own
 * root-path prefix), the earliest-created canonical-path selection among
 * admitted siblings, the 50-hop walk cap, the visited-set cycle guard, and
 * the two-track first-occurrence display-slot ordering (whose dense rank is
 * the `author_index` resolution domain for name-only claims). A behavior
 * change on either side must land on both.
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
  // many chain posts contributed a spoofed claim. The audit dedups by
  // (rootAuthor, rootPermlink, hive); future volume data drives
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
    // simultaneously).
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
    //  2. REVOKED accreditation:
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

    // Supersession fields (canonical ORCID resolution). The
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

/**
 * Per-row enrichment context for `enrichRowsWithChainAuthors`. Carries the
 * once-per-request accreditation sets (loaded by the caller via the
 * `getAll*`/`getAccredited*` loaders), the shared wall-clock `AbortSignal`,
 * an optional per-request `HeadAuthorsMemo`, and a `logLabel` distinguishing
 * the listing vs profile surface in the per-row failure warn.
 */
export interface EnrichRowsContext {
  accreditedAccounts: Set<string>;
  accreditedOrcids: Map<string, string | null>;
  accreditationOrcidStatus: Map<string, { orcid: string | null; status: AccreditationStatus }>;
  accreditedNames: Map<string, string>;
  signal?: AbortSignal;
  memo?: HeadAuthorsMemo;
  /**
   * Surface label woven into the per-row enrichment-failure warn so listing
   * and profile failures stay distinguishable in logs (the only thing that
   * differed between the two previously-duplicated enrichment loops).
   */
  logLabel: string;
}

/**
 * Shared per-row cumulative-union enrichment, consumed by both the listing
 * (`fetchPapersFromHaf`) and profile (`fetchUserPapersFromHaf`) surfaces.
 *
 * For each row it fans out `resolveChainCumulativeAuthors` under one
 * `Promise.all`, catching per-row failures so one row's chain-walk explosion
 * cannot take down the page (the erroring row simply gets no map entry and the
 * caller falls back to its head-meta projection). The returned map is keyed by
 * `` `${author}/${permlink}` ``.
 *
 * Two consumer-side concerns are FOLDED IN here so both surfaces share one
 * implementation (they previously duplicated both inline at each call site):
 *
 *   - **`length > 0` takeover gate.** A non-null but empty cumulative result
 *     (`authors: []` — a multi-link chain whose posts carry no renderable
 *     author entries) routes back to the head-meta projection rather than
 *     serving an empty authors list. Empty results are therefore NOT entered
 *     into the map; a missing map entry IS the fallback signal.
 *   - **`affiliation` strip.** `PaperSummary`'s contract excludes
 *     `affiliation` (it is `PaperDetail`-only). The stored `authors[]` is
 *     affiliation-stripped here, so a consumer can use the map entry directly.
 *     The detail surface does not use this helper, so its legitimate
 *     `affiliation` rendering is unaffected.
 *
 * A map entry therefore means "this row has a usable cumulative-union takeover
 * (non-empty, affiliation-free)"; the row author's own `accredited_authors`
 * fallback is the caller's responsibility on a miss.
 */
export async function enrichRowsWithChainAuthors<T extends { author: string; permlink: string }>(
  rows: T[],
  ctx: EnrichRowsContext,
): Promise<Map<string, ChainCumulativeAuthorsResult>> {
  const chainAuthorsByKey = new Map<string, ChainCumulativeAuthorsResult>();
  await Promise.all(
    rows.map(async (row) => {
      const key = `${row.author}/${row.permlink}`;
      try {
        const result = await resolveChainCumulativeAuthors(row.author, row.permlink, {
          accreditedAccounts: ctx.accreditedAccounts,
          accreditedOrcids: ctx.accreditedOrcids,
          accreditationOrcidStatus: ctx.accreditationOrcidStatus,
          accreditedNames: ctx.accreditedNames,
          memo: ctx.memo,
          signal: ctx.signal,
        });
        // Takeover gate: only a non-null result carrying at least one author
        // takes over; an empty cumulative array falls back to head-meta (no
        // map entry). Strip `affiliation` so the stored authors match the
        // PaperSummary contract both surfaces emit.
        if (result !== null && result.authors.length > 0) {
          chainAuthorsByKey.set(key, {
            authors: result.authors.map((a) => {
              const { affiliation: _affiliation, ...rest } = a;
              return rest;
            }),
            accredited_authors: result.accredited_authors,
          });
        }
      } catch (err) {
        // Chain-walk failure for one row must not take down the whole page;
        // the row falls back to the head-meta projection at the call site.
        logger.warn({ err, author: row.author, permlink: row.permlink }, ctx.logLabel);
      }
    }),
  );
  return chainAuthorsByKey;
}
