/**
 * Standing source-discipline canary for `agents/docs/ARCHITECTURE.md` § 6.5
 * invariant #9: a session-proof window is never opened by session
 * establishment.
 *
 * A session-kind fresh-auth proof is target-less and multi-use for a bounded
 * window, so whoever holds one can broadcast and upload for the rest of that
 * window. § 6.4.1 licenses exactly two routes to open one, and both are an
 * explicit re-auth act on top of an already-authenticated session:
 *
 *   - `POST /api/custody/session-auth` — a password entry, argon2-verified.
 *   - `POST /api/orcid/callback mode='session_auth'` — a completed ORCID OAuth
 *     round-trip whose returned iD must equal the one linked to the account.
 *
 * Why a mechanical check rather than trusting review: the prohibited shape is
 * the one that looks most reasonable to a future author. "The user just proved
 * their password at `/login`, why send them through a second prompt before they
 * can vote?" is a sympathetic product ask, and the code that grants it is two
 * lines in a handler that already has the username in hand. `handleLogin` and
 * `handleSessionAuth` are sibling branches of ONE `/api/orcid/callback`
 * dispatch, both fed by a genuine OAuth round-trip, which makes minting on the
 * login branch look like a consistency fix rather than a security regression.
 * `POST /api/auth/signup-verify/confirm` is worse still: its documented
 * best-effort-JWT contract lets a fast retry mint a second JWT, so a proof
 * minted there would be minted twice per finalization.
 *
 * If any of those lands, invariant #1 ("critical actions require a fresh re-auth
 * proof") is satisfied in form and dead in substance: holding a session would
 * once again be enough to broadcast, which is the exact property the fresh-auth
 * layer exists to deny. The failure is silent — every test still passes, the
 * proof is still required on the wire, and the only thing that changed is that
 * possession of a JWT now produces one.
 *
 * GRANULARITY. The occurrence assertion is over `file#symbol` pairs, not over
 * files. The two licensed mints live in `routes/orcid.ts` and
 * `routes/custody.ts`, and `routes/orcid.ts` is where the most likely violation
 * lands: `handleLogin` sits beside `handleSessionAuth` in the same dispatch. A
 * file-set assertion cannot express "this file may mint, but only from that one
 * handler". The import assertion below is deliberately the other way round, file
 * granular, because an import statement always sits at module scope and the
 * symbol half of every key would be the constant module-scope label.
 *
 * SCOPE AND DETECTION. Every `.ts` file under `src/` is scanned,
 * `lib/fresh-auth.ts` included. Detection is a match on the mint's NAME, not on
 * a call shape: a call-shaped pattern is defeated by one line, since
 * `import { issueSessionFreshAuthToken as mint }` renames every call site to
 * `mint(...)`, and the aliasing caller writes no `kind: 'session'` literal for
 * the construction scan below to catch either. Matching the name catches the
 * alias at the import, which is the last place the real name is forced to
 * appear. The cost is that the definition, prose, and plain import specifiers
 * match too, so they are removed by an explicit skip predicate rather than by
 * the pattern's shape — and the specifier skip is VETOED by an `as` on the line,
 * which is the mechanism the alias catch turns on. A trailing prose mention of
 * the mint on a code line counts and goes red; stripping comment tails before
 * testing was considered and rejected, because a naive strip truncates at a
 * marker inside a string literal and would let a real reference hide behind a
 * URL. Reword the comment instead.
 *
 * The exact-set assertion is the load-bearing half: it catches a mint added in
 * a brand-new file or a brand-new handler, which a forbidden-file list never
 * would. The forbidden-file assertion exists on top of it to name the
 * sympathetic cases explicitly, so a red bar there reads as "this is invariant
 * #9" rather than "the allowlist needs updating".
 *
 * Further scans cover what a name-based canary structurally cannot.
 *
 * A window minted inside `lib/fresh-auth.ts` by NEW code under a different name
 * writes the mint's name nowhere, but it cannot avoid writing the
 * `kind: 'session'` discriminator, so the enclosing symbols of that literal are
 * pinned too. That scan is quote-, comma- and key-quoting-agnostic on purpose:
 * nothing in this package enforces any of them (the ESLint config is
 * safety-only, with no `quotes` and no `comma-dangle` rule, and there is no
 * prettier config in the repo), so keying on them made a name-independent
 * backstop defeatable by a style choice. Nor is it line-oriented: a wrapped
 * literal (`kind:` at end of line, the value on the next) and a bare shorthand
 * property (`kind,` forwarding a local binding) are both construction signals,
 * because both were full evasions of the value-anchored form and this scan is
 * the last line of defence behind a mint that calls nothing. The key-anchored
 * signal cannot see the VALUE, so it also fires on a wrapped `consent_op`
 * construction and on a bare destructure of `kind` — accepted false positives,
 * loud rather than silent, and none exist under `src/` today. What remains out
 * of reach is an entry assembled entirely by spread with no `kind` key of its
 * own; that shape cannot reach storage without a storage write, which is what
 * the write pins below close over.
 *
 * A helper that spread-copies an already validated entry with a pushed-out
 * deadline extends a window while writing neither the mint's name nor the
 * discriminator. `persistSessionSlide` is the chokepoint every such helper
 * SHOULD reach, and the clamp to the cap plus the revocation-epoch check both
 * live in its one legitimate caller, so that caller set is pinned. But a
 * chokepoint pin alone is stepped around by writing to the storage tiers
 * directly, so the writes themselves are pinned too: every `memStore.set` and
 * every Redis `SET` against the entry keyspace inside the module, the
 * `fresh_auth:token` key-namespace literal across the whole tree (so the
 * keyspace cannot be re-derived outside the module), and the test-only
 * in-memory seeding hook, which must never acquire a production caller.
 *
 * Finally, a coverage registry. The scans above stop a mint that still LOOKS
 * like one; the registry stops the other half, a brand-new route that issues a
 * session and that nobody remembered to assert a proof-free response for. The
 * registry attributes transitively: a call to `jwt.sign` marks its enclosing
 * symbol, and every CALLER of a plain-function symbol that encloses a mint is
 * marked as an issuing site as well, to a fixpoint. Without that, extracting
 * the mint into a helper collapses the registry to the helper's one symbol —
 * an edit that reads as ordinary maintenance — and every route calling the
 * helper afterwards issues sessions invisibly.
 *
 * A checked non-issue, recorded so it is not "fixed" later: the sibling sweep
 * scan in `tests/routes/session-proof-invalidation.test.ts` is a REQUIRED-call
 * canary, so an alias there makes a writer look unswept and fails closed. It
 * needs no equivalent change.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  MODULE_SCOPE,
  enclosingSymbol,
  isCommentLine,
  occurrencesOf,
  skipCommentLine,
  skipCommentOr,
  sourcesUnder,
  type ScannedSource,
} from '../support/enclosing-symbol.js';

/** ANY textual occurrence of the mint's name, not a call-shaped one. See the
 *  file docblock for why the call shape was abandoned. */
