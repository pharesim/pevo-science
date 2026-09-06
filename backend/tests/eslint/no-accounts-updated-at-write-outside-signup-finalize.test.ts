/**
 * Standing source-discipline canary: `accounts.updated_at` is written by
 * exactly two statements, the `/confirm` finalize and the `/link` finalize in
 * `routes/signup-verify.ts`, and by nothing else in the application.
 *
 * WHAT THE CLOSED SET BUYS. The `/link` stuck-recovery lookup re-finds a row by
 * `username` once `verify_token` has been cleared, and admitting a row there
 * BYPASSES the signup session-binding check: the row was bound by the prior
 * finalize, and the request's Hive signature stands in as the stronger
 * per-request credential. An account that has upgraded to self-custody must
 * never reach that branch, and the term that keeps it out is an ordering
 * between two epochs on the row, `upgraded_at <= updated_at`.
 *
 * That ordering holds for exactly one reason. The upgrade stamps `upgraded_at`
 * and deliberately leaves `updated_at` alone, so an upgraded row carries an
 * upgrade epoch strictly NEWER than its recency marker and fails the
 * comparison. Add a third writer of `updated_at` anywhere — a settings touch, a
 * profile write, an admin tool, a trigger — and the next such write on an
 * upgraded row moves the marker past the epoch, the comparison starts passing,
 * and that account becomes eligible for a binding-free session mint.
 *
 * WHERE THE THIRD WRITER MOST PLAUSIBLY COMES FROM, so the next author reading
 * a red bar recognises their own edit: the signup upserts refresh `created_at`
 * in their `ON CONFLICT ... DO UPDATE` branches and leave `updated_at` alone,
 * which reads like an oversight and is not one. A column DEFAULT fires on the
 * insert branch only, so those branches genuinely do not advance the marker,
 * and that asymmetry is what keeps a repeat signup against an existing row from
 * moving the marker past an upgrade epoch. Symmetrising it is the shape this
 * canary exists to stop.
 *
 * WHY A SOURCE SCAN. Nothing else refuses it. The schema cannot express the
 * ordering (both columns are legitimately writable), and no behavioural test
 * goes red, because reaching the bypass needs a row in the narrow
 * post-finalize state plus a valid ownership proof: a third writer changes
 * nothing observable at the wire until someone exercises the recovery path
 * against an upgraded account, which is the incident, not the test.
 *
 * THREE SCANS OVER `src`, two of them deriving the same writer set from
 * opposite ends so a misattribution in either walk is a red bar rather than a
 * silent pass.
 *
 *   1. COLUMN-FIRST. Every `updated_at` assignment in the tree, attributed to
 *      the table it writes by walking up to the nearest `UPDATE <table>` /
 *      `INSERT INTO <table>`. Those resolving to `accounts` must be exactly the
 *      two finalizes, TALLIED per `file#symbol`. A key set alone would let an
 *      allowed key absorb a second write, and both allowed keys are route
 *      handlers running a couple of hundred lines each, so the count is what
 *      makes a write added beside a licensed one a new member.
 *
 *   2. RESOLUTION IS FAIL-CLOSED. No assignment may resolve to
 *      {@link UNRESOLVED_TABLE}. Without this, a shape the upward walk cannot
 *      read passes as "not accounts", which is the silent direction. With it,
 *      an unattributable write is a red bar naming its line.
 *
 *   3. TABLE-FIRST. Every `UPDATE accounts` / `INSERT INTO accounts` statement,
 *      read whole to its terminator, flagged when its SET list or INSERT
 *      column list carries the column. This is not a redundant spelling
 *      of the first scan: an `INSERT INTO accounts (..., updated_at)` writes
 *      the column with no assignment anywhere in the statement, so the
 *      column-first pattern cannot see it at all, and anchoring on the table
 *      also survives an intervening `UPDATE` that would capture the upward
 *      walk.
 *
 *   4. NO INTERPOLATED `accounts` WRITE. A statement partly held in a variable
 *      defeats the other three at once: the fragment carrying the assignment
 *      is attributed by the upward walk to whatever table sits above the
 *      constant's declaration, so it RESOLVES and the fail-closed arm stays
 *      quiet, while the table-first read finds a placeholder where the SET
 *      list should be. Refusing the shape where it would matter is what keeps
 *      the fail-closed property from being conditional on nobody writing it.
 *      Read-side interpolation is untouched; the recovery lookups themselves
 *      interpolate their window and are SELECTs.
 *
 * AND OVER `migrations`, because the route comment's universal has a second
 * half — the table carries no trigger — and a trigger is precisely the third
 * writer no scan of application source can see. Stored routines are refused
 * alongside triggers and rules: a trigger function is written before the
 * trigger that installs it, and a routine body is a write path its call site
 * does not spell. The migration-side writer set is pinned too: the column's
 * introduction back-fills it, and the custody-alignment migration's own header
 * records that it deliberately does NOT bump the marker, since that would put
 * every repaired row inside the recovery window for the length of the window
 * after deploy. A future back-fill that forgets is the same hazard as a third
 * route writer. The fail-closed resolution arm spans both trees, because an
 * unattributable write matters more in a migration, not less.
 *
 * KNOWN LIMITS, stated here rather than discovered later:
 *
 *   - Detection is TEXTUAL, per `tests/support/enclosing-symbol.ts`. A SET
 *     list composed from a variable is refused rather than tolerated, but a
 *     dynamically NAMED target — `UPDATE ${table}`, an `EXECUTE format(...)`
 *     in a migration — still hides, because there is no literal `accounts` for
 *     the table-first scan to anchor on. What makes a text scan sound today is
 *     that no write in either tree names its table that way.
 *   - The column carries a `DEFAULT now()`, so every INSERT stamps it without
 *     naming it. That is not a hazard and is not scanned for: the ordering
 *     protects an ALREADY-upgraded row, and a row being inserted has no upgrade
 *     epoch yet.
 *   - The scans read the shapes an author writes by accident, not the ones an
 *     author writes to evade a test. A writer determined to get past them can.
 *
 * A NOTE ON REUSE. `sourcesUnder`, `enclosingSymbol` and `isCommentLine` come
 * from the shared support module. The statement reach does not: the joined-
 * statement helper in the custody-claim canary is tuned for TypeScript
 * expressions and caps its join at four lines, and the `/confirm` finalize puts
 * five SET lines between `UPDATE accounts` and its `updated_at` assignment, so
 * that helper structurally cannot reach the shape this canary exists to see.
 * The reach here is delimited by what an SQL statement actually ends at
 * instead: its own string quote in TypeScript, its semicolon in a migration.
 *
 * Planted positives and negatives at the bottom keep every pattern honest:
 * without them an edit that mangles one leaves its scan matching nothing and
 * the canary enforces nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  enclosingSymbol,
  isCommentLine,
  sourcesUnder,
  type ScannedSource,
} from '../support/enclosing-symbol.js';

/** The only two statements licensed to write the column, keyed `file#symbol`
 *  and carrying HOW MANY writes each symbol may hold. Both are signup
 *  finalizes: they stamp the marker at the moment the recovery window they
 *  bound is supposed to open.
 *
 *  The count is the load-bearing half. Each allowed key names a route handler
 *  running a couple of hundred lines, so a set of keys alone absorbs a second
 *  write added anywhere inside one of them — including the resume branch of
 *  the very handler the ordering protects, which is where an author fixing a
 *  recovery bug would most naturally put one. Counting occurrences turns that
 *  into a new member of the comparison instead. A third entry, or a raised
 *  count, is a decision about the ordering invariant, not a bookkeeping
 *  update. */
