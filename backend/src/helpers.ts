import type { Request } from 'express';
import type { PaperAuthor, PaperSortOption } from './types/index.js';

export interface PaperSummary {
  author: string;
  permlink: string;
  title: string;
  abstract: string;
  discipline: string;
  keywords: string[];
  authors: PaperAuthor[];
  ipfs_cid: string | null;
  created: string;
  net_votes: number;
  vote_strength: string | null;
  review_count: number;
  avg_rating: number;
  citation_count: number;
  author_reputation: number;
  is_accredited: boolean;
  accredited_authors: string[];
  source_type: "native" | "arxiv" | "crossref";
  doi: string | null;
}
import { config } from './config.js';
import { logger } from './logger.js';

export function parseMeta(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (err) { logger.warn({ err }, 'Failed to parse json_metadata string'); return {}; }
  }
  return (raw as Record<string, unknown>) ?? {};
}

export function isPevoPaper(meta: Record<string, unknown>): boolean {
  const appMeta = meta[config.appTag] as Record<string, unknown> | undefined;
  return appMeta?.type === 'paper' && typeof meta.app === 'string' && (meta.app as string).startsWith(`${config.appTag}/`);
}

export function isPevoReview(meta: Record<string, unknown>): boolean {
  const appMeta = meta[config.appTag] as Record<string, unknown> | undefined;
  return appMeta?.type === 'review' && typeof meta.app === 'string' && (meta.app as string).startsWith(`${config.appTag}/`);
}

/**
 * Returns true iff the metadata claims `type = 'bridge_paper'` AND the post
 * was authored by `config.hiveBridgeAccount`.
 *
 * The author argument is **load-bearing**: bridge identity is what distinguishes
 * a real bridge import from a spoofed self-claim. A type flag without an
 * identity check is a self-asserted exemption — see
 * `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`.
 * Callers that have a post in hand always have the author; pass it.
 */
export function isPevoBridgePaper(meta: Record<string, unknown>, author: string): boolean {
  const appMeta = meta[config.appTag] as Record<string, unknown> | undefined;
  return (
    appMeta?.type === 'bridge_paper'
    && author === config.hiveBridgeAccount
    && typeof meta.app === 'string'
    && (meta.app as string).startsWith(`${config.appTag}/`)
  );
}

export function isPevoAnyPaper(meta: Record<string, unknown>, author: string): boolean {
  return isPevoPaper(meta) || isPevoBridgePaper(meta, author);
}

export function parsePageLimit(req: Request) {
  const page = Math.min(10000, Math.max(1, parseInt(req.query.page as string, 10) || 1));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

export type SortField = PaperSortOption;
const VALID_SORTS = new Set<SortField>(['date', 'reputation', 'votes']);

export function parseSort(req: Request): SortField {
  const s = req.query.sort as string;
  return VALID_SORTS.has(s as SortField) ? (s as SortField) : 'date';
}

export function parseOrder(req: Request): 'asc' | 'desc' {
  return req.query.order === 'asc' ? 'asc' : 'desc';
}

/** Extract the abstract from a post body.
 *  The body format is: abstract + "\n\n---\n\n" + full text.
 *  Falls back to first 300 chars for pre-format posts. */
export function extractAbstract(body: string): string {
  const sepIndex = body.indexOf('\n\n---\n\n');
  if (sepIndex !== -1) return body.slice(0, sepIndex).trim();
  return body.slice(0, 300);
}

/** Extract a PaperSummary shape from a Hive post + parsed metadata.
 *  review_count, citation_count, author_reputation, and is_accredited
 *  default to 0/false — callers should enrich from HAF or batch lookups. */
export function toPaperSummary(post: {
  author: string;
  permlink: string;
  title: string;
  body: string;
  created: string;
  net_votes: number;
}, meta: Record<string, unknown>): PaperSummary {
  const pevo = (meta[config.appTag] || {}) as Record<string, unknown>;
  return {
    author: post.author,
    permlink: post.permlink,
    title: post.title,
    abstract: extractAbstract(post.body),
    discipline: (pevo.discipline as string) || '',
    keywords: (pevo.keywords as string[]) || [],
    authors: (pevo.authors as PaperSummary['authors']) || [],
    ipfs_cid: (pevo.ipfs_cid as string) || null,
    created: post.created,
    net_votes: post.net_votes,
    vote_strength: null,
    review_count: 0,
    avg_rating: 0,
    citation_count: 0,
    author_reputation: 0,
    is_accredited: false,
    accredited_authors: [],
    source_type: isPevoBridgePaper(meta, post.author)
      ? ((pevo.source as Record<string, unknown>)?.type as 'arxiv' | 'crossref') || 'arxiv'
      : 'native',
    doi: (isPevoBridgePaper(meta, post.author)
      ? ((pevo.source as Record<string, unknown>)?.doi as string) || null
      : null),
  };
}