const SESSION_MINT_IDENT_RE = /\bissueSessionFreshAuthToken\b/;

/** The definition line. Skipped by shape so the module that defines the mint is
 *  still scanned for references to it. */
const SESSION_MINT_DEFINITION_RE = /function\s+issueSessionFreshAuthToken\s*\(/;

/** An UNALIASED named-import specifier for the mint, in every shape written
 *  here: its own line inside a multi-line import, the last specifier followed by
 *  a closing brace and `from`, and the single-line form. Taking a plain
 *  reference to the mint is not minting, so these are spared; WHICH modules may
 *  take that reference is pinned separately by the import-site assertion.
 *
 *  The closing-brace branch requires a following `from` rather than accepting a
 *  bare brace, because an unanchored closing brace also spares an object literal
 *  (`  issueSessionFreshAuthToken };`), which is a way to hold the reference
 *  without producing a counted occurrence. Every real import ends with a brace
 *  and `from`; an object literal does not. */
const SESSION_MINT_IMPORT_SPECIFIER_RE =
  /^\s*(?:import\s*\{[^}]*?)?issueSessionFreshAuthToken\s*(?:,|\}\s*from\b|$)/;

/** The identifier renamed at the import. Its presence VETOES the specifier skip,
 *  and that veto is the mechanism the whole scan turns on.
 *
 *  Two reasons the veto cannot be folded into the specifier pattern by simply
 *  omitting an `as` branch. First, the specifier pattern is satisfied by the
 *  FIRST specifier on a line, and duplicate specifiers for one exported name
 *  with distinct local bindings are legal, so an import naming the mint twice
 *  would be skipped on the strength of its unaliased half while handing the file
 *  a working alias. Second, the veto is what makes an alias introduced INSIDE an
 *  already-licensed module visible: unskipped, the specifier is a module-scope
 *  occurrence, hence a new `file#symbol` member, hence a red bar, which is the
 *  one case a file-granular import assertion structurally cannot see. */
const SESSION_MINT_ALIAS_RE = /\bissueSessionFreshAuthToken\s+as\b/;

/** The continuation of the statement a specifier line starts: the line joined
 *  with the following lines up to and including the one that ends the import
 *  clause (a `from`, a semicolon) or a small cap. The alias veto below runs
 *  against this joined text rather than the single line, because
 *  `issueSessionFreshAuthToken` on its own line followed by `as mint,` on the
 *  next is a legal specifier whose alias the per-line veto never saw — the
 *  specifier line matched the bare-name skip, the continuation line matched no
 *  pattern at all, and the file held a working alias. The occurrence helper
 *  already hands every skip predicate the surrounding lines; this is the scan
 *  that needs them. */
const jointImportStatement = (lines: string[], lineIndex: number): string => {
  let joined = lines[lineIndex];
  // A line that already carries its `from` or terminator is a complete
  // statement; joining past it could only pull in unrelated neighbours.
  if (/\bfrom\b|;/.test(joined)) return joined;
  for (let j = lineIndex + 1; j < lines.length && j <= lineIndex + 6; j++) {
    joined += '\n' + lines[j];
    if (/\bfrom\b|;/.test(lines[j])) break;
  }
  return joined;
};

/** The three shapes that name the mint without holding a callable reference
 *  under a new name: its own definition, a whole-comment line, and an unaliased
 *  import specifier. Everything else that writes the name counts. The alias
 *  veto is applied to the JOINED statement, not the single line — see
 *  {@link jointImportStatement}. */
const skipMintLine = (
  line: string,
  lineIndex: number,
  lines: string[],
  insideRegion?: boolean,
): boolean =>
  SESSION_MINT_DEFINITION_RE.test(line) ||
  isCommentLine(line, insideRegion) ||
  (SESSION_MINT_IMPORT_SPECIFIER_RE.test(line) &&
    !SESSION_MINT_ALIAS_RE.test(jointImportStatement(lines, lineIndex)));

/** A named import of the mint, matched against whole file text because both
 *  licensed imports are multi-line: no single line carries both the specifier
 *  and the module path that identifies it. Matches the aliased form too, so a
 *  module that pulls in the mint under any name is a member.
 *
 *  Anchored on the `.js` specifier this build requires. A module reached by some
 *  other spelling would be absent rather than a member, which shrinks the set
 *  instead of failing it; that leg is covered by the occurrence scan, which sees
 *  the reference line regardless of how the module was named. */
const SESSION_MINT_IMPORT_RE =
  /import\s*\{[^}]*\bissueSessionFreshAuthToken\b[^}]*\}\s*from\s*'[^']*fresh-auth\.js'/;

/** The session discriminator written as an object-literal field, in any quote
 *  style TypeScript accepts, with or without a trailing comma, and with the key
 *  itself quoted or not.
 *
 *  Accepted false positive, loud rather than silent: allowing whitespace before
 *  the colon also matches a ternary whose alternative is the literal. That is a
 *  red bar naming a symbol, which is the safe direction; refusing the whitespace
 *  would instead let `kind : 'session',` construct a window unseen. */
