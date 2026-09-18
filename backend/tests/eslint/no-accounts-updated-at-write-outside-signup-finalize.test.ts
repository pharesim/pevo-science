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
 * `verify_token IS NULL`, so a row the branch has touched is invisible to both
 * until some later statement clears the token.
 *
 * That second one is a delay, not a barrier, and the difference matters because
 * the barrier reading names the wrong term as load-bearing. THREE statements
 * clear the token, not two: the two finalizes, and the settings email-verify
 * route in `routes/settings.ts`, which clears it on whatever row carries the
 * link's token with no custody, username or marker in its own SET list. So a
 * row can leave the branch's hiding place without a finalize ever running on
 * it. What keeps such a row out of the two lookups is `custody`, and `custody`
 * alone. Both statements key on a random hex `verify_token`, which is state E
 * and state G and nothing else (ARCHITECTURE.md section 6.1: a finalized row
 * carries NULL, a verify-clicked one a `confirmed:` prefix), and both of those
 * carry `custody` NULL, since no INSERT in the tree names the column. A row
 * that never reached a finalize fails `= 'light'` and `= 'self'` alike.
 *
 * The clearer cannot reach a FINALIZED light row at all, which is worth
 * spelling out because the reverse reads plausible. Such a row carries
 * `verify_token` NULL, so the clearer's own lookup, which selects BY the token,
 * never finds it. The settings add flow that writes a token INSERTs only where
 * the username has no row, so an account that already has one takes the change
 * flow instead, and that flow writes `pending_email_token` and never names
 * `verify_token`. And nothing puts a hex token back afterwards: the signup
 * upsert answers 409 on a NULL token, the resend route returns before its
 * UPDATE, and the verify-link handler selects by a token the row must already
 * hold. State G is the row the third clearer reaches.
 *
 * The marker is what bounds the rows `custody` DOES let through, which are the
 * finalized light and upgraded rows the two finalizes stamped and nothing else
 * touches. Leaving `updated_at` out of the upsert branch, and out of the
 * settings clearer, is what keeps both of them out of that writer set, so that
 * neither can move a marker if either is later rescoped to a row `custody`
 * admits. Symmetrising either of them to touch every column is the shape this
 * canary exists to stop. That the upsert can overwrite a finalized state G row
 * at all is a separate defect in `POST /signup`, tracked on its own; it is not
 * what this scan guards.
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
 *     The assignment it carries reds under the fail-closed arm instead, and
 *     that backstop is what the limit rests on — but only because the statement
 *     read refuses to resolve a table it cannot reach its own terminator from.
 *     "No readable head reaches it" is not a property of the shape, it is a
 *     property of the read: the `EXECUTE format` spelling puts the nearest head
 *     inside a dollar-quoted literal, and a read that derived its spans from
 *     its own starting position took that literal's closing tag for an opener,
 *     ran past the statement's semicolon, and lent the write below it a
 *     plausible other table. {@link SpanEvent} is what holds the backstop up.
 *     It holds only while the COLUMN is spelled: make both identifiers
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
 *     that shape carries no assignment token. The SET-list form of the same
 *     shape reds by resolution instead, but only where no readable head opens
 *     earlier in the same quoted text: a statement read ends at the quote that
 *     encloses it, a backtick or an ordinary `'`, rather than at a `;`, so a
 *     sibling statement read from that head reaches the assignment and lends it
 *     its own table, silently.
 *     The reverse error is the tolerable one and is not chased:
 *     a line inside a block comment that carries no leading `*`, or an odd
 *     quote in a line of prose, is read as live SQL and can only cost a red
 *     bar on a statement that was never live.
 *   - The ALTER head anchors on the keyword `TABLE`, and that is not the only
 *     keyword reaching an ordinary table. `ALTER MATERIALIZED VIEW accounts
 *     RENAME COLUMN touched_at TO updated_at`, and the same statement spelled
 *     `ALTER VIEW` or `ALTER FOREIGN TABLE`, are each accepted against an
 *     ordinary table on PostgreSQL 16. Every OTHER form of those three is
 *     refused for the wrong relkind — `DROP COLUMN` under all three, and
 *     `ALTER COLUMN ... TYPE` under `FOREIGN TABLE` — so `RENAME COLUMN` is the
 *     single form that reaches, and it is exactly the one that moves another
 *     column onto the name. None is a spelling an author reaches for by
 *     accident, so the keyword stays narrow and the shape is recorded here
 *     rather than admitted: it is deliberate-evasion class, which this file's
 *     threat model does not chase.
 *   - The column carries a `DEFAULT now()`, so every INSERT stamps it without
 *     naming it. That is not a hazard and is not scanned for, but the reason is
 *     `custody` rather than anything about the marker: each lookup conjoins a
 *     custody value no INSERT writes (`= 'light'` for `/confirm`, which also
 *     wants `posting_key_enc IS NOT NULL`, and `= 'self'` for `/link`), and no
 *     INSERT in the tree names the column at all, so a row arrives carrying
 *     NULL and fails both however fresh its stamp is. What the reason is NOT is
 *     that a row being inserted has yet to be finalized. A row can reach the
 *     finalized-LOOKING predicate — `verify_token` cleared, `username` set —
 *     with no finalize ever having run on it, which is state G in
 *     ARCHITECTURE.md section 6.1, and what refuses that row is the custody
 *     filter too.
 *   - Text that only LOOKS like a comment or a value to the reader, where the
 *     shape is not one this tree writes: a backslash escape inside an
 *     `E'...'` string, a `--` glued on both sides in TypeScript code outside a
 *     template. Each blanks a span that was live, so each is a silent miss
 *     rather than a red bar, which is why the reader errs toward reading
 *     wherever it can: an unclosed comment opener is text, a value keeps its
 *     markers, and a decrement is an operator.
 *   - A regex literal is told from a division by the code before its slash
 *     ({@link regexLiteralEnd}): after an OPERAND the slash divides, and after
 *     a keyword ({@link PATTERN_KEYWORD_RE}) or anything else it opens a
 *     pattern that must end on its own line. An operand ends in a name
 *     character, a digit, or a closing `)`, `]`, `}`, quote or backtick, and
 *     may carry a postfix `!`, `++` or `--`; a slash leading its line is
 *     judged from the previous line carrying code, since the language inserts
 *     no semicolon before one. What is left misjudged is a pattern that OPENS
 *     a statement
 *     after a closing paren (`if (ready) /x/.test(v)`) or after a keyword this
 *     list does not carry, which reads as a division and leaves a quote inside
 *     the pattern opening a value; and a division after an operand spelling
 *     the list does not carry, which reads as a pattern. Neither tree spells
 *     either, and the second is the one that costs: the pattern runs to the
 *     next slash on the line, which is routinely a `//` opener, after which
 *     the comment's own prose is read as code and a path glob in it opens a
 *     block comment over the lines below.
 *   - A string VALUE that spans lines is read as code from its second line
 *     on BY THE BLANKING, because the value state resets at each line while the
 *     block, template and dollar states do not. The reset is what keeps one
 *     unbalanced quote in prose from blanking the rest of a file, and no value
 *     in either tree spans lines. Where that shape appears, a comment marker on
 *     the continuation line blanks live SQL, so the residual is a silent one
 *     and is named here rather than left to be found. The STATEMENT read
 *     resets the same way but does not read on: a line ending mid-value stops
 *     it with no terminator, so the statement resolves no table and is reported
 *     by line instead. The two readers therefore diverge here on purpose, and
 *     only here — see {@link statementAt}. It is also the one shape that can
 *     supply the body keyword from a VALUE: the keyword test is END-ANCHORED,
 *     so a closed value cannot
 *     (`SET note = 'stored exactly as'` ends in its own quote and matches
 *     nothing), but a value left OPEN at the end of a line can
 *     (`SET note = 'stored exactly as`), and a span on the next line then reads
 *     as a body with its own markers blanked.
 *   - The body-or-value judgement at a dollar-quote opener has residuals of its
 *     own. It is made from the keyword before the opener, and every line it
 *     consults is a BLANKED one — the opener's own line up to that point, and
 *     the previous non-blank line when the opener leads its line (`... AS` on
 *     one line, `$$` on the next) — so a comment can neither supply the keyword
 *     nor hide it. What can still supply one is an unterminated string value,
 *     folded into the multi-line-value residual above. A clause between the
 *     keyword and the opener hides it the other way: `DO LANGUAGE plpgsql $$`
 *     is a body this test does not see, so its comments are copied like a
 *     value's and the comment-gap class is open inside it. Neither tree spells
 *     either shape.
 *   - A literal NESTED inside a body is read as the source it is: the body
 *     EXECUTEs it, so its comments are blanked like the body's own. Two bounds
 *     make that safe, and neither is optional. A `--` blanks only as far as the
 *     INNERMOST open tag, because the characters past that tag belong to the
 *     literal's enclosing body again and are routinely the live statement
 *     beside it. And quoting is tracked at every depth, so a marker that is a
 *     CHARACTER of a string value in that SQL — the `--` in a
 *     separator-normalising `regexp_replace`, the `/*` in a marker-stripping
 *     `replace` — is not a comment at all. Without the second bound an ordinary
 *     back-fill blanks its own `updated_at = NOW()`, which is a silent pass
 *     rather than a red bar. The residual left is the other direction: a nested
 *     literal that is pure DATA, a `RAISE NOTICE` message rather than a
 *     statement to execute, still has a genuine comment marker of its own
 *     blanked, which can only hide a write spelled inside a string nothing
 *     executes.
 *   - The two dialects disagree at one opener, and each is right in its own
 *     file. `${` is a template interpolation in TypeScript, so `` `$${n}` `` is
 *     the placeholder-builder idiom and opens nothing; in a migration the same
 *     characters are an ordinary dollar-quoted literal whose content begins
 *     with a brace, which is how an array literal is written and the usual
 *     reason to reach for dollar quoting at all. The dialect is the blanking
 *     reader's own `sql` argument, and the statement read replays the spans
 *     that reader recorded rather than judging openers again, so the two
 *     readers cannot answer differently. What is NOT
 *     covered is SQL held in a `.ts` file that spells a brace-leading literal:
 *     the TypeScript answer wins there, and it is the right one, since the
 *     interpolation would have run before PostgreSQL ever saw the text.
 *   - An interpolation is copied whole ({@link interpolationEnd}), so nothing
 *     inside one is a delimiter, a comment marker or a quote for any arm
 *     outside it. Two residuals come with that. One that SPANS LINES is not
 *     recognised at all and is read flat, as it was before, since copying to
 *     the end of a line would blank live code; neither tree spells one. And a
 *     write spelled INSIDE an interpolation is copied rather than read, which
 *     no arm then sees — a shape that would mean building a statement out of
 *     the expression interpolated into another statement. The brace-depth half
 *     of the close is not discriminable by any fixture: ended early at a `}`
 *     of its own, what an interpolation leaves behind is `)`-shaped text that
 *     every arm reads inertly, in every shape tried (an object literal, one
 *     carrying a quoted value, a nested template, a comment). The QUOTING half
 *     is pinned, because a `}` inside a string leaves the quote behind it
 *     open.
 *   - The scans read the shapes an author writes by accident, not the ones an
 *     author writes to evade a test. A writer determined to get past them can.
 *
 * A NOTE ON REUSE. `sourcesUnder` and `enclosingSymbol` come from the shared
 * support module. The reading does not. The joined-statement helper in the
 * custody-claim canary is tuned for TypeScript expressions and caps its join
 * at four lines, and what that bound does here depends on which head a scan
 * anchors on. Measured over every candidate head rather than reasoned about:
 * from the `/confirm` handler's `await pool.query(` the marker is not reached at
 * all, one line past the cap; from that statement's own template head it lands
 * on the FOURTH and last joined line, zero slack; the `/link` heads reach it
 * with one and two lines to spare. So the helper reaches the shape from three of
 * four heads, and the tightest of those has nothing left. One more SET line, or
 * a reordering that moves the marker down, puts that head out of range —
 * silently, since a join that stops short reports a statement that writes
 * nothing. A bound that happens to fit is not a bound that holds, and the reach
 * here is delimited by
 * what an SQL statement actually ends at instead, its own string quote in
 * TypeScript and its semicolon in a migration, with dollar-quoted spans carried
 * across lines so a semicolon inside one ends nothing. The comment handling is
 * the half that could not be shared at any bound. The
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
 *  string is untouched.
 *
 *  The pattern ends at the keyword and is END-ANCHORED, because it is tested
 *  against the slice that STOPS at the column rather than one that runs past
 *  it. A pattern free to match anywhere in the text ahead is a VETO: the
 *  characters `const updated_at =` occurring LATER — in a string value, in
 *  prose the blanking left alone — switch detection off for a real write that
 *  came first, and both writer walks go quiet together, which is the one
 *  direction this file cannot afford. Anchoring is also what lets the column's
 *  own `\s*` before the `=` admit any run of whitespace: whatever sits between
 *  the column and its sign is on the far side of the slice and cannot reach
 *  this pattern at all.
 *
 *  The whitespace class excludes a NEWLINE for the same reason the pattern is
 *  anchored. {@link writesColumn} reads a whole statement, whose lines are
 *  joined, so a plain `\s` lets a keyword ending one line veto a write opening
 *  the next — text that is a declaration in no dialect, and a veto is the
 *  silent direction. No TypeScript in the tree splits a declaration across the
 *  line, and a scan that missed one would only cost a red bar. */
const TYPESCRIPT_LOCAL_RE = /\b(?:const|let|var)[^\S\n]+$/;

