/**
 * Global test setup — runs before/after all test files.
 *
 * Closes the HAF database pool after tests complete to prevent
 * open handles from keeping the process alive.
 */

import { afterAll } from 'vitest';
import { closeHafPool } from '../src/db.js';

afterAll(async () => {
  await closeHafPool();
});
