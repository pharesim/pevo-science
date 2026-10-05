# Remove coordination context from the bodies of solutions entries

**Owner:** architect
**Created:** 2026-10-06
**Priority:** low

Filed by backend from the `/ce-compound-refresh` of
`agents/docs/solutions/conventions/pg-abortcontroller-budget-bounded-by-statement-timeout-2026-05-16.md`
(refreshed in `21571707`). That entry still cites three commit SHAs, a task slug and "Round-1"
in its Context and its Origin line. Removing them was left out of the refresh because it is a
convention sweep, not an accuracy fix. A count across the store showed the entry is typical.

## Why

Root `CLAUDE.md`, "Comment anchors": "Coordination context (round numbers, hold items, task
slugs, SHAs) belongs in commit messages and task files, not in source, and not in the bodies of
`agents/docs/solutions/` entries either." The rule exists because task files archive and the
archive trims, so a slug citation dies. A SHA does not tell a reader what the code does now.

A count at filing (2026-10-06) over the bodies of all 241 entries finds 152 entries with at
least one class:

| Class | Entries |
|---|---|
| Round or hold ordinals (`Round-1`, `round 3`, `hold item`, `hold #`) | 109 |
| Commit SHAs (backticked, or after `commit`) | 97 |
| Lowercase task slugs (`backend-…`, `ui-…`, `architect-…`) | 92 |
| Legacy uppercase slugs (`BE-…`, `BACKEND-…`, `SEC-…`, `UI-…` and siblings) | 46 |
| Task redirects (`see task`, `this task`, `tasks-archive`, `task body`) | 44 |
| Finding or option labels (`item #N`, `AC #N`, `Option A.4`) | 6 |

By category: 144 in `conventions/`, 4 in `architecture-patterns/`, 2 in `runtime-errors/`, 2
in `test-failures/`.

## Scope

- Remove the coordination tokens from entry bodies and keep what they pointed at. "Round-1 of
  `backend-haf-walker-wall-clock-budget` (commits `1d01a21` + `79078d7` + `741a3e9` on main,
  2026-05-16) added an AbortController…" becomes "A 2026-05-16 change added an
  AbortController…". Anchor on behaviour, a date, or a stable symbol, never on another
  coordination token. A convention-enforcing fix audits its own replacement.
- Fix by deleting or narrowing, per root `CLAUDE.md`. A sentence that turns out to be wrong
  about the code goes in a note for its own task, not into this sweep.
- Not coordination context, leave as is: frontmatter (including `date:`), filenames (dated names
  stay, per `agents/docs/solutions/README.md`), links to other solutions entries (which may
  contain role words or dates), `ARCHITECTURE.md` section references, `api-contracts/*.md`
  references, timings, and hex values shown as data.
- An entry whose subject is the convention itself (for example the entries on task-slug citations
  or the commit zone audit) may need slug or SHA examples. Keep those and list them under
  "Kept on purpose" in this file.
- The count's lowercase-slug pattern skips solutions filenames, but still catches some ordinary
  hyphenated phrases. Read each hit before editing.

## Decide before starting

1. **Line-number anchors.** A separate count finds 56 entries citing `file.ext:NN`. They drift:
   the refresh replaced three stale ones (`papers.ts:~2084`, `db.ts:22`, `db.ts:24`) in the
   AbortController entry. The `CLAUDE.md` sentence above does not list them for solutions
   bodies. Fold them into this sweep, file them separately, or leave them.
2. **A gate for new entries.** `.githooks/pre-commit` checks added lines under
   `{frontend,backend}/{src,tests}` only, so nothing stops a `/ce-compound` run from writing a
   new SHA or slug into an entry. Extending the gate to `agents/docs/solutions/` would hold the
   line once the sweep is done.
3. **Batching.** 152 entries is several commits. Grouping by the clusters in the solutions
   catalog, or by module, keeps each diff reviewable.

## Done when

The count below prints 0 for every class, or every remaining hit is listed under "Kept on
purpose" with a reason. Run it from `agents/docs/solutions/`; pass `-l` to list each entry with
its classes.

```python
import re, glob, collections, sys
files = sorted(glob.glob('*/*.md'))
names = {f.rsplit('/', 1)[-1][:-3] for f in files}
CLASSES = {
    'sha': r'`[0-9a-f]{7,40}`|\bcommits? `?[0-9a-f]{7,40}\b',
    'role-slug': r'(?<![A-Za-z0-9/._-])(?:backend|ui|architect)-[a-z0-9]+(?:-[a-z0-9]+)+',
    'legacy-slug': r'\b(?:BE|BACKEND|UI|SEC|AC|ARCHITECT|BRIDGE|FE|API)-[A-Z][A-Z0-9-]+',
    'round-hold': r'\b[Rr]ound[- ]?(?:\d+|one|two|three|four)\b|\bhold #|\bhold(?:-block)? items?\b|\bpre-round\b',
    'finding-label': r'\bitem #\d|\bacceptance #\d|\bAC #\d|\bOption [A-Z]\.\d',
    'task-redirect': r'\b(?:see|this) task\b|\btasks-archive\b|\btask body\b',
}
cnt = collections.Counter(); hits = {}
for f in files:
    s = open(f).read()
    body = s.split('\n---\n', 1)[1] if s.startswith('---') and '\n---\n' in s else s
    found = []
    for k, p in CLASSES.items():
        ms = [m.group(0) for m in re.finditer(p, body)]
        if k == 'role-slug':
            ms = [m for m in ms if m not in names and not re.search(r'-20\d\d-\d\d-\d\d$', m)]
        if ms:
            cnt[k] += 1; found.append(k)
    if found: hits[f] = found
print(f'docs {len(files)}  with any class {len(hits)}')
for k in CLASSES: print(f'  {k:14} {cnt[k]}')
if '-l' in sys.argv:
    for f, ks in hits.items(): print(f, ','.join(ks))
```

## Kept on purpose

(none yet)
