# Listing, profile and search rows of a continued paper show the root post, not the head

**Owner:** backend
**Created:** 2026-10-01
**Priority:** normal

## Why

The listing (`backend/src/routes/papers.ts`), the profile (`backend/src/routes/profile.ts`) and
search (`backend/src/routes/search.ts`) hide continuation posts (each filters on
`json_metadata -> <app tag> -> 'continues' IS NULL`) and read title and text from the root
post's `hafsql.comments` row:

- the listing: `c.title` and `LEFT(c.body, 300) AS abstract`;
- the profile: `c.title` and `LEFT(c.body, 300) AS body`, three sites;
- search: `c.title ILIKE` / `c.body ILIKE` in both match arms, and the snippet
  `substring(c.body from 1 for 300)`.

For a paper with continuations, the detail shows the head's title and text
(`fetchPaperDetailFromHaf` walks the chain), while these rows show the root's. A search for
wording that only the head holds misses the paper, and a search for wording the head removed
still finds it. No PEvO paper has a continuation today, so this is latent until the first one
lands.

SEO meta is not affected: `injectPaperMeta` in `backend/src/app.ts` reads `get_content`.

## Scope

Make the listing, profile and search rows of a continued paper present the head's title and
text, with a mechanism chosen here. Candidates: resolving each listed root's head, with a cache
keyed on the head's `(author, permlink, last_edited)` that a failed walk never fills; or a SQL
join from each root to its newest continuation. For search, filter over the head's text, or
record "search matches the root post of a continued paper" as a documented limit. Propose,
measure the listing cost (rows per page, walk or join cost) against the HAF node, and say which
you chose in the signal block. Reuse the detail's chain walk; do not grow a second walker.

## Acceptance criteria

1. A continued paper (a fixture root plus a continuation that changes title and text) lists, in
   the listing and on the profile, the head's title and the head's abstract.
2. Search on that fixture behaves as chosen and documented in the signal block.
3. A paper without continuations is unchanged, with no extra HAF query per row.
4. Each behaviour is pinned by a spec, and each spec is probed by reverting its own site.
5. New comments follow root `CLAUDE.md` "Comment anchors".

## History

Filed 2026-10-01 for six readers that showed the creation body of an edited post, because
`hafsql.comments.body` never took an edit (an upstream HafSQL defect). Blocked on the user's
report to the node operator. HafSQL v2.6.2 fixed it (2026-10-02), the configured node runs
v2.6.3 with `comments_table` rebuilt, and on 2026-10-08 10 of 10 freshly edited posts and every
earlier example showed the edited body in the column. The review and comment readers and the
edited-body half of the listing, profile and search readers needed nothing more. Rescoped by the
architect on 2026-10-09 to the continued-paper case, which the original task already named as the
part an upstream fix would leave.
