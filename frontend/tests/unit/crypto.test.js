import { describe, it, expect } from 'vitest';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { sha256Hex, sha256File, slugify } from '../../src/crypto.js';

// jsdom's File/Blob do not implement .arrayBuffer() in this version, so the
// frontend's sha256File (which calls file.arrayBuffer()) can't consume them
// in the test environment. Node 20's native File/Blob from node:buffer are
// spec-compliant for our purposes — the production code runs in real browsers
// where File.arrayBuffer() is always present.

describe('sha256Hex', () => {
  it('hashes the empty string to the known NIST vector', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes "abc" to the known NIST vector', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes JSON-stringified objects deterministically (matches backend body-hash rule)', async () => {
    // sha256 of the literal string `{}` — matches JSON.stringify(body ?? {}) for bodyless requests.
    expect(await sha256Hex('{}')).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
  });

  it('handles unicode via UTF-8 encoding', async () => {
    // sha256("héllo") computed against a trusted reference.
    const hex = await sha256Hex('héllo');
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hex).toBe('3c48591d8d098a4538f5e013dfcf406e948eac4d3277b10bf614e295d6068179');
  });
});

describe('sha256File', () => {
  it('hashes a File the same as the string path for identical bytes', async () => {
    const content = 'hello world';
    const file = new NodeFile([content], 'greeting.txt', { type: 'text/plain' });
    const fromFile = await sha256File(file);
    const fromString = await sha256Hex(content);
    expect(fromFile).toBe(fromString);
  });

  it('produces the known vector for a Blob with empty content', async () => {
    const blob = new NodeBlob([], { type: 'application/octet-stream' });
    const hex = await sha256File(blob);
    expect(hex).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('slugify', () => {
  it('lowercases and replaces whitespace with dashes', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('collapses multiple whitespace/underscores into a single dash', () => {
    expect(slugify('hello   world')).toBe('hello-world');
    expect(slugify('hello___world')).toBe('hello-world');
    expect(slugify('hello _ world')).toBe('hello-world');
  });

  it('strips non-word characters that are not whitespace or dashes', () => {
    expect(slugify('hello!@#world')).toBe('helloworld');
    expect(slugify('A/B testing: v1.0')).toBe('ab-testing-v10');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugify('---hello---world---')).toBe('hello-world');
    expect(slugify('  spaced out  ')).toBe('spaced-out');
  });

  it('truncates to 200 characters', () => {
    const long = 'a'.repeat(250);
    const out = slugify(long);
    expect(out.length).toBe(200);
    expect(out).toBe('a'.repeat(200));
  });

  it('strips non-ASCII word characters (\\w is ASCII-only)', () => {
    // Locks current behavior: \w does not match é, ö, ñ — they are stripped.
    expect(slugify('Héllo Wörld')).toBe('hllo-wrld');
    expect(slugify('niño español')).toBe('nio-espaol');
  });

  it('returns empty string when every character is stripped', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('   ')).toBe('');
  });
});
