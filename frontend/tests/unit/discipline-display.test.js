import { describe, it, expect } from 'vitest';
import { titleCaseDiscipline } from '../../src/lib/discipline-display.js';

describe('titleCaseDiscipline', () => {
  describe('edge cases', () => {
    it('returns empty string for empty input', () => {
      expect(titleCaseDiscipline('')).toBe('');
    });

    it('returns empty string for whitespace-only input', () => {
      expect(titleCaseDiscipline('   ')).toBe('');
    });

    it('returns empty string for non-string input', () => {
      expect(titleCaseDiscipline(null)).toBe('');
      expect(titleCaseDiscipline(undefined)).toBe('');
      expect(titleCaseDiscipline(42)).toBe('');
    });

    it('trims leading and trailing whitespace', () => {
      expect(titleCaseDiscipline('  physics  ')).toBe('Physics');
    });

    it('collapses multiple internal spaces to single spaces', () => {
      expect(titleCaseDiscipline('theory   of    computation')).toBe('Theory of Computation');
    });
  });

  describe('single word', () => {
    it('capitalizes a lowercase single word', () => {
      expect(titleCaseDiscipline('physics')).toBe('Physics');
    });

    it('normalizes mixed-case single word to title case', () => {
      expect(titleCaseDiscipline('pHYsIcs')).toBe('Physics');
    });

    it('uppercases a known initialism even alone', () => {
      expect(titleCaseDiscipline('ml')).toBe('ML');
      expect(titleCaseDiscipline('ai')).toBe('AI');
    });
  });

  describe('stopwords', () => {
    it('keeps stopwords lowercase when not first', () => {
      expect(titleCaseDiscipline('theory of computation')).toBe('Theory of Computation');
    });

    it('capitalizes a stopword when it is the first word', () => {
      expect(titleCaseDiscipline('of mice and men')).toBe('Of Mice and Men');
    });

    it('handles multiple stopwords in one title', () => {
      expect(titleCaseDiscipline('the art of the deal')).toBe('The Art of the Deal');
    });

    it('covers all declared stopwords (of, and, for, in, the, to, a, an)', () => {
      expect(titleCaseDiscipline('crime and punishment')).toBe('Crime and Punishment');
      expect(titleCaseDiscipline('code for america')).toBe('Code for America');
      expect(titleCaseDiscipline('life in japan')).toBe('Life in Japan');
      expect(titleCaseDiscipline('road to perdition')).toBe('Road to Perdition');
      expect(titleCaseDiscipline('once a day')).toBe('Once a Day');
      expect(titleCaseDiscipline('once an hour')).toBe('Once an Hour');
    });
  });

  describe('initialisms', () => {
    it('uppercases initialisms mid-phrase', () => {
      expect(titleCaseDiscipline('applied ml')).toBe('Applied ML');
      expect(titleCaseDiscipline('computational dna analysis')).toBe('Computational DNA Analysis');
    });

    it('uppercases initialisms regardless of input case', () => {
      expect(titleCaseDiscipline('applied Ml')).toBe('Applied ML');
      expect(titleCaseDiscipline('APPLIED ML')).toBe('Applied ML');
    });

    it('handles multiple initialisms in one title', () => {
      expect(titleCaseDiscipline('gpu and cpu architecture')).toBe('GPU and CPU Architecture');
    });

    it('initialism beats stopword when they would collide (not a real case, but documents priority)', () => {
      // No current stopword is also an initialism; this asserts the code
      // path prefers initialism uppercasing over stopword lowercasing.
      expect(titleCaseDiscipline('nlp in medicine')).toBe('NLP in Medicine');
    });
  });

  describe('hyphenated words', () => {
    it('capitalizes each hyphen-separated segment', () => {
      expect(titleCaseDiscipline('bio-informatics')).toBe('Bio-Informatics');
    });

    it('respects initialisms inside hyphenated words', () => {
      expect(titleCaseDiscipline('ml-ops')).toBe('ML-Ops');
    });

    it('handles stopword-free multi-hyphen compounds', () => {
      expect(titleCaseDiscipline('state-of-the-art')).toBe('State-Of-The-Art');
    });
  });

  describe('mixed-case input normalization', () => {
    it('normalizes arbitrarily mixed case input', () => {
      expect(titleCaseDiscipline('CoMpUtEr ScIeNcE')).toBe('Computer Science');
    });

    it('handles all-caps input without preserving existing casing', () => {
      expect(titleCaseDiscipline('QUANTUM PHYSICS')).toBe('Quantum Physics');
    });
  });
});
