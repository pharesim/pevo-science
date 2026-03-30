import { describe, it, expect } from 'vitest';
import {
  parseIdentifier,
  bridgePermlink,
  buildBridgeBody,
  buildBridgeMetadata,
} from '../src/bridge.js';
import { config } from '../src/config.js';
import type { BridgeLookupResult } from '@pevo/contracts';

const TAG = config.appTag;
const APP_ID = config.appId;

describe('parseIdentifier', () => {
  it('parses a plain arXiv ID', () => {
    const result = parseIdentifier('2301.12345');
    expect(result).toEqual({ type: 'arxiv', id: '2301.12345' });
  });

  it('parses arXiv: prefix', () => {
    const result = parseIdentifier('arXiv:2301.12345');
    expect(result).toEqual({ type: 'arxiv', id: '2301.12345' });
  });

  it('parses arXiv URL (abs)', () => {
    const result = parseIdentifier('https://arxiv.org/abs/2301.12345');
    expect(result).toEqual({ type: 'arxiv', id: '2301.12345' });
  });

  it('parses arXiv URL (pdf)', () => {
    const result = parseIdentifier('https://arxiv.org/pdf/2301.12345');
    expect(result).toEqual({ type: 'arxiv', id: '2301.12345' });
  });

  it('strips version suffix from arXiv ID', () => {
    const result = parseIdentifier('2301.12345v2');
    expect(result).toEqual({ type: 'arxiv', id: '2301.12345' });
  });

  it('parses a plain DOI', () => {
    const result = parseIdentifier('10.1101/2026.01.01.123456');
    expect(result).toEqual({ type: 'doi', id: '10.1101/2026.01.01.123456' });
  });

  it('parses a doi.org URL', () => {
    const result = parseIdentifier('https://doi.org/10.1101/2026.01.01.123456');
    expect(result).toEqual({ type: 'doi', id: '10.1101/2026.01.01.123456' });
  });

  // bioRxiv / medRxiv URLs → DOI
  it('parses bioRxiv URL to DOI', () => {
    const result = parseIdentifier('https://www.biorxiv.org/content/10.1101/2023.01.01.123456');
    expect(result).toEqual({ type: 'doi', id: '10.1101/2023.01.01.123456' });
  });

  it('parses medRxiv URL to DOI', () => {
    const result = parseIdentifier('https://www.medrxiv.org/content/10.1101/2023.05.10.540001');
    expect(result).toEqual({ type: 'doi', id: '10.1101/2023.05.10.540001' });
  });

  it('strips version suffix from bioRxiv URL', () => {
    const result = parseIdentifier('https://www.biorxiv.org/content/10.1101/2023.01.01.123456v2');
    expect(result).toEqual({ type: 'doi', id: '10.1101/2023.01.01.123456' });
  });

  // PubMed URLs
  it('parses PubMed URL', () => {
    const result = parseIdentifier('https://pubmed.ncbi.nlm.nih.gov/37821468');
    expect(result).toEqual({ type: 'pubmed', id: '37821468' });
  });

  it('parses legacy NCBI PubMed URL', () => {
    const result = parseIdentifier('https://www.ncbi.nlm.nih.gov/pubmed/37821468');
    expect(result).toEqual({ type: 'pubmed', id: '37821468' });
  });

  // Semantic Scholar URLs
  it('parses Semantic Scholar URL', () => {
    const result = parseIdentifier(
      'https://www.semanticscholar.org/paper/Attention-Is-All-You-Need-Vaswani-Shazeer/204e3073870fae3d05bcbc2f6a8e263d9b72e776',
    );
    expect(result).toEqual({ type: 'semantic_scholar', id: '204e3073870fae3d05bcbc2f6a8e263d9b72e776' });
  });

  // ResearchGate URLs
  it('parses ResearchGate URL', () => {
    const result = parseIdentifier(
      'https://www.researchgate.net/publication/123456789_Some_Paper_Title',
    );
    expect(result).toEqual({ type: 'researchgate', id: '123456789_Some_Paper_Title' });
  });

  it('returns null for garbage input', () => {
    expect(parseIdentifier('not a valid identifier')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseIdentifier('')).toBeNull();
  });
});

describe('bridgePermlink', () => {
  it('generates permlink for arXiv', () => {
    expect(bridgePermlink({ type: 'arxiv', id: '2301.12345' })).toBe('bridge-arxiv-2301-12345');
  });

  it('generates permlink for DOI', () => {
    expect(bridgePermlink({ type: 'doi', id: '10.1101/2026.01.01.123456' }))
      .toBe('bridge-doi-10-1101-2026-01-01-123456');
  });
});

const SAMPLE_LOOKUP: BridgeLookupResult = {
  source_type: 'arxiv',
  doi: '10.48550/arXiv.2301.12345',
  arxiv_id: '2301.12345',
  title: 'Test Paper Title',
  authors: [
    { name: 'Alice Smith', orcid: null, affiliation: 'MIT' },
    { name: 'Bob Jones', orcid: '0000-0001-2345-6789', affiliation: null },
  ],
  abstract: 'This is the abstract of the test paper.',
  published_date: '2023-01-15',
  source_name: 'arXiv',
  source_url: 'https://arxiv.org/abs/2301.12345',
  pdf_url: 'https://arxiv.org/pdf/2301.12345',
  license: 'CC-BY-4.0',
  subjects: ['cs.CL', 'cs.LG'],
};

describe('buildBridgeBody', () => {
  it('includes title, authors, abstract, and attribution', () => {
    const body = buildBridgeBody(SAMPLE_LOOKUP, 'scientist1');
    expect(body).toContain('# Test Paper Title');
    expect(body).toContain('Alice Smith, Bob Jones');
    expect(body).toContain('2023-01-15 on arXiv');
    expect(body).toContain('This is the abstract of the test paper.');
    expect(body).toContain('@scientist1');
    expect(body).toContain('[View original](https://arxiv.org/abs/2301.12345)');
    expect(body).toContain('10.48550/arXiv.2301.12345');
  });
});

describe('buildBridgeMetadata', () => {
  it('returns valid bridge paper metadata', () => {
    const meta = buildBridgeMetadata(SAMPLE_LOOKUP, 'scientist1', 'Computer Science', ['NLP'], 'en', 1);
    expect(meta.app).toBe(APP_ID);
    expect(meta.tags).toContain(TAG);
    expect(meta.tags).toContain('science');

    const pevo = meta[TAG];
    expect(pevo.type).toBe('bridge_paper');
    expect(pevo.version).toBe(1);
    expect(pevo.discipline).toBe('Computer Science');
    expect(pevo.keywords).toEqual(['NLP']);
    expect(pevo.language).toBe('en');
    expect(pevo.authors).toHaveLength(2);
    expect(pevo.authors[0].name).toBe('Alice Smith');
    expect(pevo.authors[1].orcid).toBe('0000-0001-2345-6789');
    expect(pevo.source.type).toBe('arxiv');
    expect(pevo.source.doi).toBe('10.48550/arXiv.2301.12345');
    expect(pevo.source.arxiv_id).toBe('2301.12345');
    expect(pevo.source.registered_by).toBe('scientist1');
    expect(pevo.ipfs_cid).toBeNull();
  });
});
