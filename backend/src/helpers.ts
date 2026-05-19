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
import { paperDisciplineField } from './types/disciplines.js';
import { validatedCid } from './lib/ipfs-validation.js';
import { applyAuthorSupersession } from './lib/author-supersession.js';

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

/**
 * JS-side mirror of the canonical `validReviewWhere` SQL gate
 * (`src/hafsql.ts`). A row is a valid PEvO review iff:
 *   - `meta[appTag].type === 'review'`, AND
 *   - `meta[appTag].rating` is an object with all four dimensions
 *     (methodology, novelty, clarity, significance) being integers in
 *     `[1, 5]`.
 *
 * The `meta.app === '<appTag>/...'` startsWith check was dropped because
 * the authoring client is not part of PEvO's trust layer — accredited
 * scientists broadcasting from peakd/ecency/raw clients still count.
 * Symmetric with the SQL gate's drop of `app LIKE '<appTag>/%'`.
 *
 * Keep this in sync with `validReviewWhere`. The post-filter at the
 * single-review route (`routes/reviews.ts`) acts as defense-in-depth on
 * top of the SQL gate; if the two definitions drift, a row can pass one
 * filter but fail the other and the display↔reputation parity invariant
 * breaks.
 */
const RATING_INT_1_TO_5 = /^[1-5]$/;
function isInt1To5(v: unknown): boolean {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 5;
  if (typeof v === 'string') return RATING_INT_1_TO_5.test(v);
  return false;
}

export function isPevoReview(meta: Record<string, unknown>): boolean {
  const appMeta = meta[config.appTag] as Record<string, unknown> | undefined;
  if (!appMeta || appMeta.type !== 'review') return false;
  const rating = appMeta.rating;
  // `typeof rating !== 'object'` admits arrays (`typeof [] === 'object'`
  // returns 'object' in JS), so an array-shaped rating slips through. The
  // SQL gate now uses `jsonb_typeof(...) = 'object'` which narrows to
  // JSON objects only (arrays are 'array', numbers/strings/null/booleans
  // get their own typeof); mirror that here so SQL↔JS parity is
  // preserved. Same root cause as the helper-doc note: 'object' is not
  // a runtime shape, it's a category that includes arrays in JS.
  if (!rating || typeof rating !== 'object' || Array.isArray(rating)) return false;
  const r = rating as Record<string, unknown>;
  return isInt1To5(r.methodology) && isInt1To5(r.novelty) && isInt1To5(r.clarity) && isInt1To5(r.significance);
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

/**
 * Extract one chain post's contribution to the cumulative authorized
 * continuation-author set. The chain-walk admit-set under cumulative-union
 * (see `agents/docs/ARCHITECTURE.md § 2 "Multi-Author Trust Model"`) is the
 * union of the per-post contributions across all chain posts walked so far;
 * this helper returns a single post's contribution. The set membership
 * rule is:
 *
 *   - **Native paper** (`pevo.type === 'paper'`): the `hive` field values
 *     from `pevo.authors[]`, lowercased. These are the named authors of
 *     the paper. Hive enforces lowercase chain-side, so case-mismatched
 *     metadata entries (e.g. `'Alice'` from a display-case copy-paste)
 *     would silently lock out the legitimate `alice` continuation. We
 *     normalize at extract time.
 *
 *   - **Bridge paper** (`pevo.type === 'bridge_paper'` AND post author ===
 *     `config.hiveBridgeAccount`): the contribution is
 *     `{config.hiveBridgeAccount}`. Bridge papers are immutable
 *     post-publish; the bridge account vouches for original-preprint
 *     authors who lack on-chain identity, gating continuations
 *     (reviews/discussions only) on the bridge account. Original-preprint
 *     authors are listed in `pevo.authors[]` but typically have
 *     `hive: null` (they don't have on-chain identity), so deferring to
 *     `pevo.authors[]` would yield an empty set and block ALL
 *     continuations of bridge papers. The Option-b carve-out admitting
 *     `config.hiveBridgeAccount` is now strictly defense-in-depth under
 *     the immutability policy.
 *
 * Returns an empty Set if the metadata is missing, malformed, the post
 * isn't a valid PEvO paper, or no `hive` entries are valid (defensive:
 * callers must treat empty as "this post contributes nothing", not as
 * "all admits"). Filters out non-string `hive` entries — bridge papers'
 * `hive: null` carrier entries do not contribute to the admit-set on
 * native chain posts; they remain in display via the per-post pass-through
 * for chain.length === 1 (bridge papers are immutable so they never reach
 * the cumulative-union display path).
 *
 * See `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`
 * for the convention this enforces. The continuation-author check is
 * **set membership** in this resource-scoped vouched-identity set, not
 * equality to a single pinned account.
 *
 * @param pevoMeta - the parsed `pevo` metadata sub-object (i.e.
 *   `meta[config.appTag]`). May be null/undefined/non-object.
 * @param postAuthor - the chain-level author of THIS chain post. Used to
 *   detect bridge papers via the `isPevoBridgePaper` author-pin (each
 *   post is checked individually; the carve-out fires only when the
 *   post's author matches the bridge account).
 */
export function extractAuthorizedContinuationAuthors(
  pevoMeta: Record<string, unknown> | null | undefined,
  postAuthor: string,
): Set<string> {
  const authors: Set<string> = new Set();
  if (!pevoMeta || typeof pevoMeta !== 'object') return authors;
  // Bridge-paper special case: the bridge account is the only authorized
  // continuator. pevo.authors[] entries for bridge papers carry `hive: null`
  // since the original preprint authors don't own on-chain identity; the
  // bridge account vouches for them via the bridge-paper-author-pin
  // convention.
  if (pevoMeta.type === 'bridge_paper' && postAuthor === config.hiveBridgeAccount) {
    authors.add(config.hiveBridgeAccount);
    return authors;
  }
  const arr = pevoMeta.authors;
  if (!Array.isArray(arr)) return authors;
  for (const entry of arr) {
    if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      if (typeof e.hive === 'string') {
        const hive = e.hive.trim().toLowerCase();
        if (hive.length > 0) authors.add(hive);
      }
    }
  }
  return authors;
}