const SESSION_KIND_RE = /\bkind\b['"`\]\s]*:\s*(['"`])session\1/;

/** Occurrences that NAME the kind in TYPE position rather than construct an
 *  entry, removed from the line before the construction test runs. Two shapes
 *  exist and both must stay out of the scan: a union member inside a type
 *  literal, terminated by a semicolon, which object-literal syntax cannot carry;
 *  and a type-literal argument to a utility type, closed by a brace and an angle
 *  bracket.
 *
 *  Removal is per-OCCURRENCE, not a whole-line skip, because a whole-line skip
 *  keyed on a utility-type NAME hides a construction that merely shares the line
 *  with one, and a typed local declared from a narrowed type is the natural way
 *  to write exactly that. Stripping the type occurrence leaves the construction
 *  behind, where the scan still sees it.
 *
 *  Accepted false positive, again loud: a type narrowing wrapped so that the
 *  braced field sits alone on its line carries neither terminator and is read as
 *  construction. No such line exists under `src/` today. */
const SESSION_KIND_TYPE_OCCURRENCE_RE = /\bkind\b['"`\]\s]*:\s*(['"`])session\1\s*(?:;|\}\s*>)/g;

/** The construction-site predicate the scan applies, shared with the planted
 *  self-test below so the two cannot drift apart. `SESSION_KIND_RE` carries no
 *  global flag on purpose: only the stripping regex is global, and a global
 *  regex is stateful under `.test`. */
const constructsSessionEntry = (line: string, insideRegion?: boolean): boolean =>
  !isCommentLine(line, insideRegion) &&
  SESSION_KIND_RE.test(line.replace(SESSION_KIND_TYPE_OCCURRENCE_RE, ''));

/** The discriminator KEY in a position whose VALUE the line does not show: a
 *  bare shorthand property (`kind,` / `kind }`, forwarding a local binding) or
 *  a wrapped key (`kind:` at end of line, the value on the next). Both shapes
 *  construct an entry while writing no `'session'` literal on the matched line,
 *  so both stepped around the value-anchored scan entirely — and this is the
 *  backstop for a mint that calls nothing, so a shape it cannot see is a full
 *  evasion, not a degradation.
 *
 *  Because the value is out of sight, this signal cannot discriminate: a
 *  wrapped `consent_op` construction and a bare `{ kind }` destructure match
 *  too. Accepted false positives, loud rather than silent — each is a red bar
 *  naming a symbol, and none exist under `src/` today. The lookbehind keeps
 *  property reads (`entry.kind`) and other identifiers merely ending in the
 *  word (`operation_kind`) out; a comparison (`kind === ...`) never matches
 *  because the character after the key is an equals sign, not a comma, brace,
 *  colon-at-end, or line end. */
const SESSION_KIND_BARE_KEY_RE = /(?<![.\w])['"`]?\bkind\b['"`]?\s*(?:[,}]|:\s*$)/;

/** A line that either shows the full session discriminator or signals its key
 *  with the value out of sight. This composed predicate is what the whole-tree
 *  scan and the planted self-tests share. */
const signalsSessionEntry = (line: string, insideRegion?: boolean): boolean =>
  constructsSessionEntry(line, insideRegion) ||
  (!isCommentLine(line, insideRegion) && SESSION_KIND_BARE_KEY_RE.test(line));

/** The inverted skip the discriminator scan hands to `occurrencesOf`, shared
 *  between the whole-tree scan and its planted end-to-end probes so the two
 *  cannot drift apart. */
const skipNonSessionEntryLine = (
  line: string,
  _lineIndex: number,
  _lines: string[],
  insideRegion: boolean,
): boolean => !signalsSessionEntry(line, insideRegion);

/** A reference to the private slide persister, and its definition line. */
const SESSION_SLIDE_CALL_RE = /\bpersistSessionSlide\b/;
const SESSION_SLIDE_DEFINITION_RE = /function\s+persistSessionSlide\s*\(/;

/** A call that mints a session JWT. Every one is a surface where a proof could
 *  be attached to an established session. */
const JWT_MINT_RE = /\bjwt\.sign\s*\(/;

/** The only two handlers licensed to mint, one per factor (§ 6.4.1). */
const ALLOWED_MINT_SITES = [
  'routes/custody.ts#POST /session-auth',
  'routes/orcid.ts#handleSessionAuth',
];

/** The only modules allowed to hold a reference to the mint at all.
 *  `lib/fresh-auth.ts` defines it and therefore imports nothing. */
const ALLOWED_MINT_IMPORTERS = ['routes/custody.ts', 'routes/orcid.ts'];

/** The places the discriminator scan may fire: the mint and the slide, which
 *  construct session entries outright, and `validateStoredEntry`, which
 *  re-emits an already-stored entry's `kind` as a bare shorthand after
 *  structural narrowing. The third member is the price of the key-anchored
 *  signal, and it is legitimate because validation never invents a kind: the
 *  shorthand forwards a value read back from the storage tiers, whose writers
 *  are themselves pinned by the storage-write assertions below — an entry has
 *  to have been minted or slid by a pinned writer before validation can echo
 *  it. A visible allowlist member beats the blind spot it replaced: the old
 *  value-anchored scan simply could not see a construction written as a
 *  wrapped literal or a shorthand at all. */
const ALLOWED_SESSION_ENTRY_SITES = [
  'lib/fresh-auth.ts#consumeSessionWindow',
  'lib/fresh-auth.ts#issueSessionFreshAuthToken',
  'lib/fresh-auth.ts#validateStoredEntry',
];

/** The slide persister's only legitimate caller: the windowed consume, where
 *  the clamp to the cap and the revocation-epoch check live. */
const ALLOWED_SESSION_SLIDE_SITES = ['lib/fresh-auth.ts#consumeSessionWindow'];

/** Every toucher of the in-memory entry tier, pinned by the identifier rather
 *  than by a call shape so a wrapped call, an aliased method, or a `.clear()`
 *  cannot slip past. The map is module-private, so the scan is scoped to the
 *  module that declares it; the exported seeding hook is the one road in from
 *  outside and is pinned separately to zero production callers. Each member is
 *  a function this file's other assertions already hold in place: the two
 *  mints and the slide persister write entries, the burn and the sweeps and
 *  the drop delete them, the read serves the fallback leg, the cleanup tick
 *  expires them, and the two test hooks reset and seed under test control. */
const MEMSTORE_TOUCH_RE = /\bmemStore\b/;
const MEMSTORE_DEFINITION_RE = /^const memStore = new Map/;
const ALLOWED_MEMSTORE_TOUCH_SITES = [
  'lib/fresh-auth.ts#_resetFreshAuthMemStoreForTests',
  'lib/fresh-auth.ts#_setMemStoreEntryForTests',
  'lib/fresh-auth.ts#burnConsentOpEntry',
  'lib/fresh-auth.ts#dropSessionWindow',
  'lib/fresh-auth.ts#invalidateSessionFreshAuthTokens',
  'lib/fresh-auth.ts#issueFreshAuthToken',
  'lib/fresh-auth.ts#issueSessionFreshAuthToken',
  'lib/fresh-auth.ts#persistSessionSlide',
  'lib/fresh-auth.ts#readFreshAuthEntry',
  'lib/fresh-auth.ts#startCleanup',
];

/** Every toucher of the canonical Redis entry keyspace, via the module-private
 *  key-prefix constant. Pinned as an identifier for the same
 *  cannot-be-stepped-around reason: the Redis writes are multi-line calls, so a
 *  write-shaped line pattern misses them by construction. Same membership
 *  story: mints and the slide write, the burn and sweeps and drop delete, the
 *  read reads, the ledger drain retries compensating deletes. */
const ENTRY_KEY_PREFIX_RE = /\bKEY_PREFIX\b/;
const ENTRY_KEY_PREFIX_DEFINITION_RE = /^const KEY_PREFIX = /;
const ALLOWED_ENTRY_KEY_PREFIX_SITES = [
  'lib/fresh-auth.ts#burnConsentOpEntry',
  'lib/fresh-auth.ts#drainSpentConsentOps',
  'lib/fresh-auth.ts#dropSessionWindow',
  'lib/fresh-auth.ts#invalidateSessionFreshAuthTokens',
  'lib/fresh-auth.ts#issueFreshAuthToken',
  'lib/fresh-auth.ts#issueSessionFreshAuthToken',
  'lib/fresh-auth.ts#persistSessionSlide',
  'lib/fresh-auth.ts#readFreshAuthEntry',
];

/** The entry keyspace's namespace literal. `KEY_PREFIX` is module-private, but
 *  the string it derives from is not — a helper anywhere in the tree can write
 *  `${config.appTag}:fresh_auth:token:${t}` and reach the same keyspace with no
 *  identifier this file pins. So the literal itself is pinned to its one
 *  definition, at module scope of the module that owns the store. */
const ENTRY_KEYSPACE_LITERAL_RE = /fresh_auth:token/;

/** The module that owns the entry store, and the only one whose key-prefix
 *  definition line may carry the keyspace literal. */
const ENTRY_STORE_MODULE = 'lib/fresh-auth.ts';

/** Every live occurrence of the entry keyspace literal except the key-prefix
 *  definition in the owning module. The definition line is skipped by shape,
 *  in that module only: a copy of the same constant line pasted into another
 *  module is the cheapest way to reach the store from outside it, so there it
 *  is an occurrence like any other.
 *
 *  The result is compared to the empty set rather than to a module-scope key
 *  standing for the definition. A key stands for every line that resolves to
 *  it, so licensing `lib/fresh-auth.ts#<module>` would let a second
 *  module-scope literal in the owning module ride on the definition's key,
 *  and a literal inside a function too wherever the resolver answers module
 *  scope for it, which it does below an inner block closing on a `*\/ }`
 *  line. With no key licensed, every such line is a member. */
function strayKeyspaceLiterals(files: ScannedSource[]): { keys: string[]; sites: string[] } {
  const owner = occurrencesOf(
    files.filter((s) => s.rel === ENTRY_STORE_MODULE),
    ENTRY_KEYSPACE_LITERAL_RE,
    skipCommentOr(ENTRY_KEY_PREFIX_DEFINITION_RE),
  );
  const elsewhere = occurrencesOf(
    files.filter((s) => s.rel !== ENTRY_STORE_MODULE),
    ENTRY_KEYSPACE_LITERAL_RE,
    skipCommentLine,
  );
  return { keys: [...owner.keys, ...elsewhere.keys].sort(), sites: [...owner.sites, ...elsewhere.sites] };
}

/** The test-only in-memory seeding hook. It writes the entry tier directly, so
 *  a production caller would be a mint with no licensed name, no discriminator
 *  literal, and no slide — invisible to every scan above. Its caller set is
 *  pinned to nothing: the hook exists for tests, tests live outside `src/`,
 *  and the definition line is skipped by shape. */
const SEEDING_HOOK_RE = /\b_setMemStoreEntryForTests\b/;
const SEEDING_HOOK_DEFINITION_RE = /function\s+_setMemStoreEntryForTests\s*\(/;

/** Every handler that mints or reissues a session JWT, plus every caller of a
 *  plain-function symbol that does (attribution is transitive — see
 *  {@link sessionIssuingSites}). Each minting handler is covered by a
 *  wire-level no-proof assertion against its real 200 response:
 *  `session-establishment-mints-no-window` (login, confirm, session),
 *  `session-proof-invalidation` (recover, recover/verify), `orcid` (login mode),
 *  `signup-verify` (link), `custody-upgrade` (upgrade). `POST /callback` is an
 *  indirect member: it dispatches to `handleLogin`, which mints, so it is an
 *  issuing surface whether or not the mint's line moves. */
const SESSION_ISSUING_SITES = [
  'routes/auth.ts#POST /login',
  'routes/auth.ts#POST /session',
  'routes/custody.ts#POST /upgrade',
  'routes/orcid.ts#POST /callback',
  'routes/orcid.ts#handleLogin',
  'routes/recover.ts#POST /recover',
  'routes/recover.ts#POST /recover/verify',
  'routes/signup-verify.ts#POST /confirm',
  'routes/signup-verify.ts#POST /link',
];

/** The registry's member-count floor. The exact-set assertion already goes red
 *  on any change, but a shrink has a sympathetic cover story ("the mints were
 *  consolidated, I updated the list") that a grow does not. Shrinking the
 *  registry therefore has to be done twice, in two spellings — remove the
 *  member AND lower this floor — so it cannot ride along inside a mechanical
 *  list sync. */
const SESSION_ISSUING_SITES_FLOOR = 9;

/** Session-establishment and account-recovery surfaces, named explicitly so a
 *  mint landing in one produces a message that says what rule it broke. */
const FORBIDDEN_MINT_FILES = [
  'routes/auth.ts',
  'routes/signup-verify.ts',
  'routes/recover.ts',
  'middleware/verifyHiveSignature.ts',
];

/** Every `file#symbol` that issues a session JWT, directly or through a
 *  helper, computed to a fixpoint: the enclosing symbols of `jwt.sign` calls
 *  seed the set, and for every member whose symbol is a plain function name
 *  (a route-registration label cannot be called), the callers of that name
 *  join the set too, then THEIR callers if they are plain functions, until
 *  nothing new appears.
 *
 *  The transitivity is the point. Keyed on the literal call shape alone,
 *  extracting the mint into `mintSessionJwt()` collapses the registry to one
 *  member — an edit that reads as ordinary maintenance — after which every
 *  new route calling the helper issues sessions with no registry entry and no
 *  wire-level no-proof assertion demanded of it. Under transitive attribution
 *  the extraction keeps every caller in the set, and a new caller is a new
 *  member.
 *
 *  A helper name is matched as `name(`, skipping its own definition line and
 *  comments. A helper whose name collides with an unrelated identifier
 *  elsewhere would over-match — a red bar naming the site, the loud
 *  direction; rename the helper or account for the site. */
function sessionIssuingSites(files: ScannedSource[]): { keys: string[]; sites: string[] } {
  const direct = occurrencesOf(files, JWT_MINT_RE, skipCommentLine);
  const keys = new Set(direct.keys);
  const sites = [...direct.sites];
  const isPlainFunctionName = (sym: string): boolean => /^[A-Za-z_$][\w$]*$/.test(sym);
  const seenNames = new Set<string>();
  const pending = direct.keys.map((k) => k.split('#')[1]).filter(isPlainFunctionName);
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    const callRe = new RegExp(`\\b${name}\\s*\\(`);
    const definitionRe = new RegExp(`\\bfunction\\s+${name}\\s*\\(`);
    const calls = occurrencesOf(files, callRe, skipCommentOr(definitionRe));
    for (const key of calls.keys) {
      keys.add(key);
      const sym = key.split('#')[1];
      if (isPlainFunctionName(sym)) pending.push(sym);
    }
    sites.push(...calls.sites);
  }
  return { keys: [...keys].sort(), sites };
}

const sources = sourcesUnder(path.resolve(__dirname, '..', '..', 'src'));

describe('invariant #9 — no session-proof mint outside the two re-auth routes', () => {
  it('walks a plausible number of source files (guards against a broken walker)', () => {
    // Without this, a walker that returned nothing would make every assertion
    // below vacuously true and the canary would enforce nothing.
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.map((s) => s.rel)).toContain('lib/fresh-auth.ts');
  });

  it('only the password and ORCID re-auth handlers hold a callable reference to the session-proof mint', () => {
    const { keys, sites } = occurrencesOf(sources, SESSION_MINT_IDENT_RE, skipMintLine);
    expect(keys, `session-proof mint occurrence sites:\n${sites.join('\n')}`).toEqual(
      [...ALLOWED_MINT_SITES].sort(),
    );
  });

  it('only the two re-auth route modules import the session-proof mint', () => {
    const importers = sources
      .filter((s) => SESSION_MINT_IMPORT_RE.test(s.lines.join('\n')))
      .map((s) => s.rel)
      .sort();
    expect(
      importers,
      'a module that imports the mint can call it under any local name, so the ' +
        'import is a second boundary this invariant is defended at, not only the ' +
        'call site',
    ).toEqual([...ALLOWED_MINT_IMPORTERS].sort());
  });

  it('only the mint, the slide, and stored-entry validation touch the session discriminator', () => {
    // Name-independent backstop. A helper added inside lib/fresh-auth.ts that
    // opens a window under some other name calls nothing this canary greps for,
    // but it cannot avoid writing the discriminator — as a visible literal, a
    // wrapped literal, or a shorthand forwarding, all of which the composed
    // predicate fires on.
    const { keys, sites } = occurrencesOf(sources, /\bkind\b/, skipNonSessionEntryLine);
    expect(keys, `session-kind entry construction sites:\n${sites.join('\n')}`).toEqual(
      [...ALLOWED_SESSION_ENTRY_SITES].sort(),
    );
  });

  it('only the windowed consume persists a slid window', () => {
    const { keys, sites } = occurrencesOf(
      sources,
      SESSION_SLIDE_CALL_RE,
      skipCommentOr(SESSION_SLIDE_DEFINITION_RE),
    );
    expect(
      keys,
      'a second caller of the slide persister can push a window past its idle ' +
        'deadline without writing the kind discriminator and without naming the ' +
        `mint, so neither scan above would see it:\n${sites.join('\n')}`,
    ).toEqual([...ALLOWED_SESSION_SLIDE_SITES].sort());
  });

  it('no session-establishment or recovery route opens a window as a side effect', () => {
    const scanned = sources.filter((s) => FORBIDDEN_MINT_FILES.includes(s.rel));
    expect(scanned.length, 'a forbidden file was renamed or removed').toBe(
      FORBIDDEN_MINT_FILES.length,
    );
    // On a session-establishment or recovery module even HOLDING a reference is
    // the violation, so the unaliased-specifier skip is deliberately not applied
    // here; only prose is spared.
    const { sites } = occurrencesOf(scanned, SESSION_MINT_IDENT_RE, skipCommentLine);
    expect(
      sites,
      'a session-proof window must be opened only by an explicit re-auth act, ' +
        'never as a side effect of logging in, refreshing a token, finalizing a ' +
        `signup, or recovering an account:\n${sites.join('\n')}`,
    ).toEqual([]);
  });

  it('every session-issuing handler has a wire-level no-proof assertion', () => {
    // The scans above stop a mint that still looks like one. This stops the
    // other half: a brand-new route that issues a session and that nobody
    // remembered to assert against. A new entry here is a red bar that says "add
    // the response assertion, then pin the site" — the set IS the registry, and
    // it is deliberately unpleasant to extend without doing both. Attribution
    // is transitive so the registry survives the mint being extracted into a
    // helper; see sessionIssuingSites.
    const { keys, sites } = sessionIssuingSites(sources);
    expect(keys, `session JWT issuing sites:\n${sites.join('\n')}`).toEqual(
      [...SESSION_ISSUING_SITES].sort(),
    );
    expect(SESSION_ISSUING_SITES.length).toBeGreaterThanOrEqual(SESSION_ISSUING_SITES_FLOOR);
  });

  it('extracting the JWT mint into a helper keeps every caller in the registry', () => {
    // Planted probe for the transitive attribution. Under the literal
    // call-shape scan this synthetic module contributed exactly one member
    // (the helper), and the two routes calling it were invisible — the
    // collapse that read as ordinary maintenance. The fixpoint walk must name
    // all three, and the second-level wrapper's caller proves the walk does
    // not stop at depth one.
    const synthetic: ScannedSource = {
      rel: 'routes/synthetic.ts',
      lines: [
        'function mintSessionJwt(username) {',
        '  return jwt.sign({ sub: username }, secret);',
        '}',
        '',
        'function reissueSession(username) {',
        '  return mintSessionJwt(username);',
        '}',
        '',
        "router.post('/first', async (req, res) => {",
        '  const token = mintSessionJwt(req.hiveUsername);',
        '});',
        '',
        "router.post('/second', async (req, res) => {",
        '  const token = reissueSession(req.hiveUsername);',
        '});',
      ],
    };
    expect(sessionIssuingSites([synthetic]).keys).toEqual([
      'routes/synthetic.ts#POST /first',
      'routes/synthetic.ts#POST /second',
      'routes/synthetic.ts#mintSessionJwt',
      'routes/synthetic.ts#reissueSession',
    ]);
  });

  it('only the pinned functions touch the in-memory entry tier', () => {
    const module = sources.filter((s) => s.rel === 'lib/fresh-auth.ts');
    expect(module.length, 'the guarded module was renamed or removed').toBe(1);
    const { keys, sites } = occurrencesOf(
      module,
      MEMSTORE_TOUCH_RE,
      skipCommentOr(MEMSTORE_DEFINITION_RE),
    );
    expect(
      keys,
      'a new toucher of the in-memory entry store can plant or extend a ' +
        'session window without calling the mint, writing the discriminator, ' +
        `or reaching the slide persister:\n${sites.join('\n')}`,
    ).toEqual([...ALLOWED_MEMSTORE_TOUCH_SITES].sort());
  });

  it('only the pinned functions touch the Redis entry keyspace', () => {
    const module = sources.filter((s) => s.rel === 'lib/fresh-auth.ts');
    expect(module.length, 'the guarded module was renamed or removed').toBe(1);
    const { keys, sites } = occurrencesOf(
      module,
      ENTRY_KEY_PREFIX_RE,
      skipCommentOr(ENTRY_KEY_PREFIX_DEFINITION_RE),
    );
    expect(
      keys,
      'a new toucher of the canonical entry keyspace can write a window ' +
        `directly to Redis past every caller pin above:\n${sites.join('\n')}`,
    ).toEqual([...ALLOWED_ENTRY_KEY_PREFIX_SITES].sort());
  });

  it('the entry keyspace literal exists once, at the key-prefix definition', () => {
    // KEY_PREFIX is module-private, but the namespace string is not: a helper
    // anywhere under src/ can rebuild the key from the literal and reach the
    // store with no identifier the scans above pin. Comments are spared (prose
    // cannot address Redis); everything else is one definition line in the
    // owning module.
    const owner = sources.filter((s) => s.rel === ENTRY_STORE_MODULE);
    expect(owner.length, 'the guarded module was renamed or removed').toBe(1);
    // The literal still lives on the definition line, once. Without this,
    // `strayKeyspaceLiterals` passes vacuously when the namespace or the
    // constant is renamed.
    expect(
      owner[0].lines.filter(
        (line) => ENTRY_KEY_PREFIX_DEFINITION_RE.test(line) && ENTRY_KEYSPACE_LITERAL_RE.test(line),
      ),
      'the key-prefix definition no longer carries the entry keyspace literal',
    ).toHaveLength(1);
    const { keys, sites } = strayKeyspaceLiterals(sources);
    expect(
      keys,
      `the fresh-auth entry keyspace is addressed outside its defining constant:\n${sites.join('\n')}`,
    ).toEqual([]);
  });

  it('a keyspace literal outside the definition is reported wherever it resolves', () => {
    // Planted probes for the stray scan. Each plant sits beside the real
    // definition line, which must stay unreported.
    const definition = 'const KEY_PREFIX = `${config.appTag}:fresh_auth:token:`;';
    const owner = (...body: string[]): ScannedSource => ({
      rel: ENTRY_STORE_MODULE,
      lines: ['/**', ' * Entries live under `${appTag}:fresh_auth:token:${token}`.', ' */', definition, '', ...body],
    });
    expect(strayKeyspaceLiterals([owner()]).keys).toEqual([]);

    // A literal inside a function, below an inner block that closes on an
    // indented `*\/ }` line. The walk reads that brace as the function's end
    // and answers module scope, the key a licensed definition would share.
    const belowInnerClose = owner(
      'export function rebuildKey(token: string) {',
      '  if (token) {',
      '    /*',
      '    the inner block ends here',
      '    */ }',
      '  return `${config.appTag}:fresh_auth:token:${token}`;',
      '}',
    );
    expect(enclosingSymbol(belowInnerClose.lines, 10)).toBe(MODULE_SCOPE);
    expect(strayKeyspaceLiterals([belowInnerClose]).keys).toEqual([`${ENTRY_STORE_MODULE}#${MODULE_SCOPE}`]);

    // A second literal at module scope of the owning module.
    const secondAtModuleScope = owner('const LEGACY_PREFIX = `${config.appTag}:fresh_auth:token:`;');
    expect(strayKeyspaceLiterals([secondAtModuleScope]).keys).toEqual([
      `${ENTRY_STORE_MODULE}#${MODULE_SCOPE}`,
    ]);

    // The definition line itself, copied into another module.
    const copiedDefinition: ScannedSource = { rel: 'routes/synthetic.ts', lines: [definition] };
    expect(strayKeyspaceLiterals([copiedDefinition]).keys).toEqual([`routes/synthetic.ts#${MODULE_SCOPE}`]);
  });

  it('the test-only seeding hook has no production caller', () => {
    const { keys, sites } = occurrencesOf(
      sources,
      SEEDING_HOOK_RE,
      skipCommentOr(SEEDING_HOOK_DEFINITION_RE),
    );
    expect(
      keys,
      'the in-memory seeding hook writes the entry tier directly, so a ' +
        'production caller is an unlicensed mint invisible to every other ' +
        `scan in this file:\n${sites.join('\n')}`,
    ).toEqual([]);
  });

  it('the occurrence scan fires on aliases and indirection and spares imports, prose, and the definition', () => {
    // Planted positives and negatives. Without them the scans above can silently
    // no-op: an edit that mangles the pattern leaves every result empty and the
    // suite stays green while the canary enforces nothing. They exercise the
    // COMPOSED predicate, because under a name match the regex alone no longer
    // encodes the semantics.
    const counts = (line: string): boolean =>
      SESSION_MINT_IDENT_RE.test(line) && !skipMintLine(line, 0, [line]);
    const countsAt = (lines: string[], i: number): boolean =>
      SESSION_MINT_IDENT_RE.test(lines[i]) && !skipMintLine(lines[i], i, lines);

    expect(counts("const issued = await issueSessionFreshAuthToken(username, 'password');")).toBe(true);
    expect(counts('  issueSessionFreshAuthToken (username, mechanism)')).toBe(true);
    // The alias, in every shape it can take. This is the case a call-shaped
    // pattern was blind to, and the reason the scan matches the name.
    expect(counts('  issueSessionFreshAuthToken as mint,')).toBe(true);
    expect(counts('  issueSessionFreshAuthToken as mint')).toBe(true);
    expect(counts("import { issueSessionFreshAuthToken as mint } from '../lib/fresh-auth.js';")).toBe(true);
    expect(counts("import {issueSessionFreshAuthToken as mint} from '../lib/fresh-auth.js';")).toBe(true);
    expect(counts("  issueSessionFreshAuthToken as mint } from '../lib/fresh-auth.js';")).toBe(true);
    // Duplicate specifiers for one exported name are legal; the unaliased half
    // must not buy the aliased half a skip.
    expect(
      counts(
        "import { issueSessionFreshAuthToken, issueSessionFreshAuthToken as mint } from '../lib/fresh-auth.js';",
      ),
    ).toBe(true);
    // Indirection without an `as`, an object literal rather than an import, and
    // a namespace-qualified call. All three hold a callable reference.
    expect(counts('const mint = issueSessionFreshAuthToken;')).toBe(true);
    expect(counts('  issueSessionFreshAuthToken };')).toBe(true);
    expect(counts("  const issued = await freshAuth.issueSessionFreshAuthToken(username, 'password');")).toBe(true);

    expect(counts('  issueSessionFreshAuthToken,')).toBe(false);
    expect(counts('  issueSessionFreshAuthToken')).toBe(false);
    expect(counts("import { issueSessionFreshAuthToken } from '../lib/fresh-auth.js';")).toBe(false);
    expect(counts("import {issueSessionFreshAuthToken} from '../lib/fresh-auth.js';")).toBe(false);
    expect(counts("import { issueFreshAuthToken, issueSessionFreshAuthToken } from '../lib/fresh-auth.js';")).toBe(false);
    expect(counts("  issueSessionFreshAuthToken } from '../lib/fresh-auth.js';")).toBe(false);
    expect(counts(' * consumed by `issueSessionFreshAuthToken` on the session surface')).toBe(false);
    expect(counts('// session-kind (issueSessionFreshAuthToken) entries share this single')).toBe(false);
    expect(counts('export async function issueSessionFreshAuthToken(')).toBe(false);
    // The consent-op mint is a different function with a different contract and
    // is licensed on more routes; it must not be swept up by this canary.
    expect(counts("await issueFreshAuthToken(username, 'password', target);")).toBe(false);
    // The documented edge of a name-based scan: a mint under a NEW name is out
    // of reach here by construction, which is what the discriminator and slide
    // scans exist to cover.
    expect(counts("await issueSessionFreshAuthTokenV2(username, 'password');")).toBe(false);

    // The alias split across a line break. The specifier line alone satisfies
    // the bare-name skip and the per-line veto never saw the `as`, so the file
    // held a working alias while the scan stayed green. The veto now runs
    // against the joined statement.
    const wrappedAlias = [
      'import {',
      '  issueSessionFreshAuthToken',
      '    as mint,',
      "} from '../lib/fresh-auth.js';",
    ];
    expect(countsAt(wrappedAlias, 1)).toBe(true);
    // The same wrap without an alias stays a plain import and stays spared.
    const wrappedPlain = [
      'import {',
      '  issueSessionFreshAuthToken,',
      "} from '../lib/fresh-auth.js';",
    ];
    expect(countsAt(wrappedPlain, 1)).toBe(false);
    // A complete single-line import is never joined with its neighbours, so an
    // adjacent line cannot veto it into a false positive.
    const completeThenNoise = [
      "import { issueSessionFreshAuthToken } from '../lib/fresh-auth.js';",
      "// prose: issueSessionFreshAuthToken as documented above",
    ];
    expect(countsAt(completeThenNoise, 0)).toBe(false);

    // The definition line matches the name and is skipped by shape, so the
    // module that defines the mint stays scanned for references to it.
    expect(SESSION_MINT_DEFINITION_RE.test('export async function issueSessionFreshAuthToken(')).toBe(true);
    expect(SESSION_MINT_DEFINITION_RE.test("  const issued = await issueSessionFreshAuthToken(username, 'password');")).toBe(false);

    // A star-leading live line: a wrapped operand naming the mint. The
    // shape-only reading dropped it as a docblock continuation before it was
    // counted, which was a silent pass for exactly the reference this canary
    // scans for; the block-comment region `occurrencesOf` computes per file
    // is what keeps it counted. The same text inside a docblock stays prose.
    const starLeadingLive: ScannedSource = {
      rel: 'lib/synthetic.ts',
      lines: [
        'function weightedMint(username: string) {',
        '  return Number(flag)',
        '    * issueSessionFreshAuthToken(username, mechanism).length;',
        '}',
      ],
    };
    expect(occurrencesOf([starLeadingLive], SESSION_MINT_IDENT_RE, skipMintLine).keys).toEqual([
      'lib/synthetic.ts#weightedMint',
    ]);
    const proseContinuation: ScannedSource = {
      rel: 'lib/synthetic.ts',
      lines: [
        '/**',
        ' * issueSessionFreshAuthToken(username, mechanism) is licensed twice.',
        ' */',
        'function weightedMint(username: string) {',
        '  return null;',
        '}',
      ],
    };
    expect(occurrencesOf([proseContinuation], SESSION_MINT_IDENT_RE, skipMintLine).keys).toEqual([]);
  });

  it('the import matcher fires on every import of the mint and on nothing else', () => {
    expect(
      SESSION_MINT_IMPORT_RE.test(
        "import {\n  issueFreshAuthToken,\n  issueSessionFreshAuthToken,\n  type FreshAuthTarget,\n} from '../lib/fresh-auth.js';",
      ),
    ).toBe(true);
    // An alias is still an import.
    expect(
      SESSION_MINT_IMPORT_RE.test(
        "import {\n  issueSessionFreshAuthToken as mint,\n} from '../lib/fresh-auth.js';",
      ),
    ).toBe(true);
    expect(SESSION_MINT_IMPORT_RE.test("import { issueSessionFreshAuthToken } from '../lib/fresh-auth.js';")).toBe(true);
    expect(SESSION_MINT_IMPORT_RE.test("import { invalidateSessionFreshAuthTokens } from '../lib/fresh-auth.js';")).toBe(false);
    expect(SESSION_MINT_IMPORT_RE.test("import { issueFreshAuthToken } from '../lib/fresh-auth.js';")).toBe(false);
    // No specifier to match; the occurrence scan catches its call site instead.
    expect(SESSION_MINT_IMPORT_RE.test("import * as freshAuth from '../lib/fresh-auth.js';")).toBe(false);
  });

  it('the construction matcher is not defeated by quote style or a trailing comma', () => {
    expect(constructsSessionEntry("    kind: 'session',")).toBe(true);
    // Quote style, the trailing comma, and whether the key itself is quoted are
    // enforced by nothing in this package. A construction written in any of
    // these styles must still be caught; every one was a silent pass before.
    expect(constructsSessionEntry('    kind: "session",')).toBe(true);
    expect(constructsSessionEntry('    kind: `session`,')).toBe(true);
    expect(constructsSessionEntry("    kind:'session'")).toBe(true);
    expect(constructsSessionEntry("    kind: 'session'")).toBe(true);
    expect(constructsSessionEntry("  const entry = { kind: 'session' };")).toBe(true);
    expect(constructsSessionEntry("  'kind': 'session',")).toBe(true);
    expect(constructsSessionEntry('  "kind": "session",')).toBe(true);
    expect(constructsSessionEntry("    kind: 'session' as const,")).toBe(true);
    // A construction sharing its line with a utility type. The type occurrence
    // is stripped, the construction survives the strip and is caught. A skip
    // keyed on the utility NAME hid all three of these.
    expect(
      constructsSessionEntry(
        "  const next: Extract<ValidatedEntry, { kind: 'session' }> = { kind: 'session', username };",
      ),
    ).toBe(true);
    expect(
      constructsSessionEntry("  const stored: Omit<StoredEntry, 'nonce'> = { kind: 'session', username };"),
    ).toBe(true);
    expect(constructsSessionEntry("  return { kind: 'session', username } as Pick<Entry, 'kind'>;")).toBe(true);

    expect(constructsSessionEntry("  if (entry.kind === 'session') {")).toBe(false);
    // Type positions, not construction. Both name the kind without building an
    // entry, and both live in lib/fresh-auth.ts today.
    expect(constructsSessionEntry("      kind: 'session';")).toBe(false);
    expect(constructsSessionEntry("  entry: Extract<ValidatedEntry, { kind: 'session' }>,")).toBe(false);
    expect(
      constructsSessionEntry("  entry: Extract<ValidatedEntry, { kind: 'session'; username: string }>,"),
    ).toBe(false);
    expect(constructsSessionEntry(" *   - a `kind: 'session'` entry (target-less, minted by")).toBe(false);
    // A different discriminator value, and a different identifier that merely
    // ends in the word. Neither may be swept into this scan.
    expect(constructsSessionEntry("    kind: 'consent_op',")).toBe(false);
    expect(constructsSessionEntry("  const operation_kind: 'session' = x;")).toBe(false);

    // The key-anchored signal: shapes that construct while showing no value on
    // the matched line. Both were full evasions of the value-anchored form.
    expect(signalsSessionEntry('    kind:')).toBe(true);
    expect(signalsSessionEntry('    kind,')).toBe(true);
    expect(signalsSessionEntry('  return { kind, username, mechanism };')).toBe(true);
    expect(signalsSessionEntry('  return { username, kind };')).toBe(true);
    expect(signalsSessionEntry("    'kind':")).toBe(true);
    // Accepted false positive, loud: a bare destructure of the key. None exist
    // under src/ today; one added later is a red bar naming its symbol.
    expect(signalsSessionEntry('  const { kind } = entry;')).toBe(true);
    // Shapes the key-anchored signal must NOT fire on: property reads, type
    // annotations with their type on the line, comparisons, assignments,
    // other identifiers, prose.
    expect(signalsSessionEntry("  if (entry.kind === 'session') {")).toBe(false);
    expect(signalsSessionEntry('  kind: FreshAuthKind;')).toBe(false);
    expect(signalsSessionEntry('  let kind: FreshAuthKind;')).toBe(false);
    expect(signalsSessionEntry('  kind = rawKind;')).toBe(false);
    expect(signalsSessionEntry("  if (kind === 'session') {")).toBe(false);
    expect(signalsSessionEntry('    operation_kind,')).toBe(false);
    expect(signalsSessionEntry(' * Stored value: `{ username, mechanism, issued_at, kind }` JSON, plus')).toBe(false);

    expect(isCommentLine(" *   - a `kind: 'session'` entry (target-less, minted by")).toBe(true);
    expect(isCommentLine("    kind: 'session',")).toBe(false);
  });

  it('a wrapped literal and a shorthand construction are occurrences of the discriminator scan', () => {
    // End-to-end planted probes through the same occurrence walk the
    // whole-tree assertion runs, not just the line predicate. Before the
    // key-anchored signal, both of these produced an EMPTY occurrence set and
    // the exact-set assertion had nothing to go red on.
    const wrapped: ScannedSource = {
      rel: 'lib/synthetic.ts',
      lines: [
        'async function mintWindowUnderAnotherName(username) {',
        '  const entry = {',
        '    username,',
        '    kind:',
        "      'session',",
        '  };',
        '}',
      ],
    };
    expect(
      occurrencesOf([wrapped], /\bkind\b/, skipNonSessionEntryLine).keys,
    ).toEqual(['lib/synthetic.ts#mintWindowUnderAnotherName']);

    const shorthand: ScannedSource = {
      rel: 'lib/synthetic.ts',
      lines: [
        'async function forwardKindShorthand(username) {',
        "  const kind = 'session';",
        '  return { username, kind };',
        '}',
      ],
    };
    expect(
      occurrencesOf([shorthand], /\bkind\b/, skipNonSessionEntryLine).keys,
    ).toEqual(['lib/synthetic.ts#forwardKindShorthand']);
  });

  it('the slide and session-JWT matchers fire on a call and spare the definition and prose', () => {
    expect(SESSION_SLIDE_CALL_RE.test('  void persistSessionSlide(token, slid, now, fromMemStore);')).toBe(true);
    expect(SESSION_SLIDE_DEFINITION_RE.test('async function persistSessionSlide(')).toBe(true);
    expect(SESSION_SLIDE_DEFINITION_RE.test('  void persistSessionSlide(token, slid, now, fromMemStore);')).toBe(false);
    expect(JWT_MINT_RE.test('    const token = jwt.sign(')).toBe(true);
    // Prose that merely names the mint has no open paren and does not match;
    // prose that quotes the call shape does, and is spared by the skip instead.
    expect(JWT_MINT_RE.test('  // invariant: no jwt.sign call mints before the INSERT')).toBe(false);
    expect(JWT_MINT_RE.test('  // a second jwt.sign(...) here needs its own response assertion')).toBe(true);
    expect(isCommentLine('  // a second jwt.sign(...) here needs its own response assertion')).toBe(true);
  });

  it('the enclosing-symbol resolver names handlers, not files', () => {
    // The granularity this canary rests on. A resolver that returned the same
    // label for every line would collapse the assertion back to file
    // granularity while every test above stayed green.
    const lines = [
      "router.post('/session-auth', verifyHiveSignature, async (req, res) => {",
      '  const issued = await issueSessionFreshAuthToken(username, "password");',
      '});',
      '',
      'async function handleLogin(',
      '  req: Request,',
      '): Promise<void> {',
      '  const issued = await issueSessionFreshAuthToken(username, "password");',
      '}',
    ];
    expect(enclosingSymbol(lines, 1)).toBe('POST /session-auth');
    // The wrapped parameter list must not read as the end of the block, and the
    // route handler above must not leak downward into the sibling function.
    expect(enclosingSymbol(lines, 7)).toBe('handleLogin');
    // A parenthesized EXPRESSION is not a function declaration. Without the
    // paren-arm guard, `const raw = (parsed as X).field;` swallowed every
    // following occurrence in its real enclosing function under the local's
    // name — which is how the discriminator scan once reported the shorthand
    // returns inside stored-entry validation as sites named for two locals.
    const expressionLocals = [
      'function validateSomething(raw) {',
      '  const rawAbsolute = (parsed as { absolute_expires_at?: unknown }).absolute_expires_at;',
      '  return { kind, username };',
      '}',
    ];
    expect(enclosingSymbol(expressionLocals, 2)).toBe('validateSomething');
    // The guard keeps the true positives: an arrow with its `=>` visible, and
    // a parameter list left open for the next line.
    expect(enclosingSymbol(['const handler = async (req, res) => {', '  mint();'], 1)).toBe('handler');
    expect(enclosingSymbol(['const handler = (', '  req: Request,', ') => {', '  mint();'], 3)).toBe('handler');
    // An aliased specifier is caught because it resolves to module scope, which
    // is never an allowed key. If the resolver ever labelled import lines with
    // the nearest declaration instead, that alias would acquire a symbol name
    // and the catch would go quiet, so the property is pinned here rather than
    // assumed.
    expect(
      enclosingSymbol(
        ['import {', '  issueSessionFreshAuthToken as mint,', "} from '../lib/fresh-auth.js';"],
        1,
      ),
    ).toBe(MODULE_SCOPE);
  });
});
