# Tasks

One file per task. Conflict-free concurrent edits: agents only touch their own task file; transitions are `git mv` between section directories.

## Layout

```
tasks/
  pending/<slug>.md   # not yet started or in progress
  review/<slug>.md    # implementer done, awaiting architect re-review
  blocked/<slug>.md   # [BLOCKED by <agent>] — waiting on another agent
```

## Slug format

`<role>-<kebab-summary>.md`

Examples: `ui-keychain-upgrade.md`, `backend-recover-rate-limit.md`, `pinner-cid-gc.md`. No date prefix. Dates live inside the file (hold blocks, re-review signals).

## Task file shape

```markdown
# <Task title>

**Owner:** <role>
**Created:** <YYYY-MM-DD>

<Description. What, why, acceptance criteria.>

## Implementation notes

<Implementer's notes as work progresses.>

## Architect re-review (<date>) — HELD PENDING FIXES:

- Finding 1 ...
- Finding 2 ...

## <Role> re-review signal (<date>, <working tree or SHA>):

- Finding 1: addressed in path/to/file.ts:NN — <short justification>
- Finding 2: ...
```

Hold blocks and re-review signals are appended, never rewritten. The architect updates hold blocks only during re-review. See `CLAUDE.md` § Agent Coordination Rules #7.

## Transitions

| From | To | Who | Mechanism |
|------|----|-----|-----------|
| (new) | `pending/` | any agent | create file |
| `pending/` | `review/` | implementer | `git mv` when task complete, then append a re-review signal block if revisiting |
| `pending/` | `blocked/` | any agent | `git mv` + append `[BLOCKED by <agent>]` note |
| `blocked/` | `pending/` | blocking agent | `git mv` once unblocked |
| `review/` | `pending/` | architect | `git mv` if new hold block requires more than appended fixes |
| `review/` | archived | architect | see Archive below |

## Archive

When the architect archives a task:

1. **Prepend** the task file's contents to `agents/docs/tasks-archive.md`, under a `## <Task title> (archived <YYYY-MM-DD>)` heading.
2. **Trim** `tasks-archive.md` from the bottom to at most **250 lines**. Old archive entries fall off; full history lives in git.
3. **Delete** the per-task file (`git rm agents/docs/tasks/review/<slug>.md`).

No strikethrough, no "completed" markers in the task file. Archive = prepend + trim + delete.
