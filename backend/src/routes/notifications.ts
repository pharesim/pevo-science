import { Router, type Request, type Response } from 'express';
import { isHafAvailable } from '../db.js';
import { hiveClient } from '../hive.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { parseMeta, isPevoReview } from '../helpers.js';
import { getAccreditedSet } from '../accreditation.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { fetchNotificationsFromHaf } from '../notification-queries.js';
import type { NotificationEvent, NotificationBatch } from '@pevo/contracts';

const router = Router();

// ──────────────────────────────────────────────
// Hive API fallback
// ──────────────────────────────────────────────

interface RawEvent {
  type: string;
  blockNum: number;
  timestamp: string;
  actor: string;
  data: Record<string, unknown>;
  needsAccreditationCheck: boolean;
}

async function fetchNotificationsFromHiveApi(
  account: string,
  sinceBlock: number,
  limit: number,
): Promise<NotificationBatch> {
  try {
    const history: Array<[number, Record<string, unknown>]> = await hiveClient.database.call(
      'get_account_history',
      [account, -1, Math.min(limit * 3, 500)],
    );

    // Pass 1: collect candidate events and actors needing accreditation check
    const candidates: RawEvent[] = [];
    const actorsToCheck = new Set<string>();

    for (const [, entry] of history) {
      const op = entry.op as [string, Record<string, unknown>] | undefined;
      if (!op) continue;

      const blockNum = Number(entry.block) || 0;
      if (blockNum <= sinceBlock) continue;

      const timestamp = (entry.timestamp as string) || new Date().toISOString();
      const [opType, opData] = op;

      if (opType === 'comment' && opData.parent_author === account) {
        const meta = parseMeta(opData.json_metadata);
        const author = opData.author as string;
        if (isPevoReview(meta)) {
          actorsToCheck.add(author);
          candidates.push({ type: 'new_review', blockNum, timestamp, actor: author, data: opData, needsAccreditationCheck: true });
        } else if (meta.pevo && (meta.pevo as Record<string, unknown>).type === 'comment') {
          actorsToCheck.add(author);
          candidates.push({ type: 'new_reply', blockNum, timestamp, actor: author, data: opData, needsAccreditationCheck: true });
        }
      }

      if (opType === 'vote' && opData.author === account) {
        const voter = opData.voter as string;
        actorsToCheck.add(voter);
        candidates.push({ type: 'new_vote', blockNum, timestamp, actor: voter, data: opData, needsAccreditationCheck: true });
      }

      if (opType === 'custom_json') {
        try {
          const json = JSON.parse(opData.json as string);
          if (json.action === 'accredit' && json.account === account) {
            candidates.push({ type: 'accreditation_update', blockNum, timestamp, actor: '', data: json, needsAccreditationCheck: false });
          } else if (json.action === 'revoke' && json.account === account) {
            candidates.push({ type: 'accreditation_update_revoke', blockNum, timestamp, actor: '', data: json, needsAccreditationCheck: false });
          } else if (json.action === 'vouch' && json.vouchee === account) {
            candidates.push({ type: 'new_vouch', blockNum, timestamp, actor: json.voucher as string, data: json, needsAccreditationCheck: false });
          }
        } catch (err) {
          logger.debug({ err }, 'Skipping malformed custom_json in notifications');
        }
      }
    }

    // Pass 2: batch accreditation check for all actors at once
    const accreditedSet = actorsToCheck.size > 0
      ? await getAccreditedSet([...actorsToCheck])
      : new Set<string>();

    // Pass 3: filter and build final events
    const events: NotificationEvent[] = [];
    for (const c of candidates) {
      if (c.needsAccreditationCheck && !accreditedSet.has(c.actor)) continue;

      switch (c.type) {
        case 'new_review':
          events.push({
            type: 'new_review', block_num: c.blockNum, timestamp: c.timestamp,
            actor: c.actor, paper_author: account,
            paper_permlink: c.data.parent_permlink as string, paper_title: '',
            permlink: c.data.permlink as string,
          });
          break;
        case 'new_reply':
          events.push({
            type: 'new_reply', block_num: c.blockNum, timestamp: c.timestamp,
            actor: c.actor, parent_author: account,
            parent_permlink: c.data.parent_permlink as string,
            paper_author: '', paper_permlink: '',
            permlink: c.data.permlink as string,
          });
          break;
        case 'new_vote':
          events.push({
            type: 'new_vote', block_num: c.blockNum, timestamp: c.timestamp,
            actor: c.actor, target_author: account,
            target_permlink: c.data.permlink as string,
            target_type: 'paper', weight: Number(c.data.weight) || 0,
          });
          break;
        case 'accreditation_update':
          events.push({
            type: 'accreditation_update', block_num: c.blockNum, timestamp: c.timestamp,
            action: 'accredit', method: c.data.method as string,
          });
          break;
        case 'accreditation_update_revoke':
          events.push({
            type: 'accreditation_update', block_num: c.blockNum, timestamp: c.timestamp,
            action: 'revoke',
          });
          break;
        case 'new_vouch':
          events.push({
            type: 'new_vouch', block_num: c.blockNum, timestamp: c.timestamp,
            actor: c.actor, relationship: (c.data.relationship as string) || 'colleague',
          });
          break;
      }

      if (events.length >= limit) break;
    }

    events.sort((a, b) => a.block_num - b.block_num);
    const trimmed = events.slice(0, limit);

    const latestBlock = trimmed.length > 0
      ? Math.max(...trimmed.map((e) => e.block_num))
      : sinceBlock;

    return {
      events: trimmed,
      latest_block: latestBlock,
      has_more: events.length > limit,
    };
  } catch (err) {
    logger.error({ err }, 'Hive API notifications query failed');
    return { events: [], latest_block: sinceBlock, has_more: false };
  }
}

// ──────────────────────────────────────────────
// GET /api/notifications
// ──────────────────────────────────────────────

router.get('/', verifyHiveSignature, async (req: Request, res: Response) => {
  const account = req.hiveUsername!;
  const sinceBlock = parseInt(req.query.since_block as string, 10);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 50));

  if (isNaN(sinceBlock) || sinceBlock < 0 || sinceBlock > 2_000_000_000) {
    return sendError(res, 400, 'BAD_REQUEST', 'since_block query parameter is required and must be a non-negative integer');
  }

  if (isHafAvailable()) {
    const cacheKey = `notifications:${account}:${sinceBlock}:${limit}`;
    const result = await hafCache.getOrSet(cacheKey, () =>
      fetchNotificationsFromHaf(account, sinceBlock, limit),
    );
    if (result) {
      return sendOk(res, result);
    }
  }

  // Hive API fallback
  const result = await fetchNotificationsFromHiveApi(account, sinceBlock, limit);
  sendOk(res, result);
});

export default router;
