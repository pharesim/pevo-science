# BACKEND-LANGUAGE-FILTER-LENGTH-CAP — Close unbounded-string vector on `?language=` parameter

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, follow-up from `backend-search-query-param-typeof-narrow-sweep` round-1 cluster review)
**Priority:** P2

## Problem

`parseLanguageFilter` in `backend/src/types/search-filters.ts:202-206` accepts ANY single string with NO length cap and NO charset constraint:

```ts
export function parseLanguageFilter(raw: unknown): LanguageFilterResult {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw === 'string') return { ok: true, value: raw };
  return { ok: false, message: INVALID_LANGUAGE_MESSAGE };
}
```

The helper's docblock at search-filters.ts:180-194 explicitly defers charset/length enforcement to a future revisit ("Charset/length enforcement is intentionally out of scope here; revisit when the publishing UI's allowed-language set is pinned end-to-end"). The deferral was a defensible architect-level decision in the typeof-narrow-sweep task, which scoped only to repeated-param/non-string rejection.

The unbounded-string vector remains. Sister params have caps:
- `?q=`: 200-char cap + LIKE-escape (see `validateSearchQuery`)
- `?discipline=`: 100-char cap + Unicode-letter charset (see `validateDisciplineFilter`)
- `?language=`: nothing

Adversarial review (cluster-3 search-cluster pass, commit `e7a495f` review pass on 2026-05-16) flagged the gap with high confidence: each unique `?language=` value enumerates a HAF query on cache-miss (15s TTL on `hafCache`). The SHA-256 hashing of the cache `rawKey` bounds Redis key SIZE but does not bound the number of distinct cache entries an attacker can enumerate by varying the value. Resource at risk is HAF backend CPU.

`/api/search` is PUBLIC and UNAUTHENTICATED. The `searchLimiter` middleware bounds at 60 req/min/IP; a botnet linearly amplifies. Single-instance PEvO deployment makes horizontal-scale dismissals (`project_single_instance_only`) inapplicable — this is a single-instance HAF-CPU concern.

## Goal

Add a length cap (and optionally a charset constraint) to `parseLanguageFilter` so the unbounded-string vector is closed.

## Architect decisions (to bake in before implementation)

**Length cap: 16 characters.** Rationale:
- BCP-47 (IETF language tags) is the natural shape for language values (e.g., `en`, `pt-BR`, `zh-Hant-TW`). Most real tags fit in ≤10 chars; 16 leaves headroom for edge cases.
- The route binds `?language=` to `c.json_metadata ->> 'language' = $N` (parameterized exact-equality). No per-character ILIKE cost. The cap exists primarily to bound the cache-key enumeration space.

**Charset constraint: deferred (separate decision).** Rationale:
- The helper docblock's deferral on charset was specifically about the publishing-UI's allowed-language set not being pinned end-to-end. That's still true.
- A defensible charset for BCP-47 is `^[a-zA-Z0-9-]+$`. But enforcing it would orphan any historical bridge papers with non-conforming language tags in their JSON metadata.
- For THIS task: length cap only. Charset can land as a follow-up after the publishing UI's allowed-language set is pinned.

**Empty-string handling:** `?language=` (no value) yields empty string. The current helper returns `{ok: true, value: ''}`, which propagates to the SQL bind. Decision: treat empty string as ABSENT (mirrors `?q=` whitespace-only behavior) — return `{ok: true, value: undefined}`. This avoids querying for papers with literal-empty-string language tags.

## Acceptance criteria

1. **Length cap.** Add `SEARCH_LANGUAGE_MAX_LEN = 16` constant to `backend/src/types/search-filters.ts`. Modify `parseLanguageFilter`:
   - `raw === undefined` → `{ok: true, value: undefined}` (unchanged)
   - `typeof raw !== 'string'` → `{ok: false, message: 'Invalid language. Must be a single value (repeated params not allowed)'}` (refined message per cluster-3 finding AC-04)
   - `raw.length === 0` → `{ok: true, value: undefined}` (NEW — absent semantics for empty-string)
   - `raw.length > 16` → `{ok: false, message: 'Invalid language. Must be 16 characters or fewer'}` (NEW)
   - Otherwise → `{ok: true, value: raw}` (unchanged)

