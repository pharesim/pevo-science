import Alpine from 'alpinejs';
import {
  startOrcid,
  consentOpRequestFields,
  fetchEmailStatus,
  mintSessionAuthProof,
} from '../api.js';
import { broadcastOps } from '../signer.js';
import { REAUTH_PROMPT_BUSY } from '../components/reauth-modal.js';
// The storage keys for the subject-bound caches below. Defined in
// subject-bound-keys.js — the single source of truth the auth store's subject
// scrub and its test-fixture mirror loop over — never as private literals
// here, so the scrub and the fixture cannot drift from the keys this module
// actually writes. The semantics of each cache stay documented below, next to
// the code that implements it.
import {
  SESSION_PROOF_KEY,
  CONSENT_OP_PROOF_KEY,
  RETURN_PATH_KEY,
  ORCID_MODE_KEY,
} from './subject-bound-keys.js';

// In-tab cache of the session-kind fresh_auth_proof WINDOW, stored under
// `SESSION_PROOF_KEY`. The proof is
// target-less, bound to the JWT subject, and multi-use: it authorizes the
// non-consent broadcast surface and the IPFS upload-token pre-flight
// repeatedly until the window closes. Two deadlines bound it and the window
// ends at whichever arrives first — a sliding idle deadline that every
// successful use pushes forward, and an absolute cap no activity extends. The
// slide is not observable on the wire (neither the broadcast nor the
// upload-token response echoes a refreshed deadline), so the idle period is
// learned from the issuance response and the slide is modelled client-side.
// Held in sessionStorage so the window survives the ORCID OAuth round-trip
// (publish page → orcid.org → /orcid/callback → return path) without
// leaking across tabs or persisting past tab close.

// A window closing sooner than this reads as already spent to the
// acquire-before-commit gate. Re-authing deliberately ahead of a submit beats
// discovering the window closed after the user has attached a file and paid
// for an upload. The broadcast path itself demands no margin — any live
// window is worth attempting.
const WINDOW_PREFLIGHT_MARGIN_MS = 120_000;

// In-tab cache of a consent_op-kind fresh_auth_proof, stored under
// `CONSENT_OP_PROOF_KEY`. Target-bound to the
// triple `(action, root_author, root_permlink)` and, for name-only-route
// credit ops, the additional per-op fields the backend binds: `author_index`
// (claim/approve) and `claimer` (approve/revoke). The broadcast consumer MUST
// match every bound field to consume; a proof minted for slot 2 cannot be
// reused for slot 3, nor an approve proof for co-author A reused against
// co-author B (the substitution `target_mismatch` the binding defends).
// Settings critical actions and anchored-route consent ops (author_accept /
// author_resign) leave `author_index` / `claimer` null, so they match on the
// triple alone. Single-slot by design: each ORCID fresh_auth round-trip mints
// state for one target, so a second flow overwrites the cached entry (matches
// the existing pevo_orcid_mode overwrite pattern). The token itself is a
// single-use bearer bound to the JWT subject with the same 5-minute TTL as
// session-kind proofs; backend invariant is identical (consumed atomically on
// broadcast attempt, gone post-attempt whether success or failure).

// `RETURN_PATH_KEY` stashes pre-redirect context so the callback handler can
// navigate the user back to the page they initiated the action on. Cleared by
// the callback handler after the proof lands.

// Sentinel for `broadcastWithFreshAuth` callers: when minting required a
// full-page redirect to ORCID, broadcast cannot complete in this tick.
// Returning null (rather than throwing) lets callers `if (res === null) return`
// and unwinds cleanly without a generic error toast firing during navigation.
export const FRESH_AUTH_REDIRECT_PENDING = null;

// Allowed ORCID OAuth redirect hosts. Validated before every `window.location`
// assignment to a backend-supplied `redirect_url` (open-redirect defense).
// Shared by EVERY ORCID redirect flow: the session-auth and settings-action
// mint flows below, and the page-level start flows (login, signup, recover,
// settings ORCID-link, accreditation), so every redirect-host check uses this
// one allowlist. Frozen so a consumer cannot mutate the shared policy
// (`.includes()` is unaffected by the freeze).
export const ORCID_REDIRECT_HOSTS = Object.freeze(['orcid.org', 'sandbox.orcid.org']);

// 401 consume-failure reasons that mean "the proof was absent or no longer
// usable" — re-mint and retry once. `wrong_mechanism` is excluded (re-minting
// the same factor would not fix it). Single source of truth shared by both
// fresh-auth orchestrators (settings + authorship consent ops) and the
// session-kind retry gate in broadcastWithFreshAuth below, so the three retry
// gates cannot drift on which 401 reasons are recoverable.
export const REMINTABLE_REASONS = Object.freeze(['missing', 'expired', 'malformed']);

// Shared password-factor outcome sentinels for the consent-op / settings
// fresh-auth orchestrators. Exported (not per-orchestrator locals) so the
// orchestrators compare against the SAME symbol mintViaPasswordFactor returns —
// a per-file Symbol would never be `===` to the helper's return.
//   FRESH_AUTH_CANCELLED  the flow stopped without completing, from one of two
//                         causes the caller handles identically and the user
//                         does not: the user dismissed the re-auth modal (no
//                         message, stopping was their choice), or a subject
//                         teardown abandoned the flow (reported by
//                         `subjectTeardownGuard`'s cancel before the sentinel
//                         is returned, so the caller adds nothing).
//   FRESH_AUTH_MINT_FAILED  re-auth could not be completed (a second wrong
//                         password, or a transport error on the retry mint);
//                         the caller surfaces a generic re-auth failure rather
//                         than letting the mint failure escape as the op's own
//                         message.
//   FRESH_AUTH_PROMPT_BUSY  a re-auth prompt for a DIFFERENT action is already
//                         open, so this one was refused before the user ever
//                         saw it (distinct from CANCELLED, which is the user's
//                         own decision to stop).
//   FRESH_AUTH_REAUTH_REQUIRED  a window was needed and none was open, but the
//                         account's only factor is a full-page ORCID
//                         round-trip and the caller asked for acquisition
//                         without navigation (see `allowRedirect`).
//   FRESH_AUTH_ORCID_FALLBACK  the password factor was ASSUMED (the account
//                         status was unavailable) and the backend rejected the
//                         mint: the account most likely has no password, so
//                         the caller hands the action to its own ORCID factor
//                         instead of demanding a second password that may not
//                         exist.
export const FRESH_AUTH_CANCELLED = Symbol('fresh_auth_cancelled');
export const FRESH_AUTH_MINT_FAILED = Symbol('fresh_auth_mint_failed');
export const FRESH_AUTH_PROMPT_BUSY = Symbol('fresh_auth_prompt_busy');
export const FRESH_AUTH_REAUTH_REQUIRED = Symbol('fresh_auth_reauth_required');
export const FRESH_AUTH_ORCID_FALLBACK = Symbol('fresh_auth_orcid_fallback');

// Default re-auth modal prompt. Lib code cannot use the `$t` magic helper; read
// the i18n store directly with an English fallback. Called by every
// password-factor surface — the settings and authorship consent-op
// orchestrators and the session-window acquisition below — so the prompt copy
// cannot drift between them.
export function passwordPromptMessage() {
  return (
    Alpine.store('i18n')?.messages?.settings?.reauthPasswordPrompt ||
    'Enter your account password to confirm this action.'
  );
}

// Tear down a corrupted session on `username_mismatch`: the JWT subject and the
// proof subject diverge, which no re-auth can fix. Disconnect the session and
// surface the re-login toast. Shared by all three fresh-auth orchestrators
// (broadcastWithFreshAuth, withAuthorshipFreshAuth, withSettingsFreshAuth) so the
// teardown side-effects cannot drift between surfaces; each caller still returns
// its own surface-appropriate sentinel after calling this (the session-kind path
// returns FRESH_AUTH_REDIRECT_PENDING, the consent-op/settings paths return
// { sessionInconsistent: true }). `auth.disconnect()` is synchronous (auth.js —
// in-memory mutation + localStorage/sessionStorage removals, no awaited I/O), so
// teardown completes before the toast fires and there is no toast-vs-teardown
// race. Lib code cannot use `$t`; read the i18n store directly with an English
// fallback for the not-yet-loaded-bundle case.
export function handleSessionInconsistency() {
  const auth = Alpine.store('auth');
  if (auth) {
    auth.disconnect();
    // The disconnect runs the subject scrub, which abandons every in-flight
    // acquisition. Claim that teardown before speaking: the message below is
    // the one the user needs, and a flight parked at its own teardown boundary
    // would otherwise resume and stack a second, vaguer message on top of it.
    // The claim sits inside this branch because it marks the teardown THIS
    // disconnect caused as narrated; with no store to disconnect there is no
    // teardown here to claim, and stamping the live generation anyway would
    // credit whatever teardown is current to a message about something else.
    claimTeardownReport();
  }
  toastLocalized('auth', 'sessionInconsistency', 'Session inconsistency detected. Please sign in again.');
}

// Show one error toast, localized. Lib code cannot use the `$t` magic helper,
// so every message this module raises reads the i18n store directly and falls
// back to English for the not-yet-loaded-bundle case; this is that read plus
// the show, in one place, so the fallback policy and the severity cannot drift
// between the sites that raise messages (the session-inconsistency teardown
// above, the window-outcome dispatch below, and the teardown cancel in the
// password-factor mint).
function toastLocalized(section, name, fallback) {
  const msg = Alpine.store('i18n')?.messages?.[section]?.[name] || fallback;
  Alpine.store('toast')?.show(msg, 'error');
}

