/**
 * Standing source-discipline canary: `accounts.updated_at` is written by
 * exactly two statements, the `/confirm` finalize and the `/link` finalize in
 * `routes/signup-verify.ts`, and by nothing else in the application or its
 * migrations.
 *
 * WHAT THE CLOSED SET BUYS. `updated_at` is the one recency marker both
 * stuck-recovery lookups in that file measure against, and each of them admits
 * a row PAST the signup session-binding check: the row was bound by the prior
 * finalize, and a per-request ownership proof stands in for the binding. The
 * `/confirm` lookup admits a light row while `updated_at > NOW() - INTERVAL`
 * holds, its only staleness bound, and its resume path mints a light-custody
 * session on a posting-key proof. The `/link` lookup
 * admits a self-custody row on the same recency bound plus an ordering between
 * the row's two epochs, `upgraded_at <= updated_at`, which is what keeps an
 * account that has upgraded out of a window its own `/confirm` finalize opened.
 *
 * Both terms hold for the same reason: only the two finalizes stamp the marker.
 * A finalized row therefore leaves the recovery window once and never re-enters
 * it, and the custody upgrade, which stamps `upgraded_at` and deliberately
 * leaves `updated_at` alone, leaves an upgraded row with an epoch strictly
 * NEWER than its marker. Add a third writer anywhere — a settings touch, a
 * profile write, an admin tool, a trigger — and every finalized light row it
 * touches is back inside the `/confirm` window for the length of the window,
 * while an upgraded row it touches also has its marker moved past its epoch,
 * so the `/link` comparison starts passing. Either way the outcome is a
 * binding-free session mint. The safety question for a new writer is therefore
 * not what its WHERE clause says (a writer scoped to `custody = 'light'`
 * reopens the `/confirm` window just the same) but whether it can EVER bump the
 * marker on a finalized row, light or upgraded.
 *
 * A third reader depends on the same closed set without a security stake, and
 * is listed here so a red bar accounts for it: `collectCompleted` in
 * `jobs/registration-watch.ts` advances an announce cursor over the column, and
 * a writer that bumped the marker on a long-finalized row would put that
 * account back in front of the operator. Its `seen:accounts` set absorbs the
 * repeat, so the cost there is bookkeeping rather than a bypass — but it is the
 * second place in the tree whose correctness argument names this column, and a
 * new writer has to be weighed against both.
 *
 * WHERE THE THIRD WRITER MOST PLAUSIBLY COMES FROM, so the next author reading
 * a red bar recognises their own edit: the signup upserts in `routes/auth.ts`
 * refresh `created_at` in their `ON CONFLICT ... DO UPDATE` branches and leave
 * `updated_at` alone, which reads like an oversight to be tidied up. It is not,
 * and the reason is NOT the duplicate-email pre-check in `POST /signup`. That
 * check answers 409 for exactly two token shapes, NULL and a `confirmed:`
 * prefix, so every row carrying a random hex token falls through to the
 * `DO UPDATE` branch: state E, which is the branch's intended target, and state
 * G, which is not — a self-custody account that acquired a row by registering
 * an email through settings, username set and `custody` NULL, carrying a hex
 * token while that email is unverified (ARCHITECTURE.md section 6.1).
 *
 * Two things make that overwrite inert for this invariant. The branch's own
 * column list does not name the marker, so it is not moved. And the branch
 * WRITES a non-NULL `verify_token`, while both recovery lookups require
 * `verify_token IS NULL` — so a row the branch has touched is invisible to both
 * until some later statement clears the token, and the only statements that do
 * are the two finalizes, which are licensed to stamp the marker at that moment.
 * That barrier is structural: it holds for whatever the fall-through set turns
 * out to be, where the `custody` filters on the two lookups hold only while the
 * section 6.1 enumeration does. Leaving `updated_at` out of the branch is the
 * defence in depth behind both, and symmetrising the branch to touch every
 * column is the shape this canary exists to stop. That the upsert can overwrite
 * a finalized state G row at all is a separate defect in `POST /signup`,
 * tracked on its own; it is not what this scan guards.
 *
 * WHY A SOURCE SCAN. A CHECK of the same family as the custody-alignment
 * constraint, `upgraded_at IS NULL OR upgraded_at >= updated_at`, would pin the
 * `/link` ordering at commit for every state ARCHITECTURE.md section 6.1
 * enumerates, and it is proposed alongside this canary, not replaced by it. It
 * cannot express the `/confirm` bound: the schema sees a marker being stamped,
 * not which statement stamped it, and a finalize and a settings touch are the
 * same UPDATE to a constraint. That half of the invariant is a claim about the
 * source, and only a scan of the source can hold it. Nor does any behavioural
 * test go red, because reaching either bypass needs a row in the narrow
 * post-finalize state plus a valid ownership proof: a third writer changes
 * nothing observable at the wire until someone exercises a recovery path
 * against a finalized account, which is the incident, not the test.
 *
 * EVERY SCAN READS THE SAME BLANKED TEXT. Before any pattern runs, each line
 * has its comment spans replaced by spaces of equal length. The reason is that
 * every pattern here needs two tokens adjacent — a column and its `=`, a
 * target list's `)` and its `=`, a column list's parentheses, a keyword and
 * its table — and SQL admits a comment wherever it admits whitespace. One
 * comment dropped in one of those gaps silences the pattern that spans it, and
 * because the four scans share those patterns, it silences them together:
 * the two writer walks and the fail-closed arm all go quiet at once, which is
 * the failure this file exists to prevent. Blanking closes that class rather
 * than one shape of it. Values are not blanked, so a `--` inside a string, a
 * URL, or a semicolon in an error message stays part of the statement — but a
 * routine or `DO $$` body is source rather than data, so its comments are
 * blanked like any other and a comment planted in a token gap inside one reds.
 *
 * Because the reader is the single point every scan passes through, its own
 * end state is asserted: a file left mid-comment, mid-template or mid-quoted
 * span is a file whose remaining lines were copied with blanking OFF, and that
 * is the one defect class which silences the whole guard at once instead of one
 * arm of it. The two shapes that produced it are refused at the opener — a
 * block comment with no closer, and a dollar-quote tag that is not a
 * PostgreSQL tag or never recurs — and the end-state assertion is what catches
 * the next one.
 *
 * FOUR SCANS OVER `src`, two of them deriving the same writer set from
 * opposite ends so a misattribution in either walk is a red bar rather than a
 * silent pass.
 *
 *   1. COLUMN-FIRST. Every `updated_at` assignment in the tree, attributed to
 *      the table it writes by walking up to the nearest statement head
 *      (`UPDATE <table>`, `INSERT INTO <table>`, `MERGE INTO <table>`) and
 *      reading that statement forward to its terminator. The head counts only
 *      if the statement it opens reaches the assignment's line; a head whose
 *      statement closed earlier belongs to some other query, and the
 *      assignment resolves to {@link UNRESOLVED_TABLE} rather than to a table
 *      that merely sits above it. Those resolving to `accounts` must be
 *      exactly the two finalizes, TALLIED per `file#symbol`. A key set alone
 *      would let an allowed key absorb a second write, and both allowed keys
 *      are route handlers running a couple of hundred lines each, so the
 *      count is what makes a write added beside a licensed one a new member.
 *
 *   2. RESOLUTION IS FAIL-CLOSED, UNCONDITIONALLY. No assignment may resolve
 *      to {@link UNRESOLVED_TABLE}, and the label does not depend on what else
 *      sits in the file: a head the patterns cannot read (a quoted identifier,
 *      a table name held in a variable, a fragment joined onto a statement
 *      that closed on an earlier line) is not attributed to whichever query
 *      happens to precede it, even though route handlers chain their queries
 *      a few lines apart and that misattribution would be the common
 *      placement. Without this, a shape the upward walk cannot read passes as
 *      "not accounts", which is the silent direction. With it, an
 *      unattributable write is a red bar naming its line.
 *
 *   3. TABLE-FIRST. Every `UPDATE accounts` / `INSERT INTO accounts` /
 *      `MERGE INTO accounts` statement, read whole to its terminator, flagged
 *      when its SET list, INSERT column list, or MERGE insert list carries the
 *      column. This is not a redundant spelling of the first scan: an
 *      `INSERT INTO accounts (..., updated_at)` writes the column with no
 *      assignment anywhere in the statement, so the column-first pattern
 *      cannot see it at all, and anchoring on the table also survives a
 *      misattribution by the upward walk.
 *
 *   4. NO ASSEMBLED `accounts` WRITE. A statement partly held in a variable
 *      defeats the table-first read, which finds a placeholder where the SET
 *      list should be, so the shape is refused where the join is spelled on
 *      the statement's own lines: a `${...}` interpolation anywhere in it, or
 *      a `+` beside its opening or closing quote. The fragment carrying the
 *      assignment is caught separately by the fail-closed arm, because no
 *      readable head's statement reaches a constant declared on its own.
 *      Read-side interpolation is untouched; the recovery lookups themselves
 *      interpolate their window and are SELECTs.
 *
 * AND A COLUMN CAN BE REWRITTEN WITH NO STATEMENT THAT WRITES A ROW. An
 * `ALTER COLUMN updated_at TYPE ... USING <expr>` recomputes every value in
 * the table from an expression, a drop and re-add replaces the column, and a
 * rename moves another column onto the name. Each lands every row at whatever
 * the new value is, which is the outcome the writer scans exist to refuse, and
 * none of them is an UPDATE, an INSERT or a MERGE. The `ALTER TABLE accounts`
 * statements that name the column are pinned to the migration that introduces
 * it for that reason.
 *
 * AND OVER `migrations`, because the route comment's universal has a second
 * half — the table carries no trigger — and a trigger is precisely the third
 * writer no scan of application source can see. The column-first and
 * table-first scans both run over the migration files too, so a back-fill
 * that bumps the marker is caught in either spelling. The migration-side
 * writer set is pinned to the column's introduction, which back-fills it to a
 * definitively-past value; the custody-alignment migration's own header
 * records that it deliberately does NOT bump the marker, since that would put
 * every repaired row inside the recovery window for the length of the window
 * after deploy, and a future back-fill that forgets is the same hazard as a
 * third route writer. Triggers, rules and stored routines are refused as a
 * class: a trigger function is written before the trigger that installs it, a
 * rule rewrites a statement into one the source does not show, and a routine
 * body is a write path its call site does not spell. A trigger or rule bound
 * to `accounts` is refused outright, with no exemption. Any other routine is
 * refused unless its exact `file#KIND name` is recorded as judged, so a
 * judgement made once about one function cannot carry to a later function of
 * the same name in another file. That refusal is what a trigger body needs: a
 * PL/pgSQL `NEW.updated_at := now()` is not an assignment the column pattern
 * reads (the property-access lookbehind drops it, as it drops a TypeScript
 * field write), so the routine arm is the ONLY catcher of that shape, and a
 * self-test pins the non-match so the dependency stays recorded. The
 * fail-closed resolution arm spans both trees, because an unattributable
 * write matters more in a migration, not less.
 *
 * KNOWN LIMITS, stated here rather than discovered later:
 *
 *   - Detection is TEXTUAL: the comment blanking in {@link blankLine}, the
 *     statement read in {@link statementAt}, and the symbol attribution in
 *     `tests/support/enclosing-symbol.ts`. A dynamically NAMED target —
 *     `UPDATE ${table}`, an `EXECUTE format('UPDATE %I SET updated_at =
 *     now()', 'accounts')` in a migration — hides from the table-first scan,
 *     because there is no literal `accounts` to anchor on.
 *     The assignment it carries reds under the fail-closed arm instead, since
 *     no readable head reaches it, and that backstop is what the limit rests
 *     on. It holds only while the COLUMN is spelled: make both identifiers
 *     dynamic (a second `%I`, a `quote_ident` concatenation) and there is no
 *     `updated_at =` token either, so nothing fires at all. The same is true
 *     of a join spelled away from the statement's own lines (a fragment pushed
 *     into an array and joined later, a template built by a helper): the
 *     assembled-write scan cannot see the join, and only a fragment that
 *     spells the assignment reds by resolution. What makes a text scan sound
 *     today is that no write in either tree names its table, or assembles its
 *     text, that way — and that a migration doing so would have to reach for
 *     dynamic SQL to write one static column, which is a shape worth a second
 *     look on its own.
 *   - Shapes that are not house style and are not read: a quoted identifier
 *     (`UPDATE "accounts"`), an upper-case `UPDATED_AT`, a positional
 *     `INSERT INTO accounts VALUES (...)` with no column list, an
 *     auto-updatable view over the table, a keyword and its table split across
 *     lines. A quoted identifier hides an INSERT that names the column, since
 *     that shape carries no assignment token; the SET-list form of the same
 *     shape is not hidden, because its assignment reds by resolution instead. The reverse error is the tolerable one and is not chased:
 *     a line inside a block comment that carries no leading `*`, or an odd
 *     quote in a line of prose, is read as live SQL and can only cost a red
 *     bar on a statement that was never live.
 *   - The column carries a `DEFAULT now()`, so every INSERT stamps it without
 *     naming it. That is not a hazard and is not scanned for: both bounds
 *     protect an ALREADY-finalized row, and a row being inserted is neither
 *     finalized nor upgraded yet.
 *   - Text that only LOOKS like a comment or a value to the reader, where the
 *     shape is not one this tree writes: a block-comment opener inside a
 *     regex character class that finds a real closer further down, a
 *     backslash escape inside an
 *     `E'...'` string, a `--` glued on both sides in TypeScript code outside a
 *     template. Each blanks a span that was live, so each is a silent miss
 *     rather than a red bar, which is why the reader errs toward reading
 *     wherever it can: an unclosed comment opener is text, a value keeps its
 *     markers, and a decrement is an operator.
 *   - A string VALUE that spans lines is read as code from its second line
 *     on, because the value state resets at each line while the block,
 *     template and dollar states do not. The reset is what keeps one
 *     unbalanced quote in prose from blanking the rest of a file, and no
 *     value in either tree spans lines. Where that shape appears, a comment
 *     marker on the continuation line blanks live SQL, so the residual is a
 *     silent one and is named here rather than left to be found.
 *   - The two judgements the reader makes at a dollar-quote opener have their
 *     own residuals. Whether the span is a body or a value is decided from the
 *     keyword before it, and when the opener leads its line (`... AS` on one
 *     line, `$$` on the next) the previous non-blank line is read RAW, so a
 *     comment ending in one of those keywords could answer for it; neither tree
 *     spells a body that way. And a nested value inside a body — a `format()`
 *     literal in its own tag — is read as more body, so a comment marker in
 *     that value is blanked. Both err toward blanking inside a routine, which
 *     is where a comment gap is a silent pass rather than a red bar.
 *   - The scans read the shapes an author writes by accident, not the ones an
 *     author writes to evade a test. A writer determined to get past them can.
 *
 * A NOTE ON REUSE. `sourcesUnder` and `enclosingSymbol` come from the shared
 * support module. The reading does not. The joined-statement helper in the
 * custody-claim canary is tuned for TypeScript expressions and caps its join
 * at four lines, and the `/confirm` finalize puts five SET lines between
 * `UPDATE accounts` and its `updated_at` assignment, so that helper
 * structurally cannot reach the shape this canary exists to see; the reach
 * here is delimited by what an SQL statement actually ends at instead, its own
 * string quote in TypeScript and its semicolon in a migration, with string
 * state carried across lines so a semicolon inside a value ends nothing. The
 * comment handling is local for a related reason: the shared shape-only
 * predicate answers about a whole LINE, which both skips a head tagged for an
 * editor (`/* sql *\/ \`UPDATE accounts`) and, more seriously, would skip a
 * live statement because something earlier on its line looked like a comment
 * marker. Dropping a whole line because something on it looked like a comment
 * marker is what made that possible; blanking the comment SPAN and leaving the
 * rest of the line to be read is what closes it.
 *
 * Planted positives and negatives in the pattern specs keep every pattern
 * honest, and each is planted where the feature it cites is the only thing
 * answering it: without that, an edit that mangles one leaves its scan
 * matching nothing and the canary enforces nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  enclosingSymbol,
  MODULE_SCOPE,
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
 *  count, is a decision about the recovery bounds, not a bookkeeping update. */
