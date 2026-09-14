/**
 * Light-account fresh-auth on the CONSENT-OP surface, driven against the real
 * backend. An `author_accept` from the paper-detail accept affordance carries
 * a target-bound consent-op proof, minted at the real
 * `POST /api/custody/fresh-auth` (password factor) for the op's own
 * `(action, root_author, root_permlink)`, to the real
 * `POST /api/custody/broadcast`, where the gated-op scan hashes those same
 * fields off the op and the proof must have been minted for exactly them.
 *
 * This is a distinct mechanism from the session window
 * `non-consent-fresh-auth.spec.js` drives, not a variant of it. The consent-op
 * kind is single-use and target-bound; on the password factor this spec
 * drives, `mintAuthorshipFreshAuthProof` hands it straight to the broadcast,
 * and only the ORCID return leg writes it into `CONSENT_OP_PROOF_KEY` (not
 * driven here). A session-kind proof is refused on this surface with
 * `kind_mismatch` (ARCHITECTURE.md 6.4.1). The controls
 * at the end pin both halves: a replay of the accepted bundle is refused
 * because the consume spent the proof, and the same bundle carrying a freshly
 * minted session-kind proof is refused for its kind.
 *
 * Where the real-backend leg stops, and why that is the assertion: the seeded
 * light account carries no encrypted posting key, so `/api/custody/broadcast`
 * consumes the proof and then refuses at its first post-gate step, the
 * posting-key decrypt (`expectPostGateStop`, fixtures/light-account.js).
 * Nothing is signed and nothing reaches a Hive node. The spent-proof replay
 * doubles as the gate control: the identical bundle that just passed is
 * refused AT the gate once its proof is gone.
 *
 * Carve-out clause (a): the paper-detail READ routes and the boot-time authed
 * GETs are stubbed (fixtures/paper-mocks.js) so the accept affordance renders
 * against a deterministic authorship shape (an anchored slot for the signer,
 * still unconsented, plus the matching pending-consent row); that includes
 * the accreditation-status poll answering accredited for the seeded
 * username, which the affordance gates on and HAF does not index. The stub
 * affects rendering only: the broadcast handler performs no accreditation
 * check. The JWT is seeded via `mintSessionJwt`. The mint and every consume
 * run real.
 * Clause (b): no auth middleware is mocked and no cryptographic verification
 * is bypassed. `verifyHiveSignature` runs real on the Bearer path, the
 * password is argon2-verified server-side, and the proof is backend-issued.
 * Clause (c): this spec is the real-path companion for the light-account
 * consent-op orchestration `lib-authorship-consent.test.js` pins, and for
 * `authorship-consent-actions.spec.js`, whose Keychain (self-custody) path
 * stops at the op shape because the Keychain stub cannot sign. For
 * `lib-fresh-auth-consent-op-cache.test.js` it covers only the cold-page
 * lookup miss ahead of the mint; the keyed reuse that suite pins has no
 * real-path companion.
 */

import { test, expect } from './fixtures/keychain.js';
import { seedAccreditedSession } from './fixtures/auth.js';
import { openAppPool } from './fixtures/db.js';
import { installPaperMocks, installAuthedBootMocks, buildPaper } from './fixtures/paper-mocks.js';
import {
  TEST_PASSWORD,
  bearer,
  postTo,
  seedLightAccount,
  answerReauthPrompt,
  expectPostGateStop,
  expectGateRefusal,
} from './fixtures/light-account.js';

// This spec mints a live backend-valid bearer JWT and types the seeded
// account password into the reauth modal. Traces would persist both.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const APP_TAG = 'pevotest';
const FULL_NAME = 'E2E Fresh Auth Consenter';

