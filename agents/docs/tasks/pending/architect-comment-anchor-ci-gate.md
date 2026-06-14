# ARCHITECT-COMMENT-ANCHOR-CI-GATE — mechanize the comment-anchor convention so sweeps stop missing files

**Owner:** architect
**Created:** 2026-06-14 (architect, from the `/ce-code-review` of `bbe6607c` / the comment-anchor residual-sweep hold)
**Priority:** P3 (preventive tooling; no behavioral impact, but the gap it closes has recurred 3+ times)

## Problem

The root `CLAUDE.md` "Comment anchors" convention (no task slugs, round/hold/item
ordinals, acceptance-# cites, line-number/`LNN`/`~NNN` cites, commit SHAs, or soft
`see the task` redirects in production/test source) is enforced only by manual
review-time grep. That keeps failing the same way: a sweep greps a NARROW prefix
family (e.g. `BACKEND-` only, or `UI-`/`BE-`/`SEC-`/`BACKEND-` but not `JFR-`/`TEST-`/
the soft `See task ITEM N` redirect), reports "clean," and leaves in-scope rot in
files outside its own diff. Documented recurrences:

- `agents/docs/solutions/conventions/sweep-acceptance-grep-under-enumerates-slug-prefix-families-2026-06-08.md`
- the `bbe6607c` residual sweep (held 2026-06-14): missed `search.js` `JFR-001`,
  `accredited-directory.js` `See task ITEM N`, `bridge-preview.spec.js` `bridge.js L66`,
  `pages-settings.test.js` `AC #3`, and the `keychain.js`/`global-setup.js` ID redirects.

A mechanical gate would catch new violations at commit/CI time and end the
manual-sweep cycle.

## Goal

Add a repo-local check that fails when NEW comment-anchor rot is introduced in
`frontend/{src,tests}/**` and `backend/{src,tests}/**`, encoding the WIDENED
prefix-family pattern (not a narrow per-prefix grep).

## Design decisions to settle (this is why it isn't already automated)

- **Gate shape.** Prefer a DIFF-gate (fail only on rot ADDED by the staged/PR diff)
  over a whole-tree-clean gate — the tree currently carries accepted gray-area IDs
  (see allowlist) and an immediate whole-tree gate would block every unrelated
  commit until a full sweep lands. A whole-tree gate can come later once the tree
  is clean. Decide: staged-diff hook vs CI-diff check vs a vitest test that diffs
  against a committed baseline snapshot.
- **Placement.** A `.githooks/` pre-commit check is the consistent choice (the
  commit-msg zone audit already lives there, opt-in via `core.hooksPath`; architect
  zone). A CI-side check is the backstop since hooks are per-clone opt-in and
  `--no-verify`-bypassable. Consider both: hook for fast local feedback, CI for the
  authoritative gate. If a vitest-based check is chosen instead, note it lands in
  `frontend/`/`backend/` (ui/backend zones) and must be filed to those agents.
- **The hard part — false positives.** The pattern must ALLOWLIST legitimate
  durable anchors and non-slug tokens, or it will be too noisy to keep enabled:
  - `agents/docs/solutions/**/*.md`, `agents/docs/api-contracts/*.md`,
    `ARCHITECTURE.md § N` / `§6.5 invariant #2`, root/agent `CLAUDE.md` refs.
  - Duration/size approximations: `~10 min`, `~180s`, `~200 bytes`, `~100-char`
    (NOT line-number `~NNN`).
  - Crypto/format/standard tokens: `HMAC-SHA512`, `SHA-256`, `AES-256`, `ISO-8601`,
    `BIP39`, `UTF-8`, and prose hyphenations like `FAIL-CLOSED`, `ALL-CAPS`,
    `PRE-BROADCAST`, `CARVE-OUT`, `HIVE-KEYED`.
  - The base58 WIF character class `[1-9A-HJ-NP-Za-km-z]` (the `HJ-NP` false positive).
  - The self-describing E2E coverage-matrix header IDs (`E2E-AUTH-2`, `READ-N`,
    `WRITE-N`, `AUTH-N`, `CRYPTO-1`, `ACCR-1`, `BRIDGE-1`, `SETTINGS-1`) and
    `SEC-00N` security-requirement IDs in spec headers — decide whether to allowlist
    these wholesale or only in the first-line/header docblock position.
  - `describe()`/`it()` TEST-NAME strings — currently treated as a separate
    (deferred) class; decide whether the gate covers comments only or test names too.
- **Reuse.** The widened pattern from the sweep-grep solution doc is the starting
  regex; refine it against the allowlist above.

## Acceptance

- A documented gate (hook and/or CI check) that fails on NEWLY-added comment-anchor
  rot across the frontend + backend source/test trees, with the allowlist above
  honored (verified zero false positives against the current tree's accepted IDs).
- If implemented as a `.githooks/` hook: a test under `.githooks/tests/` (mirroring
  `test-commit-msg.sh`) and activation noted (per-clone `core.hooksPath`).
- A short entry in root `CLAUDE.md` "Comment anchors" pointing at the gate, and a
  `/ce-compound` solution doc if the allowlist design carries non-obvious rationale.
- Decide and record: diff-gate now, whole-tree-clean gate deferred until the tree
  is swept clean (the `ui-frontend-comment-anchor-residual-sweep` re-sweep is the
  remaining frontend debt; a backend pass may be needed too).

## Cross-references

- Root `CLAUDE.md` "Comment anchors".
- `agents/docs/solutions/conventions/sweep-acceptance-grep-under-enumerates-slug-prefix-families-2026-06-08.md`
- `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`
- `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`
- `agents/docs/solutions/conventions/commit-zone-audit-hook-2026-04-30.md` — the existing `.githooks` precedent.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