const ALLOWED_WRITER_SITES: Record<string, number> = {
  'routes/signup-verify.ts#POST /confirm': 1,
  'routes/signup-verify.ts#POST /link': 1,
};

/** The one migration licensed to write the column: the one that introduces it
 *  and back-fills existing rows to a definitively-past value. */
const ALLOWED_WRITER_MIGRATIONS: Record<string, number> = {
  [`016_accounts_updated_at.sql#${MODULE_SCOPE}`]: 1,
};

/** The migration statements licensed to ALTER the column: the ones that
 *  introduce it. Each is a separate statement, so the count is what a second
 *  ALTER in the same file has to raise. */
const ALLOWED_COLUMN_ALTERATIONS: Record<string, number> = {
  [`016_accounts_updated_at.sql#${MODULE_SCOPE}`]: 3,
};

/** Stored routines whose bodies were judged, by hand, unable to write
 *  `accounts.updated_at`. Empty, and the app database defines none at all,
 *  which is what lets the routine arm refuse every one of them rather than
 *  parse each body. Adding one anywhere is a red bar asking for that judgement
 *  to be made once, and recorded here, rather than assumed.
 *
 *  Entries are the EXACT `file#KIND name` key the arm reports, compared by
 *  equality, so a judgement covers one routine in one migration: a later
 *  `CREATE OR REPLACE FUNCTION` of the same name in another file is a new
 *  body and a new red bar. A trigger or rule bound to `accounts` cannot be
 *  listed here at all; it is refused before this list is consulted. */
const ROUTINES_THAT_CANNOT_REACH_ACCOUNTS: string[] = [];

/** Why the set is closed, carried into every failure message so whoever trips
 *  the bar can tell whether their new writer is safe rather than reaching for
 *  the assertion. A message that says only "unexpected site" sends the next
 *  author to delete it. */
const ORDERING_RATIONALE =
  'accounts.updated_at is the one recency marker both stuck-recovery lookups in ' +
  'routes/signup-verify.ts measure against, and each admits a row past the signup ' +
  'session-binding check. The /confirm lookup admits a light row while ' +
  '`updated_at > NOW() - INTERVAL` holds, and its resume path mints a light-custody ' +
  'session on a posting-key proof alone; the /link lookup admits a self-custody row on ' +
  'the same bound plus the ordering `upgraded_at <= updated_at`. Only the two signup ' +
  'finalizes stamp the marker, so a finalized row leaves the window once and never ' +
  're-enters it, and an upgrade stamps `upgraded_at` without touching `updated_at`, so ' +
  'an upgraded account fails the ordering. A third writer puts every finalized light row ' +
  'it touches back inside the /confirm window, and on an upgraded row it also moves the ' +
  'marker past the upgrade epoch; either hands that account a binding-free session mint. ' +
  "The test for a new writer is not its WHERE clause (one scoped to custody = 'light' " +
  'reopens the /confirm window just the same) but whether it can ever bump the marker on ' +
  'a finalized row, light or upgraded. If it genuinely cannot, say why here and add it to ' +
  'the list; do not widen the list to make a bar go green.';

/** An assignment to the column: the SET-list shape, in any SQL spelling of the
 *  right-hand side. The lookbehind drops a property access (`row.updated_at =`,
 *  which is a TypeScript assignment and writes no database column, and
 *  `NEW.updated_at :=`, the PL/pgSQL trigger-body write the routine arm alone
 *  catches) along with a longer column name that merely ends in the same
 *  characters. The negative lookahead drops a comparison (`updated_at ==`).
 *  A SQL equality read (`WHERE updated_at = $1`) would match and is a red bar
 *  on a statement that writes nothing — the safe direction for a refusal, and
 *  no such read exists in the tree. */
const COLUMN_ASSIGNMENT_RE = /(?<![.\w])updated_at"?\s*=(?!=)/;

/** The same write in PostgreSQL's ROW-ASSIGNMENT form, `(a, b) = (x, y)`,
 *  where the column sits in a parenthesised target list and the `=` belongs to
 *  the list rather than to the column. Valid SQL, one keystroke from the
 *  ordinary form, and invisible to a pattern that expects the column and the
 *  `=` to be adjacent.
 *
 *  Anchored on the target list itself rather than on the `SET` keyword,
 *  because a row assignment is one set_clause among several and PostgreSQL
 *  lets it sit anywhere in the list: in `SET custody = $1, (email, updated_at)
 *  = ($2, NOW())` nothing but a comma precedes it, so a pattern demanding
 *  `SET` immediately before the paren reads the statement as writing no
 *  column at all. Every parenthesised group on the line is examined, not just
 *  the first, since the one carrying the column may follow one that does not.
 *  The `>` in the lookahead keeps a TypeScript arrow function's parameter list
 *  out, and the second `=` keeps an equality comparison out. */
const ROW_TARGET_LIST_RE = /\(([^()]*)\)\s*=(?![=>])/;

/** A TypeScript local carrying the column's name, which writes no column. The
 *  tree spells row fields in snake_case, so `const updated_at = ...` is a
 *  shape someone writes without meaning anything by it. Excluded by
 *  declaration keyword rather than by name, so an assignment inside a SQL
 *  string is untouched. */
const TYPESCRIPT_LOCAL_RE = /\b(?:const|let|var)\s+updated_at\s*[:=]/;

/** How far BACK {@link assignmentIndex} looks for a declaration keyword when
 *  deciding whether a match is a TypeScript local: far enough to hold the
 *  longest keyword and the whitespace after it, and no farther. The bound
 *  exists so the exclusion applies to the match it precedes rather than to the
 *  whole text, and it is two-sided — widened, it starts dropping real writes
 *  that merely follow the characters of a declaration inside a value.
 *
 *  There is deliberately no matching FORWARD bound. The pattern's own `\s*`
 *  before the `:` or `=` admits any run of whitespace, so any fixed number is
 *  either arbitrary or wrong, and reading forward to the end of the text costs
 *  nothing: a match there still requires the keyword to sit within the bound
 *  above it. */
const LOCAL_DECLARATION_BEFORE = 12;

/** Where `text` FIRST writes the column, in either spelling, or -1. The
 *  position is what lets {@link targetTable} ask which statement encloses the
 *  assignment rather than which one merely shares its line.
 *
 *  Both spellings are collected and the EARLIER returned, rather than the
 *  plain form short-circuiting the row form. A line may carry one of each —
 *  `SET (email, updated_at) = ($1, NOW()), custody = $2, updated_at = NOW()` is
 *  ordinary PostgreSQL — and returning the plain match first hands
 *  {@link assignmentIndexes} a position PAST the row assignment, which then
 *  resumes its walk beyond it and never counts it. The line would report one
 *  write where it holds two, so a second write added beside a licensed one
 *  disappears into the count that exists to catch it. */
function assignmentIndex(text: string): number {
  let earliest = -1;
  const note = (at: number): void => {
    if (earliest === -1 || at < earliest) earliest = at;
  };
  for (const match of text.matchAll(new RegExp(COLUMN_ASSIGNMENT_RE.source, 'g'))) {
    const at = match.index ?? 0;
    // The local-declaration exclusion is scoped to the match that it precedes.
    // Applied to the whole text it is a veto: the characters `const updated_at
    // =` appearing anywhere — in a value, in prose the blanking left alone —
    // would switch detection off for an entire line or statement, which is a
    // silent pass and the one direction this file cannot afford.
    if (TYPESCRIPT_LOCAL_RE.test(text.slice(Math.max(0, at - LOCAL_DECLARATION_BEFORE)))) continue;
    note(at);
    break;
  }
  for (const targets of text.matchAll(new RegExp(ROW_TARGET_LIST_RE.source, 'g'))) {
    const column = targets[1].search(/\bupdated_at\b/);
    if (column !== -1) {
      note((targets.index ?? 0) + 1 + column);
      break;
    }
  }
  return earliest;
}

/** Whether `text` writes the column, in either spelling. */
function assignsColumn(text: string): boolean {
  return assignmentIndex(text) !== -1;
}

/** Every position on `text` that writes the column. The scans tally writes,
 *  not lines, so a line carrying two of them contributes two occurrences. */
function assignmentIndexes(text: string): number[] {
  const found: number[] = [];
  for (let from = 0; from < text.length; ) {
    const at = assignmentIndex(text.slice(from));
    if (at === -1) break;
    found.push(from + at);
    from += at + 1;
  }
  return found;
}

/** The table an `UPDATE` targets. PostgreSQL's two locking clauses that carry
 *  the keyword — `FOR UPDATE` and `FOR NO KEY UPDATE` — are excluded by the
 *  lookbehinds, and `ON CONFLICT ... DO UPDATE SET` (with MERGE's
 *  `WHEN MATCHED THEN UPDATE SET`) by the {@link NOT_A_TABLE} rejection, so
 *  those assignments resolve to the INSERT's or MERGE's table rather than to a
 *  table named `set`.
 *
 *  Both lookbehinds are needed, and the second is not a spelling variant of the
 *  first: the characters immediately before `UPDATE` in the weaker lock are
 *  `KEY `, which the `FOR ` lookbehind never sees, so that clause matches and
 *  names a table after whatever word follows it. */
const QUALIFIED_NAME = '[a-z_][a-z0-9_]*(?:\\s*\\.\\s*[a-z_][a-z0-9_]*)*';
const UPDATE_TARGET_RE = new RegExp(
  `(?<!\\bFOR\\s+)(?<!\\bFOR\\s+NO\\s+KEY\\s+)\\bUPDATE\\s+(?:ONLY\\s+)?\\(?\\s*(${QUALIFIED_NAME})`,
  'i',
);
const INSERT_TARGET_RE = new RegExp(`\\bINSERT\\s+INTO\\s+(${QUALIFIED_NAME})`, 'i');
/** MERGE is a writer shape on the PostgreSQL this runs against, with an
 *  UPDATE branch and an INSERT branch that name no table of their own. */
const MERGE_TARGET_RE = new RegExp(`\\bMERGE\\s+INTO\\s+(?:ONLY\\s+)?\\(?\\s*(${QUALIFIED_NAME})`, 'i');
const HEAD_PATTERNS = [UPDATE_TARGET_RE, INSERT_TARGET_RE, MERGE_TARGET_RE];
/** Words that follow `UPDATE` in a clause rather than naming a table. `set` is
 *  the upsert and MERGE branch; the rest are the tail of a locking clause whose
 *  own `FOR` sits far enough left that a lookbehind is not the place to reject
 *  it (`FOR UPDATE OF t`, `FOR UPDATE NOWAIT`, `FOR UPDATE SKIP LOCKED`). A
 *  head that resolves to a plausible OTHER table satisfies the fail-closed arm
 *  instead of tripping it, so a keyword read as a table name is the silent
 *  direction; rejecting it leaves the assignment unresolved, which is a red
 *  bar. */
const NOT_A_TABLE = new Set(['set', 'skip', 'nowait', 'of']);

/** An `accounts` statement, matched case-insensitively so a lowercase-keyword
 *  writer cannot slip past. Prose that happens to read like one is admitted
 *  too, which costs nothing: only statements whose text WRITES the column
 *  reach an assertion, and a sentence does not.
 *
 *  Schema qualification is admitted for `public` alone, which is what keeps the
 *  chain-side `hafsql.accounts` view out of the set. It carries the same bare
 *  name and a different meaning, it lives in the read-only database, and the
 *  recovery bounds these scans protect say nothing about it. */
const ACCOUNTS_STATEMENT_RE =
  /\b(?:UPDATE\s+(?:ONLY\s+)?|INSERT\s+INTO\s+|MERGE\s+INTO\s+(?:ONLY\s+)?|COPY\s+)\(?\s*(?:public\s*\.\s*)?accounts\b/i;

/** The column list of an `INSERT INTO accounts (...)`, which writes the column
 *  by naming it and carries no assignment for the column-first scan to find.
 *  The table alias is optional because `INSERT INTO accounts AS a (...)` is the
 *  idiomatic spelling once an `ON CONFLICT ... DO UPDATE` clause needs to read
 *  the pre-existing row, and this file already holds two such upserts. The
 *  negated class crosses newlines, so a column list laid out one per line is
 *  read whole. */
const ACCOUNTS_INSERT_COLUMNS_RE =
  /\bINSERT\s+INTO\s+(?:public\s*\.\s*)?accounts(?:\s+AS\s+"?[a-z_][a-z0-9_]*"?)?\s*\(([^)]*)\)/i;

/** The insert column list of a MERGE's `WHEN NOT MATCHED THEN INSERT (...)`
 *  branch, which names no table: the target is the MERGE's. */
const MERGE_INSERT_COLUMNS_RE = /\bTHEN\s+INSERT\s*\(([^)]*)\)/i;

/** The column list of a `COPY accounts (...) FROM`, which loads the named
 *  columns straight into the table with no assignment and no INSERT keyword
 *  for the other patterns to anchor on. */
const COPY_COLUMNS_RE = /\bCOPY\s+(?:public\s*\.\s*)?accounts\s*\(([^)]*)\)/i;

/** An `ALTER TABLE accounts` statement, and whether it touches the column.
 *
 *  A column can be rewritten without any statement that writes a row.
 *  `ALTER COLUMN updated_at TYPE ... USING <expr>` recomputes every value in
 *  the table from an expression; a drop and re-add replaces the column
 *  outright; a rename moves another column onto the name. Each lands every row
 *  at whatever the new value is, which is exactly what the writer scans exist
 *  to refuse, and none of them is an UPDATE, an INSERT or a MERGE. */
const ALTER_ACCOUNTS_RE = /\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\s*\.\s*)?accounts\b/i;

/** Trigger, rule and stored-routine creation, in every spelling PostgreSQL
 *  accepts, capturing the kind and the name so a site can be keyed exactly. A
 *  rule is in scope for the same reason a trigger is: it rewrites a statement
 *  into one the source does not show. A function or procedure is in scope
 *  because its body is a write path the call site does not spell, and because
 *  a trigger function is written before the trigger that installs it. A name
 *  the pattern cannot read (a quoted identifier) is reported as
 *  {@link UNNAMED_ROUTINE}, which no exemption can match. */
const ROUTINE_CREATION_RE =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?(?:EVENT\s+)?(TRIGGER|RULE|FUNCTION|PROCEDURE)\b(?:\s+([a-z_][a-z0-9_.]*))?/i;
const UNNAMED_ROUTINE = '<unnamed>';

/** The clause that binds a trigger (`... ON accounts`) or a rule
 *  (`AS ON <event> TO accounts`) to the table. Tested against the whole
 *  creation statement, so a target on its own line is still seen. */
const BOUND_TO_ACCOUNTS_RE = /\b(?:ON|TO)\s+(?:public\.)?accounts\b/i;

/** A template interpolation inside a SQL literal, and a string join on either
 *  side of one. Harmless in a read; refused inside an `accounts` write because
 *  each moves part of the statement out of the statement, leaving the
 *  table-first read a placeholder where the SET list should be. The join is
 *  recognised where it is spelled against the literal: a `+` closing the text
 *  before the opening quote, or opening the text after the closing quote (on
 *  that line, or leading the next). */
