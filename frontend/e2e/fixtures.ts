import { test as base, type Page } from "@playwright/test";

/**
 * Mock API responses for E2E tests.
 * Intercepts fetch requests to the backend so tests don't need a running server.
 */

const MOCK_PAPER: Record<string, unknown> = {
  author: "alice",
  permlink: "neural-plasticity-2026",
  title: "Neural Network Plasticity in Adult Brains",
  discipline: "neuroscience",
  keywords: ["fMRI", "plasticity"],
  created: "2026-03-01T12:00:00Z",
  last_update: "2026-03-01T12:00:00Z",
  net_votes: 42,
  review_count: 2,
  citation_count: 5,
  is_accredited: true,
  author_reputation: 78,
};

const MOCK_PAPER_DETAIL = {
  ...MOCK_PAPER,
  body: "## Abstract\n\nThis paper explores neural plasticity.\n\n## Introduction\n\nPlasticity is a fundamental property of the brain.",
  authors: [
    { name: "Dr. Alice", hive: "alice", orcid: "0000-0001-2345-6789", affiliation: "MIT" },
  ],
  ipfs_cid: null,
  ipfs_filename: null,
  reviews: [
    {
      author: "bob",
      permlink: "review-1",
      body: "Excellent methodology and clear presentation.",
      created: "2026-03-05T10:00:00Z",
      is_anonymous: false,
      is_accredited: true,
      net_votes: 8,
      rating: { methodology: 4, novelty: 5, clarity: 4, significance: 5 },
    },
  ],
  citations: [
    { author: "carol", permlink: "citing-paper", title: "A Follow-up Study on Plasticity" },
  ],
};

const MOCK_PROFILE = {
  username: "alice",
  is_accredited: true,
  accreditation: {
    name: "Dr. Alice",
    institution: "MIT",
    field: "neuroscience",
    method: "email",
    timestamp: "2026-01-15T08:00:00Z",
  },
  reputation: {
    score: 78,
    breakdown: {
      papers: 30,
      reviews: 15,
      paper_votes: 12,
      review_votes: 5,
      citations: 8,
      accreditation_bonus: 20,
      account_age: 3,
    },
  },
  stats: {
    paper_count: 3,
    review_count: 5,
    citation_count: 8,
    first_pevo_post: "2026-01-20T12:00:00Z",
  },
};

const MOCK_DISCIPLINES = [
  { name: "neuroscience", count: 12 },
  { name: "physics", count: 8 },
  { name: "biology", count: 6 },
];

const MOCK_PLATFORM_STATS = {
  total_papers: 150,
  total_reviews: 340,
  total_accredited_researchers: 85,
  total_citations: 420,
  active_disciplines: 12,
  papers_last_30_days: 23,
  reviews_last_30_days: 51,
};

const MOCK_RESEARCHERS = [
  {
    username: "alice",
    name: "Dr. Alice",
    institution: "MIT",
    field: "neuroscience",
    method: "email",
    timestamp: "2026-01-15T08:00:00Z",
  },
  {
    username: "bob",
    name: "Dr. Bob",
    institution: "Stanford",
    field: "physics",
    method: "wot",
    timestamp: "2026-02-10T14:00:00Z",
  },
];

function wrap<T>(data: T, meta?: { total: number; page: number; limit: number }) {
  return { status: "success" as const, data, meta };
}

export async function mockApi(page: Page) {
  await page.route("**/api/papers?*", async (route) => {
    await route.fulfill({
      json: wrap([MOCK_PAPER, { ...MOCK_PAPER, author: "bob", permlink: "quantum-gravity", title: "Quantum Gravity Explored", discipline: "physics" }], { total: 2, page: 1, limit: 10 }),
    });
  });

  await page.route("**/api/papers/alice/neural-plasticity-2026", async (route) => {
    await route.fulfill({ json: wrap(MOCK_PAPER_DETAIL) });
  });

  await page.route("**/api/papers/alice/neural-plasticity-2026/comments*", async (route) => {
    await route.fulfill({ json: wrap([]) });
  });

  await page.route("**/api/papers/alice/neural-plasticity-2026/citations*", async (route) => {
    await route.fulfill({ json: wrap([], { total: 0, page: 1, limit: 20 }) });
  });

  await page.route("**/api/profile/alice", async (route) => {
    await route.fulfill({ json: wrap(MOCK_PROFILE) });
  });

  await page.route("**/api/profile/alice/papers*", async (route) => {
    await route.fulfill({ json: wrap([MOCK_PAPER], { total: 1, page: 1, limit: 20 }) });
  });

  await page.route("**/api/disciplines", async (route) => {
    await route.fulfill({ json: wrap(MOCK_DISCIPLINES) });
  });

  await page.route("**/api/search?*", async (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get("q") || "";
    if (q.toLowerCase().includes("neural")) {
      await route.fulfill({
        json: wrap(
          [
            {
              author: "alice",
              permlink: "neural-plasticity-2026",
              title: "Neural Network Plasticity in Adult Brains",
              type: "paper",
              created: "2026-03-01T12:00:00Z",
              snippet: "This paper explores <mark>neural</mark> plasticity...",
              is_accredited: true,
            },
          ],
          { total: 1, page: 1, limit: 20 }
        ),
      });
    } else {
      await route.fulfill({ json: wrap([], { total: 0, page: 1, limit: 20 }) });
    }
  });

  await page.route("**/api/stats", async (route) => {
    await route.fulfill({ json: wrap(MOCK_PLATFORM_STATS) });
  });

  await page.route("**/api/accreditations?*", async (route) => {
    await route.fulfill({ json: wrap(MOCK_RESEARCHERS, { total: 2, page: 1, limit: 12 }) });
  });

  await page.route("**/api/accreditations/*", async (route) => {
    await route.fulfill({
      json: wrap({ username: "alice", is_accredited: true, method: "email", timestamp: "2026-01-15T08:00:00Z" }),
    });
  });

  await page.route("**/api/wot/*", async (route) => {
    await route.fulfill({
      json: wrap({ is_accredited: true, vouch_count: 0, threshold: 3, vouchers: [] }),
    });
  });

  await page.route("**/api/health", async (route) => {
    await route.fulfill({ json: { status: "ok", timestamp: new Date().toISOString() } });
  });

  await page.route("**/api/notifications*", async (route) => {
    await route.fulfill({ json: wrap({ events: [], latest_block: 1000 }) });
  });
}

export const test = base.extend<{ mockApi: void }>({
  mockApi: [
    async ({ page }, use) => {
      await mockApi(page);
      await use();
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