test.describe('light-account consent op against the real backend', () => {
  let pool;
  let RUN_SUFFIX;
  let USERNAME;

  test.beforeAll(async ({}, testInfo) => {
    RUN_SUFFIX = `${Date.now().toString(36).slice(-6)}r${testInfo.retry}`;
    USERNAME = `e2e-fa-consent-${RUN_SUFFIX}`;
    pool = openAppPool();
    await seedLightAccount(pool, {
      username: USERNAME,
      email: `e2e+fa-consent-${RUN_SUFFIX}@pevo.test`,
      fullName: FULL_NAME,
    });
  });

  test.afterAll(async () => {
    if (pool) await pool.end();
  });

  test('author_accept carries a target-bound consent-op proof minted at the real fresh-auth route', async ({ page, request }) => {
    const username = USERNAME;
    const { token } = await seedAccreditedSession(page, {
      username,
      accreditation: { name: FULL_NAME },
      custody: 'light',
    });
    const paper = buildPaper({
      author: 'rootauthor',
      permlink: `e2e-fa-accept-${RUN_SUFFIX}`,
      authors: [
        { name: 'Root Author', hive: 'rootauthor', consented: true },
        { name: FULL_NAME, hive: username, consented: false },
      ],
      title: 'Light Account Consent Op Test',
    });
    await installAuthedBootMocks(page, {
      pendingConsents: [{ paper_author: paper.author, paper_permlink: paper.permlink }],
      accreditationName: FULL_NAME,
    });
    await installPaperMocks(page, { paper, comments: [] });

    await page.goto(`/en/paper/${paper.author}/${paper.permlink}`);

    const mintRequestPromise = page.waitForRequest(postTo('/api/custody/fresh-auth').request);
    const mintResponsePromise = page.waitForResponse(postTo('/api/custody/fresh-auth').response);
    const broadcastRequestPromise = page.waitForRequest(postTo('/api/custody/broadcast').request);
    const broadcastResponsePromise = page.waitForResponse(postTo('/api/custody/broadcast').response);

    await page.locator('[data-testid="accept-authorship"]').click();
    // The password factor (the seeded row has a password, which the real
    // GET /settings/email reports) opens the reauth modal; no consent-op
    // proof is cached yet, so the SPA mints.
    await answerReauthPrompt(page);

    // The mint request binds the proof to the op's own target...
    const mintReq = await mintRequestPromise;
    const mintBody = mintReq.postDataJSON();
    expect(mintBody).toMatchObject({
      action: 'author_accept',
      root_author: paper.author,
      root_permlink: paper.permlink,
      password: TEST_PASSWORD,
    });
    // ...and the real route echoes that binding with the issued proof.
    const mintResp = await mintResponsePromise;
    expect(mintResp.status()).toBe(200);
    const issued = (await mintResp.json()).data;
    expect(typeof issued.fresh_auth_proof).toBe('string');
    expect(issued.fresh_auth_proof.length).toBeGreaterThan(0);
    expect(issued).toMatchObject({
      mechanism: 'password',
      action: 'author_accept',
      root_author: paper.author,
      root_permlink: paper.permlink,
    });

    // The broadcast carried that proof on the consent op it was minted for.
    const broadcastReq = await broadcastRequestPromise;
    const body = broadcastReq.postDataJSON();
    expect(body.fresh_auth_proof).toBe(issued.fresh_auth_proof);
    expect(body.operations).toHaveLength(1);
    const [opType, op] = body.operations[0];
    expect(opType).toBe('custom_json');
    expect(op.id).toBe(APP_TAG);
    expect(op.required_posting_auths).toEqual([username]);
    expect(JSON.parse(op.json)).toEqual({
      action: 'author_accept',
      root_author: paper.author,
      root_permlink: paper.permlink,
    });

    // The backend accepted it: the gated-op scan matched the proof's target,
    // the consume passed, and the request stopped at the seeded account's
    // posting-key decrypt.
    await expectPostGateStop(await broadcastResponsePromise);

    // Single-use: the consume spent the proof, so the identical bundle is
    // now refused AT the gate (a spent entry reads as expired).
    const replay = await request.post('/api/custody/broadcast', { headers: bearer(token), data: body });
    await expectGateRefusal(replay, { status: 401, reasons: ['expired', 'missing'] });

    // Kind isolation: a session-kind window, minted for real by the same
    // account, is refused on this surface for its kind. This is the
    // criterion a session-window proof cannot satisfy.
    const sessionMint = await request.post('/api/custody/session-auth', {
      headers: bearer(token),
      data: { password: TEST_PASSWORD },
    });
    expect(sessionMint.status()).toBe(200);
    const sessionProof = (await sessionMint.json()).data.fresh_auth_proof;
    expect(typeof sessionProof).toBe('string');
    const wrongKind = await request.post('/api/custody/broadcast', {
      headers: bearer(token),
      data: { ...body, fresh_auth_proof: sessionProof },
    });
    await expectGateRefusal(wrongKind, { status: 403, reasons: ['kind_mismatch'] });
  });
});
