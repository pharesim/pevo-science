/**
 * Shared registry for IPFS CIDs uploaded during an E2E run, read by
 * global-teardown to unpin them from Kubo and drop their Redis tracking keys.
 *
 * JSONL on disk because Playwright runs tests across multiple worker
 * processes: an in-memory Set in the fixture would only cover the worker
 * that wrote it. Appending to a file is the cheapest cross-process channel
 * and POSIX O_APPEND makes concurrent small writes atomic.
 */

import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CAPTURED_CIDS_PATH = resolve(__dirname, '..', '.captured-cids.jsonl');

export function recordCid(cid, meta = {}) {
  if (!cid || typeof cid !== 'string') return;
  const line = JSON.stringify({ cid, at: Date.now(), ...meta }) + '\n';
  appendFileSync(CAPTURED_CIDS_PATH, line, { flag: 'a' });
}

export function readCapturedCids() {
  if (!existsSync(CAPTURED_CIDS_PATH)) return [];
  const raw = readFileSync(CAPTURED_CIDS_PATH, 'utf8');
  const seen = new Set();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.cid) seen.add(obj.cid);
    } catch {
      // skip malformed lines
    }
  }
  return [...seen];
}

export function resetCapturedCids() {
  if (existsSync(CAPTURED_CIDS_PATH)) rmSync(CAPTURED_CIDS_PATH);
}