const ALLOWED_WRITER_SITES: Record<string, number> = {
  'routes/signup-verify.ts#POST /confirm': 1,
  'routes/signup-verify.ts#POST /link': 1,
};

/** The one migration licensed to write the column: the one that introduces it
 *  and back-fills existing rows to a definitively-past value. */
const ALLOWED_WRITER_MIGRATIONS: Record<string, number> = {
  '016_accounts_updated_at.sql#<module>': 1,
};

/** Triggers, rules and stored routines whose bodies demonstrably cannot write
 *  `accounts.updated_at`. Empty, and the app database defines none at all,
 *  which is what lets this arm refuse every one of them rather than parse each
 *  trigger's `ON <table>` clause and each routine's body. Adding one anywhere
 *  is a red bar asking for that judgement to be made by hand once, and
 *  recorded here, rather than assumed.
 *
 *  Entries match as substrings of the reported site, so a filename exempts a
 *  file and a routine name exempts one routine. */
const ROUTINES_THAT_CANNOT_REACH_ACCOUNTS: string[] = [];

/** Why the set is closed, carried into every failure message so whoever trips
 *  the bar can tell whether their new writer is safe rather than reaching for
 *  the assertion. A message that says only "unexpected site" sends the next
 *  author to delete it. */
const ORDERING_RATIONALE =
  'the /link stuck-recovery lookup admits a row only when `upgraded_at <= updated_at`, ' +
  'and admitting a row there bypasses the signup session-binding check. An upgrade stamps ' +
  '`upgraded_at` and leaves `updated_at` alone, so an upgraded account fails that comparison ' +
  'and stays out of the bypass. A third writer of `updated_at` moves the marker past the ' +
  'upgrade epoch on the next write and hands that account a binding-free session mint. ' +
  'If a new writer is genuinely safe, say why here and add it to the list; do not widen ' +
  'the list to make a bar go green.';