2. **Helper-direct unit tests.** Add to `backend/tests/lib/search-filters.test.ts`:
   - `parseLanguageFilter(undefined)` → `{ok:true, value:undefined}`
   - `parseLanguageFilter('')` → `{ok:true, value:undefined}` (NEW empty-as-absent)
   - `parseLanguageFilter('en')` → `{ok:true, value:'en'}`
   - `parseLanguageFilter('pt-BR')` → `{ok:true, value:'pt-BR'}` (16-char boundary not yet hit)
   - `parseLanguageFilter('a'.repeat(16))` → `{ok:true, value:'aaaa...'}` (16-char boundary, accept)
   - `parseLanguageFilter('a'.repeat(17))` → `{ok:false, message: /16 characters/}` (17-char boundary, reject)
   - `parseLanguageFilter(['en','fr'])` → `{ok:false, message: /single value/}` (repeated-params shape)
   - `parseLanguageFilter(42)` → `{ok:false, message: /single value/}` (non-string non-array)

3. **Route-level test.** Add to `backend/tests/routes/search.test.ts`:
   - `?language=<17-char>` → 400 with the new length-cap message.
   - `?language=en` → 200 (happy-path; verify the filter is actually applied if the corpus has language-tagged papers).

4. **Helper docblock update.** Rewrite the deferral block at search-filters.ts:180-194 to reflect that LENGTH is now enforced (cap = 16) but charset is still deferred. Name the cluster-3 review pass (2026-05-16) as the gate that closed the length deferral.

5. **No charset change.** Charset enforcement is out of scope for this task. A separate follow-up can pin BCP-47 charset (`^[a-zA-Z0-9-]+$`) when the publishing UI's allowed-language set is pinned end-to-end.

## Out of scope

