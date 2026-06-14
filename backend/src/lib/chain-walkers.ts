import { getPool } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { hafCache } from '../cache.js';
import {
  parseMeta,
  isPevoAnyPaper,
  extractAuthorizedContinuationAuthors,
  safePevoMeta,
} from '../helpers.js';
import { T, validPevoPaperWhere } from '../hafsql.js';
import { diff_match_patch as DiffMatchPatch } from 'diff-match-patch';

/**
 * Shared continuation-chain + version-reconstruction walkers (chain domain).
 *
 * These were lifted out of `routes/papers.ts` so the cumulative-authors
 * helper (`lib/chain-cumulative.ts`) can consume the forward/backward walkers
 * without a route-to-route import. Both `routes/papers.ts` (detail/version
 * surfaces) and `lib/chain-cumulative.ts` (the cumulative-union enrichment)
 * import from here, keeping the dependency direction routes -> lib with zero
 * lib -> routes edges. Behavior is unchanged from the route-embedded original.
 */

const dmp = new DiffMatchPatch();

export interface PaperVersionEntry {
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

export interface ChainLink {
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
export interface ChainResolution {
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
export type HeadAuthorsMemo = Map<string, Set<string> | null>;

export function makeHeadAuthorsMemo(): HeadAuthorsMemo {
  return new Map();
}

function memoKey(author: string, permlink: string): string {
  return `${author}/${permlink}`;
}

/**
 * Cache TTL for the per-root cumulative-authors entry. Aligned with the
 * documented ORCID supersession staleness window on `PaperSummary`
 * (`api-contracts/papers.md`): an accreditation revocation or new claim
 * propagates to listing/profile within this window. The detail surface
 * computes live and writes-through to this cache, so any detail hit on a
 * paper effectively re-warms the listing entry for free.
 */
export const CHAIN_CUMULATIVE_AUTHORS_TTL_MS = 1_800_000;

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
export async function fetchHeadAuthorizedAuthors(
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
    // Memoize the null on failure too. This function's docstring contract
    // says "Both null and Set results are cached"; without this
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
export async function resolveContinuationChain(
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
  // 50 hops × ≥1 sequential SQL query × 30s statement_timeout (the
  // connection-level `SET statement_timeout = 30000` in db.ts)
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
      // at the `i < MAX_HOPS` loop guard.
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
export async function findCanonicalRoot(
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
export interface ReconstructedVersion extends PaperVersionEntry {
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
export async function reconstructVersionsFromHaf(
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
    // mitigation — operators correlate post-incident).
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
      // TOCTOU author-set-expansion concern.
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