/** An assignment to the column: the SET-list shape, in any SQL spelling of the
 *  right-hand side. The lookbehind drops a property access (`row.updated_at =`,
 *  which is a TypeScript assignment and writes no database column) and the
 *  negative lookahead drops a comparison (`updated_at ==`), while a SQL
 *  equality read (`WHERE updated_at = $1`) would match and is a red bar on a
 *  statement that writes nothing — the safe direction for a refusal, and no
 *  such read exists in the tree. */
const COLUMN_ASSIGNMENT_RE = /(?<![.\w])updated_at\s*=(?!=)/;

/** The same write in PostgreSQL's ROW-ASSIGNMENT form, `SET (a, b) = (x, y)`,
 *  where the column is followed by a comma or a paren and the `=` belongs to
 *  the target list. Valid SQL, one keystroke from the ordinary form, and
 *  invisible to a pattern that expects the column and the `=` to be adjacent.
 *  The capture is the target list, tested for the column separately. */
const SET_TARGET_LIST_RE = /\bSET\s*\(([^)]*)\)\s*=/i;

/** A TypeScript local carrying the column's name, which writes no column. The
 *  tree spells row fields in snake_case, so `const updated_at = ...` is a
 *  shape someone writes without meaning anything by it. Excluded by
 *  declaration keyword rather than by name, so an assignment inside a SQL
 *  string is untouched. */
const TYPESCRIPT_LOCAL_RE = /\b(?:const|let|var)\s+updated_at\s*[:=]/;

/** Whether a line writes the column, in either spelling. */
function assignsColumn(text: string): boolean {
  if (TYPESCRIPT_LOCAL_RE.test(text)) return false;
  if (COLUMN_ASSIGNMENT_RE.test(text)) return true;
  const targets = text.match(SET_TARGET_LIST_RE);
  return targets !== null && /\bupdated_at\b/.test(targets[1]);
}

/** The table an `UPDATE` targets. `FOR UPDATE SKIP LOCKED` is excluded by the
 *  lookbehind and PostgreSQL's `ON CONFLICT ... DO UPDATE SET` by the
 *  {@link NOT_A_TABLE} rejection, so an upsert's assignments resolve to the
 *  INSERT's table rather than to a table named `set`. */
const UPDATE_TARGET_RE = /(?<!\bFOR\s+)\bUPDATE\s+(?:ONLY\s+)?([a-z_][a-z0-9_.]*)/i;
const INSERT_TARGET_RE = /\bINSERT\s+INTO\s+([a-z_][a-z0-9_.]*)/i;
/** `UPDATE` followed by this word names no table. */
const NOT_A_TABLE = 'set';

/** An `accounts` statement, matched case-insensitively so a lowercase-keyword
 *  writer cannot slip past. Prose that happens to read like one is admitted
 *  too, which costs nothing: only statements whose text WRITES the column
 *  reach an assertion, and a sentence does not.
 *
 *  Schema qualification is admitted for `public` alone, which is what keeps the
 *  chain-side `hafsql.accounts` view out of the set. It carries the same bare
 *  name and a different meaning, it lives in the read-only database, and the
 *  ordering these scans protect says nothing about it. */
