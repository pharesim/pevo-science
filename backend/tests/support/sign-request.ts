import { PrivateKey, cryptoUtils } from '@hiveio/dhive';
import { config } from '../../src/config.js';
import { buildCanonicalAuthMessage } from '../../src/lib/authMessage.js';

/**
 * Produce a request-bound Hive signature for the test harness.
 *
 * The canonical signing-message template is delegated to
 * `buildCanonicalAuthMessage` from `backend/src/lib/authMessage.ts` — the
 * single source of truth shared with the server-side verifier
 * (`backend/src/middleware/verifyHiveSignature.ts`). Importing the SSoT
 * captures the protocol in exactly one place so any future change (header
 * shape, body-coalesce semantics, version bump) propagates from a single
 * edit. BE-LOG-PII-EMAIL-HASH round-3 hold item 2.
 *
 * This helper composes the SSoT-built message with the test-harness signing
 * concerns: (a) build the canonical message via the imported SSoT (which
 * internally body-hashes with `?? {}` semantics — the prior in-helper
 * `|| {}` form was already-latent drift), (b) sha256 the message, and
 * (c) sign with the supplied `privateKey`. Callers bind their per-file key
 * (e.g. `TEST_KEY` / `TEST_PRIVATE_KEY`) via a thin wrapper.
 *
 * Extracted from per-file copies in `auth.test.ts` and `signup-verify.test.ts`
 * (BE-LOG-PII-EMAIL-HASH round-2 hold item 3 — maintainability MAINT M1) and
 * subsequently adopted by the bridge / claims / signup-verify-postbroadcast-
 * severity / bridge-haf-lag-locks suites (round-3 hold item 1).
 */
export function signRequestBound(
  privateKey: PrivateKey,
  method: string,
  fullPath: string,
  body: unknown,
  timestamp: string,
): string {
  const msg = buildCanonicalAuthMessage({
    appTag: config.appTag,
    method,
    path: fullPath,
    body,
    timestamp,
  });
  const msgHash = cryptoUtils.sha256(msg);
  return privateKey.sign(msgHash).toString();
}
