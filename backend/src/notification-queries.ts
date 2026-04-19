/**
 * Shared HAF notification query — used by both the GET /api/notifications
 * endpoint and the email digest system.
 */

import { getPool } from './db.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { T, activeAccreditationsCteBody } from './hafsql.js';
// ─── Notification Types ──────────────────────────────────────────

export type NotificationEventType =
  | "new_review"
  | "new_citation"
  | "new_vote"
  | "accreditation_update"
  | "new_vouch"
  | "new_reply";

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
  paper_author: string;
  paper_permlink: string;
  permlink: string;
}

export type NotificationEvent =
  | NewReviewEvent
  | NewCitationEvent
  | NewVoteEvent
  | AccreditationUpdateEvent
  | NewVouchEvent
  | NewReplyEvent;

export interface NotificationBatch {
  events: NotificationEvent[];
  latest_block: number;
  has_more: boolean;
}

export async function fetchNotificationsFromHaf(
  account: string,
  sinceBlock: number,
  limit: number,
): Promise<NotificationBatch | null> {
  const pool = getPool();
  if (!pool) return null;

  try {
    // $1 = account, $2 = sinceBlock, $3 = limit, $4/$5 = CTE params, $N = appTag, $N+1 = appTag/%
    const accredCte = activeAccreditationsCteBody(4);
    const at = `$${accredCte.nextIdx}`;       // appTag for WHERE clauses
    const al = `$${accredCte.nextIdx + 1}`;   // appTag/% LIKE pattern
    const result = await pool.query(
      `WITH ${accredCte.sql},

      -- Pre-resolve bridge papers registered by this user (tiny result set).
      -- This avoids LEFT JOINing every vote/review/citation to comments just
      -- to check the registered_by field, which times out on old sinceBlock values.
      user_bridge_papers AS (
        SELECT c.author, c.permlink
        FROM ${T.comments} c
        WHERE c.parent_author = '' AND c.parent_permlink = ${at}
          AND c.json_metadata -> ${at} -> 'source' ->> 'registered_by' = $1
          AND c.json_metadata ->> 'app' LIKE ${al}
      )

      -- 1a. New reviews on your own papers (accredited reviewers only)
      SELECT
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
        NULL::text AS parent_permlink_ref
      FROM ${T.commentOps} co
      LEFT JOIN ${T.comments} p ON p.author = co.parent_author AND p.permlink = co.parent_permlink
      JOIN active_accreditations aa_r ON aa_r.account = co.author
      WHERE co.parent_author = $1
        AND co.block_num > $2
        AND (co.json_metadata -> ${at} ->> 'type') = 'review'
        AND co.json_metadata ->> 'app' LIKE ${al}

      UNION ALL

      -- 1b. New reviews on your bridge papers
      SELECT
        'new_review'::text,
        co.block_num,
        co.timestamp,
        co.author,
        co.parent_author,
        co.parent_permlink,
        COALESCE(p.title, '') AS paper_title,
        co.permlink,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL
      FROM ${T.commentOps} co
      JOIN user_bridge_papers bp ON bp.author = co.parent_author AND bp.permlink = co.parent_permlink
      LEFT JOIN ${T.comments} p ON p.author = co.parent_author AND p.permlink = co.parent_permlink
      JOIN active_accreditations aa_r ON aa_r.account = co.author
      WHERE co.block_num > $2
        AND (co.json_metadata -> ${at} ->> 'type') = 'review'
        AND co.json_metadata ->> 'app' LIKE ${al}

      UNION ALL

      -- 2a. New accredited votes on your own papers/reviews
      SELECT
        'new_vote'::text,
        v.block_num,
        v.timestamp,
        v.voter,
        v.author,
        v.permlink,
        NULL,
        NULL,
        'paper',
        v.weight::int,
        NULL, NULL, NULL, NULL, NULL
      FROM ${T.voteOps} v
      JOIN active_accreditations aa ON aa.account = v.voter
      WHERE v.author = $1
        AND v.block_num > $2
        AND v.weight != 0

      UNION ALL

      -- 2b. New accredited votes on your bridge papers
      SELECT
        'new_vote'::text,
        v.block_num,
        v.timestamp,
        v.voter,
        v.author,
        v.permlink,
        NULL,
        NULL,
        'paper',
        v.weight::int,
        NULL, NULL, NULL, NULL, NULL
      FROM ${T.voteOps} v
      JOIN active_accreditations aa ON aa.account = v.voter
      JOIN user_bridge_papers bp ON bp.author = v.author AND bp.permlink = v.permlink
      WHERE v.block_num > $2
        AND v.weight != 0

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
        NULL, NULL, NULL
      FROM ${T.customJson} cj
      WHERE cj.custom_id = ${at}
        AND cj.json::jsonb ->> 'account' = $1
        AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
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
        NULL, NULL
      FROM ${T.customJson} cj
      WHERE cj.custom_id = ${at}
        AND cj.json::jsonb ->> 'vouchee' = $1
        AND cj.json::jsonb ->> 'action' = 'vouch'
        AND cj.block_num > $2

      UNION ALL

      -- 5. New replies to your discussion comments (accredited users only)
      SELECT
        'new_reply'::text,
        co.block_num,
        co.timestamp,
        co.author,
        NULL, NULL, NULL,
        co.permlink,
        NULL, NULL, NULL, NULL, NULL,
        co.parent_author,
        co.parent_permlink
      FROM ${T.commentOps} co
      JOIN active_accreditations aa_c ON aa_c.account = co.author
      WHERE co.parent_author = $1
        AND co.block_num > $2
        AND (co.json_metadata -> ${at} ->> 'type') = 'comment'
        AND co.json_metadata ->> 'app' LIKE ${al}

      UNION ALL

      -- 6a. New citations of your own papers (accredited citing authors only)
      SELECT
        'new_citation'::text,
        citing.block_num,
        citing.timestamp,
        citing.author,
        cited_ref.author AS paper_author,
        cited_ref.permlink AS paper_permlink,
        COALESCE(cited_paper.title, '') AS paper_title,
        citing.permlink,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL
      FROM ${T.commentOps} citing
      JOIN active_accreditations aa_ct ON aa_ct.account = citing.author
      CROSS JOIN LATERAL jsonb_array_elements(
        citing.json_metadata -> ${at} -> 'citations'
      ) AS cite_elem
      CROSS JOIN LATERAL (
        SELECT cite_elem ->> 'author' AS author, cite_elem ->> 'permlink' AS permlink
      ) AS cited_ref
      LEFT JOIN ${T.comments} cited_paper
        ON cited_paper.author = cited_ref.author AND cited_paper.permlink = cited_ref.permlink
      WHERE citing.block_num > $2
        AND citing.author <> $1
        AND cited_ref.author = $1
        AND (citing.json_metadata -> ${at} ->> 'type') = 'paper'
        AND citing.json_metadata ->> 'app' LIKE ${al}

      UNION ALL

      -- 6b. New citations of your bridge papers
      SELECT
        'new_citation'::text,
        citing.block_num,
        citing.timestamp,
        citing.author,
        cited_ref.author AS paper_author,
        cited_ref.permlink AS paper_permlink,
        COALESCE(cited_paper.title, '') AS paper_title,
        citing.permlink,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL
      FROM ${T.commentOps} citing
      JOIN active_accreditations aa_ct ON aa_ct.account = citing.author
      CROSS JOIN LATERAL jsonb_array_elements(
        citing.json_metadata -> ${at} -> 'citations'
      ) AS cite_elem
      CROSS JOIN LATERAL (
        SELECT cite_elem ->> 'author' AS author, cite_elem ->> 'permlink' AS permlink
      ) AS cited_ref
      JOIN user_bridge_papers bp ON bp.author = cited_ref.author AND bp.permlink = cited_ref.permlink
      LEFT JOIN ${T.comments} cited_paper
        ON cited_paper.author = cited_ref.author AND cited_paper.permlink = cited_ref.permlink
      WHERE citing.block_num > $2
        AND citing.author <> $1
        AND (citing.json_metadata -> ${at} ->> 'type') = 'paper'
        AND citing.json_metadata ->> 'app' LIKE ${al}

      ORDER BY block_num ASC
      LIMIT $3`,
      [account, sinceBlock, limit, ...accredCte.params, config.appTag, `${config.appTag}/%`],
    );

    const events: NotificationEvent[] = [];
    for (const r of result.rows as Array<Record<string, unknown>>) {
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
            paper_author: r.paper_author as string,
            paper_permlink: r.paper_permlink as string,
            permlink: r.event_permlink as string,
          });
          break;
      }
    }

    const latestBlock = events.length > 0
      ? Math.max(...events.map((e) => e.block_num))
      : sinceBlock;

    return {
      events,
      latest_block: latestBlock,
      has_more: events.length >= limit,
    };
  } catch (err) {
    logger.error({ err }, 'HAF notifications query failed');
    return null;
  }
}
