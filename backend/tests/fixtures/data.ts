/**
 * Shared test fixtures for PEvO backend integration tests.
 *
 * All mock data lives here. Test files import what they need
 * instead of defining inline mock objects.
 */

// ─── Hive Post Shapes ──────────────────────────────────────

export interface MockHivePost {
  author: string;
  permlink: string;
  title: string;
  body: string;
  format: string;
  created: string;
  net_votes: number;
  children?: number;
  parent_author: string;
  parent_permlink: string;
  json_metadata: string;
}

export interface MockHiveAccount {
  name: string;
  posting: { key_auths: [string, number][] };
}

// ─── Papers ─────────────────────────────────────────────────

export const PAPER_ALICE_QUANTUM: MockHivePost = {
  author: 'alice',
  permlink: 'quantum-paper',
  title: 'Quantum Computing Advances',
  body: 'This paper explores quantum computing breakthroughs in 2026.',
  created: '2026-03-01T00:00:00',
  net_votes: 10,
  children: 3,
  parent_permlink: 'pevo',
  parent_author: '',
  json_metadata: JSON.stringify({
    app: 'pevo/0.1',
    tags: ['pevo', 'science', 'physics'],
    pevo: {
      type: 'paper',
      version: 1,
      discipline: 'physics',
      keywords: ['quantum', 'computing'],
      authors: [{ name: 'Alice', hive: 'alice', orcid: '', affiliation: 'MIT' }],
      ipfs_cid: null,
    },
  }),
};

export const PAPER_BOB_NEURO: MockHivePost = {
  author: 'bob',
  permlink: 'neuro-paper',
  title: 'Neural Pathways Study',
  body: 'A study on neural pathways and their role in cognition.',
  created: '2026-02-15T00:00:00',
  net_votes: 5,
  children: 1,
  parent_permlink: 'pevo',
  parent_author: '',
  json_metadata: JSON.stringify({
    app: 'pevo/0.1',
    tags: ['pevo', 'science', 'neuroscience'],
    pevo: {
      type: 'paper',
      version: 1,
      discipline: 'neuroscience',
      keywords: ['neural', 'cognition'],
      authors: [{ name: 'Bob', hive: 'bob', orcid: '', affiliation: 'Stanford' }],
      ipfs_cid: 'QmNeuro123',
    },
  }),
};

export const ALL_PAPERS = [PAPER_ALICE_QUANTUM, PAPER_BOB_NEURO];

// ─── Reviews ────────────────────────────────────────────────

export const REVIEW_CAROL_ON_QUANTUM: MockHivePost = {
  author: 'carol',
  permlink: 're-alice-quantum-review',
  title: '',
  body: 'Excellent methodology.',
  created: '2026-03-05T00:00:00',
  net_votes: 2,
  parent_author: 'alice',
  parent_permlink: 'quantum-paper',
  json_metadata: JSON.stringify({
    app: 'pevo/0.1',
    tags: ['pevo', 'review'],
    pevo: {
      type: 'review',
      version: 1,
      rating: { methodology: 5, novelty: 4, clarity: 4, significance: 5 },
      is_anonymous: false,
    },
  }),
};

export const REVIEW_DAVE_ON_QUANTUM: MockHivePost = {
  author: 'dave',
  permlink: 're-alice-quantum-review-2',
  title: '',
  body: 'Formal review content.',
  created: '2026-03-09T00:00:00',
  net_votes: 5,
  parent_author: 'alice',
  parent_permlink: 'quantum-paper',
  json_metadata: JSON.stringify({
    app: 'pevo/0.1',
    tags: ['pevo', 'review'],
    pevo: {
      type: 'review',
      version: 1,
      rating: { methodology: 4, novelty: 3, clarity: 4, significance: 3 },
      is_anonymous: false,
    },
  }),
};

// ─── Discussion Comments ────────────────────────────────────

export const COMMENT_BOB_ON_QUANTUM: MockHivePost = {
  author: 'bob',
  permlink: 're-alice-quantum-comment-1',
  title: '',
  body: 'Great paper, interesting findings!',
  created: '2026-03-10T00:00:00',
  net_votes: 3,
  parent_author: 'alice',
  parent_permlink: 'quantum-paper',
  json_metadata: JSON.stringify({
    app: 'pevo/0.1',
    tags: ['pevo'],
    pevo: { type: 'comment', version: 1 },
  }),
};

export const COMMENT_CAROL_ON_QUANTUM: MockHivePost = {
  author: 'carol',
  permlink: 're-alice-quantum-comment-2',
  title: '',
  body: 'I have some questions about the methodology.',
  created: '2026-03-11T00:00:00',
  net_votes: 1,
  parent_author: 'alice',
  parent_permlink: 'quantum-paper',
  json_metadata: JSON.stringify({
    app: 'pevo/0.1',
    tags: ['pevo'],
    pevo: { type: 'comment', version: 1 },
  }),
};

export const REPLY_ALICE_TO_BOB: MockHivePost = {
  author: 'alice',
  permlink: 're-bob-reply-1',
  title: '',
  body: 'Thanks for the feedback!',
  created: '2026-03-10T12:00:00',
  net_votes: 0,
  parent_author: 'bob',
  parent_permlink: 're-alice-quantum-comment-1',
  json_metadata: JSON.stringify({
    app: 'pevo/0.1',
    tags: ['pevo'],
    pevo: { type: 'comment', version: 1 },
  }),
};

// ─── Notification History Entries ────────────────────────────

export const NOTIFICATION_HISTORY = [
  [1, {
    block: 82345678,
    timestamp: '2026-03-25T14:30:12',
    op: ['comment', {
      author: 'reviewer1',
      parent_author: 'scientist1',
      parent_permlink: 'my-paper',
      permlink: 're-my-paper-review',
      json_metadata: JSON.stringify({
        app: 'pevo/0.1',
        pevo: { type: 'review', version: 1 },
      }),
    }],
  }],
  [2, {
    block: 82345700,
    timestamp: '2026-03-25T14:31:00',
    op: ['custom_json', {
      json: JSON.stringify({
        action: 'vouch',
        voucher: 'scientist2',
        vouchee: 'scientist1',
        relationship: 'colleague',
      }),
    }],
  }],
];

// ─── Hive Accounts ──────────────────────────────────────────

export const ACCOUNT_ALICE: MockHiveAccount = {
  name: 'alice',
  posting: { key_auths: [['STM_MOCK_KEY', 1]] },
};

export const ACCOUNT_BOB: MockHiveAccount = {
  name: 'bob',
  posting: { key_auths: [['STM_MOCK_KEY_BOB', 1]] },
};