- Charset constraint on `?language=` (separate follow-up).
- Length caps on sibling params (`?source=`, `?sort=`, `?type=` are enum-bounded already; no cap needed).
- Frontend changes (publishing UI's allowed-language set is the prerequisite for charset enforcement; not this task).
- Audit of OTHER cache-key parameters for similar enumeration vectors (would be a separate sweep task).

## Source

- `backend-search-query-param-typeof-narrow-sweep` round-1 `/ce-code-review` (commit `e7a495f`, architect re-review 2026-05-16). Adversarial finding `adv-search-language-cache-exhaustion` (anchor 75) flagged the gap; correctness/security each acknowledged it informationally (no length cap is a documented deferral; not a regression introduced by the sweep).
- Architect triage on cluster-3 search-cluster review: filed as separate task to preserve typeof-narrow scope discipline.

## Cross-references

- `agents/docs/tasks/archive/backend-search-q-likeguard-and-length-cap.md` (200-char cap + LIKE-escape on `?q=`; analogous design)
- `agents/docs/tasks/archive/be-discipline-length-cap.md` (100-char cap on `?discipline=`; analogous design)
- `backend/src/types/search-filters.ts:180-194` — the docblock deferral this task closes
- `backend/src/types/disciplines.ts` — `validateDisciplineFilter` pattern (Result-shape return, length cap, charset guard)

## Backend implementation signal (2026-05-16)

All 5 acceptance items landed in a single commit. Files touched:

- `backend/src/types/search-filters.ts` — added `SEARCH_LANGUAGE_MAX_LEN = 16` exported constant; rewrote `parseLanguageFilter` to the 5-branch contract spec'd by the task (undefined → ok-absent; non-string → fail with refined message naming the "single value (repeated params not allowed)" contract; empty string → ok-absent; over-cap → fail with length-cap message naming "16 characters"; otherwise → ok with raw value). Rewrote the helper docblock to reflect that LENGTH is now enforced (cap = 16) and charset is still deferred, naming the cluster-3 review pass (2026-05-16) as the gate that closed the length deferral. The contract decision for empty-string-as-absent is also documented inline.
- `backend/tests/lib/search-filters.test.ts` — extended the `parseLanguageFilter` describe block with 6 new specs covering: empty-string-as-absent, BCP-47 subtagged shape (`pt-BR`), `SEARCH_LANGUAGE_MAX_LEN` constant pin, 16-char boundary accept, 17-char boundary reject (with `/16 characters/` message), and refined the existing repeated-param / non-string assertions to match `/single value/i` (the new error-message contract). 8 specs total per acceptance criterion #2.
- `backend/tests/routes/search.test.ts` — added 2 route-level specs: `?language=<17-char>` → 400 with length-cap message; `?language=en` → 200 happy-path.

`npm run lint` clean (pre-existing seed-phrase.ts warnings only); `npx tsc --noEmit` clean. Vitest deferred to the parent's serialized run after all in-flight backend tasks land.

## Architect re-review (2026-05-16, round-1 → round-2) — HELD PENDING FIXES:

`/ce-code-review` ran on commit `0a10584` with 8 personas (correctness opus; testing, maintainability, project-standards, security, kieran-typescript, ce-learnings-researcher sonnet; adversarial opus). `ce-agent-native-reviewer` skipped per PEvO root CLAUDE.md. Cluster-3 architect triage produced 1 item to address.

### Items to address

1. **(P2 maintainability+kieran-typescript, anchor 100 cross-reviewer)** `INVALID_LANGUAGE_LENGTH_MESSAGE` hardcodes `'16'` independently of `SEARCH_LANGUAGE_MAX_LEN`. At `backend/src/types/search-filters.ts:219`:

   ```ts
   const INVALID_LANGUAGE_LENGTH_MESSAGE = 'Invalid language. Must be 16 characters or fewer';
   ```

   The cap value `16` is duplicated as a string literal in the message — `SEARCH_LANGUAGE_MAX_LEN = 16` on `:216` is the policy value but is not interpolated. The test regex `/16 characters/` at `backend/tests/lib/search-filters.test.ts:251` and `backend/tests/routes/search.test.ts` also matches against the hardcoded literal, so changing `SEARCH_LANGUAGE_MAX_LEN` to e.g. 24 would silently produce a wrong-number message AND both tests would still pass — providing false confidence that the message reflects the active cap.

   Fix: template the message via the constant:

   ```ts
   const INVALID_LANGUAGE_LENGTH_MESSAGE = `Invalid language. Must be ${SEARCH_LANGUAGE_MAX_LEN} characters or fewer`;
   ```

   The test regexes `/16 characters/` stay valid as long as the cap is in the 10–99 range; no test update is required for this specific fix unless you also want to derive the regex from the constant (`new RegExp(`${SEARCH_LANGUAGE_MAX_LEN} characters`)`) for full single-source-of-truth.

### Items dismissed during architect triage

- (P3 kieran-typescript KT-02, anchor 50) Docblock claims "code points" but `.length` returns UTF-16 code units — dismissed at confidence gate. Pre-existing pattern shared with `SEARCH_QUERY_MAX_LEN` (would be a sweep, not a localized fix); irrelevant for the BCP-47 ASCII domain.
- (Adversarial residual) `?q=` is the dominant cache-key entropy contributor — out of scope per architect decision; the 16-char cap on `?language=` closes the specific `adv-search-language-cache-exhaustion` vector flagged in round-1 of typeof-narrow-sweep. Broader cache-exhaustion hardening (rate-limit-per-cache-miss, allowlist of canonical language tags) is a separate decision.
- (Adversarial residual) Empty-string-as-absent semantics shift — verified no client-observable behavior change. Pre-patch `?language=` (empty) flowed to `value: ''`, which was falsy at the `if (language)` SQL gate (`backend/src/routes/search.ts:79`) and coalesced to `l=` in the cache key (`:437`). Post-patch `value: undefined` produces identical SQL and identical cache key. Purely a typing refinement.
- (Adversarial residual) `.length` vs codepoints/bytes for the 16-char cap — irrelevant for BCP-47 ASCII domain; not exploitable (hashed cache key, parameterized SQL bind). Docblock imprecision noted under KT-02 above.
- (Correctness residual) Whitespace-only `?language=   ` is accepted by the helper (only literal `''` is treated as absent) — divergence from `?q=` trim-empty behavior, but consistent with the architect's empty-string-only decision baked into the task; not held.
- (P2 project-standards PS-001) Task file not moved from `pending/` to `review/` in the same commit — dismissed; backend CLAUDE.md option (b) explicitly permits append-and-move-in-N+1, and commit `83e98a9` performed the bulk pending→review triage move.

### Items handed to separate architect actions (not held on this task)

- (Learnings advisory) `backend/src/routes/papers.ts:477,479,517-519` is a known-remaining `req.query.x as string` sweep target per the `req-query-as-string-cast-silent-coerce-2026-05-16` learning. Out of scope for this task; architect should verify a follow-up task exists or file one before archiving the cluster.
- Vitest deferred per signal block; verify green on the parent serialized run before archive.

### Re-review signal

When item 1 above lands, `git mv` this file back to `tasks/review/`. Round-2 architect re-review scopes `/ce-code-review` to the round-2 commit. Anchor: a single-line template fix at `search-filters.ts:219`; tests stay as-is unless the implementer chooses the optional regex-from-constant tightening.
