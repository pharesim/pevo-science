# A comment title or body holding a control character fails its broadcast with an auth error

**Owner:** backend
**Created:** 2026-10-08
**Priority:** normal

Filed at the user's request ("file that too") from the "Related (not filed)" note in
`backend-platform-signed-ops-carry-unchecked-client-text`, which the same read-only workflow
produced on 2026-10-08. Priority is normal because the failure has been traced in source but not
seen on chain (Scope 1 settles that). If Scope 1 confirms it, a publishing flow is broken for
affected input, which fits `high`; that is the architect's call.

## Why

The trace below was read in hived master `45044109` with fc at `fcacedd2` (both 2026-10-07). The
version the deployed API nodes run, and any proxy in front of them, were not checked.

- dhive builds the JSON-RPC body with `JSON.stringify`, which writes a C0 control character other
  than tab, LF and CR as an escape: `\b`, `\f`, or `\u00XX`. An unpaired surrogate becomes
  `\udXXX`. The signed binary instead carries the raw byte, or EF BF BD (U+FFFD) for a lone
  surrogate.
- hived's JSON-RPC entry parses the request with fc's default legacy parser
  (`fc::json::from_string(message, ...)` in `libraries/plugins/json_rpc/json_rpc_plugin.cpp`).
  Its `parseEscape` (`fc/src/io/json.cpp`) decodes only `\t`, `\n`, `\r` and `\\`. Any other
  escape comes back as its next character, so `a\fb` reads as `afb` and `\u0001` as `u0001`.
- The node serializes the transaction it parsed, so the digest differs from the one the client
  signed, the recovered key does not match, and the broadcast is refused with an auth error.
- Nested JSON is not affected. A custom_json `json` or a comment `json_metadata` string reaches
  the node with doubled backslashes, which `parseEscape` restores. Only raw string fields are
  affected: a comment's `title`, `body` and `permlink`.

Neither the backend nor the frontend removes these characters before broadcast. The backend-signed
paths that would fail:

- Anonymous review (`routes/anonymousReview.ts`): the review `body` goes straight into the proxy
  account's comment. The user gets 500 `Failed to post anonymous review to Hive`.
- Light-account custody (`POST /api/custody/broadcast`): the SPA's comment `title`, `body` and
  `permlink` (papers, reviews, comments) are signed as sent, and the failure goes through
  `handleBroadcastError`.
- Bridge worker (`src/bridge-worker.ts`): `buildBridgeBody` and the comment `title` take arXiv and
  Crossref text verbatim. Also, `meta.title.slice(0, 253)` cuts by UTF-16 code unit, so a title
  over 256 characters can be left ending in a lone high surrogate.

A form feed or vertical tab pasted from a PDF or a word processor is enough to trigger it.

## Scope

1. Confirm the failure without broadcasting. Build a comment op whose `body` holds U+000C with
   dhive, sign it locally, and compare dhive's serialized hex with what an API node returns for
   the same transaction from a read-only call (`condenser_api.get_transaction_hex` or
   `database_api.get_transaction_hex`). Record the result in the signal block. If the two match,
   the premise is false: stop and report.
2. If they differ, refuse before signing, with a 400 that names the field and says what to remove,
   whenever a comment `title`, `body` or `permlink` holds U+0000 to U+0008, U+000B, U+000C,
   U+000E to U+001F, or an unpaired surrogate. This applies on the anonymous-review route and on
   custody's comment ops.
3. The bridge worker has no user to correct the text, so it rewrites provider text in the title
   and body: form feed and vertical tab become a newline, the other characters in that set are
   dropped, and an unpaired surrogate becomes U+FFFD. Its title truncation cuts by code point. If
   you choose a different rewrite, state it in the signal block.

Out of scope:

- The Keychain path (self-custody broadcasts from the SPA through the Keychain extension) is UI
  zone, and Keychain's own serializer was not checked.
- U+0000 and unpaired surrogates in custom_json `json` and comment `json_metadata`; that is
  `backend-platform-signed-ops-carry-unchecked-client-text`.

## Acceptance criteria

1. The signal block records the Scope 1 comparison: both hex strings, or the read call's error.
2. For each character class in Scope 2, a spec pins the 400 on the anonymous-review route and on a
   custody comment op, before any broadcast call. A body with tab, LF and CR still broadcasts.
3. Specs pin the bridge rewrite, and a title of 254 or more characters whose cut falls inside a
   surrogate pair, which must not end in a lone surrogate.
4. No emdash in new response strings. Comments follow root `CLAUDE.md` "Comment anchors".

## [TODO Architect]

If Scope 1 confirms the failure, the SPA's composer needs the same treatment for its Keychain path
(normalize or refuse before `requestBroadcast`), which would be a ui task. Normalizing in the
composer would also spare light-account users the 400 from Scope 2.
