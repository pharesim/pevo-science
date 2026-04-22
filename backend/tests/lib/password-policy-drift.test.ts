// Drift-check gate pairing backend/src/lib/password-policy.ts with
// frontend/src/password-policy.js. The two helpers encode the same rule
// (length >= 10, one lowercase, one uppercase, one digit) and must stay in
// lockstep. A unilateral change on either side trips this test so FE-side
// acceptance and BE-side rejection can never diverge silently in prod.

import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MIN_PASSWORD_LENGTH as BE_MIN,
  isPasswordValid as beIsPasswordValid,
} from '../../src/lib/password-policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FE_HELPER_PATH = resolve(__dirname, '../../../frontend/src/password-policy.js');

type FeModule = {
  MIN_PASSWORD_LENGTH: number;
  isPasswordValid: (pw: unknown) => boolean;
};

async function loadFeHelper(): Promise<FeModule> {
  return (await import(pathToFileURL(FE_HELPER_PATH).href)) as FeModule;
}

// Shared test-vector grid — every case is labelled so a mismatch names the
// exact scenario that drifted. Extend this when the policy gains a new
// criterion; keep it identical across the grid on both sides.
const VECTORS: ReadonlyArray<readonly [label: string, input: unknown, expected: boolean]> = [
  ['meets every criterion', 'SecurePass123', true],
  ['exactly minimum length with every class', 'Abcdefgh12', true],
  ['one below minimum length', 'Short9aBc', false],
  ['missing lowercase letter', 'SECUREPASS123', false],
  ['missing uppercase letter', 'securepass123', false],
  ['missing digit', 'SecurePassword', false],
  ['empty string', '', false],
  ['undefined input', undefined, false],
  ['null input', null, false],
  ['number input', 123456789012345, false],
  ['object input', {}, false],
  ['array input', [], false],
  ['boolean input', true, false],
];

describe('password-policy drift-check (BE ↔ FE)', () => {
  it('MIN_PASSWORD_LENGTH matches across stacks', async () => {
    const fe = await loadFeHelper();
    expect(fe.MIN_PASSWORD_LENGTH).toBe(BE_MIN);
  });

  it('isPasswordValid agrees on every shared test vector', async () => {
    const fe = await loadFeHelper();
    const disagreements: string[] = [];
    for (const [label, input, expected] of VECTORS) {
      const beResult = beIsPasswordValid(input);
      const feResult = fe.isPasswordValid(input);
      if (beResult !== expected || feResult !== expected || beResult !== feResult) {
        disagreements.push(
          `${label}: BE=${beResult} FE=${feResult} expected=${expected}`,
        );
      }
    }
    expect(disagreements).toEqual([]);
  });
});
