/**
 * Character rule on `accreditationRequestSchema`'s `full_name` and
 * `institution`, and its inheritance by `accreditationMetadataEditSchema`,
 * which picks those fields from the request schema.
 */

import { describe, it, expect } from 'vitest';
import { accreditationRequestSchema, accreditationMetadataEditSchema } from '../src/validation.js';

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
];

const ACCEPTED: Array<[string, string]> = [
  ['Latin with diacritics and punctuation', "Dr. Zoë Núñez-O'Brien"],
  ['Portuguese institution', 'Universidade do Porto'],
  ['CJK', '东京大学'],
  ['right-to-left mark', 'محمد\u200f علي'],
  ['left-to-right mark', 'ACME\u200e Lab'],
  ['zero-width non-joiner', 'علی\u200cرضا'],
];

describe('accreditationRequestSchema: full_name and institution character rule', () => {
  describe.each(['full_name', 'institution'] as const)('%s', (fieldName) => {
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

describe('accreditationMetadataEditSchema inherits the character rule', () => {
  it.each(['full_name', 'institution'] as const)('rejects a line break in %s', (fieldName) => {
    const result = accreditationMetadataEditSchema.safeParse({ [fieldName]: 'Line one\nLine two' });
    expect(result.success).toBe(false);
  });

  it.each(['full_name', 'institution'] as const)('accepts an ordinary %s', (fieldName) => {
    const result = accreditationMetadataEditSchema.safeParse({ [fieldName]: "Dr. Zoë Núñez-O'Brien" });
    expect(result.success).toBe(true);
  });
});
