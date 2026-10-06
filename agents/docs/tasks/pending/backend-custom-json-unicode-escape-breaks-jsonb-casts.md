# A custom_json op carrying a `\u0000` or lone-surrogate escape breaks every jsonb cast of it

**Owner:** backend
**Created:** 2026-10-07
**Priority:** high

Filed from the review of `backend-latest-op-haf-lookups-walk-the-blocks-index` (triage: user).

## Why

- `hafsql.operation_custom_json_view.json` is `text`, defined as `o.body_value ->> 'json'`
  (checked on the HAF node on 2026-10-07). PEvO's queries parse it with `cj.json::jsonb`; at
  filing, 188 lines under `backend/src` across 11 files contain `json::jsonb` or `json::json`.
- PostgreSQL's jsonb input rejects the escape `\u0000` and a lone surrogate escape such as
  `\ud800`, and the cast throws (checked on PostgreSQL 16; the HAF node runs 17.9).
  `::json ->> 'action'` also throws when another key holds `\u0000`.
- Any Hive account can broadcast a custom_json under the app tag's id. The `revoteResult` read in
  `backend/src/routes/papers.ts` filters on `custom_id` and then only on cast fields (`action`,
  `author`, `permlink`), so one such op would make it throw on every paper, and the op cannot be
  removed from the chain. A signer or authority filter does not reliably keep the cast off that
  row either: PostgreSQL does not fix the order in which `WHERE` conditions are evaluated.
- Not yet verified: that hived accepts a custom_json whose `json` holds such an escape.

`backend-accreditation-character-rule-on-other-chain-writes` closes the platform's own write
paths. This task covers ops PEvO does not write.

## Scope

1. Read hived's validation of `custom_json_operation` (the JSON validity check its `validate`
   calls) in the hived source. No broadcast. If hived rejects both escapes, cite the source in the
   signal block and stop.
2. Otherwise, a row whose `json` the jsonb input rejects must not make a PEvO HAF query error; it
   matches nothing. Because PostgreSQL does not fix `WHERE` evaluation order, the check must be
   sequenced before the cast explicitly (PostgreSQL's documented way is a `CASE`), not added as a
   sibling `AND` condition.
3. Apply it to every query that casts the view's `json` column. A shared SQL fragment is invisible
   to the static SQL lint rules (`static-sql-lint-rule-blind-to-extracted-fragments-2026-06-14.md`);
   check what those rules read before extracting one.

Out of scope: comment `json_metadata` reads. State that column's type in the signal block.

## Acceptance criteria

1. Specs show that a row whose `json` holds `\u0000` or a lone surrogate is skipped while an
   ordinary row still matches, for the guard form used. The synthetic-`VALUES` redirect in
   `test-haf-sql-selection-redirect-cte-from-synthetic-values-2026-06-09.md` is one way to feed
   such rows without HAF.
2. Comments follow root `CLAUDE.md` "Comment anchors".
