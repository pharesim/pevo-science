# BACKEND-PAPER-DETAIL-CID-VALIDATE-ON-EMIT — output-side IPFS-CID shape validation

**Owner:** Backend Agent
**Created:** 2026-05-05 (architect, surfaced by round-4 `/ce-code-review` adversarial finding F3 on `backend-continuation-post-author-consent-gate`)
**Priority:** P3

## Problem

`backend/src/helpers.ts` `pevoString(pevo, key)` (added round-4 of `backend-continuation-post-author-consent-gate`) narrows runtime values to `string | null` via `typeof v === 'string' && v.length > 0`. The predicate accepts whitespace, control characters, newlines, null bytes, and zero-width spaces unchanged.

Frontend `paper-detail.js:904-905` builds the IPFS download link via simple concatenation: `${this.ipfsGateway}${this.paper.ipfs_cid}`. A vouched co-author broadcasting a continuation with `pevo.ipfs_cid = '   QmFoo  '`, `'QmFoo\n'`, `'Qm​Foo'` (zero-width space), or `'Qm\x00Foo'` (null byte) flows through `pevoString` → flows through the API response → produces a malformed URL or, in some HTTP gateways, a request-smuggling vector.

This is NOT a regression introduced by round-4; the prior `(headPevo.X as string) ?? rootPevo.X` cast pattern had identical behavior. But the round-4 helper is now the canonical "right way to read a pevo string" and bakes the no-trim/no-validate behavior into the helper's contract.

The fix is NOT to widen `pevoString`'s responsibility (mixing narrowing + validation creates a maintenance hazard — different fields have different valid charsets). The fix is to validate the CID shape at the API response-emit boundary in `papers.ts`, catching all sources of bad CIDs (helper input, direct assignment, future cast sites, future on-chain attacker payloads).

## Threat model

- **Attacker:** vouched co-author of a paper (passes the round-3 author-consent gate) OR any Hive account before round-3 / round-4 hardening landed (legacy on-chain content).
- **Capability:** broadcast a continuation post (or the original paper post) with `pevo.ipfs_cid` containing whitespace / control characters / null bytes / zero-width spaces.
- **Impact:** malformed URLs in frontend (download link broken — annoyance), or in worst-case HTTP gateway behavior, request smuggling. Not a content-spoof attack (the CID is still attacker-attributable on chain), but a polish gap that lets attacker-controlled strings flow into client-side URL construction.
- **Detection:** none today. No canary tests assert the response-emit triple's shape against an IPFS CID charset.

## Goal

Validate the shape of `ipfs_cid` (and optionally `document_hash`) at the point where the values are written into the API response in `backend/src/routes/papers.ts`. When the value fails validation, drop it (set to `null`) and emit an operator log event so the bad on-chain content is detectable.

## Acceptance

### 1. CID-shape predicate

`backend/src/helpers.ts` (or a new `backend/src/lib/ipfs-validation.ts` if the helper grows):

```ts
/**
 * Returns true if the input matches the expected IPFS CID shape:
 * - CIDv0: `Qm` + 44 base58btc characters (alphabet: 1-9 a-k m-z A-H J-N P-Z, no 0OIl).
 * - CIDv1: any base32 / base58btc / base16 multibase prefix per the multihash spec.
 *
 * For the round-1 acceptance, MVP shape: regex match on the v0 + v1-base32 patterns
 * (covers >99% of real CIDs in the corpus). Reject anything outside this whitelist.
 *
 * Does NOT verify the multihash digest is well-formed at the bit level — that's a
 * stronger check requiring a multihash library; the regex is sufficient to filter
 * the round-4 attack class (whitespace, control chars, null bytes, zero-width).
 */
export function isValidIpfsCid(cid: string): boolean {
  // CIDv0: starts with Qm, length 46, base58btc charset
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) return true;
  // CIDv1 base32: starts with `b`, length variable, charset a-z2-7
  if (/^b[a-z2-7]{20,}$/.test(cid)) return true;
  return false;
}
```

### 2. Apply at the response-emit sites in papers.ts

Three categories of sites:
- **Per-version override at `papers.ts:685-687`** (round-4-introduced lines, post round-5 atomic-triple-bundle): wrap the assignment in the validator.
- **Snapshot site at `papers.ts:396`** (`/api/papers/:author` list): same wrapping.
- **Snapshot site at `papers.ts:1360-1362`** (other snapshot path): same wrapping.

Concrete shape (assuming a thin helper `validatedCid(value: string | null): string | null` that returns `value` if valid, `null` otherwise + warn-logs the rejection):

```ts
detail.ipfs_cid = validatedCid(pevoString(headPevo, 'ipfs_cid'));
```

`validatedCid` logs a warn on rejection: `event: 'paper_detail_ipfs_cid_rejected'` with `{ author, permlink, raw_cid_prefix }` (truncate raw value to first 32 chars to avoid log injection from very long attacker payloads). Rejection is silent to the consumer (response carries `null`); operators see the reject event in logs.

### 3. Optional: validate `document_hash` shape

`document_hash` is typically `sha256:<64-hex>`. Add a sibling `isValidDocumentHash(hash: string): boolean` that matches `^(sha256|sha512|blake3):[0-9a-f]+$` with appropriate length bounds. Apply at the same three sites. Lower priority than the CID validation (no current consumer reads `document_hash`); file as a follow-up if scope grows.

### 4. Canary tests