// Password-factor mint shared by the settings + authorship consent-op
// orchestrators. Prompt via the global reauth modal, then mint via the caller's
// `mintFn(password)` — the only part that differs between surfaces (the settings
// vs authorship target binding). A wrong password (401 UNAUTHORIZED at the mint
// route) re-prompts once. Returns:
//   - the proof string on success;
//   - FRESH_AUTH_CANCELLED if the modal was dismissed at either prompt;
//   - FRESH_AUTH_MINT_FAILED if re-auth is spent (a second wrong password, or any
//     transport error on the retry mint);
//   - FRESH_AUTH_PROMPT_BUSY if another action's prompt already owns the modal;
//   - FRESH_AUTH_ORCID_FALLBACK if the password factor was ASSUMED
//     (`opts.assumed`) and the mint 401'd — see below.
// A non-auth error on the FIRST attempt (transport, 503, VALIDATION_ERROR)
// propagates so the caller's op-level handler surfaces the real cause.
//
// A successful mint additionally reports into the password-factor memo (see
// `beginPasswordMintReport`): the mint route verifying the password is the
// strongest evidence the account has one, so an ASSUMED factor that just
// minted is not re-guessed on the next resolution while the status read
// stays unavailable. A second consecutive rejection does the opposite: it
// retires the memo (`clearPasswordFactorMemo`), so the next resolution
// re-reads the status rather than riding an answer the verifying route has
// just contradicted twice. Only a rejection of the password retires it; a
// transport failure on the retry mint leaves the memo standing.
//
// Every await below is also a teardown boundary. The prompt is a human-length
// pause and the mint is a round-trip, so the tab's subject can change under
// either one — and the mint reads the JWT at call time (api.js
// `authenticatedRequest`), so a mint issued past a subject change binds to
// whoever the tab now represents, not to whoever opened the prompt. `guard`
// turns every such resumption into a clean cancel.
//
// A guard opened here captures whatever the generation is by the time this
// function is entered, so relying on the default is correct ONLY for a caller
// that either has no await ahead of this call, or re-checks its own captured
// generation immediately before it, with nothing awaited in between. The
// session acquisition is the second kind: its factor read awaits first, and
// only its pre-call generation check keeps the default sound — remove that
// "redundant" check and a teardown landing in the factor read reopens the
// cross-subject mint there. Every other caller — both consent-op
// orchestrators read the account status first — must pass a guard opened
// before its first await, or a teardown landing in that earlier await has
// already moved the generation and the default compares the post-teardown
// value against itself, never firing.
export async function mintViaPasswordFactor(
  mintFn,
  { message, assumed = false, guard = subjectTeardownGuard() },
) {
  const modal = Alpine.store('reauthModal');
  // Captured BEFORE the prompt opens: a subject scrub landing while the
  // modal sits open must veto the memo write (see beginPasswordMintReport).
  const reportMintSuccess = beginPasswordMintReport();
  const attemptMint = async (password) => {
    const minted = await mintFn(password);
    // A teardown while the round-trip was pending leaves a proof this tab must
    // not deliver to the caller's `run`.
    if (guard.tornDown()) return guard.cancel();
    reportMintSuccess(minted);
    return minted;
  };

  let password = await modal.request({ message });
  // No mint may leave the tab after a teardown, and this check is what
  // guarantees it: nothing awaits between here and the request `attemptMint`
  // issues, so "checked here" and "checked at the request" are the same
  // instant. Anything inserted in between would need its own check.
  if (guard.tornDown()) return guard.cancel();
  if (password === REAUTH_PROMPT_BUSY) return FRESH_AUTH_PROMPT_BUSY;
  if (password === null || password === undefined) return FRESH_AUTH_CANCELLED;

  try {
    return await attemptMint(password);
  } catch (err) {
    // A teardown that landed while the mint was in flight outranks whatever
    // the mint reported. Checked before the branches below so a rejection
    // cannot re-prompt the new subject with the old action's prompt, and so
    // the ASSUMED-password branch cannot fire a full-page ORCID round-trip on
    // behalf of the subject that left.
    if (guard.tornDown()) return guard.cancel();

    // A non-auth error on the first attempt (transport, 503) propagates as an
    // unexpected failure; only a wrong password (UNAUTHORIZED) re-prompts.
    if (err?.code !== 'UNAUTHORIZED') throw err;

    // When the password factor was ASSUMED rather than observed — the account
    // status was unavailable and the unknown fell through to the prompt — a
    // 401 here is at least as likely "no password registered" as a typo. A
    // second prompt would dead-end a genuinely passwordless account (there is
    // no password to get right, and the mint route burns a sentinel hash to
    // keep the two cases indistinguishable), so hand the caller back to its
    // ORCID factor instead. An account that really has a password only lands
    // here by mistyping while the status read is down, and its ORCID factor
    // completes the action too.
    if (assumed) return FRESH_AUTH_ORCID_FALLBACK;

    password = await modal.request({ message });
    if (guard.tornDown()) return guard.cancel();
    if (password === REAUTH_PROMPT_BUSY) return FRESH_AUTH_PROMPT_BUSY;
    if (password === null || password === undefined) return FRESH_AUTH_CANCELLED;
    try {
      return await attemptMint(password);
    } catch (retryErr) {
      // A teardown outranks the spent-re-auth report here too: the user is not
      // owed "re-authentication failed" for an attempt this tab abandoned, and
      // the memo this leg would retire belongs to the successor by now.
      if (guard.tornDown()) return guard.cancel();
      // A second consecutive rejection of the password itself retires the
      // memo: the verifying route has now contradicted it twice, and a memo
      // hit answers "observed", the one answer that never falls back to
      // ORCID. The next resolution re-reads the status instead (the
      // transition this closes is documented at `_passwordFactorMemo`). A
      // transport failure here says nothing about the password and leaves
      // the memo alone.
      if (retryErr?.code === 'UNAUTHORIZED') clearPasswordFactorMemo();
      // Last re-prompt spent: a second auth failure, or any transport error on
      // the retry mint, means re-auth could not be completed. Surface the
      // generic re-auth failure rather than letting it escape as the op's own
      // message — the user has already been prompted twice.
      return FRESH_AUTH_MINT_FAILED;
    }
  }
}

// Open a teardown guard over a stretch of work that must all belong to one
// subject: the factor read, the prompt, the mint, and the guarded call the
// proof is minted for. Snapshot the generation the subject scrub bumps, and
// answer two questions afterwards — has the tab's subject-bound state been
// torn down since, and how does this flow report that.
//
// Open the guard BEFORE the first await of the stretch. The generation only
// distinguishes "before" from "after", so a guard opened after the teardown
// compares the post-teardown value against itself and never fires; that is the
// whole reason the guard is a value callers pass down rather than something
// each layer captures for itself.
//
// `cancel()` reports and returns the SAME sentinel a user dismissal does, so no
// caller needs a new branch and the window-outcome vocabulary keeps `cancelled`
// silent — but it speaks first, because the two are otherwise
// indistinguishable to a user who typed a password and watched nothing happen.
// A user's own dismissal stays silent; only a teardown-driven cancel reports.
//
// The report is at most once per teardown, and never once per guard. One
// subject change can abandon several flights at once — the acquisition slots
// are keyed on the redirect posture, so a page's own submit gate and the
// editor's inline-image upload can be parked on the same coalesced factor
// read — and each holds its own guard. Reporting per guard would stack
// identical messages describing one event. The claim below is what collapses
// them, and it is also how a teardown that already narrates itself
// (`handleSessionInconsistency`) keeps the flights it abandoned from talking
// over it. The claim is keyed to the live generation, so when subject changes
// come faster than the flights they abandon unwind, one report covers the run
// of them (see `_reportedTeardownGeneration`).
export function subjectTeardownGuard() {
  const generation = _acquireGeneration;
  return {
    tornDown: () => generation !== _acquireGeneration,
    cancel: () => {
      if (_reportedTeardownGeneration !== _acquireGeneration) {
        claimTeardownReport();
        toastLocalized(
          'auth',
          'reauthCancelled',
          'Your session changed, so the confirmation was cancelled.',
        );
      }
      return FRESH_AUTH_CANCELLED;
    },
  };
}

// The teardown generation whose message has already been delivered. Compared
// against the LIVE `_acquireGeneration`, so a claim suppresses every flight
// that unwinds while that generation is current, whichever teardown abandoned
// it: one report per teardown horizon, not one per teardown. A flight parked
// across two rapid subject changes therefore unwinds silently once any party
// has claimed the newer generation, and the earlier change is folded into that
// one message rather than narrated on its own. Deliberate: the user has just
// been told their session changed, and a second message about the change
// before it would only stack. The next scrub bumps the generation past the
// mark, and the first guard to unwind under it speaks again.
let _reportedTeardownGeneration = -1;

// Mark the current teardown as narrated. Called by `cancel()` as it reports,
// and by any teardown that shows a message of its own BEFORE the flights it
// abandoned resume — those flights then unwind silently rather than adding a
// second message about one event.
function claimTeardownReport() {
  _reportedTeardownGeneration = _acquireGeneration;
}

// The corrupted-session discriminator, in one place so the first-attempt and
// retry legs of every fresh-auth surface cannot drift on what a mismatch looks
// like. The JWT subject and the proof subject diverge; no re-mint fixes it
// (every re-acquisition would replay the same mismatched pair), so each leg
// routes it through `handleSessionInconsistency` rather than treating it as a
// retryable re-auth failure.
//
// `details.reason` is the whole gate, never a status code. The session-kind
// surface shapes its errors in signer.js and carries a 403 alongside; the
// consent-op, settings and upload surfaces raise api.js ApiRequestErrors that
// carry no `status` at all, and a retry-leg error that reaches a normalizing
// wrapper loses `status` on the way through. Keying on the reason is the only
// form that holds on every leg.
export function isUsernameMismatch(err) {
  return err?.code === 'FRESH_AUTH_REQUIRED' && err.details?.reason === 'username_mismatch';
}

// Dismiss a re-auth prompt left open across a subject teardown. Called by the
// auth store's subject scrub alongside the cache clears; kept here because
// this module is the modal store's only programmatic consumer, so the
// knowledge that `cancel()` resolves the pending `request()` — and that a
// `null` resolution is what unwinds `mintViaPasswordFactor` — stays with the
// code that depends on it.
//
// Without this the prompt survives the teardown three ways at once: it stays
// on screen and answerable for a subject the tab no longer represents, the
// previous subject's typed password stays live in the store (only submit and
// cancel clear it), and the orchestrator parked on `modal.request()` never
// resumes at all — there is no timeout on that await, so the action hangs
// until a human touches the prompt. `cancel()` closes all three: it hides the
// prompt, blanks the password, and resolves the parked promise so the
// generation check above can unwind the flow as a clean cancel.
//
// Safe when no prompt is open: `cancel()` is a no-op on the pending-promise
// half and merely re-blanks fields that are already blank.
export function dismissOpenReauthPrompt() {
  Alpine.store('reauthModal')?.cancel?.();
}

// The session-window periods the backend publishes in
// `agents/docs/api-contracts/custody.md`, mirrored client-side: a 15-minute
// sliding idle deadline and a 2-hour absolute cap.
// A freshly issued window always spans the full period, so at issuance the
// distance the client measures to the server's deadline is that period minus
// clock skew and round-trip latency — the deadlines carry no duration the
// client does not already know. Both clocks tick at the same rate, so the
// window really does last one full period of wall time from issuance no matter
// how far apart the two clocks are set.
const SESSION_IDLE_PERIOD_MS = 900_000;
const SESSION_ABSOLUTE_PERIOD_MS = 7_200_000;

// Reconcile one server deadline against the client clock at issuance. The
// measured span is trusted only inside a plausible band around the mirrored
// period:
//   - longer than the period means the client clock trails the server's. The
//     window is not really longer, and believing it is buys a mid-flow 401
//     exactly where the pre-flight margin exists to prevent one.
//   - shorter than half the period is skew, not a shorter backend period.
//     Honouring it spends the window on prompts the user does not owe, and a
//     span under the pre-flight margin makes every acquisition read as
//     instantly stale — which for a passwordless account is an ORCID redirect
//     loop, since the round-trip caches a window the next gate rejects.
// A genuine backend period change inside the band is still honoured, so the
// client tracks the server rather than hardcoding it outright.
function anchoredSpan(deadline, periodMs) {
  const measured = new Date(deadline).getTime() - Date.now();
  if (!Number.isFinite(measured)) return NaN;
  if (measured > periodMs || measured < periodMs / 2) return periodMs;
  return measured;
}

