/**
 * Shared IPFS helpers used by both the gateway/upload routes (`routes/ipfs.ts`)
 * and the orphan-cleanup job (`ipfs-cleanup.ts`): the Kubo/Pinata unpin
 * helpers and the `image`-array SRF type-guard SQL fragment. Both symbols were
 * byte-duplicated across the two files; centralizing them here keeps them from
 * drifting under independent edits.
 */

import { config } from '../config.js';

export type PinBackend = 'kubo' | 'pinata';

const PIN_BACKENDS: readonly PinBackend[] = ['kubo', 'pinata'];

/**
 * Narrow an untrusted string (e.g. the `pin_backend` column read off a
 * tracking row) to the `PinBackend` union, throwing on anything outside it.
 *
 * The cleanup job and the upload compensation path both dispatch the unpin to
 * the recorded backend; an `as PinBackend` assertion cast would let an
 * out-of-domain value flow straight into `unpinFromIpfs`, whose non-kubo
 * branch routes to Pinata — firing a Pinata DELETE for a CID Pinata never
 * held, swallowing the benign "not pinned", then letting the caller reap the
 * tracking row and leak the real (Kubo) pin forever. Throwing here surfaces
 * the bad value to the caller's error handling instead, which logs and skips
 * the reap so the row survives for an operator. The DB CHECK on `pin_backend`
 * is the write-time backstop; this is the read-time one.
 */
export function toPinBackend(value: string): PinBackend {
  if ((PIN_BACKENDS as readonly string[]).includes(value)) {
    return value as PinBackend;
  }
  throw new Error(`Unrecognized pin backend: ${JSON.stringify(value)}`);
}

/**
 * SQL fragment builder: array-type guard for the broadcaster-controlled Hive
 * `image` field at a `jsonb_array_elements_text()` SRF argument position.
 *
 * Hive's `image` metadata is convention, not schema: any post can broadcast a
 * non-array value (null, string, integer, object). Postgres evaluates a
 * `CROSS JOIN LATERAL` / SRF before the surrounding `WHERE`, so a WHERE-side
 * `jsonb_typeof = 'array'` guard fires too late and is a placebo — the type
 * guard must sit INSIDE the SRF argument so a non-array short-circuits to
 * `'[]'::jsonb` before the SRF runs.
 *
 * `alias` is the SQL alias of the comment relation at the call site
 * (`cidIsKnown` and `cidReferencedInHaf` both alias `comments` as `c`).
 * Taking it as a parameter makes the relation-alias dependency an explicit,
 * enforced part of the call rather than an invisible contract baked into a
 * constant: a site using a different alias substitutes it correctly instead of
 * interpolating a `c.`-hardwired fragment that fails at runtime with an obscure
 * column-not-found error. `alias` is validated as a bare SQL identifier because
 * it is interpolated, not bound — SRF-argument SQL cannot take a placeholder —
 * and call sites pass compile-time literals, never user input.
 *
 * Interpolated into `cidIsKnown` (`routes/ipfs.ts`) and `cidReferencedInHaf`
 * (`ipfs-cleanup.ts`), and imported by the SRF guard test so the test fragment
 * stays definitionally in sync with production. See
 * `agents/docs/solutions/conventions/pg-cross-join-lateral-where-guard-fires-after-srf-2026-05-16.md`.
 */
export function imageSrfGuardExpr(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`imageSrfGuardExpr: invalid SQL relation alias ${JSON.stringify(alias)}`);
  }
  return `CASE WHEN jsonb_typeof(${alias}.json_metadata->'image') = 'array'
             THEN ${alias}.json_metadata->'image'
             ELSE '[]'::jsonb
        END`;
}

/**
 * Unpin a CID from the local Kubo node. A "not pinned" response is benign —
 * the pin may already be absent (e.g. removed by a concurrent cleanup sweep,
 * or the backend restarted between pin and unpin) — so it is swallowed rather
 * than raised.
 */
export async function unpinFromKubo(cid: string): Promise<void> {
  const response = await fetch(
    `${config.ipfsApiUrl}/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`,
    { method: 'POST', signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) {
    const text = await response.text();
    if (!text.includes('not pinned')) {
      throw new Error(`Kubo unpin failed: ${response.status} ${text}`);
    }
  }
}

/**
 * Unpin a CID from Pinata. Mirrors `unpinFromKubo`'s benign-absence tolerance:
 * an already-removed pin is signalled by a "not pinned" reason (the
 * CURRENT_USER_HAS_NOT_PINNED_CID family) rather than a clean 200; match it
 * case-insensitively across the underscore reason-code form and any plain-
 * English phrasing so the compensation path does not raise the orphan alarm
 * for a pin that is already gone. Pinata does not formally document this error
 * body, so the match is deliberately defensive over the known not-pinned signal.
 */
export async function unpinFromPinata(cid: string): Promise<void> {
  const response = await fetch(`https://api.pinata.cloud/pinning/unpin/${encodeURIComponent(cid)}`, {
    method: 'DELETE',
    headers: {
      pinata_api_key: config.pinataApiKey,
      pinata_secret_api_key: config.pinataSecretKey,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text();
    const lower = text.toLowerCase();
    if (!lower.includes('not pinned') && !lower.includes('not_pinned')) {
      throw new Error(`Pinata unpin failed: ${response.status} ${text}`);
    }
  }
}

/**
 * Compensation unpin for the pin-then-record durability shape: dispatch to the
 * same backend that produced the pin. If the original pin came from Kubo, only
 * Kubo's unpin can release the disk; calling the wrong backend would silently
 * leak the pinned blob.
 *
 * The dispatch is exhaustive over the `PinBackend` union with an explicit
 * branch per backend and a throw on the unreachable default. A bare
 * `if (kubo) … else pinata` would silently route any non-kubo value to Pinata;
 * the explicit branches plus the `never`-typed default keep the function from
 * misrouting if the union ever widens without a matching branch here.
 */
export async function unpinFromIpfs(cid: string, backend: PinBackend): Promise<void> {
  switch (backend) {
    case 'kubo':
      return unpinFromKubo(cid);
    case 'pinata':
      return unpinFromPinata(cid);
    default: {
      const unreachable: never = backend;
      throw new Error(`Unrecognized pin backend: ${JSON.stringify(unreachable)}`);
    }
  }
}
