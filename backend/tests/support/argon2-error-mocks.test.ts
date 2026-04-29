/**
 * Self-tests for the shared `assertArgon2AbortIsSilent` helper.
 *
 * The helper is the choke point for 7+ silent-abort assertion sites across
 * the argon2 route-translation tests. Coverage of its three outcome
 * branches and its round-3 invocation-guard was previously incidental
 * (callers exercise only the happy-path "timeout + mock-called-once" cell).
 * Per `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`,
 * a defense-in-depth guard that exists to catch a specific regression class
 * must itself be regression-fenced — otherwise a future refactor that
 * weakens or drops the guard ships green.
 *
 * Justification for `vi.fn` + synthetic supertest-shaped promises (no real
 * supertest / Express here): the unit under test is the helper itself.
 * Driving its three outcome-classification branches deterministically
 * requires constructing the exact resolution shapes the helper inspects
 * (`Promise<{status: number}>` for the response branch, `{code:
 * 'ECONNABORTED', timeout, message}` rejection for the timeout branch,
 * arbitrary other rejection for the other-error branch). Spinning up a
 * real Express app + supertest to drive these branches would couple this
 * unit test to four route handlers and obscure the property under test.
 * `verifyHiveSignature` is not in the helper's call graph; no middleware
 * is mocked.
 *
 * Round-4 hold-block item 1 of `backend-argon2-error-routes-test-coverage`.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Response as SupertestResponse } from 'supertest';
import type { runWithArgon2Slot as RunWithArgon2SlotType } from '../../src/lib/argon2-semaphore.js';
import { assertArgon2AbortIsSilent } from './argon2-error-mocks.js';

type MockFn = ReturnType<typeof vi.fn<typeof RunWithArgon2SlotType>>;

function makeMockFn(): MockFn {
  return vi.fn<typeof RunWithArgon2SlotType>();
}

/**
 * Construct a supertest-shaped timeout-rejection. Mirrors what supertest's
 * `.timeout({ deadline: 250 })` actually emits when no response arrives —
 * the helper's `outcome.kind === 'timeout'` branch is gated on this exact
 * shape (one of: `code === 'ECONNABORTED'`, numeric `timeout` field, or
 * `/Timeout/i` in `message`).
 */
function timeoutRejection(): unknown {
  return Object.assign(new Error('Timeout of 250ms exceeded'), {
    code: 'ECONNABORTED',
    timeout: 250,
  });
}

/**
 * Cast a partial response shape into the `SupertestResponse` slot. The
 * helper only reads `res.status`; faking the rest avoids dragging in the
 * full supertest type surface.
 */
function fakeResponse(status: number): Promise<SupertestResponse> {
  return Promise.resolve({ status } as unknown as SupertestResponse);
}

describe('assertArgon2AbortIsSilent — outcome classification self-tests', () => {
  it('rejects when the request resolved with a response (route wrote a body)', async () => {
    // The mutation this guard catches: a route that returned a 500 (or any
    // other status) on the abort path within the supertest deadline. Without
    // this branch the helper would silently see no rejection and pass.
    const mockFn = makeMockFn();
    // Mock was "called once" (simulating the route entering argon2 then
    // writing a body) so the second assertion would otherwise pass; the
    // outcome.kind branch is what must trip first.
    mockFn();

    await expect(
      assertArgon2AbortIsSilent(fakeResponse(500), mockFn),
    ).rejects.toThrow(/silent-abort contract violated/);
    await expect(
      assertArgon2AbortIsSilent(fakeResponse(500), makeMockFn()),
    ).rejects.toThrow(/route wrote response with status 500/);
  });

  it('resolves cleanly when the request timed out AND the mock fn was called once', async () => {
    const mockFn = makeMockFn();
    mockFn(); // Simulate the route entering argon2 before hanging.

    await expect(
      assertArgon2AbortIsSilent(Promise.reject(timeoutRejection()), mockFn),
    ).resolves.toBeUndefined();
  });

  it('rejects when the request timed out but the mock fn was NEVER called (round-3 invocation-guard regression class)', async () => {
    // The mutation this guard catches: a route that hangs at an unmocked
    // `await` BEFORE reaching argon2 (e.g. a DB/Redis call the test forgot
    // to seed, a never-resolving feature-flag check). The supertest deadline
    // fires regardless; without the invocation guard, outcome.kind would be
    // 'timeout' and the helper would false-pass even though the abort path
    // was never entered.
    const mockFn = makeMockFn();
    // Note: mockFn is NOT called; this is the regression scenario.

    await expect(
      assertArgon2AbortIsSilent(Promise.reject(timeoutRejection()), mockFn),
    ).rejects.toThrow(/route hung but argon2 path was never entered/);
  });

  it('rejects with the unexpected-error diagnostic when the request rejects with a non-timeout error', async () => {
    // The mutation this branch catches: a network-layer crash or a
    // supertest rejection shape the timeout-classifier doesn't recognize.
    // Without the diagnostic message, vitest's default `expected
    // 'other-error' to be 'timeout'` would not surface the underlying
    // err.toString() that names what actually went wrong.
    const mockFn = makeMockFn();
    mockFn();
    const otherErr = new Error('ECONNRESET');

    await expect(
      assertArgon2AbortIsSilent(Promise.reject(otherErr), mockFn),
    ).rejects.toThrow(/unexpected error: Error: ECONNRESET/);
  });
});
