/**
 * Preprint Bridge service.
 *
 * Fetches metadata from arXiv and CrossRef APIs, generates deterministic
 * permlinks, and constructs Hive comment operations for bridge papers.
 */

import crypto from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import type { BridgeLookupResult, BridgeLookupAuthor } from './types/index.js';

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// ─── Identifier parsing ──────────────────────────────────────────

export interface ParsedIdentifier {
  type: 'arxiv' | 'doi' | 'pubmed' | 'semantic_scholar' | 'researchgate';
  id: string;  // normalized: arXiv ID without prefix, DOI without url prefix, PMID, S2 hash, or RG slug
}

const ARXIV_PATTERNS = [
  /^arxiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)$/i,
  /^(\d{4}\.\d{4,5}(?:v\d+)?)$/,
  /arxiv\.org\/abs\/(\d{4}\.\d{4,5}(?:v\d+)?)/i,
  /arxiv\.org\/pdf\/(\d{4}\.\d{4,5}(?:v\d+)?)/i,
];

const DOI_PATTERNS = [
  /^(10\.\d{4,9}\/[^\s]+)$/,
  /doi\.org\/(10\.\d{4,9}\/[^\s]+)/i,
];

const BIORXIV_PATTERNS = [
  /(?:bio|med)rxiv\.org\/content\/(10\.\d{4,9}\/[^\s?#v]+)/i,
];

const PUBMED_PATTERNS = [
  /pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i,
  /ncbi\.nlm\.nih\.gov\/pubmed\/(\d+)/i,
];

const SEMANTIC_SCHOLAR_PATTERNS = [
  /semanticscholar\.org\/paper\/(?:.*\/)?([a-f0-9]{40})/i,
];

const RESEARCHGATE_PATTERNS = [
  /researchgate\.net\/publication\/(\d+[^\s?#]*)/i,
];

export function parseIdentifier(input: string): ParsedIdentifier | null {
  const trimmed = input.trim();

  for (const re of ARXIV_PATTERNS) {
    const m = trimmed.match(re);
    if (m) return { type: 'arxiv', id: m[1].replace(/v\d+$/, '') };
  }

  for (const re of DOI_PATTERNS) {
    const m = trimmed.match(re);
    if (m) return { type: 'doi', id: m[1] };
  }

  for (const re of BIORXIV_PATTERNS) {
    const m = trimmed.match(re);
    if (m) return { type: 'doi', id: m[1] };
  }

  for (const re of PUBMED_PATTERNS) {
    const m = trimmed.match(re);
    if (m) return { type: 'pubmed', id: m[1] };
  }

  for (const re of SEMANTIC_SCHOLAR_PATTERNS) {
    const m = trimmed.match(re);
    if (m) return { type: 'semantic_scholar', id: m[1] };
  }

  for (const re of RESEARCHGATE_PATTERNS) {
    const m = trimmed.match(re);
    if (m) return { type: 'researchgate', id: m[1] };
  }

  return null;
}

// ─── Permlink generation ─────────────────────────────────────────

export function bridgePermlink(parsed: ParsedIdentifier): string {
  const prefix = parsed.type === 'arxiv' ? 'bridge-arxiv-' : 'bridge-doi-';
  const slug = parsed.id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return (prefix + slug).slice(0, 256);
}

// ─── arXiv HTML fallback (when API returns 429) ─────────────────

function extractMeta(html: string, name: string): string | null {
  const re = new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

function extractAllMeta(html: string, name: string): string[] {
  const re = new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'gi');
  const results: string[] = [];
  let m;
  while ((m = re.exec(html)) !== null) results.push(m[1]);
  return results;
}

async function fetchFromArxivHtml(arxivId: string): Promise<BridgeLookupResult | null> {
  const url = `https://arxiv.org/abs/${encodeURIComponent(arxivId)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`arXiv abs page returned ${res.status}`);
  }

  const html = await res.text();

  const title = extractMeta(html, 'citation_title');
  if (!title) return null; // not a valid paper page

  const abstract = extractMeta(html, 'citation_abstract')?.replace(/\s+/g, ' ').trim() || '';
  const published = extractMeta(html, 'citation_date') || '';
  const pdfUrl = extractMeta(html, 'citation_pdf_url') || `https://arxiv.org/pdf/${arxivId}`;

  const authorNames = extractAllMeta(html, 'citation_author');
  const authors: BridgeLookupAuthor[] = authorNames.map((name) => ({
    name,
    orcid: null,
    affiliation: null,
  }));

  // Extract subjects from the primary-subject span
  const subjects: string[] = [];
  const subjectMatch = html.match(/class="primary-subject">([^<]+)</);
  if (subjectMatch) {
    const catMatch = subjectMatch[1].match(/\(([^)]+)\)/);
    if (catMatch) subjects.push(catMatch[1]);
  }

  return {
    source_type: 'arxiv',
    doi: null,
    arxiv_id: arxivId,
    title: title.replace(/\s+/g, ' ').trim(),
    authors,
    abstract,
    published_date: published.replace(/\//g, '-'),
    source_name: 'arXiv',
    source_url: `https://arxiv.org/abs/${arxivId}`,
    pdf_url: pdfUrl,
    license: null,
    subjects,
  };
}

// ─── arXiv API ───────────────────────────────────────────────────

async function fetchFromArxiv(arxivId: string): Promise<BridgeLookupResult | null> {
  // Try the Atom API first; fall back to scraping the abstract page on 429
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (res.status === 429) {
    logger.warn('arXiv API rate limited, falling back to abstract page');
    return fetchFromArxivHtml(arxivId);
  }

  if (!res.ok) {
    logger.error({ status: res.status }, 'arXiv API request failed');
    throw new Error(`arXiv API returned ${res.status}`);
  }

  const xml = await res.text();

  // Simple XML parsing — arXiv Atom feed is well-structured
  const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entryMatch) return null;
  const entry = entryMatch[1];

  // Check for error entry (arXiv returns an entry with "Error" id for invalid IDs)
  if (entry.includes('<title>Error</title>') || entry.includes('is not a valid arXiv identifier')) {
    return null;
  }

  const title = extractTag(entry, 'title')?.replace(/\s+/g, ' ').trim() || '';
  const abstract = extractTag(entry, 'summary')?.replace(/\s+/g, ' ').trim() || '';
  const published = extractTag(entry, 'published') || '';
  const doi = extractTag(entry, 'arxiv:doi') || null;

  // Authors
  const authors: BridgeLookupAuthor[] = [];
  const authorRegex = /<author>([\s\S]*?)<\/author>/g;
  let authorMatch;
  while ((authorMatch = authorRegex.exec(entry)) !== null) {
    const authorXml = authorMatch[1];
    const name = extractTag(authorXml, 'name') || '';
    const affiliation = extractTag(authorXml, 'arxiv:affiliation') || null;
    authors.push({ name, orcid: null, affiliation });
  }

  // Categories/subjects
  const subjects: string[] = [];
  const catRegex = /term="([^"]+)"\s+scheme="http:\/\/arxiv\.org/g;
  let catMatch;
  while ((catMatch = catRegex.exec(entry)) !== null) {
    subjects.push(catMatch[1]);
  }

  // License
  const licenseMatch = entry.match(/<arxiv:license[^>]*>([^<]*)<\/arxiv:license>/) ||
                       entry.match(/href="([^"]*creativecommons[^"]*)"/);
  const license = licenseMatch ? licenseMatch[1].trim() : null;

  return {
    source_type: 'arxiv',
    doi,
    arxiv_id: arxivId,
    title,
    authors,
    abstract,
    published_date: published.slice(0, 10),
    source_name: 'arXiv',
    source_url: `https://arxiv.org/abs/${arxivId}`,
    pdf_url: `https://arxiv.org/pdf/${arxivId}`,
    license,
    subjects,
  };
}

function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const m = xml.match(re);
  return m ? m[1] : null;
}

