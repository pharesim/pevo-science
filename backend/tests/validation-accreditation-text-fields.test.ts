/**
 * Character rules on `accreditationRequestSchema`'s `full_name`, `institution`
 * and `field`, their inheritance by `accreditationMetadataEditSchema`, which
 * picks those fields from the request schema, and `toAccreditOpText`, which
 * rewrites an ORCID profile name to pass them.
 */

import { describe, it, expect } from 'vitest';
import {
  accreditationRequestSchema,
  accreditationMetadataEditSchema,
  toAccreditOpText,
} from '../src/validation.js';

const VALID_REQUEST = { full_name: 'Jane Smith', institution: 'MIT', field: 'physics', email: 'jane@mit.edu' };

const REJECTED: Array<[string, string]> = [
  ['line feed', '\n'],
  ['carriage return', '\r'],
  ['tab', '\t'],
  ['NUL', '\u0000'],
  ['DEL', '\u007f'],
  ['NEL', '\u0085'],
  ['line separator', '\u2028'],
  ['paragraph separator', '\u2029'],
  ['LRE', '\u202a'],
  ['RLE', '\u202b'],
  ['PDF', '\u202c'],
  ['LRO', '\u202d'],
  ['RLO', '\u202e'],
  ['LRI', '\u2066'],
  ['RLI', '\u2067'],
  ['FSI', '\u2068'],
  ['PDI', '\u2069'],
  ['lone high surrogate', '\ud800'],
  ['lone low surrogate', '\udc00'],
];

const ACCEPTED: Array<[string, string]> = [
  ['Latin with diacritics and punctuation', "Dr. Zoë Núñez-O'Brien"],
  ['Portuguese institution', 'Universidade do Porto'],
  ['CJK', '东京大学'],
  ['Hangul, below the surrogate block', '서울대학교'],
  ['fullwidth punctuation, above the surrogate block', '東京大学（理学部）'],
  ['a character outside the BMP (a surrogate pair)', '\ud842\udfb7野家'],
  ['right-to-left mark', 'محمد\u200f علي'],
  ['left-to-right mark', 'ACME\u200e Lab'],
  ['zero-width non-joiner', 'علی\u200cرضا'],
];

const OP_TEXT_FIELDS = ['full_name', 'institution', 'field'] as const;

describe('accreditationRequestSchema: full_name, institution and field character rules', () => {
  describe.each(OP_TEXT_FIELDS)('%s', (fieldName) => {
    it.each(REJECTED)('rejects a value containing a %s', (_label, ch) => {
      const result = accreditationRequestSchema.safeParse({ ...VALID_REQUEST, [fieldName]: `Jane${ch}Smith` });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => i.path.join('.'))).toEqual([fieldName]);
    });

    it.each(ACCEPTED)('accepts %s', (_label, value) => {
      const result = accreditationRequestSchema.safeParse({ ...VALID_REQUEST, [fieldName]: value });
      expect(result.success).toBe(true);
    });
  });
});

describe('accreditationMetadataEditSchema inherits the character rules', () => {
  it.each(OP_TEXT_FIELDS)('rejects a line break in %s', (fieldName) => {
    const result = accreditationMetadataEditSchema.safeParse({ [fieldName]: 'Line one\nLine two' });
    expect(result.success).toBe(false);
  });

  it.each(OP_TEXT_FIELDS)('rejects a lone surrogate in %s', (fieldName) => {
    const result = accreditationMetadataEditSchema.safeParse({ [fieldName]: 'Half\ud800Pair' });
    expect(result.success).toBe(false);
  });

  it.each(OP_TEXT_FIELDS)('accepts an ordinary %s', (fieldName) => {
    const result = accreditationMetadataEditSchema.safeParse({ [fieldName]: "Dr. Zoë Núñez-O'Brien" });
    expect(result.success).toBe(true);
  });
});

describe('toAccreditOpText', () => {
  it.each(REJECTED)('removes a %s, and the result passes the request schema', (_label, ch) => {
    const out = toAccreditOpText(`Jane${ch}Smith`);
    expect(out).not.toContain(ch);
    expect(accreditationRequestSchema.safeParse({ ...VALID_REQUEST, full_name: out }).success).toBe(true);
  });

  it('turns each run of line breaks and other control characters into one space', () => {
    expect(toAccreditOpText('Jane\r\n\tSmith')).toBe('Jane Smith');
    expect(toAccreditOpText('Jane\u2028Smith\u0085Jr')).toBe('Jane Smith Jr');
  });

  it('drops the bidi embedding, override and isolate characters and an unpaired surrogate', () => {
    expect(toAccreditOpText('\u2067محمد علي\u2069')).toBe('محمد علي');
    expect(toAccreditOpText('Jane\u202e Smith')).toBe('Jane Smith');
    expect(toAccreditOpText('Jane\ud800 Smith\udc00')).toBe('Jane Smith');
  });

  it('trims the result, which is empty when nothing else was there', () => {
    expect(toAccreditOpText('  Jane Smith\n')).toBe('Jane Smith');
    expect(toAccreditOpText('\r\n\u202e\udc00\t')).toBe('');
  });

  it.each(ACCEPTED)('leaves %s unchanged', (_label, value) => {
    expect(toAccreditOpText(value)).toBe(value);
  });
});