/** How far BACK {@link assignmentIndex} looks for a declaration keyword when
 *  deciding whether a match is a TypeScript local: far enough to hold the
 *  longest keyword and the whitespace after it, and no farther.
 *
 *  With the pattern anchored at the column, the bound no longer holds the veto
 *  off — the anchor does that — so what it decides is how much whitespace may
 *  separate a keyword from the name it declares. Both ends of that are the
 *  tolerable direction: a declaration spaced out past the bound is read as a
 *  write and costs a red bar on a line that writes nothing, and widening it
 *  only admits a longer run of pure whitespace, which no value spells. */
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
    // The local-declaration exclusion is scoped to the match it precedes, by
    // reading the slice that ENDS at the column against an end-anchored
    // keyword. A slice running PAST the column, tested against an unanchored
    // pattern, is a veto instead: the declaration characters occurring later in
    // the same text switch detection off for a real write that came first.
    if (TYPESCRIPT_LOCAL_RE.test(text.slice(Math.max(0, at - LOCAL_DECLARATION_BEFORE), at))) continue;
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
 *  to refuse, and none of them is an UPDATE, an INSERT or a MERGE.
 *
 *  The head carries three optional groups, spelled in the order PostgreSQL's
 *  own grammar puts them: `IF EXISTS`, then `ONLY`, then the schema qualifier.
 *  Those positions were read off a live server rather than reasoned about:
 *  `ALTER TABLE ONLY IF EXISTS accounts` is rejected as a syntax error, and so
 *  is `ALTER TABLE (accounts)`. What makes the positions PINS rather than
 *  claims is the fixture set: one line per group, plus one carrying all three
 *  at once, which is the only spelling a reordering can be caught by.
 *
 *  `IF EXISTS` is admitted because a drop or a retype of the column carried
 *  behind it is the very statement this arm exists to refuse. No ALTER head in
 *  this tree spells it: every one is bare, and idempotency here is written at
 *  the column (`ADD COLUMN IF NOT EXISTS`), at the constraint (`DROP
 *  CONSTRAINT IF EXISTS`) or inside a `DO` block. The reason for admitting it
 *  is therefore forward-looking rather than observed. The idempotent house
 *  style invites the clause, and the arm should already see it when the first
 *  one lands rather than start seeing it one migration later.
 *
 *  The parenthesised target rides INSIDE the `ONLY` group, where the DML heads
 *  keep it outside their own, because `ONLY ( accounts )` is the whole of what
 *  PostgreSQL accepts here: a bare `ALTER TABLE (accounts)` does not parse.
 *  Hoisting it out would admit a statement no server runs, which is a widening
 *  that loses nothing, so nothing pins it in. The space after `ONLY` is
 *  optional because `ONLY(accounts)` parses too.
 *
 *  That group is spelled as two alternatives with the paren REQUIRED in one of
 *  them, rather than as the shorter `ONLY\s*\(?\s*` with an optional one, and
 *  the reason is cost rather than grammar: the two admit exactly the same
 *  statements, but an optional paren sitting between two unbounded whitespace
 *  runs lets the engine split those runs every possible way before giving up.
 *  A line carrying `ALTER TABLE ONLY` and then whitespace that never reaches a
 *  table costs quadratic time under the short spelling — seconds at a hundred
 *  thousand spaces, against under a millisecond at four hundred thousand under
 *  this one. No line in either tree looks like that, so this is headroom and
 *  not a live cost, and no assertion holds the timing down: this paragraph is
 *  what keeps the shape from being tidied back into the short form.
 *
 *  Which needs saying plainly, because three sibling heads DO carry the short
 *  form and its cost: `ACCOUNTS_STATEMENT_RE`, `UPDATE_TARGET_RE` and
 *  `MERGE_TARGET_RE` each measure the same quadratic curve on the same input
 *  shape. They are left alone here because the widening that made the question
 *  live is this head's, and because the cost is headroom for them exactly as it
 *  is for this one. They are named so a reader comparing the heads reads this
 *  one as the deliberate exception rather than as the odd one out to tidy away,
 *  which is the reading that would undo the paragraph. */
const ALTER_ACCOUNTS_RE =
  /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\b\s*\(\s*|ONLY\s+)?(?:public\s*\.\s*)?accounts\b/i;

/** Every head a scan reads a statement FROM, and so every head whose statement
 *  has to be readable to a terminator. Read by {@link unreadableStatements},
 *  which the arm and its fixtures both call. The arm once kept its own loop and
 *  a fixture helper kept a copy, and the two drifted apart the last time the
 *  set widened: the arm learned about the ALTER head and the copy did not. */
const READ_FROM_HEADS = [ACCOUNTS_STATEMENT_RE, ALTER_ACCOUNTS_RE];

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
 * comment-gap class inside it, and both migrations that carry a `DO` block hold
 * real PL/pgSQL over this table — 007 a duplicate-ORCID guard that aggregates
 * `accounts` and raises, 017 a custody-alignment repair — so the distinction is
 * made at the opener from the keyword the span follows.
 *
 * The distinction is made ONCE, at the outermost opener, and then applies all
 * the way down. A body spells a literal of its own to carry SQL it EXECUTEs,
 * and that literal can carry another, so the open tags are a STACK rather than
 * a tag: inside a body every depth is source, read with the body's own rules —
 * quoting tracked, comments blanked, each comment bounded by the innermost tag.
 * Inside a VALUE nothing is tracked at all, because a value's characters are
 * data to its own closing tag and a `$` inside one is just a dollar sign.
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
  /** The dollar-quote tags currently open, outermost first, each spanning
   *  lines. A stack rather than a tag, because a body spells a nested literal
   *  to carry SQL it EXECUTEs and that literal can carry one of its own;
   *  PostgreSQL requires each tag to differ from the one enclosing it. The
   *  innermost is what the next closing tag has to match, and what bounds a
   *  comment opened inside it. */
  dollar: string[];
  /** Whether the OUTERMOST of those is a routine or `DO` BODY rather than a
   *  string value. A body is PL/pgSQL or SQL source, where a comment is a
   *  comment and has to be blanked like any other, and so is every literal the
   *  body executes. A value is data all the way down: its characters belong to
   *  the statement, markers included, and nothing inside one is a span of its
   *  own, so the stack never grows past a value. */
  dollarCode: boolean;
}

/** A dollar-quoted span the blanking reader OPENED or CLOSED, and where.
 *
 *  These are decisions, not a second opinion. {@link statementAt} used to ask
 *  {@link dollarOpenerAt} the same question {@link blankLine} asks, from its
 *  own starting position and with no stack behind it, so the only question it
 *  could pose was "does a span OPEN here" — and a literal's own CLOSING tag
 *  answers yes to that. The grammar matches, no interpolation follows, and the
 *  tag recurs (it is the next literal's opener), so the recurrence requirement
 *  CONFIRMS the phantom rather than refusing it. The read then swallows the
 *  semicolon that really ended its statement and runs on, and a head inside a
 *  literal lends its table to a write below it that no readable head reaches.
 *  Replaying the blanking reader's own opens and closes is what makes the two
 *  answers the same answer: one reader decides, the other consumes. */
interface SpanEvent {
  col: number;
  /** The characters consumed at `col`: a tag's length, or 1 for the backtick
   *  that ends a template and every span open inside it at once. */
  width: number;
  tag: string;
  open: boolean;
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

/** The text before a `/` that makes it a DIVISION: an operand, optionally
 *  carrying a postfix operator. An operand ENDS in a name character (Unicode,
 *  since an identifier may be), a digit, or a closing `)`, `]`, `}`, quote or
 *  backtick; after it a slash divides. TypeScript adds two postfix spellings
 *  that keep the operand an operand — the non-null assertion `x!`, which is
 *  ordinary in this codebase, and `x++` / `x--` — and each is admitted only
 *  where an operand precedes it, so the PREFIX `!` of `!/re/.test(v)` still
 *  opens a pattern. */
const OPERAND_END_RE = /[\p{L}\p{N}_$)\]}'"`](?:!|\+\+|--)?$/u;

/** The keywords a regex literal may follow. Each ends in a name character, so
 *  without this the pattern after one reads as a division, and a quote inside
 *  that pattern then opens a value that is not there. The lookbehind is what
 *  keeps a PROPERTY of the same name out (`obj.return / 2` divides), together
 *  with a name that merely ends in one (`noreturn / 2`). */
