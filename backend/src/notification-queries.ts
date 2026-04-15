/**
 * Shared HAF notification query — used by both the GET /api/notifications
 * endpoint and the email digest system.
 */

import { getPool } from './db.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { T, activeAccreditationsCteBody } from './hafsql.js';
import type { NotificationEvent, NotificationBatch } from './types/index.js';

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
      `WITH ${accredCte.sql}

      -- 1. New reviews on your papers (accredited reviewers only)
      --    Includes bridged papers where you are the registered_by user
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
      WHERE co.block_num > $2
        AND (co.json_metadata -> ${at} ->> 'type') = 'review'
        AND co.json_metadata ->> 'app' LIKE ${al}
        AND (
          co.parent_author = $1
          OR p.json_metadata -> ${at} -> 'source' ->> 'registered_by' = $1
        )

      UNION ALL

      -- 2. New accredited votes on your papers/reviews
      --    Includes bridged papers where you are the registered_by user
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
      LEFT JOIN ${T.comments} vp ON vp.author = v.author AND vp.permlink = v.permlink
      WHERE v.block_num > $2
        AND v.weight != 0
        AND (
          v.author = $1
          OR vp.json_metadata -> ${at} -> 'source' ->> 'registered_by' = $1
        )

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

      -- 6. New citations of your papers (accredited citing authors only)
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
        AND (citing.json_metadata -> ${at} ->> 'type') = 'paper'
        AND (
          cited_ref.author = $1
          OR cited_paper.json_metadata -> ${at} -> 'source' ->> 'registered_by' = $1
        )
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