// In-memory fallback copy of the window, written ONLY when the sessionStorage
// write failed (private mode, quota, storage blocked). Without it a failed
// write leaves the acquire-before-commit gate reporting a window that nothing
// recorded, so a single publish pays for three acquisitions and a passwordless
// account's submit gate can never be satisfied. A successful write clears it,
// so storage stays the single source of truth whenever storage works at all.
let _memoryWindow = null;

function persistWindow(entry) {
  try {
    sessionStorage.setItem(SESSION_PROOF_KEY, JSON.stringify(entry));
    _memoryWindow = null;
  } catch {
    // The window still covers the rest of this page load through the mirror;
    // only surviving the ORCID round-trip (a full page load) needs storage.
    //
    // Drop any older stored entry before installing the mirror. A failed
    // write can leave a stale window readable (quota hit after an earlier
    // successful write), and the read consults storage before the mirror, so
    // without the removal the stale copy would shadow the fresher one. With
    // it, a non-empty storage read always implies a current entry by
    // construction.
    dropWindow();
    _memoryWindow = entry;
  }
}

function dropWindow() {
  _memoryWindow = null;
  try {
    sessionStorage.removeItem(SESSION_PROOF_KEY);
  } catch {
    /* noop */
  }
}

// The raw cached entry, from storage when storage holds one and from the
// in-memory mirror when the read comes back empty or unreadable.
function storedWindow() {
  let raw;
  try {
    raw = sessionStorage.getItem(SESSION_PROOF_KEY);
  } catch {
    return _memoryWindow;
  }
  if (raw === null || raw === undefined) return _memoryWindow;
  try {
    return JSON.parse(raw);
  } catch {
    dropWindow();
    return null;
  }
}

// Read the cached window: the token, both deadlines, and the idle period
// learned at issuance. `minRemainingMs` is the caller's freshness demand — a
// window still open but closing sooner than that reads as a miss WITHOUT being
// cleared, so a proactive re-auth the user then cancels leaves the live window
// usable for the action they were already taking.
//
// Every deadline in the entry is client-anchored (see `cacheSessionProof`), so
// comparing it to `Date.now()` is comparing two readings of the same clock.
function readSessionWindow(minRemainingMs = 0) {
  const entry = storedWindow();
  if (!entry) return null;
  const { token, expiresAt, absoluteExpiresAt, idlePeriodMs } = entry;
  if (!token || !expiresAt || !absoluteExpiresAt) {
    dropWindow();
    return null;
  }
  // A malformed deadline yields NaN; `Date.now() >= NaN` is false, so a naive
  // comparison would treat the entry as never-expiring. Treat a non-finite
  // deadline or idle period as corruption: clear the slot so the consumer
  // re-auths rather than replaying an entry of unknown lifetime.
  const idleTs = new Date(expiresAt).getTime();
  const absoluteTs = new Date(absoluteExpiresAt).getTime();
  if (
    !Number.isFinite(idleTs) ||
    !Number.isFinite(absoluteTs) ||
    !Number.isFinite(idlePeriodMs)
  ) {
    dropWindow();
    return null;
  }
  // The window ends at whichever deadline arrives first.
  const closesAt = Math.min(idleTs, absoluteTs);
  const now = Date.now();
  if (now >= closesAt) {
    dropWindow();
    return null;
  }
  if (now + minRemainingMs >= closesAt) return null;
  return { token, absoluteTs, idlePeriodMs };
}

function getCachedSessionProof(minRemainingMs = 0) {
  return readSessionWindow(minRemainingMs)?.token ?? null;
}

// Cache a freshly issued window. `expiresAt` is the server's sliding idle
// deadline and `absoluteExpiresAt` its cap; both are re-anchored to the client
// clock through `anchoredSpan` before being stored, so every later liveness
// check compares two readings of one clock and the server-vs-client offset
// drops out of the arithmetic entirely. The anchored idle span IS the idle
// period, and this is the only place the client can learn it — the backend
// publishes no period field — so it is stored alongside the deadlines for
// later slides to replay.
export function cacheSessionProof(token, expiresAt, absoluteExpiresAt) {
  const now = Date.now();
  const idlePeriodMs = anchoredSpan(expiresAt, SESSION_IDLE_PERIOD_MS);
  const absoluteSpanMs = anchoredSpan(absoluteExpiresAt, SESSION_ABSOLUTE_PERIOD_MS);
  // An unparseable deadline anchors to NaN, and `new Date(now + NaN)` throws a
  // RangeError at toISOString — from a cache write no caller expects to
  // reject. Fail closed instead, matching every other corrupt-entry case in
  // this module: drop the slot and let the next consumer re-auth.
  if (!Number.isFinite(idlePeriodMs) || !Number.isFinite(absoluteSpanMs)) {
    dropWindow();
    return;
  }
  persistWindow({
    token,
    expiresAt: new Date(now + idlePeriodMs).toISOString(),
    absoluteExpiresAt: new Date(now + absoluteSpanMs).toISOString(),
    idlePeriodMs,
  });
}

// Replay the server-side idle slide after a successful use. The backend pushes
// the idle deadline forward on every consume but echoes nothing back, so the
// client repeats the same arithmetic: now plus the idle period learned at
// issuance, never past the absolute cap. A miss (window already closed) is a
// no-op — the next acquisition re-auths. Every consume site owes this call;
// skipping one lets the client fall behind the server and evict a token the
// server would still honour.
export function slideSessionWindow() {
  const entry = readSessionWindow();
  if (!entry) return;
  const slidTs = Math.min(Date.now() + entry.idlePeriodMs, entry.absoluteTs);
  persistWindow({
    token: entry.token,
    expiresAt: new Date(slidTs).toISOString(),
    absoluteExpiresAt: new Date(entry.absoluteTs).toISOString(),
    idlePeriodMs: entry.idlePeriodMs,
  });
}

export function clearCachedSessionProof() {
  dropWindow();
}

// Cache a consent_op-kind proof along with its target binding: the
// `(action, root_author, root_permlink)` triple plus the optional credit-op
// fields `author_index` (claim/approve) and `claimer` (approve/revoke). Pass
// the values the backend ECHOED at issuance, not values reconstructed
// client-side, so the cache key cannot drift from the proof's actual binding.
// Anchored consent ops and settings actions omit the two optional fields;
// they normalize to null and the lookup matches on the triple alone. Returns
// void; failures (private mode, quota) are swallowed and the consumer simply
// won't find a cache hit on lookup — the freshly-minted token returned by the
// mint flow can still be passed to the broadcast in-memory.
export function cacheConsentOpProof(
  token, expiresAt, action, rootAuthor, rootPermlink, authorIndex, claimer,
) {
  try {
    sessionStorage.setItem(
      CONSENT_OP_PROOF_KEY,
      JSON.stringify({
        token,
        expiresAt,
        action,
        rootAuthor,
        rootPermlink,
        authorIndex: authorIndex ?? null,
        claimer: claimer ?? null,
      }),
    );
  } catch {
    /* same swallow as cacheSessionProof */
  }
}

