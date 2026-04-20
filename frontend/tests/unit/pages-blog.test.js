import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchBlogPosts = vi.fn();

vi.mock('../../src/api.js', () => ({
  fetchBlogPosts: (...args) => mockFetchBlogPosts(...args),
}));

vi.mock('../../src/components/paper-card.js', () => ({
  formatDate: (d) => d || '',
}));

const mockRouterStore = { navigate: vi.fn() };

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => {
      if (name === 'router') return mockRouterStore;
      return {};
    }),
  },
}));

import Alpine from 'alpinejs';
import { initBlogPage } from '../../src/pages/blog.js';

function createComponent() {
  initBlogPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  comp.$store = { router: mockRouterStore };
  return comp;
}

describe('blogPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchBlogPosts.mockResolvedValue({ data: [] });
  });

  describe('truncateBody', () => {
    it('returns empty string for falsy input', () => {
      const comp = createComponent();
      expect(comp.truncateBody(null)).toBe('');
      expect(comp.truncateBody(undefined)).toBe('');
      expect(comp.truncateBody('')).toBe('');
    });

    it('returns body as-is when shorter than maxLength', () => {
      const comp = createComponent();
      expect(comp.truncateBody('Short text')).toBe('Short text');
    });

    it('strips markdown headers', () => {
      const comp = createComponent();
      const body = '## Header\n' + 'a'.repeat(350);
      const result = comp.truncateBody(body);
      expect(result).not.toContain('##');
    });

    it('strips markdown images', () => {
      const comp = createComponent();
      const body = '![alt text](http://example.com/image.png) ' + 'a'.repeat(300);
      const result = comp.truncateBody(body);
      expect(result).not.toContain('![');
      expect(result).not.toContain('http://example.com/image.png');
    });

    it('strips markdown links but preserves text', () => {
      const comp = createComponent();
      const body = '[Click here](http://example.com) ' + 'a'.repeat(300);
      const result = comp.truncateBody(body);
      expect(result).not.toContain('](');
      expect(result).toContain('Click here');
    });

    it('strips formatting characters (*_~`)', () => {
      const comp = createComponent();
      const body = '**bold** _italic_ ~strike~ `code` ' + 'a'.repeat(300);
      const result = comp.truncateBody(body);
      expect(result).not.toContain('**');
      expect(result).not.toContain('_');
    });

    it('truncates long text and adds ellipsis', () => {
      const comp = createComponent();
      const body = 'word '.repeat(100); // 500 chars
      const result = comp.truncateBody(body);
      expect(result.endsWith('...')).toBe(true);
      expect(result.length).toBeLessThanOrEqual(304); // 300 + '...'
    });

    it('respects custom maxLength', () => {
      const comp = createComponent();
      const body = 'word '.repeat(100);
      const result = comp.truncateBody(body, 50);
      expect(result.endsWith('...')).toBe(true);
      expect(result.length).toBeLessThanOrEqual(54);
    });

    it('does not add ellipsis if stripped text is under maxLength', () => {
      const comp = createComponent();
      // Body is over 300 chars but after stripping markdown it's under
      const body = '![big image](http://example.com/' + 'x'.repeat(280) + '.png) short';
      const result = comp.truncateBody(body);
      expect(result).not.toContain('...');
    });
  });

  describe('loadPosts', () => {
    it('sets posts from response data', async () => {
      const comp = createComponent();
      mockFetchBlogPosts.mockResolvedValue({ data: [{ title: 'Post 1' }] });
      await comp.loadPosts();
      expect(comp.posts).toEqual([{ title: 'Post 1' }]);
      expect(comp.loading).toBe(false);
      expect(comp.error).toBeNull();
    });

    it('sets error on failure', async () => {
      const comp = createComponent();
      mockFetchBlogPosts.mockRejectedValue(new Error('fail'));
      await comp.loadPosts();
      expect(comp.error).toBe('blog.errorLoading');
      expect(comp.loading).toBe(false);
    });

    it('sets loading to true at start and false at end', async () => {
      const comp = createComponent();
      let loadingDuringFetch;
      mockFetchBlogPosts.mockImplementation(() => {
        loadingDuringFetch = comp.loading;
        return Promise.resolve({ data: [] });
      });
      await comp.loadPosts();
      expect(loadingDuringFetch).toBe(true);
      expect(comp.loading).toBe(false);
    });

    it('defaults to empty array when response has no data', async () => {
      const comp = createComponent();
      mockFetchBlogPosts.mockResolvedValue({});
      await comp.loadPosts();
      expect(comp.posts).toEqual([]);
    });
  });
});