const PATTERN_KEYWORD_RE =
  /(?<![.\p{L}\p{N}_$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/u;

/** The end, exclusive, of the regex literal whose opening slash is at `at`, or
 *  -1 when that slash is a division.
 *
 *  A quote inside a pattern is one of its characters, and patterns like that
 *  are ordinary code: this tree spells the `"`-matching ones in its arXiv and
 *  Crossref scraping (`html.match(/class="primary-subject">([^<]+)</)`) and in
 *  HTML escaping (`s.replace(/"/g, '&quot;')`), and the apostrophe spellings a
 *  SQL layer reaches for, `v.replace(/'/g, "''")`, are the ones this arm is
 *  here for before one lands. Read as a quote it opens a VALUE that
 *  is not there, and every decision after it on the line is made from inside
 *  that phantom: a template's backtick is declined as a character of a value, a
 *  `/*` inside a real string is taken for a comment, a `//` inside a SQL
 *  literal blanks the rest of the line. Each hides an ordinary write.
 *
 *  Where it STARTS is judged from the code before the slash, blanked, so a
 *  comment in between neither supplies an operand nor hides one: after an
 *  operand ({@link OPERAND_END_RE}) the slash divides, after a keyword
 *  ({@link PATTERN_KEYWORD_RE}) or anything else it opens a pattern. A slash
 *  LEADING its line is judged from the previous line with code on it, because
 *  that is how the language reads it too: no semicolon is inserted before a
 *  slash, so `total` on one line and `/ 2` on the next is one division.
 *
 *  Where it ENDS is the next slash that is neither escaped nor inside a
 *  character class, on the same line, since a regex literal cannot span lines.
 *  A slash with no such end opens no pattern and is read as the division it
 *  then has to be.
 *
 *  What a misjudged division costs is why the operand list has to stay
 *  complete: the pattern it opens runs to the next slash, which is routinely
 *  the opener of a `//` comment, and the prose behind that opener is then read
 *  as code — where a path glob (`/api/papers/*`) opens a block comment that
 *  blanks every line down to the next closer, writers included. */
function regexLiteralEnd(line: string, at: number, prior: string): number {
  if (OPERAND_END_RE.test(prior) && !PATTERN_KEYWORD_RE.test(prior)) return -1;
  let inClass = false;
  for (let j = at + 1; j < line.length; j++) {
    const c = line[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
    } else if (c === '[') {
      inClass = true;
    } else if (c === '/') {
      return j + 1;
    }
  }
  return -1;
}

/** The end, exclusive, of the `${...}` interpolation opening at `at`, or -1
 *  when it does not close on this line.
 *
 *  An interpolation holds TypeScript, not the SQL around it, and what it holds
 *  can be a template of ITS OWN. Read flat, that nested template's OPENING
 *  backtick closes the outer one, so the flag says no template is open while
 *  one still is — and every arm that tests the flag then answers for the wrong
 *  text. The reader does not descend into one: the whole interpolation is
 *  copied as written, so no character inside it is a delimiter, a comment
 *  marker or a quote for any arm out here.
 *
 *  Finding the close needs the brace depth AND the quoting, since a `}` inside
 *  a string or a nested template closes nothing. An interpolation that spans
 *  lines reports -1 and is read as it was before, flat: the shape is not in
 *  either tree, and copying to the end of the line would blank live code. */
function interpolationEnd(line: string, at: number): number {
  let depth = 1;
  const quotes: string[] = [];
  for (let j = at + 2; j < line.length; j++) {
    const char = line[j];
    if (char === '\\') {
      j++;
      continue;
    }
    const open = quotes[quotes.length - 1];
    if (open !== undefined && open !== '`') {
      if (char === open) quotes.pop();
      continue;
    }
    if (char === '`') {
      if (open === '`') quotes.pop();
      else quotes.push(char);
      continue;
    }
    if (open === '`') continue;
    if (char === "'" || char === '"') quotes.push(char);
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return j + 1;
  }
  return -1;
}

/** The code before a position, as the blanking reader has it: the current
 *  line's own blanked text up to that point, or, when that is empty, the
 *  nearest earlier line carrying any. Trailing space is dropped either way, so
 *  what comes back ends in the last character of code before the position. */
function codeBefore(blanked: string[], lineIndex: number, before: string): string {
  if (before.trimEnd() !== '') return before.trimEnd();
  for (let i = lineIndex - 1; i >= 0; i--) {
    if (blanked[i] === undefined || blanked[i].trim() === '') continue;
    return blanked[i].trimEnd();
  }
  return '';
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

/** The tag of the dollar-quoted span opening at `at` on `lineIndex`, or null
 *  when nothing opens there.
 *
 *  ONE reader asks this, and that is the point rather than an accident.
 *  {@link blankLine} is the only caller; {@link statementAt} used to be the
 *  second, and an opener one of them believed in while the other did not was a
 *  divergence that read green. A span only the statement read opened carried it
 *  past its own terminator and lent its table to a write below it, which
 *  resolved to a plausible other table instead of tripping the fail-closed arm.
 *  Sharing this helper closed that, and then stopped being enough: the question
 *  it answers is "does a span OPEN here", and a read starting inside a literal
 *  needs to know it is inside one, which no opener test can tell it. So the
 *  statement read no longer judges openers at all. It REPLAYS the decisions
 *  this helper made for the blanking reader, through {@link SpanEvent} — the
 *  stronger form of the same fix, since two readers consuming one record cannot
 *  disagree the way two readers running one function still could.
 *
 *  The judgement still has to be right, because everything downstream now
 *  inherits it. No STATEMENT read over either tree reaches a grammatical opener
 *  today; the BLANKING reader reaches two, the `DO $$` in migrations 007 and
 *  017, and answers both correctly. The conditions below stay load-bearing
 *  because the shapes that break them — the placeholder-builder idiom, a tag
 *  spelled once — are ordinary code a migration or a multi-line template could
 *  carry at any time.
 *
 *  Three conditions, all of them load-bearing. The tag is PostgreSQL's own
 *  grammar ({@link DOLLAR_QUOTE_RE}). The characters after it must not be a
 *  TypeScript interpolation, since `` `$${n}` `` is this repo's
 *  placeholder-builder idiom rather than a quoted span. And the tag must RECUR
 *  ({@link dollarCloses}), the way a block comment must find a closer: a span
 *  that cannot close is not a span, and believing in one runs to the end of the
 *  file. */
function dollarOpenerAt(
  lines: string[],
  lineIndex: number,
  at: number,
  interpolates: boolean,
): string | null {
  const line = lines[lineIndex];
  const opener = line.slice(at).match(DOLLAR_QUOTE_RE);
  if (opener === null) return null;
  if (interpolates && line[at + opener[0].length] === '{') return null;
  return dollarCloses(lines, lineIndex, at, opener[0]) ? opener[0] : null;
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

/** Whether the block comment opening at `from` on `lineIndex` actually closes,
 *  within every boundary that ends the text carrying it.
 *
 *  An opener that never closes is not a comment: in a template it is ordinary
 *  text, and a glob or a wildcard path (`sessions/*`) is the shape that
 *  produces one. Treating it as a comment would blank every line after it, and
 *  a blanked line is a line no scan sees, so that mistake is silent and
 *  unbounded.
 *
 *  BOUNDARIES, not one boundary, and one search rather than two. A `/*` is a
 *  comment only in the text that holds it, and that text can end for more than
 *  one reason at once: a template ends at its backtick, since what follows is
 *  code again, and a dollar-quoted literal ends at its own tag, since a search
 *  running past the tag blanks the body's text after it and what follows a
 *  nested literal is routinely the live statement beside it. A `/*` inside a
 *  literal that itself sits inside a template answers to BOTH, so the caller
 *  hands over whichever apply and the nearest one wins. Splitting this into two
 *  functions, one per boundary, is what dropped the template bound from the
 *  in-literal case: the copy kept the tag and lost the backtick, and the loss
 *  reads green because a search that runs too far only ever blanks MORE.
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
 *  is not a comment, and a closer past a boundary is not one either. */
function blockCloses(
  lines: string[],
  lineIndex: number,
  from: number,
  boundaries: string[],
): boolean {
  for (let i = lineIndex; i < lines.length; i++) {
    const text = i === lineIndex ? lines[i].slice(from + 2) : lines[i];
    const closes = text.indexOf('*/');
    let ends = -1;
    for (const boundary of boundaries) {
      const at = text.indexOf(boundary);
      if (at !== -1 && (ends === -1 || at < ends)) ends = at;
    }
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
): { text: string; state: BlankState; spans: SpanEvent[] } {
  const line = lines[lineIndex];
  const escapes = !sql;
  // A backtick delimits a template in TypeScript and is an ordinary character
  // everywhere in SQL, so every arm that OPENS or ENDS a template is gated on
  // the dialect. (The block-comment boundary one level down tests the flag
  // alone, which is inert for as long as these arms keep the flag false in a
  // `.sql` read.)
  // The template FLAG is no substitute for that gate, however safe it reads:
  // the flag starts false in a `.sql` file but nothing kept it there,
  // so one unpaired backtick inside an ordinary quoted value — an audit note,
  // a quoted shell fragment — switched a migration into template mode for the
  // rest of the file, and a backtick PAIR inside a `RAISE NOTICE` string
  // cleared the open tag stack mid-body, after which the block's own `END $$`
  // read as an opener instead of a close. The two arms that only END a
  // template test the flag as well as the dialect, since in TypeScript a
  // backtick ends nothing where no template is open.
  const ticks = !sql;
  let { block, template, dollar, dollarCode } = state;
  let opaque: string | null = null;
  const spans: SpanEvent[] = [];
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
      // A VALUE inside a dollar-quoted literal cannot outlive the literal, so
      // the innermost tag closes one whatever the quoting says — the same bound
      // the `--` arm below already carries, and needed for the same reason one
      // level up. Dollar quoting exists so a value need not escape its quotes,
      // so an unpaired apostrophe inside one (`$d$ 016's back-fill $d$`) is
      // ordinary, correct SQL rather than a mistake. Consumed as an open value,
      // it swallows the literal's own closing tag: no CLOSE is recorded, every
      // line after it is registered one level too deep, and {@link statementAt}
      // replays that depth and suppresses the terminator of whatever statement
      // comes next. The blanking's own damage stops at the line, because
      // `opaque` resets; the mis-recorded span does not.
      if (dollar.length > 0 && line.startsWith(dollar[dollar.length - 1], i)) {
        const tag = dollar[dollar.length - 1];
        out += tag;
        spans.push({ col: i, width: tag.length, tag, open: false });
        i += tag.length;
        dollar = dollar.slice(0, -1);
        if (dollar.length === 0) dollarCode = false;
        opaque = null;
        continue;
      }
      if (escapes && char === '\\' && next !== undefined) {
        out += char + next;
        i += 2;
        continue;
      }
      out += char;
      // An unescaped backtick ends the template whatever else is open: a value
      // cannot contain one, so an apostrophe in prose earlier on the line must
      // not swallow it and leave the template flag inverted for the rest of
      // the file. Only where a template IS open, though, which the dialect
      // alone does not say. In TypeScript a backtick inside an ordinary
      // quoted string is one of that string's characters, and ending the VALUE
      // there hands the rest of the string to the code rules, where a `/*`
      // opens a comment that blanks every line up to the next `*/`. In SQL it
      // is an ordinary character of the value. The gate trusts the value to be
      // real, which holds because a quote inside a regex literal opens none:
      // see {@link regexLiteralEnd}. Without it, a line carrying an ODD number
      // of quote characters that opened no string leaves this arm declining the
      // backtick of the template after them.
      if (ticks && template && char === '`') {
        template = false;
        opaque = null;
        for (const open of dollar) spans.push({ col: i, width: 1, tag: open, open: false });
        dollar = [];
        dollarCode = false;
      } else if (char === opaque) opaque = null;
      i++;
      continue;
    }
    if (dollar.length > 0) {
      const tag = dollar[dollar.length - 1];
      // An escape belongs to the TypeScript literal the span sits in, not to
      // the span, so it is copied whole: an escaped backtick is a character of
      // the value, not the end of the template.
      if (escapes && char === '\\' && next !== undefined) {
        out += char + next;
        i += 2;
        continue;
      }
      // An unescaped backtick ends the template whatever else is open. A
      // dollar-quoted span cannot contain one, so a span opened inside a
      // template must not swallow the template's own closer: the missed toggle
      // leaves the flag inverted for the rest of the file, where an ordinary
      // decrement is then read as a comment and blanks the write beside it.
      // Gated on the dialect as well as the flag, so a `.sql` migration is
      // untouched however the flag got set.
      if (ticks && template && char === '`') {
        out += char;
        template = false;
        for (const open of dollar) spans.push({ col: i, width: 1, tag: open, open: false });
        dollar = [];
        dollarCode = false;
        i++;
        continue;
      }
      // The innermost tag is what closes: a nested literal ends before the body
      // carrying it does.
      if (line.startsWith(tag, i)) {
        out += tag;
        spans.push({ col: i, width: tag.length, tag, open: false });
        i += tag.length;
        dollar = dollar.slice(0, -1);
        if (dollar.length === 0) dollarCode = false;
        continue;
      }
      // A VALUE is data to its own closing tag: every character belongs to the
      // statement, markers included, and nothing inside one is a span of its
      // own. A CODE body is source, so its comments are blanked like any other
      // — a comment between two tokens a pattern needs adjacent silences that
      // pattern wherever it sits — and so is every literal that body EXECUTEs,
      // which is why the source rules below run at every depth rather than only
      // at the body's own.
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
        // PostgreSQL requires a nested tag to differ from the one enclosing it,
        // and that tag was tested above, so any opener reaching here starts a
        // literal one level deeper.
        const inner = dollarOpenerAt(lines, lineIndex, i, !sql);
        if (inner !== null) {
          dollar = [...dollar, inner];
          out += inner;
          spans.push({ col: i, width: inner.length, tag: inner, open: true });
          i += inner.length;
          continue;
        }
      }
      if (char === '-' && next === '-') {
        // A line comment ends with its line OR with the literal carrying it,
        // whichever comes first. Running to the end of the line regardless is
        // what erases the live statement a body spells after a nested literal.
        const closes = line.indexOf(tag, i);
        const until = closes === -1 ? line.length : closes;
        out += ' '.repeat(until - i);
        i = until;
        if (until === line.length) break;
        continue;
      }
      // Both boundaries apply at once: the literal ends at its own tag, and a
      // literal sitting inside a template also ends where the template does.
      if (
        char === '/' &&
        next === '*' &&
        blockCloses(lines, lineIndex, i, ticks && template ? [tag, '`'] : [tag])
      ) {
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
    if (ticks && char === '`') {
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
    // An interpolation is TypeScript inside the template's SQL, and it is
    // copied whole: see {@link interpolationEnd}. Before the dollar-quote
    // opener below, because `${` is this dialect's interpolation wherever a
    // template is open, and `$${n}` is the placeholder-builder idiom that
    // opener already refuses.
    if (char === '$' && next === '{' && !sql && template) {
      const end = interpolationEnd(line, i);
      if (end !== -1) {
        out += line.slice(i, end);
        i = end;
        continue;
      }
    }
    if (char === '$' && (sql || template)) {
      const opener = dollarOpenerAt(lines, lineIndex, i, !sql);
      if (opener !== null) {
        dollar = [opener];
        dollarCode = opensCodeBody(blanked, lineIndex, out);
        out += opener;
        spans.push({ col: i, width: opener.length, tag: opener, open: true });
        i += opener.length;
        continue;
      }
    }
    // A regex literal is a VALUE to its closing slash: its quotes, markers and
    // backticks are characters of the pattern (see {@link regexLiteralEnd}).
    // TypeScript code alone, since SQL writes a slash as an operator, `|/` for
    // a square root, and that includes the SQL a template holds.
    if (char === '/' && next !== '/' && next !== '*' && !sql && !template) {
      const end = regexLiteralEnd(line, i, codeBefore(blanked, lineIndex, out));
      if (end !== -1) {
        out += line.slice(i, end);
        i = end;
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
    if (char === '/' && next === '*' && blockCloses(lines, lineIndex, i, template ? ['`'] : [])) {
      block = true;
      out += '  ';
      i += 2;
      continue;
    }
    out += char;
    i++;
  }
  return { text: out, state: { block, template, dollar, dollarCode }, spans };
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
function blankAll(
  lines: string[],
  sql: boolean,
): { code: string[]; state: BlankState; entry: string[][]; spans: SpanEvent[][] } {
  let state: BlankState = { block: false, template: false, dollar: [], dollarCode: false };
  const code: string[] = [];
  const entry: string[][] = [];
  const spans: SpanEvent[][] = [];
  lines.forEach((_line, i) => {
    entry.push(state.dollar);
    const blanked = blankLine(lines, i, state, sql, code);
    state = blanked.state;
    code.push(blanked.text);
    spans.push(blanked.spans);
  });
  return { code, state, entry, spans };
}

/** A file's lines with their comments blanked, carrying what the blanking
 *  reader DECIDED about them.
 *
 *  It used to carry the DIALECT instead, so that both readers would answer the
 *  same way at a dollar opener. That is no longer the shape of the problem:
 *  {@link statementAt} does not judge openers at all now, it replays the ones
 *  recorded here, so there is no second dialect answer to keep aligned and the
 *  flag has no reader. A field nothing reads is a field the next author has to
 *  decide about, so it is gone rather than kept for symmetry; the dialect still
 *  travels as `blankLine`'s own `sql` parameter, where it is used.
 *
 *  What rides on the text instead is the record: the tag stack each line STARTS
 *  in, and every span opened or closed on it in column order. Together they
 *  give any position in the file its stack, which is what {@link statementAt}
 *  needs and could not derive on its own — a reader beginning mid-file with an
 *  empty stack has no tag to close against, so it reads a literal's terminator
 *  as an opener. These ride on the text for the reason the flag used to: a
 *  caller that has to remember to pass them is a caller that can pass the wrong
 *  ones. */
interface BlankedCode extends Array<string> {
  entry?: string[][];
  spans?: SpanEvent[][];
}

function blankFile(lines: string[], sql: boolean): BlankedCode {
  const blanked = blankAll(lines, sql);
  const code: BlankedCode = blanked.code;
  code.entry = blanked.entry;
  code.spans = blanked.spans;
  return code;
}

/** The dollar-quote tag stack open at `col` on `lineIndex`: the stack the line
 *  started in, advanced by the spans the blanking reader opened and closed
 *  before that column. */
function spanStackAt(code: BlankedCode, lineIndex: number, col: number): string[] {
  let stack = code.entry?.[lineIndex] ?? [];
  for (const event of code.spans?.[lineIndex] ?? []) {
    if (event.col >= col) break;
    stack = event.open ? [...stack, event.tag] : stack.slice(0, -1);
  }
  return stack;
}

/** The spans opening or closing exactly at `col`, in the order the blanking
 *  reader applied them. More than one closes at a column only where a template
 *  ends and takes every span open inside it with it. */
function spanEventsAt(code: BlankedCode, lineIndex: number, col: number): SpanEvent[] {
  return (code.spans?.[lineIndex] ?? []).filter((event) => event.col === col);
}

/** Every line of a file, blanked once, since every scan reads them repeatedly. */
interface Readable extends ScannedSource {
  code: BlankedCode;
}

function readable(files: ScannedSource[]): Readable[] {
  return files.map((file) => ({ ...file, code: blankFile(file.lines, file.rel.endsWith('.sql')) }));
}

/** The string enclosing `index` on an already-blanked line, and where it opens,
 *  or null when the position sits in no string. Only the same character closes
 *  a string, so a `'light'` inside a backticked template does not end it, and a
 *  literal that opens and closes AHEAD of the position is not mistaken for the
 *  one that encloses it.
 *
 *  IT SKIPS DOLLAR-QUOTED SPANS, for the reason every reader here ends up
 *  needing: a character's meaning depends on where it sits, and a quote
 *  character inside a dollar-quoted value is data. Read flat, the apostrophe in
 *  `$$don't reuse this$$` and the backtick in ``$$don`t reuse this$$`` each
 *  open a string that never closes before the head, so the head's statement is
 *  delimited by a quote instead of by its semicolon, runs on past its own end,
 *  and lends its table to the write below it — the same silent direction
 *  {@link statementAt} closes one layer up, reached through the delimiter
 *  rather than through the span. Both spellings are ordinary migration prose.
 *
 *  The spans it skips are the blanking reader's own, replayed from
 *  {@link SpanEvent} rather than re-derived, so this reader cannot disagree with
 *  the other two about where a value begins. That also removes the need for a
 *  dialect flag here: a backtick is only ever a delimiter where the blanking
 *  reader already treated it as one. */
function enclosingQuote(
  code: BlankedCode,
  lineIndex: number,
  index: number,
): { char: string; at: number } | null {
  const line = code[lineIndex];
  const events = code.spans?.[lineIndex] ?? [];
  let depth = (code.entry?.[lineIndex] ?? []).length;
  let seen = 0;
  let quote: string | null = null;
  let at = -1;
  for (let i = 0; i < index; i++) {
    while (seen < events.length && events[seen].col === i) {
      depth += events[seen++].open ? 1 : -1;
    }
    if (depth > 0) continue;
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
function targetTable(code: BlankedCode, lineIndex: number, position?: number): string {
  const own = position ?? assignmentIndex(code[lineIndex]);
  const at = own === -1 ? code[lineIndex].length : own;
  for (let i = lineIndex; i >= 0; i--) {
    const head = statementHead(code[i], i === lineIndex && own !== -1 ? own : undefined);
    if (head === null) continue;
    const reach = statementAt(code, i, head.index);
    // Reaching the assignment's LINE is not enough when the statement ends on
    // that line: one that closed to the left of the assignment is a sibling
    // query, not its owner, and lending its table is the misattribution the
    // fail-closed arm exists to refuse. A read that GAVE UP reaches nothing at
    // all, whatever line it stopped on — see {@link SqlStatement.stopped}.
    const reaches =
      !reach.stopped &&
      (reach.lastLine > lineIndex ||
        (reach.lastLine === lineIndex && (reach.closedAt === -1 || reach.closedAt > at)));
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
  /** Whether the read GAVE UP rather than ran out of room.
   *
   *  Both answers report `closedAt: -1`, and they mean opposite things to
   *  {@link targetTable}. Hitting the cap or the end of the file means the
   *  statement runs on past everything below it, so it does reach a write there.
   *  Giving up — the span carrying the head closed first, or a line ended inside
   *  a value — means its extent is UNKNOWN, and a statement of unknown extent
   *  must lend its table to nothing. Reading the one flag for both is how a
   *  fail-closed answer gets spent as a reaching one. */
  stopped: boolean;
}

/**
 * The SQL statement that starts at `matchIndex` on `lineIndex` of an
 * already-blanked file, read to its terminator.
 *
 * The delimiter is the quote of the string ENCLOSING the keyword, so a
 * backtick template and a single-quoted one-liner are each read to their own
 * quote, and a literal that opens and closes ahead of the keyword cannot hand
 * the read a delimiter that truncates it short of the assignment. A keyword
 * enclosed by no string is a migration statement, read to its semicolon. It is
 * capped so an unterminated literal cannot swallow the rest of the file. A read
 * that hits the cap reports no terminator, which is itself asserted on: a
 * statement too long to read whole is a statement this file cannot clear.
 *
 * A READ THAT CANNOT REACH ITS OWN TERMINATOR MUST NOT RESOLVE A TABLE. That is
 * the whole of what the span and value handling below is for, and it is the
 * invariant, not the mechanism: a statement read past its real end reaches
 * writes that are not its own, and {@link targetTable} then hands one of them a
 * plausible other table instead of leaving it {@link UNRESOLVED_TABLE}. Refusing
 * to resolve is a red bar naming a line; resolving to the wrong table is
 * silence.
 *
 * SPANS ARE REPLAYED, NOT RE-JUDGED. The head can sit anywhere, including
 * inside a dollar-quoted literal a `DO` body EXECUTEs, so the read starts from
 * {@link spanStackAt} — the stack the blanking reader held at that exact
 * position — and every span it opens or closes afterwards is one
 * {@link blankLine} already recorded. Deriving them again from this position
 * cannot work: with an empty stack the only question askable at a `$` is "does
 * a span OPEN here", and a literal's own CLOSING tag answers yes to it, since
 * the tag is grammatical and recurs as the next literal's opener. That read
 * swallowed its statement's semicolon and ran on to lend its table below.
 *
 * DEPTH, relative to where the head sits, is what suspends the terminator.
 * Inside the head's OWN span the statement text is ordinary text and its
 * semicolon and quotes mean what they say, which is how a statement EXECUTEd
 * from a literal is read whole. Deeper than that is a value or a nested literal
 * belonging to the statement, where a semicolon is one of its characters. And
 * SHALLOWER means the span carrying the head closed before the statement ended:
 * the read stops there reporting no terminator, which is the fail-closed answer.
 *
 * VALUE STATE RESETS PER LINE, and a line that ends mid-value STOPS the read.
 * Those are one decision, not two, because either half alone is silent in its
 * own direction. Carried across lines, one unescaped quote — in prose, in a
 * `$$it's$$` value, in the hand-escaping `replace(/'/g, "''")` idiom — leaves
 * this read inside a value for the rest of the file, so the template's own
 * closing backtick stops ending it and the head reaches writes below it. Reset
 * and allowed to continue, the second line of a value that genuinely spans
 * lines is read as code and its own semicolon truncates the statement, which
 * drops a MERGE's insert column list — the one writer shape carrying no
 * assignment for the fail-closed arm to catch. So the read stops with no
 * terminator instead, resolving no table and reporting the statement to the
 * every-statement-readable arm by line.
 *
 * This is the ONE place the two readers deliberately answer differently, and
 * the difference is a refusal rather than a divergence: the blanking reads on,
 * because blanking a whole file is not optional, while the statement read gives
 * up on a statement it cannot bound. Dollar-quoted spans are not affected —
 * they DO span lines, because those are the blanking reader's own decisions,
 * replayed rather than re-derived.
 */
function statementAt(code: BlankedCode, lineIndex: number, matchIndex: number): SqlStatement {
  const opener = enclosingQuote(code, lineIndex, matchIndex);
  const quote = opener?.char ?? null;
  let text = '';
  let dollar = spanStackAt(code, lineIndex, matchIndex);
  const enclosing = dollar.length;
  let lastLine = lineIndex;
  for (let i = lineIndex; i < code.length && i <= lineIndex + LITERAL_CAP; i++) {
    const line = code[i];
    let out = '';
    let col = i === lineIndex ? matchIndex : 0;
    let closedAt = -1;
    let opaque: string | null = null;
    let escaped = false;
    while (col < line.length) {
      const char = line[col];
      const events = spanEventsAt(code, i, col);
      if (events.length > 0 && opaque === null) {
        for (const event of events) dollar = event.open ? [...dollar, event.tag] : dollar.slice(0, -1);
        // The span the head sits in closed before the statement did, so the
        // statement has no terminator this read can reach.
        const shallower = dollar.length < enclosing;
        // A column spent on span machinery can still be this statement's
        // delimiter. A template's closing backtick force-closes every span open
        // inside it and the blanking reader records those closes AT the
        // backtick, so a read that only replays the events there runs out of
        // the template and lends its table to a write in the code after it.
        // Tested after the depth, not before: a head whose own span closed at
        // this column reached no terminator inside that span, and taking the
        // backtick for one would lend its table to a sibling statement instead.
        if (!shallower && char === quote) {
          closedAt = col;
          break;
        }
        out += line.slice(col, col + events[0].width);
        col += events[0].width;
        if (shallower) {
          escaped = true;
          break;
        }
        continue;
      }
      if (dollar.length > enclosing) {
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
      out += char;
      col++;
    }
    text += i === lineIndex ? out : '\n' + out;
    lastLine = i;
    if (closedAt !== -1) {
      return { text, lastLine: i, closedAt, quoteAt: opener?.at ?? -1, stopped: false };
    }
    // A line that ended with a VALUE still open is a line the read could not
    // balance, and carrying on is wrong in both directions. Carried, one
    // unescaped quote keeps the read inside a value past the template's own
    // closing backtick, so the head reaches writes below it and lends them its
    // table. Reset, the continuation of a value that genuinely spans lines is
    // read as code and its own `;` truncates the statement — which drops a
    // MERGE's insert column list, the one place a write carries no assignment
    // for the fail-closed arm to catch. So neither: the read STOPS here and
    // reports no terminator, which resolves no table and puts the statement in
    // front of the every-statement-readable arm as a red bar naming its line.
    if (escaped || opaque !== null) {
      return { text, lastLine: i, closedAt: -1, quoteAt: opener?.at ?? -1, stopped: true };
    }
  }
  return { text, lastLine, closedAt: -1, quoteAt: opener?.at ?? -1, stopped: false };
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

/** Every `accounts` statement, read from every head in {@link READ_FROM_HEADS},
 *  whose read stops without reaching a terminator.
 *
 *  EVERY head a scan reads from, not only the DML ones. Each scan asks a
 *  question about a statement's TEXT, and each can only answer it for a
 *  statement read to the end, so a head this scan does not cover is a truncated
 *  read nothing reports. The ALTER head is the one that most needs saying:
 *  `accountsColumnAlterations` is the ONLY arm that sees a rewrite carrying no
 *  assignment and no column list, so a truncated ALTER is a silent pass with no
 *  second walk behind it. A wrapped DEFAULT string in the ADD COLUMN clause
 *  ahead of the `ALTER COLUMN updated_at TYPE ... USING` is all it takes.
 *
 *  A named scan rather than a loop written into the arm, as the writer and
 *  ALTER arms are, so that a fixture calls the arm's own enumeration. (The
 *  end-state arm still builds its list inline, and carries the same risk.) A
 *  loop kept in the arm with a copy of it in a fixture helper lets the arm
 *  drift from the copy: its head list, its match flags and its stop test each
 *  read green when changed in the arm alone.
 *
 *  What the extraction does NOT cover, said here because naming a scan invites
 *  the wrong reading: the arm still chooses which FILES to hand in, and
 *  a fixture passes its own. Narrowing `[...sources, ...migrations]` at the
 *  call site, to either half or to nothing, leaves every test green. No fixture
 *  can answer for that, the way none can answer for an assertion rewritten to
 *  `toEqual(unread)`; what answers for it is reading the arm. */
function unreadableStatements(files: Readable[]): Occurrence[] {
  const found: Occurrence[] = [];
  for (const { rel, lines, code } of files) {
    code.forEach((line, i) => {
      for (const pattern of READ_FROM_HEADS) {
        for (const match of line.matchAll(new RegExp(pattern.source, 'gi'))) {
          if (statementAt(code, i, match.index ?? 0).closedAt === -1) found.push(occurrenceAt(rel, lines, i));
        }
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
const asCode = (lines: string[], sql = false): BlankedCode => blankFile(lines, sql);
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
      .filter(({ state }) => state.block || state.template || state.dollar.length > 0)
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
    // is what the assignment pattern's own `\s*` admits, and which the
    // declaration test never sees because it reads the slice that STOPS at the
    // column.
    expect(assignsColumn('  var updated_at = 1;')).toBe(false);
    expect(assignsColumn('  const updated_at   = row.updated_at;')).toBe(false);
    expect(assignsColumn('             signup_binding_hash = NULL, updated_at = NOW()')).toBe(true);
    // The exclusion may not scan FORWARD. The declaration characters sitting
    // after a real write — inside an ordinary string value, which the blanking
    // leaves alone — vetoed that write while the test read past it, and both
    // writer walks went quiet on a statement that writes the column. Pinned at
    // the predicate and again end to end, because the veto silenced both.
    const vetoed = "SET updated_at = NOW(), full_name = 'unset, see const updated_at = row.updated_at'";
    expect(assignsColumn(vetoed)).toBe(true);
    expect(assignmentIndex(vetoed)).toBe('SET '.length);
    const vetoedFile = readable([{ rel: 'x.ts', lines: inHandler(`    \`UPDATE accounts ${vetoed} WHERE id = $1\`,`) }]);
    expect(countsOf(columnAssignments(vetoedFile).get('accounts') ?? [])).toEqual({ 'x.ts#touch': 1 });
    expect(countsOf(accountsColumnWriters(vetoedFile))).toEqual({ 'x.ts#touch': 1 });
    // And the backward bound still decides how far a keyword may sit from the
    // name it declares. Past it the declaration reads as a write, which costs a
    // red bar on a line that writes nothing — the tolerable direction, and the
    // only one the bound can now take.
    expect(assignsColumn(`  const${' '.repeat(20)}updated_at = 1;`)).toBe(true);
    // The keyword must sit on the column's OWN line. A statement is read with
    // its lines joined, so whitespace that crosses the newline lets a word
    // ending one line veto a write opening the next — a declaration in no
    // dialect, and a veto is the silent direction.
    expect(writesColumn('UPDATE accounts SET const\n   updated_at = NOW() WHERE id = 1')).toBe(true);
    expect(assignsColumn('const\n   updated_at = NOW()')).toBe(true);
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
    // A semicolon inside a VALUE ends no migration statement: the value is
    // tracked across the line carrying it, so the statement is read whole to
    // the real terminator rather than truncated at the value. Across LINES it
    // is the dollar-quoted spans that carry, not the quoted ones — see the
    // per-line value reset pinned in the enclosing-span spec.
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
    expect(enclosingQuote(escapedDelimiter, 0, escapedDelimiter[0].indexOf('UPDATE accounts'))?.char).toBe('`');
    expect(writesColumn(statementAt(escapedDelimiter, 0, escapedDelimiter[0].indexOf('UPDATE accounts')).text)).toBe(true);
    // The comment blank, in both dialects and in neither direction too far:
    // a marker inside a value is left alone, and a decrement is not a comment.
    expect(scanned('UPDATE accounts -- SET updated_at = now()')).toBe('UPDATE accounts' + ' '.repeat(26));
    expect(scanned("SET note = 'a -- b', updated_at = NOW()")).toBe("SET note = 'a -- b', updated_at = NOW()");
    expect(scanned('  for (let i = n; i--; ) touch(i);')).toBe('  for (let i = n; i--; ) touch(i);');
    expect(scanned('  const next = /* skip */ id;')).toBe('  const next = ' + ' '.repeat(10) + ' id;');
  });

  it('a read that cannot reach its own terminator resolves no table', () => {
    // WHERE THE HEAD SITS is what the read has to know, and the blanking
    // reader is the only thing that knows it. Two `EXECUTE format($q$...$q$)`
    // calls SHARING a tag put a head inside the first literal; deriving spans
    // from that position instead of replaying them reads the first literal's
    // own CLOSING tag as an opener — grammatical, uninterpolated, and recurring
    // as the second literal's opener, so the recurrence requirement confirms
    // the phantom rather than refusing it. The read then swallows its own
    // semicolon, runs to the write below, and lends it a plausible other table.
    const sharedTag = [
      'DO $$',
      'BEGIN',
      "  EXECUTE format($q$ UPDATE pending_recovery SET note = %L WHERE id = 1 $q$, 'x');",
      "  EXECUTE format($q$ UPDATE %I SET updated_at = NOW() WHERE custody = 'light' $q$, 'accounts');",
      'END $$;',
    ];
    const shared = asCode(sharedTag, true);
    const insideLiteral = statementAt(shared, 2, sharedTag[2].indexOf('UPDATE pending_recovery'));
    expect(insideLiteral.closedAt).toBe(-1);
    expect(insideLiteral.stopped).toBe(true);
    expect(insideLiteral.lastLine).toBe(2);
    // GIVING UP AND RUNNING OUT OF ROOM report the same `closedAt` and mean
    // opposite things, so the flag is what separates them. Read as one answer,
    // a write on the very line the read stopped on is lent the head's table —
    // the fail-closed answer spent as a reaching one. The shape is the same
    // shared-tag literal with the write pulled up onto the closing-tag line.
    const stopLineWrite = [
      'DO $$',
      'BEGIN',
      '  EXECUTE format($q$',
      '    UPDATE sessions SET seen = NOW() WHERE id = %L',
      '  $q$, 1); UPDATE "accounts" SET updated_at = NOW() WHERE id = 1;',
      'END $$;',
    ];
    expect(unresolvedIn(stopLineWrite, '018_probe.sql')).toHaveLength(1);
    const runaway = ['UPDATE accounts', ...Array.from({ length: 60 }, (_, n) => `   SET c${n} = ${n},`)];
    expect(statementAt(asCode(runaway, true), 0, 0).stopped).toBe(false);
    expect(targetTable(shared, 3, assignmentIndex(shared[3]))).toBe(UNRESOLVED_TABLE);
    expect(unresolvedIn(sharedTag, '018_probe.sql')).toHaveLength(1);
    // The same shape with the table spelled as a quoted identifier, which the
    // table-first scan cannot see either, so resolution is the only arm left.
    expect(
      unresolvedIn(
        ['DO $$', 'BEGIN', '  EXECUTE format($q$ UPDATE sessions SET seen = NOW() $q$);', '  EXECUTE format($q$ UPDATE "accounts" SET updated_at = NOW() $q$);', 'END $$;'],
        '018_probe.sql',
      ),
    ).toHaveLength(1);
    // And the depth is RELATIVE to the head, not absolute: a statement the body
    // EXECUTEs is read whole to its own semicolon, so closing the column-first
    // walk inside a literal is not what this costs. Both walks still see it.
    const executed = ['DO $$', 'BEGIN', "  EXECUTE $q$UPDATE accounts SET custody = 'light', updated_at /* clock */ = NOW();$q$;", 'END $$;'];
    expect(scansOf(executed, '018_probe.sql').tableFirst).toEqual(['018_probe.sql#<module>']);
    expect(scansOf(executed, '018_probe.sql').columnFirst).toEqual(['018_probe.sql#<module>']);
    expect(unresolvedIn(executed, '018_probe.sql')).toHaveLength(0);
    // THE VALUE STATE RESETS PER LINE, the way the blanking reader resets it.
    // One unescaped quote left the read inside a value for the rest of the
    // file, so the template's own closing backtick stopped ending it and the
    // head reached whatever came next. Both spellings are ordinary code: an
    // apostrophe inside a dollar-quoted value, and the hand-escaping idiom.
    const apostrophe = ['export const NOTE = `UPDATE sessions SET note = $$it\'s$$ WHERE id = $1`;', '', 'export const TOUCH = `UPDATE "accounts" SET updated_at = NOW() WHERE id = $1`;'];
    expect(unresolvedIn(apostrophe)).toHaveLength(1);
    const handEscaped = [
      'async function note(v: string, u: string) {',
      '  await q(`UPDATE notes SET note = \'${v.replace(/\'/g, "\'\'")}\' WHERE username = $2`, [u]);',
      '  await q(`UPDATE "accounts" SET updated_at = NOW() WHERE username = $1`, [u]);',
      '}',
    ];
    expect(unresolvedIn(handEscaped)).toHaveLength(1);
    // The balanced control, which is what makes the apostrophe and
    // hand-escaping fixtures discriminate: with the quote balanced the read
    // ends at its own backtick and the accounts write is reached by no head at
    // all, so it is unresolved for the ORIGINAL reason rather than by a read
    // running on. The distinguishing assertion is therefore the sessions
    // statement's own terminator, not the unresolved count.
    const balanced = asCode(['export const NOTE = `UPDATE sessions SET note = $$its$$ WHERE id = $1`;']);
    expect(statementAt(balanced, 0, balanced[0].indexOf('UPDATE')).closedAt).toBe(balanced[0].lastIndexOf('`'));
    const unbalanced = asCode([apostrophe[0]]);
    expect(statementAt(unbalanced, 0, unbalanced[0].indexOf('UPDATE')).closedAt).toBe(unbalanced[0].lastIndexOf('`'));
    // A TEMPLATE'S CLOSING BACKTICK STILL ENDS ITS STATEMENT when the blanking
    // reader spends that same column force-closing a span. A tag recurring
    // anywhere later in the file opens a span inside the template, the backtick
    // ending the template closes it, and the close is recorded AT the backtick.
    // Consumed as span machinery and never tested as a delimiter, it let the
    // read run out of the template and lend its table to a write in the code
    // after it. The depth test cannot see this: the head sits at the template's
    // top level, so the stack returns to exactly the depth it started at.
    for (const tag of ['$tag$', '$$']) {
      const forceClosed = [
        `const a = \`UPDATE sessions SET note = ${tag}x\`;`,
        'const b = 1;',
        "await run('UPDATE \"accounts\" SET updated_at = NOW()');",
        `const t = \`${tag}\`;`,
      ];
      const read = statementAt(asCode(forceClosed), 0, forceClosed[0].indexOf('UPDATE'));
      expect(read.closedAt, tag).toBe(forceClosed[0].lastIndexOf('`'));
      expect(read.stopped, tag).toBe(false);
      expect(unresolvedIn(forceClosed), tag).toHaveLength(1);
    }
    // And the depth test still comes FIRST. A head INSIDE the span that
    // backtick force-closes had its text end with that span, so it reached no
    // terminator of its own and must still give up there. Taking the backtick
    // as its terminator instead lends the head's table to a sibling statement
    // the same body spells after it.
    const bodyForceClosed = [
      'const body = `DO $$ BEGIN UPDATE sessions SET seen = NOW(); UPDATE "accounts" SET updated_at = NOW();`;',
      'const end = `$$`;',
    ];
    const inBody = statementAt(asCode(bodyForceClosed), 0, bodyForceClosed[0].indexOf('UPDATE sessions'));
    expect(inBody.stopped).toBe(true);
    expect(unresolvedIn(bodyForceClosed)).toHaveLength(1);
    // The terminator is honoured wherever the force-closing backtick sits, not
    // only on the head's own line. A template that spans lines puts it below,
    // and a read that tests the delimiter only on the line it started from runs
    // out of that template exactly as before.
    expect(
      unresolvedIn([
        'async function touch(id: number) {',
        '  const a = `UPDATE sessions SET note = $tag$x',
        '     and more`;',
        '  await run(\'UPDATE "accounts" SET updated_at = NOW()\');',
        '  const t = `$tag$`;',
        '}',
      ]),
    ).toHaveLength(1);
    // And the read ENDS at that backtick rather than recording it and reading
    // on. Past it, the next backtick is another template's opener wherever
    // templates sit side by side in one expression, and a quoted-identifier
    // write between the two is then lent this statement's table.
    expect(
      unresolvedIn([
        'async function touch(id: number) {',
        "  await tx([`UPDATE sessions SET note = $tag$x`, 'UPDATE \"accounts\" SET updated_at = NOW() WHERE id = $1', `SELECT 1`]);",
        '  const sigil = `$tag$`;',
        '}',
      ]),
    ).toHaveLength(1);
  });

  it('each reader feature is the only thing answering its own fixture', () => {
    const migration = '018_probe.sql#<module>';
    // THE END ANCHOR on the local-declaration exclusion. The slice tested ENDS
    // at the column, so only a declaration keyword sitting immediately before
    // it excludes the match. Unanchored, the same characters occurring ANYWHERE
    // in the twelve before the column veto a real write — and `'let '` is an
    // ordinary value, not a declaration.
    const valuedKeyword = ["UPDATE accounts SET note = 'let ', updated_at = NOW() WHERE id = 1;"];
    expect(assignmentIndex(valuedKeyword[0])).toBe(valuedKeyword[0].indexOf(', updated_at') + 2);
    expect(scansOf(valuedKeyword, '018_probe.sql').columnFirst).toEqual([migration]);
    expect(scansOf(valuedKeyword, '018_probe.sql').tableFirst).toEqual([migration]);
    // THE GUARD BEFORE `dollarCode` IS CLEARED. A nested literal closing returns
    // the reader to the body that spelled it, not to the file: clearing the flag
    // on any close reads the REST of that body as a value, so its comments stop
    // being blanked and the gap in the write after it is wide open.
    const afterNested = [
      'DO $$',
      'BEGIN',
      '  EXECUTE $q$SELECT 1$q$;',
      "  UPDATE accounts SET custody = 'light', updated_at /* the server clock */ = NOW();",
      'END $$;',
    ];
    expect(scansOf(afterNested, '018_probe.sql').tableFirst).toEqual([migration]);
    expect(scansOf(afterNested, '018_probe.sql').columnFirst).toEqual([migration]);
    // THE TAG STACK, in both directions. A single tag is REPLACED by a nested
    // one, so the nested literal's close empties the state and the body's own
    // `END $$` is read as an opener instead of a close — `END ` is no body
    // keyword, so a VALUE opens and swallows the top-level write below it. The
    // second block then closes that span, which is why the end state is clean
    // and the walker-health arm cannot be what catches this.
    const twoBlocks = [
      'DO $$',
      'BEGIN',
      '  EXECUTE $q$SELECT 1$q$;',
      'END $$;',
      '',
      "UPDATE accounts SET custody = 'light', updated_at /* the server clock */ = NOW() WHERE id = 1;",
      '',
      'DO $$',
      'BEGIN',
      "  RAISE NOTICE 'done';",
      'END $$;',
    ];
    expect(scansOf(twoBlocks, '018_probe.sql').tableFirst).toEqual([migration]);
    expect(scansOf(twoBlocks, '018_probe.sql').columnFirst).toEqual([migration]);
    expect(blankAll(twoBlocks, true).state.dollar).toEqual([]);
    // `opensCodeBody` READS THE BLANKED TEXT, not the raw line. A comment
    // between the keyword and the opener hides the keyword from a raw read, so
    // a real anonymous block reads as a value and every token gap inside it
    // reopens. The writer walks are what must see this, not the routine arm:
    // `DO` installs nothing, so the routine refusal never fires on it.
    const commentedKeyword = [
      'DO /* anonymous */ $$',
      'BEGIN',
      "  UPDATE accounts SET custody = 'light', updated_at /* the server clock */ = NOW();",
      'END $$;',
    ];
    expect(scansOf(commentedKeyword, '018_probe.sql').tableFirst).toEqual([migration]);
    expect(scansOf(commentedKeyword, '018_probe.sql').columnFirst).toEqual([migration]);
    expect(routineSites(readable([{ rel: '018_probe.sql', lines: commentedKeyword }]))).toHaveLength(0);
    // BOTH `blankLine` CALL SITES ASK THROUGH THE OPENER HELPER, so a tag
    // spelled once opens nothing at either depth. Bypassing the helper at the
    // MAIN-PATH site opens a span that never closes, which switches blanking
    // off for the rest of the file: the write below goes unseen.
    const looseTopLevel = [
      'SELECT $tag$ AS sigil;',
      '',
      "UPDATE accounts SET custody = 'light', updated_at /* the server clock */ = NOW() WHERE id = 1;",
    ];
    expect(scansOf(looseTopLevel, '018_probe.sql').tableFirst).toEqual([migration]);
    expect(scansOf(looseTopLevel, '018_probe.sql').columnFirst).toEqual([migration]);
    expect(blankAll(looseTopLevel, true).state.dollar).toEqual([]);
    // Bypassing it at the NESTED site leaves a span open at a depth the body's
    // own closer can no longer match, so the end state is what reports it.
    const looseNested = [
      'DO $$',
      'BEGIN',
      "  EXECUTE 'SELECT ' || $tag$ AS sigil;",
      "  UPDATE accounts SET custody = 'light', updated_at /* the server clock */ = NOW();",
      'END $$;',
    ];
    expect(scansOf(looseNested, '018_probe.sql').tableFirst).toEqual([migration]);
    expect(scansOf(looseNested, '018_probe.sql').columnFirst).toEqual([migration]);
    expect(blankAll(looseNested, true).state.dollar).toEqual([]);
    // THE TAG GRAMMAR, pinned where it is the only condition answering. The
    // sigil fixtures beside the DOLLAR_QUOTE_RE self-tests are answered by the
    // RECURRENCE condition instead: their loose tag is spelled once, so the
    // span is refused whatever the grammar says, and a grammar loosened to
    // admit punctuation still greens them. A placeholder list REPEATED is what
    // separates the two — `$1,$` recurs on the second `VALUES` line, so the
    // recurrence condition is satisfied and only the grammar refuses the span.
    // The shape is an ordinary multi-statement template with the same
    // parameters bound twice.
    const repeatedPlaceholders = [
      'async function touch(id: number) {',
      '  await pool.query(`',
      '    INSERT INTO staging (a, b) VALUES ($1,$2);',
      "    UPDATE accounts SET custody = 'light', updated_at /* the server clock */ = NOW() WHERE id = $3;",
      '    INSERT INTO staging_copy (a, b) VALUES ($1,$2);',
      '  `, [1, 2, id]);',
      '}',
    ];
    expect(scansOf(repeatedPlaceholders).tableFirst).toEqual(['x.ts#touch']);
    expect(scansOf(repeatedPlaceholders).columnFirst).toEqual(['x.ts#touch']);
    // THE "CLOSES AHEAD" RESET in `enclosingQuote`. A quote that opened AND
    // closed before the position encloses nothing; reported as the enclosing
    // one it hands the read a terminator that stops it at the next value in the
    // statement. The escape-skip pin beside the terminator spec does not answer
    // this one — it keeps a quote OPEN, where this keeps one from staying open.
    // A MERGE is what makes the truncation silent rather than a red bar: the
    // column is written by its insert LIST, so there is no assignment anywhere
    // for the fail-closed arm to report.
    const auditThenMerge = [
      "INSERT INTO audit_log (msg) VALUES ('accounts touched'); MERGE INTO accounts a USING (SELECT 'light'::text AS custody, 'i@x.pt'::text AS email) s ON s.email = a.email WHEN NOT MATCHED THEN INSERT (email, custody, updated_at) VALUES (s.email, s.custody, NOW());",
    ];
    expect(enclosingQuote(asCode(auditThenMerge, true), 0, auditThenMerge[0].indexOf('MERGE INTO'))).toBeNull();
    expect(scansOf(auditThenMerge, '018_probe.sql').tableFirst).toEqual([migration]);
    // THE DOLLAR-SPAN SKIP in the same reader. A quote character inside a
    // dollar-quoted VALUE is data, and read flat it opens a string that never
    // closes before the head — so the head is delimited by that quote instead
    // of by its semicolon, runs past its own end, and lends its table to the
    // write below. Both spellings are ordinary migration prose, and the
    // apostrophe one is the likelier by far.
    for (const note of ["$$don't reuse this$$", '$$don`t reuse this$$']) {
      const spanned = [
        `WITH stale AS (SELECT id FROM ops_notes WHERE body = ${note}) UPDATE audit_log SET seen = NOW() WHERE id IN (SELECT id FROM stale);`,
        'UPDATE "accounts" SET updated_at = NOW() WHERE id = 2;',
      ];
      const spannedCode = asCode(spanned, true);
      expect(enclosingQuote(spannedCode, 0, spanned[0].indexOf('UPDATE audit_log')), note).toBeNull();
      expect(unresolvedIn(spanned, '018_probe.sql'), note).toHaveLength(1);
    }
    // THE FAIL-CLOSED STOP on a line that ended mid-value. Carrying the value
    // on lends a table below; resetting silently truncates at the continuation
    // line's own `;`, which drops a MERGE insert list — the one writer shape
    // that carries no assignment for the fail-closed arm to catch. Stopping
    // with no terminator is what puts it in front of the readable arm instead.
    const valueAcrossLines = [
      'MERGE INTO accounts a',
      " USING (SELECT 'seed",
      " note; here'::text AS n) s ON true",
      " WHEN NOT MATCHED THEN INSERT (email, updated_at) VALUES ('u@x.pt', NOW());",
    ];
    const truncated = statementAt(asCode(valueAcrossLines, true), 0, 0);
    expect(truncated.closedAt).toBe(-1);
    expect(truncated.lastLine).toBe(1);
    expect(unreadableIn(valueAcrossLines, '018_probe.sql')).toHaveLength(1);
    // The same stop reached from the ALTER head, which is what holds that head
    // in READ_FROM_HEADS. A DEFAULT string wrapped ahead of the retype stops the
    // read on the value's own line, and `accountsColumnAlterations` is the only
    // scan that sees a rewrite carrying no assignment and no column list, so it
    // reads the truncated text as naming nothing. The readable arm is then the
    // one bar left, and this goes through its mirror because the mirror reads
    // the set the arm reads. The single-line control is the same rewrite with
    // the value closed on its line: nothing to report as unreadable, and the
    // ALTER pin sees the column itself, which is the arm meant for that shape.
    const wrappedDefault = [
      "ALTER TABLE accounts ADD COLUMN note TEXT DEFAULT 'wrapped",
      "value', ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING NOW();",
    ];
    expect(unreadableIn(wrappedDefault, '018_probe.sql')).toHaveLength(1);
    expect(accountsColumnAlterations(readable([{ rel: '018_probe.sql', lines: wrappedDefault }]))).toHaveLength(0);
    const oneLineDefault = [
      "ALTER TABLE accounts ADD COLUMN note TEXT DEFAULT 'one line', ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING NOW();",
    ];
    expect(unreadableIn(oneLineDefault, '018_probe.sql')).toEqual([]);
    expect(accountsColumnAlterations(readable([{ rel: '018_probe.sql', lines: oneLineDefault }]))).toHaveLength(1);
    // The scan's case fold, since the heads are matched under flags the scan
    // sets rather than the ones the patterns carry.
    expect(unreadableIn(wrappedDefault.map((l) => l.toLowerCase()), '018_probe.sql')).toHaveLength(1);
    // And a statement that runs past the read cap is reported as well as one
    // that stops mid-value. The two report the same missing terminator for
    // different reasons, and only the terminator is what the scan tests.
    const overlong = [
      'ALTER TABLE accounts',
      ...Array.from({ length: LITERAL_CAP + 2 }, (_, n) => `  ADD COLUMN IF NOT EXISTS pref_${n} TEXT,`),
      '  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING NOW();',
    ];
    expect(statementAt(asCode(overlong, true), 0, 0).stopped).toBe(false);
    expect(unreadableIn(overlong, '018_probe.sql')).toHaveLength(1);
    // The head's COLUMN, since a statement is read from where its head sits and
    // not from the start of the line. A migration opening its line with
    // anything else puts the head to the right of column 0.
    expect(unreadableIn(['BEGIN; ' + wrappedDefault[0], wrappedDefault[1]], '018_probe.sql')).toHaveLength(1);
    // EVERY head on the line, not the first: a line carrying two ALTERs hides
    // the second one's truncation behind the first one's clean read.
    expect(
      unreadableIn([`${oneLineDefault[0]} ${wrappedDefault[0]}`, wrappedDefault[1]], '018_probe.sql'),
    ).toHaveLength(1);
    // Matched against the BLANKED line, so a comment inside the head is a gap
    // the pattern reads through rather than a head the scan cannot see.
    expect(
      unreadableIn(["ALTER TABLE /* the light rows */ accounts ADD COLUMN note TEXT DEFAULT 'wrapped", wrappedDefault[1]], '018_probe.sql'),
    ).toHaveLength(1);
    // And TypeScript, since the scan runs over both trees: a template MERGE
    // whose value wraps stops the same way, and its insert list is the one
    // writer shape carrying no assignment for the fail-closed arm to catch.
    expect(
      unreadableIn([
        'async function touch(id: number) {',
        '  await q(`MERGE INTO accounts a',
        "   USING (SELECT 'seed",
        "   note; here'::text AS n) s ON true",
        "   WHEN NOT MATCHED THEN INSERT (email, updated_at) VALUES ('u@x.pt', NOW())`, [id]);",
        '}',
      ]),
    ).toHaveLength(1);
    // THE SPAN-STACK CLEAR on the backtick that ends a template. Ending the
    // template without clearing the tags leaves the reader in value-passthrough
    // for the lines after it, so the next statement's comment gap survives. The
    // shape is an ordinary sigil constant beside an ordinary query.
    const sigilThenWrite = [
      'async function touch(id: number) {',
      '  const sigil = `$$a`;',
      '  await q(`UPDATE accounts SET custody = $1, updated_at /* the server clock */ = NOW()`, [id]);',
      "  const pair = '$$';",
      '}',
    ];
    expect(scansOf(sigilThenWrite).tableFirst).toEqual(['x.ts#touch']);
    expect(scansOf(sigilThenWrite).columnFirst).toEqual(['x.ts#touch']);
    // THE DIALECT ARGUMENT on the NESTED opener call, not just the call itself.
    // Hard-coded to the migration answer, the placeholder-builder `$${n}` opens
    // a nested span inside a body held in a template, which then bounds the
    // body's comment search at `$$` instead of at the body's own tag — so a
    // `$$` written inside the comment ends the search early, the comment is
    // refused, and the gap it sits in stays open.
    const bodyInTemplateWithPlaceholder = [
      'async function touch(n: number) {',
      '  await q(`DO $body$',
      'BEGIN',
      '  PERFORM $${n};',
      "  UPDATE accounts SET custody = 'self', updated_at /* stamped $$ here */ = NOW();",
      'END $body$`, [n]);',
      '  const sigil = `$$`;',
      '}',
    ];
    expect(scansOf(bodyInTemplateWithPlaceholder).tableFirst).toEqual(['x.ts#touch']);
    expect(scansOf(bodyInTemplateWithPlaceholder).columnFirst).toEqual(['x.ts#touch']);
  });

  it('a backtick is a delimiter in TypeScript and a character everywhere in SQL', () => {
    // EVERY arm that acts on a backtick is gated on the DIALECT. Gating on the
    // template flag alone reads safe and is not: the flag starts false in a
    // `.sql` file and nothing kept it there, so one unpaired backtick inside an
    // ordinary quoted value switched a migration into template mode for the
    // rest of the file — after which its `--` arm stopped blanking, a `$$`
    // value opened as a span and the live write beside it went unseen.
    const unpaired = [
      "UPDATE audit_log SET note = 'tick ` mark' WHERE id = 1;",
      '',
      "UPDATE accounts SET note = $$a ` -- b$$, updated_at = NOW() WHERE username = 'x';",
    ];
    expect(scansOf(unpaired, '018_probe.sql').tableFirst).toEqual(['018_probe.sql#<module>']);
    expect(scansOf(unpaired, '018_probe.sql').columnFirst).toEqual(['018_probe.sql#<module>']);
    expect(blankFile(unpaired, true)[2]).toBe(unpaired[2]);
    // A backtick PAIR inside a `RAISE NOTICE` string is the same arm one layer
    // in: ungated it cleared the OPEN TAG STACK mid-body, so the block's own
    // `END $$` read as an opener instead of a close. `END ` is not a body
    // keyword, so what opened was a VALUE — comments copied through, the gap
    // between `updated_at` and its `=` wide open, and the end state still clean
    // because the next block's `$$` closed the span the first one left.
    const notice = [
      'DO $$',
      'BEGIN',
      "  RAISE NOTICE 'something ` quoted ` here';",
      'END $$;',
      '',
      "UPDATE accounts SET custody = 'light', updated_at /* gap */ = NOW() WHERE id = 1;",
      '',
      'DO $$',
      'BEGIN',
      "  RAISE NOTICE 'second block';",
      'END $$;',
    ];
    expect(scansOf(notice, '018_probe.sql').tableFirst).toEqual(['018_probe.sql#<module>']);
    expect(scansOf(notice, '018_probe.sql').columnFirst).toEqual(['018_probe.sql#<module>']);
    // The end state is asserted beside it because a clean end state is exactly
    // what let this one through: the walker-health arm cannot be what catches a
    // stack cleared and re-balanced inside the same file.
    expect(blankAll(notice, true).state.dollar).toEqual([]);
    // The TOP-LEVEL arm's gate, pinned at the state rather than through a
    // writer: a bare backtick outside every value in a migration is malformed
    // SQL, so there is no plausible writer fixture that reaches it, and the
    // observable the gate governs is the flag it would otherwise set for the
    // rest of the file. An ODD count, because a pair toggles the flag on and
    // back off and ends the line in the same state with the gate deleted. This
    // is the gate the other two arms lean on: they test the flag, and it is
    // this arm alone that could set the flag in a `.sql` file.
    expect(blankAll(['SELECT `a;'], true).state.template).toBe(false);
    expect(blankAll(['const a = `x`;'], false).state.template).toBe(false);
    expect(blankAll(['const a = `x;'], false).state.template).toBe(true);
    // And the arms still do their job in TypeScript, where a backtick really
    // does delimit: the template opens, and a `--` inside it is a comment
    // however it is spelled.
    expect(scanned("  await q(`UPDATE accounts SET a = 1--x`);").trimEnd()).toBe('  await q(`UPDATE accounts SET a = 1');
    // The FLAG half, which the dialect gate does not supply. In TypeScript a
    // backtick ends a template only where one is open; inside an ordinary
    // single-quoted string it is one of the string's characters. The arm that
    // meets a backtick inside a VALUE acted on the dialect alone, so it ended
    // the value there and handed the rest of the string to the code rules,
    // where a `/*` opened a block comment running to the next `*/` and blanked
    // the plain write between them. Not a quoted identifier, not dynamic SQL:
    // an ordinary `UPDATE accounts SET updated_at = NOW()`.
    const quotedTicks = [
      'async function touch(id: number) {',
      "  const pattern = 'cache `sessions` /* legacy';",
      "  await q('UPDATE accounts SET updated_at = NOW() WHERE id = $1', [id]);",
      "  const closer = 'end */';",
      '}',
    ];
    expect(scansOf(quotedTicks).tableFirst).toEqual(['x.ts#touch']);
    expect(scansOf(quotedTicks).columnFirst).toEqual(['x.ts#touch']);
    // A `${...}` INTERPOLATION holds TypeScript, not SQL, and what it holds can
    // be a template of its own. Read flat, that nested template's OPENING
    // backtick closes the outer one, so the flag says no template is open while
    // one still is, and the opaque-branch backtick arm then declines the next
    // backtick it meets inside a value. The rest of the line becomes one value:
    // the write's own
    // template, its backticks and the comment in its token gap all disappear
    // into it. So an interpolation is copied whole and nothing inside one is a
    // delimiter.
    const interpolated = [
      'async function touch(id: number, ok: boolean) {',
      "  const label = `outer ${ok ? `inner '` : ''} end`; await q(`UPDATE accounts SET updated_at /* stamped */ = NOW() WHERE id = $1`, [id]);",
      '}',
    ];
    expect(scansOf(interpolated).tableFirst).toEqual(['x.ts#touch']);
    expect(scansOf(interpolated).columnFirst).toEqual(['x.ts#touch']);
    // Its close is found by quoting as well as by brace depth, since a `}`
    // inside a string closes nothing. An interpolation in the write's OWN
    // statement is what makes that observable: ended early, the quote left
    // behind opens a value and the comment in the SET list's token gap stays
    // live inside it.
    expect(
      scansOf([
        'async function touch(id: number) {',
        "  await q(`UPDATE accounts SET note = ${fmt('}')}, updated_at /* stamped */ = NOW() WHERE id = $1`, [id]);",
        '}',
      ]).tableFirst,
    ).toEqual(['x.ts#touch']);
    // And the quote spellings an interpolation carries stay inside it: a regex
    // with an apostrophe, and an ordinary quoted string.
    expect(
      scansOf([
        'async function touch(id: number, raw: string) {',
        "  const label = `outer ${raw.replace(/'/g, \"''\")} end`; await q(`UPDATE accounts SET updated_at /* stamped */ = NOW() WHERE id = $1`, [id]);",
        '}',
      ]).tableFirst,
    ).toEqual(['x.ts#touch']);
  });

  it('a regex literal is read whole, so a quote or a marker inside one opens nothing', () => {
    // A quote inside a regex literal is one of the pattern's characters. The
    // `"`-matching spellings are already in the tree, in the bridge's HTML
    // scraping and in HTML escaping; the apostrophe ones, `v.replace(/'/g,
    // "''")`, are what a SQL layer reaches for and are not in it yet. Read as a
    // quote, a pattern's quote opens a VALUE that is not there, and
    // the rest of the line is judged from inside it. A template on that line is
    // then read as a value, so the comments in its token gaps stay live; a `/*`
    // inside a real string is read as code and blanks the lines below it to the
    // next `*/`; a `//` or `--` inside a SQL literal is read as code and blanks
    // the rest of the line. Each hides an ordinary write, and the flag gate on
    // a backtick met inside a value makes the first of them certain.
    //
    // A write counts as CAUGHT when it lands where a red bar reads it: on
    // accounts, or unresolved for the fail-closed arm. Any other table is
    // silence.
    const caught = (...body: string[]): number => {
      const found = columnAssignments(
        readable([{ rel: 'x.ts', lines: ['async function touch(v: string, w: string, id: number) {', ...body, '}'] }]),
      );
      return (found.get('accounts') ?? []).length + (found.get(UNRESOLVED_TABLE) ?? []).length;
    };
    const gap = 'await q(`UPDATE accounts SET updated_at /* stamped */ = NOW() WHERE id = $1`, [id]);';
    // A template on the pattern's line, bare and holding a quoted literal of its own.
    expect(caught(`  const safe = v.replace(/'/g, "''"); ${gap}`)).toBe(1);
    expect(caught("  const safe = v.replace(/'/g, \"''\"); await q(`UPDATE accounts SET custody = 'light', updated_at /* stamped */ = NOW() WHERE id = $1`, [id]);")).toBe(1);
    // An even count of phantom quotes, which leaves the line looking balanced:
    // an apostrophe in a trailing comment, and a second hand-escape on the line.
    expect(caught(`  const safe = v.replace(/'/g, "''"); ${gap} // don't retry`)).toBe(1);
    expect(caught("  const a = v.replace(/'/g, \"''\"); await q(`UPDATE accounts SET updated_at /* stamped */ = NOW() WHERE id = $1`, [id, w.replace(/'/g, \"''\")]);")).toBe(1);
    // The double-quote pattern, which is the spelling this tree already writes.
    expect(caught(`  const bare = v.replace(/"/g, ''); ${gap} log("touched");`)).toBe(1);
    // A line-comment marker inside a SQL literal, read as code and blanking the
    // assignment after it.
    expect(caught("  const safe = v.replace(/'/g, \"''\"); await q(`UPDATE accounts SET avatar = 'https://example.org/a.png', updated_at = NOW() WHERE id = $1`, [id]);")).toBe(1);
    expect(caught("  const safe = v.replace(/'/g, \"''\"); await q(`UPDATE accounts SET bio = '-- none --', updated_at = NOW() WHERE id = $1`, [id]);")).toBe(1);
    // A block-comment opener inside a string, in a template and in a plain
    // string, blanking a write on the NEXT line down to a later closer.
    const below = ["  await q('UPDATE accounts SET updated_at = NOW() WHERE id = $1', [id]);", '  /** a later doc comment */'];
    expect(caught("  const safe = v.replace(/'/g, \"''\"); const images = await q(`SELECT id FROM uploads WHERE mime LIKE 'image/*'`, []);", ...below)).toBe(1);
    expect(caught("  const safe = v.replace(/'/g, \"''\"); const images = 'image/*';", ...below)).toBe(1);
    //
    // Where a pattern ENDS. An escaped slash does not end it, and neither does
    // a slash inside a character class; each, taken as the end, leaves the
    // quote after it outside the pattern. The escape skips ONE character, and
    // the class ends at its own `]`: skip two and `/\\/` runs past its closer,
    // hold the class open and a class-led pattern never closes at all.
    expect(caught(`  const safe = v.replace(/\\/'/g, ''); ${gap}`)).toBe(1);
    expect(caught(`  const safe = v.replace(/[/']/g, ''); ${gap}`)).toBe(1);
    expect(caught(`  const safe = p.replace(/\\\\/g, '/'); ${gap}`)).toBe(1);
    expect(caught(`  const safe = v.replace(/[']/g, "''"); ${gap}`)).toBe(1);
    //
    // Where a pattern STARTS, which is told from a division by the code before
    // the slash. After a keyword a slash opens a pattern, and each keyword is
    // its own line here because dropping one from the list leaves the pattern
    // after it read as a division ...
    for (const keyword of ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']) {
      expect(caught(`  ${keyword} /'/.test(v) ? q(\`UPDATE accounts SET updated_at /* stamped */ = NOW() WHERE id = $1\`, [id]) : null;`), keyword).toBe(1);
    }
    // ... and after an operand it divides, so a comment after the division is
    // still a comment. Read as a pattern, the division swallows the comment's
    // opener and leaves its text live. One line per kind of operand end,
    // including the postfix operators that keep an operand an operand, the
    // non-null assertion above all: `x! / y` is ordinary TypeScript. Then a
    // name that only ENDS in a keyword, a PROPERTY named for one, the keyword
    // before a name rather than before the slash, and a comment between the
    // operand and the slash, which is judged from the blanked line and so does
    // not stand in for the operand it follows.
    for (const line of [
      '  const half = total / 2 /* note */;',
      '  const half = (total) / 2 /* note */;',
      '  const half = xs[0] / 2 /* note */;',
      '  const half = total$ / 2 /* note */;',
      '  const half = 3600 / 2 /* note */;',
      '  const half = DAY_SECONDS / 2 /* note */;',
      '  const half = amanhã / 2 /* note */;',
      '  const half = total! / 2 /* note */;',
      '  const half = total++ / 2 /* note */;',
      '  const half = total-- / 2 /* note */;',
      "  const half = 'x' / 2 /* note */;",
      '  const half = `x` / 2 /* note */;',
      '  const half = {} / 2 /* note */;',
      '  const half = total_ / 2 /* note */;',
      "  const half = \"100\" / 2 /* note */;",
      '  const half = noreturn / 2 /* note */;',
      '  const half = weight_of / 2 /* note */;',
      '  const half = row2in / 2 /* note */;',
      '  const half = tally$of / 2 /* note */;',
      '  const half = obj.return / 2 /* note */;',
      '  return total / 2 /* note */;',
      '  const half = total /* c */ / 2 /* note */;',
    ]) {
      expect(scanned(line), line).toBe(line.replace(/\/\* [a-z]+ \*\//g, (c) => ' '.repeat(c.length)));
    }
    // The PREFIX `!` is not a postfix one: a pattern still opens after it.
    expect(caught(`  if (!/^[a-z]+$/.test(v)) ${gap}`)).toBe(1);
    // The pattern is copied through, and only the comment after it is blanked:
    // the arm writes the literal's own characters into the blanked line, and
    // nothing else on the line moves.
    const withPattern = "  const safe = v.replace(/'/g, \"''\"); // trims the quote";
    expect(scanned(withPattern)).toBe(withPattern.replace('// trims the quote', ' '.repeat('// trims the quote'.length)));
    // A slash LEADING its line continues the previous line carrying code,
    // since the language inserts no semicolon before one. Judged from its own
    // line alone, the
    // division reads as a pattern, eats the trailing comment's opener, and the
    // glob in that comment's prose blanks the write below it.
    expect(
      caught('  const share = total', '    / count; // rates across /api/papers/* and /api/reviews/*', `  ${gap}`, '  /** a later doc comment */'),
    ).toBe(1);
    // The line it reads back to is the nearest one CARRYING code, so a comment
    // line in between does not stand in for the operand ...
    expect(
      caught('  const share = total', '  // divided by the number of pages', '    / count; // rates across /api/papers/*', `  ${gap}`, '  /** a later doc comment */'),
    ).toBe(1);
    // ... and neither does the blank the operand's own line ends in once a
    // trailing comment on it has been blanked away.
    expect(
      caught('  const share = total // the running total', '    / count; // rates across /api/papers/*', `  ${gap}`, '  /** a later doc comment */'),
    ).toBe(1);
    // Patterns are TypeScript. PostgreSQL has a prefix operator spelled with a
    // slash, `|/` for a square root, so a slash after a bar is an operator in a
    // migration and in the SQL a template holds, and read as a pattern there it
    // swallows the comment between two of them.
    const rooted = 'UPDATE accounts SET score = |/ score, updated_at /* c */ = |/ 4.0 WHERE id = 1';
    expect(scansOf([`${rooted};`], '018_probe.sql').tableFirst).toEqual(['018_probe.sql#<module>']);
    expect(scansOf(['async function touch(id: number) {', `  await q(\`${rooted}\`, [id]);`, '}']).tableFirst).toEqual(['x.ts#touch']);
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

  /** The `accounts` statements in a fixture file that cannot be read to a
   *  terminator, through the same scan the every-statement-readable arm runs. */
  function unreadableIn(lines: string[], rel = 'x.ts'): string[] {
    return unreadableStatements(readable([{ rel, lines }])).map((o) => o.site);
  }

  /** The assignments in a fixture file that no readable head reaches, which is
   *  what the fail-closed arm reports. */
  function unresolvedIn(lines: string[], rel = 'x.ts'): Occurrence[] {
    return columnAssignments(readable([{ rel, lines }])).get(UNRESOLVED_TABLE) ?? [];
  }

  /** What the writer scans make of a fixture file. */
  function scansOf(lines: string[], rel = 'x.ts'): { columnFirst: string[]; tableFirst: string[] } {
    const files = readable([{ rel, lines }]);
    return {
      columnFirst: Object.keys(countsOf(columnAssignments(files).get('accounts') ?? [])),
      tableFirst: Object.keys(countsOf(accountsColumnWriters(files))),
    };
  }

  it('every accounts statement can be read whole', () => {
    const unread = unreadableStatements([...sources, ...migrations]);
    expect(
      unread,
      'an accounts statement whose text stops without reaching a terminator, because it ran ' +
        'past the read cap or ended a line inside an unbalanced value. Every scan asks whether ' +
        'the statement text carries something — a column in a SET list, a column list, an ' +
        'ALTER naming the column — and can only answer for text it read to the end: a clause ' +
        'that closes beyond the stop reads as carrying nothing. Close the value on its own ' +
        'line, shorten the statement, or raise the cap deliberately. ' +
        `Why it matters: ${ORDERING_RATIONALE}\n${sitesOf(unread)}`,
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
    // And the head under each optional clause PostgreSQL allows between the
    // keyword and the table, one line per clause so deleting that clause alone
    // reds its own line. `IF EXISTS` is the clause this tree has yet to write
    // and would reach for first: every ALTER head here is bare today, while
    // idempotency is spelled at the column and at the constraint, so the clause
    // is one migration away rather than already in front of us.
    expect(alterations(['ALTER TABLE IF EXISTS accounts DROP COLUMN updated_at;'])).toBe(1);
    expect(alterations(['ALTER TABLE ONLY accounts DROP COLUMN updated_at;'])).toBe(1);
    expect(alterations(['ALTER TABLE public.accounts DROP COLUMN updated_at;'])).toBe(1);
    // Two clauses together. This line needs BOTH of them to match, so deleting
    // either one reds it alongside that clause's own single-clause line; what
    // it ADDS is their order. PostgreSQL takes `IF EXISTS ONLY` and rejects
    // `ONLY IF EXISTS`, so a pattern carrying the two groups the other way
    // round still matches each clause on its own and goes blind on the
    // combination alone. The per-clause attribution comes from the set of
    // single-clause lines, not from this one.
    expect(alterations(['ALTER TABLE IF EXISTS ONLY accounts DROP COLUMN updated_at;'])).toBe(1);
    // All three groups at once, in grammar order. This is the only spelling
    // that carries every one of them, and so the only one that answers for the
    // qualifier's POSITION: three optional groups admit three pairwise orders,
    // and the single-clause lines answer for none of them. Hoist the qualifier
    // to the front of the pattern and every other line here still matches while
    // `ALTER TABLE IF EXISTS public.accounts` stops being counted at all. This
    // line misses under every reordering of the three.
    expect(alterations(['ALTER TABLE IF EXISTS ONLY public.accounts DROP COLUMN updated_at;'])).toBe(1);
    // A parenthesised target, which PostgreSQL admits under `ONLY` and nowhere
    // else: a bare `ALTER TABLE (accounts)` is a syntax error, which is why the
    // paren rides inside the `ONLY` group here rather than outside it as the
    // DML heads spell it. The gap after `ONLY` is optional because the closed-up
    // spelling parses too, and the `ONLY(accounts)` fixture is what pins it so.
    expect(alterations(['ALTER TABLE ONLY (accounts) DROP COLUMN updated_at;'])).toBe(1);
    expect(alterations(['ALTER TABLE ONLY(accounts) DROP COLUMN updated_at;'])).toBe(1);
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
    // while thirteen of them were read as live source.
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
    expect(blockCloses(['  /* an opener with no closer anywhere', ...filler], 0, 2, [])).toBe(false);
    expect(blockCloses(['  /* an opener whose closer is a long way down', ...filler, '  */'], 0, 2, [])).toBe(true);
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
    // The varied axis is the `sigil` argument: each is a shape that could be
    // read as a dollar-quote opener but must not be. The `gapped` write it
    // precedes carries its comment in the gap a pattern needs, so that write is
    // seen only while comment blanking is still switched on.
    const afterSigil = (sigil: string): string[] => ['async function touch(id: number) {', sigil, gapped, '}'];
    expect(scansOf(afterSigil('  await q(`INSERT INTO staging (a, b) VALUES ($1,$2)`, [id]);')).tableFirst).toEqual([key]);
    expect(scansOf(afterSigil('  const named = body.replace(re, `${prefix}$1`);')).tableFirst).toEqual([key]);
    // And a grammatical tag that never recurs opens nothing either: a span that
    // cannot close is not a span, the same answer `blockCloses` gives.
    expect(scansOf(afterSigil('  await q(`SELECT $tag$ AS sigil`, [id]);')).tableFirst).toEqual([key]);
    expect(DOLLAR_QUOTE_RE.test('$$')).toBe(true);
    expect(DOLLAR_QUOTE_RE.test('$body$')).toBe(true);
    expect(DOLLAR_QUOTE_RE.test('$não$')).toBe(true);
    expect(DOLLAR_QUOTE_RE.test('$1,$2)')).toBe(false);
    expect(DOLLAR_QUOTE_RE.test('${prefix}$1')).toBe(false);
    expect(DOLLAR_QUOTE_RE.test('$t-1$')).toBe(false);
    // The interpolation exclusion belongs to TypeScript alone. `$${...}$$` is
    // the placeholder-builder idiom in a template and an ordinary dollar-quoted
    // literal in a migration — one whose content begins with a brace, which is
    // how an array literal is spelled and exactly the reason an author reaches
    // for dollar quoting in the first place. Applied to a migration it refuses a
    // real span, so the statement read ends at a `;` that is one of the
    // literal's own characters and the rest of the statement is never examined.
    expect(dollarOpenerAt(['  const p = `$${idx}`;'], 0, '  const p = `'.length, true)).toBeNull();
    expect(dollarOpenerAt(["SET flags = $${a;b}$$::text[], updated_at = NOW();"], 0, 'SET flags = '.length, false)).toBe('$$');
    // An ALTER that rewrites the column, behind a brace-leading literal whose
    // `;` would otherwise terminate the read before the ALTER COLUMN clause.
    expect(
      accountsColumnAlterations(
        readable([{ rel: '018_probe.sql', lines: ['ALTER TABLE accounts', '  ADD COLUMN IF NOT EXISTS affiliations TEXT[] NOT NULL', '    DEFAULT $${Porto; INESC TEC}$$::text[],', '  ALTER COLUMN updated_at TYPE TIMESTAMPTZ', "    USING date_trunc('second', updated_at);"] }]),
      ),
    ).toHaveLength(1);
    // The MERGE insert list behind the same literal, which carries no
    // assignment anywhere and so is the table-first scan's alone to see.
    expect(
      scansOf(['MERGE INTO accounts a', 'USING (', "  SELECT 'i@x.pt'::text AS email, $${Porto; INESC TEC}$$::text[] AS aff", ') s', '   ON s.email = a.email', ' WHEN NOT MATCHED THEN', '   INSERT (email, custody, updated_at)', "   VALUES (s.email, 'light', NOW());"], '018_probe.sql').tableFirst,
    ).toEqual([migration]);
    // And a `--` that is one of the literal's characters, which is read as a
    // comment only if the literal is refused.
    expect(
      scansOf(["UPDATE accounts SET importer_flags = $${--strict,--skip}$$::text[], updated_at = NOW() WHERE custody = 'light';"], '018_probe.sql').tableFirst,
    ).toEqual([migration]);
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
    // A literal NESTED inside a code body is the SQL the body executes, so a
    // comment in one of its token gaps silences the same patterns it silences
    // anywhere else. Read as data, the gap is wide open inside a block that
    // bumps the marker on every finalized row.
    expect(
      scansOf(['DO $$', 'BEGIN', "  EXECUTE $q$UPDATE accounts SET custody = 'light', updated_at /* the server clock */ = NOW();$q$;", 'END $$;'], '018_probe.sql').tableFirst,
    ).toEqual([migration]);
    expect(
      scansOf(['DO $$', 'BEGIN', "  EXECUTE $q$UPDATE accounts SET custody = 'light', updated_at -- the server clock", '     = NOW();$q$;', 'END $$;'], '018_probe.sql').tableFirst,
    ).toEqual([migration]);
    // Quoting is tracked at every depth, so a marker that is a CHARACTER of a
    // string value inside the executed SQL is not a comment at all. Read
    // without it, an ordinary separator-normalising back-fill blanks its own
    // live tail: the `--` in the pattern is taken for a comment, and the
    // `updated_at = NOW()` beside it goes with it.
    expect(
      scansOf(['DO $$', 'BEGIN', '  EXECUTE $q$UPDATE accounts', "     SET institution = regexp_replace(institution, '\\s*--\\s*', ' - ', 'g'), updated_at = NOW()", "   WHERE institution LIKE '%--%'$q$;", 'END $$;'], '018_probe.sql').tableFirst,
    ).toEqual([migration]);
    // The same for a block-comment marker held as data, which is worse: a `/*`
    // carries no bound of its own and blanks across LINES to whatever `*/` it
    // finds ahead.
    expect(
      scansOf(['DO $$', 'BEGIN', '  EXECUTE $q$', '    UPDATE accounts', "       SET institution = replace(institution, '/*', ''),", '           updated_at = NOW()', "     WHERE institution LIKE '%*/%'$q$;", 'END $$;'], '018_probe.sql').tableFirst,
    ).toEqual([migration]);
    // A VALUE inside a nested literal is bounded by the literal's own tag.
    // Dollar quoting exists so a value need not escape its quotes, so an
    // unpaired apostrophe inside one is correct SQL and routine in operator
    // prose. Read as an open value it swallows the literal's closing tag, and
    // what that costs is not the line it sits on — the blanking recovers at the
    // next line — but the SPAN RECORD: every line after it registers one level
    // too deep, and the statement read replays that depth and suppresses the
    // terminator of the next statement for the length of its cap.
    const quotedInNested = [
      'DO $$',
      'BEGIN',
      '  INSERT INTO custody_audit_log (event, detail)',
      "  VALUES ('started', $d$ 016's back-fill skipped rows with a NULL marker $d$);",
      '  UPDATE "accounts"',
      '     SET updated_at = NOW()',
      "   WHERE custody = 'light';",
      'END $$;',
    ];
    expect(blankAll(quotedInNested, true).state.dollar).toEqual([]);
    expect(asCode(quotedInNested, true).entry?.[4]).toEqual(['$$']);
    expect(unresolvedIn(quotedInNested, '018_probe.sql')).toHaveLength(1);
    // And a literal nested inside the nested one: the depth is a stack, not a
    // single tag, because PostgreSQL lets a body's literal carry one of its own.
    expect(
      scansOf(['DO $$', 'BEGIN', '  EXECUTE $q$UPDATE accounts SET institution = $t$Porto -- Engenharia$t$, updated_at = NOW()$q$;', 'END $$;'], '018_probe.sql').tableFirst,
    ).toEqual([migration]);
    // A block comment that does NOT close before the literal does is not a
    // comment: searching past the tag blanks the body's own text after it. The
    // shape is malformed SQL either way — an opener the executed statement
    // never closes — and what the bound decides is which way it fails. Bounded,
    // the marker is read as text and the live statement beside it is still
    // seen; unbounded, the search finds a `*/` further down the FILE, blanks
    // every line between, and a real writer disappears. Over-reading a comment
    // marker costs a red bar on text that was never live; under-reading a live
    // statement costs the guard.
    expect(blockCloses(["  EXECUTE $q$SELECT /* note $q$; UPDATE accounts SET updated_at = NOW();"], 0, '  EXECUTE $q$SELECT '.length, ['$q$'])).toBe(false);
    expect(blockCloses(["  EXECUTE $q$SELECT /* note */ 1$q$;"], 0, '  EXECUTE $q$SELECT '.length, ['$q$'])).toBe(true);
    // The boundaries are a SET because a body inside a TEMPLATE ends for two
    // reasons and the nearer one wins. Split into a per-boundary function the
    // in-body search kept the tag and lost the backtick, and the loss reads
    // green: a search that runs too far only ever blanks MORE, so what it costs
    // is the live statement after the template rather than a red bar.
    const bodyInTemplate = [
      'async function touch(id: number) {',
      '  await q(`DO $$ BEGIN /* note`);',
      '  await q(`UPDATE accounts SET custody = $1, updated_at = NOW() WHERE id = $2`, [id]);',
      '  /* an ordinary comment further down */',
      "  const tag = '$$';",
      '}',
    ];
    const opener = bodyInTemplate[1].indexOf('/* note');
    expect(blockCloses(bodyInTemplate, 1, opener, ['$$', '`'])).toBe(false);
    expect(blockCloses(bodyInTemplate, 1, opener, ['$$'])).toBe(true);
    // End to end: bound by the tag alone, the `*/` two lines down blanks the
    // accounts write between them.
    expect(scansOf(bodyInTemplate).tableFirst).toEqual(['x.ts#touch']);
    expect(
      scansOf(
        ['DO $$', 'BEGIN', '  EXECUTE $q$SELECT /* unterminated$q$;', '  UPDATE accounts SET custody = $1, updated_at = NOW();', 'END $$;', '/* an ordinary comment further down the file */'],
        '018_probe.sql',
      ).tableFirst,
    ).toEqual([migration]);
    // And the blank inside such a literal STOPS at its closing tag, because the
    // characters past the tag are the body's again. Run to the end of the line
    // instead, a `--` belonging to the literal erases the live statement the
    // body spells beside it — a write present in the tree and seen by nothing.
    expect(
      scansOf(['DO $$', 'BEGIN', "  EXECUTE $q$SELECT 1 -- ignored$q$; UPDATE accounts SET custody = 'self', updated_at = NOW();", 'END $$;'], '018_probe.sql').tableFirst,
    ).toEqual([migration]);
    expect(
      scansOf(['DO $$', 'BEGIN', '  EXECUTE $q$SELECT 1', "  -- still inside the literal$q$; UPDATE accounts SET custody = 'self', updated_at = NOW();", 'END $$;'], '018_probe.sql').tableFirst,
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
    // The end anchor is also what decides which VALUE can supply the keyword,
    // and the KNOWN LIMITS say so: a CLOSED value cannot, because its own quote
    // sits after the word, and only a value left open at the end of its line
    // can. Pinned here so an example that reads well but cannot match fails
    // instead of being believed.
    expect(DOLLAR_CODE_BODY_RE.test("   SET note = 'stored exactly as'")).toBe(false);
    expect(DOLLAR_CODE_BODY_RE.test("   SET note = 'stored exactly as")).toBe(true);
    // And the clause that hides a real one, which the KNOWN LIMITS also name.
    expect(DOLLAR_CODE_BODY_RE.test('DO LANGUAGE plpgsql ')).toBe(false);
    // A dollar span is read where SQL runs, not in ordinary TypeScript: a pair
    // of `$`-fenced identifiers in code would otherwise span the statement
    // between them and switch its blanking off.
    const outsideTemplate = asCode([
      '  const tag = $body$;',
      '  await q(`UPDATE accounts SET custody = $1, updated_at /* stamped */ = NOW()`);',
      '  const end = $body$;',
    ]);
    expect(assignmentIndex(outsideTemplate[1])).toBeGreaterThan(-1);
    // ONE reader makes the opener judgement: the blanking reader, through
    // `dollarOpenerAt`. The statement read judges no openers of its own; it
    // replays the spans the blanking reader recorded. So a wrong judgement is
    // inherited rather than contradicted, and a span opened where none exists
    // carries the statement read past its own terminator — which lends that
    // statement's table to a write below it that no readable head reaches, so
    // the write resolves to a plausible other table instead of tripping the
    // fail-closed arm. Each condition is pinned where it is the ONLY one
    // answering, so dropping any of them from the helper reds a bar.
    //
    // The recurrence condition: a grammatical tag spelled once.
    expect(
      targetTable(asCode(['UPDATE sessions SET note = $tag$ WHERE id = 1;', 'UPDATE "accounts" SET updated_at = NOW() WHERE id = 2;'], true), 1),
    ).toBe(UNRESOLVED_TABLE);
    // The interpolation exclusion: the placeholder-builder idiom, with a real
    // `$$` further down so the recurrence condition is satisfied and cannot be
    // the one answering.
    expect(
      targetTable(
        asCode([
          '  await q(`',
          '    UPDATE sessions SET note = $${n} WHERE id = 1;',
          '    UPDATE "accounts" SET updated_at = NOW() WHERE id = 2`);',
          '  const sigil = `$$`;',
        ]),
        2,
      ),
    ).toBe(UNRESOLVED_TABLE);
    // A dollar-quoted span opened inside a template must not swallow the
    // template's own closing backtick: a value cannot hold one, and the missed
    // toggle leaves the flag inverted for the rest of the file, where an
    // ordinary decrement is then read as a comment and blanks the write beside
    // it.
    const swallowed = asCode([
      '  const sigil = `$$a`;',
      '  const pair = $$;',
      '  for (let i = n; i--; ) await q(`UPDATE accounts SET updated_at = NOW()`, [i]);',
    ]);
    expect(statementHead(swallowed[2])?.table).toBe('accounts');
    expect(assignmentIndex(swallowed[2])).toBeGreaterThan(-1);
    // An escape belongs to the TypeScript literal the span sits in, so an
    // escaped backtick inside a span is one of the value's characters and ends
    // no template. Read as the closer, it ends the template a backtick early
    // and the real closer re-opens one, which leaves the flag inverted the
    // same way a swallowed closer does.
    const escapedInSpan = asCode([
      '  const sigil = `$$a\\`b$$ and more`;',
      '  for (let i = n; i--; ) await q(`UPDATE accounts SET updated_at = NOW()`, [i]);',
    ]);
    expect(statementHead(escapedInSpan[1])?.table).toBe('accounts');
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