// ─── CrossRef API ────────────────────────────────────────────────

async function fetchFromCrossRef(doi: string): Promise<BridgeLookupResult | null> {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'PEvO/0.1 (https://pevo.science; mailto:admin@pevo.science)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    logger.error({ status: res.status }, 'CrossRef API request failed');
    throw new Error(`CrossRef API returned ${res.status}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const msg = (data as { message: Record<string, unknown> }).message;
  if (!msg) return null;

  const title = Array.isArray(msg.title) ? (msg.title as string[])[0] || '' : '';
  const abstract = (msg.abstract as string || '').replace(/<[^>]+>/g, '').trim();

  // Authors
  const rawAuthors = (msg.author || []) as Array<Record<string, unknown>>;
  const authors: BridgeLookupAuthor[] = rawAuthors.map((a) => ({
    name: [a.given, a.family].filter(Boolean).join(' ') || '',
    orcid: (a.ORCID as string || '').replace('http://orcid.org/', '').replace('https://orcid.org/', '') || null,
    affiliation: Array.isArray(a.affiliation) && a.affiliation.length > 0
      ? (a.affiliation[0] as Record<string, string>).name || null
      : null,
  }));

  // Published date
  const dateParts = (msg['published-print'] || msg['published-online'] || msg.created) as { 'date-parts'?: number[][] } | undefined;
  const dp = dateParts?.['date-parts']?.[0] || [];
  const publishedDate = dp.length >= 3
    ? `${dp[0]}-${String(dp[1]).padStart(2, '0')}-${String(dp[2]).padStart(2, '0')}`
    : dp.length >= 1 ? `${dp[0]}-01-01` : '';

  // Source URL
  const sourceUrl = (msg.URL as string) || `https://doi.org/${doi}`;

  // PDF link
  const links = (msg.link || []) as Array<Record<string, string>>;
  const pdfLink = links.find((l) => l['content-type'] === 'application/pdf');
  const pdfUrl = pdfLink?.URL || null;

  // License
  const licenses = (msg.license || []) as Array<Record<string, unknown>>;
  const license = licenses.length > 0 ? (licenses[0].URL as string) || null : null;

  // Subjects
  const subjects = (msg.subject || []) as string[];

  // Check for arXiv ID in alternative-id
  const altIds = (msg['alternative-id'] || []) as string[];
  const arxivId = altIds.find((id) => /^\d{4}\.\d{4,5}$/.test(id)) || null;

  // Source name from container-title or publisher
  const containerTitle = Array.isArray(msg['container-title']) ? (msg['container-title'] as string[])[0] : null;
  const publisher = msg.publisher as string || '';
  const sourceName = containerTitle || publisher || 'CrossRef';

  return {
    source_type: 'crossref',
    doi,
    arxiv_id: arxivId,
    title,
    authors,
    abstract,
    published_date: publishedDate,
    source_name: sourceName,
    source_url: sourceUrl,
    pdf_url: pdfUrl,
    license,
    subjects,
  };
}

// ─── External identifier resolvers ──────────────────────────────

async function resolvePubMedDoi(pmid: string): Promise<string | null> {
  const url = `https://api.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?ids=${encodeURIComponent(pmid)}&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const data = await res.json() as { records?: Array<{ doi?: string }> };
  return data.records?.[0]?.doi || null;
}

async function resolveSemanticScholarDoi(paperId: string): Promise<string | null> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(paperId)}?fields=externalIds`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const data = await res.json() as { externalIds?: { DOI?: string } };
  return data.externalIds?.DOI || null;
}

async function resolveResearchGateDoi(slug: string): Promise<string | null> {
  const url = `https://www.researchgate.net/publication/${slug}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { 'User-Agent': 'PEvO/0.1 (https://pevo.science)' },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/<meta\s+(?:property|name)="citation_doi"\s+content="([^"]+)"/i);
  return m ? m[1] : null;
}

/**
 * Resolve any parsed identifier to a canonical 'arxiv' | 'doi' type.
 * For PubMed, Semantic Scholar, and ResearchGate, this makes network
 * calls to resolve the DOI.
 */
export type CanonicalIdentifier = { type: 'arxiv' | 'doi'; id: string };

export async function resolveToCanonical(identifier: string): Promise<CanonicalIdentifier | null> {
  const parsed = parseIdentifier(identifier);
  if (!parsed) return null;

  if (parsed.type === 'arxiv' || parsed.type === 'doi') return parsed as CanonicalIdentifier;

  let doi: string | null = null;

  if (parsed.type === 'pubmed') {
    doi = await resolvePubMedDoi(parsed.id);
  } else if (parsed.type === 'semantic_scholar') {
    doi = await resolveSemanticScholarDoi(parsed.id);
  } else if (parsed.type === 'researchgate') {
    doi = await resolveResearchGateDoi(parsed.id);
  }

  if (!doi) return null;
  return { type: 'doi', id: doi };
}

// ─── Public API ──────────────────────────────────────────────────

export async function lookupPreprint(identifier: string): Promise<BridgeLookupResult | null> {
  const parsed = parseIdentifier(identifier);
  if (!parsed) {
    // Try both APIs as fallback
    const [arxivResult, crossrefResult] = await Promise.allSettled([
      fetchFromArxiv(identifier),
      fetchFromCrossRef(identifier),
    ]);
    if (arxivResult.status === 'fulfilled' && arxivResult.value) return arxivResult.value;
    if (crossrefResult.status === 'fulfilled' && crossrefResult.value) return crossrefResult.value;
    return null;
  }

  if (parsed.type === 'arxiv') {
    return fetchFromArxiv(parsed.id);
  }

  if (parsed.type === 'doi') {
    return fetchFromCrossRef(parsed.id);
  }

  // Resolve indirect identifiers (PubMed, Semantic Scholar, ResearchGate) to DOI
  const canonical = await resolveToCanonical(identifier);
  if (!canonical) return null;

  if (canonical.type === 'arxiv') return fetchFromArxiv(canonical.id);
  return fetchFromCrossRef(canonical.id);
}

/**
 * Build the Hive post body for a bridge paper.
 */
export function buildBridgeBody(
  meta: BridgeLookupResult,
  registeringUser: string,
): string {
  const authorList = meta.authors.map((a) => a.name).join(', ') || 'Unknown';
  const doiLine = meta.doi ? `**DOI:** [${meta.doi}](https://doi.org/${meta.doi})\n` : '';
  const licenseLine = meta.license ? `**License:** ${meta.license}\n` : '';

  return `# ${meta.title}

**Authors:** ${authorList}
**Published:** ${meta.published_date} on ${meta.source_name}
${doiLine}${licenseLine}
---

## Abstract

${meta.abstract}

---

*This paper was originally published on ${meta.source_name}. It was registered on PEvO by @${registeringUser} to enable open scientific evaluation. [View original](${meta.source_url})*`;
}

/**
 * Build the full json_metadata object for a bridge paper.
 */
export function buildBridgeMetadata(
  meta: BridgeLookupResult,
  registeringUser: string,
  discipline: string,
  keywords: string[],
  language: string,
  version: number,
  title: string,
  body: string,
  postAuthor: string,
  postPermlink: string,
) {
  const authors = meta.authors.map((a) => ({
    name: a.name,
    hive: null as string | null,
    orcid: a.orcid || null,
  }));

  const pevo = {
    type: 'bridge_paper' as const,
    version,
    authors,
    discipline,
    keywords,
    language,
    citations: [] as unknown[],
    ipfs_cid: null,
    ipfs_filename: null,
    document_hash: null,
    source: {
      type: meta.source_type,
      doi: meta.doi,
      arxiv_id: meta.arxiv_id,
      url: meta.source_url,
      pdf_url: meta.pdf_url,
      published_date: meta.published_date,
      source_name: meta.source_name,
      license: meta.license,
      registered_by: registeringUser,
    },
  };

  return {
    app: config.appId,
    canonical_url: `${config.appUrl}/paper/${postAuthor}/${postPermlink}`,
    tags: [config.appTag, 'science', discipline.toLowerCase().replace(/\s+/g, '-')].filter(Boolean),
    [config.appTag]: pevo,
  };
}
