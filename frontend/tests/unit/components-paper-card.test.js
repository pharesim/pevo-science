import { describe, it, expect } from 'vitest';
import { truncateText, formatDate } from '../../src/components/paper-card.js';

describe('truncateText', () => {
  it('returns empty string for null/undefined', () => {
    expect(truncateText(null)).toBe('');
    expect(truncateText(undefined)).toBe('');
  });

  it('returns text unchanged when shorter than maxLength', () => {
    expect(truncateText('Hello', 280)).toBe('Hello');
  });

  it('returns text unchanged when exactly maxLength', () => {
    const text = 'a'.repeat(280);
    expect(truncateText(text, 280)).toBe(text);
  });

  it('truncates at word boundary and appends ellipsis', () => {
    const text = 'word '.repeat(60); // 300 chars
    const result = truncateText(text, 50);
    expect(result.length).toBeLessThanOrEqual(54); // 50 + '...'
    expect(result).toMatch(/\.\.\.$/);
    expect(result).not.toMatch(/\s\.\.\.$/); // no trailing space before ellipsis
  });

  it('uses default maxLength of 280', () => {
    const text = 'a '.repeat(200); // 400 chars
    const result = truncateText(text);
    expect(result.length).toBeLessThanOrEqual(284);
    expect(result).toMatch(/\.\.\.$/);
  });
});

describe('formatDate', () => {
  it('returns empty string for falsy input', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate('')).toBe('');
    expect(formatDate(undefined)).toBe('');
  });

  it('formats a valid ISO date string', () => {
    const result = formatDate('2024-03-15T10:00:00Z');
    expect(result).toContain('Mar');
    expect(result).toContain('15');
    expect(result).toContain('2024');
  });

  it('handles invalid date gracefully', () => {
    // toLocaleDateString may return "Invalid Date" or the catch returns the raw string
    const result = formatDate('not-a-date');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
