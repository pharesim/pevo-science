/**
 * Shared HAF notification query — used by both the GET /api/notifications
 * endpoint and the email digest system.
 */

import { getPool } from './db.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { T, activeAccreditationsCteBody, validPevoPaperWhere, validReviewWhere } from './hafsql.js';
// ─── Notification Types ──────────────────────────────────────────

export type NotificationEventType =
  | "new_review"
  | "new_citation"
  | "new_vote"
  | "accreditation_update"
  | "new_vouch"
  | "new_reply"
  | "claim_pending"
  | "claim_approved"
  | "claim_revoked";

export interface BaseNotificationEvent {
  type: NotificationEventType;
  block_num: number;
  timestamp: string;
}

export interface NewReviewEvent extends BaseNotificationEvent {
  type: "new_review";
  actor: string;
  paper_author: string;
  paper_permlink: string;
  paper_title: string;
  permlink: string;
}

export interface NewCitationEvent extends BaseNotificationEvent {
  type: "new_citation";
  actor: string;
  paper_author: string;
  paper_permlink: string;
  paper_title: string;
  citing_permlink: string;
}

export interface NewVoteEvent extends BaseNotificationEvent {
  type: "new_vote";
  actor: string;
  target_author: string;
  target_permlink: string;
  target_type: "paper" | "review";
  weight: number;
}

export interface AccreditationUpdateEvent extends BaseNotificationEvent {
  type: "accreditation_update";
  action: "accredit" | "revoke";
  method?: string;
}

export interface NewVouchEvent extends BaseNotificationEvent {
  type: "new_vouch";
  actor: string;
  relationship: string;
}

export interface NewReplyEvent extends BaseNotificationEvent {
  type: "new_reply";
  actor: string;
  parent_author: string;
  parent_permlink: string;
  // No paper_author / paper_permlink: a reply can sit N levels deep in a
  // comment chain, and resolving the root paper coords would require unbounded
  // recursive SQL. The arm emitted NULLs cast to required strings, so any
  // consumer building /papers/${paper_author}/${paper_permlink} would land on
  // /papers/null/null. Dropped rather than mis-resolved.
  permlink: string;
}

export interface ClaimPendingEvent extends BaseNotificationEvent {
  type: "claim_pending";
  actor: string;
  paper_author: string;
  paper_permlink: string;
}

export interface ClaimApprovedEvent extends BaseNotificationEvent {
  type: "claim_approved";
  paper_author: string;
  paper_permlink: string;
}

export interface ClaimRevokedEvent extends BaseNotificationEvent {
  type: "claim_revoked";
  paper_author: string;
  paper_permlink: string;
}

export type NotificationEvent =
  | NewReviewEvent
  | NewCitationEvent
  | NewVoteEvent
  | AccreditationUpdateEvent
  | NewVouchEvent
  | NewReplyEvent
  | ClaimPendingEvent
  | ClaimApprovedEvent
  | ClaimRevokedEvent;

export interface NotificationBatch {
  events: NotificationEvent[];
  latest_block: number;
  has_more: boolean;
}

// Fixed look-back window for cached/shareable notification computations. The
// underlying query is computed relative to `chainHead - NOTIFICATION_WINDOW_BLOCKS`
// (genesis-clamped) rather than a caller cursor, so the dedup runs across a wide
// window — an edit/revote of content published within the window collapses
// against its publication row instead of re-firing as a fresh notification — and
// the SPA result is shareable across polls. ~100k blocks is roughly 3.5 days at
// Hive's 3s cadence. Shared by the SPA route (routes/notifications.ts) and the
// email digest (digest.ts) so both consume the batch the same way.
export const NOTIFICATION_WINDOW_BLOCKS = 100_000;

// Internal fetch cap for the window batch, deliberately larger than any response
// `limit`. fetchNotificationsFromHaf orders by the caller's `direction` and
// LIMITs to this cap plus a +1 truncation probe, so the batch holds at most the
// newest (route, 'desc') or oldest (digest, 'asc') `cap` events above the floor.
// Only when the probe row materializes (a genuine >cap window) AND the cut fell
// inside a block (the probe shares the last-kept row's block) is that partial
// boundary block dropped whole, so no consumer ever sees a cap-truncated block;
// an edge-aligned cut (probe in a different block) keeps the complete block.
// Callers apply their cursor in-app over this wider batch. See the route's
// applySinceBlockFilter and the digest's drain logic.
export const NOTIFICATION_WINDOW_FETCH_CAP = 1000;

/**
 * Floor for the cached window computation: move forward from the chain head when
 * the block-watcher has observed one, else fall back to the genesis floor so a
 * cold backend (watcher not yet ticked) still produces a valid computation.
 * Never dips below `genesis - 1`.
 */
export function computeNotificationWindowFloor(head: number, genesis: number): number {
  const genesisFloor = genesis > 0 ? genesis - 1 : 0;
  return head > 0
    ? Math.max(genesisFloor, head - NOTIFICATION_WINDOW_BLOCKS)
    : genesisFloor;
}

/**
 * Re-apply a poll/digest cursor to a window-relative batch: keep only events
 * strictly after `sinceBlock`. Strict `>` is the shared cursor contract — the
 * SPA route and the digest both treat `latest_block` as already-delivered and
 * resume past it. Centralized so the two consumers cannot drift on `>` vs `>=`.
 */
export function filterEventsAfter(events: NotificationEvent[], sinceBlock: number): NotificationEvent[] {
  return events.filter((e) => e.block_num > sinceBlock);
}

