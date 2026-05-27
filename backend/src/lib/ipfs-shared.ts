/**
 * Shared IPFS helpers used by both the gateway/upload routes (`routes/ipfs.ts`)
 * and the orphan-cleanup job (`ipfs-cleanup.ts`): the Kubo/Pinata unpin
 * helpers, the `pin_backend` narrowing, the `image`-array SRF type-guard SQL
 * fragment, and the tags-scoped CID-reference containment query. Each was
 * byte-duplicated across the two files; centralizing them here keeps them from
 * drifting under independent edits — a drift that, on the cleanup side, unpins
 * a live on-chain-referenced file (irreversible).
 */

import type pg from 'pg';
import { config } from '../config.js';
import { T } from '../hafsql.js';

export type PinBackend = 'kubo' | 'pinata';

const PIN_BACKENDS: readonly PinBackend[] = ['kubo', 'pinata'];

/**
 * The unrecognized-pin-backend error message, in one place. Raised by both the
 * read-time narrowing in `toPinBackend` and the exhaustive-switch default in
 * `unpinFromIpfs`; sharing the source keeps the two from drifting if the union
 * widens. Module-local — both consumers live in this file, so it carries no
 * cross-module obligation on the exact string format.
 */
function unrecognizedPinBackendMessage(value: unknown): string {
  return `Unrecognized pin backend: ${JSON.stringify(value)}`;
}

/**
 * Type predicate narrowing an arbitrary string to the `PinBackend` union. Used
 * by `toPinBackend` so the narrowing is mechanical — no inner `as PinBackend`
 * assertion survives, so deleting the surrounding guard cannot let an
 * out-of-domain value through silently.
 */
function isPinBackend(v: string): v is PinBackend {
  return (PIN_BACKENDS as readonly string[]).includes(v);
}

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
  if (isPinBackend(value)) return value;
  throw new Error(unrecognizedPinBackendMessage(value));
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
 * (`cidReferencedByAppTag` aliases `comments` as `c` in its containment scan).
 * Taking it as a parameter makes the relation-alias dependency an explicit,
 * enforced part of the call rather than an invisible contract baked into a
 * constant: a site using a different alias substitutes it correctly instead of
 * interpolating a `c.`-hardwired fragment that fails at runtime with an obscure
 * column-not-found error. `alias` is validated as a bare SQL identifier because
 * it is interpolated, not bound — SRF-argument SQL cannot take a placeholder —
 * and call sites pass compile-time literals, never user input.
 *
 * Interpolated into the shared `cidReferencedByAppTag` containment query (below
 * in this file) — its sole production interpolation site after that query was
 * de-duplicated out of `cidIsKnown` and `cidReferencedInHaf` — and imported by
 * the SRF guard test so the test fragment stays definitionally in sync with
 * production. See
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
 * Is `cid` referenced by any PEvO post in HAF? Checks both
 * `metadata.<appTag>.ipfs_cid` and `metadata.<appTag>.supplementary_files[].cid`,
 * plus the broadcaster-controlled `image` array, scoped to PEvO-tagged comments.
 *
 * Both call sites consume this single definition: the cleanup job's
 * CID-in-use check (`cidReferencedInHaf`, gates whether an expired
 * pending-upload row's pin is unpinned) and the GET /ipfs/:cid gateway's
 * CID-known check (`cidIsKnown`, gates whether the proxy serves the CID). The
 * cost of drift is asymmetric: a wrong predicate on the cleanup side unpins a
 * live on-chain-referenced file (irreversible — Kubo `pin/rm` is not
 * refcounted); on the gateway side it serves or withholds content. Keeping one
 * source removes that drift.
 *
 * Three invariants are load-bearing and must not be reverted:
 *
 *  - **tags-GIN scope.** `c.tags @> [appTag]` restricts the scan to PEvO-tagged
 *    comments via the only index-assisted PEvO subset on this HAF
 *    (hafsql.comments has no GIN index on metadata, so an unscoped containment
 *    predicate full-scans the whole corpus). All CID-carrying PEvO content is
 *    appTag-tagged, so the scope drops no real reference — over-inclusive (keep
 *    pinned) beats under-inclusive (unpin a live file).
 *  - **appTag namespace.** The containment namespace must match the published
 *    shape (`metadata.<appTag>.…`), NOT a literal `pevo` key — verified against
 *    live HAF, where zero posts carry a `pevo` top-level key; the literal-`pevo`
 *    predicate never matches and would unpin every live file / 404 every CID.
 *  - **image-SRF guard.** The `image`-array match goes through
 *    `imageSrfGuardExpr('c')`, whose CASE-WHEN type guard sits INSIDE the SRF
 *    argument because Postgres evaluates the LATERAL before the surrounding
 *    WHERE; a non-array image otherwise raises "cannot extract elements from a
 *    scalar" and aborts the query (the cleanup sweep mid-loop, leaking orphan
 *    rows and pins; or the per-request CID-known check). The `'c'` arg is the
 *    comment-relation alias used in the FROM clause below.
 *
 * Scoped to the single `config.appTag`. Old-tag content from a prior
 * APP_TAG flip need not be served or retained by the production app, so the
 * containment check does not widen over historical tags; a transition mechanism
 * can be re-introduced if a future flip calls for one.
 *
 * Returns false when the HAF pool is unavailable so callers can layer their own
 * pre-checks (the gateway's Redis + pending-row short-circuit) ahead of this.
 */
export async function cidReferencedByAppTag(pool: pg.Pool, cid: string): Promise<boolean> {
  const appTag = config.appTag;

  const result = await pool.query(
    `SELECT 1 FROM ${T.comments} c
     WHERE c.tags @> $1::jsonb
       AND (
            c.json_metadata @> $2::jsonb
         OR c.json_metadata @> $3::jsonb
         OR EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(${imageSrfGuardExpr('c')}) img
              WHERE img LIKE '%' || $4 || '%'
            )
       )
     LIMIT 1`,
    [
      JSON.stringify([appTag]),
      JSON.stringify({ [appTag]: { ipfs_cid: cid } }),
      JSON.stringify({ [appTag]: { supplementary_files: [{ cid }] } }),
      cid,
    ],
  );

  // A `SELECT 1 … LIMIT 1` always reports a row count under node-pg, so a null
  // here means the driver could not determine one. Coercing that to "not
  // referenced" (false) routes the cleanup path to an irreversible unpin (Kubo
  // pin/rm is not refcounted) on an indeterminate result. Throw instead:
  // runCleanup's per-row try/catch logs and skips the row, keeping the pin and
  // its tracking row for the next sweep, and the gateway route's catch turns it
  // into a transient 502 rather than serving wrong content. Uncertainty biases
  // to keep-pinned, the safe direction on the most dangerous line here.
  if (result.rowCount === null) {
    throw new Error('cidReferencedByAppTag: query returned null rowCount; cannot safely determine CID reference');
  }
  return result.rowCount > 0;
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
      throw new Error(unrecognizedPinBackendMessage(unreachable));
    }
  }
}
