# Platform-signed ops carry client text with no rule against U+0000 or an unpaired surrogate

**Owner:** backend
**Created:** 2026-10-08
**Priority:** high

Filed from the out-of-scope observations in the signal block of
`backend-accreditation-character-rule-on-other-chain-writes` (user: "file the gap"). A read-only
workflow enumerated the sites below on 2026-10-08 (main at `8cbde35e`) and a second pass re-checked
each one. Re-check them against the tree at pickup.

## Why

- `JSON.stringify` writes U+0000 as `\u0000` and an unpaired surrogate as its `\uXXXX` escape.
  PostgreSQL's jsonb input rejects both, and PEvO's HAF reads parse custom_json with
  `cj.json::jsonb` (see `backend-custom-json-unicode-escape-breaks-jsonb-casts`).
- hived accepts both escapes in a custom_json `json` and in a comment `json_metadata`. This was
  read in hived master `45044109` with the fc submodule at `fcacedd2`.
  `custom_json_operation::validate` calls only `validate_json_with_fallback`
  (`libraries/protocol/hive_operations.cpp`). Its simdjson fast path decodes `\u0000` without a
  NUL check and passes a lone low surrogate. Its legacy fallback parser reads an unknown escape such
  as `\ud800` as literal characters. `custom_json_evaluator::do_apply` checks only the length for an
  app id with no registered interpreter. So such an op lands, and it cannot be removed.
- Reads that filter on the platform signer cast these rows for certain.
  - `retractedPapersCteBody` in `hafsql.ts` casts every admin-signed `retract_paper` op, and the
    paper listing (`routes/papers.ts`) and search (`routes/search.ts`) exclude retracted papers
    through it. One bad `retract_paper` op makes both queries throw.
  - The admin roster read in `hafsql.ts` casts every admin-signed `admin_grant`/`admin_revoke` op.
    `getAdminLevel` fails closed when that read throws, so one bad `admin_grant` op denies every
    chain-granted admin tier; only the root account keeps working.
- The widest path needs no admin role. `POST /api/papers/:author/:permlink/retract` takes `reason`
  as `(req.body.reason as string) || ''`, with no type, length or character check, from the paper's
  URL author. It checks neither accreditation nor fresh auth, and it broadcasts with the admin key.

The read-side task makes PEvO's queries survive such a row from any account. This task stops the
platform from signing one.

## Sites

Client or provider text in a platform-signed custom_json, with no rule against either character.

**Admin key** (`broadcastAdminCustomJson`):

- `POST /api/papers/:author/:permlink/retract` (`routes/papers.ts`): `reason`, of any value type
  and unbounded.
- `POST /api/admin/roster/grant`: `account` (`hiveAccount`: length bounds and lowercasing only).
- `POST /api/admin/accreditation/grant`: `account`.
- `POST /api/admin/accreditation/sanction`: `account`, and `reason` (`max(500)` only).
- `POST /api/admin/papers/retract`: `author`, `permlink` (`hivePermlink`: length bounds only), and
  `reason`.
- `POST /api/admin/authorship/revoke`: `claimer`, `paper_author`, `paper_permlink` and `reason`.
- `POST /api/papers/:author/:permlink/claims/:claimer/revoke`, the admin branch on a native paper
  (`routes/claims.ts`): `reason`, a body `as` cast that takes any value, and the URL params
  `claimer`, `author` and `permlink`, which have no format check. Express decodes `%00` to U+0000;
  a percent-encoded lone surrogate gets a 400 before the handler.

**Bridge key** (`getRequiredBridgePostingKey`, which is the admin key when `HIVE_BRIDGE_ACCOUNT`
equals `HIVE_ADMIN_ACCOUNT`, the default):

- `POST /api/admin/authorship/approve`: `claimer` and `paper_permlink`.
- `POST /api/papers/:author/:permlink/claims/:claimer/approve`, the bridge-paper branch:
  `author_index`, a body `as` cast that takes any value and that the admin account or any approved
  co-author of the bridge paper can send; `claimer` (URL param); and `paper_permlink` (URL param,
  in practice only from the admin account).
- `POST /api/papers/:author/:permlink/claims/:claimer/revoke`, the bridge-paper branch: `reason`,
  `claimer` and `paper_permlink`.