`backend/tests/lib/ipfs-validation.test.ts` (new file):
- Valid CIDv0: passes.
- Valid CIDv1 base32: passes.
- Whitespace-padded `'   QmFoo...   '`: rejected.
- Control character (newline, null byte): rejected.
- Zero-width space embedded: rejected.
- Empty string: rejected (already handled by `pevoString` upstream, but pin for documentation).
- Non-CID arbitrary string `'hello'`: rejected.

`backend/tests/routes/continuation-author-gate.test.ts` (or sibling): add 1-2 integration canaries that broadcast a continuation with whitespace-padded CID and assert response carries `null` (NOT the padded value) AND assert the operator log fired.

## Out of scope

- Strengthening `pevoString` itself with trim/validate. Validation policy is per-field; mixing it into the narrowing helper creates a maintenance hazard.
- IPFS gateway-side validation. Out of scope for backend.
- Validating `document_hash` shape — listed as optional in acceptance #3; defer if scope grows.
- Retroactive cleanup of any malformed CIDs already on chain. The validator makes them silently null going forward; on-chain history is immutable.

## Why now

1. **Adversarial finding F3 from round-4 review** of `backend-continuation-post-author-consent-gate` (P3 conf 55). The architect dismissed the finding as not blocking round-4 archive but filed this separate task per the user's option-(d) triage choice (output-side validation, decoupled from the helper).
2. **Bounded blast radius today.** Frontend builds the URL via concatenation with no shape check; current consumers are limited to the download link. If a future feature adds an integrity check or a CID-equality lookup (e.g., for citation cross-reference), the malformed-CID class becomes more impactful.
3. **Locks the canonical emit-time validation pattern.** Establishes the convention for other on-chain string fields where the broadcaster is partially trusted (vouched co-authors) but the value flows into client-side URL/computation contexts.

## Source

`/ce-code-review` round-4 of `backend-continuation-post-author-consent-gate`, adversarial reviewer finding F3 (P3 conf 55). User triage 2026-05-05 elected option (d): output-side validation at API response-emit time, decoupled from the helper.

## Cross-references

- `agents/docs/tasks/pending/backend-continuation-post-author-consent-gate.md` — round-4 hold + round-5 hold; the helper this task layers on top of.
- `backend/src/helpers.ts:159` `pevoString` — the helper this task does NOT modify; this task adds a sibling validator.
- `backend/src/routes/papers.ts:396, 685-687, 1360-1362` — the three response-emit sites needing the validator.
- `frontend/src/pages/paper-detail.js:904-905` — the URL-construction consumer that motivates output-side validation.

---

## Backend completion signal (2026-05-06, commits `7a5ccc1` + `a264ec3` on `main`)

Acceptance items 1, 2, 4, 5 landed; item 3 (`document_hash` validation) deferred per task scope as optional.

**Implementation:**

- New `backend/src/lib/ipfs-validation.ts` exports `isValidIpfsCid(cid: unknown): boolean` (strict CIDv0 base58btc + CIDv1 lowercase-base32 anchored regex) and `validatedCid(value, {author, permlink}): string | null` (warn-and-clear wrapper with `event: 'paper_detail_ipfs_cid_rejected'`, `raw_cid_prefix` truncated to 32 chars to avoid log injection).
- `backend/src/routes/papers.ts` wraps three emit sites: line 397 (listing summary in `fetchPapersFromHaf().map()`), the per-version override site (head/root atomic-triple branch — both arms wrapped in `validatedCid`, preserving the round-5 atomic-triple invariant), and line 1479 (`buildPaperDetail()` single-paper / canonical-root path).
- The cherry-pick onto main landed atop the architect's round-5 atomic-triple refactor (`backend-continuation-post-author-consent-gate` round-5 hold, commit `82bec89`), so the worker's simpler `(headPevo.ipfs_cid as string) ?? null` shape was widened during the merge to cover both `pevoString(headPevo, 'ipfs_cid')` and `pevoString(rootPevo, 'ipfs_cid')` reads. The merge consequence: existing fixtures `QmHeadCid`/`QmRootCid`/`QmV1Cid`/`QmV2Cid` (7-9 char placeholders) now correctly fail the regex; commit `a264ec3` replaces them with 46-char base58btc-shape CIDs.

**Tests landed:**

- `backend/tests/lib/ipfs-validation.test.ts` — 16 unit cases: valid CIDv0, valid CIDv1 base32, whitespace-padded reject, control-char reject (newline, null byte, CR, mid-string newline), zero-width / BOM reject, empty reject, garbage reject, non-string reject, prefix-truncation guard, no-warn for null/undefined.
- `backend/tests/routes/continuation-author-gate.test.ts` extended with two integration canaries: padded CID → null response + warn fires; valid CID → unchanged + no warn.

**Mutation-kill attestation:**

- Reverted `validatedCid()` wrap at the `buildPaperDetail` site → integration canary "clears whitespace-padded ipfs_cid to null" failed red. Restored.
- Weakened `isValidIpfsCid()` to always-true → 8 of 16 unit canaries failed red. Restored.

**Verification:** `npx tsc --noEmit` clean; `npm run lint` clean (only pre-existing seed-phrase warnings); targeted vitest 72 pass + 1 skipped across `tests/lib/ipfs-validation.test.ts` + `tests/routes/continuation-author-gate.test.ts` + `tests/routes/papers.test.ts` + `tests/routes/canonical-root-walker.test.ts`.

**Out of scope honored:** `document_hash` validation deferred (acceptance item 3 was explicitly optional); `pevoString` not strengthened with trim/validate; convention docs untouched (architect-owned).
