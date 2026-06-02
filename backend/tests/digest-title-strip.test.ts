/**
 * Pure-function coverage for the digest email body builder's defense against
 * CR/LF injection via chain-derived free-form fields (paper titles).
 *
 * These exercise `singleLine` and `describeEvent` directly as pure functions:
 * the SMTP send in `sendDigestEmail` is not invoked, so no DB/Redis/SMTP is
 * needed. The risk class under test is line-forgery in the plain-text body —
 * a paper title carrying a newline could otherwise spoof an extra digest line
 * or a line that begins at column 0, mimicking the body's own structure.
 */

import { describe, it, expect } from 'vitest';
import { singleLine, describeEvent } from '../src/digest.js';
import type { NotificationEvent } from '../src/notification-queries.js';

function reviewEvent(title: string): NotificationEvent {
  return {
    type: 'new_review',
    block_num: 1,
    timestamp: '2026-01-01T00:00:00Z',
    actor: 'alice',
    paper_author: 'carol',
    paper_permlink: 'pp',
    paper_title: title,
    permlink: 'p',
  };
}

function citationEvent(title: string): NotificationEvent {
  return {
    type: 'new_citation',
    block_num: 1,
    timestamp: '2026-01-01T00:00:00Z',
    actor: 'bob',
    paper_author: 'carol',
    paper_permlink: 'pp',
    paper_title: title,
    citing_permlink: 'cp',
  };
}

describe('singleLine', () => {
  it('strips LF and CR', () => {
    expect(singleLine('Innocent\n→ Phishing line')).toBe('Innocent → Phishing line');
    expect(singleLine('a\rb')).toBe('a b');
    expect(singleLine('a\r\nb')).toBe('a b');
  });

  it('strips Unicode line terminators that are not \\s members in V8 (NEL, LS, PS)', () => {
    // NEL (U+0085) matches neither \r/\n nor \s in V8, so the explicit
    // line-terminator pass — not the whitespace collapse — has to catch it.
    expect(singleLine('a\u0085b')).toBe('a b');
    expect(singleLine('a\u2028b')).toBe('a b');
    expect(singleLine('a\u2029b')).toBe('a b');
  });

  it('collapses internal whitespace runs to a single space', () => {
    expect(singleLine('foo   bar\t\tbaz')).toBe('foo bar baz');
  });

  it('trims leading and trailing whitespace', () => {
    expect(singleLine('  padded  ')).toBe('padded');
    expect(singleLine('\n\nlead trail\n')).toBe('lead trail');
  });

  it('handles null and undefined as empty string', () => {
    expect(singleLine(null)).toBe('');
    expect(singleLine(undefined)).toBe('');
  });
});

describe('describeEvent line-forgery defense', () => {
  it('renders a CR/LF title as a single body line (new_review)', () => {
    const line = `- ${describeEvent(reviewEvent('Innocent\n→ Phishing line'))}`;
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toBe('- alice reviewed your paper "Innocent → Phishing line"');
  });

  it('neuters a spoofing payload so the attacker line does not start at column 0', () => {
    // A title crafted to look like a forged digest bullet on its own line.
    const payload = 'Real Paper\n- mallory endorsed your paper';
    const line = `- ${describeEvent(citationEvent(payload))}`;
    // The whole thing collapses to one line; no embedded line begins with "- ".
    const embeddedLines = line.split('\n');
    expect(embeddedLines).toHaveLength(1);
    expect(line).toBe('- bob cited your paper "Real Paper - mallory endorsed your paper"');
  });

  it('neuters a NEL-forged line a whitespace-only strip would miss', () => {
    // U+0085 is not a whitespace member in V8; a CR/LF-only strip leaves it
    // intact, and it renders as a line break in some mail clients.
    const payload = 'Real Paper\u0085- mallory endorsed your paper';
    const line = `- ${describeEvent(citationEvent(payload))}`;
    expect(line.includes('\u0085')).toBe(false);
    expect(line).toBe('- bob cited your paper "Real Paper - mallory endorsed your paper"');
  });

  it('preserves legitimate titles unchanged aside from whitespace collapse', () => {
    expect(describeEvent(reviewEvent('A Study of Things')))
      .toBe('alice reviewed your paper "A Study of Things"');
  });

  it('applies the strip to citation titles too', () => {
    expect(describeEvent(citationEvent('Top\rSecret')))
      .toBe('bob cited your paper "Top Secret"');
  });
});

describe('multi-event body line accounting', () => {
  it('produces one body line per event regardless of CR/LF in titles', () => {
    const events: NotificationEvent[] = [
      reviewEvent('First\nInjected'),
      citationEvent('Second\r\nInjected'),
    ];
    // Mirror the body bullet construction in sendDigestEmail.
    const bullets = events.map((e) => `- ${describeEvent(e)}`);
    const body = bullets.join('\n');
    // Two events => two lines, not three+ from smuggled newlines.
    expect(body.split('\n')).toHaveLength(2);
  });
});