const ACCOUNTS_STATEMENT_RE =
  /\b(?:UPDATE\s+(?:ONLY\s+)?|INSERT\s+INTO\s+)(?:public\.)?accounts\b/i;

/** The column list of an `INSERT INTO accounts (...)`, which writes the column
 *  by naming it and carries no assignment for the column-first scan to find.
 *  The table alias is optional because `INSERT INTO accounts AS a (...)` is the
 *  idiomatic spelling once an `ON CONFLICT ... DO UPDATE` clause needs to read
 *  the pre-existing row, and this file already holds two such upserts. */
const ACCOUNTS_INSERT_COLUMNS_RE =
  /\bINSERT\s+INTO\s+(?:public\.)?accounts(?:\s+AS\s+[a-z_][a-z0-9_]*)?\s*\(([^)]*)\)/is;

/** Trigger, rule and stored-routine creation, in every spelling PostgreSQL
 *  accepts. A rule is in scope for the same reason a trigger is: it rewrites a
 *  statement into one the source does not show. A function or procedure is in
 *  scope because its body is a write path the call site does not spell, and
 *  because a trigger function is written before the trigger that installs
 *  it. */
const ROUTINE_CREATION_RE =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?(?:EVENT\s+)?(?:TRIGGER|RULE|FUNCTION|PROCEDURE)\b/i;

/** A template interpolation inside a SQL literal. Harmless in a read, and the
 *  reason it is refused inside an `accounts` write is that it moves part of the
 *  statement out of the statement: a SET fragment held in a constant is
 *  attributed by the column-first walk to whatever table happens to sit nearest
 *  above the constant's declaration, so it resolves, the fail-closed arm stays
 *  quiet, and the table-first read sees a statement whose SET list is a
 *  placeholder. That is the one evasion that defeats all the other scans at
 *  once, so the shape is refused outright where it would matter. */
