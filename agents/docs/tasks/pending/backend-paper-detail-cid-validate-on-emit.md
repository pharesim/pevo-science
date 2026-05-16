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

---

## Architect re-review round-2 (2026-05-16) — HELD PENDING FIXES

`/ce-code-review` on commits `7a5ccc1` + `a264ec3` dispatched 9 reviewers (correctness, security, adversarial, testing, maintainability, project-standards, learnings, api-contract, kieran-typescript; `ce-agent-native-reviewer` skipped per root CLAUDE.md). Surfaced 1 P1 missed emit site + 1 P1 dead branch + 1 P2 type-clarity. 3 held below; other findings dismissed or noted for future scope.

### Items to address

**1. (P1) Missed fourth `ipfs_cid` emit site at `helpers.ts:321` `toPaperSummary()`**

**Where:** `backend/src/helpers.ts:321` — `toPaperSummary()` returns `ipfs_cid: pevoString(pevo, 'ipfs_cid')` unwrapped. Consumed by `backend/src/routes/profile.ts:279` for `GET /api/profile/:username/papers` (and any other route that builds `PaperSummary`).

**Why:** Task acceptance #2 enumerated three emit sites in `papers.ts` (listing summary, head/root atomic-triple branch, single-paper `buildPaperDetail`) — all wrapped correctly. But `toPaperSummary()` in `helpers.ts` is a **fourth** path that produces a paper response payload with `ipfs_cid`, and it's unwrapped. The exact attack class the task defends against (whitespace / control char / null byte / zero-width CID broadcast by a vouched co-author) bypasses the defense on the profile-papers route. Current frontend consumers of profile-papers are truthy-checks only (`paper-card.js:80`), so blast radius is bounded today — but the "validate at every emit boundary" convention is broken at the moment it's claimed to be established, and a future feature URL-constructing from a profile-papers `ipfs_cid` re-opens the surface silently.

**Fix:** Wrap the assignment at `helpers.ts:321`:

```ts
ipfs_cid: validatedCid(pevoString(pevo, 'ipfs_cid'), { author: post.author, permlink: post.permlink }),
```

Add a canary on `/api/profile/:username/papers` asserting a profile-papers response with a malformed-CID paper returns `ipfs_cid: null` + warn fires. Re-run the wrapping-primitive grep audit per `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`:

```bash
grep -n "ipfs_cid\s*[:=]" backend/src/
```

Include the verbatim grep output in the re-review signal block so a fifth missed site would be self-documented. Expected: 4 occurrences in `papers.ts` (all `validatedCid`-wrapped) + 1 occurrence in `helpers.ts` (now `validatedCid`-wrapped post-fix).

**2. (P1) Dead branch in `validatedCid` typeof guard at `ipfs-validation.ts:83-97`**

**Where:** `backend/src/lib/ipfs-validation.ts:83-97`.

**Why:** Parameter declared `value: string | null | undefined`. Line 83 returns null on `null | undefined`, narrowing `value` to `string`. The `typeof value !== 'string'` guard at line 84 is unreachable; the 14-line `logger.warn` inside the dead branch will never fire. The inline comment ("Defensive: callers pass through pevoString/safePevoMeta...") describes a concern the declared signature does not actually admit. The bug is a type lie in either direction: either the signature is too narrow (intent is to guard `unknown`) or the branch is dead (intent is for `pevoString` to be the intake guard).

**Fix:** Implementer's design choice between two shapes:

- **Widen to `unknown`** — change signature to `validatedCid(value: unknown, context)`, making the branch live. Removes need for `as` casts at any future call site passing non-string values. Consistent with `isValidIpfsCid` already accepting `unknown`. Add a unit canary covering the non-string path (logger.warn fires for non-string input).
- **Delete the branch** — accept `pevoString` as the intake guard. Cleanest if you trust the upstream contract; the four current call sites all pass `pevoString(...)` which returns `string | null`. Delete the typeof check + the unreachable warn.

Pick one and update the JSDoc to match. Note which path was taken in the re-review signal so future contributors don't re-litigate.

**3. (P2) Extract named interface `CidValidationContext` for the `context` parameter**

**Where:** `backend/src/lib/ipfs-validation.ts:79-82` (`validatedCid` signature).

**Why:** The `context` parameter is typed inline as `{ author: string; permlink: string }`. Named interfaces surface by name in editor hover, are importable by tests that construct context objects explicitly, and signal that the shape is a deliberate contract rather than an anonymous bag.

**Fix:** Export `interface CidValidationContext { author: string; permlink: string; }` from `ipfs-validation.ts` and use it in the `validatedCid` signature.

### Findings dismissed at triage (no action)

- Cache cascade for malformed-then-corrected CID (adversarial A3 P2/75): malicious-content path is closed (cache stores `null`, not the attacker payload). Remaining cost is "legitimate corrective re-broadcast doesn't take effect for up to 30 min" — bounded annoyance, not a defect. PEvO's cache-is-perf-layer posture stands.
- `pevoString` + `validatedCid` two-layer contract unenforced (adversarial A2 P2/70): grep-audit convention captured in `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` and applied at item #1 above. Reconsider AST-rule/typed-newtype investment if a second emit-time validator emerges (e.g., `document_hash` gets the same treatment).
- `ipfs_filename` + `document_hash` siblings unvalidated (security S2 P3/50): task acceptance #3 explicitly deferred `document_hash` validation as optional. Current consumers escape both via Alpine `x-text`. Reopen if a future feature URL-constructs from either.
- Carve-out invocation header missing from `backend/tests/lib/ipfs-validation.test.ts` (learnings LOW): unit test of a pure function — carve-out is for mocked-pool / observability-spy patterns. The file does spy on `logger.warn` (carve-out-eligible); implementer's call whether to add the formal header while touching the file for item #2.

### Re-review signal

When items 1-3 land, `git mv` this file from `tasks/pending/` back to `tasks/review/` per `feedback_task_mv_to_review_after_each_round.md`. Use bare `backend:` or `backend(<scope>):` commit prefixes so the zone-audit hook fires. The architect's next review pass scopes `/ce-code-review` to commits since `a264ec3`. Items can land in any order or in one combined commit.