/**
 * Fetch a window batch of notification events for `account` in `(floor, head]`,
 * capped at `cap` rows.
 *
 * `direction` selects which end of the window the cap keeps:
 *   - 'desc' (SPA bell feed): the NEWEST `cap` events above the floor.
 *   - 'asc'  (email digest):  the OLDEST `cap` events above the floor.
 * Regardless of direction the returned `events` are in ascending `block_num`
 * order — `direction` only chooses which events survive the cap, not the
 * presentation order.
 *
 * Same-block ordering is broken deterministically by the monotonic global
 * `haf_operations` PK (`<view>.id`, the views expose no intra-block index), so
 * the cap cut is reproducible. Truncation is detected with a `cap + 1` probe
 * fetch: only when the (cap+1)th row exists is the window genuinely larger than
 * the cap (`capHit`). On `capHit` the truncated-end block (the OLDEST block for
 * 'desc', the NEWEST for 'asc') is dropped whole ONLY when the cut fell inside a
 * block — i.e. the probe row shares the last-kept row's block, making that block
 * partial. An edge-aligned cut (the probe sits in a different block) leaves the
 * truncated-end block COMPLETE and keeps it, so a complete boundary block is never
 * over-dropped and no consumer is ever handed a cap-truncated block. An
 * exactly-cap, fully-contained window drops nothing. `has_more` reflects `capHit`.
 *
 * Residual: the single-block-exceeds-cap case can empty the batch. For 'desc'
 * (SPA) the dropped oldest block is NOT recovered by a forward floor-slide (the
 * floor only moves forward, aging it out); recovery happens only if the
 * in-window count later falls below the cap, or via the email digest for
 * enrolled users. For 'asc' (digest) the dropped newest block resurfaces on the
 * next drain once the floor has slid to contain it.
 */