**Light-account custody** (`POST /api/custody/broadcast`, signed with the user's own key, which
PEvO holds): the client's custom_json `json` and comment `json_metadata` are signed after only a
`JSON.parse` and the allowlist checks. A self-custody account can broadcast the same op itself, so
this does not widen who can write one, but PEvO is the signer.

**Bridge worker** comment `json_metadata` (`buildBridgeMetadata`): provider text from arXiv and
Crossref (author names, ORCID, URLs, dates, license, DOI), with no sanitizing. PEvO reads comment
`json_metadata` as the jsonb column of `hafsql.comments` and never casts it. Whether such an escape
breaks anything depends on how HAF ingests it, which is unverified: checking it needs a read-only
query on the HAF node and the user's permission.

Checked clean: every accredit-op builder except the admin grant's `account`, the anonymous-review
`anon_review` custom_json and the review comment's `json_metadata`, account creation, and WoT.

## Scope

1. Reject U+0000 and unpaired surrogates with a 400 at the request, for every request field under
   "Sites":
   - `hiveAccount` and `hivePermlink` in `validation.ts` take the Hive account-name and permlink
     formats (`HIVE_ACCOUNT_NAME_REGEX` and `HIVE_PERMLINK_FORMAT_REGEX`, as
     `validateRetractParams` applies them), which exclude both characters. Before tightening,
     confirm that no admin-console flow sends a permlink outside that format.
   - The admin `reason` fields (sanction, papers/retract, authorship/revoke) get the character rule.
   - The self-service retract's `reason` and the claims routes' `reason` become typed strings with a
     length bound (the admin retract's `max(500)`) and the character rule. `author_index` becomes an
     integer or null. The claims routes' URL params get the account-name and permlink format checks.
2. Add a backstop where the platform signs. Refuse to broadcast a custom_json `json` (admin key,
   bridge key, anonymous-review proxy, custody) or a comment `json_metadata` (bridge worker,
   custody) whose decoded strings hold U+0000 or an unpaired surrogate. The refusal answers non-2xx
   and broadcasts nothing. Check the decoded strings, not the escape text, so a client's escaped
   surrogate pair still passes. The backstop also covers chain values that a later op carries
   forward (the metadata edit's `prior.*`, ORCID `handleLink`), which no request schema sees. For
   the bridge worker, decide whether to rewrite provider text (as `toAccreditOpText` does for the
   ORCID name) or skip the import, and state the choice in the signal block.

Out of scope:

- Comment `title`, `body` and `permlink`. On PEvO's dhive path, these raw fields do not land with a
  U+0000, a lone surrogate or another C0 control character (see "Related").
- The read side, which is `backend-custom-json-unicode-escape-breaks-jsonb-casts`.

## Acceptance criteria

1. For each request field in Scope 1, a spec pins a 400 with no broadcast for U+0000, and for an
   unpaired surrogate wherever the transport admits one (JSON bodies, not URL params). An ordinary
   value still succeeds.
2. The self-service retract and claims routes answer 400 for a non-string `reason` and a
   non-integer `author_index`.
3. For each signing path the backstop covers, specs pin a refusal for each character before any
   broadcast call, and pin that an escaped surrogate pair passes.
4. No emdash in new response strings. Comments follow root `CLAUDE.md` "Comment anchors".

## Related (not filed)

- Raw comment fields fail to broadcast. dhive signs a U+0000 as byte 00 and a lone surrogate as
  U+FFFD, and the RPC JSON carries the escape. hived's JSON-RPC entry uses fc's legacy parser,
  whose `parseEscape` handles only `t`, `n`, `r` and backslash. The node therefore rebuilds a
  different string, the signature does not verify, and the broadcast is refused with an auth error.
  The same happens for any C0 control character other than tab, LF and CR. So an anonymous review
  `body`, a light-account paper's `title` or `body` via custody, or a bridge import's `title` or
  `body` holding a form feed pasted from a PDF fails to broadcast. This was traced in source and not
  exercised live. Separately, the bridge worker's `meta.title.slice(0, 253)` can cut a surrogate
  pair and leave a lone high surrogate. These are user-facing failures, not poisoned ops, and can
  be a separate task if wanted.