const SQL_INTERPOLATION_RE = /\$\{/;

/** The label a write gets when no statement above it names a table. */
const UNRESOLVED_TABLE = '<unresolved>';

/** How far each walk reaches. `WALK` is the upward reach from an assignment to
 *  its statement head, sized for the longest such distance the tree holds (an
 *  upsert, whose `DO UPDATE SET` assignments sit below a `VALUES` list and a
 *  multi-line `CASE`). `LITERAL` bounds the downward read of one statement, so
 *  an unterminated quote cannot swallow the rest of a file. */
const WALK_CAP = 25;
const LITERAL_CAP = 40;

/** The table written by the assignment on `lineIndex`: the nearest statement
 *  head at or above it, or {@link UNRESOLVED_TABLE}. Schema qualification is
 *  dropped so `public.accounts` and `accounts` are one table. */
function targetTable(lines: string[], lineIndex: number): string {
  for (let i = lineIndex; i >= 0 && i >= lineIndex - WALK_CAP; i--) {
    if (isCommentLine(lines[i])) continue;
    const updated = lines[i].match(UPDATE_TARGET_RE);
    if (updated && updated[1].toLowerCase() !== NOT_A_TABLE) return bareTable(updated[1]);
    const inserted = lines[i].match(INSERT_TARGET_RE);
    if (inserted) return bareTable(inserted[1]);
  }
  return UNRESOLVED_TABLE;
}

/** A table name with its default-schema qualification dropped, so `accounts`
 *  and `public.accounts` are one table while a name qualified into any other
 *  schema stays distinct from both. */
function bareTable(name: string): string {
  return name.toLowerCase().replace(/^public\./, '');
}

/**
 * The SQL statement that starts at `matchIndex` on `lineIndex`, read to
 * whichever terminator comes first.
 *
 * Two terminators, because the two places an `accounts` statement is written
 * end differently. In TypeScript the statement is a string literal, and the
 * delimiter is taken from the source rather than assumed: the last quote
 * character before the SQL keyword opens it, so a backtick template and a
 * single-quoted one-liner are each read to their own quote, and the `'light'`
 * and `'self'` literals inside a backticked SET list do not end it. In a
 * migration there is no quote at all, and the statement ends at its semicolon,
 * which also stops the read from running on into a following procedural block.
 * A keyword with neither before it is read as a template continuation, capped.
 */
function sqlStatementAt(lines: string[], lineIndex: number, matchIndex: number): string {
  const before = lines[lineIndex].slice(0, matchIndex);
  const quote = [...before].reverse().find((c) => c === '`' || c === "'" || c === '"') ?? '`';
  const endOf = (line: string): number => {
    const candidates = [line.indexOf(quote), line.indexOf(';')].filter((at) => at !== -1);
    return candidates.length === 0 ? -1 : Math.min(...candidates);
  };
  const head = lines[lineIndex].slice(matchIndex);
  const closes = endOf(head);
  if (closes !== -1) return head.slice(0, closes);
  let out = head;
  for (let i = lineIndex + 1; i < lines.length && i <= lineIndex + LITERAL_CAP; i++) {
    const at = endOf(lines[i]);
    if (at !== -1) return out + '\n' + lines[i].slice(0, at);
    out += '\n' + lines[i];
  }
  return out;
}

/** Whether an `accounts` statement writes the column: an assignment anywhere in
 *  it, or the column named in an INSERT column list.
 *
 *  Anywhere, deliberately, rather than only ahead of the statement's `WHERE`.
 *  Confining the assignment test to a statement's head reads well until a SET
 *  list carries a subquery, whose own `WHERE` then truncates the text before
 *  the real assignment and turns a live writer into a silent pass. What the
 *  wider test costs is a red bar on an equality PREDICATE over the column
 *  (`WHERE updated_at = $1`) inside a statement that writes it elsewhere or not
 *  at all. No accounts statement keys on the recency marker today, one that did
 *  would be worth a look anyway, and over-matching is the safe direction for a
 *  scan whose job is refusal. The predicate a back-fill actually writes
 *  (`WHERE updated_at IS NULL`) carries no `=` and does not match. */
function writesColumn(statement: string): boolean {
  if (assignsColumn(statement)) return true;
  const columns = statement.match(ACCOUNTS_INSERT_COLUMNS_RE);
  return columns !== null && /\bupdated_at\b/.test(columns[1]);
}

interface Occurrence {
  key: string;
  site: string;
}

/** Every column assignment across `files`, attributed to a table. */
function columnAssignments(files: ScannedSource[]): Map<string, Occurrence[]> {
  const byTable = new Map<string, Occurrence[]>();
  for (const { rel, lines } of files) {
    lines.forEach((line, i) => {
      if (!assignsColumn(line) || isCommentLine(line)) return;
      const table = targetTable(lines, i);
      const symbol = enclosingSymbol(lines, i);
      const found = byTable.get(table) ?? [];
      found.push({ key: `${rel}#${symbol}`, site: `${rel}:${i + 1} (${symbol}) — ${line.trim()}` });
      byTable.set(table, found);
    });
  }
  return byTable;
}

/** Every `accounts` statement that writes the column, read table-first. */
function accountsColumnWriters(files: ScannedSource[]): Occurrence[] {
  const found: Occurrence[] = [];
  for (const { rel, lines } of files) {
    lines.forEach((line, i) => {
      const match = line.match(ACCOUNTS_STATEMENT_RE);
      if (match === null || isCommentLine(line)) return;
      if (!writesColumn(sqlStatementAt(lines, i, match.index ?? 0))) return;
      const symbol = enclosingSymbol(lines, i);
      found.push({ key: `${rel}#${symbol}`, site: `${rel}:${i + 1} (${symbol}) — ${line.trim()}` });
    });
  }
  return found;
}

/** Occurrences tallied per `file#symbol`, which is what a comparison against
 *  {@link ALLOWED_WRITER_SITES} needs: a second write inside an allowed symbol
 *  raises that symbol's count rather than disappearing into it. */
function countsOf(found: Occurrence[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const { key } of found) tally[key] = (tally[key] ?? 0) + 1;
  return tally;
}

function sitesOf(found: Occurrence[]): string {
  return found.map((o) => o.site).join('\n');
}

/** The migration files, as scanned sources keyed by filename, with `--`
 *  comments stripped so prose about the column is not read as SQL. */
function migrationSources(root: string): ScannedSource[] {
  return readdirSync(root)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({
      rel: name,
      lines: readFileSync(path.join(root, name), 'utf8')
        .split('\n')
        .map((line) => line.replace(/--.*$/, '')),
    }));
}