const SQL_INTERPOLATION_RE = /\$\{/;
const JOINED_BEFORE_RE = /\+\s*$/;
const JOINED_AFTER_RE = /^\s*\+/;

/** The label a write gets when no statement head above it reaches it. */
const UNRESOLVED_TABLE = '<unresolved>';

/** How far one statement is read downward from its head, so an unterminated
 *  quote cannot swallow the rest of a file. The upward walk from an assignment
 *  needs no cap of its own: it stops at the first head it meets, and that
 *  head's statement is read under this one. */
const LITERAL_CAP = 40;

/**
 * The reading layer every scan is built on: a file with each COMMENT span
 * replaced by spaces of the same length, and a statement read from a head to
 * its terminator.
 *
 * WHY BLANKING, RATHER THAN A "IS THIS POSITION COMMENTED" TEST. Every pattern
 * here needs two tokens to sit next to each other: a column and its `=`, a
 * target list's `)` and its `=`, a column list's parentheses, a keyword and
 * its table. A comment is legal SQL wherever whitespace is, so ANY comment
 * dropped between two of those tokens silences the pattern that spans them,
 * and the three writer scans share those patterns, so one comment silences
 * them together. Blanking closes that whole class at once and keeps every
 * reported position true to the source line.
 *
 * WHY IT MUST TRACK VALUES. A blank applied inside a string constant would
 * erase live SQL: a value carrying `--`, an address carrying `//`, a prose
 * semicolon in an error message. Quoted and dollar-quoted VALUES are therefore
 * copied through untouched, and their contents are still matched, since a value
 * is part of the statement even when nothing in it is a token.
 *
 * WHY A DOLLAR-QUOTED BODY IS NOT ONE OF THEM. `$$ ... $$` spells two different
 * things. After `AS` or `DO` it is the SOURCE of a routine or an anonymous
 * block — PL/pgSQL or SQL that PostgreSQL compiles, where `--` and block
 * comments are comments and a marker between two tokens silences a pattern
 * exactly as it does outside. Anywhere else it is a string constant whose
 * characters are data. Copying a body through verbatim reopens the whole
 * comment-gap class inside it, and both migrations that carry a `DO` block wrap
 * ordinary `accounts` DDL, so the distinction is made at the opener from the
 * keyword the span follows.
 *
 * WHY THE STATE IS CARRIED ACROSS LINES. A block comment spans lines, and a
 * line-local guess about which of its lines are comment is wrong in both
 * directions: a docblock continuation is not always marked, and a `*` at the
 * head of a line is just as likely to be an arithmetic continuation or the
 * close of a comment with live SQL after it. Either error is silent, since a
 * blanked line is a line no scan sees, so the block state is tracked from the
 * top of the file instead of inferred per line. A quoted value resets at each
 * line, because an unbalanced quote in prose would otherwise blank whatever
 * followed it for the rest of the file.
 *
 * WHY TWO DIALECTS. A statement lives inside a TypeScript literal here, so
 * both `--` and `/* *\/` from SQL and `//` and `/* *\/` from TypeScript are
 * comments. The two disagree about `--` glued to an identifier: SQL always
 * starts a comment, TypeScript may be decrementing. That exception applies
 * only where TypeScript can be running, which is code outside a template in a
 * `.ts` file; inside a template, and anywhere in a `.sql` file, `--` is a
 * comment however it is spelled.
 */
interface BlankState {
  /** Inside a block comment, which spans lines. */
  block: boolean;
  /** Inside a backtick template, which spans lines and holds SQL. */
  template: boolean;
  /** The dollar-quote tag currently open, which spans lines, or null. */
  dollar: string | null;
  /** Whether that span is a routine or `DO` BODY rather than a string value.
   *  A body is PL/pgSQL or SQL source, where a comment is a comment and has to
   *  be blanked like any other; a value is data, where a comment marker is one
   *  of its characters. */
  dollarCode: boolean;
  /** The tag of a dollar-quoted VALUE nested inside that body, or null. A body
   *  is source, so a literal inside it is data again, and PostgreSQL requires
   *  the inner tag to differ from the outer one. Without this the body's own
   *  comment handling reads a `--` belonging to the nested value as a comment
   *  and blanks the rest of its line, which erases whatever live SQL follows —
   *  the one direction blanking must never take. */
  dollarNested: string | null;
}

/** A `--` glued to an identifier on either side, which is TypeScript's
 *  decrement operator rather than a comment. Both sides matter: `i--` puts the
 *  name before it and `--i` after, and reading either as a comment blanks the
 *  rest of its line. Only where TypeScript is running, since SQL takes `--` as
 *  a comment however it is spelled. */
const DECREMENT_RE = /[\w$]/;

function isDecrement(line: string, at: number): boolean {
  return DECREMENT_RE.test(line[at - 1] ?? ' ') || DECREMENT_RE.test(line[at + 2] ?? ' ');
}

/** The opener of a dollar-quoted string, `$$` or `$tag$`, in PostgreSQL's own
 *  grammar: the tag is empty, or an unquoted identifier — a letter or
 *  underscore, then letters, digits and underscores — which is why the letter
 *  classes are Unicode-aware rather than ASCII.
 *
 *  The grammar is the load-bearing part, not a tidy-up. A tag pattern loose
 *  enough to admit punctuation matches a PARAMETER PLACEHOLDER PAIR: `VALUES
 *  ($1,$2)` reads as a span tagged `$1,$` and `` `${prefix}$1` `` as one tagged
 *  `${prefix}$`. Neither tag ever recurs, so the span never closes, and a span
 *  that never closes switches comment blanking off from that point to the end
 *  of the file — silencing the column walk, the table walk and the fail-closed
 *  arm together, which is the whole guard. Both spellings are ordinary code.
 *
 *  Two further conditions apply at the opener, each closing a shape the grammar
 *  alone does not: the tag must RECUR later in the file (see
 *  {@link dollarCloses}), the way a block comment must find a closer, and the
 *  characters after `$$` must not be a TypeScript interpolation, since
 *  `` `$${n}` `` is this repo's placeholder-builder idiom rather than a quoted
 *  span. */
const DOLLAR_QUOTE_RE = /^\$(?:[\p{L}_][\p{L}\p{Nd}_]*)?\$/u;

/** Whether the dollar-quoted span opening at `from` on `lineIndex` ever closes.
 *  An opener whose tag never recurs is not a quoted span, for the same reason
 *  a block comment opener with no closer is not a comment: reading it as one
 *  turns off the blanking that every pattern here depends on, for every line
 *  after it, and a line no scan reads is a silent pass rather than a red bar. */
function dollarCloses(lines: string[], lineIndex: number, from: number, tag: string): boolean {
  for (let i = lineIndex; i < lines.length; i++) {
    const text = i === lineIndex ? lines[i].slice(from + tag.length) : lines[i];
    if (text.includes(tag)) return true;
  }
  return false;
}

/** The keyword a routine or anonymous-block body follows. A dollar-quoted span
 *  is SOURCE, not data, exactly when it is the body of a `CREATE FUNCTION` /
 *  `CREATE PROCEDURE` (`... AS $$`) or of an anonymous `DO $$` block;
 *  everywhere else it is a string constant whose characters are data. */
const DOLLAR_CODE_BODY_RE = /\b(?:DO|AS)\s*$/i;

/** Whether the span opening after `before` on `lineIndex` is a code body.
 *
 *  Every line consulted is a BLANKED one: `before` is the current line already
 *  blanked up to the opener, and when the opener leads its line — the `AS` on
 *  one line and `$$` on the next — the walk reads back through `blanked`, the
 *  lines this same pass has already finished. Reading either RAW gets the
 *  judgement wrong in both directions, and both are silent. A comment sitting
 *  after the keyword (`... AS -- see below`) hides it, so a real routine body
 *  reads as a value and the comment-gap class reopens inside it. And SQL prose
 *  ending in one of the keywords (`-- nothing else to do`, `-- stored exactly
 *  as`) supplies one, so a following VALUE is blanked as code and its own `--`
 *  erases live statement text. Migrations here write `--` prose in quantity, so
 *  the second is the likelier of the two. */
function opensCodeBody(blanked: string[], lineIndex: number, before: string): boolean {
  if (before.trim() !== '') return DOLLAR_CODE_BODY_RE.test(before);
  for (let i = lineIndex - 1; i >= 0; i--) {
    if (blanked[i] === undefined || blanked[i].trim() === '') continue;
    return DOLLAR_CODE_BODY_RE.test(blanked[i]);
  }
  return false;
}

/** Whether the block comment opening at `from` on `lineIndex` actually closes.
 *  An opener that never closes is not a comment: in a template it is ordinary
 *  text, and a glob or a wildcard path (`sessions/*`) is the shape that
 *  produces one. Treating it as a comment would blank every line after it, and
 *  a blanked line is a line no scan sees, so that mistake is silent and
 *  unbounded. Inside a template the close must also come before the template
 *  ends, since text after the backtick is code again.
 *
 *  The search runs to the end of the file rather than to a fixed lookahead.
 *  A bounded one answers "not a comment" for every block comment longer than
 *  the bound, and reads that comment's prose as live source instead. Thirteen
 *  of the block comments in the scanned trees run past sixty lines and the
 *  longest is 159, so a sixty-line bound put all thirteen in that state — which
 *  is how a `$1..$4` written in the prose of one of them opened a phantom
 *  dollar-quoted span and switched blanking off for the rest of its file. The
 *  file is already in memory, so the unbounded search costs nothing, and the
 *  bound's purpose is served by the two answers that remain: no closer anywhere
 *  is not a comment, and inside a template the closer must precede the
 *  backtick. */
function blockCloses(lines: string[], lineIndex: number, from: number, template: boolean): boolean {
  for (let i = lineIndex; i < lines.length; i++) {
    const text = i === lineIndex ? lines[i].slice(from + 2) : lines[i];
    const closes = text.indexOf('*/');
    const ends = template ? text.indexOf('`') : -1;
    if (closes !== -1 && (ends === -1 || closes < ends)) return true;
    if (ends !== -1) return false;
  }
  return false;
}

/** `line` with its comment spans blanked, and the state the next line starts
 *  in. `sql` marks a file that is SQL throughout rather than TypeScript
 *  carrying SQL in templates. */
function blankLine(
  lines: string[],
  lineIndex: number,
  state: BlankState,
  sql: boolean,
  blanked: string[] = [],
): { text: string; state: BlankState } {
  const line = lines[lineIndex];
  const escapes = !sql;
  let { block, template, dollar, dollarCode, dollarNested } = state;
  let opaque: string | null = null;
  let out = '';
  let i = 0;
  while (i < line.length) {
    const char = line[i];
    const next = line[i + 1];
    if (block) {
      const closing = char === '*' && next === '/';
      out += closing ? '  ' : ' ';
      i += closing ? 2 : 1;
      block = !closing;
      continue;
    }
    // A value inside a code body is read before the body itself, so the body's
    // comment handling cannot blank a marker that is one of the value's own
    // characters.
    if (opaque !== null) {
      if (escapes && char === '\\' && next !== undefined) {
        out += char + next;
        i += 2;
        continue;
      }
      out += char;
      // An unescaped backtick ends the template whatever else is open: a value
      // cannot contain one, so an apostrophe in prose earlier on the line must
      // not swallow it and leave the template flag inverted for the rest of
      // the file.
      if (char === '`') {
        template = !template;
        opaque = null;
        dollar = null;
        dollarCode = false;
        dollarNested = null;
      } else if (char === opaque) opaque = null;
      i++;
      continue;
    }
    if (dollar !== null) {
      // A literal nested inside a code body is data again, and its characters
      // are read before the body's own comment handling can blank one of them.
      if (dollarNested !== null) {
        if (line.startsWith(dollarNested, i)) {
          out += dollarNested;
          i += dollarNested.length;
          dollarNested = null;
          continue;
        }
        out += char;
        i++;
        continue;
      }
      if (line.startsWith(dollar, i)) {
        out += dollar;
        i += dollar.length;
        dollar = null;
        dollarCode = false;
        continue;
      }
      // A VALUE body is data: every character of it belongs to the statement,
      // markers included. A CODE body is source, so its comments are blanked
      // like any other — a comment between two tokens a pattern needs adjacent
      // silences that pattern wherever it sits, and a routine or `DO` body is
      // not an exception to that. Only the shapes that belong to the body's own
      // dialect are read here: no template delimiter, and no nested tag.
      if (!dollarCode) {
        out += char;
        i++;
        continue;
      }
      if (char === "'" || char === '"') {
        opaque = char;
        out += char;
        i++;
        continue;
      }
      if (char === '$') {
        const inner = line.slice(i).match(DOLLAR_QUOTE_RE);
        // PostgreSQL requires a nested tag to differ from the one that opened
        // the body, and the body's terminator was tested above, so any opener
        // reaching here starts a value.
        if (inner !== null && line[i + inner[0].length] !== '{' && dollarCloses(lines, lineIndex, i, inner[0])) {
          dollarNested = inner[0];
          out += inner[0];
          i += inner[0].length;
          continue;
        }
      }
      if (char === '-' && next === '-') {
        out += ' '.repeat(line.length - i);
        break;
      }
      if (char === '/' && next === '*' && blockCloses(lines, lineIndex, i, template)) {
        block = true;
        out += '  ';
        i += 2;
        continue;
      }
      out += char;
      i++;
      continue;
    }
    if (escapes && char === '\\' && next !== undefined) {
      out += char + next;
      i += 2;
      continue;
    }
    if (char === '`') {
      template = !template;
      out += char;
      i++;
      continue;
    }
    if (char === "'" || char === '"') {
      opaque = char;
      out += char;
      i++;
      continue;
    }
    if (char === '$' && (sql || template)) {
      const opener = line.slice(i).match(DOLLAR_QUOTE_RE);
      // `$${n}` is the placeholder-builder idiom, not a quoted span: the `$$`
      // is a SQL sigil followed by a template interpolation. Reading it as one
      // would switch comment blanking off from there to the next `$$`. And a
      // tag that never recurs closes nothing, so reading it as a span would
      // switch blanking off for the rest of the file.
      if (
        opener !== null &&
        line[i + opener[0].length] !== '{' &&
        dollarCloses(lines, lineIndex, i, opener[0])
      ) {
        dollar = opener[0];
        dollarCode = opensCodeBody(blanked, lineIndex, out);
        out += opener[0];
        i += opener[0].length;
        continue;
      }
    }
    if (char === '/' && next === '/' && !sql && !template) {
      out += ' '.repeat(line.length - i);
      break;
    }
    if (
      char === '-' &&
      next === '-' &&
      (sql || template || !isDecrement(line, i))
    ) {
      out += ' '.repeat(line.length - i);
      break;
    }
    if (char === '/' && next === '*' && blockCloses(lines, lineIndex, i, template)) {
      block = true;
      out += '  ';
      i += 2;
      continue;
    }
    out += char;
    i++;
  }
  return { text: out, state: { block, template, dollar, dollarCode, dollarNested } };
}

/** Every line of a file with its comments blanked, read from the top so a
 *  block comment, a template and a dollar-quoted body each end where they
 *  really end, together with the state the reader is left in at the last line.
 *
 *  That final state is asserted on. Every span the reader tracks is closed by
 *  the end of a well-formed file, so a file it leaves mid-span is a file it
 *  misread, and the lines after the misread point were copied verbatim with no
 *  comment blanking — which is the one failure mode that silences every scan at
 *  once instead of one of them. Reading the state out is what turns that from a
 *  defect someone has to think of into a red bar. */
function blankAll(lines: string[], sql: boolean): { code: string[]; state: BlankState } {
  let state: BlankState = { block: false, template: false, dollar: null, dollarCode: false, dollarNested: null };
  const code: string[] = [];
  lines.forEach((_line, i) => {
    const blanked = blankLine(lines, i, state, sql, code);
    state = blanked.state;
    code.push(blanked.text);
  });
  return { code, state };
}

function blankFile(lines: string[], sql: boolean): string[] {
  return blankAll(lines, sql).code;
}

/** Every line of a file, blanked once, since every scan reads them repeatedly. */
interface Readable extends ScannedSource {
  code: string[];
}

function readable(files: ScannedSource[]): Readable[] {
  return files.map((file) => ({ ...file, code: blankFile(file.lines, file.rel.endsWith('.sql')) }));
}

/** The string enclosing `index` on an already-blanked line, and where it
 *  opens, or null when the position sits in no string. Only the same character
 *  closes a string, so a `'light'` inside a backticked template does not end
 *  it, and a literal that opens and closes AHEAD of the position is not
 *  mistaken for the one that encloses it. */
function enclosingQuote(line: string, index: number): { char: string; at: number } | null {
  let quote: string | null = null;
  let at = -1;
  for (let i = 0; i < index; i++) {
    const char = line[i];
    if (quote !== null) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '`' || char === "'" || char === '"') {
      quote = char;
      at = i;
    }
  }
  return quote === null ? null : { char: quote, at };
}

interface StatementHead {
  table: string;
  index: number;
}

