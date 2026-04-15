import { Router, type Request, type Response } from 'express';
import { hiveClient } from '../hive.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { parseMeta } from '../helpers.js';

const router = Router();

interface BlogPost {
  author: string;
  permlink: string;
  title: string;
  body: string;
  created: string;
  tags: string[];
}

function toBlogPost(d: { author: string; permlink: string; title: string; body: string; created: string; json_metadata: unknown }): BlogPost {
  const meta = parseMeta(d.json_metadata);
  const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
  return {
    author: d.author,
    permlink: d.permlink,
    title: d.title,
    body: d.body,
    created: d.created,
    tags,
  };
}

async function fetchBlogPosts(limit: number): Promise<BlogPost[]> {
  const discussions = await hiveClient.database.getDiscussions('blog', {
    tag: config.blogAuthor,
    limit: Math.min(limit, 100),
  });

  return discussions
    .filter((d) => d.parent_permlink === config.blogTag)
    .map(toBlogPost);
}

// ──────────────────────────────────────────────
// GET /api/blog — list blog posts
// ──────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));

  try {
    const posts = await hafCache.getOrSet(
      `blog:${limit}`,
      () => fetchBlogPosts(limit),
      300_000,
      true,
    );
    sendOk(res, posts || []);
  } catch (err) {
    logger.error({ err }, 'Blog posts fetch failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to fetch blog posts');
  }
});

// ──────────────────────────────────────────────
// GET /api/blog/:permlink — single blog post
// ──────────────────────────────────────────────

router.get('/:permlink', async (req: Request, res: Response) => {
  const { permlink } = req.params;

  try {
    const content = await hiveClient.database.call('get_content', [config.blogAuthor, permlink]);
    if (!content || !content.author || content.parent_permlink !== config.blogTag) {
      return sendError(res, 404, 'NOT_FOUND', 'Blog post not found');
    }
    sendOk(res, toBlogPost(content));
  } catch (err) {
    logger.error({ err, permlink }, 'Blog post fetch failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to fetch blog post');
  }
});

export default router;