/**
 * Read a string field from parsed `pevo` metadata, or return `null` if
 * the value isn't a non-empty string.
 *
 * Why this exists: `safePevoMeta(...)` returns `Record<string, unknown>`,
 * so reading a string-shaped field naturally requires a runtime check.
 * The naive shape `(pevo[key] as string) ?? null` is a TypeScript
 * assertion (not a narrowing) — runtime values like `0`, `''`, `false`,
 * and `{}` flow through it as if they were strings, and the `?? null`
 * tail becomes dead from the checker's perspective. The naive shape
 * also passes empty strings through unchanged, diverging from the
 * codebase's other `pevo`-string read sites which all collapse `''`
 * to `null` via `|| null`. This helper unifies the read pattern: a
 * string field is either present (non-empty) or absent (null).
 *
 * **Contract:** `pevoString` narrows non-strings (and empty strings)
 * to null. It does NOT itself drive head-vs-root selection at the
 * atomic-triple site in `papers.ts` — the `'in'`-based
 * `headHasAnyTripleKey` sentinel decides whether head's view or
 * root's view of the IPFS triple wins atomically; `pevoString` then
 * narrows whichever side won. Per-field `??` chaining like
 * `pevoString(headPevo, 'ipfs_cid') ?? pevoString(rootPevo,
 * 'ipfs_cid')` re-introduces the Frankenstein-composition bug-class
 * that the atomic block exists to prevent — do not copy that shape
 * to new head-vs-root sites.
 *
 * Typical usage is at non-triple sites, where the value is read once
 * from a single `pevo` object:
 *
 *     const doi = pevoString(pevo, 'doi');
 *     // doi is `string | null`; non-string and empty-string runtime
 *     // values both collapse to null.
 */