/** The statement head NEAREST to `before` on an already-blanked `line` that
 *  names a table, or null.
 *
 *  Nearest rather than leftmost, because what encloses a position is the last
 *  statement opened before it: a line carrying two statements would otherwise
 *  hand every assignment in the second one to the first one's table, which is
 *  a misattribution to a table the assertion does not compare against. Each
 *  pattern is also walked PAST its rejected matches — a `DO UPDATE SET`, which
 *  names no table — rather than stopped at the first, so an upsert sharing a
 *  line with a later statement still resolves that statement. */
function statementHead(line: string, before?: number): StatementHead | null {
  let nearest: StatementHead | null = null;
  for (const pattern of HEAD_PATTERNS) {
    for (const match of line.matchAll(new RegExp(pattern.source, 'gi'))) {
      const index = match.index ?? 0;
      if (before !== undefined && index >= before) break;
      if (NOT_A_TABLE.has(bareTable(match[1]))) continue;
      if (nearest === null || index > nearest.index) nearest = { table: bareTable(match[1]), index };
    }
  }
  return nearest;
}

/** The table written by the assignment on `lineIndex`: the nearest statement
 *  head at or above it, provided the statement that head opens reaches the
 *  assignment's line. A head whose statement closed earlier belongs to some
 *  other query, and the assignment is {@link UNRESOLVED_TABLE}: the walk does
 *  not keep climbing to whatever query happens to sit further up. On the
 *  assignment's own line only a head to its LEFT can own it, since a statement
 *  opened after the assignment cannot contain it. */
function targetTable(code: string[], lineIndex: number, position?: number): string {
  const own = position ?? assignmentIndex(code[lineIndex]);
  const at = own === -1 ? code[lineIndex].length : own;
  for (let i = lineIndex; i >= 0; i--) {
    const head = statementHead(code[i], i === lineIndex && own !== -1 ? own : undefined);
    if (head === null) continue;
    const reach = statementAt(code, i, head.index);
    // Reaching the assignment's LINE is not enough when the statement ends on
    // that line: one that closed to the left of the assignment is a sibling
    // query, not its owner, and lending its table is the misattribution the
    // fail-closed arm exists to refuse.
    const reaches =
      reach.lastLine > lineIndex ||
      (reach.lastLine === lineIndex && (reach.closedAt === -1 || reach.closedAt > at));
    return reaches ? head.table : UNRESOLVED_TABLE;
  }
  return UNRESOLVED_TABLE;
}

/** A table name with its default-schema qualification dropped and any
 *  whitespace around the qualifying dot removed, so `accounts`,
 *  `public.accounts` and `public . accounts` are one table while a name
 *  qualified into any other schema stays distinct from all three. */
function bareTable(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '').replace(/^public\./, '');
}

/** One SQL statement as read from its head: its text, the line it ends on, the
 *  column of its terminator on that line (-1 when the read hit the cap or the
 *  end of the file first), and the column of the quote that opens it on the
 *  head line (-1 in a migration, where there is none). */
interface SqlStatement {
  text: string;
  lastLine: number;
  closedAt: number;
  quoteAt: number;
}

/**
 * The SQL statement that starts at `matchIndex` on `lineIndex` of an
 * already-blanked file, read to its terminator.
 *
 * The delimiter is the quote of the string ENCLOSING the keyword, so a
 * backtick template and a single-quoted one-liner are each read to their own
 * quote, and a literal that opens and closes ahead of the keyword cannot hand
 * the read a delimiter that truncates it short of the assignment. A keyword
 * enclosed by no string is a migration statement, read to its semicolon. The
 * read carries value state across lines, so a semicolon inside a quoted or
 * dollar-quoted value ends nothing, and it is capped so an unterminated
 * literal cannot swallow the rest of the file. A read that hits the cap
 * reports no terminator, which is itself asserted on: a statement too long to
 * read whole is a statement this file cannot clear.
 */
function statementAt(code: string[], lineIndex: number, matchIndex: number): SqlStatement {
  const opener = enclosingQuote(code[lineIndex], matchIndex);
  const quote = opener?.char ?? null;
  let text = '';
  let opaque: string | null = null;
  let dollar: string | null = null;
  let lastLine = lineIndex;
  for (let i = lineIndex; i < code.length && i <= lineIndex + LITERAL_CAP; i++) {
    const line = code[i];
    let out = '';
    let col = i === lineIndex ? matchIndex : 0;
    let closedAt = -1;
    while (col < line.length) {
      const char = line[col];
      const nextChars = line.slice(col);
      if (dollar !== null) {
        if (line.startsWith(dollar, col)) {
          out += dollar;
          col += dollar.length;
          dollar = null;
          continue;
        }
        out += char;
        col++;
        continue;
      }
      if (opaque !== null) {
        if (char === '\\' && col + 1 < line.length) {
          out += line.slice(col, col + 2);
          col += 2;
          continue;
        }
        out += char;
        if (char === opaque) opaque = null;
        col++;
        continue;
      }
      if (char === '\\' && col + 1 < line.length) {
        out += line.slice(col, col + 2);
        col += 2;
        continue;
      }
      if (quote === null ? char === ';' : char === quote) {
        closedAt = col;
        break;
      }
      if (char === "'" || char === '"') {
        opaque = char;
        out += char;
        col++;
        continue;
      }
      const opener2 = char === '$' && quote === null ? nextChars.match(DOLLAR_QUOTE_RE) : null;
      if (opener2 !== null) {
        dollar = opener2[0];
        out += opener2[0];
        col += opener2[0].length;
        continue;
      }
      out += char;
      col++;
    }
    text += i === lineIndex ? out : '\n' + out;
    lastLine = i;
    if (closedAt !== -1) return { text, lastLine: i, closedAt, quoteAt: opener?.at ?? -1 };
  }
  return { text, lastLine, closedAt: -1, quoteAt: opener?.at ?? -1 };
}

/** Whether an `accounts` statement writes the column: an assignment anywhere in
 *  it, or the column named in an INSERT column list or a MERGE insert list.
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
  // Every column list in the statement, not the first of either kind. A MERGE
  // may carry several conditional `WHEN NOT MATCHED THEN INSERT` branches, and
  // a statement may carry an INSERT beside a MERGE, so stopping at one list
  // lets a later branch write the column unseen.
  for (const pattern of [ACCOUNTS_INSERT_COLUMNS_RE, MERGE_INSERT_COLUMNS_RE, COPY_COLUMNS_RE]) {
    for (const columns of statement.matchAll(new RegExp(pattern.source, 'gi'))) {
      if (/\bupdated_at\b/.test(columns[1])) return true;
    }
  }
  return false;
}

interface Occurrence {
  key: string;
  site: string;
}

function occurrenceAt(rel: string, lines: string[], i: number): Occurrence {
  const symbol = enclosingSymbol(lines, i);
  return { key: `${rel}#${symbol}`, site: `${rel}:${i + 1} (${symbol}) — ${lines[i].trim()}` };
}

/** Every column assignment across `files`, attributed to a table. */
function columnAssignments(files: Readable[]): Map<string, Occurrence[]> {
  const byTable = new Map<string, Occurrence[]>();
  for (const { rel, lines, code } of files) {
    code.forEach((line, i) => {
      // Every assignment on the line, not the line itself. The comparison is a
      // tally of WRITES, so a second one riding on a licensed write's line has
      // to raise the count rather than disappear into it.
      for (const at of assignmentIndexes(line)) {
        const table = targetTable(code, i, at);
        const found = byTable.get(table) ?? [];
        found.push(occurrenceAt(rel, lines, i));
        byTable.set(table, found);
      }
    });
  }
  return byTable;
}

/** Every `accounts` statement that writes the column, read table-first. Every
 *  head on a line is considered, not only the first: a migration line carrying
 *  two statements ends the first read at its semicolon, so a second statement
 *  beside it would otherwise go unread. */
function accountsColumnWriters(files: Readable[]): Occurrence[] {
  const found: Occurrence[] = [];
  for (const { rel, lines, code } of files) {
    code.forEach((line, i) => {
      for (const match of line.matchAll(new RegExp(ACCOUNTS_STATEMENT_RE.source, 'gi'))) {
        if (writesColumn(statementAt(code, i, match.index ?? 0).text)) {
          found.push(occurrenceAt(rel, lines, i));
        }
      }
    });
  }
  return found;
}

/** Whether `statement`, read from its head on `headLine`, is joined to more
 *  text by a `+` spelled against its literal. */
function joinedByPlus(code: string[], statement: SqlStatement, headLine: number): boolean {
  if (statement.quoteAt !== -1 && JOINED_BEFORE_RE.test(code[headLine].slice(0, statement.quoteAt))) return true;
  if (statement.closedAt === -1) return false;
  const after = code[statement.lastLine].slice(statement.closedAt + 1);
  if (JOINED_AFTER_RE.test(after)) return true;
  const next = code[statement.lastLine + 1];
  return after.trim() === '' && next !== undefined && JOINED_AFTER_RE.test(next);
}

interface AssembledWrite {
  site: string;
  how: 'interpolation' | 'concatenation';
}

/** Every `accounts` statement whose text is assembled rather than spelled. */
function assembledWrites(files: Readable[]): AssembledWrite[] {
  const found: AssembledWrite[] = [];
  for (const { rel, lines, code } of files) {
    code.forEach((line, i) => {
      for (const match of line.matchAll(new RegExp(ACCOUNTS_STATEMENT_RE.source, 'gi'))) {
        const statement = statementAt(code, i, match.index ?? 0);
        const how = SQL_INTERPOLATION_RE.test(statement.text)
          ? 'interpolation'
          : joinedByPlus(code, statement, i)
            ? 'concatenation'
            : null;
        if (how === null) continue;
        found.push({ site: occurrenceAt(rel, lines, i).site, how });
        return;
      }
    });
  }
  return found;
}

interface RoutineSite {
  key: string;
  site: string;
  boundToAccounts: boolean;
}

/** Every trigger, rule, function and procedure created across `files`, keyed
 *  exactly, and flagged when it is a trigger or rule bound to `accounts`. A
 *  function body that names the table does not bind it; deciding what a body
 *  can reach is the by-hand judgement the exemption list records. */
function routineSites(files: Readable[]): RoutineSite[] {
  const found: RoutineSite[] = [];
  for (const { rel, lines, code } of files) {
    code.forEach((line, i) => {
      for (const match of line.matchAll(new RegExp(ROUTINE_CREATION_RE.source, 'gi'))) {
        const kind = match[1].toUpperCase();
        const bindsTable = kind === 'TRIGGER' || kind === 'RULE';
        found.push({
          key: `${rel}#${kind} ${match[2] ?? UNNAMED_ROUTINE}`,
          site: `${rel}:${i + 1} — ${lines[i].trim()}`,
          boundToAccounts:
            bindsTable && BOUND_TO_ACCOUNTS_RE.test(statementAt(code, i, match.index ?? 0).text),
        });
      }
    });
  }
  return found;
}

/** Every `ALTER TABLE accounts` statement that names the column. */
function accountsColumnAlterations(files: Readable[]): Occurrence[] {
  const found: Occurrence[] = [];
  for (const { rel, lines, code } of files) {
    code.forEach((line, i) => {
      for (const match of line.matchAll(new RegExp(ALTER_ACCOUNTS_RE.source, 'gi'))) {
        const statement = statementAt(code, i, match.index ?? 0);
        if (/\bupdated_at\b/.test(statement.text)) found.push(occurrenceAt(rel, lines, i));
      }
    });
  }
  return found;
}

/** The routines not covered by an exact exemption key. */
function unexempted(routines: RoutineSite[], exemptions: string[]): RoutineSite[] {
  return routines.filter((routine) => !exemptions.includes(routine.key));
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

/** The migration files, keyed by filename. Comments are blanked by the shared
 *  reader like any other source, so the `--` prose these files carry in
 *  quantity is not read as SQL. */
function migrationSources(root: string): ScannedSource[] {
  return readdirSync(root)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({
      rel: name,
      lines: readFileSync(path.join(root, name), 'utf8').split('\n'),
    }));
}

/** Every `.sql` file under `root`, recursively.
 *
 *  `sourcesUnder` collects `.ts` alone, which is right for a scan of code and
 *  wrong for a scan of statements: a query kept as a `.sql` resource beside
 *  the code that runs it is inside the scanned tree and reaches the same
 *  database, and an extension filter is not a reason to stop looking at it.
 *  None exists today, which is why this returns an empty list and why the
 *  writer set is unchanged by it. */
function sqlResourcesUnder(root: string): ScannedSource[] {
  const out: ScannedSource[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.sql')) {
        out.push({
          rel: path.relative(root, full).split(path.sep).join('/'),
          lines: readFileSync(full, 'utf8').split('\n'),
        });
      }
    }
  };
  walk(root);
  return out;
}

const srcRoot = path.resolve(__dirname, '..', '..', 'src');
const sources = readable(sourcesUnder(srcRoot));
const migrations = readable([
  ...migrationSources(path.resolve(__dirname, '..', '..', 'migrations')),
  ...sqlResourcesUnder(srcRoot),
]);

/** The blanked view every scan reads, for fixtures written as source lines.
 *  A fixture is TypeScript unless it is given as a migration. */
const asCode = (lines: string[], sql = false): string[] => blankFile(lines, sql);
const scanned = (line: string, sql = false): string => blankFile([line], sql)[0];