const sources = sourcesUnder(path.resolve(__dirname, '..', '..', 'src'));
const migrations = migrationSources(path.resolve(__dirname, '..', '..', 'migrations'));

describe('accounts.updated_at is written by the two signup finalizes and nothing else', () => {
  it('walks a plausible number of sources and migrations (guards against a broken walker)', () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.map((s) => s.rel)).toContain('routes/signup-verify.ts');
    expect(migrations.length).toBeGreaterThan(10);
    expect(migrations.map((m) => m.rel)).toContain(
      Object.keys(ALLOWED_WRITER_MIGRATIONS)[0].split('#')[0],
    );
  });

  it('every updated_at assignment resolves to the table it writes', () => {
    const unresolved = [
      ...(columnAssignments(sources).get(UNRESOLVED_TABLE) ?? []),
      ...(columnAssignments(migrations).get(UNRESOLVED_TABLE) ?? []),
    ];
    expect(
      unresolved.map((o) => o.site),
      'an updated_at assignment with no statement head above it cannot be told apart from ' +
        'an accounts write, so it fails here rather than passing as some other table. ' +
        `Give the statement a readable head or scan it another way. Why this matters: ${ORDERING_RATIONALE}\n` +
        `${sitesOf(unresolved)}`,
    ).toEqual([]);
  });

  it('the accounts writers found column-first are exactly the two signup finalizes', () => {
    const writers = columnAssignments(sources).get('accounts') ?? [];
    expect(
      countsOf(writers),
      `a statement writing accounts.updated_at outside the two signup finalizes, or a ` +
        `second one inside a handler already licensed for one. Why the set is closed: ` +
        `${ORDERING_RATIONALE}\n${sitesOf(writers)}`,
    ).toEqual(ALLOWED_WRITER_SITES);
  });

  it('the accounts writers found table-first are the same two', () => {
    const writers = accountsColumnWriters(sources);
    expect(
      countsOf(writers),
      `an accounts statement writing updated_at outside the two signup finalizes. This scan ` +
        `reads the statement from its table, so it also sees an INSERT that writes the column ` +
        `by naming it. Why the set is closed: ${ORDERING_RATIONALE}\n${sitesOf(writers)}`,
    ).toEqual(ALLOWED_WRITER_SITES);
  });

  it('only the column-introducing migration writes accounts.updated_at', () => {
    const writers = columnAssignments(migrations).get('accounts') ?? [];
    expect(
      countsOf(writers),
      `a migration writing accounts.updated_at. A back-fill that bumps the marker puts every ` +
        `row it touches inside the recovery window for the length of that window after deploy. ` +
        `Why that matters: ${ORDERING_RATIONALE}\n${sitesOf(writers)}`,
    ).toEqual(ALLOWED_WRITER_MIGRATIONS);
  });

  it('no migration installs a trigger, rule or stored routine', () => {
    const found: string[] = [];
    for (const { rel, lines } of migrations) {
      lines.forEach((line, i) => {
        if (ROUTINE_CREATION_RE.test(line)) found.push(`${rel}:${i + 1} — ${line.trim()}`);
      });
    }
    expect(
      found.filter((site) => !ROUTINES_THAT_CANNOT_REACH_ACCOUNTS.some((r) => site.includes(r))),
      'a trigger, rule or stored routine is a writer no scan of application source can see, ' +
        'and one that touches `accounts` would bump updated_at on every row it fires for. This ' +
        'arm refuses all of them rather than parsing each target table and each routine body: ' +
        'if yours demonstrably cannot write the column, record that judgement in the exemption ' +
        `list. Why it matters: ${ORDERING_RATIONALE}\n${found.join('\n')}`,
    ).toEqual([]);
  });

  it('no accounts write statement is assembled by interpolation', () => {
    const interpolated: string[] = [];
    for (const { rel, lines } of sources) {
      lines.forEach((line, i) => {
        const match = line.match(ACCOUNTS_STATEMENT_RE);
        if (match === null || isCommentLine(line)) return;
        const statement = sqlStatementAt(lines, i, match.index ?? 0);
        if (!SQL_INTERPOLATION_RE.test(statement)) return;
        interpolated.push(`${rel}:${i + 1} (${enclosingSymbol(lines, i)}) — ${line.trim()}`);
      });
    }
    expect(
      interpolated,
      'an accounts write whose text is partly held in a variable is unreadable to both writer ' +
        'scans at once: the column-first walk attributes the fragment to whatever table sits ' +
        'above its declaration, so the fail-closed arm stays quiet, and the table-first read ' +
        'sees a placeholder where the SET list should be. Spell the statement out, or bind the ' +
        `value as a parameter. Why it matters: ${ORDERING_RATIONALE}\n${interpolated.join('\n')}`,
    ).toEqual([]);
  });

  it('the patterns fire on the shapes that would break the ordering and spare the current ones', () => {
    // Assignments, in the spellings a third writer would arrive as.
    expect(COLUMN_ASSIGNMENT_RE.test('             signup_binding_hash = NULL, updated_at = NOW()')).toBe(true);
    expect(COLUMN_ASSIGNMENT_RE.test('SET last_digest_block = $2, updated_at = now()')).toBe(true);
    expect(COLUMN_ASSIGNMENT_RE.test('    updated_at=NOW(),')).toBe(true);
    expect(COLUMN_ASSIGNMENT_RE.test('         updated_at = EXCLUDED.updated_at,')).toBe(true);
    // Reads and TypeScript, which write no column.
    expect(COLUMN_ASSIGNMENT_RE.test("           AND upgraded_at <= updated_at")).toBe(false);
    expect(COLUMN_ASSIGNMENT_RE.test('  updated_at: Date;')).toBe(false);
    expect(COLUMN_ASSIGNMENT_RE.test('    updated_at: row.updated_at as Date,')).toBe(false);
    expect(COLUMN_ASSIGNMENT_RE.test('  if (row.updated_at == other) return;')).toBe(false);
    expect(COLUMN_ASSIGNMENT_RE.test('  row.updated_at = stamp;')).toBe(false);

    // Table attribution, including the two shapes that would otherwise name no
    // table or the wrong one.
    const upsert = [
      '`INSERT INTO notification_preferences (username, updated_at)',
      ' VALUES ($1, now())',
      ' ON CONFLICT (username) DO UPDATE SET',
      '   updated_at = now()`,',
    ];
    expect(targetTable(upsert, 3)).toBe('notification_preferences');
    const skipLocked = [
      '`WITH due AS (SELECT id FROM q FOR UPDATE SKIP LOCKED)',
      ' UPDATE bridge_import_queue b',
      '    SET updated_at = NOW()`,',
    ];
    expect(targetTable(skipLocked, 2)).toBe('bridge_import_queue');
    expect(targetTable(['`SELECT id FROM q FOR  UPDATE SKIP LOCKED', ' UPDATE accounts', ' SET updated_at = NOW()`,'], 2)).toBe('accounts');
    expect(targetTable(['`UPDATE public.accounts', ' SET updated_at = NOW()`,'], 1)).toBe('accounts');
    expect(targetTable(['`UPDATE hafsql.accounts', ' SET updated_at = NOW()`,'], 1)).toBe('hafsql.accounts');
    expect(ACCOUNTS_STATEMENT_RE.test('  `UPDATE hafsql.accounts SET updated_at = NOW()`,')).toBe(false);
    expect(targetTable(['await pool.query(', '  {}', '  updated_at = NOW()'], 2)).toBe(UNRESOLVED_TABLE);

    // The literal reach: a quote inside a backticked SET list does not end it,
    // and a single-quoted one-liner ends at its own quote.
    const finalize = [
      "        `UPDATE accounts",
      "         SET username = $1, custody = 'light', verify_token = NULL,",
      "             signup_binding_hash = NULL, updated_at = NOW()",
      "         WHERE id = $6`,",
      "        [normalizedUsername],",
    ];
    expect(writesColumn(sqlStatementAt(finalize, 0, 9))).toBe(true);
    const oneLiner = ["      'UPDATE accounts SET password_hash = $1 WHERE id = $2',", '      [hash, id],'];
    expect(writesColumn(sqlStatementAt(oneLiner, 0, 7))).toBe(false);
    // The predicate a back-fill writes is not a write; an assignment behind a
    // subquery's own WHERE still is; the column named in an INSERT list is one
    // with no assignment anywhere in the statement.
    expect(writesColumn('UPDATE accounts SET custody = $1 WHERE updated_at IS NULL')).toBe(false);
    expect(
      writesColumn(
        'UPDATE accounts SET orcid = (SELECT o FROM b WHERE u = $1), updated_at = NOW() WHERE id = $2',
      ),
    ).toBe(true);
    expect(writesColumn('INSERT INTO accounts (email, updated_at) VALUES ($1, now())')).toBe(true);
    expect(writesColumn('INSERT INTO accounts (email, verify_token) VALUES ($1, $2)')).toBe(false);

    // Statement heads, including the lowercase prose that must not be able to
    // hide a real writer behind a case convention.
    expect(ACCOUNTS_STATEMENT_RE.test('      `UPDATE accounts')).toBe(true);
    expect(ACCOUNTS_STATEMENT_RE.test('  `insert into public.accounts (email)')).toBe(true);
    expect(ACCOUNTS_STATEMENT_RE.test('  `SELECT id FROM accounts WHERE username = $1`,')).toBe(false);

    // Triggers, rules and routines, in the spellings PostgreSQL accepts. A
    // routine counts because a trigger function is written before the trigger
    // that installs it, and its body is a write path no call site spells.
    expect(ROUTINE_CREATION_RE.test('CREATE TRIGGER accounts_touch BEFORE UPDATE ON accounts')).toBe(true);
    expect(ROUTINE_CREATION_RE.test('CREATE OR REPLACE RULE r AS ON UPDATE TO accounts')).toBe(true);
    expect(ROUTINE_CREATION_RE.test('CREATE CONSTRAINT TRIGGER t AFTER INSERT ON accounts')).toBe(true);
    expect(ROUTINE_CREATION_RE.test('CREATE OR REPLACE FUNCTION touch_accounts() RETURNS trigger')).toBe(true);
    expect(ROUTINE_CREATION_RE.test('CREATE PROCEDURE sweep() LANGUAGE plpgsql AS $$')).toBe(true);
    expect(ROUTINE_CREATION_RE.test('CREATE TABLE IF NOT EXISTS accounts (')).toBe(false);
    expect(ROUTINE_CREATION_RE.test('CREATE INDEX IF NOT EXISTS accounts_orcid_key ON accounts')).toBe(false);

    // The row-assignment SET form, where the column is followed by a comma or
    // a paren and the `=` belongs to the target list.
    expect(assignsColumn('SET (custody, updated_at) = ($2, NOW())')).toBe(true);
    expect(assignsColumn('       SET (pending_email, updated_at)')).toBe(false);
    expect(assignsColumn('SET (custody, upgraded_at) = ($2, NOW())')).toBe(false);
    expect(writesColumn('UPDATE accounts SET (pending_email, updated_at) = (NULL, NOW()) WHERE id = $1')).toBe(true);

    // An INSERT that names the column behind a table alias, the spelling an
    // upsert reaches for once its conflict clause reads the pre-existing row.
    expect(writesColumn('INSERT INTO accounts AS a (email, updated_at) VALUES ($1, NOW())')).toBe(true);
    expect(writesColumn('INSERT INTO accounts AS a (email, verify_token) VALUES ($1, $2)')).toBe(false);

    // A TypeScript local carrying the column's name writes no column; the same
    // text inside a SET list does.
    expect(assignsColumn('  const updated_at = row.updated_at;')).toBe(false);
    expect(assignsColumn('             signup_binding_hash = NULL, updated_at = NOW()')).toBe(true);

    // Interpolation inside an accounts write, the one shape that hides from
    // both writer scans at once.
    expect(SQL_INTERPOLATION_RE.test('SET updated_at = NOW() ${recencyFragment}')).toBe(true);
    expect(SQL_INTERPOLATION_RE.test('SET verify_token = $1, expires_at = $2')).toBe(false);
  });
});