export async function fetchNotificationsFromHaf(
  account: string,
  floor: number,
  cap: number,
  direction: 'asc' | 'desc',
): Promise<NotificationBatch | null> {
  const pool = getPool();
  if (!pool) return null;

  // Outer-order direction for the cap cut: ASC keeps the oldest `cap`, DESC the
  // newest. The same-block tie-breaker is the monotonic HAF op id (op_id) per
  // agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md Rule 2.
  const dir = direction === 'desc' ? 'DESC' : 'ASC';

  try {
    // $1 = account, $2 = floor, $3 = cap, $4/$5 = CTE params, $N = appTag, $N+1 = appTag/%, $N+2 = bridgeAccount
    const accredStartIdx = 4;
    const accredCte = activeAccreditationsCteBody(accredStartIdx);
    const at = `$${accredCte.nextIdx}`;       // appTag for WHERE clauses
    const al = `$${accredCte.nextIdx + 1}`;   // appTag/% LIKE pattern
    const bridgeParam = `$${accredCte.nextIdx + 2}`; // hiveBridgeAccount
    const adminParam = `$${accredCte.nextIdx + 3}`;  // hiveAdminAccount (arm 9 revoke signer set)
    // accreditationAuthorities is the 2nd of activeAccreditationsCteBody's two
    // params (custom_id at startIdx, authorities array at startIdx + 1). Anchor
    // forward on the CTE start index so a new bound param in that CTE shifts
    // this in step rather than silently resolving to the wrong placeholder.
    const authoritiesParam = `$${accredStartIdx + 1}`; // accreditationAuthorities — authority gate on the accreditation-update feed
    // Not buildWith: this WITH chain mixes the activeAccreditationsCteBody
    // builder's CTE with hand-written inline CTEs (user_bridge_papers, the
    // notification arms). buildWith composes CTE *builders*, not inline-literal
    // CTEs, so the manual spelling is required here.
    const result = await pool.query(
      `WITH ${accredCte.sql},

      -- Pre-resolve bridge papers registered by this user (tiny result set).
      -- This avoids LEFT JOINing every vote/review/citation to comments just
      -- to check the registered_by field, which times out on old sinceBlock values.
      user_bridge_papers AS (
        -- Bridge papers registered by this user, pinned to config.hiveBridgeAccount
        -- via validPevoPaperWhere('bridge'). The 'registered_by' metadata field is
        -- attacker-controlled in isolation; pairing it with the bridge-author
        -- pin makes it safe (any non-bridge-author bridge_paper is invalid data).
        SELECT c.author, c.permlink
        FROM ${T.comments} c
        WHERE c.parent_author = '' AND c.parent_permlink = ${at}
          AND ${validPevoPaperWhere({ commentAlias: 'c', appTagParam: at, bridgeAccountParam: bridgeParam, source: 'bridge' })}
          AND c.json_metadata -> ${at} -> 'source' ->> 'registered_by' = $1
          AND c.json_metadata ->> 'app' LIKE ${al}
      )

      -- 1a. New reviews on your own papers (accredited reviewers only).
      -- INNER JOIN to ${T.comments} p plus a paper-class identity check
      -- via validPevoPaperWhere — without it, an accredited attacker can
      -- write a (type=review, rating={1,1,1,1}) reply to ANY of the
      -- recipient Hive content (a blog post, a non-paper comment, a
      -- peakd reply) and trigger a new_review notification with an empty
      -- title (the LEFT JOIN-to-a-non-paper bug surfaced by the round-1
      -- review item #3). Mirrors arm 1b tighter user_bridge_papers gate.
      -- source=all is the safe choice — for native papers
      -- co.parent_author = $1 matches the chain author (recipient);
      -- bridge papers can never satisfy co.parent_author = $1 because
      -- their chain author is config.hiveBridgeAccount.
      -- DISTINCT ON (co.author, co.permlink) ORDER BY co.block_num ASC collapses
      -- a review and all its later edits to the single publication row, so a
      -- reviewer fixing typos does not re-fire new_review on every edit. The raw
      -- operation_comment_view carries one row per edit (see hive-schemas edit
      -- semantics); earliest-wins makes edits silent.
      --
      -- A credited authorship claimer (ORCID / name-only slot, absent from
      -- authors[].hive) reviewing the paper they are credited for IS excluded from
      -- the display review aggregates (excludeClaimedSelfWhere) and from the
      -- reputation score (the cycle's accepted_claims NOT EXISTS gate), because a
      -- self-review there would inflate ratings / score. This new_review arm is
      -- INTENTIONALLY left ungated for that case: a notification confers no credit
      -- and carries no display weight, so the self-dealing-inflation risk those
      -- exclusions close does not apply. The arm reports raw review-shaped activity
      -- on the recipient's paper, so the author is informed that a credited
      -- co-author posted a review even though it does not count toward ratings or
      -- score. (Gating it would compose the recipient-scoped accepted-claims set
      -- into this multi-CTE query for a rare case with no integrity benefit.) The
      -- co.author != $1 gate already drops the paper author's own self-review.
      SELECT * FROM (
        SELECT DISTINCT ON (co.author, co.permlink)
          'new_review'::text AS event_type,
          co.block_num,
          co.timestamp AS event_timestamp,
          co.author AS actor,
          co.parent_author AS paper_author,
          co.parent_permlink AS paper_permlink,
          COALESCE(p.title, '') AS paper_title,
          co.permlink AS event_permlink,
          NULL::text AS target_type,
          NULL::int AS vote_weight,
          NULL::text AS accredit_action,
          NULL::text AS accredit_method,
          NULL::text AS vouch_relationship,
          NULL::text AS parent_author,
          NULL::text AS parent_permlink_ref,
          co.id AS op_id
        FROM ${T.commentOps} co
        JOIN ${T.comments} p
          ON p.author = co.parent_author AND p.permlink = co.parent_permlink
          AND ${validPevoPaperWhere({ commentAlias: 'p', appTagParam: at, bridgeAccountParam: bridgeParam, source: 'all' })}
        JOIN active_accreditations aa_r ON aa_r.account = co.author
        WHERE co.parent_author = $1
          AND co.block_num > $2
          AND ${validReviewWhere({ commentAlias: 'co', appTagParam: at })}
          AND co.author != $1
        ORDER BY co.author, co.permlink, co.block_num ASC
      ) AS arm_1a

      UNION ALL

      -- 1b. New reviews on your bridge papers
      -- Same earliest-wins dedup as arm 1a so bridge-paper review edits stay silent.
      SELECT * FROM (
        SELECT DISTINCT ON (co.author, co.permlink)
          'new_review'::text AS event_type,
          co.block_num,
          co.timestamp AS event_timestamp,
          co.author AS actor,
          co.parent_author AS paper_author,
          co.parent_permlink AS paper_permlink,
          COALESCE(p.title, '') AS paper_title,
          co.permlink AS event_permlink,
          NULL::text AS target_type,
          NULL::int AS vote_weight,
          NULL::text AS accredit_action,
          NULL::text AS accredit_method,
          NULL::text AS vouch_relationship,
          NULL::text AS parent_author,
          NULL::text AS parent_permlink_ref,
          co.id AS op_id
        FROM ${T.commentOps} co
        JOIN user_bridge_papers bp ON bp.author = co.parent_author AND bp.permlink = co.parent_permlink
        -- LEFT JOIN (vs the INNER JOIN + validPevoPaperWhere in arm 1a) is
        -- safe here because user_bridge_papers is the parent-paper
        -- existence proof: the bp.author/bp.permlink pair is itself produced
        -- from a validPevoPaperWhere source=bridge filter upstream, so
        -- the comments-side row IS guaranteed to be a PEvO bridge paper.
        -- LEFT JOIN preserves the row if hafsql.comments lags behind the
        -- comment_operations insert (rare but observable on heavy ingest);
        -- p.title falls back to empty string via COALESCE above. The arm 1a
        -- promotion to INNER + validPevoPaperWhere is needed because the
        -- native arm has no equivalent pre-filtered CTE; arm 1a's INNER JOIN
        -- + validPevoPaperWhere comment above carries that rationale.
        LEFT JOIN ${T.comments} p ON p.author = co.parent_author AND p.permlink = co.parent_permlink
        JOIN active_accreditations aa_r ON aa_r.account = co.author
        WHERE co.block_num > $2
          AND ${validReviewWhere({ commentAlias: 'co', appTagParam: at })}
          AND co.author != $1
        ORDER BY co.author, co.permlink, co.block_num ASC
      ) AS arm_1b

      UNION ALL

      -- 2a. New accredited votes on your own native papers.
      -- JOIN comments + validPevoPaperWhere so a vote on the recipient's
      -- non-PEvO Hive content (blog post, non-paper comment) does NOT surface
      -- as "X endorsed your paper" (arm 1a was hardened against the same class
      -- earlier; arm 2 was missed). v.voter != v.author drops self-votes.
      -- DISTINCT ON (v.author, v.permlink, v.voter) ORDER BY v.block_num DESC keeps
      -- only the latest vote per (post, voter), so a weight toggle fires once. The
      -- weight != 0 filter is HOISTED to the outer select: if the latest op is a
      -- retract (weight 0), the whole vote is suppressed rather than surfacing the
      -- prior non-zero weight.
      SELECT * FROM (
        SELECT DISTINCT ON (v.author, v.permlink, v.voter)
          'new_vote'::text AS event_type,
          v.block_num,
          v.timestamp AS event_timestamp,
          v.voter AS actor,
          v.author AS paper_author,
          v.permlink AS paper_permlink,
          NULL::text AS paper_title,
          NULL::text AS event_permlink,
          'paper'::text AS target_type,
          v.weight::int AS vote_weight,
          NULL::text AS accredit_action,
          NULL::text AS accredit_method,
          NULL::text AS vouch_relationship,
          NULL::text AS parent_author,
          NULL::text AS parent_permlink_ref,
          v.id AS op_id
        FROM ${T.voteOps} v
        JOIN active_accreditations aa ON aa.account = v.voter
        JOIN ${T.comments} p
          ON p.author = v.author AND p.permlink = v.permlink
          AND ${validPevoPaperWhere({ commentAlias: 'p', appTagParam: at, bridgeAccountParam: bridgeParam, source: 'all' })}
        WHERE v.author = $1
          AND v.block_num > $2
          AND v.voter != v.author
        ORDER BY v.author, v.permlink, v.voter, v.block_num DESC
      ) AS arm_2a
      WHERE vote_weight != 0

      UNION ALL

      -- 2b. New accredited votes on your bridge papers
      -- Same latest-wins dedup + outer weight-hoist as arm 2a, for bridge papers.
      SELECT * FROM (
        SELECT DISTINCT ON (v.author, v.permlink, v.voter)
          'new_vote'::text AS event_type,
          v.block_num,
          v.timestamp AS event_timestamp,
          v.voter AS actor,
          v.author AS paper_author,
          v.permlink AS paper_permlink,
          NULL::text AS paper_title,
          NULL::text AS event_permlink,
          'paper'::text AS target_type,
          v.weight::int AS vote_weight,
          NULL::text AS accredit_action,
          NULL::text AS accredit_method,
          NULL::text AS vouch_relationship,
          NULL::text AS parent_author,
          NULL::text AS parent_permlink_ref,
          v.id AS op_id
        FROM ${T.voteOps} v
        JOIN active_accreditations aa ON aa.account = v.voter
        JOIN user_bridge_papers bp ON bp.author = v.author AND bp.permlink = v.permlink
        WHERE v.block_num > $2
          AND v.voter != v.author
        ORDER BY v.author, v.permlink, v.voter, v.block_num DESC
      ) AS arm_2b
      WHERE vote_weight != 0

      UNION ALL

      -- 2c. New accredited votes on your reviews.
      -- A vote on a recipient's review comment must surface as target_type
      -- 'review', not the hardcoded 'paper' the merged arm 2 emitted.
      -- validReviewWhere pins the voted post as a structurally-valid review.
      -- Same latest-wins dedup + outer weight-hoist as arm 2a, for votes on the
      -- recipient's reviews (target_type 'review').
      SELECT * FROM (
        SELECT DISTINCT ON (v.author, v.permlink, v.voter)
          'new_vote'::text AS event_type,
          v.block_num,
          v.timestamp AS event_timestamp,
          v.voter AS actor,
          v.author AS paper_author,
          v.permlink AS paper_permlink,
          NULL::text AS paper_title,
          NULL::text AS event_permlink,
          'review'::text AS target_type,
          v.weight::int AS vote_weight,
          NULL::text AS accredit_action,
          NULL::text AS accredit_method,
          NULL::text AS vouch_relationship,
          NULL::text AS parent_author,
          NULL::text AS parent_permlink_ref,
          v.id AS op_id
        FROM ${T.voteOps} v
        JOIN active_accreditations aa ON aa.account = v.voter
        JOIN ${T.comments} c
          ON c.author = v.author AND c.permlink = v.permlink
          AND ${validReviewWhere({ commentAlias: 'c', appTagParam: at })}
        WHERE v.author = $1
          AND v.block_num > $2
          AND v.voter != v.author
        ORDER BY v.author, v.permlink, v.voter, v.block_num DESC
      ) AS arm_2c
      WHERE vote_weight != 0

      UNION ALL

      -- 3. Accreditation updates targeting you
      SELECT
        'accreditation_update'::text,
        cj.block_num,
        cj.timestamp,
        NULL,
        NULL, NULL, NULL, NULL, NULL, NULL,
        cj.json::jsonb ->> 'action',
        cj.json::jsonb ->> 'method',
        NULL, NULL, NULL,
        cj.id AS op_id
      FROM ${T.customJson} cj
      WHERE cj.custom_id = ${at}
        AND cj.json::jsonb ->> 'account' = $1
        AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
        -- Authority gate: only an accredit/revoke op signed by an
        -- accreditation authority produces a notification. Without it, a
        -- self-broadcast accredit/revoke op naming this account (signed with
        -- any posting key) would push a spurious accreditation_update. Same
        -- required_posting_auths gate the trust reads use (accred_ranked in
        -- activeAccreditationsCteBody, the per-account accreditation reads).
        AND cj.required_posting_auths ?| ${authoritiesParam}::text[]
        AND cj.block_num > $2

      UNION ALL

      -- 4. New vouches for you
      SELECT
        'new_vouch'::text,
        cj.block_num,
        cj.timestamp,
        cj.json::jsonb ->> 'voucher',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        cj.json::jsonb ->> 'relationship',
        NULL, NULL,
        cj.id AS op_id
      FROM ${T.customJson} cj
      WHERE cj.custom_id = ${at}
        AND cj.json::jsonb ->> 'vouchee' = $1
        AND cj.json::jsonb ->> 'action' = 'vouch'
        -- Signer gate (per the Vouch / Web of Trust schema in hive-schemas.md):
        -- a vouch is only valid when signed by the named voucher, and the
        -- voucher must be accredited.
        -- Without it anyone can forge a vouch naming a random voucher and the
        -- vouchee gets a spurious new_vouch notification + digest email.
        AND cj.required_posting_auths ->> 0 = cj.json::jsonb ->> 'voucher'
        AND cj.required_posting_auths ->> 0 IN (SELECT account FROM active_accreditations)
        AND cj.block_num > $2

      UNION ALL

      -- 5. New replies to your discussion comments (accredited users only).
      -- The paper_author / paper_permlink / paper_title positions are
      -- intentionally NULL here: a reply can sit N levels deep, so the root
      -- paper coords are not resolvable without unbounded recursive SQL. The
      -- emitted NewReplyEvent omits them rather than carry null-valued coords.
      -- DISTINCT ON (co.author, co.permlink) ORDER BY co.block_num ASC collapses
      -- a reply and all its later edits to the single publication row, so
      -- editing a reply does not re-fire new_reply on the parent-comment author.
      -- The raw operation_comment_view carries one row per edit (see hive-schemas
      -- edit semantics); earliest-wins makes edits silent. Same dedup shape as
      -- the sibling comment-derived arms (1a, 1b).
      SELECT * FROM (
        SELECT DISTINCT ON (co.author, co.permlink)
          'new_reply'::text AS event_type,
          co.block_num,
          co.timestamp AS event_timestamp,
          co.author AS actor,
          NULL::text AS paper_author,
          NULL::text AS paper_permlink,
          NULL::text AS paper_title,
          co.permlink AS event_permlink,
          NULL::text AS target_type,
          NULL::int AS vote_weight,
          NULL::text AS accredit_action,
          NULL::text AS accredit_method,
          NULL::text AS vouch_relationship,
          co.parent_author AS parent_author,
          co.parent_permlink AS parent_permlink_ref,
          co.id AS op_id
        FROM ${T.commentOps} co
        JOIN active_accreditations aa_c ON aa_c.account = co.author
        WHERE co.parent_author = $1
          AND co.block_num > $2
          -- Self-exclusion: a user replying to their own comment must not
          -- notify themselves. Mirrors the self-exclusion guard the sibling
          -- comment-derived arms (1a, 1b) carry.
          AND co.author != $1
          AND (co.json_metadata -> ${at} ->> 'type') = 'comment'
          AND co.json_metadata ->> 'app' LIKE ${al}
        ORDER BY co.author, co.permlink, co.block_num ASC
      ) AS arm_5

      UNION ALL

      -- 6a. New citations of your own papers (accredited citing authors only)
      -- DISTINCT ON the (citing post, cited paper) 4-tuple ORDER BY citing.block_num
      -- ASC: a citation newly introduced in an edit fires once (its first block),
      -- but a citation surviving across edits does not re-fire on every edit.
      SELECT * FROM (
        SELECT DISTINCT ON (citing.author, citing.permlink, cited_ref.author, cited_ref.permlink)
          'new_citation'::text AS event_type,
          citing.block_num,
          citing.timestamp AS event_timestamp,
          citing.author AS actor,
          cited_ref.author AS paper_author,
          cited_ref.permlink AS paper_permlink,
          COALESCE(cited_paper.title, '') AS paper_title,
          citing.permlink AS event_permlink,
          NULL::text AS target_type,
          NULL::int AS vote_weight,
          NULL::text AS accredit_action,
          NULL::text AS accredit_method,
          NULL::text AS vouch_relationship,
          NULL::text AS parent_author,
          NULL::text AS parent_permlink_ref,
          citing.id AS op_id
        FROM ${T.commentOps} citing
        JOIN active_accreditations aa_ct ON aa_ct.account = citing.author
        -- CASE-WHEN array-guard at SRF argument position. Without it, a chain
        -- post broadcasting non-array pevo.citations (null, string, integer,
        -- object) would crash the entire /api/notifications GET for the
        -- recipient with "cannot extract elements from a scalar". The
        -- CASE-WHEN absorbs the non-array case to '[]'::jsonb at the
        -- argument site so jsonb_array_elements never sees a scalar. See
        -- agents/docs/solutions/conventions/
        -- pg-cross-join-lateral-where-guard-fires-after-srf-2026-05-16.md.
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(citing.json_metadata -> ${at} -> 'citations') = 'array'
            THEN citing.json_metadata -> ${at} -> 'citations'
            ELSE '[]'::jsonb
          END
        ) AS cite_elem
        CROSS JOIN LATERAL (
          SELECT cite_elem ->> 'author' AS author, cite_elem ->> 'permlink' AS permlink
        ) AS cited_ref
        -- INNER JOIN + paper-existence gate: the cited (author, permlink) must
        -- actually exist as a PEvO paper. Without it, a broadcaster can stuff
        -- thousands of fake {author: $1, permlink: 'fake-N'} citation refs into
        -- a "paper" and spam unlimited citation notifications + digest emails to
        -- the victim. cited_ref.author = $1 below pins the recipient as the
        -- cited native author.
        JOIN ${T.comments} cited_paper
          ON cited_paper.author = cited_ref.author AND cited_paper.permlink = cited_ref.permlink
          AND ${validPevoPaperWhere({ commentAlias: 'cited_paper', appTagParam: at, bridgeAccountParam: bridgeParam, source: 'all' })}
        WHERE citing.block_num > $2
          AND citing.author <> $1
          AND cited_ref.author = $1
          AND (citing.json_metadata -> ${at} ->> 'type') = 'paper'
          AND citing.json_metadata ->> 'app' LIKE ${al}
        ORDER BY citing.author, citing.permlink, cited_ref.author, cited_ref.permlink, citing.block_num ASC
      ) AS arm_6a

      UNION ALL

      -- 6b. New citations of your bridge papers
      -- Same (citing post, cited paper) earliest-wins dedup as arm 6a, for bridge papers.
      SELECT * FROM (
        SELECT DISTINCT ON (citing.author, citing.permlink, cited_ref.author, cited_ref.permlink)
          'new_citation'::text AS event_type,
          citing.block_num,
          citing.timestamp AS event_timestamp,
          citing.author AS actor,
          cited_ref.author AS paper_author,
          cited_ref.permlink AS paper_permlink,
          COALESCE(cited_paper.title, '') AS paper_title,
          citing.permlink AS event_permlink,
          NULL::text AS target_type,
          NULL::int AS vote_weight,
          NULL::text AS accredit_action,
          NULL::text AS accredit_method,
          NULL::text AS vouch_relationship,
          NULL::text AS parent_author,
          NULL::text AS parent_permlink_ref,
          citing.id AS op_id
        FROM ${T.commentOps} citing
        JOIN active_accreditations aa_ct ON aa_ct.account = citing.author
        -- CASE-WHEN array-guard at SRF argument position. Same defensive
        -- shape as arm 6a above. See
        -- agents/docs/solutions/conventions/
        -- pg-cross-join-lateral-where-guard-fires-after-srf-2026-05-16.md.
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(citing.json_metadata -> ${at} -> 'citations') = 'array'
            THEN citing.json_metadata -> ${at} -> 'citations'
            ELSE '[]'::jsonb
          END
        ) AS cite_elem
        CROSS JOIN LATERAL (
          SELECT cite_elem ->> 'author' AS author, cite_elem ->> 'permlink' AS permlink
        ) AS cited_ref
        JOIN user_bridge_papers bp ON bp.author = cited_ref.author AND bp.permlink = cited_ref.permlink
        -- user_bridge_papers already proves the cited paper exists as a bridge
        -- paper registered by the recipient; the INNER JOIN + paper-existence
        -- gate here is belt-and-suspenders against the same fake-citation spam
        -- vector closed in arm 6a.
        JOIN ${T.comments} cited_paper
          ON cited_paper.author = cited_ref.author AND cited_paper.permlink = cited_ref.permlink
          AND ${validPevoPaperWhere({ commentAlias: 'cited_paper', appTagParam: at, bridgeAccountParam: bridgeParam, source: 'all' })}
        WHERE citing.block_num > $2
          AND citing.author <> $1
          AND (citing.json_metadata -> ${at} ->> 'type') = 'paper'
          AND citing.json_metadata ->> 'app' LIKE ${al}
        ORDER BY citing.author, citing.permlink, cited_ref.author, cited_ref.permlink, citing.block_num ASC
      ) AS arm_6b

      UNION ALL

      -- 7. Pending authorship claims on your papers (notify post author)
      SELECT
        'claim_pending'::text,
        cj.block_num,
        cj.timestamp,
        cj.required_posting_auths ->> 0,
        cj.json::jsonb ->> 'paper_author',
        cj.json::jsonb ->> 'paper_permlink',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        cj.id AS op_id
      FROM ${T.customJson} cj
      WHERE cj.custom_id = ${at}
        AND cj.json::jsonb ->> 'action' = 'claim_authorship'
        AND cj.json::jsonb ->> 'paper_author' = $1
        -- Signer gate (per the Claim Authorship schema in hive-schemas.md): the
        -- signer IS the claimer and only accredited users may claim. Without it a stranger can forge
        -- a claim_authorship naming the victim's paper and spam the post
        -- author with claim_pending notifications.
        AND cj.required_posting_auths ->> 0 IN (SELECT account FROM active_accreditations)
        AND cj.block_num > $2

      UNION ALL

      -- 8. Authorship claim approved (notify claimer)
      -- DISTINCT ON (paper_author, paper_permlink) ORDER BY cj.block_num ASC
      -- collapses an approve re-broadcast/edit storm to one notification per cited
      -- paper (earliest-wins, matching arms 1a/6a).
      SELECT * FROM (
        SELECT DISTINCT ON (cj.json::jsonb ->> 'paper_author', cj.json::jsonb ->> 'paper_permlink')
          'claim_approved'::text AS event_type,
          cj.block_num,
          cj.timestamp AS event_timestamp,
          NULL::text AS actor,
          cj.json::jsonb ->> 'paper_author' AS paper_author,
          cj.json::jsonb ->> 'paper_permlink' AS paper_permlink,
          NULL::text AS paper_title,
          NULL::text AS event_permlink,
          NULL::text AS target_type,
          NULL::int AS vote_weight,
          NULL::text AS accredit_action,
          NULL::text AS accredit_method,
          NULL::text AS vouch_relationship,
          NULL::text AS parent_author,
          NULL::text AS parent_permlink_ref,
          cj.id AS op_id
        FROM ${T.customJson} cj
        WHERE cj.custom_id = ${at}
          AND cj.json::jsonb ->> 'action' = 'approve_authorship'
          AND cj.json::jsonb ->> 'claimer' = $1
          -- Signer gate (per the Approve Authorship schema in hive-schemas.md): an
          -- approve is only valid when signed by the ACTUAL native post author or
          -- the bridge account. The signer set must NOT be derived from the
          -- JSON-self-asserted paper_author: an attacker controls both their own
          -- posting key and the paper_author field, so {paper_author:<self>,
          -- claimer:<victim>} would pass a self-referential check (signer ==
          -- self-named paper_author). The native arm proves the named
          -- (paper_author, paper_permlink) is a real PEvO native paper via
          -- ${T.comments} + validPevoPaperWhere and binds the signer to that
          -- post's ACTUAL author (mirrors the existence proof in arms 1b/2/6). The
          -- bridge arm is the param-bound bridgeParam branch, already safe.
          AND (
            EXISTS (
              SELECT 1 FROM ${T.comments} ap_paper
              WHERE ap_paper.author = cj.json::jsonb ->> 'paper_author'
                AND ap_paper.permlink = cj.json::jsonb ->> 'paper_permlink'
                AND ${validPevoPaperWhere({ commentAlias: 'ap_paper', appTagParam: at, bridgeAccountParam: bridgeParam, source: 'native' })}
                AND cj.required_posting_auths ->> 0 = ap_paper.author
            )
            OR cj.required_posting_auths ->> 0 = ${bridgeParam}
          )
          -- Claim-correlation gate: fire only when the recipient ($1) ACTUALLY
          -- claimed authorship on this exact (paper_author, paper_permlink). The
          -- signer gate above proves the approver authored the named real paper,
          -- but NOT that $1 ever claimed it, so without this an accredited owner
          -- could self-sign an approve of their OWN paper naming an arbitrary
          -- victim as claimer and spam them a "claim approved" notification + digest
          -- email. Sibling arms 1a/2a stay safe by binding the existence proof to
          -- the recipient; arms 8/9 carry the recipient on the unrelated claimer
          -- field, so the claim-to-recipient link must be made explicit here.
          AND EXISTS (
            SELECT 1 FROM ${T.customJson} cl
            WHERE cl.custom_id = ${at}
              AND cl.json::jsonb ->> 'action' = 'claim_authorship'
              AND cl.json::jsonb ->> 'paper_author' = cj.json::jsonb ->> 'paper_author'
              AND cl.json::jsonb ->> 'paper_permlink' = cj.json::jsonb ->> 'paper_permlink'
              AND cl.required_posting_auths ->> 0 = $1
          )
          AND cj.block_num > $2
        ORDER BY cj.json::jsonb ->> 'paper_author', cj.json::jsonb ->> 'paper_permlink', cj.block_num ASC
      ) AS arm_8

      UNION ALL

      -- 9. Authorship claim revoked (notify claimer)
      -- DISTINCT ON (paper_author, paper_permlink) ORDER BY cj.block_num ASC
      -- collapses a revoke re-broadcast/edit storm to one notification per cited
      -- paper (earliest-wins, matching arms 1a/6a).
      SELECT * FROM (
        SELECT DISTINCT ON (cj.json::jsonb ->> 'paper_author', cj.json::jsonb ->> 'paper_permlink')
          'claim_revoked'::text AS event_type,
          cj.block_num,
          cj.timestamp AS event_timestamp,
          NULL::text AS actor,
          cj.json::jsonb ->> 'paper_author' AS paper_author,
          cj.json::jsonb ->> 'paper_permlink' AS paper_permlink,
          NULL::text AS paper_title,
          NULL::text AS event_permlink,
          NULL::text AS target_type,
          NULL::int AS vote_weight,
          NULL::text AS accredit_action,
          NULL::text AS accredit_method,
          NULL::text AS vouch_relationship,
          NULL::text AS parent_author,
          NULL::text AS parent_permlink_ref,
          cj.id AS op_id
        FROM ${T.customJson} cj
        WHERE cj.custom_id = ${at}
          AND cj.json::jsonb ->> 'action' = 'revoke_authorship'
          AND cj.json::jsonb ->> 'claimer' = $1
          -- Signer gate (per the Revoke Authorship schema in hive-schemas.md): a
          -- revoke is valid when signed by the ACTUAL native post author, the
          -- claimer themselves, the bridge account, or the admin account. As in arm
          -- 8, the post-author branch must NOT trust the JSON-self-asserted
          -- paper_author: an attacker controlling both their posting key and the
          -- paper_author field could otherwise self-sign {paper_author:<self>,
          -- claimer:<victim>}. The native arm proves the named (paper_author,
          -- paper_permlink) is a real PEvO native paper via ${T.comments} +
          -- validPevoPaperWhere and binds the signer to that post's ACTUAL author.
          -- The bridge and admin branches are param-bound, already safe. The
          -- claimer-self branch is safe because cj.json ->> 'claimer' is pinned to
          -- $1 above, so it admits only an op the recipient signed with their key.
          AND (
            EXISTS (
              SELECT 1 FROM ${T.comments} rv_paper
              WHERE rv_paper.author = cj.json::jsonb ->> 'paper_author'
                AND rv_paper.permlink = cj.json::jsonb ->> 'paper_permlink'
                AND ${validPevoPaperWhere({ commentAlias: 'rv_paper', appTagParam: at, bridgeAccountParam: bridgeParam, source: 'native' })}
                AND cj.required_posting_auths ->> 0 = rv_paper.author
            )
            OR cj.required_posting_auths ->> 0 IN (
              cj.json::jsonb ->> 'claimer',
              ${bridgeParam},
              ${adminParam}
            )
          )
          -- Claim-correlation gate (see arm 8): fire only when the recipient ($1)
          -- actually claimed authorship on this exact (paper_author, paper_permlink),
          -- so an accredited owner cannot self-sign a revoke of their own paper
          -- naming an arbitrary victim as claimer and spam them. The claimer-self
          -- signer branch already implies a self-claim, but the post-author branch
          -- does not, so the correlation must gate both.
          AND EXISTS (
            SELECT 1 FROM ${T.customJson} cl
            WHERE cl.custom_id = ${at}
              AND cl.json::jsonb ->> 'action' = 'claim_authorship'
              AND cl.json::jsonb ->> 'paper_author' = cj.json::jsonb ->> 'paper_author'
              AND cl.json::jsonb ->> 'paper_permlink' = cj.json::jsonb ->> 'paper_permlink'
              AND cl.required_posting_auths ->> 0 = $1
          )
          AND cj.block_num > $2
        ORDER BY cj.json::jsonb ->> 'paper_author', cj.json::jsonb ->> 'paper_permlink', cj.block_num ASC
      ) AS arm_9

      ORDER BY block_num ${dir}, op_id ${dir}
      LIMIT $3`,
      // $3 = cap + 1: fetch one probe row beyond the cap so a genuine >cap
      // truncation (probe present) is distinguishable from an exactly-cap
      // fully-contained window (probe absent). See the capHit computation below.
      [account, floor, cap + 1, ...accredCte.params, config.appTag, `${config.appTag}/%`, config.hiveBridgeAccount, config.hiveAdminAccount],
    );

    // The probe row (the (cap+1)th) is the genuine-truncation signal. A plain
    // `>= cap` over a `LIMIT cap` fetch fires at EXACTLY cap even when no
    // truncation occurred, dropping a genuinely-complete boundary block; under
    // the SPA's forward newest-first cursor the floor only slides forward, so that
    // block ages out and is never recovered (a silent skip, not graceful
    // deferral). `> cap` over the cap+1 fetch fires only on a real >cap window.
    const capHit = result.rows.length > cap;
    // Truncate the probe back to `cap` before building events. The fetch is
    // ordered (block_num, op_id) `dir`, so the probe sits at the truncated end.
    const keptRows = capHit
      ? (result.rows as Array<Record<string, unknown>>).slice(0, cap)
      : (result.rows as Array<Record<string, unknown>>);
    const events: NotificationEvent[] = [];
    for (const r of keptRows) {
      const base = {
        block_num: Number(r.block_num),
        timestamp: r.event_timestamp instanceof Date
          ? r.event_timestamp.toISOString()
          : String(r.event_timestamp),
      };

      switch (r.event_type) {
        case 'new_review':
          events.push({
            ...base,
            type: 'new_review',
            actor: r.actor as string,
            paper_author: r.paper_author as string,
            paper_permlink: r.paper_permlink as string,
            paper_title: r.paper_title as string,
            permlink: r.event_permlink as string,
          });
          break;
        case 'new_citation':
          events.push({
            ...base,
            type: 'new_citation',
            actor: r.actor as string,
            paper_author: r.paper_author as string,
            paper_permlink: r.paper_permlink as string,
            paper_title: r.paper_title as string,
            citing_permlink: r.event_permlink as string,
          });
          break;
        case 'new_vote':
          events.push({
            ...base,
            type: 'new_vote',
            actor: r.actor as string,
            target_author: r.paper_author as string,
            target_permlink: r.paper_permlink as string,
            target_type: (r.target_type as 'paper' | 'review') || 'paper',
            weight: Number(r.vote_weight) || 0,
          });
          break;
        case 'accreditation_update':
          events.push({
            ...base,
            type: 'accreditation_update',
            action: (r.accredit_action as 'accredit' | 'revoke') || 'accredit',
            ...(r.accredit_method ? { method: r.accredit_method as string } : {}),
          });
          break;
        case 'new_vouch':
          events.push({
            ...base,
            type: 'new_vouch',
            actor: r.actor as string,
            relationship: (r.vouch_relationship as string) || 'colleague',
          });
          break;
        case 'new_reply':
          events.push({
            ...base,
            type: 'new_reply',
            actor: r.actor as string,
            parent_author: r.parent_author as string,
            parent_permlink: r.parent_permlink_ref as string,
            permlink: r.event_permlink as string,
          });
          break;
        case 'claim_pending':
          events.push({
            ...base,
            type: 'claim_pending',
            actor: r.actor as string,
            paper_author: r.paper_author as string,
            paper_permlink: r.paper_permlink as string,
          });
          break;
        case 'claim_approved':
          events.push({
            ...base,
            type: 'claim_approved',
            paper_author: r.paper_author as string,
            paper_permlink: r.paper_permlink as string,
          });
          break;
        case 'claim_revoked':
          events.push({
            ...base,
            type: 'claim_revoked',
            paper_author: r.paper_author as string,
            paper_permlink: r.paper_permlink as string,
          });
          break;
      }
    }

    // Rows arrive in (block_num, op_id) `dir` order; normalize to ascending
    // block_num for the returned contract (both consumers expect ascending).
    events.sort((a, b) => a.block_num - b.block_num);

    let delivered = events;
    if (capHit && events.length > 0) {
      // On a genuine >cap truncation the cut falls at the rows[cap-1]/rows[cap]
      // boundary (the fetch is ordered (block_num, op_id) `dir`). Drop the
      // truncated-end block ONLY when the cut fell INSIDE a block — i.e. the probe
      // row (rows[cap], the first dropped row) shares the block of the last kept row
      // (rows[cap-1]): that block is partial, and a cap-truncated partial block must
      // never be exposed. When the cut is block-edge-aligned (the probe is in a
      // different block) the truncated-end block is COMPLETE — keep it, or a
      // forward cursor would never recover it (the 'desc'/SPA floor only slides
      // forward; the 'asc'/digest floor would age it out permanently). In the
      // single-block-exceeds-cap case the partial-drop empties the batch (documented
      // residual: the block surfaces once the floor slides to contain it).
      const probeBlock = Number((result.rows[cap] as Record<string, unknown>).block_num);
      const lastKeptBlock = Number((result.rows[cap - 1] as Record<string, unknown>).block_num);
      if (probeBlock === lastKeptBlock) {
        const boundaryBlock = direction === 'desc'
          ? events[0].block_num
          : events[events.length - 1].block_num;
        delivered = events.filter((e) => e.block_num !== boundaryBlock);
      }
    }

    const latestBlock = delivered.length > 0
      ? delivered[delivered.length - 1].block_num
      : floor;

    return {
      events: delivered,
      latest_block: latestBlock,
      has_more: capHit,
    };
  } catch (err) {
    // Intentional swallow-to-null (kept asymmetric with the
    // single-resource paper/review/comment-existence sites that throw):
    // this notifications query is a broad multi-CTE scan keyed on a
    // window `floor` ($2) that can legitimately reach the 30s
    // statement_timeout under a wide window (a low floor for a recipient
    // with deep history). Translating to 503 retriable on every such
    // timeout would mis-classify "expensive query" as "HAF outage"
    // and the polling SPA's retry would compound load. The route
    // surfaces an empty-events response on null — same observational
    // shape the SPA already handles for "no new events".
    logger.error({ err }, 'HAF notifications query failed');
    return null;
  }
}