describe('accounts.updated_at is written by the two signup finalizes and nothing else', () => {
  it('walks a plausible number of sources and migrations (guards against a broken walker)', () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.map((s) => s.rel)).toContain('routes/signup-verify.ts');
    expect(migrations.length).toBeGreaterThan(10);
    expect(migrations.map((m) => m.rel)).toContain(
      Object.keys(ALLOWED_WRITER_MIGRATIONS)[0].split('#')[0],
    );
  });

  it('the reader finishes every file it reads with no span left open', () => {
    const unfinished = [...sources, ...migrations]
      .map((file) => ({ rel: file.rel, state: blankAll(file.lines, file.rel.endsWith('.sql')).state }))
      .filter(({ state }) => state.block || state.template || state.dollar !== null)
      .map(({ rel, state }) => `${rel} — ${JSON.stringify(state)}`);
    expect(
      unfinished,
      'a file the reader left mid-span is a file it misread, and every line after the misread ' +
        'point was copied with NO comment blanking. That is the one failure mode which silences ' +
        'every scan at once rather than one of them: the column walk, the table walk and the ' +
        'fail-closed arm all go quiet together, so the guard reports nothing and reads green. ' +
        'A block comment, a template and a dollar-quoted span each close in a well-formed file, ' +
        'so an open one at the last line names the shape the reader got wrong — fix the reader, ' +
        `not this list. Why the guard matters: ${ORDERING_RATIONALE}\n${unfinished.join('\n')}`,
    ).toEqual([]);
  });

  it('every updated_at assignment resolves to the table it writes', () => {
    const unresolved = [
      ...(columnAssignments(sources).get(UNRESOLVED_TABLE) ?? []),
      ...(columnAssignments(migrations).get(UNRESOLVED_TABLE) ?? []),
    ];
    expect(
      unresolved.map((o) => o.site),
      'an updated_at assignment that no readable statement head reaches cannot be told apart ' +
        'from an accounts write, so it fails here rather than passing as some other table, and ' +
        'a head further up the file whose statement closed earlier does not count. Give the ' +
        `statement a readable head or scan it another way. Why this matters: ${ORDERING_RATIONALE}\n` +
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
        `reads the statement from its table, so it also sees an INSERT or a MERGE that writes ` +
        `the column by naming it. Why the set is closed: ${ORDERING_RATIONALE}\n${sitesOf(writers)}`,
    ).toEqual(ALLOWED_WRITER_SITES);
  });

  it('only the column-introducing migration writes accounts.updated_at, column-first', () => {
    const writers = columnAssignments(migrations).get('accounts') ?? [];
    expect(
      countsOf(writers),
      `a migration writing accounts.updated_at. A back-fill that bumps the marker puts every ` +
        `row it touches inside the recovery window for the length of that window after deploy. ` +
        `Why that matters: ${ORDERING_RATIONALE}\n${sitesOf(writers)}`,
    ).toEqual(ALLOWED_WRITER_MIGRATIONS);
  });

  it('only the column-introducing migration writes accounts.updated_at, table-first', () => {
    const writers = accountsColumnWriters(migrations);
    expect(
      countsOf(writers),
      `a migration statement writing accounts.updated_at, read from its table so an INSERT ` +
        `that names the column is seen too. A back-fill that bumps the marker puts every row ` +
        `it touches inside the recovery window for the length of that window after deploy. ` +
        `Why that matters: ${ORDERING_RATIONALE}\n${sitesOf(writers)}`,
    ).toEqual(ALLOWED_WRITER_MIGRATIONS);
  });

  it('only the column-introducing migration alters accounts.updated_at itself', () => {
    const altered = accountsColumnAlterations([...sources, ...migrations]);
    expect(
      countsOf(altered),
      `an ALTER TABLE naming accounts.updated_at outside the migration that introduces it. A ` +
        `column can be rewritten with no statement that writes a row: an ALTER COLUMN ... TYPE ` +
        `... USING recomputes every value from an expression, a drop and re-add replaces the ` +
        `column, a rename moves another column onto the name. Each lands every row at a new ` +
        `value, which is what the writer scans exist to refuse, and none of them is an UPDATE. ` +
        `Why it matters: ${ORDERING_RATIONALE}\n${sitesOf(altered)}`,
    ).toEqual(ALLOWED_COLUMN_ALTERATIONS);
  });

  it('no migration binds a trigger or rule to accounts, exemption or not', () => {
    const bound = routineSites(migrations).filter((routine) => routine.boundToAccounts);
    expect(
      bound.map((routine) => routine.site),
      'a trigger or rule on `accounts` fires on every row it matches and is a writer no scan ' +
        'of application source can see. There is no exemption for this shape: a trigger body ' +
        'writes the column as `NEW.updated_at := now()`, which the column pattern does not ' +
        'read, so refusing the binding is the only catcher. Why it matters: ' +
        `${ORDERING_RATIONALE}\n${bound.map((routine) => routine.site).join('\n')}`,
    ).toEqual([]);
  });

  it('no migration installs a trigger, rule or stored routine that has not been judged by exact site', () => {
    const found = unexempted(routineSites(migrations), ROUTINES_THAT_CANNOT_REACH_ACCOUNTS);
    expect(
      found.map((routine) => `${routine.key} at ${routine.site}`),
      'a trigger, rule or stored routine is a writer no scan of application source can see, ' +
        'and a routine body is a write path its call site does not spell. This arm refuses all ' +
        'of them rather than parsing each body: if yours demonstrably cannot write the column, ' +
        'record that judgement in the exemption list under the exact `file#KIND name` key ' +
        `reported here. Why it matters: ${ORDERING_RATIONALE}\n` +
        `${found.map((routine) => routine.site).join('\n')}`,
    ).toEqual([]);
  });

  it('no accounts write statement is assembled by interpolation or concatenation', () => {
    const assembled = assembledWrites(sources);
    expect(
      assembled.map((write) => `[${write.how}] ${write.site}`),
      'an accounts write whose text is partly held in a variable is unreadable to the ' +
        'table-first scan, which sees a placeholder where the SET list should be. Spell the ' +
        `statement out, or bind the value as a parameter. Why it matters: ${ORDERING_RATIONALE}\n` +
        `${assembled.map((write) => write.site).join('\n')}`,
    ).toEqual([]);
  });

  // The pattern specs. Every planted line answers to exactly one feature, so
  // deleting that feature turns it red; the comments name which.
  it('an assignment is read in the SET-list spellings and not in reads, TypeScript or PL/pgSQL', () => {
    expect(COLUMN_ASSIGNMENT_RE.test('             signup_binding_hash = NULL, updated_at = NOW()')).toBe(true);
    expect(COLUMN_ASSIGNMENT_RE.test('SET last_digest_block = $2, updated_at = now()')).toBe(true);
    expect(COLUMN_ASSIGNMENT_RE.test('    updated_at=NOW(),')).toBe(true);
    expect(COLUMN_ASSIGNMENT_RE.test('         updated_at = EXCLUDED.updated_at,')).toBe(true);
    // Reads and TypeScript field declarations, which write no column.
    expect(COLUMN_ASSIGNMENT_RE.test('           AND upgraded_at <= updated_at')).toBe(false);
    expect(COLUMN_ASSIGNMENT_RE.test('  updated_at: Date;')).toBe(false);
    expect(COLUMN_ASSIGNMENT_RE.test('    updated_at: row.updated_at as Date,')).toBe(false);
    // The lookbehind: a property access, and a longer column that ends the
    // same way.
    expect(COLUMN_ASSIGNMENT_RE.test('  row.updated_at = stamp;')).toBe(false);
    expect(COLUMN_ASSIGNMENT_RE.test('SET last_updated_at = NOW()')).toBe(false);
    // The lookahead: a comparison on a bare local, with no dot for the
    // lookbehind to drop it by.
    expect(COLUMN_ASSIGNMENT_RE.test('  if (updated_at == other) return;')).toBe(false);
    expect(COLUMN_ASSIGNMENT_RE.test('  if (updated_at === other) return;')).toBe(false);
    // The PL/pgSQL trigger-body write is NOT read here, in either spelling. It
    // is the property-access shape, and the routine arm is its sole catcher.
    expect(assignsColumn('  NEW.updated_at := now();')).toBe(false);
    expect(assignsColumn('  NEW.updated_at = now();')).toBe(false);
    // The row-assignment form, where the column is followed by a comma or a
    // paren and the `=` belongs to the target list; and the target list alone.
    expect(assignsColumn('SET (custody, updated_at) = ($2, NOW())')).toBe(true);
    expect(assignmentIndex('SET (custody, updated_at) = ($2, NOW())')).toBe('SET (custody, '.length);
    expect(assignsColumn('       SET (pending_email, updated_at)')).toBe(false);
    expect(assignsColumn('SET (custody, upgraded_at) = ($2, NOW())')).toBe(false);
    // The same form NOT first in the SET list, where nothing but a comma
    // precedes the target list, and behind another parenthesised group that
    // does not carry the column. PostgreSQL takes a row assignment as one
    // set_clause among several, so this is the ordinary spelling once a
    // statement writes anything else.
    expect(assignsColumn('SET custody = $1, (pending_email, updated_at) = ($2, NOW())')).toBe(true);
    expect(assignsColumn('SET (a, b) = ($1, $2), (pending_email, updated_at) = ($3, NOW())')).toBe(true);
    expect(assignsColumn('SET custody = $1, (pending_email, verify_token) = ($2, NULL)')).toBe(false);
    // A parenthesised list is not an assignment when the `=` opens an arrow or
    // a comparison.
    expect(assignsColumn('  const stamp = (updated_at) => updated_at ?? new Date();')).toBe(false);
    expect(assignsColumn('  if (row.get(updated_at) === other) return;')).toBe(false);
    // A TypeScript local carrying the column's name writes no column; the same
    // text inside a SET list does.
    expect(assignsColumn('  const updated_at = row.updated_at;')).toBe(false);
    expect(assignsColumn('  let updated_at: Date | null = null;')).toBe(false);
    // Each declaration keyword, and a run of whitespace before the sign — which
    // is what the pattern's own `\s*` admits and no forward bound can put a
    // number on. (The annotation spelling `updated_at:` is excluded a step
    // earlier, by the assignment pattern's own `\s*=`, so no fixture here can
    // reach the declaration pattern's `:` alternative.)
    expect(assignsColumn('  var updated_at = 1;')).toBe(false);
    expect(assignsColumn('  const updated_at   = row.updated_at;')).toBe(false);
    expect(assignsColumn('             signup_binding_hash = NULL, updated_at = NOW()')).toBe(true);
    // A row assignment LEFT of a plain one. The two spellings are collected and
    // the earlier returned, rather than the plain form answering first: a
    // position past the row assignment sends the occurrence walk beyond it, so
    // the line reports one write where it holds two and a second write added
    // beside a licensed one disappears into the count meant to catch it.
    const mixed = 'SET (email, updated_at) = ($1, NOW()), custody = $2, updated_at = NOW()';
    expect(assignmentIndex(mixed)).toBe('SET ('.length + 'email, '.length);
    expect(assignmentIndexes(mixed)).toHaveLength(2);
    // And the same line, end to end, through both writer scans.
    const mixedFile = readable([{ rel: 'x.ts', lines: ['async function touch(id: number) {', `  await q(\`UPDATE accounts ${mixed} WHERE id = $3\`, [id]);`, '}'] }]);
    expect(countsOf(columnAssignments(mixedFile).get('accounts') ?? [])).toEqual({ 'x.ts#touch': 2 });
    expect(countsOf(accountsColumnWriters(mixedFile))).toEqual({ 'x.ts#touch': 1 });
  });

  const finalize = [
    '        `UPDATE accounts',
    "         SET username = $1, custody = 'light', verify_token = NULL,",
    '             posting_key_enc = $2, iv_posting = $3,',
    '             memo_key_enc = $4, iv_memo = $5,',
    '             signup_binding_hash = NULL, updated_at = NOW()',
    '         WHERE id = $6`,',
    '        [normalizedUsername],',
  ];
  const merge = [
    '        `MERGE INTO accounts a',
    '         USING (SELECT $1::text AS email) s ON s.email = a.email',
    '         WHEN MATCHED THEN UPDATE SET updated_at = NOW()',
    '         WHEN NOT MATCHED THEN INSERT (email, updated_at) VALUES (s.email, NOW())`,',
  ];
  // A query that closed on its own line, sitting just above whatever follows.
  const foreign = ['      `UPDATE sessions SET last_seen = NOW() WHERE id = $1`,', '      [sessionId],'];

  it('a head resolves the table, and only when its statement reaches the assignment', () => {
    // An upsert's assignments belong to the INSERT: `DO UPDATE SET` names no
    // table.
    const upsert = [
      '`INSERT INTO notification_preferences (username, updated_at)',
      ' VALUES ($1, now())',
      ' ON CONFLICT (username) DO UPDATE SET',
      '   updated_at = now()`,',
    ];
    expect(targetTable(asCode(upsert), 3)).toBe('notification_preferences');
    // `FOR UPDATE` ahead of the true head on the same line: the lookbehind is
    // what walks the pattern past it.
    expect(
      targetTable(asCode(['`WITH due AS (SELECT id FROM q FOR UPDATE SKIP LOCKED) UPDATE bridge_import_queue q SET updated_at = NOW()`,']), 0),
    ).toBe('bridge_import_queue');
    expect(
      targetTable(asCode(['`WITH due AS (SELECT id FROM q FOR  UPDATE SKIP LOCKED) UPDATE accounts SET updated_at = NOW()`,']), 0),
    ).toBe('accounts');
    // `FOR UPDATE` to the RIGHT of the true head and left of the assignment,
    // which is where a row lock is actually written. Reading it as a head
    // would name the statement after the word that follows it.
    expect(
      targetTable(asCode(['`UPDATE accounts SET x = (SELECT v FROM q FOR UPDATE SKIP LOCKED), updated_at = NOW() WHERE id = $1`,']), 0),
    ).toBe('accounts');
    // PostgreSQL's weaker row lock, `FOR NO KEY UPDATE`, in the same position.
    // Its keyword is preceded by `KEY `, which the `FOR ` lookbehind never
    // sees, so it needs a lookbehind of its own — pinned on the pattern here,
    // because the keyword-tail rejection below would otherwise answer for it
    // and leave the deletion of either one green.
    expect(UPDATE_TARGET_RE.test('SELECT id FROM q FOR UPDATE SKIP LOCKED')).toBe(false);
    expect(UPDATE_TARGET_RE.test('SELECT id FROM q FOR NO KEY UPDATE SKIP LOCKED')).toBe(false);
    expect(UPDATE_TARGET_RE.test('SELECT id FROM q FOR NO KEY UPDATE OF q')).toBe(false);
    expect(UPDATE_TARGET_RE.test('UPDATE accounts SET updated_at = NOW()')).toBe(true);
    expect(
      targetTable(asCode(['`UPDATE accounts SET x = (SELECT v FROM q FOR NO KEY UPDATE SKIP LOCKED), updated_at = NOW() WHERE id = $1`,']), 0),
    ).toBe('accounts');
    // A locking clause SPLIT across lines puts its `FOR` out of every
    // lookbehind's reach, since a head is read one line at a time. The word
    // after the keyword is then captured as a table, and a head that resolves
    // to a plausible other table satisfies the fail-closed arm instead of
    // tripping it — the silent direction. Rejecting the keyword tails is what
    // leaves the write unresolved and the bar red.
    for (const tail of ['  UPDATE SKIP LOCKED', '  UPDATE NOWAIT', '  UPDATE OF q']) {
      expect(targetTable(asCode(['SELECT id FROM q', '  FOR', tail, '  , updated_at = NOW();'], true), 3), tail).toBe(UNRESOLVED_TABLE);
    }
    // `ONLY`, the default schema, and another schema.
    expect(targetTable(asCode(['`UPDATE ONLY accounts', ' SET updated_at = NOW()`,']), 1)).toBe('accounts');
    expect(targetTable(asCode(['`UPDATE public.accounts', ' SET updated_at = NOW()`,']), 1)).toBe('accounts');
    expect(targetTable(asCode(['`UPDATE hafsql.accounts', ' SET updated_at = NOW()`,']), 1)).toBe('hafsql.accounts');
    // MERGE: its UPDATE branch names no table, so the walk climbs to the MERGE.
    expect(targetTable(asCode(merge), 2)).toBe('accounts');
    // The finalize: five SET lines between the head and the assignment.
    expect(targetTable(asCode(finalize), 4)).toBe('accounts');
    // No head at all.
    expect(targetTable(asCode(['await pool.query(', '  {}', '  updated_at = NOW()']), 2)).toBe(UNRESOLVED_TABLE);
    // The reach. A foreign query closed two lines up; each unreadable head
    // below it stays unresolved instead of borrowing that query's table.
    const unreadable = [
      ['      `UPDATE "accounts" SET updated_at = NOW() WHERE id = $2`,'],
      ['      `UPDATE ${table} SET updated_at = NOW() WHERE id = $2`,'],
      ["      head + ' SET updated_at = NOW() WHERE id = $2',"],
      ["      'SET custody = $1, updated_at = NOW()',"],
    ];
    for (const shape of unreadable) {
      expect(targetTable(asCode([...foreign, ...shape]), foreign.length), shape[0]).toBe(UNRESOLVED_TABLE);
    }
    // And the readable heads below the same foreign query resolve to their own
    // table, not to `sessions`.
    expect(targetTable(asCode([...foreign, ...merge]), foreign.length + 2)).toBe('accounts');
    expect(targetTable(asCode([...foreign, ...finalize]), foreign.length + 4)).toBe('accounts');
    expect(
      targetTable(asCode([...foreign, '      /* sql */ `UPDATE accounts', '         SET updated_at = NOW()`,']), foreign.length + 1),
    ).toBe('accounts');
  });

  it('a head is read wherever the keyword sits outside a comment', () => {
    expect(statementHead(scanned('      /* sql */ `UPDATE accounts'))?.table).toBe('accounts');
    expect(scanned('      /* sql */ `UPDATE accounts')).toContain('UPDATE accounts');
    expect(statementHead(scanned('      // UPDATE accounts SET updated_at = NOW()'))).toBeNull();
    // A docblock continuation is a comment because its block is open, not
    // because the line opens with a star: an arithmetic continuation and the
    // close of a comment with live SQL after it wear the same shape, and
    // blanking either of those would drop live SQL from every scan at once.
    const docblock = asCode(['  /**', '   * UPDATE accounts SET updated_at = NOW()', '   */']);
    expect(docblock[1].trim()).toBe('');
    expect(statementHead(docblock[1])).toBeNull();
    const arithmetic = asCode(['      `UPDATE accounts', '          SET budget = budget', '              * $1, updated_at = NOW()', '        WHERE id = $2`,']);
    expect(assignmentIndex(arithmetic[2])).toBeGreaterThan(-1);
    expect(targetTable(arithmetic, 2)).toBe('accounts');
    const closeThenSql = asCode(['      `UPDATE accounts', '          SET custody = $1, /* the marker moves with it', '           */ updated_at = NOW()', '        WHERE id = $2`,']);
    expect(assignmentIndex(closeThenSql[2])).toBeGreaterThan(-1);
    expect(targetTable(closeThenSql, 2)).toBe('accounts');
    expect(statementHead(scanned('  await next(); // then UPDATE accounts'))).toBeNull();
    // A block comment is a comment because it CLOSES. One that never does is
    // ordinary text: a glob or a wildcard path in a template wears the same
    // two characters, and reading that as a comment blanks every line after
    // it, which is silent and unbounded.
    const blockComment = asCode(['  /* UPDATE accounts SET updated_at = NOW()', '     is what the old finalize did */']);
    expect(statementHead(blockComment[0])).toBeNull();
    expect(blockComment[1].trim()).toBe('');
    const glob = asCode(['  const keys = `${prefix}:sessions/${username}/*`;', '  await q(`UPDATE accounts SET updated_at = NOW() WHERE id = $1`);']);
    expect(glob[0]).toBe('  const keys = `${prefix}:sessions/${username}/*`;');
    expect(statementHead(glob[1])?.table).toBe('accounts');
    // A one-line upsert, where `DO UPDATE SET` names no table: the head is the
    // INSERT, and the rejected match does not become a table called `set`.
    expect(statementHead(scanned('`INSERT INTO t (a) VALUES (1) ON CONFLICT DO UPDATE SET updated_at = now()`'))?.table).toBe('t');
    // The walk past a rejected match, isolated: the same pattern matches twice
    // on one line, once inside a closed comment and once live. Stopping at the
    // first match loses the live statement entirely.
    expect(statementHead(scanned('  /* was: UPDATE sessions */ `UPDATE accounts SET updated_at = NOW()`,'))?.table).toBe('accounts');
    // A comment marker inside a string opens no comment: blanking from it
    // would erase the rest of the line, and with it a real write.
    const url = "  `UPDATE accounts SET avatar = 'https://cdn.example/a.png', updated_at = NOW() WHERE id = $1`,";
    expect(scanned(url)).toBe(url);
    expect(statementHead(scanned(url))?.table).toBe('accounts');
    // Nor does a closed block comment that mentions one.
    const blockTagged = '  /* see https://pevo.example/x */ `UPDATE accounts SET updated_at = NOW()`,';
    expect(scanned(blockTagged)).toContain('`UPDATE accounts SET updated_at = NOW()`');
    expect(statementHead(scanned(blockTagged))?.table).toBe('accounts');
    // An escaped quote does not close the string it sits in, so a comment
    // marker further along that string is still inside it.
    const escaped = "  'UPDATE accounts SET note = \\'//x\\', updated_at = NOW()',";
    expect(scanned(escaped)).toBe(escaped);
    // A statement opened AFTER the assignment cannot own it, so a head to the
    // right of one is not a candidate however near it is.
    expect(
      targetTable(asCode(['  `UPDATE accounts SET updated_at = NOW() WHERE id = $1`, [id]);', '  await pool.query(`UPDATE sessions SET x = 1`);']), 0),
    ).toBe('accounts');
    expect(
      targetTable(asCode(['  `UPDATE accounts SET updated_at = NOW()`, [id]); await pool.query(`UPDATE sessions SET x = 1`);']), 0),
    ).toBe('accounts');
    // Two statements on one line: the assignment belongs to the nearest head
    // to its left, not to the leftmost one.
    const twoStatements = "  `UPDATE bridge_import_queue SET note = 'x'; UPDATE accounts SET custody = 'light', updated_at = NOW()`,";
    expect(targetTable(asCode([twoStatements]), 0)).toBe('accounts');
    expect(statementHead(scanned(twoStatements))?.table).toBe('accounts');
    expect(statementHead(scanned(twoStatements), twoStatements.indexOf('SET note'))?.table).toBe('bridge_import_queue');
    // Both writer scans see a tagged head and neither sees a commented one.
    const tagged: ScannedSource = {
      rel: 'x.ts',
      lines: [
        'async function touch(id: number) {',
        '  await pool.query(',
        '    /* sql */ `UPDATE accounts SET updated_at = NOW() WHERE id = $1`,',
        '    [id],',
        '  );',
        '}',
      ],
    };
    expect(countsOf(accountsColumnWriters(readable([tagged])))).toEqual({ 'x.ts#touch': 1 });
    expect(countsOf(columnAssignments(readable([tagged])).get('accounts') ?? [])).toEqual({ 'x.ts#touch': 1 });
    expect(assembledWrites(readable([tagged]))).toEqual([]);
    const commented: ScannedSource = { rel: 'x.ts', lines: ['  // `UPDATE accounts SET updated_at = NOW()`,'] };
    expect(accountsColumnWriters(readable([commented]))).toEqual([]);
    expect(columnAssignments(readable([commented])).size).toBe(0);
  });

  it('a statement is read to its own terminator: its quote, its semicolon, or the cap', () => {
    // A backtick template: the single quotes inside its SET list do not end it.
    const read = statementAt(asCode(finalize), 0, 9);
    expect(read.lastLine).toBe(5);
    expect(writesColumn(read.text)).toBe(true);
    // A single-quoted one-liner ends at its own quote, not at the sibling query
    // that follows it in the same call.
    const oneLiner = [
      "      'UPDATE accounts SET password_hash = $1 WHERE id = $2',",
      '      [hash, id]),',
      "    pool.query('UPDATE sessions SET updated_at = NOW() WHERE account_id = $1', [id]),",
    ];
    const one = statementAt(asCode(oneLiner), 0, 7);
    expect(one.lastLine).toBe(0);
    expect(writesColumn(one.text)).toBe(false);
    // A literal that opens and closes AHEAD of the keyword inside the same
    // template does not become the delimiter. Taking it would end the read at
    // the next literal in the SET list, short of the assignment, and turn a
    // live writer into a silent pass.
    const cte = ["      `WITH s AS (SELECT 'x' AS v) UPDATE accounts SET custody = 'light', updated_at = NOW() FROM s`,"];
    const withCte = statementAt(asCode(cte), 0, cte[0].indexOf('UPDATE accounts'));
    expect(withCte.quoteAt).toBe(cte[0].indexOf('`'));
    expect(writesColumn(withCte.text)).toBe(true);
    // A migration: no quote opens it, the semicolon ends it, and the interval
    // literal inside it does not.
    const backfill = [
      'UPDATE accounts',
      "  SET updated_at = COALESCE(created_at, NOW() - INTERVAL '1 day')",
      '  WHERE updated_at IS NULL;',
      'ALTER TABLE accounts ALTER COLUMN updated_at SET DEFAULT now();',
    ];
    const migration = statementAt(asCode(backfill), 0, 0);
    expect(migration.lastLine).toBe(2);
    expect(migration.closedAt).toBe(backfill[2].indexOf(';'));
    expect(migration.quoteAt).toBe(-1);
    expect(writesColumn(migration.text)).toBe(true);
    // An unterminated template stops at the cap rather than at the end of the
    // file.
    const runaway = ['`UPDATE accounts', ...Array.from({ length: 60 }, (_, n) => `   SET c${n} = ${n},`)];
    const capped = statementAt(asCode(runaway), 0, 1);
    expect(capped.lastLine).toBe(LITERAL_CAP);
    expect(capped.closedAt).toBe(-1);
    // A semicolon inside a VALUE ends no migration statement: the read carries
    // string state across lines, so the statement is read whole to the real
    // terminator rather than truncated at the value.
    const valued = ['UPDATE accounts', "   SET note = 'ops@pevo.example;archive',", '       updated_at = NOW()', ' WHERE id = 1;'];
    const acrossValue = statementAt(asCode(valued), 0, 0);
    expect(acrossValue.lastLine).toBe(3);
    expect(acrossValue.closedAt).toBe(valued[3].indexOf(';'));
    expect(writesColumn(acrossValue.text)).toBe(true);
    // The escape skip inside `enclosingQuote`. An escaped backtick does not end
    // the template it sits in, so the statement below it is still delimited by
    // the template's own quote. Read without the skip, the enclosing quote is
    // the apostrophe after it, and the read then stops at the next value in the
    // SET list — short of the assignment, which is a silent pass.
    const escapedDelimiter = asCode(["  await q(`SET note = 'a\\`b'; UPDATE accounts SET custody = 'x', updated_at = NOW()`);"]);
    expect(enclosingQuote(escapedDelimiter[0], escapedDelimiter[0].indexOf('UPDATE accounts'))?.char).toBe('`');
    expect(writesColumn(statementAt(escapedDelimiter, 0, escapedDelimiter[0].indexOf('UPDATE accounts')).text)).toBe(true);
    // The comment blank, in both dialects and in neither direction too far:
    // a marker inside a value is left alone, and a decrement is not a comment.
    expect(scanned('UPDATE accounts -- SET updated_at = now()')).toBe('UPDATE accounts' + ' '.repeat(26));
    expect(scanned("SET note = 'a -- b', updated_at = NOW()")).toBe("SET note = 'a -- b', updated_at = NOW()");
    expect(scanned('  for (let i = n; i--; ) touch(i);')).toBe('  for (let i = n; i--; ) touch(i);');
    expect(scanned('  const next = /* skip */ id;')).toBe('  const next = ' + ' '.repeat(10) + ' id;');
  });

  it('the table-first read sees the column in a SET list, an INSERT list and both MERGE branches', () => {
    // Heads, including the lowercase prose that must not be able to hide a
    // real writer behind a case convention, and the names that are not this
    // table.
    expect(ACCOUNTS_STATEMENT_RE.test('      `UPDATE accounts')).toBe(true);
    // The case fold and the default-schema qualifier, each pinned on its own so
    // a rewrite of one line cannot quietly retire the other.
    expect(ACCOUNTS_STATEMENT_RE.test('  `insert into accounts (email)')).toBe(true);
    expect(ACCOUNTS_STATEMENT_RE.test('  `INSERT INTO public.accounts (email)')).toBe(true);
    expect(ACCOUNTS_STATEMENT_RE.test('  `MERGE INTO accounts a')).toBe(true);
    expect(ACCOUNTS_STATEMENT_RE.test('  `UPDATE ONLY accounts')).toBe(true);
    expect(ACCOUNTS_STATEMENT_RE.test('  `SELECT id FROM accounts WHERE username = $1`,')).toBe(false);
    expect(ACCOUNTS_STATEMENT_RE.test('  `UPDATE hafsql.accounts SET updated_at = NOW()`,')).toBe(false);
    expect(ACCOUNTS_STATEMENT_RE.test('  `UPDATE accounts_audit SET updated_at = NOW()`,')).toBe(false);
    // The predicate a back-fill writes is not a write; an assignment behind a
    // subquery's own WHERE still is.
    expect(writesColumn('UPDATE accounts SET custody = $1 WHERE updated_at IS NULL')).toBe(false);
    expect(
      writesColumn('UPDATE accounts SET orcid = (SELECT o FROM b WHERE u = $1), updated_at = NOW() WHERE id = $2'),
    ).toBe(true);
    expect(writesColumn('UPDATE accounts SET (pending_email, updated_at) = (NULL, NOW()) WHERE id = $1')).toBe(true);
    // The column named in an INSERT list is a write with no assignment anywhere
    // in the statement; behind a table alias; laid out one column per line.
    expect(writesColumn('INSERT INTO accounts (email, updated_at) VALUES ($1, now())')).toBe(true);
    expect(writesColumn('INSERT INTO accounts (email, verify_token) VALUES ($1, $2)')).toBe(false);
    expect(writesColumn('INSERT INTO accounts AS a (email, updated_at) VALUES ($1, NOW())')).toBe(true);
    expect(writesColumn('INSERT INTO accounts AS a (email, verify_token) VALUES ($1, $2)')).toBe(false);
    expect(writesColumn('INSERT INTO accounts (\n  email,\n  updated_at\n) VALUES ($1, NOW())')).toBe(true);
    // MERGE: the UPDATE branch by assignment, the INSERT branch by its list.
    expect(writesColumn(statementAt(asCode(merge), 0, 9).text)).toBe(true);
    expect(writesColumn('MERGE INTO accounts a USING s ON s.id = a.id WHEN MATCHED THEN UPDATE SET updated_at = NOW()')).toBe(true);
    expect(
      writesColumn('MERGE INTO accounts a USING s ON s.id = a.id WHEN NOT MATCHED THEN INSERT (email, updated_at) VALUES (s.email, NOW())'),
    ).toBe(true);
    expect(
      writesColumn('MERGE INTO accounts a USING s ON s.id = a.id WHEN NOT MATCHED THEN INSERT (email) VALUES (s.email)'),
    ).toBe(false);
    // The table-first scan, end to end, on each MERGE branch alone.
    const matched: ScannedSource = {
      rel: 'x.ts',
      lines: ['async function touch() {', '  await pool.query(', '    `MERGE INTO accounts a USING s ON s.id = a.id', '     WHEN MATCHED THEN UPDATE SET updated_at = NOW()`,', '  );', '}'],
    };
    const inserted: ScannedSource = {
      rel: 'x.ts',
      lines: ['async function touch() {', '  await pool.query(', '    `MERGE INTO accounts a USING s ON s.id = a.id', '     WHEN NOT MATCHED THEN INSERT (email, updated_at) VALUES (s.email, NOW())`,', '  );', '}'],
    };
    expect(countsOf(accountsColumnWriters(readable([matched])))).toEqual({ 'x.ts#touch': 1 });
    expect(countsOf(columnAssignments(readable([matched])).get('accounts') ?? [])).toEqual({ 'x.ts#touch': 1 });
    expect(countsOf(accountsColumnWriters(readable([inserted])))).toEqual({ 'x.ts#touch': 1 });
  });

  it('routine creation is read in every spelling, keyed by name, and bound by its target', () => {
    const spellings: Array<[string, string]> = [
      ['CREATE TRIGGER accounts_touch BEFORE UPDATE ON accounts', 'TRIGGER accounts_touch'],
      ['CREATE OR REPLACE RULE r AS ON UPDATE TO accounts DO ALSO NOTIFY x', 'RULE r'],
      ['CREATE CONSTRAINT TRIGGER t AFTER INSERT ON accounts', 'TRIGGER t'],
      ['CREATE EVENT TRIGGER audit_ddl ON ddl_command_end', 'TRIGGER audit_ddl'],
      ['CREATE OR REPLACE FUNCTION touch_accounts() RETURNS trigger', 'FUNCTION touch_accounts'],
      ['CREATE PROCEDURE sweep() LANGUAGE plpgsql AS $$', 'PROCEDURE sweep'],
      ['create function "Touch"() returns trigger', `FUNCTION ${UNNAMED_ROUTINE}`],
    ];
    for (const [line, key] of spellings) {
      expect(routineSites(readable([{ rel: 'm.sql', lines: [line] }])).map((routine) => routine.key), line).toEqual([`m.sql#${key}`]);
    }
    expect(ROUTINE_CREATION_RE.test('CREATE TABLE IF NOT EXISTS accounts (')).toBe(false);
    expect(ROUTINE_CREATION_RE.test('CREATE INDEX IF NOT EXISTS accounts_orcid_key ON accounts')).toBe(false);
    // Bound to accounts: a trigger whose target sits on its own line, a rule's
    // `TO`, and neither for another table nor for a function whose body
    // merely names the table.
    const trigger: ScannedSource = {
      rel: 'm.sql',
      lines: ['CREATE TRIGGER accounts_touch', '  BEFORE UPDATE ON accounts', '  FOR EACH ROW EXECUTE FUNCTION touch_accounts();'],
    };
    expect(routineSites(readable([trigger]))[0].boundToAccounts).toBe(true);
    const rule: ScannedSource = { rel: 'm.sql', lines: ['CREATE RULE r AS ON UPDATE TO accounts DO ALSO NOTIFY x;'] };
    expect(routineSites(readable([rule]))[0].boundToAccounts).toBe(true);
    const elsewhere: ScannedSource = {
      rel: 'm.sql',
      lines: ['CREATE TRIGGER t BEFORE UPDATE ON accounts_audit', '  FOR EACH ROW EXECUTE FUNCTION f();'],
    };
    expect(routineSites(readable([elsewhere]))[0].boundToAccounts).toBe(false);
    const body: ScannedSource = {
      rel: 'm.sql',
      lines: ['CREATE OR REPLACE FUNCTION f() RETURNS void AS $$', '  UPDATE accounts SET custody = custody;', '$$ LANGUAGE sql;'],
    };
    expect(routineSites(readable([body]))[0].boundToAccounts).toBe(false);
    // An exemption is exact: it covers one routine in one file, and a name
    // alone covers nothing.
    const twice: ScannedSource[] = [
      { rel: '018_a.sql', lines: ['CREATE OR REPLACE FUNCTION touch_last_seen() RETURNS trigger AS $$'] },
      { rel: '019_b.sql', lines: ['CREATE OR REPLACE FUNCTION touch_last_seen() RETURNS trigger AS $$'] },
    ];
    expect(unexempted(routineSites(readable(twice)), ['018_a.sql#FUNCTION touch_last_seen']).map((routine) => routine.key)).toEqual([
      '019_b.sql#FUNCTION touch_last_seen',
    ]);
    expect(unexempted(routineSites(readable(twice)), ['touch_last_seen'])).toHaveLength(2);
  });

  /** A fixture file's lines wrapped in a handler, so an occurrence resolves to
   *  a named symbol the way a real route's does. */
  const inHandler = (...body: string[]): string[] => [
    'async function touch(id: number) {',
    '  await pool.query(',
    ...body,
    '    [id],',
    '  );',
    '}',
  ];

  /** What the writer scans make of a fixture file. */
  function scansOf(lines: string[], rel = 'x.ts'): { columnFirst: string[]; tableFirst: string[] } {
    const files = readable([{ rel, lines }]);
    return {
      columnFirst: Object.keys(countsOf(columnAssignments(files).get('accounts') ?? [])),
      tableFirst: Object.keys(countsOf(accountsColumnWriters(files))),
    };
  }

  it('every accounts statement can be read whole', () => {
    const unread: string[] = [];
    for (const { rel, lines, code } of [...sources, ...migrations]) {
      code.forEach((line, i) => {
        for (const match of line.matchAll(new RegExp(ACCOUNTS_STATEMENT_RE.source, 'gi'))) {
          if (statementAt(code, i, match.index ?? 0).closedAt === -1) {
            unread.push(`${rel}:${i + 1} — ${lines[i].trim()}`);
          }
        }
      });
    }
    expect(
      unread,
      'an accounts statement whose text runs past the read cap without reaching a terminator. ' +
        'The table-first scan asks whether the statement writes the column, and it can only ' +
        'answer for a statement it read to the end: a column list that closes beyond the cap ' +
        'reads as writing nothing. Shorten the statement, or raise the cap deliberately. ' +
        `Why it matters: ${ORDERING_RATIONALE}\n${unread.join('\n')}`,
    ).toEqual([]);
  });

  it('the reader closes the gaps a statement could otherwise hide in', () => {
    const key = 'x.ts#touch';
    const migration = '018_probe.sql#<module>';
    // Each shape in this list writes accounts.updated_at and was invisible to
    // at least one scan before the feature it names was added.
    const shapes: Array<[string, string[], string[], string]> = [
      [
        'an escaped delimiter inside the template, which must not end the read',
        inHandler('    `UPDATE accounts SET note = \\`x\\`, updated_at = NOW() WHERE id = $1`,'),
        [key],
        'x.ts',
      ],
      [
        'a MERGE against ONLY the table, which the head patterns must still name',
        inHandler('    `MERGE INTO ONLY accounts a USING (SELECT $1::int AS id) s ON s.id = a.id', '     WHEN MATCHED THEN UPDATE SET updated_at = NOW()`,'),
        [key],
        'x.ts',
      ],
      [
        'a MERGE whose SECOND conditional insert branch names the column',
        inHandler('    `MERGE INTO accounts a USING (SELECT $1::text AS email) s ON s.email = a.email', '     WHEN NOT MATCHED AND s.email IS NULL THEN INSERT (email) VALUES (s.email)', '     WHEN NOT MATCHED THEN INSERT (email, updated_at) VALUES (s.email, NOW())`,'),
        [key],
        'x.ts',
      ],
      [
        'a MERGE insert branch masked by a later INSERT that names no column',
        inHandler('    `MERGE INTO accounts a USING (SELECT $1::text AS email) s ON s.email = a.email', '     WHEN NOT MATCHED THEN INSERT (email, updated_at) VALUES (s.email, NOW());', '     INSERT INTO accounts (email) SELECT email FROM staging`,'),
        [key],
        'x.ts',
      ],
      [
        'an INSERT behind a QUOTED table alias',
        inHandler('    `INSERT INTO accounts AS "a" (email, updated_at)', '     VALUES ($1, NOW()) ON CONFLICT (email) DO NOTHING`,'),
        [key],
        'x.ts',
      ],
      [
        'a QUOTED column identifier, which separates the column from its `=`',
        inHandler('    `UPDATE accounts SET "updated_at" = NOW() WHERE id = $1`,'),
        [key],
        'x.ts',
      ],
      [
        'a `--` written flush against the token before it, which SQL still reads as a comment',
        inHandler('    `UPDATE accounts', "        SET verify_token = NULL-- cleared here; the UPDATE sessions sweep is gone", '            , updated_at = NOW()', '      WHERE id = $1`,'),
        [key],
        'x.ts',
      ],
      [
        'a schema qualifier written with spaces around its dot',
        ['UPDATE public . accounts', '   SET updated_at = NOW()', ' WHERE custody = $1;'],
        [migration],
        '018_probe.sql',
      ],
      [
        'a dollar-quoted value carrying the statement terminator',
        ['UPDATE accounts', "   SET institution = $$Universidade do Porto;FCUP$$, updated_at = NOW()", ' WHERE institution = $1;'],
        [migration],
        '018_probe.sql',
      ],
      [
        'a dollar-quoted value carrying a comment marker, which is part of the value',
        ['UPDATE accounts', "   SET institution = $$Porto -- Engenharia$$, updated_at = NOW()", ' WHERE institution = $1;'],
        [migration],
        '018_probe.sql',
      ],
      [
        'a value quoting a TypeScript declaration, which declares nothing here',
        ['UPDATE accounts', "   SET full_name = 'unset, see const updated_at = row.updated_at', updated_at = NOW()", ' WHERE full_name = $1;'],
        [migration],
        '018_probe.sql',
      ],
      [
        'a SECOND statement on one migration line, whose own read ends at its own terminator',
        ['INSERT INTO accounts (email) VALUES ($1); INSERT INTO accounts (email, updated_at) VALUES ($2, NOW());'],
        [migration],
        '018_probe.sql',
      ],
    ];
    for (const [what, lines, expected, rel] of shapes) {
      expect(scansOf(lines, rel).tableFirst, what).toEqual(expected);
    }
    // An upsert sharing a line with a later statement: the rejected `DO UPDATE
    // SET` must not stop the head walk, or the second statement's assignment
    // is attributed to the first statement's table.
    expect(
      scansOf(inHandler('    `INSERT INTO t (a) VALUES (1) ON CONFLICT DO UPDATE SET a = 1; UPDATE accounts SET updated_at = NOW() WHERE id = $1`,')).columnFirst,
    ).toEqual([key]);
    // Two routines on one migration line: both are sites, and the trigger is
    // bound to the table whatever precedes it.
    const twoRoutines = readable([
      {
        rel: '018_probe.sql',
        lines: ['CREATE FUNCTION noop() RETURNS void AS $x$ SELECT 1 $x$ LANGUAGE sql; CREATE TRIGGER accounts_touch BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION touch_accounts();'],
      },
    ]);
    expect(routineSites(twoRoutines).map((routine) => routine.key)).toEqual([
      '018_probe.sql#FUNCTION noop',
      '018_probe.sql#TRIGGER accounts_touch',
    ]);
    expect(routineSites(twoRoutines).filter((routine) => routine.boundToAccounts)).toHaveLength(1);
    // A second write riding on a licensed write's LINE raises the count: the
    // comparison tallies writes, not lines.
    expect(
      countsOf(accountsColumnWriters(readable([{ rel: 'x.ts', lines: ['async function touch(id: number) {', '  await q(`UPDATE accounts SET updated_at = NOW() WHERE id = $1`); await q(`INSERT INTO accounts (email, updated_at) VALUES ($2, NOW())`);', '}'] }]))),
    ).toEqual({ 'x.ts#touch': 2 });
    expect(
      countsOf(columnAssignments(readable([{ rel: 'x.ts', lines: ['async function touch(id: number) {', '  await q(`UPDATE accounts SET updated_at = NOW() WHERE id = $1`); await q(`UPDATE accounts SET updated_at = NOW() WHERE id = $2`);', '}'] }])).get('accounts') ?? []),
    ).toEqual({ 'x.ts#touch': 2 });
    // A parenthesised target, which names the table just as `ONLY` does.
    expect(scansOf(inHandler('    `UPDATE ONLY (accounts) SET updated_at = NOW() WHERE id = $1`,')).tableFirst).toEqual([key]);
    expect(scansOf(inHandler('    `UPDATE ONLY (accounts) SET updated_at = NOW() WHERE id = $1`,')).columnFirst).toEqual([key]);
    // The head patterns, not just the statement pattern, must name the table
    // under `ONLY` and under a spaced qualifier: a head that resolves to a
    // plausible OTHER table satisfies the fail-closed arm instead of tripping
    // it, which is the silent direction.
    expect(scansOf(inHandler('    `MERGE INTO ONLY accounts a USING (SELECT $1::int AS id) s ON s.id = a.id', '     WHEN MATCHED THEN UPDATE SET updated_at = NOW()`,')).columnFirst).toEqual([key]);
    expect(scansOf(['UPDATE public . accounts', '   SET updated_at = NOW()', ' WHERE custody = $1;'], '018_probe.sql').columnFirst).toEqual([migration]);
    // A `--` glued to the token before it is a comment in SQL, and blanking it
    // is what keeps the rest of its line from being read as statement text.
    expect(scansOf(['UPDATE accounts', "   SET verify_token = NULL-- cleared here, and so is the marker: , updated_at = NOW()", '       , updated_at = NOW()', ' WHERE id = 1;'], '018_probe.sql').tableFirst).toEqual([migration]);
    expect(scanned("   SET verify_token = NULL-- cleared", true).trimEnd()).toBe('   SET verify_token = NULL');
    // A `//` is a comment only where TypeScript runs: in SQL, and inside a
    // template, it is ordinary text, and blanking from it erases live SQL.
    expect(scanned('UPDATE accounts SET url = $$a//b$$, updated_at = NOW();', true)).toBe('UPDATE accounts SET url = $$a//b$$, updated_at = NOW();');
    expect(scanned('  `UPDATE accounts SET url = http://x, updated_at = NOW()`,')).toBe('  `UPDATE accounts SET url = http://x, updated_at = NOW()`,');
    expect(scanned('  const u = 1; // UPDATE accounts SET updated_at = NOW()').trimEnd()).toBe('  const u = 1;');
    // An apostrophe in prose on a template line must not leave the template
    // flag inverted for the rest of the file.
    const afterProse = asCode(['  logger.info(`the account\'s marker`);', '  `UPDATE accounts', "      SET verify_token = NULL-- cleared, and the marker with it: updated_at = NOW()", '          , updated_at = NOW()', '    WHERE id = $1`,']);
    expect(afterProse[2].trimEnd()).toBe('      SET verify_token = NULL');
    // The placeholder-builder idiom is not a dollar-quoted span, so comment
    // blanking stays on after it.
    const afterPlaceholder = asCode(['  const p = `$${idx}`;', '  `UPDATE accounts SET a = 1 /* and the marker */ , updated_at = NOW()`,']);
    expect(afterPlaceholder[1]).toContain('              ');
    expect(assignmentIndex(afterPlaceholder[1])).toBeGreaterThan(-1);
    // A bare `;` inside a template ends nothing: only the enclosing quote does.
    const twoInOne = asCode(['  await q(`UPDATE accounts SET custody = $1; SET updated_at = NOW()`);']);
    expect(writesColumn(statementAt(twoInOne, 0, twoInOne[0].indexOf('UPDATE')).text)).toBe(true);
    // A COPY loads the named columns with no assignment and no INSERT keyword.
    expect(scansOf(['COPY accounts (email, updated_at) FROM STDIN;'], '018_probe.sql').tableFirst).toEqual([migration]);
    expect(scansOf(['COPY accounts (email, verify_token) FROM STDIN;'], '018_probe.sql').tableFirst).toEqual([]);
    // An ALTER that rewrites the column, in each spelling that reaches every row.
    const alterations = (lines: string[]): number =>
      accountsColumnAlterations(readable([{ rel: '018_probe.sql', lines }])).length;
    expect(alterations(["ALTER TABLE accounts", "  ALTER COLUMN updated_at TYPE TIMESTAMPTZ", "  USING (updated_at AT TIME ZONE 'UTC');"])).toBe(1);
    expect(alterations(['ALTER TABLE accounts RENAME COLUMN touched_at TO updated_at;'])).toBe(1);
    expect(alterations(['ALTER TABLE accounts DROP COLUMN updated_at;'])).toBe(1);
    expect(alterations(['ALTER TABLE accounts ADD COLUMN pending_email TEXT;'])).toBe(0);
    expect(alterations(['ALTER TABLE sessions ALTER COLUMN updated_at TYPE TIMESTAMPTZ;'])).toBe(0);
    // A pre-decrement is an operator, not a comment, so it blanks nothing.
    expect(scansOf(['async function touch(n: number, id: number) {', '  let left = n;', "  if (--left === 0) await q('UPDATE accounts SET updated_at = NOW() WHERE id = $1', [id]);", '}']).tableFirst).toEqual(['x.ts#touch']);
    expect(scanned('  if (--left === 0) touch();')).toBe('  if (--left === 0) touch();');
    expect(scanned('  for (let i = n; i--; ) touch(i);')).toBe('  for (let i = n; i--; ) touch(i);');
    // A dollar-quoted value inside a TEMPLATE is a value: a comment marker in
    // it is part of the statement, and blanking from it would erase the write.
    expect(scansOf(inHandler('    `UPDATE accounts SET note = $$a -- b$$, updated_at = NOW() WHERE id = $1`,')).tableFirst).toEqual([key]);
    // A MERGE whose target is parenthesised is still the accounts table to the
    // head patterns, not a table named after the word before it.
    expect(scansOf(inHandler('    `MERGE INTO ONLY (accounts) a USING (SELECT $1::int AS id) s ON s.id = a.id', '     WHEN MATCHED THEN UPDATE SET updated_at = NOW()`,')).columnFirst).toEqual([key]);
    // A block comment opened inside a template must close inside it, and one
    // opened in code must close within the reader's reach; neither may blank
    // an accounts write that follows.
    const globThenWrite = asCode(['  const keys = `${prefix}:sessions/*`;', '  await q(`UPDATE accounts SET updated_at = NOW() WHERE id = $1`);', '  /* an ordinary comment further down the file */']);
    expect(statementHead(globThenWrite[1])?.table).toBe('accounts');
    // A block comment is a comment however FAR its closer sits, and an opener
    // with no closer anywhere is not one. Both counts are LITERAL: derived from
    // whatever bound the reader holds they move with it and pin nothing, which
    // is how a bound shorter than the docblocks in this tree stayed unnoticed
    // while seventeen of them were read as live source.
    const farClose = asCode(['  /* an opener whose closer is a long way down', ...Array.from({ length: 400 }, () => '  filler'), '  */']);
    expect(farClose[1].trim()).toBe('');
    expect(farClose[400].trim()).toBe('');
    const neverCloses = asCode(['  const keys = `${prefix}:sessions/*`;', ...Array.from({ length: 400 }, () => '  filler')]);
    expect(neverCloses[1]).toBe('  filler');
    expect(neverCloses[400]).toBe('  filler');
    // That fixture answers on the template arm — the search stops at the
    // backtick before it can run off the end — so the no-closer-anywhere
    // refusal itself is pinned here, outside a template, where reaching the end
    // of the file IS the answer.
    const filler = Array.from({ length: 400 }, () => '  filler');
    expect(blockCloses(['  /* an opener with no closer anywhere', ...filler], 0, 2, false)).toBe(false);
    expect(blockCloses(['  /* an opener whose closer is a long way down', ...filler, '  */'], 0, 2, false)).toBe(true);
    // A dollar tag is any identifier PostgreSQL accepts, not only an ASCII one,
    // and an identifier is what it has to be: the tag rules are the unquoted
    // identifier rules minus the dollar sign.
    expect(scansOf(['UPDATE accounts', "   SET note = $não$x -- y$não$, updated_at = NOW()", ' WHERE id = 1;'], '018_probe.sql').tableFirst).toEqual([migration]);
    // A parameter placeholder PAIR is not an opener, in either spelling this
    // tree writes it. Read as one it opens a span whose tag never recurs, and a
    // span that never closes switches comment blanking off to the end of the
    // file — which silences every scan together rather than one of them. The
    // write below each opener carries its comment in the gap a pattern needs,
    // so it is seen only while blanking is still on.
    const gapped = '  await q(`UPDATE accounts SET custody = $1, updated_at /* the server clock */ = NOW()`, [id]);';
    expect(scansOf(['async function touch(id: number) {', '  await q(`INSERT INTO staging (a, b) VALUES ($1,$2)`, [id]);', gapped, '}']).tableFirst).toEqual([key]);
    expect(scansOf(['async function touch(id: number) {', '  const named = body.replace(re, `${prefix}$1`);', gapped, '}']).tableFirst).toEqual([key]);
    // And a grammatical tag that never recurs opens nothing either: a span that
    // cannot close is not a span, the same answer `blockCloses` gives.
    expect(scansOf(['async function touch(id: number) {', '  await q(`SELECT $tag$ AS sigil`, [id]);', gapped, '}']).tableFirst).toEqual([key]);
    expect(DOLLAR_QUOTE_RE.test('$$')).toBe(true);
    expect(DOLLAR_QUOTE_RE.test('$body$')).toBe(true);
    expect(DOLLAR_QUOTE_RE.test('$não$')).toBe(true);
    expect(DOLLAR_QUOTE_RE.test('$1,$2)')).toBe(false);
    expect(DOLLAR_QUOTE_RE.test('${prefix}$1')).toBe(false);
    expect(DOLLAR_QUOTE_RE.test('$t-1$')).toBe(false);
    // Inside a routine or `DO` body a comment is a comment: the body is source,
    // not data, so a marker in a token gap silences the same patterns there as
    // anywhere else. Two migrations already carry an anonymous block wrapping
    // ordinary DDL.
    expect(
      scansOf(['DO $$', 'BEGIN', '  UPDATE accounts', '     SET custody = $1,', '         updated_at -- the server clock, never a client value', '           = NOW();', 'END $$;'], '018_probe.sql').tableFirst,
    ).toEqual([migration]);
    expect(
      scansOf(['CREATE OR REPLACE FUNCTION f() RETURNS void AS $$', 'BEGIN', '  UPDATE accounts SET custody = $1, updated_at /* stamped */ = NOW();', 'END $$ LANGUAGE plpgsql;'], '018_probe.sql').tableFirst,
    ).toEqual([migration]);
    // And a VALUE body is still data: the same marker there is one of its
    // characters, and blanking it would erase live SQL.
    expect(scansOf(['UPDATE accounts', "   SET institution = $$Porto -- Engenharia$$, updated_at = NOW()", ' WHERE institution = $1;'], '018_probe.sql').tableFirst).toEqual([migration]);
    // A literal NESTED inside a code body is data again. Read as more body, its
    // own `--` is taken for a comment and blanks the rest of the line, which
    // erases the live statement beside it — a write present in the tree and
    // seen by nothing.
    expect(
      scansOf(['DO $$', 'BEGIN', "  EXECUTE $q$SELECT 1 -- ignored$q$; UPDATE accounts SET custody = 'self', updated_at = NOW();", 'END $$;'], '018_probe.sql').tableFirst,
    ).toEqual([migration]);
    expect(
      scansOf(['DO $$', 'BEGIN', '  EXECUTE $q$SELECT 1', "  -- still inside the value$q$; UPDATE accounts SET custody = 'self', updated_at = NOW();", 'END $$;'], '018_probe.sql').tableFirst,
    ).toEqual([migration]);
    // Body or value is judged from BLANKED text, in both directions, because
    // both errors are silent. A comment after the keyword must not hide it:
    expect(
      scansOf(['CREATE OR REPLACE FUNCTION f() RETURNS void AS -- see the header', '$$', 'BEGIN', '  UPDATE accounts SET custody = $1, updated_at /* stamped */ = NOW();', 'END', '$$ LANGUAGE plpgsql;'], '018_probe.sql').tableFirst,
    ).toEqual([migration]);
    // and SQL prose ending in one of the keywords must not supply one, or the
    // value below it is blanked as code and its `--` erases the write:
    expect(
      scansOf(['UPDATE accounts SET note = -- the value is stored exactly as', '$$a -- b$$, updated_at = NOW();'], '018_probe.sql').tableFirst,
    ).toEqual([migration]);
    expect(
      scansOf(['UPDATE accounts SET note = -- nothing else to do', '$$a -- b$$, updated_at = NOW();'], '018_probe.sql').tableFirst,
    ).toEqual([migration]);
    // A span with no keyword before it anywhere is a value: the default is what
    // keeps every ordinary literal's characters out of the comment handling.
    expect(asCode(['$$a -- b$$'], true)[0]).toBe('$$a -- b$$');
    // The keyword test, clause by clause: the case fold, the word boundary that
    // keeps `HAS` out, and the end anchor that keeps a mid-line `AS` out.
    expect(DOLLAR_CODE_BODY_RE.test('DO ')).toBe(true);
    expect(DOLLAR_CODE_BODY_RE.test('do ')).toBe(true);
    expect(DOLLAR_CODE_BODY_RE.test('CREATE FUNCTION f() RETURNS void AS ')).toBe(true);
    expect(DOLLAR_CODE_BODY_RE.test('  SET x = has ')).toBe(false);
    expect(DOLLAR_CODE_BODY_RE.test('  SET a = 1 AS alias, b = ')).toBe(false);
    // A dollar span is read where SQL runs, not in ordinary TypeScript: a pair
    // of `$`-fenced identifiers in code would otherwise span the statement
    // between them and switch its blanking off.
    const outsideTemplate = asCode([
      '  const tag = $body$;',
      '  await q(`UPDATE accounts SET custody = $1, updated_at /* stamped */ = NOW()`);',
      '  const end = $body$;',
    ]);
    expect(assignmentIndex(outsideTemplate[1])).toBeGreaterThan(-1);
    // Each assignment is resolved from its OWN position: two writes on one
    // line belong to the head each one sits after, not both to the first.
    expect(
      countsOf(columnAssignments(readable([{ rel: 'x.ts', lines: ['async function touch(id: number) {', '  await q(`UPDATE sessions SET updated_at = NOW()`); await q(`UPDATE accounts SET updated_at = NOW()`);', '}'] }])).get('accounts') ?? []),
    ).toEqual({ 'x.ts#touch': 1 });
    // A sibling query that opened AND CLOSED to the left of an unreadable head
    // on the same line does not lend it a table: only a statement that reaches
    // the assignment can own it.
    expect(
      targetTable(asCode(['  await q(`UPDATE sessions SET a = 1`); await q(`UPDATE "accounts" SET updated_at = NOW()`);']), 0),
    ).toBe(UNRESOLVED_TABLE);
    // An interpolated statement sharing a line with a spelled one is still
    // reported: the assembled scan reads every head on the line.
    expect(
      assembledWrites(readable([{ rel: 'x.ts', lines: ['async function touch() {', '  await q(`UPDATE accounts SET custody = $1`); await q(`UPDATE accounts SET ${fragment}`);', '}'] }])).map((w) => w.how),
    ).toEqual(['interpolation']);
    // The occurrence COUNT, not just the key set: a second write inside a
    // symbol that already holds one is a new member of the comparison.
    expect(
      countsOf(accountsColumnWriters(readable([{ rel: 'x.ts', lines: inHandler('    `UPDATE accounts SET updated_at = NOW() WHERE id = $1`,', '    `UPDATE accounts SET updated_at = NOW() WHERE id = $2`,') }]))),
    ).toEqual({ 'x.ts#touch': 2 });
    // A migration INSERT that names the column, which carries no assignment
    // anywhere and so is the table-first scan's alone to see.
    expect(scansOf(['INSERT INTO accounts (email, updated_at) VALUES ($1, now());'], '018_probe.sql')).toEqual({
      columnFirst: [],
      tableFirst: [migration],
    });
    // And a statement no read can finish is refused rather than cleared: a
    // column list closing beyond the cap reads as writing nothing.
    const overlong = ['INSERT INTO accounts (', ...Array.from({ length: LITERAL_CAP + 2 }, (_, n) => `  c${n},`), '  updated_at', ') VALUES ($1);'];
    expect(statementAt(asCode(overlong, true), 0, 0).closedAt).toBe(-1);
  });

  it('a comment cannot sit between two tokens a pattern needs adjacent', () => {
    // Every shape in this list writes accounts.updated_at and places an
    // ordinary comment where a pattern needs two tokens together. Each was a
    // silent pass before comments were blanked, and each defeats several scans
    // at once, because the writer scans share these patterns.
    const key = 'x.ts#touch';
    const gaps: Array<[string, string[]]> = [
      [
        'between the column and its `=`, in SQL',
        inHandler('    `UPDATE accounts', '        SET custody = $1,', '            updated_at -- server clock, never client-supplied', '              = NOW()', '      WHERE id = $2`,'),
      ],
      [
        'between the column and its `=`, in a block comment on one line',
        inHandler('    `UPDATE accounts SET custody = $1, updated_at /* server clock */ = NOW() WHERE id = $2`,'),
      ],
      [
        "between a row target list's `)` and its `=`",
        inHandler('    `UPDATE accounts', '        SET (pending_email, updated_at)', '            -- the pending change and the marker are cleared as one', '            = (NULL, NOW())', '      WHERE id = $1`,'),
      ],
      [
        'inside a row target list, carrying parentheses of its own',
        inHandler('    `UPDATE accounts SET (pending_email, /* and NOW() for */ updated_at) = (NULL, NOW()) WHERE id = $1`,'),
      ],
      [
        'inside an INSERT column list, carrying a parenthesis of its own',
        inHandler('    `INSERT INTO accounts (', '       email,       /* the primary (login) address */', '       updated_at', '     ) VALUES ($1, NOW())`,'),
      ],
      [
        'carrying a semicolon in prose, which would otherwise end the statement',
        inHandler('    `UPDATE accounts', '        SET custody = $1,', '            -- stamped here; the session re-key runs later', '            updated_at = NOW()', '      WHERE id = $2`,'),
      ],
      [
        'naming another table, which would otherwise supply a nearer head',
        inHandler('    `UPDATE accounts', '        SET custody = $1,', '            -- supersedes the UPDATE sessions sweep that used to stamp here', '            updated_at = NOW()', '      WHERE id = $2`,'),
      ],
      [
        'ahead of the statement, naming one, which would otherwise drop the line',
        inHandler('    /* mirrors the INSERT INTO accounts upsert in POST /signup */ `UPDATE accounts', '        SET custody = $1, updated_at = NOW()', '      WHERE id = $2`,'),
      ],
    ];
    for (const [what, lines] of gaps) {
      expect(scansOf(lines).tableFirst, what).toEqual([key]);
    }
    // The same gaps in a migration, where a back-fill that bumps the marker is
    // the hazard, and where `--` prose is written in quantity.
    const backfills: Array<[string, string[]]> = [
      ['a `--` gap', ['UPDATE accounts', "   SET custody = 'self',", '       updated_at -- the repair is a row mutation like any other', '         = NOW()', ' WHERE upgraded_at IS NOT NULL;']],
      ['a block-comment gap', ['UPDATE accounts', "   SET (pending_email, updated_at) /* cleared together */ = (NULL, NOW())", ' WHERE pending_email IS NOT NULL;']],
      ['a semicolon in prose', ['UPDATE accounts', '   SET custody = $1, -- stamped here; the sweep runs later', '       updated_at = NOW();']],
    ];
    for (const [what, lines] of backfills) {
      expect(scansOf(lines, '018_probe.sql').tableFirst, what).toEqual(['018_probe.sql#<module>']);
    }
    // A comment ahead of a routine's own keyword, naming another routine, must
    // not drop the live one: the routine arm is the only catcher of a trigger
    // body, which no column pattern reads.
    const commentedRoutine = readable([
      {
        rel: '018_probe.sql',
        lines: [
          '/* supersedes CREATE FUNCTION touch_accounts_v1 */ CREATE OR REPLACE FUNCTION touch_accounts() RETURNS trigger AS $$',
          'BEGIN NEW.updated_at := now(); RETURN NEW; END $$ LANGUAGE plpgsql;',
          '/* supersedes CREATE TRIGGER accounts_touch_v1 */ CREATE TRIGGER accounts_touch',
          '  BEFORE UPDATE ON accounts',
          '  FOR EACH ROW EXECUTE FUNCTION touch_accounts();',
        ],
      },
    ]);
    expect(routineSites(commentedRoutine).map((routine) => routine.key)).toEqual([
      '018_probe.sql#FUNCTION touch_accounts',
      '018_probe.sql#TRIGGER accounts_touch',
    ]);
    expect(routineSites(commentedRoutine).filter((routine) => routine.boundToAccounts)).toHaveLength(1);
    // And what blanking must NOT do: a marker inside a value is part of the
    // statement, not a comment, so blanking it would erase live SQL.
    expect(scansOf(inHandler("    `UPDATE accounts SET note = 'ops@pevo.example;archive', updated_at = NOW() WHERE id = $1`,")).tableFirst).toEqual([key]);
    expect(scansOf(inHandler("    `UPDATE accounts SET avatar = 'https://cdn.example/a.png', updated_at = NOW() WHERE id = $1`,")).tableFirst).toEqual([key]);
    expect(scansOf(inHandler("    `UPDATE accounts SET note = 'a -- b', updated_at = NOW() WHERE id = $1`,")).tableFirst).toEqual([key]);
  });

  it('an assembled accounts write is read by its interpolation or by its join', () => {
    expect(SQL_INTERPOLATION_RE.test('SET updated_at = NOW() ${recencyFragment}')).toBe(true);
    expect(SQL_INTERPOLATION_RE.test('SET verify_token = $1, expires_at = $2')).toBe(false);
    const how = (lines: string[]): string[] => assembledWrites(readable([{ rel: 'x.ts', lines }])).map((write) => write.how);
    expect(how(['  `UPDATE accounts SET custody = $1, ${recency} WHERE id = $2`,'])).toEqual(['interpolation']);
    // A `+` after the closing quote, before the opening quote, and leading the
    // next line.
    expect(how(["  'UPDATE accounts SET custody = $1, ' + recency + ' WHERE id = $2',"])).toEqual(['concatenation']);
    expect(how(["  recency + 'UPDATE accounts SET custody = $1 WHERE id = $2',"])).toEqual(['concatenation']);
    expect(how(["  'UPDATE accounts SET custody = $1, '", '    + recency,'])).toEqual(['concatenation']);
    // Spelled-out statements, one-line and multi-line, are not assembled.
    expect(how(["  'UPDATE accounts SET custody = $1 WHERE id = $2',", '  [custody, id],'])).toEqual([]);
    expect(how(['  `UPDATE accounts', "   SET custody = 'light', updated_at = NOW()", '   WHERE id = $1`,'])).toEqual([]);
    // A read that never reached a terminator has no "after the closing quote"
    // text at all. Taking the whole last line for it reads an ordinary
    // continuation as the join and reports a concatenation that is not there;
    // the unterminated statement itself is the separate red bar.
    expect(how(['  `UPDATE accounts SET custody = $1', '  + fragment'])).toEqual([]);
  });
});