// Look up a cached consent_op-kind proof. Strict match on every target field —
// the `(action, root_author, root_permlink)` triple plus `author_index` and
// `claimer` (each normalized to null when absent). Any mismatch returns null so
// the consumer mints a fresh proof bound to the intended slot/subject rather
// than replaying one minted for a different one. Also returns null and clears
// the slot on TTL expiry. A pre-extension cached entry (no author_index/claimer
// fields) reads them as undefined → null, so a triple-only lookup still hits.
//
// A token that is not a string is corruption, and it is dropped here with the
// tokenless and unreadable-deadline cases rather than at either orchestrator.
// One drop at the single reader is what both cache legs inherit —
// `withSettingsFreshAuth` and `withAuthorshipFreshAuth` each hand whatever this
// returns straight to their guarded call — and it is the placement
// `evictUnnamedAcquisition` chose one slot over, for the same reason: a refusal
// carried by each consumer refuses the value without dropping the entry behind
// it, so the next attempt on that target re-reads it and refuses again.
// The entry cannot outlive that refusal by way of the retry gate either:
// `consentOpFreshAuthRetryGate` rethrows anything that is not
// FRESH_AUTH_REQUIRED before it reaches its `clearProofCache` hook, and the
// routes whose request schema declares the proof as a bounded string answer a
// non-string with a validation rejection rather than a fresh-auth one — the
// accreditation-metadata edit and the admin authority actions. On those the
// gate's clear never runs, so nothing else would drop the entry inside its TTL.
//
// The drop sits with the corruption checks, BEFORE the target comparison, and
// that ordering is load-bearing in both directions. An entry whose token is not
// a string is unusable at every target, so waiting for a target match would
// leave it cached for the target it does match. The comparison itself still
// returns null WITHOUT removing, deliberately: a proof minted for another
// target is valid for that target, and evicting it on an unrelated lookup would
// charge the user a re-auth on a paper they were not acting on.
//
// Ungated, and for a stronger reason than `evictUnnamedAcquisition` had to
// argue: the read, the type test and the removal are adjacent synchronous
// statements in one function body. No await separates them, so a subject
// teardown cannot land between the entry this sees and the slot it clears, and
// the successor-pays-a-re-auth harm that gates the sibling clears in
// `broadcastWithFreshAuth` has no shape to take here. The tokenless and TTL
// drops it joins are ungated on the same grounds.
//
// The refusal a user can act on lives at the write instead, in the
// `/orcid/callback` fresh-auth handler, which is the only producer of this slot
// and the only place a refusal has a surface to appear on. This drop is the
// eviction, not that refusal: a miss here reads downstream as "no proof
// cached" and sends the consumer off to acquire one, which on an ORCID-only
// account is a full-page round-trip and not something the user is told about.
export function getCachedConsentOpProof(
  action, rootAuthor, rootPermlink, authorIndex, claimer,
) {
  try {
    const raw = sessionStorage.getItem(CONSENT_OP_PROOF_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    // An empty-string token is falsy and was always dropped here; the typeof
    // test widens the same branch to every other shape a JSON round-trip can
    // carry into the slot (a number, a boolean, an object, an array), each of
    // which is truthy and would otherwise be returned and broadcast verbatim.
    if (!entry || !entry.token || typeof entry.token !== 'string' || !entry.expiresAt) {
      sessionStorage.removeItem(CONSENT_OP_PROOF_KEY);
      return null;
    }
    // Malformed expiresAt yields NaN; `Date.now() >= NaN` is false. Treat
    // NaN as corruption — mirrors getCachedSessionProof.
    const ts = new Date(entry.expiresAt).getTime();
    if (!Number.isFinite(ts) || Date.now() >= ts) {
      sessionStorage.removeItem(CONSENT_OP_PROOF_KEY);
      return null;
    }
    if (
      entry.action !== action ||
      entry.rootAuthor !== rootAuthor ||
      entry.rootPermlink !== rootPermlink ||
      (entry.authorIndex ?? null) !== (authorIndex ?? null) ||
      (entry.claimer ?? null) !== (claimer ?? null)
    ) {
      return null;
    }
    return entry.token;
  } catch {
    return null;
  }
}

export function clearCachedConsentOpProof() {
  try {
    sessionStorage.removeItem(CONSENT_OP_PROOF_KEY);
  } catch {
    /* noop */
  }
}

export function getReturnPath() {
  try {
    return sessionStorage.getItem(RETURN_PATH_KEY);
  } catch {
    return null;
  }
}

export function clearReturnPath() {
  try {
    sessionStorage.removeItem(RETURN_PATH_KEY);
  } catch {
    /* noop */
  }
}

// THE re-auth factor resolver. Every surface that has to choose between the
// inline password prompt and the navigating ORCID round-trip calls this one
// function, so the factor a user is offered cannot depend on which page they
// happen to be on.
//
// `hasPassword` from the account status is the discriminator, and the failure
// direction is folded in here on purpose: ONLY an explicit `false` routes to
// ORCID. An unknown, absent, or failed status resolves to the password prompt
// and lets the backend reject a genuinely passwordless account. That asymmetry
// is the whole point. The ORCID factor is a full-page navigation that discards
// page state, so a transient status failure must never be the thing that fires
// it at someone who could have typed a password instead.
//
// The answer is `{ usesPassword, assumed }`: `usesPassword` picks the factor,
// and `assumed` records whether that pick was observed from the account status
// or guessed because the status was unavailable. The distinction matters at
// exactly one point — a 401 at a password mint. Against an observed password
// that is a typo and earns a re-prompt; against an assumed one it is at least
// as likely "no password registered", and a second prompt would dead-end an
// account whose only registered factor is ORCID. `mintViaPasswordFactor`
// consumes the flag and hands such callers back to their ORCID factor.
//
// A positive answer is memoized per username for the tab. A password is lost
// through one transition only, an ORCID recovery with no new password (B → C
// in ARCHITECTURE.md § 6.3), so re-fetching the status on every acquisition
// would be pure latency; a memo that outlives that transition is retired by
// the two erasers (the subject scrub and the mint route's second consecutive
// rejection). The negative and assumed answers are deliberately NOT memoized
// — a passwordless user who sets a password in settings must be able to use
// it on their next acquisition, and a guess must never harden into a fact. A
// successful password MINT under an assumed factor is no longer a guess — the
// backend verified the password — so it does memoize, via
// `beginPasswordMintReport`. The memo is keyed on the authenticated username
// so a re-login as a different account in the same tab cannot inherit it.
//
// Both erasers run through `clearPasswordFactorMemo`. The subject scrub
// (`auth.disconnect()`, and a login that changes the JWT subject) drops the
// memo outright alongside the proof caches. The mint route drops it on a
// second consecutive rejection of the password (`mintViaPasswordFactor`'s
// spent re-prompt), because the memo can outlive the password it vouches for:
// the recovery that drops a password can run in another tab, and a re-login
// as the same subject keeps this tab's state on purpose, so the subject scrub
// never runs here. A memo hit answers "observed", which is exactly the answer
// that never falls back to ORCID, so a stale memo would prompt for a password
// that no longer exists on every action until a page reload. Two rejections
// at the verifying route outrank the memo exactly as one success there
// outranks the status endpoint; a real password holder who mistypes twice
// pays one extra status read before the memo is rebuilt.
let _passwordFactorMemo = null;
// Pairs the memo with `clearPasswordFactorMemo()`: a clear landing while a
// status fetch is in flight must not be undone by that fetch resolving
// afterwards, so the writer captures the generation before its await and
// declines the write when a clear happened in between.
let _passwordFactorMemoGeneration = 0;
// Concurrent resolutions coalesce onto one status request. The resolver has
// direct callers on several surfaces (session acquisition, both consent-op
// orchestrators, and their retry gates), and two racing callers must not each
// spend the rate-limited status budget — nor land on different factors when
// one request succeeds and its sibling transiently fails. Mirrors the
// in-flight pattern of `_acquireInFlight` below.
//
// The join is identity-keyed: the flight records the authenticated subject it
// was started for, and a caller shares it only when the current subject
// matches. The status read is answered for the JWT that made it, so its
// answer must stay with that subject. The subject scrub already nulls the
// slot on every enumerated subject change; the key is the belt-and-braces
// refusal for any path that swaps the subject without the scrub.
let _factorResolutionInFlight = null;
let _factorResolutionSubject = null;

export function clearPasswordFactorMemo() {
  _passwordFactorMemo = null;
  _passwordFactorMemoGeneration += 1;
}

// The memo's second writer: a successful password mint. The mint route
// VERIFIED the password, which outranks anything the status endpoint could
// report — and keeps working while that endpoint is rate-limited (per IP, so
// a shared university network can keep it unavailable across a whole
// session). Without this report an ASSUMED factor stays a guess after a
// successful mint, the next resolution re-guesses, and one later mistype
// fires the navigating ORCID fallback at an account that just proved its
// password exists. Every mint success reports, observed or assumed — the
// evidence is identical, and for an already-memoized observed answer the
// write is an idempotent refresh. `mintViaPasswordFactor` owns the report for
// all of its callers (the session acquisition and the settings and authorship
// orchestrators), so no mint surface can forget it.
//
// Both the subject and the generation are captured BEFORE the prompt opens,
// mirroring the status-fetch write's capture-before-await shape: a subject
// scrub landing while the modal sits open bumps the generation (via
// `clearPasswordFactorMemo`) and so vetoes the write, instead of the late
// success re-memoizing for a subject this tab no longer represents.
function beginPasswordMintReport() {
  const username = Alpine.store('auth')?.username;
  const generation = _passwordFactorMemoGeneration;
  return (minted) => {
    // Only a proof string is a mint success. A mint callback may resolve to
    // a sentinel instead (the session acquisition's teardown path unwinds as
    // a clean cancel), and that proves nothing about the password.
    if (typeof minted !== 'string') return;
    if (username && generation === _passwordFactorMemoGeneration) {
      _passwordFactorMemo = username;
    }
  };
}

export async function resolvePasswordFactor() {
  const username = Alpine.store('auth')?.username;
  if (username && _passwordFactorMemo === username) {
    return { usesPassword: true, assumed: false };
  }
  if (_factorResolutionInFlight && _factorResolutionSubject === username) {
    return _factorResolutionInFlight;
  }

  const flight = (async () => {
    const generation = _passwordFactorMemoGeneration;
    let hasPassword;
    try {
      hasPassword = (await fetchEmailStatus())?.data?.hasPassword;
    } catch {
      hasPassword = undefined;
    }
    if (
      hasPassword === true &&
      username &&
      generation === _passwordFactorMemoGeneration
    ) {
      _passwordFactorMemo = username;
    }
    return {
      usesPassword: hasPassword !== false,
      assumed: hasPassword !== true && hasPassword !== false,
    };
  })();

  _factorResolutionInFlight = flight;
  _factorResolutionSubject = username;
  try {
    return await flight;
  } finally {
    // A teardown (abandonInFlightAcquisitions) may have cleared the slot and
    // a newer resolution may own it by now; only the flight that installed
    // itself may clear it.
    if (_factorResolutionInFlight === flight) {
      _factorResolutionInFlight = null;
      _factorResolutionSubject = null;
    }
  }
}

// Start the ORCID round-trip that opens a session window. The only factor a
// passwordless account has, and a full-page navigation — callers must have
// nothing unsaved in flight when this fires (see `ensureSessionWindow`).
// `isStale` is the acquisition's teardown predicate, threaded through to the
// redirect helper's pre-navigation re-check; `acquireSessionProof`, the one
// caller, always threads its flight's guard, so no production flight reaches
// the redirect without one.
export async function beginSessionAuthOrcidRedirect(isStale) {
  return beginOrcidFreshAuthRedirect('session_auth', {}, '/', isStale);
}

// Acquire a session-kind window: reuse the cached one, or open a new one
// through the factor the account has registered. Password accounts mint inline
// at `POST /api/custody/session-auth` (a modal, no navigation); passwordless
// accounts take the ORCID round-trip.
//
// Returns the proof string, FRESH_AUTH_REDIRECT_PENDING when the ORCID factor
// started a full-page round-trip (the window lands in cache when the user
// returns via /orcid/callback), FRESH_AUTH_CANCELLED when the password modal
// was dismissed, FRESH_AUTH_MINT_FAILED when re-auth could not be completed, or
// FRESH_AUTH_PROMPT_BUSY when another action already owns the modal. It also
// returns values the outcome vocabulary does not name: `undefined` when the
// mint answered without a proof string, which the mint callback's narrowing
// picks deliberately, and a truthy non-string when the cache leg hands back
// what the window slot was holding. Every consumer refuses either as an unnamed
// result rather than reading it as an outcome anyone registered.
// Throws on transport / config errors.
//
// `allowRedirect: false` suppresses the navigating factor: callers already
// holding something the user would lose (a picked image, a batch of completed
// pins) get FRESH_AUTH_REAUTH_REQUIRED instead of a full-page ORCID round-trip
// fired out from under them. Only the passwordless branch is suppressed — the
// password factor's modal is inline and costs nothing to show mid-flow.
//
// Concurrent callers — a submit and a vote button racing in the same tick, or a
// page batch and an inline editor image — are coalesced through the
// module-level `_acquireInFlight` promises, so only one password modal or one
// redirect is ever in flight per posture. That coalescing is what lets the
// upload layer drop its own prompt-serialization gate: the singleton reauth
// modal is never asked twice concurrently by callers sharing a posture.
//
// The slot is keyed on the redirect policy: a caller only joins an
// acquisition that shares its `allowRedirect` posture. Joined promises hand
// the joiner the FIRST caller's outcome, and the two postures resolve the
// passwordless branch oppositely — suppressed refuses where permissive
// navigates — so a submit entitled to navigate must never inherit the
// refusal of an inline-image acquisition it happened to race, nor the other
// way round. Cross-posture collisions on the password factor surface as the
// modal's own busy sentinel, which callers already handle.
const _acquireInFlight = { permissive: null, suppressed: null };

// Pairs the in-flight acquisition state with `abandonInFlightAcquisitions()`:
// a flight captures the generation before its awaits and, when a teardown
// intervened, declines to cache, deliver, or navigate for a subject this tab
// no longer represents. Mirrors the `_passwordFactorMemoGeneration` pattern
// above.
let _acquireGeneration = 0;

// Abandon the module-level in-flight state when the tab's subject-bound
// session state is torn down (explicit logout, or a login that changes the
// JWT subject). Called by the auth store's subject scrub alongside the cache
// clears; this function owns only the in-flight promises and their
// generation, while the caches and the password-factor memo keep their own
// exported clears next to it in that scrub. Two hazards this closes:
//   - a caller arriving AFTER the teardown must not join a flight started
//     for the previous subject and inherit its outcome;
//   - an acquisition still pending at teardown must not repopulate the
//     just-scrubbed window cache when its mint resolves late (the mint
//     function writes `cacheSessionProof` on resolve) nor hand its proof to
//     anyone; the generation bump makes such a flight resolve as a clean
//     cancel instead.
// Contract for every production caller, present or future: a generation bump
// must travel with the SUBJECT_BOUND_STORAGE_KEYS removal in the same
// synchronous body, as `_scrubSubjectBoundState` does.
// `beginOrcidFreshAuthRedirect`'s stale unwind reads a bumped generation as
// proof that its own flow keys are already gone and leaves whatever stands in
// them to the later flow that wrote it, so a caller that bumps without
// clearing inverts that rule and turns every stale unwind into a key leak.
export function abandonInFlightAcquisitions() {
  _acquireGeneration += 1;
  _acquireInFlight.permissive = null;
  _acquireInFlight.suppressed = null;
  _factorResolutionInFlight = null;
  _factorResolutionSubject = null;
}

// Evict the window slot when an acquisition resolves a value the outcome
// vocabulary does not name, so every reading of that one slot inherits the drop
// instead of each consumer carrying its own. TWO sites read the raw acquisition
// result, and both already REFUSE such a value — the fail-closed guard in
// `ensureSessionWindow` and the broadcast unwinder `acquisitionAborted` — but
// only the guard ever cleared, so a truthy non-string reaching the broadcast
// surface was refused and left where it was, to be re-read and re-refused on
// every later vote, comment and review until the entry's idle deadline arrived,
// a sign-out scrubbed the slot, or an unrelated page gate or upload pre-flight
// happened to run the evicting one. The upload pre-flight is not a third such
// reading: `windowProof` (lib/ipfs-upload.js) calls `ensureSessionWindow` and
// refuses through its OUTCOME, so it inherited the guard's clear from the start
// and was never a reader that could strand a value. The THREE-site tally at
// `WINDOW_OUTCOME_BY_SENTINEL` is a different and equally correct count: it
// tallies who acts on an outcome, which the page gate and the upload pre-flight
// both do, not who reads the raw result.
//
// The value travels on unchanged: refusing is still each consumer's own, and a
// swallow would have to pick the value to swallow into. Every falsy candidate
// but `''` and `null` is a non-string the guard and `acquisitionAborted`
// already refuse, and the user is already told re-authentication failed, so
// swallowing into one of those buys nothing. `''` is falsy AND a string, so it
// clears both string tests and arrives as a ready window, where the page gate
// says yes and the upload pre-flight takes the unproofed branch self-custody
// uses. `null` is the registered redirect member, so a swallow into it would
// manufacture the misread the mint callback's narrowing exists to prevent.
//
// Ungated, unlike the sibling clears in `broadcastWithFreshAuth`. Those hold a
// real round-trip between the window they read and the clear they run, so a
// teardown landing inside it leaves the successor's freshly minted entry in the
// slot and dropping it would charge them a re-auth that was never theirs.
// Nothing here has that shape: the cache leg reads and clears in adjacent
// synchronous statements, and every teardown boundary a flight crosses resolves
// FRESH_AUTH_CANCELLED, a registered outcome this check never fires on —
// including the boundary between the mint's cache write and its return. What is
// left is a microtask hop, and the subject scrub empties the slot before it
// bumps the generation while both writers of that slot sit behind a round-trip,
// so a teardown landing in the hop can only make this clear a no-op.
function evictUnnamedAcquisition(proof) {
  if (typeof proof !== 'string' && acquisitionOutcomeKey(proof) === null) {
    clearCachedSessionProof();
  }
  return proof;
}

async function acquireSessionProof(minRemainingMs = 0, { allowRedirect = true } = {}) {
  const cached = getCachedSessionProof(minRemainingMs);
  if (cached) return evictUnnamedAcquisition(cached);
  const slot = allowRedirect ? 'permissive' : 'suppressed';
  // A joiner runs no eviction of its own: the flight that installed itself
  // drops an unnamed result before its `finally` releases the slot, so by the
  // time a joiner or a later cold caller can look, it has already happened once
  // for everyone.
  if (_acquireInFlight[slot]) return _acquireInFlight[slot];

  // Opened before any await: a teardown bumping the generation mid-flight
  // turns every later step into a clean cancel (see
  // abandonInFlightAcquisitions).
  //
  // Which boundaries REPORT that cancel is a deliberate split. The two below
  // that call `guard.cancel()` are the ones no other layer speaks for: past
  // them the flight resolves `cancelled`, an outcome the shared dispatch
  // table keeps silent by design, and the upload pre-flight then throws its
  // own already-reported code — so without a word here the user would answer
  // nothing, see nothing, and watch the action end. The prompt, the mint and
  // the post-mint boundaries stay silent for the opposite reason:
  // `mintViaPasswordFactor` holds its own guard across exactly those awaits
  // and has already spoken by the time control returns here, so a second
  // report would be the double toast rather than the missing one.
  const guard = subjectTeardownGuard();
  const flight = (async () => {
    // The navigation policy for the passwordless outcome, applied in one
    // place: the known-passwordless branch and the assumed-password fallback
    // below share it, so the two cannot diverge on when a redirect may fire.
    // The redirect leg carries the flight's teardown predicate: the start
    // round-trip inside it is the one await left between the teardown checks
    // here and the navigation, so the helper re-checks at that boundary and
    // cancels a stale flight instead of navigating for a subject this tab no
    // longer represents. Nothing downstream of that cancel reports it, so the
    // report belongs here.
    const orcidOrRefuse = async () => {
      if (!allowRedirect) return FRESH_AUTH_REAUTH_REQUIRED;
      const started = await beginSessionAuthOrcidRedirect(guard.tornDown);
      return started === FRESH_AUTH_CANCELLED ? guard.cancel() : started;
    };

    const factor = await resolvePasswordFactor();
    // The status read is a real round-trip, and a negative or assumed answer
    // is never memoized, so every cold acquisition awaits it — this is the
    // teardown boundary a cross-tab subject change is likeliest to land in.
    // It is also the pre-call re-check `mintViaPasswordFactor`'s default
    // guard depends on (see its docblock): nothing may be awaited between
    // here and the call below.
    if (guard.tornDown()) return guard.cancel();
    if (!factor.usesPassword) return orcidOrRefuse();

    const minted = await mintViaPasswordFactor(
      async (password) => {
        // The prompt can sit open across a teardown; do not spend a mint on
        // a subject this tab no longer represents.
        if (guard.tornDown()) return FRESH_AUTH_CANCELLED;
        const issued = await mintSessionAuthProof(password);
        // A teardown while the mint round-trip was pending: the scrub has
        // already emptied the window slot, and this write would repopulate
        // it under the wrong subject. Drop the issuance and unwind.
        if (guard.tornDown()) return FRESH_AUTH_CANCELLED;
        const proof = issued.fresh_auth_proof;
        cacheSessionProof(proof, issued.expires_at, issued.absolute_expires_at);
        // Hand back a string or nothing, never the response value verbatim.
        // The window vocabulary's redirect member IS `null`, the one sentinel
        // a JSON body can reproduce, so a response carrying
        // `"fresh_auth_proof": null` returned as it stands would classify as
        // an ORCID round-trip already in flight, with no navigation behind it:
        // the page gate and the broadcast unwinder say nothing (the toast
        // table keeps the redirect row silent, since a page that is leaving
        // needs no message) and the upload pre-flight raises its cancel code,
        // so the user is either told nothing or told they cancelled, and
        // neither is something they can act on. Every other member is a Symbol
        // no response can produce, which is why this is the only coercion the
        // wire needs. Narrowing to `undefined` lands a null token where the
        // other malformed ones already land, in the fail-closed guard that
        // refuses; its consumers say so. The `cacheSessionProof` call keeps
        // the raw value deliberately: a null token reads as tokenless and is
        // dropped whenever the entry is next read, and
        // `evictUnnamedAcquisition` removes it before then anyway.
        return typeof proof === 'string' ? proof : undefined;
      },
      { message: passwordPromptMessage(), assumed: factor.assumed },
    );
    if (guard.tornDown()) return FRESH_AUTH_CANCELLED;
    // The assumed factor turned out to be the wrong guess: the account has no
    // password to prompt for, so the ORCID round-trip is the way through.
    if (minted === FRESH_AUTH_ORCID_FALLBACK) return orcidOrRefuse();
    return minted;
  })();

  _acquireInFlight[slot] = flight;
  try {
    return evictUnnamedAcquisition(await flight);
  } finally {
    // A teardown may have cleared the slot and a newer flight may have
    // claimed it since; only the flight that installed itself may clear it.
    if (_acquireInFlight[slot] === flight) _acquireInFlight[slot] = null;
  }
}

// ---------------------------------------------------------------------------
// The window-outcome vocabulary and its shared dispatch.
//
// `acquireSessionProof` resolves to a proof string or to one of the sentinels
// below, and three independently owned sites consume the result: the page gate
// `freshAuthWindowReady`, the broadcast unwinder `acquisitionAborted`, and the
// upload pre-flight `windowProof` (lib/ipfs-upload.js). This map is THE
// registration point for the vocabulary: `ensureSessionWindow` derives its
// outcome object from the key, the toast dispatch below carries the message
// (or deliberate silence) each outcome owes the user, and the vocabulary-driven
// exhaustiveness suite pins every consuming site against `WINDOW_OUTCOME_KEYS`,
// so a member added here without a matching entry at a consumer is a failing
// test rather than a silent fall-through discovered in review.
//
// FRESH_AUTH_ORCID_FALLBACK is deliberately absent: acquisition resolves it
// internally (to the ORCID redirect or the suppressed refusal) before any
// window consumer sees it, and the exhaustiveness suite pins that exclusion.
const WINDOW_OUTCOME_BY_SENTINEL = new Map([
  [FRESH_AUTH_REDIRECT_PENDING, 'redirect'],
  [FRESH_AUTH_CANCELLED, 'cancelled'],
  [FRESH_AUTH_MINT_FAILED, 'failed'],
  [FRESH_AUTH_PROMPT_BUSY, 'busy'],
  [FRESH_AUTH_REAUTH_REQUIRED, 'reauthRequired'],
]);

// The non-ready outcome keys, derived from the registration map so the two
// cannot drift. Every outcome object carries exactly one of these keys by
// construction (`ensureSessionWindow` sets the one matching its sentinel).
export const WINDOW_OUTCOME_KEYS = Object.freeze([...WINDOW_OUTCOME_BY_SENTINEL.values()]);

// Classify an acquisition result for consumers that see the raw
// proof-or-sentinel: the vocabulary key, or null for a proof string in hand
// (and for any value outside the vocabulary, which every consumer treats as
// its existing fall-through).
export function acquisitionOutcomeKey(proof) {
  return WINDOW_OUTCOME_BY_SENTINEL.get(proof) ?? null;
}

// Which vocabulary member a non-ready `ensureSessionWindow` outcome carries;
// null for a ready outcome (or one outside the vocabulary).
export function windowOutcomeKey(outcome) {
  return WINDOW_OUTCOME_KEYS.find((key) => outcome?.[key]) ?? null;
}

// The message each outcome owes the user, in one table so no consuming site
// can drift on copy or on which outcomes speak. A null row is a decision, not
// a gap:
//   redirect   an in-flight navigation needs no toast; the page is leaving.
//   cancelled  silent HERE. A user's own dismissal warrants no message, and a
//              teardown-driven cancel has already been reported at the abort
//              site (`subjectTeardownGuard`), so a row would double-report it.
//   failed     re-auth could not be completed (a second wrong password, or a
//              transport error on the retry mint): the user was prompted twice
//              and would otherwise watch the action do nothing at all.
//   busy       the action was refused because another action's prompt owns the
//              modal. The user never saw a prompt for THIS action, so saying
//              nothing would look like the button did nothing.
//   reauthRequired  no window is open and the account's only factor navigates,
//              but the caller asked for a non-navigating acquisition. The work
//              was refused before anything was lost — that is the point of
//              suppressing — but a silent refusal reads as a dead button, so
//              tell the user the way through: re-authenticate, then try again.
const WINDOW_OUTCOME_TOASTS = Object.freeze({
  redirect: null,
  cancelled: null,
  failed: {
    section: 'settings',
    name: 'reauthFailed',
    fallback: 'Re-authentication failed. Please try again.',
  },
  busy: {
    section: 'common',
    name: 'reauthPromptOpen',
    fallback: 'Finish the confirmation already open, then try again.',
  },
  reauthRequired: {
    section: 'common',
    name: 'reauthRequired',
    fallback: 'Please confirm your identity again, then try once more.',
  },
});

// The one dispatch behind every site that consumes an acquisition outcome, so
// none of them carries a copy of its own. Silent for outcomes whose table row
// is null and for a null key (a ready outcome, or a value outside the
// vocabulary). The localization and the show come from `toastLocalized`, shared
// with the module's non-vocabulary messages.
export function showWindowOutcomeToast(outcomeKey) {
  const spec = outcomeKey ? WINDOW_OUTCOME_TOASTS[outcomeKey] : null;
  if (!spec) return;
  toastLocalized(spec.section, spec.name, spec.fallback);
}

// Acquire-before-commit gate (ARCHITECTURE.md § 6.4.1). Call this BEFORE
// starting work whose loss would cost the user — selecting a file, uploading to
// IPFS, entering a submit sequence — never after. The ORCID factor acquires by
// full-page navigation, so an acquisition that happens mid-flow throws away the
// attached file and any completed upload; acquiring first is what makes inline
// upload reachable for a passwordless account at all, and it is why neither the
// selected file nor the resulting CID needs to be persisted into a draft.
//
// By default a window closing sooner than the pre-flight margin reads as
// already spent, so a submit about to begin re-auths deliberately rather than
// discovering the window closed halfway through.
//
// Returns:
//   { ready: true, proof }            proceed; `proof` is the window token, or
//                                     null for self-custody (Keychain signs per
//                                     request and needs no window)
//   { ready: false, redirect: true }  ORCID round-trip in flight; abort cleanly
//   { ready: false, cancelled: true } the password modal was dismissed, or a
//                                     subject teardown abandoned the
//                                     acquisition (already reported)
//   { ready: false, failed: true }    re-auth could not be completed
//   { ready: false, busy: true }      another action's prompt owns the modal
//   { ready: false, reauthRequired: true }  no window is open and the only
//                                     factor navigates, but the caller asked
//                                     for a non-navigating acquisition
//
// The non-ready outcome keys come from `WINDOW_OUTCOME_BY_SENTINEL` above: a
// new way for an acquisition to end is registered there, never by adding a
// branch here. An acquisition result the vocabulary does not name is refused
// rather than trusted, so a forgotten registration costs a re-auth act, never
// a sentinel delivered downstream as if it were a proof.
//
// Throws on transport / config errors, so callers that have nothing to unwind
// go through `freshAuthWindowReady` instead, which cannot reject.
export async function ensureSessionWindow({
  minRemainingMs = WINDOW_PREFLIGHT_MARGIN_MS,
  allowRedirect = true,
} = {}) {
  if (Alpine.store('auth')?.custody !== 'light') return { ready: true, proof: null };

  const proof = await acquireSessionProof(minRemainingMs, { allowRedirect });
  const outcomeKey = acquisitionOutcomeKey(proof);
  if (outcomeKey) return { ready: false, [outcomeKey]: true };
  // Fail closed on anything outside the vocabulary. The sentinel legs are
  // closed by construction with one exception, and closing it is the mint
  // callback's job: the redirect member IS `null`, a value JSON can carry, so
  // that callback narrows what it hands back rather than let a response reach
  // the sentinel space. Every other member is a Symbol no response can
  // produce. What stays open is the window slot, which the cache leg and the
  // mint leg both run through and neither type-checks: `readSessionWindow`
  // hands back any token that is not FALSY (it checks the deadlines, never the
  // token), and the mint callback hands `fresh_auth_proof` to
  // `cacheSessionProof` unexamined, narrowing only what it returns. So a
  // non-string here either came out of that slot or has just gone into it, and
  // a refusal that leaves it there is a lockout rather than a refusal: every
  // later reading finds the same entry and refuses again. Which is why the
  // eviction belongs to `acquireSessionProof`, where those two legs and the two
  // readings of the raw result pass through one drop; the
  // `clearCachedSessionProof()` in this guard is a deliberate restatement of
  // it, kept so this gate answers for its own refusal without a reader having
  // to trust an eviction they cannot see from here, and a second drop of an
  // already-empty slot costs nothing.
  //
  // Ungated, where the module's one GATED clear — the 401 eviction in
  // `broadcastWithFreshAuth` — sits behind `!guard.tornDown()`. That one holds
  // a real network round-trip between the window it read and the clear it
  // runs, so a teardown landing inside it would drop a successor's freshly
  // minted entry and charge them a re-auth that was never theirs. This clear
  // has no such gap: nothing is awaited between the acquisition resolving and
  // this line, and every flight that crosses a teardown boundary resolves
  // FRESH_AUTH_CANCELLED, which is registered and returns before the guard is
  // reached. It is the same argument `evictUnnamedAcquisition` makes for the
  // drop this one restates.
  //
  // What the drop in `evictUnnamedAcquisition` removes depends on the value,
  // and this clear restates it. A Symbol never reaches storage
  // (`JSON.stringify` omits the field, leaving a deadline-only shell that
  // reads as tokenless), but the in-memory mirror `persistWindow` falls back
  // to on a failed write keeps the raw entry, Symbol included, and a Symbol
  // token reads back live, so a Symbol needs that drop only there; a truthy
  // number or an object survives both paths and is the case that drop is
  // chiefly for. Left in place, an entry this module wrote is bounded by its
  // IDLE deadline (`cacheSessionProof` always anchors idle nearer than the
  // cap, and every consume site refuses before it reaches
  // `slideSessionWindow`), while an entry written by anything else is bounded
  // only by the deadlines it carries, which `readSessionWindow` still
  // enforces but which need not sit inside the module's periods.
  //
  // The direction this guard exists to close is the quiet one. Read as a ready
  // window, an unregistered result travels on AS the proof, and how it fails
  // then turns on its own shape rather than on anything the user can answer. A
  // truthy one clears the upload path's missing-proof checks and reaches the
  // pre-flight request: `JSON.stringify` omits a Symbol-valued field, so that
  // request leaves carrying no proof at all, while a number or an object goes
  // out as it stands for the backend's own string test to reject. A falsy one
  // takes the unproofed branch instead, the one self-custody uses, where a
  // light account is refused before a request is built. Every route ends in a
  // rejection with nothing to act on. This is also the string test
  // `acquisitionAborted` applies to the raw acquisition result, so both
  // readings of an outcome refuse an unnamed one alike — and both now inherit
  // the one eviction rather than each owning its own, so neither can leave an
  // entry behind for the other to heal. Neither refuses in silence either:
  // `acquisitionAborted` falls the unnamed class through to the same `failed`
  // outcome this guard returns for it. What they still differ on is which
  // vocabulary carries that refusal out. This guard only names the outcome and
  // leaves the report to whoever consumes it — `freshAuthWindowReady` through
  // the toast dispatch, `windowProof` (lib/ipfs-upload.js) through the upload
  // error codes — while the broadcast unwinder shows the message itself,
  // because `broadcastWithFreshAuth` collapses every failed acquisition into
  // the one FRESH_AUTH_REDIRECT_PENDING sentinel, which is the whole of what
  // its call sites see.
  if (typeof proof !== 'string') {
    clearCachedSessionProof();
    return { ready: false, failed: true };
  }
  return { ready: true, proof };
}

// The refuse-while-open outcome as the orchestrators' callers see it: toast
// the way out, then unwind through the existing clean-abort outcome so call
// sites need no new branch — the message is the whole difference from a
// cancel. Shared by the settings and authorship orchestrators (both gates
// each) so the collision cannot read differently between surfaces.
export function promptBusy() {
  showWindowOutcomeToast('busy');
  return { cancelled: true };
}

// Page-level acquire-before-commit gate: acquire the window, surface the one
// outcome the user needs told about, and answer the only question the caller
// has — may I start this work? Pages call this before a file selection or a
// submit sequence so a passwordless account's full-page ORCID round-trip fires
// while there is nothing to lose. See `ensureSessionWindow` for the ordering
// rule and the outcome vocabulary.
export async function freshAuthWindowReady(opts) {
  let outcome;
  try {
    outcome = await ensureSessionWindow(opts);
  } catch (err) {
    // A gate that rejects is worse than the path it front-runs: it sits ahead
    // of the caller's own try, so the rejection escapes, the step machine never
    // leaves idle, and the user re-clicks a dead-looking button forever. Every
    // acquisition failure the user can act on is a re-auth failure, so say so
    // and refuse the work.
    console.warn('[fresh-auth] window acquisition failed', err);
    showWindowOutcomeToast('failed');
    return false;
  }
  if (outcome.ready) return true;
  // Every non-ready outcome surfaces through the shared dispatch: the table
  // decides which outcomes speak and which stay silent, so this site cannot
  // drop a newly added vocabulary member on the floor.
  showWindowOutcomeToast(windowOutcomeKey(outcome));
  return false;
}

// Generic ORCID fresh-auth redirect. Stashes the return path + per-tab mode
// marker, starts the OAuth round-trip with the caller's target `extra`, validates
// the redirect host against the shared allowlist, and navigates. Callers supply
// the OAuth `mode` ('session_auth' for the target-less broadcast/upload window,
// 'fresh_auth' for the target-bound consent-op and settings surfaces), the
// `extra` (the action plus any target fields the backend binds) and a default
// return path used only when `window.location.pathname` is empty. Returns
// FRESH_AUTH_REDIRECT_PENDING; throws on transport / config / invalid-host errors.
//
// `isStale` (optional) is a teardown predicate re-checked after the start
// round-trip: the round-trip is an await a subject teardown can land inside,
// and a navigation issued past it would send the tab to ORCID on behalf of a
// subject it no longer represents. A stale flight whose start succeeds
// resolves as FRESH_AUTH_CANCELLED — the same silent clean-cancel every other
// teardown boundary in the acquisition resolves to; one whose start rejects
// still propagates the rejection to its caller, with the keys left alone
// under the flow-key ownership rule. When the predicate is a consent-op
// guard's `tornDown`, the guarded caller owns the report. Every production
// caller threads one: the session acquisition through
// `beginSessionAuthOrcidRedirect`, and both consent-op orchestrators through
// `beginOrcidUnderGuard`. The page-level ORCID flows (login, signup, recover,
// the settings link, accreditation) do not come through here at all — they
// write their own mode marker and call `startOrcid` directly — so the
// parameter is optional for the unit seam, not for a second caller class.
//
// The predicate also gates every unwind past that await, because the flow keys
// the start wrote are the subject scrub's to remove and not this unwind's: the
// scrub (`_scrubSubjectBoundState`) bumps the generation the predicate reads
// and removes SUBJECT_BOUND_STORAGE_KEYS in one synchronous body, and this
// flight wrote its keys before the await the teardown landed in. So a stale
// flight's own keys are already gone, and whatever stands in them now was
// written by a later flow in this tab. Taking those would strand it:
// `completeOrcid` reads the mode marker to decide whether the callback carries
// the session JWT, so a flow whose marker went missing posts an
// authenticated-mode callback unauthenticated and dead-ends on return.
async function beginOrcidFreshAuthRedirect(mode, extra, returnPathDefault, isStale) {
  const returnPath = window.location.pathname || returnPathDefault;
  try {
    sessionStorage.setItem(RETURN_PATH_KEY, returnPath);
  } catch {
    /* return-path fallback handled in callback */
  }
  // Per-tab marker so the callback dispatches to the matching handler.
  // sessionStorage, not localStorage: localStorage is shared across tabs, so a
  // second tab in a different mode (e.g. 'link') would silently overwrite this
  // tab's marker and route the callback to the wrong handler. sessionStorage is
  // per-tab and survives the OAuth round-trip within the originating tab.
  sessionStorage.setItem(ORCID_MODE_KEY, mode);

  // The one unwind, so no exit past the start round-trip can drift from the
  // ownership rule in the docblock. What decides is what the predicate ANSWERS,
  // not that a caller supplied one: a stale flight leaves the keys alone, and
  // every other exit removes them.
  const unwindFlowKeys = () => {
    if (isStale?.()) return;
    sessionStorage.removeItem(ORCID_MODE_KEY);
    clearReturnPath();
  };

  let data;
  try {
    data = await startOrcid(mode, extra);
  } catch (err) {
    unwindFlowKeys();
    throw err;
  }

  if (isStale?.()) return FRESH_AUTH_CANCELLED;

  // Validate the redirect host before navigating — open-redirect defense
  // shared with settings.js handleOrcidLink. Uses the shared
  // ORCID_REDIRECT_HOSTS allowlist, not an inline literal, so no redirect flow
  // can drift from the others' host policy.
  let target;
  try {
    target = new URL(data.redirect_url);
  } catch {
    unwindFlowKeys();
    throw new Error('Invalid ORCID redirect URL');
  }
  if (!ORCID_REDIRECT_HOSTS.includes(target.hostname)) {
    unwindFlowKeys();
    throw new Error('Invalid ORCID redirect URL');
  }

  window.location.href = data.redirect_url;
  return FRESH_AUTH_REDIRECT_PENDING;
}

// Initiate an ORCID fresh-auth round-trip for a settings critical action
// (`change_email`, `set_password`, `delete_account`). Sibling of
// `beginSessionAuthOrcidRedirect`, but for the consent-op-kind, target-bound
// settings surface rather than the session-kind window: the proof the backend
// mints binds to (action, <username>, ''), and the `/orcid/callback` handler
// caches it via `cacheConsentOpProof` keyed on the echoed target. The settings
// flow retrieves it post-redirect with `getCachedConsentOpProof(action,
// username, '')`.
//
// This is the only mint factor for `set_password` (a passwordless account has
// no password to base a password proof on) and the fallback factor for
// `change_email` / `delete_account` on passwordless accounts. The backend
// synthesizes the target from the authenticated username, so only `action` is
// sent. Returns `FRESH_AUTH_REDIRECT_PENDING` after starting the full-page
// redirect; callers abort cleanly and resume after the user returns. Throws on
// transport / config / invalid-redirect-host errors.
//
// `isStale` is the orchestrator's teardown predicate (`guard.tornDown`),
// threaded to the redirect helper's pre-navigation re-check: the start
// round-trip is an await a subject teardown can land in, and without the
// re-check the navigation would fire for the subject that left. A stale start
// resolves FRESH_AUTH_CANCELLED without navigating; the flow keys it wrote are
// the subject scrub's to remove (the predicate reads true only after that
// scrub has run), and reporting stays with the caller's guard.
export async function beginSettingsActionOrcidFreshAuth(action, isStale) {
  return beginOrcidFreshAuthRedirect('fresh_auth', { action }, '/settings', isStale);
}

// Initiate an ORCID fresh-auth round-trip for an authorship consent/credit op.
// Sibling of beginSettingsActionOrcidFreshAuth, but the backend binds the proof
// to the paper target (and, for credit ops, the slot/subject), so the full
// target travels in the start `extra` via consentOpRequestFields. The
// `/orcid/callback` handler caches the echoed proof through cacheConsentOpProof
// keyed on that target; withAuthorshipFreshAuth retrieves it post-redirect.
// `isStale` is the same orchestrator teardown predicate the settings sibling
// threads: a stale start resolves FRESH_AUTH_CANCELLED instead of navigating.
export async function beginAuthorshipOrcidFreshAuth(target, isStale) {
  return beginOrcidFreshAuthRedirect('fresh_auth', consentOpRequestFields(target), '/', isStale);
}

// The remintable-401 retry gate shared by the consent-op orchestrators
// (withSettingsFreshAuth and withAuthorshipFreshAuth). Both surfaces broadcast
// a consent_op-kind proof the backend consumes (success or failure) before the
// guarded call runs, so when that call rejects with FRESH_AUTH_REQUIRED any
// retry must mint a fresh proof, and the cached copy is dropped first for the
// same reason. One home for the ladder so the two surfaces cannot drift on
// which failures retry, which redirect, and which are terminal.
//
// Re-mintable reasons (missing/expired/malformed, per REMINTABLE_REASONS)
// retry inline ONLY on the password factor. A KNOWN-ORCID account would need
// a second full-page OAuth redirect near the 5-minute proof TTL (re-OAuth
// loop risk); it surfaces a terminal failure so the user restarts
// deliberately. The one exception is the ASSUMED-password 401 at the retry
// mint: there the 401 is new information (the account has no password), the
// user has just engaged by typing one, and without the redirect the op
// dead-ends — each pass costs a typed password plus a full OAuth round-trip,
// so it cannot tight-loop.
//
// username_mismatch is a corrupted session, not a retryable re-auth failure:
// tear it down and force re-login via the shared teardown, matching the
// session-kind sibling in broadcastWithFreshAuth. The gate keys on
// `err.details.reason`, never on a status code: the error reaching these
// orchestrators is an api.js ApiRequestError carrying only code/details, no
// `status` (unlike the signer.js-shaped session-kind error). 401
// wrong_mechanism and the 403 target/kind mismatches are not fixable by
// re-minting the same factor; they fall through to freshAuthFailed. Errors
// whose code is not FRESH_AUTH_REQUIRED rethrow untouched so callers keep
// their own op-level handling.
//
// The hooks carry the only parts that differ per surface:
//   guard               the caller's subject teardown guard, opened at the
//                       orchestrator's entry so it also covers the guarded
//                       call this gate is reacting to — a guard opened here
//                       would be blind to a teardown that landed during it
//   resolveFactor       the surface's factor resolution (the authorship
//                       orchestrator uses the shared resolver directly; the
//                       settings orchestrator threads its set_password
//                       ORCID-only exception through its `passwordFactorFor`)
//   mint(assumed)       the surface's target-bound password mint
//   beginOrcidRedirect  the surface's ORCID round-trip starter, run under the
//                       caller's guard: on a teardown landing during the
//                       start round-trip it resolves FRESH_AUTH_CANCELLED
//                       (already reported by the guard) instead of navigating
//   run(proof)          the guarded call, retried once with the fresh proof
//   clearProofCache     drops the surface's cached proof (before the retry
//                       mints, and again after a successful retry run)
export async function consentOpFreshAuthRetryGate(err, {
  guard,
  resolveFactor,
  mint,
  beginOrcidRedirect,
  run,
  clearProofCache,
}) {
  if (err?.code !== 'FRESH_AUTH_REQUIRED') throw err;

  // The proof is consumed (success or fail) before the guarded call, so any
  // retry must mint a fresh one. Drop the cache first.
  clearProofCache();

  const remintable = REMINTABLE_REASONS.includes(err.details?.reason);
  if (remintable) {
    const factor = await resolveFactor();
    // Same boundary the orchestrators guard on their initial resolution: the
    // status read is an await, and a teardown landing in it (or earlier, in
    // the guarded call that brought us here) must not be answered with a fresh
    // prompt and a re-mint for the subject that left.
    if (guard.tornDown()) {
      guard.cancel();
      return { cancelled: true };
    }
    if (factor.usesPassword) {
      const retry = await mint(factor.assumed);
      if (retry === FRESH_AUTH_ORCID_FALLBACK) {
        const started = await beginOrcidRedirect();
        // A teardown landing during the start round-trip unwinds the starter
        // without navigating, and the surface's guard has already reported
        // it — so this is the same clean cancel every other teardown boundary
        // resolves to, never a redirect outcome for a navigation that is not
        // happening.
        if (started === FRESH_AUTH_CANCELLED) return { cancelled: true };
        return { redirect: true };
      }
      if (retry === FRESH_AUTH_PROMPT_BUSY) return promptBusy();
      if (retry === FRESH_AUTH_CANCELLED) return { cancelled: true };
      if (retry === FRESH_AUTH_MINT_FAILED) return { freshAuthFailed: true };
      try {
        const ok = await run(retry);
        clearProofCache();
        return { ok };
      } catch (retryErr) {
        // A mismatch surfacing here is the same corrupted session the
        // first-attempt branch below tears down, so it takes the same exit
        // rather than degrading into the retryable freshAuthFailed report.
        if (isUsernameMismatch(retryErr)) {
          handleSessionInconsistency();
          return { sessionInconsistent: true };
        }
        if (retryErr?.code === 'FRESH_AUTH_REQUIRED') return { freshAuthFailed: true };
        throw retryErr;
      }
    }
  }

  if (isUsernameMismatch(err)) {
    handleSessionInconsistency();
    return { sessionInconsistent: true };
  }

  // 401 wrong_mechanism, a 403 target/kind mismatch, or an ORCID-factor proof
  // this gate declines to re-mint inline: surface a generic re-auth failure.
  return { freshAuthFailed: true };
}

// Map a non-string acquisition outcome onto the broadcast call-site contract.
// Every failure to acquire unwinds through the single FRESH_AUTH_REDIRECT_PENDING
// sentinel so the eight broadcast call sites keep their one clean-abort branch
// instead of growing per-outcome handling of their own. The toast (or the
// deliberate silence) per outcome comes from the shared dispatch table, so
// this unwinder cannot drift from the page gate. The reauthRequired outcome
// is load-bearing here for the suppressed broadcast posture: post-upload call
// sites pass `allowRedirect: false` through broadcastWithFreshAuth, so a
// passwordless account whose window died between the pre-broadcast gate and
// the broadcast (or during the 401 retry's re-acquisition) lands here and
// gets the re-authenticate toast instead of a silent drop.
//
// A result the vocabulary does not name classifies to nothing, and a null key
// is what the dispatch keeps silent for a READY outcome, so a bare
// classification refused this one class without a word. The fall-through hands
// it the outcome `ensureSessionWindow`'s fail-closed guard already assigns it,
// `failed`: re-authentication did not complete, which is the one thing the
// user can act on. The class is reachable on every action rather than once —
// `evictUnnamedAcquisition` drops the entry that caused it, so nothing is left
// in the slot for a later reading to inherit the refusal from. A password
// account whose mint keeps answering without a proof string is prompted again
// on the next vote, comment and review, answers correctly again, and is
// refused again. Silence there is a password answered correctly for nothing,
// repeatedly.
//
// A fall-through on the classification rather than a branch, deliberately:
// every registered member still resolves through `acquisitionOutcomeKey`, so
// nothing about their messages or their deliberate silences is restated here,
// and what is not restated cannot drift from the page gate.
function acquisitionAborted(proof) {
  if (typeof proof === 'string') return false;
  showWindowOutcomeToast(acquisitionOutcomeKey(proof) ?? 'failed');
  return true;
}

// High-level wrapper around `broadcastOps`: acquires a session window if one is
// not already open, attaches its proof to the broadcast, and handles the
// FRESH_AUTH_REQUIRED retry / re-login fallout per the custody contract.
//
// Returns the broadcast response on success, or `FRESH_AUTH_REDIRECT_PENDING`
// (null) whenever the window could not be put in hand — an ORCID round-trip in
// flight, a dismissed password modal, a spent re-auth, or a torn-down session.
// Callers treat the null return as "abort cleanly"; any user-facing message has
// already been shown here.
//
// The window is multi-use, so a broadcast that succeeds leaves it cached and
// merely slides its idle deadline. Acquisition is only reached on the first
// action of a window (or the first after one closes), which is what makes a
// burst of votes cost a single re-auth act.
//
// Keychain (self-custody) users skip acquisition entirely; their per-request
// signed canonical message is the fresh proof.
//
// `opts.allowRedirect` (default true) is consumed here, not forwarded to
// broadcastOps: it threads the redirect posture into every acquisition this
// wrapper performs, including the 401 retry's re-acquisition. Post-upload
// call sites (the publish and edit submit sequences) pass `false` so a window
// invalidated server-side after their suppressed pre-broadcast gate passed
// cannot fire the full-page ORCID navigation while completed pins sit in
// submit-handler locals; the vote/comment/review call sites keep the
// permissive default. The suppressed refusal unwinds through
// `acquisitionAborted`'s reauthRequired branch with the re-authenticate toast.
export async function broadcastWithFreshAuth(username, operations, opts = {}) {
  const { allowRedirect = true, ...broadcastOpts } = opts;
  const auth = Alpine.store('auth');
  if (auth?.custody !== 'light') {
    return broadcastOps(username, operations, broadcastOpts);
  }

  // Opened before the first await so it spans both attempts. The acquisition
  // and the broadcast are each a boundary a cross-tab subject change can land
  // in, and every step inside them re-checks the generation for itself — but
  // the 401 retry below starts a NEW acquisition whose own snapshot would
  // post-date such a teardown and so never notice it. This guard is the only
  // cross-attempt memory of which subject the broadcast belongs to.
  const guard = subjectTeardownGuard();

  // One consume of the window: broadcast, then replay the idle slide the
  // backend performed but echoed nothing about. Both the first attempt and the
  // 401 retry go through here so "consume without sliding" — the bug class that
  // lets the client fall behind the server and evict a live token — cannot be
  // reintroduced by editing one branch and not the other.
  //
  // The slide is gated the way the dead-window clear below is: it belongs to
  // this flight's own window only. The window slot is a single unkeyed entry
  // with no subject binding, so once the guard reads torn-down the entry in it
  // was minted by whoever the tab represents next, and re-anchoring its idle
  // deadline on the departed subject's response would extend the successor's
  // window on traffic that was never theirs.
  const attemptOnce = async (windowProof) => {
    const res = await broadcastOps(username, operations, { ...broadcastOpts, freshAuthProof: windowProof });
    if (!guard.tornDown()) slideSessionWindow();
    return res;
  };

  const proof = await acquireSessionProof(0, { allowRedirect });
  if (acquisitionAborted(proof)) return FRESH_AUTH_REDIRECT_PENDING;

  try {
    return await attemptOnce(proof);
  } catch (err) {
    // Error shape `{ status, code, details }` is produced by signer.js#broadcastOps
    // (see frontend/src/signer.js — the non-2xx branch parses the JSON envelope
    // and rethrows). Keep this catch's branching aligned with the codes that
    // helper attaches; any new error code introduced upstream must be reflected
    // here.
    if (err?.code === 'FRESH_AUTH_REQUIRED') {
      // A 401 against a window proof means the window is genuinely closed — the
      // idle deadline or the absolute cap arrived, or a password reset or
      // account recovery ended every outstanding proof. That is not a spent
      // single-use token to be re-minted behind the user's back: drop the dead
      // window and put a real re-auth act in front of them.
      //
      // Only this flight's own window is ours to drop. The generation moves
      // solely inside the subject scrub, which evicts the window slot in the
      // same synchronous block BEFORE it bumps — so a torn-down flight's own
      // window is already gone, and whatever sits in the cache now was minted
      // by whoever the tab represents next. Evicting that would charge the
      // successor a re-auth for a rejection that was never theirs. The
      // mismatch arm below is unaffected either way: its
      // `handleSessionInconsistency` disconnect runs the same scrub again.
      if (!guard.tornDown()) clearCachedSessionProof();

      if (
        err.status === 401 &&
        REMINTABLE_REASONS.includes(err.details?.reason)
      ) {
        // A teardown that landed since this wrapper began outranks the retry:
        // the re-acquisition reads the store at call time, so past a subject
        // change it would prompt the NEW subject with the generic re-auth
        // message, spend their mint, and broadcast the departed subject's
        // operations under their name. Report the teardown once and take the
        // same silent abort every other non-ready outcome unwinds through.
        if (guard.tornDown()) {
          guard.cancel();
          return FRESH_AUTH_REDIRECT_PENDING;
        }
        // Normalize any error thrown by the re-acquisition or the retry
        // broadcastOps to the `{ status, code, details }` shape callers expect.
        // Without this wrap, a network failure during re-auth surfaces with
        // `TypeError: Failed to fetch` (or a startOrcid error envelope) instead
        // of the original FRESH_AUTH_REQUIRED context, so call-site
        // discriminators (publish.js, vote-buttons.js, vouch-section.js)
        // misclassify the failure and surface the wrong toast.
        try {
          // The re-acquisition inherits the caller's redirect posture: a
          // suppressed call site's retry must refuse (reauthRequired toast)
          // rather than navigate, exactly like its initial acquisition.
          const reacquired = await acquireSessionProof(0, { allowRedirect });
          if (acquisitionAborted(reacquired)) return FRESH_AUTH_REDIRECT_PENDING;
          return await attemptOnce(reacquired);
        } catch (retryErr) {
          // A mismatch surfacing on the retry is the same corrupted session
          // the first-attempt branch below tears down, so it takes the same
          // exit. This has to sit ahead of both the shape-preserving rethrow
          // and the wrap: the rethrow's predicate already matches it (a
          // signer.js-shaped 403 has both `status` and `code`), and the wrap
          // replaces `details` with a `cause` string, destroying the reason a
          // later branch would need.
          if (isUsernameMismatch(retryErr)) {
            handleSessionInconsistency();
            return FRESH_AUTH_REDIRECT_PENDING;
          }
          // Preserve the shape if the retry's own error already follows the
          // contract (i.e., another FRESH_AUTH_REQUIRED or any signer.js-shaped
          // error). Otherwise wrap into a synthesized 0/UNKNOWN shape that
          // callers can still inspect without crashing on `.details`.
          if (retryErr && typeof retryErr.status === 'number' && retryErr.code) {
            throw retryErr;
          }
          const wrapped = new Error(retryErr?.message || 'fresh-auth retry failed');
          wrapped.status = 0;
          wrapped.code = 'FRESH_AUTH_RETRY_FAILED';
          wrapped.details = { cause: retryErr?.message || String(retryErr) };
          throw wrapped;
        }
      }

      // username_mismatch → JWT subject and proof subject diverge. Critical
      // session inconsistency; force re-login via the shared teardown
      // (disconnect + re-login toast). The reason is the discriminator, via
      // the shared predicate the retry leg above uses, so the two legs cannot
      // drift; the 403 the session-kind error also carries (signer.js shapes
      // it) is a property of the wire shape, not a second condition.
      if (isUsernameMismatch(err)) {
        handleSessionInconsistency();
        return FRESH_AUTH_REDIRECT_PENDING;
      }

      // 403 kind_mismatch on the non-consent surface is structurally
      // impossible (this surface accepts both kinds). Treat as a wire-contract
      // regression and log for diagnostics; surface as a generic error.
      if (err.status === 403 && err.details?.reason === 'kind_mismatch') {
        console.warn('[fresh-auth] unexpected kind_mismatch on non-consent broadcast', err);
      }
    }
    throw err;
  }
}