export function pevoString(pevo: Record<string, unknown>, key: string): string | null {
  const v = pevo[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Read a string-array field from parsed `pevo` metadata. Non-array values
 * collapse to `[]`; array values are filtered to non-empty string entries
 * (numbers, booleans, objects, nulls, empty strings inside the array all
 * drop out). Always returns a fresh array.
 *
 * Why this exists: the prior pattern `(pevo[key] as string[]) || []` is a
 * TypeScript assertion (not a narrowing). At runtime, `pevo.keywords`
 * could be a string, a number, an object, or an array of mixed types; the
 * cast lets all of those flow through as `string[]` from the checker's
 * perspective. Downstream consumers that call `.map`, `.filter`, or
 * `.join` on the result then crash on non-string entries or coerce them
 * to display garbage. This helper unifies the read pattern: the result
 * is always a real `string[]` whose entries are guaranteed non-empty
 * strings.
 *
 * **Contract:** `pevoStringArray` narrows non-arrays to `[]` and filters
 * non-string / empty-string entries out of arrays. It does NOT itself
 * drive head-vs-root selection at coherent-triple sites (the IPFS triple
 * in `papers.ts` uses an `'in'`-based sentinel for that). Use this for
 * single-`pevo` reads, not head-vs-root selection at coherent-triple
 * sites — per-field `??` chaining like
 * `pevoStringArray(headPevo, 'keywords') ?? pevoStringArray(rootPevo,
 * 'keywords')` re-introduces the Frankenstein-composition bug-class that
 * the atomic-block invariant exists to prevent.
 *
 * Typical usage at non-triple sites:
 *
 *     const keywords = pevoStringArray(pevo, 'keywords');
 *     // keywords is `string[]`; non-array runtime values collapse to []
 *     // and non-string array entries (e.g. `[42, 'foo', null]`) are
 *     // filtered out.
 */
export function pevoStringArray(pevo: Record<string, unknown>, key: string): string[] {
  const v = pevo[key];
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry === 'string' && entry.length > 0) out.push(entry);
  }
  return out;
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
 *  PEvO bodies are composed as `## Abstract\n\n<abstract>` optionally followed
 *  by `\n\n---\n\n<full text>` (see composePostBody in publish.js). When the
 *  author uploads a PDF to IPFS without inline full text, the separator is
 *  absent and the entire body IS the abstract — returning only the first
 *  300 chars would silently truncate it. Legacy/non-PEvO posts that lack
 *  both the heading and the separator keep the 300-char preview fallback. */
export function extractAbstract(body: string): string {
  const sepIndex = body.indexOf('\n\n---\n\n');
  if (sepIndex !== -1) return body.slice(0, sepIndex).trim();
  if (/^##\s+Abstract\s*\n/.test(body)) return body.trim();
  return body.slice(0, 300);
}

/** Extract a PaperSummary shape from a Hive post + parsed metadata.
 *  review_count, citation_count, author_reputation, and is_accredited
 *  default to 0/false — callers should enrich from HAF or batch lookups.
 *
 *  ORCID supersession per `agents/docs/hive-schemas.md` § 1.1: every
 *  `authors[i]` gets `orcid_verified` and `orcid_discrepancy` populated
 *  from `orcidMap` (typically supplied by the caller via
 *  `getAccreditedOrcidsByAccount()`). Callers without an accreditation
 *  context pass `new Map()`; the supersession projection collapses to
 *  case-1/case-2 ("no claim") for every author. PaperSummary's contract
 *  omits `affiliation` per `agents/docs/api-contracts/papers.md`, so the
 *  post-supersession entries are stripped of that field. */
export function toPaperSummary(post: {
  author: string;
  permlink: string;
  title: string;
  body: string;
  created: string;
  net_votes: number;
}, meta: Record<string, unknown>, orcidMap: Map<string, string | null>): PaperSummary {
  const pevo = (meta[config.appTag] || {}) as Record<string, unknown>;
  const rawAuthors = Array.isArray(pevo.authors) ? (pevo.authors as Array<Record<string, unknown>>) : [];
  const supersededAuthors = applyAuthorSupersession(rawAuthors, orcidMap);
  const summaryAuthors: PaperAuthor[] = supersededAuthors.map((entry) => {
    // Strip affiliation to honor the PaperSummary shape. `applyAuthorSupersession`
    // emits the enumerated key set (name, hive, orcid, affiliation,
    // orcid_verified, orcid_discrepancy) so PaperDetail consumers reuse it
    // unchanged; here we drop the one PaperSummary-prohibited key. The
    // double cast through `unknown` is the TS-prescribed pattern for
    // narrowing the structurally-typed object literal to the nominal
    // PaperAuthor interface — chain shape is trustable per `parseMeta`'s
    // upstream parse, but TS can't infer that.
    const { affiliation: _affiliation, ...rest } = entry;
    return rest as unknown as PaperAuthor;
  });
  return {
    author: post.author,
    permlink: post.permlink,
    title: post.title,
    abstract: extractAbstract(post.body),
    // Route through paperDisciplineField so /api/profile/:account/papers
    // surfaces canon_name (lowercased + trimmed) consistent with /api/papers.
    // Coalesce to '' to preserve PaperSummary.discipline's `string` type
    // (helper returns string | null; '' is the historical absent shape).
    discipline: paperDisciplineField(pevo.discipline) ?? '',
    keywords: pevoStringArray(pevo, 'keywords'),
    authors: summaryAuthors,
    // Output-side CID shape validation. Closes the fourth emit path missed
    // by BACKEND-PAPER-DETAIL-CID-VALIDATE-ON-EMIT round-1 (the three sites
    // in `routes/papers.ts` were wrapped; this site, which feeds
    // `/api/profile/:username/papers` and any future consumer of
    // `toPaperSummary`, was unwrapped). See task round-2 hold item 1.
    ipfs_cid: validatedCid(pevoString(pevo, 'ipfs_cid'), {
      author: post.author,
      permlink: post.permlink,
    }),
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
