/**
 * Fresh-auth challenge primitive for sensitive custody-endpoint operations.
 *
 * Purpose
 * -------
 * `author_accept` and `author_resign` consent ops, and the name-only-route
 * credit ops `claim_authorship` / `approve_authorship` / `revoke_authorship`,
 * are reputationally weighty (the broadcast event is permanently attributed
 * on chain, and the credit ops mint or revoke authorship credit). ARCH.md
 * "Light-account signing of consent ops" and § 6.4's critical-action contract
 * require the backend to demand a per-op fresh authentication challenge
 * appropriate to the user's auth mechanism: a password re-prompt for
 * password-based accounts, a fresh ORCID OAuth round-trip for ORCID-authed
 * accounts.
 *
 * Wire shape
 * ----------
 * Token: 32-byte hex string, opaque to clients. Stored at
 * `${appTag}:fresh_auth:token:${token}` (Redis when available;
 * in-memory fallback). The key prefix is kind-neutral — both
 * consent-op-kind and session-kind entries share it, discriminated by
 * the `kind` field inside the stored JSON value (not by key namespace).
 * TTL: `FRESH_AUTH_TTL_SECONDS` (5 min). Stored value:
 * `{ username, mechanism, issued_at }` JSON. Consumption is single-use via
 * Redis `GETDEL` (or `delete()` on the in-memory map).
 *
 * Binding
 * -------
 * - The token is bound to the **issuing username** at mint time. Consume
 *   verifies the JWT subject equals the stored username; cross-account
 *   replay is rejected at the route layer.
 * - `mechanism` is an informational discriminator carried into
 *   `custody_audit_log.auth_mechanism`; it is NOT used as a security
 *   predicate. The security primitives are token secrecy + single-use +
 *   username binding + TTL.
 *
 * Issuance paths (route-layer; this module is the storage primitive)
 * ------------------------------------------------------------------
 * - Password mechanism: `POST /api/custody/fresh-auth` accepts a password,
 *   argon2-verifies against `accounts.password_hash`, then calls
 *   `issueFreshAuthToken(username, 'password')`.
 * - ORCID mechanism: ORCID callback in `mode: 'fresh_auth'` verifies the
 *   OAuth-returned `orcid_id` equals `account.orcid`, then calls
 *   `issueFreshAuthToken(username, 'orcid')`.
 *
 * Consume path
 * ------------
 * `POST /api/custody/broadcast` for any operation whose payload action is
 * in `CONSENT_OP_ACTIONS` or `CREDIT_OP_ACTIONS` requires `fresh_auth_proof`
 * in the request body. The handler computes the expected target hash from
 * the op's fields, calls `consumeFreshAuthToken(token, jwtSubject,
 * expectedTargetHash)`, and rejects the broadcast on any non-`valid` outcome
 * before signing.
 *
 * Spec
 * ----
 * `agents/docs/ARCHITECTURE.md` section 2 "Light-account signing of consent
 * ops".
 */

import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { logger } from '../logger.js';
import { sendError } from '../response.js';
import { requireStringField } from './body-record.js';
import { HIVE_PERMLINK_MAX_LEN } from './hive-permlink.js';

/** Single source of truth for the anchored-route consent-op action set. The
 *  runtime Set (`CONSENT_OP_ACTIONS`) AND the compile-time union
 *  (`ConsentOpAction`) both derive from this one `as const` tuple, so a member
 *  added here lands in both at once — a new action can never be present in the
 *  Set but absent from the union (the divergence that an `as ConsentOpAction`
 *  cast at a call site would silently route through, ungated/mis-targeted). */
const CONSENT_OP_ACTION_TUPLE = ['author_accept', 'author_resign'] as const;
export type ConsentOpAction = (typeof CONSENT_OP_ACTION_TUPLE)[number];

/** Set of `custom_json` payload actions that require a fresh-auth proof.
 *  Holds ONLY the anchored-route consent ops. The name-only-route credit ops
 *  (`claim_authorship` / `approve_authorship` / `revoke_authorship`) are NOT
 *  members — they have a distinct payload shape (`paper_author` /
 *  `paper_permlink` / `author_index`, not `root_author` / `root_permlink`)
 *  and live in `CREDIT_OP_ACTIONS` below. Both sets feed the same broadcast
 *  fresh-auth gate but via separate field-extraction paths. Typed
 *  `ReadonlySet<string>` (not `ReadonlySet<ConsentOpAction>`) so a raw wire
 *  `action: string` can be membership-tested without a nominal-element cast;
 *  the narrowing to `ConsentOpAction` is what `isConsentOpAction` provides. */
export const CONSENT_OP_ACTIONS: ReadonlySet<string> = new Set(CONSENT_OP_ACTION_TUPLE);

/** Narrows a raw wire `action` string to `ConsentOpAction` via Set membership.
 *  Lets the gated-op scan drop the unsound `action as ConsentOpAction` cast at
 *  the call site — the narrowing is validated by the runtime `.has`. */
export function isConsentOpAction(action: string): action is ConsentOpAction {
  return CONSENT_OP_ACTIONS.has(action);
}

/** Single source of truth for the name-only-route credit-op action set, same
 *  Set+union derivation as the consent tuple above. These are reputation-
 *  weighty, identity-binding ops (they mint or revoke authorship credit), so a
 *  stolen JWT alone must not be able to broadcast them per
 *  `agents/docs/ARCHITECTURE.md` § 6.5 invariant #1. Their target binds
 *  `(action, paper_author, paper_permlink)` plus the op-specific fields the
 *  wire carries (`agents/docs/hive-schemas.md` § 2.9–§ 2.11):
 *  - `claim_authorship` — `author_index` (signer claims their own slot).
 *  - `approve_authorship` — `author_index` AND `claimer` (the other account
 *    being credited at that slot).
 *  - `revoke_authorship` — `claimer` (the account being stripped); no
 *    `author_index` on the wire.
 *  Binding `claimer` on approve/revoke prevents a minted proof being redirected
 *  to credit or strip a DIFFERENT co-author. Kept separate from
 *  `CONSENT_OP_ACTIONS` because the consent ops and credit ops use different
 *  payload field names. */
const CREDIT_OP_ACTION_TUPLE = ['claim_authorship', 'approve_authorship', 'revoke_authorship'] as const;

/** Action subset for the name-only-route credit ops, derived from
 *  {@link CREDIT_OP_ACTION_TUPLE} so the union and the Set cannot diverge.
 *  The target-builder (`creditOpFreshAuthTarget`), the shared field validator
 *  (`extractCreditOpFields`), and the route-layer scan all type their `action`
 *  param to this union so a 4th member added to the tuple becomes a compile
 *  error at the unhandled branch rather than an ungated/mis-targeted op. */
export type CreditOpAction = (typeof CREDIT_OP_ACTION_TUPLE)[number];

/** Set of `custom_json` payload actions for the name-only-route credit ops
 *  that require a per-target fresh-auth proof on custody broadcast. Typed
 *  `ReadonlySet<string>` for the same raw-`action` membership-test ergonomics
 *  as `CONSENT_OP_ACTIONS`; `isCreditOpAction` does the narrowing. */
export const CREDIT_OP_ACTIONS: ReadonlySet<string> = new Set(CREDIT_OP_ACTION_TUPLE);

/** Narrows a raw wire `action` string to `CreditOpAction` via Set membership.
 *  Lets the gated-op scan drop the unsound `action as CreditOpAction` cast. */
export function isCreditOpAction(action: string): action is CreditOpAction {
  return CREDIT_OP_ACTIONS.has(action);
}

/** Single source of truth for the admin-authority-action fresh-auth target set,
 *  same Set+union derivation as the consent/credit tuples above. These name the
 *  roster-gated `/api/admin/*` critical actions: a member of the admin roster
 *  triggers the backend to broadcast an authority op signed by the single
 *  `pevo.admin` key. Per `agents/docs/ARCHITECTURE.md` § 6.4 (admin-authority
 *  row) / § 6.5 invariant #1, the roster-level check is necessary but NOT
 *  sufficient — each action ALSO demands a fresh re-auth proof so a stolen admin
 *  JWT cannot broadcast authority ops in one step. Unlike the credit ops these
 *  bind only `(action, <acting-admin-username>, '')` (per-actor, not per-subject)
 *  — the same per-user binding the non-broadcast criticals (`set_password` /
 *  `change_email` / `delete_account` / `ipfs_upload`) use; the distinct `action`
 *  value is what stops a proof minted for one admin action being redirected to
 *  another under one JWT. `admin_sanction` is the authority-sanction action (a
 *  `revoke` carrying `type:"sanction"`); adding the member here is all that is
 *  needed (the generic builder and the generic issuance branch handle any
 *  member). */
const ADMIN_FRESH_AUTH_ACTION_TUPLE = [
  'admin_grant_role',
  'admin_revoke_role',
  'admin_grant_accreditation',
  'admin_retract_paper',
  'admin_revoke_authorship',
  'admin_approve_authorship',
  'admin_sanction',
] as const;

/** Action subset for the roster-gated admin authority actions, derived from
 *  {@link ADMIN_FRESH_AUTH_ACTION_TUPLE} so the union and the Set cannot
 *  diverge. The generic target-builder (`adminActionFreshAuthTarget`) and both
 *  issuance routes type their `action` param to this union. */
export type AdminFreshAuthTargetAction = (typeof ADMIN_FRESH_AUTH_ACTION_TUPLE)[number];

/** Set of admin authority actions that require a per-actor fresh-auth proof.
 *  Typed `ReadonlySet<string>` for raw-`action` membership-test ergonomics;
 *  `isAdminFreshAuthAction` does the narrowing. */
export const ADMIN_FRESH_AUTH_ACTIONS: ReadonlySet<string> = new Set(ADMIN_FRESH_AUTH_ACTION_TUPLE);

/** Narrows a raw wire `action` string to `AdminFreshAuthTargetAction` via Set
 *  membership, so both issuance paths can mint an admin-action proof from a
 *  validated body action without an unsound cast. */
export function isAdminFreshAuthAction(action: string): action is AdminFreshAuthTargetAction {
  return ADMIN_FRESH_AUTH_ACTIONS.has(action);
}

/** Per-user (non-paper) critical actions BOTH fresh-auth issuance paths accept.
 *  `set_password` is deliberately excluded here — it is ORCID-mechanism-only (a
 *  passwordless account has no password to mint a password-mechanism proof), so
 *  `validFreshAuthActionsMessage` folds it in only for the ORCID path. */
const PER_USER_CRITICAL_ACTION_TUPLE = [
  'change_email',
  'delete_account',
  'ipfs_upload',
  'edit_accreditation_metadata',
] as const;

/** Canonical "action must be one of: ..." 400 string for the fresh-auth issuance
 *  routes, DERIVED from the action tuples (consent / credit / per-user-critical /
 *  admin) so a new tuple member (e.g. `admin_sanction`) propagates to every
 *  issuance route's error copy without a hand-edit. The ORCID path additionally
 *  mints `set_password`; the password (custody) path does not. */
export function validFreshAuthActionsMessage(opts: { includeSetPassword: boolean }): string {
  const actions = [
    ...CONSENT_OP_ACTION_TUPLE,
    ...CREDIT_OP_ACTION_TUPLE,
    ...(opts.includeSetPassword ? (['set_password'] as const) : []),
    ...PER_USER_CRITICAL_ACTION_TUPLE,
    ...ADMIN_FRESH_AUTH_ACTION_TUPLE,
  ];
  return `action must be one of: ${actions.join(', ')}`;
}

export type FreshAuthMechanism = 'password' | 'orcid';

/** Action component of the per-op target binding. The fresh-auth proof
 *  binds to the (action, root_author, root_permlink) triple of the op being
 *  authorized. Without this binding, a compromised SPA could swap
 *  action/target between the user's authentication ceremony and the route
 *  that consumes the proof ("substitute author_resign on paper Y for the
 *  author_accept on paper X the user thought they authorized").
 *
 *  Two sub-patterns share this union:
 *
 *  - **Consent-op actions (broadcast):** `author_accept` and `author_resign`
 *    bind to `(action, <paper root_author>, <paper root_permlink>)`. These
 *    actions issue a `custom_json` op on chain (see `CONSENT_OP_ACTIONS`
 *    above), and the `root_*` fields come from the paper being acted on.
 *
 *  - **Credit-op actions (broadcast):** `claim_authorship`,
 *    `approve_authorship`, and `revoke_authorship` bind to
 *    `(action, <paper_author>, <paper_permlink>)` plus op-specific fields.
 *    These name-only-route ops issue a `custom_json` on chain (see
 *    `CREDIT_OP_ACTIONS` above); the paper fields map onto `root_author` /
 *    `root_permlink`, the slot index onto `author_index`, and the credited /
 *    stripped account onto `claimer`. `claim_authorship` binds `author_index`
 *    (the signer claims their own slot, no `claimer` on the wire);
 *    `approve_authorship` binds `author_index` AND `claimer`;
 *    `revoke_authorship` binds `claimer` only (no `author_index` on the wire,
 *    see `agents/docs/hive-schemas.md` § 2.11). Binding `claimer` on
 *    approve/revoke stops a minted proof being redirected to a DIFFERENT
 *    co-author at the same slot.
 *
 *  - **Non-broadcast critical actions:** `set_password`, `change_email`,
 *    `delete_account`, and `ipfs_upload` bind to
 *    `(action, <authenticated username>, '')` via per-action helpers below
 *    (`setPasswordFreshAuthTarget`, `changeEmailFreshAuthTarget`,
 *    `deleteAccountFreshAuthTarget`, `ipfsUploadFreshAuthTarget`).
 *    Empty `root_permlink` is collision-free against consent-op proofs
 *    because the route layer for consent ops forbids empty `root_permlink`
 *    strings. `set_password` transitions state C → state B per
 *    ARCHITECTURE.md § 6.3 and requires fresh ORCID re-auth per § 6.4;
 *    `change_email` transitions the address that receives password-reset
 *    tokens (auth-adjacent factor), so the JWT-only path is closed via a
 *    body-proof check per § 6.5 invariant #1; `delete_account` erases the
 *    account row (the de-facto right-to-erasure exit, A/B/C/D → [no row] per
 *    § 6.3) and so is likewise a critical action gated per § 6.4;
 *    `ipfs_upload` authorizes a `POST /api/ipfs/upload-token` mint (which lets
 *    the holder pin content under their account — illegal-content-liability
 *    stakes), so the JWT path binds a per-action proof rather than accepting
 *    a target-less session proof, closing the cross-surface session-proof
 *    redirect per § 6.5 invariant #1.
 *
 *  Collision-freedom across the union hinges on the `action` field in
 *  `computeFreshAuthTargetHash`: even two non-broadcast actions that share
 *  the same `(<username>, '')` tail produce distinct target hashes because
 *  `action` is length-prefixed into the encoded bytes. This is the property
 *  that stops a proof minted for one action (e.g. `change_email`) being
 *  replayed against another (e.g. `delete_account`). */
export type FreshAuthTargetAction =
  | ConsentOpAction
  | CreditOpAction
  | AdminFreshAuthTargetAction
  | 'set_password'
  | 'change_email'
  | 'delete_account'
  | 'ipfs_upload'
  | 'edit_accreditation_metadata';

/** Shape of the per-op target the fresh-auth proof binds to. The fields are
 *  reduced to a SHA-256 hash at issuance time via `computeFreshAuthTargetHash`.
 *  The hash, not the cleartext fields, is what's stored in the entry — the
 *  hash domain-separates from any other fields that may share the same
 *  underlying string-concat shape. */
export interface FreshAuthTarget {
  action: FreshAuthTargetAction;
  root_author: string;
  root_permlink: string;
  /** Slot index for the name-only-route credit ops (`claim_authorship` /
   *  `approve_authorship`). Zero-based index into the paper's `authors[]`
   *  identifying the slot the credit op acts on. Folded into the target hash
   *  so a stolen JWT cannot substitute a different slot under one proof.
   *  Omitted for every other action (consent ops, the non-broadcast
   *  criticals, and `revoke_authorship`, whose wire payload carries no
   *  `author_index` per `agents/docs/hive-schemas.md` § 2.11). When omitted,
   *  the hash is identical to the pre-`author_index` encoding, so existing
   *  consent-op and non-broadcast-critical proofs are unchanged. */
  author_index?: number;
  /** Credited/stripped account for the name-only-route credit ops that act on
   *  a co-author OTHER than the broadcasting signer: `approve_authorship` and
   *  `revoke_authorship` both carry a `claimer` on the wire (`hive-schemas.md`
   *  § 2.10 / § 2.11) naming the account whose credit the op binds or strips.
   *  WITHOUT folding `claimer` into the hash, a minted approve/revoke proof for
   *  `(action, paper_author, paper_permlink, author_index)` could be redirected
   *  by a compromised SPA to credit or strip a DIFFERENT co-author at the same
   *  slot — the exact substitution this binding exists to defeat
   *  (`agents/docs/ARCHITECTURE.md` § 6.4 credit-op row, § 6.5 invariant #1).
   *  `claim_authorship` carries no `claimer` (the claimer IS the signer, already
   *  pinned by the consume-side username check), so its target omits this field;
   *  consent ops and the non-broadcast criticals omit it too. When omitted, the
   *  hash is identical to the pre-`claimer` encoding, so existing proofs that
   *  never carry it are unchanged. */
  claimer?: string;
}

/** Helper that builds the canonical `FreshAuthTarget` for the `/set-password`
 *  flow. The target binds the proof to the username so a proof minted for
 *  user A cannot authorize a set-password on user B (the
 *  `consumeFreshAuthToken` username check already enforces this; the target
 *  binding is a defense-in-depth fold that also kills swap-of-action
 *  substitution attacks at the consume side). `root_permlink` is
 *  intentionally empty: no paper is involved in set-password, and the route
 *  layer for consent ops forbids empty `root_permlink` strings, so this
 *  hash cannot collide with any consent-op proof. */
export function setPasswordFreshAuthTarget(username: string): FreshAuthTarget {
  return {
    action: 'set_password',
    root_author: username,
    root_permlink: '',
  };
}

/** Helper that builds the canonical `FreshAuthTarget` for the self-service
 *  accreditation-metadata edit (`PATCH /api/accreditation/metadata`). Same
 *  per-user `(action, <username>, '')` shape as the other non-paper criticals:
 *  it binds the proof to the editing account so a proof minted for user A cannot
 *  re-broadcast an accredit op for user B, and the distinct `action` value stops
 *  a proof minted for another action being redirected here. Unlike the admin
 *  authority ops this is NOT roster-gated — authorization is the caller's own
 *  current accreditation; the op is admin-key-signed but human-authorized by the
 *  account owner editing their own profile (ARCHITECTURE.md § 6.4). */
export function editAccreditationMetadataFreshAuthTarget(username: string): FreshAuthTarget {
  return {
    action: 'edit_accreditation_metadata',
    root_author: username,
    root_permlink: '',
  };
}

/** Type-guard for the storage `mechanism` field. The membership test diverges
 *  from the `FreshAuthMechanism` union if the union grows and the test isn't
 *  updated; consolidating it here means a single point of maintenance. Used by
 *  `consumeFreshAuthToken` to narrow `unknown` from `JSON.parse` into the typed
 *  `FreshAuthMechanism`. */
export function isFreshAuthMechanism(value: unknown): value is FreshAuthMechanism {
  return value === 'password' || value === 'orcid';
}

/** Token TTL in seconds. 5 minutes — bounded enough to limit replay risk
 *  if the token leaks, generous enough for a "re-auth then broadcast" UX
 *  without forcing the user to re-prompt mid-flow.
 *
 *  Kept exported for tests: the in-memory TTL-expiry fake-timer test in
 *  `tests/lib/fresh-auth.test.ts` advances `Date.now()` past this boundary. */
export const FRESH_AUTH_TTL_SECONDS = 300;

const TOKEN_BYTES = 32;
// Kind-neutral key prefix. Both consent-op-kind (issueFreshAuthToken) and
// session-kind (issueSessionFreshAuthToken) entries share this single
// namespace; discrimination is by the `kind` JSON field inside the stored
// value, not by key namespace.
const KEY_PREFIX = `${config.appTag}:fresh_auth:token:`;

/** Discriminates per-op consent proofs (target-bound) from session-level
 *  broadcast proofs (target-less). State C ORCID-only accounts have no
 *  per-op target to bind a consent-op-kind proof to; session-kind closes
 *  the JWT-only takeover gap per ARCH.md § 6.5 invariant #1. */
export type FreshAuthKind = 'consent_op' | 'session';

interface StoredEntry {
  username: string;
  mechanism: FreshAuthMechanism;
  /** Epoch ms. Informational; expiry is enforced by Redis EX / map cleanup. */
  issued_at: number;
  /** Discriminator: `'consent_op'` (default, target-bound) or `'session'`
   *  (target-less session proof for non-consent broadcast). Stored entries
   *  predating this field are treated as `'consent_op'` on consume so the
   *  consume-side bind check still fires (closed-default). */
  kind: FreshAuthKind;
  /** SHA-256 hex of the per-op target under a length-prefixed encoding (see
   *  `computeFreshAuthTargetHash`). The consume side recomputes the hash from
   *  the bundle's gated-op fields and rejects on mismatch. Stored as hex (64
   *  chars) for JSON-safety.
   *
   *  Optional only when `kind === 'session'` — session-kind proofs are not
   *  bound to a per-op target. Consent-op-kind entries MUST carry a
   *  well-shaped hash; absence is malformed-on-consume. */
  target_hash?: string;
}

/**
 * Compute the per-op target hash. The bind is over a length-prefixed encoding
 * of the per-op target fields: the base three (`action`, `root_author`,
 * `root_permlink`) present for every action, plus — for the name-only-route
 * credit ops — the optional `author_index` and/or `claimer`, appended only
 * when present (see the optional-field section below). The base-three core is:
 *
 *   `<len(action)>|<action>|<len(root_author)>|<root_author>|<len(root_permlink)>|<root_permlink>`
 *
 * Length-prefixing is collision-free for arbitrary string content: any
 * two distinct field sequences produce distinct encodings even if individual
 * field values share substrings or contain the '|' separator. A naive
 * pipe-only delimiter (`a|b|c`) collides for `(a='x|y', b='c')` vs
 * `(a='x', b='y|c')`. Hive permlinks today are restricted to lowercase
 * alphanumerics and hyphens so '|' cannot appear in practice, but the
 * encoder defends against that constraint relaxing in the future and
 * makes the binding contract self-evidently correct under any string
 * input rather than relying on an external invariant.
 *
 * The two optional credit-op fields are appended ONLY when present, each in
 * the same length-prefixed form, in a FIXED order (`author_index` then
 * `claimer`). When both are absent the encoding is byte-identical to the
 * original triple form, so consent-op and non-broadcast-critical proofs that
 * never carry them hash to the same value as before either field existed.
 *
 * - `author_index` (name-only-route credit ops `claim_authorship` /
 *   `approve_authorship`) is appended as a string-ified integer. An absent
 *   index and an index of any value produce distinct encodings (the absent
 *   form has no segment at all), so a `revoke_authorship` proof cannot be
 *   replayed against a `claim_authorship` op on the same paper.
 * - `claimer` (`approve_authorship` / `revoke_authorship`) names the credited
 *   or stripped co-author. Folding it in is what stops a minted approve/revoke
 *   proof from being redirected to a DIFFERENT co-author at the same slot. The
 *   fixed `author_index`-before-`claimer` order keeps the encoding unambiguous
 *   even though `revoke_authorship` carries `claimer` but no `author_index`:
 *   its encoding has the index segment absent and the claimer segment present,
 *   distinct from any `approve_authorship` encoding (which carries both).
 */
export function computeFreshAuthTargetHash(target: FreshAuthTarget): string {
  let concat =
    `${target.action.length}|${target.action}|` +
    `${target.root_author.length}|${target.root_author}|` +
    `${target.root_permlink.length}|${target.root_permlink}`;
  if (target.author_index !== undefined) {
    const idx = String(target.author_index);
    concat += `|${idx.length}|${idx}`;
  }
  if (target.claimer !== undefined) {
    concat += `|${target.claimer.length}|${target.claimer}`;
  }
  return crypto.createHash('sha256').update(concat).digest('hex');
}

/** Type-guard for the `target_hash` field on the stored entry. A stored entry
 *  written before per-op target binding existed (no `target_hash` field) MUST
 *  be rejected on consume — closed-default policy. The membership check is
 *  structural: hex-string of length 64. */
function isValidTargetHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** Type guard for the storage `kind` field. Legacy entries (written before
 *  the kind discriminator landed) do not carry the field — those are
 *  treated as `'consent_op'` on consume so the target-bind check still
 *  fires (closed-default for the original security property). */
function isFreshAuthKind(value: unknown): value is FreshAuthKind {
  return value === 'consent_op' || value === 'session';
}

/** Target-binding helper for the `change_email` critical action.
 *  Change-email is a per-user (not per-broadcast) critical action — it
 *  transitions the address that receives password-reset tokens, which
 *  gates password rotation. The proof binds to `(change_email, <username>,
 *  '')`; `root_permlink` is empty so the same target-hash domain stays
 *  collision-free against consent-op proofs (which require non-empty
 *  `root_permlink` at the route layer). Used by `routes/settings.ts` POST
 *  `/email` on the change-email branch; the production issuance side
 *  (orcid `/start` + custody `/fresh-auth` action widening) is tracked
 *  separately as a follow-up. */
export function changeEmailFreshAuthTarget(username: string): FreshAuthTarget {
  return { action: 'change_email', root_author: username, root_permlink: '' };
}

/** Target-binding helper for the `delete_account` critical action.
 *  Account deletion is the de-facto right-to-erasure exit — the route runs
 *  `DELETE FROM accounts WHERE username = $1` plus related deletes and
 *  anonymizes the audit log, transitioning A/B/C/D to the no-row state. Like
 *  `change_email` it is per-user (not per-broadcast), so the proof binds to
 *  `(delete_account, <username>, '')`; `root_permlink` is empty so the
 *  target-hash domain stays collision-free against consent-op proofs (which
 *  require non-empty `root_permlink` at the route layer). The distinct
 *  `action` value is load-bearing: it prevents a proof minted for
 *  `change_email` or `set_password` (which share the `(<username>, '')` tail)
 *  from authorizing an account erasure. Used by `routes/settings.ts` DELETE
 *  `/email`; the issuance side widens `POST /api/custody/fresh-auth`
 *  (password) and `POST /api/orcid/start { mode: 'fresh_auth' }` (ORCID). */
export function deleteAccountFreshAuthTarget(username: string): FreshAuthTarget {
  return { action: 'delete_account', root_author: username, root_permlink: '' };
}

/** Target-binding helper for the `ipfs_upload` critical action.
 *  Issuing an IPFS upload token (`POST /api/ipfs/upload-token`) lets the holder
 *  pin arbitrary content under their account — an illegal-content-liability
 *  surface — so the JWT path binds a per-action proof instead of accepting a
 *  target-less session proof. Like the other non-broadcast criticals it is
 *  per-user (not per-paper): the proof binds to `(ipfs_upload, <username>, '')`;
 *  empty `root_permlink` keeps the target-hash domain collision-free against
 *  consent-op proofs (which require non-empty `root_permlink` at the route
 *  layer). The distinct `action` value is load-bearing: it is what stops a
 *  vote/comment SESSION proof, or a consent-op proof minted for a different
 *  action, from being redirected to `/upload-token` under a stolen JWT (a
 *  session proof fails the consent-op `kind` check; a wrong-action consent-op
 *  proof fails the target-hash compare). Issuance side: `POST
 *  /api/custody/fresh-auth { action: 'ipfs_upload' }` (password) and `POST
 *  /api/orcid/start { mode: 'fresh_auth', action: 'ipfs_upload' }` (ORCID). */
export function ipfsUploadFreshAuthTarget(username: string): FreshAuthTarget {
  return { action: 'ipfs_upload', root_author: username, root_permlink: '' };
}

/** Target-binding helper for the roster-gated admin authority actions
 *  (`/api/admin/*`). Like the non-broadcast criticals it is per-actor, not
 *  per-paper: the proof binds to `(<action>, <acting-admin-username>, '')`, so a
 *  proof minted for one admin action by one admin cannot be redirected to a
 *  different admin action or replayed as a different admin under one JWT (the
 *  length-prefixed `action` and the consume-side username check enforce both).
 *  Empty `root_permlink` keeps the hash domain collision-free against consent-op
 *  proofs (which require a non-empty `root_permlink` at the route layer). One
 *  generic builder serves every admin action so a new member added to
 *  {@link ADMIN_FRESH_AUTH_ACTION_TUPLE} needs no new builder. Issuance side:
 *  `POST /api/custody/fresh-auth { action }` (password) and `POST
 *  /api/orcid/start { mode: 'fresh_auth', action }` (ORCID). */
export function adminActionFreshAuthTarget(
  action: AdminFreshAuthTargetAction,
  username: string,
): FreshAuthTarget {
  return { action, root_author: username, root_permlink: '' };
}

/** Per-op field shape for the three name-only-route credit ops, expressed so
 *  the type system pins which wire fields each op carries (`hive-schemas.md`
 *  § 2.9–§ 2.11):
 *
 *  - `claim_authorship` — `author_index` (the slot the signer claims for
 *    THEMSELVES); NO `claimer` (the claimer IS the signer, already bound by the
 *    consume-side username check).
 *  - `approve_authorship` — `author_index` (the slot) AND `claimer` (the OTHER
 *    account being credited at that slot).
 *  - `revoke_authorship` — `claimer` (the account being stripped); NO
 *    `author_index` on the wire.
 *
 *  This discriminated shape is the single source of truth the builder, the
 *  broadcast scan, and both issuance routes agree on, so a caller cannot omit
 *  `claimer` on approve/revoke (the binding the security gate depends on) or
 *  supply it on claim (which would diverge the hash from the wire payload). */
export type CreditOpTargetFields =
  | { action: 'claim_authorship'; paperAuthor: string; paperPermlink: string; authorIndex: number }
  | { action: 'approve_authorship'; paperAuthor: string; paperPermlink: string; authorIndex: number; claimer: string }
  | { action: 'revoke_authorship'; paperAuthor: string; paperPermlink: string; claimer: string };

/** Target-binding helper for the name-only-route credit ops. The proof binds
 *  to `(action, paper_author, paper_permlink)` plus the op-specific fields:
 *  `author_index` for claim/approve and `claimer` for approve/revoke. The paper
 *  fields map onto `root_author` / `root_permlink` (the same hash slots the
 *  consent ops use). Binding `claimer` on approve/revoke is the defense against
 *  redirecting a minted proof to a different co-author at the same slot
 *  (`agents/docs/ARCHITECTURE.md` § 6.4 credit-op row). Both issuance routes
 *  and the broadcast consume side build the target through this single helper
 *  so the two sides cannot diverge on the encoding. */
export function creditOpFreshAuthTarget(fields: CreditOpTargetFields): FreshAuthTarget {
  if (fields.action === 'claim_authorship') {
    return {
      action: fields.action,
      root_author: fields.paperAuthor,
      root_permlink: fields.paperPermlink,
      author_index: fields.authorIndex,
    };
  }
  if (fields.action === 'approve_authorship') {
    return {
      action: fields.action,
      root_author: fields.paperAuthor,
      root_permlink: fields.paperPermlink,
      author_index: fields.authorIndex,
      claimer: fields.claimer,
    };
  }
  // revoke_authorship: claimer bound, no author_index on the wire.
  return {
    action: fields.action,
    root_author: fields.paperAuthor,
    root_permlink: fields.paperPermlink,
    claimer: fields.claimer,
  };
}

/** Length cap for the Hive-account-name fields a credit op carries
 *  (`paper_author`, `claimer`). Hive account names are at most 16 chars; 64 is
 *  a conservative ceiling that absorbs the route body-parser limit without ever
 *  materializing oversized attacker input into the stored target hash. Shared
 *  across every credit-op field read so issuance and consume cannot diverge on
 *  the cap. Exported so the custody pre-limiter's credit-op shape check caps
 *  with the same authoritative constant as the extractor it fronts. */
export const CREDIT_OP_ACCOUNT_MAX_LEN = 64;

/** Discriminated result of normalizing a credit op's wire fields from a source
 *  record. The `ok` arm carries the typed {@link CreditOpTargetFields} ready
 *  for `creditOpFreshAuthTarget`; the failure arm names the missing or
 *  ill-typed field so the route can reject with a 400 that points at it. */
export type CreditOpFieldExtraction =
  | { ok: true; fields: CreditOpTargetFields }
  | { ok: false; field: string };

/** Non-negative-integer reader for the numeric `author_index` wire field.
 *  Separate from {@link requireStringField} because the index is a number on
 *  the wire, not a string. */
function readCreditOpAuthorIndex(
  source: Record<string, unknown>,
): { ok: true; value: number } | { ok: false } {
  const raw = source.author_index;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return { ok: false };
  return { ok: true, value: raw };
}

/** Normalize + validate the wire fields of a name-only-route credit op from a
 *  source record (a request body, the ORCID `/start` Zod data, or a parsed
 *  on-chain `custom_json` payload). This is the SINGLE source of truth for
 *  credit-op field normalization: every site that hashes a credit-op target —
 *  both fresh-auth issuance paths and the broadcast consume scan — reads its
 *  fields through here, applying IDENTICAL trim + length-cap rules. Identical
 *  normalization is load-bearing: a whitespace-padded `paper_author` (or any
 *  identifier) MUST reduce to the same bytes at issuance and consume, or the
 *  proof self-inflicts a `target_mismatch` 403; and an uncapped value must
 *  never flow into the stored target. `paper_author` / `claimer` cap at
 *  {@link CREDIT_OP_ACCOUNT_MAX_LEN}, `paper_permlink` at
 *  {@link HIVE_PERMLINK_MAX_LEN}; `author_index` is a non-negative integer.
 *  The wire field names (`paper_author` / `paper_permlink` / `author_index` /
 *  `claimer`) are shared by all three sources (`agents/docs/hive-schemas.md`
 *  § 2.9–§ 2.11).
 *
 *  Exhaustiveness: each `CreditOpAction` member is handled in its own branch
 *  and the trailing `never` assignment makes a 4th member added to
 *  {@link CREDIT_OP_ACTION_TUPLE} a compile error here — it cannot silently
 *  fall into the revoke branch and produce a structurally wrong target hash. */
export function extractCreditOpFields(
  action: CreditOpAction,
  source: Record<string, unknown>,
): CreditOpFieldExtraction {
  const paperAuthor = requireStringField(source, 'paper_author', CREDIT_OP_ACCOUNT_MAX_LEN, undefined, { trim: true });
  if (!paperAuthor.ok) return { ok: false, field: 'paper_author' };
  const paperPermlink = requireStringField(source, 'paper_permlink', HIVE_PERMLINK_MAX_LEN, undefined, { trim: true });
  if (!paperPermlink.ok) return { ok: false, field: 'paper_permlink' };

  if (action === 'claim_authorship') {
    const authorIndex = readCreditOpAuthorIndex(source);
    if (!authorIndex.ok) return { ok: false, field: 'author_index' };
    return {
      ok: true,
      fields: {
        action,
        paperAuthor: paperAuthor.value,
        paperPermlink: paperPermlink.value,
        authorIndex: authorIndex.value,
      },
    };
  }
  if (action === 'approve_authorship') {
    const authorIndex = readCreditOpAuthorIndex(source);
    if (!authorIndex.ok) return { ok: false, field: 'author_index' };
    const claimer = requireStringField(source, 'claimer', CREDIT_OP_ACCOUNT_MAX_LEN, undefined, { trim: true });
    if (!claimer.ok) return { ok: false, field: 'claimer' };
    return {
      ok: true,
      fields: {
        action,
        paperAuthor: paperAuthor.value,
        paperPermlink: paperPermlink.value,
        authorIndex: authorIndex.value,
        claimer: claimer.value,
      },
    };
  }
  if (action === 'revoke_authorship') {
    const claimer = requireStringField(source, 'claimer', CREDIT_OP_ACCOUNT_MAX_LEN, undefined, { trim: true });
    if (!claimer.ok) return { ok: false, field: 'claimer' };
    return {
      ok: true,
      fields: {
        action,
        paperAuthor: paperAuthor.value,
        paperPermlink: paperPermlink.value,
        claimer: claimer.value,
      },
    };
  }
  // Exhaustiveness backstop: every CreditOpAction member is handled above. A
  // new member added to CREDIT_OP_ACTION_TUPLE without a branch here is a
  // compile error (it is not assignable to `never`), not a silent wrong-hash.
  // The throw covers callers that cast past the type system at runtime: the
  // impossible branch fails crisply instead of returning the action string
  // where an extraction record is expected.
  const _exhaustive: never = action;
  throw new Error(`extractCreditOpFields: unhandled credit-op action ${String(_exhaustive)}`);
}

/** Length cap for the Hive-account-name field a consent op carries
 *  (`root_author`). Same rationale and value as
 *  {@link CREDIT_OP_ACCOUNT_MAX_LEN}: Hive account names are at most 16 chars;
 *  64 is a conservative ceiling that absorbs the route body-parser limit
 *  without materializing oversized attacker input into the stored target hash.
 *  Kept as a separate constant because the two op families carry deliberately
 *  distinct wire field names and validation surfaces. Shared across every
 *  consent-op field read so issuance and consume cannot diverge on the cap. */
export const CONSENT_OP_ACCOUNT_MAX_LEN = 64;

/** Normalized wire fields of an anchored-route consent op (`author_accept` /
 *  `author_resign`). Both members carry the same two fields, so unlike
 *  {@link CreditOpTargetFields} no per-action discrimination is needed. */
export type ConsentOpTargetFields = {
  action: ConsentOpAction;
  rootAuthor: string;
  rootPermlink: string;
};

/** Target-binding helper for the anchored-route consent ops. The proof binds
 *  to `(action, root_author, root_permlink)` — the original triple form, so
 *  hashes for clean values are byte-identical to targets built inline before
 *  this helper existed. Both issuance routes and the broadcast consume side
 *  build the target through this single helper so the two sides cannot
 *  diverge on the encoding (mirrors {@link creditOpFreshAuthTarget}). */
export function consentOpFreshAuthTarget(fields: ConsentOpTargetFields): FreshAuthTarget {
  return {
    action: fields.action,
    root_author: fields.rootAuthor,
    root_permlink: fields.rootPermlink,
  };
}

/** Discriminated result of normalizing a consent op's wire fields from a
 *  source record. The `ok` arm carries the typed {@link ConsentOpTargetFields}
 *  ready for `consentOpFreshAuthTarget`; the failure arm names the missing or
 *  ill-typed field so the route can reject with a 400 that points at it. */
export type ConsentOpFieldExtraction =
  | { ok: true; fields: ConsentOpTargetFields }
  | { ok: false; field: string };

/** Normalize + validate the wire fields of an anchored-route consent op from a
 *  source record (a request body, the ORCID `/start` Zod data, or a parsed
 *  on-chain `custom_json` payload). This is the SINGLE source of truth for
 *  consent-op field normalization: every site that hashes a consent-op target —
 *  both fresh-auth issuance paths and the broadcast consume scan — reads its
 *  fields through here, applying IDENTICAL trim + length-cap rules. Identical
 *  normalization is load-bearing for the same reason as
 *  {@link extractCreditOpFields}: a whitespace-padded `root_author` MUST reduce
 *  to the same bytes at issuance and consume, or the proof self-inflicts a
 *  `target_mismatch` 403 that differs by mechanism (the prior asymmetry: the
 *  custody password path trimmed, the ORCID path and the consume scan did
 *  not); and an uncapped value must never flow into the stored target.
 *  `root_author` caps at {@link CONSENT_OP_ACCOUNT_MAX_LEN}, `root_permlink`
 *  at {@link HIVE_PERMLINK_MAX_LEN}. */
export function extractConsentOpFields(
  action: ConsentOpAction,
  source: Record<string, unknown>,
): ConsentOpFieldExtraction {
  const rootAuthor = requireStringField(source, 'root_author', CONSENT_OP_ACCOUNT_MAX_LEN, undefined, { trim: true });
  if (!rootAuthor.ok) return { ok: false, field: 'root_author' };
  const rootPermlink = requireStringField(source, 'root_permlink', HIVE_PERMLINK_MAX_LEN, undefined, { trim: true });
  if (!rootPermlink.ok) return { ok: false, field: 'root_permlink' };
  return {
    ok: true,
    fields: {
      action,
      rootAuthor: rootAuthor.value,
      rootPermlink: rootPermlink.value,
    },
  };
}

/** In-memory fallback. Intentionally module-scoped — fresh-auth tokens are
 *  short-lived and process-local fallback is acceptable when Redis is
 *  unavailable (matches the in-memory `orcidStates` fallback in
 *  `routes/orcid.ts`). */
const memStore = new Map<string, { entry: StoredEntry; expiresAt: number }>();

/** In-process lock set for the consume helpers. Closes the concurrent
 *  dual-consume race on the memStore fallback path.
 *
 *  The race: `consumeFreshAuthToken` / `consumeSessionFreshAuthToken` do a
 *  Redis GETDEL (atomic) followed by a memStore fallback `get` + `delete`
 *  (synchronous, but separated by an await on the GETDEL itself plus any
 *  future intervening awaits). On a concurrent `Promise.all` dual-consume
 *  for the same token, the second caller's GETDEL returns null (consumed
 *  by the first), falls through to memStore — which still holds the entry
 *  if the first caller hasn't yet executed its post-GETDEL `memStore.delete`.
 *  On Redis-down (both GETDELs throw), both fall through to memStore and
 *  the same widens. Worse, any future `await` between `memStore.get` and
 *  `memStore.delete` widens the window silently.
 *
 *  Mechanism: the consume helpers `inFlightConsumes.has(token)` synchronously
 *  on entry. If the token is already in-flight, the loser returns
 *  `{ valid: false, reason: 'expired' }` — same outcome a stale-replay
 *  caller observes, no new reason code on the wire. The winner adds the
 *  token to the set BEFORE any awaits, removes it in a `finally` so a
 *  throwing consume cleans up. Because JS is single-threaded, the
 *  `has` → `add` pair is an uninterruptible synchronous critical section.
 *
 *  Single-instance scope: this deployment is single-process, so the
 *  in-process lock is a complete guard; a multi-instance topology would
 *  re-open the race and require a Redis-side SETNX sentinel, which the
 *  in-process lock is not a substitute for. */
const inFlightConsumes = new Set<string>();

/** Periodic cleanup so the map doesn't grow unbounded under no-Redis ops.
 *  Same shape as the orcid_state cleaner in orcid.ts. Wrapped in a
 *  start/stop pair so tests can deterministically pause the cleaner during
 *  fake-timer scenarios. */
const CLEANUP_INTERVAL_MS = 60_000;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function startCleanup(): void {
  if (cleanupInterval !== null) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [token, { expiresAt }] of memStore) {
      if (expiresAt <= now) memStore.delete(token);
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupInterval.unref();
}

startCleanup();

interface IssuedFreshAuth {
  token: string;
  /** ISO-8601 string at which the token expires. Wire format per the
   *  `fresh_auth_proof` response shape documented in the custody and orcid
   *  API-contract files. The frontend reads this via
   *  `new Date(expiresAt).getTime()` — emitting epoch seconds (number) here
   *  would be silently interpreted as milliseconds and resolve to 1970, making
   *  the SPA cache 100% non-functional (every broadcast triggers a full ORCID
   *  OAuth round-trip). The ISO-8601 string form is the load-bearing
   *  invariant. */
  expires_at: string;
  mechanism: FreshAuthMechanism;
}

/**
 * Mint a fresh-auth token for `username` with the given mechanism, bound to
 * the per-op target (via `computeFreshAuthTargetHash`). The caller (route
 * handler) is responsible for verifying the user actually proved control via
 * that mechanism BEFORE calling this function. The caller is also responsible
 * for sourcing the target from the actual op the user intends to authorize.
 *
 * The proof is bound to the gated op via a SHA-256 of the target. Without this
 * bind the proof would be 1-fold-amplifiable: a compromised SPA could
 * authenticate the user for `author_accept` on paper X then use the proof to
 * broadcast `author_resign` on paper Y under the same TTL.
 *
 * Storage path: Redis preferred; falls back to the module-local map on
 * unavailable Redis or write failure. Both paths are TTL-bounded.
 */
export async function issueFreshAuthToken(
  username: string,
  mechanism: FreshAuthMechanism,
  target: FreshAuthTarget,
): Promise<IssuedFreshAuth> {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const issuedAt = Date.now();
  const targetHash = computeFreshAuthTargetHash(target);
  const entry: StoredEntry = {
    username,
    mechanism,
    issued_at: issuedAt,
    kind: 'consent_op',
    target_hash: targetHash,
  };
  const memExpiresAtMs = issuedAt + FRESH_AUTH_TTL_SECONDS * 1000;
  // ISO-8601 string per the documented wire contract — see IssuedFreshAuth
  // doc-comment above for why epoch-seconds breaks the SPA cache.
  const expiresAt = new Date(memExpiresAtMs).toISOString();

  // Write to memStore as a backup whenever Redis-issuance succeeds. Storing
  // the token only in Redis on the happy path means that if Redis flaps
  // between issue and consume, the consume side falls through to
  // memStore.get(token) → empty → spurious 'expired' 401 (the user just
  // authenticated). With the backup write, a Redis-down consume can recover
  // the entry from memStore. Single-use semantics are preserved: a successful
  // Redis GETDEL deletes the canonical entry; the mem-store fallback path also
  // calls memStore.delete() so the entry is consumed exactly once across the
  // storage tiers.
  memStore.set(token, { entry, expiresAt: memExpiresAtMs });

  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      await redis.set(
        KEY_PREFIX + token,
        JSON.stringify(entry),
        'EX',
        FRESH_AUTH_TTL_SECONDS,
      );
      return { token, expires_at: expiresAt, mechanism };
    } catch (err) {
      logger.warn(
        { err, username, event: 'fresh_auth.redis_set_failed' },
        'Falling back to in-memory store for fresh-auth token',
      );
      // memStore was already populated above — the token survives the
      // Redis-write failure.
      return { token, expires_at: expiresAt, mechanism };
    }
  }

  return { token, expires_at: expiresAt, mechanism };
}

/**
 * Mint a session-kind fresh-auth token (no per-op target binding) for
 * `username` with the given mechanism. Mirrors the storage primitives of
 * `issueFreshAuthToken` but produces a `kind: 'session'` entry consumed by
 * `consumeSessionFreshAuthToken` on the non-consent `/api/custody/broadcast`
 * path.
 *
 * Rationale: non-consent ops (vote, comment, non-consent custom_json) do
 * not have the action/paper substitution-attack surface that motivated the
 * per-op target binding. Forcing State C users (ORCID-only, passwordless) to
 * fabricate a target to mint an ORCID proof would be UX friction without
 * security benefit. Session-kind proofs encode "the user re-authed via this
 * mechanism in the last 5 minutes" — enough to close the JWT-only-takeover
 * gap on the non-consent path per ARCH.md § 6.5 invariant #1.
 *
 * The caller (route handler) is responsible for verifying the user
 * actually proved control via that mechanism BEFORE calling this function,
 * same contract as `issueFreshAuthToken`. Single-use semantics, TTL, and
 * Redis-fallback shape are identical.
 */
export async function issueSessionFreshAuthToken(
  username: string,
  mechanism: FreshAuthMechanism,
): Promise<IssuedFreshAuth> {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const issuedAt = Date.now();
  const entry: StoredEntry = {
    username,
    mechanism,
    issued_at: issuedAt,
    kind: 'session',
  };
  const memExpiresAtMs = issuedAt + FRESH_AUTH_TTL_SECONDS * 1000;
  // ISO-8601 string per the documented wire contract — see IssuedFreshAuth
  // doc-comment above for why epoch-seconds breaks the SPA cache.
  const expiresAt = new Date(memExpiresAtMs).toISOString();

  // Write to memStore as a backup whenever Redis-issuance succeeds (same
  // recovery rationale as `issueFreshAuthToken`). Storing the token only in
  // Redis on the happy path means that if Redis flaps between issue and
  // consume, the consume side falls through to memStore.get(token) → empty →
  // spurious 'expired' 401 (the user just authenticated). With the backup
  // write, a Redis-down consume can recover the entry from
  // memStore. Single-use semantics are preserved: a successful Redis GETDEL
  // deletes the canonical entry; the mem-store fallback path also calls
  // memStore.delete() so the entry is consumed exactly once across the
  // storage tiers. This block is NOT dead code in the Redis-success branch
  // — it is the recovery path for a flap between issue and consume.
  memStore.set(token, { entry, expiresAt: memExpiresAtMs });

  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      await redis.set(
        KEY_PREFIX + token,
        JSON.stringify(entry),
        'EX',
        FRESH_AUTH_TTL_SECONDS,
      );
      return { token, expires_at: expiresAt, mechanism };
    } catch (err) {
      logger.warn(
        { err, username, event: 'fresh_auth.redis_set_failed' },
        'Falling back to in-memory store for session fresh-auth token',
      );
      // memStore was already populated above — the token survives the
      // Redis-write failure.
      return { token, expires_at: expiresAt, mechanism };
    }
  }

  return { token, expires_at: expiresAt, mechanism };
}

/** Reasons for a non-valid fresh-auth verify outcome.
 *
 *  `consumeFreshAuthToken` and its session-kind sibling produce every value
 *  in this union except `'wrong_mechanism'`. `'wrong_mechanism'` is
 *  synthesized at the route layer AFTER a successful consume returned
 *  `{ valid: true, mechanism }` but the route's per-account mechanism
 *  predicate (§ 6.4: factor must be registered on the account) rejects the
 *  result. Three call sites synthesize it today: the `settings.ts`
 *  set-password and change-email handlers and the `settings.ts`
 *  delete-account (`DELETE /api/settings/email`) handler. Keeping the value
 *  in this union — rather than as a magic string at each call site — gives
 *  the typechecker compile-time enforcement that every route that emits this
 *  reason agrees on the spelling: a divergent spelling
 *  (`'wrong-mechanism'`, `'mechanism_mismatch'`) fails the assignability
 *  check against `details.reason` rather than silently landing a divergent
 *  wire token. */
export type FreshAuthVerifyFailureReason =
  | 'missing'
  | 'expired'
  | 'username_mismatch'
  | 'target_mismatch'
  | 'malformed'
  | 'kind_mismatch'
  | 'wrong_mechanism';

type FreshAuthVerifyResult =
  | { valid: true; mechanism: FreshAuthMechanism }
  | {
      valid: false;
      reason: FreshAuthVerifyFailureReason;
    };

/**
 * Single-use consume of a fresh-auth token. Returns `{ valid: true,
 * mechanism }` exactly once per issued token; subsequent calls return
 * `{ valid: false, reason: 'expired' }` (already consumed by the GETDEL /
 * map.delete()).
 *
 * Dual-tier deletion is SYMMETRIC across both legs. The Redis-success leg
 * deletes the memStore backup (so a sibling consume can't replay the token via
 * the fallback path). The memStore-fallback leg issues a best-effort
 * `redis.del` of the canonical entry (so a Redis flap mid-call that consumed
 * the memStore copy doesn't leave the canonical entry behind for a replay once
 * Redis recovers within the TTL window). An asymmetric variant — only the
 * Redis-success leg clearing the other tier — would admit a same-process
 * double-consume under a Redis blip mid-`getdel`.
 *
 * The Redis-flap fallback recovery path (memStore backup written at issuance)
 * makes the consume side resilient to mid-call Redis failures without
 * sacrificing single-use semantics.
 *
 * Consume requires `expectedTargetHash` (computed by the caller from the
 * actual gated op being authorized). A token minted for one (action, paper)
 * target cannot authorize a different target. Closed-default: a missing or
 * non-hex `expectedTargetHash` rejects with `target_mismatch` rather than
 * skipping the check, so a caller that doesn't supply a well-formed hash
 * cannot accidentally bypass the bind.
 *
 * The route layer rejects the broadcast on any non-valid outcome.
 */
export async function consumeFreshAuthToken(
  token: string | undefined,
  expectedUsername: string,
  expectedTargetHash: string,
): Promise<FreshAuthVerifyResult> {
  if (!token || typeof token !== 'string' || token.length === 0) {
    return { valid: false, reason: 'missing' };
  }

  // In-process lock check. Synchronous `has` → `add` is atomic under the JS
  // event loop; a concurrent dual-consume for the same token has exactly one
  // caller reach the body, the loser returns `expired` immediately. The lock
  // is released in a `finally` below so a throwing consume cleans up. The
  // loser's `expired` is indistinguishable from a stale replay, preserving
  // the single-use contract as the user perceives it.
  if (inFlightConsumes.has(token)) {
    return { valid: false, reason: 'expired' };
  }
  inFlightConsumes.add(token);

  try {
    return await consumeFreshAuthTokenLocked(token, expectedUsername, expectedTargetHash);
  } finally {
    inFlightConsumes.delete(token);
  }
}

/**
 * Reason -> HTTP status for a failed fresh-auth consume, in ONE place so the
 * binding-violation vs no-proof-present distinction cannot drift between
 * consumers. `username_mismatch` / `target_mismatch` / `kind_mismatch` are
 * binding violations (a proof minted for a different user or action, or a
 * target-less session proof redirected here) -> 403; `missing` / `expired` /
 * `malformed` are "no valid proof present" -> 401.
 */
function freshAuthFailureStatus(reason: FreshAuthVerifyFailureReason): 401 | 403 {
  return reason === 'username_mismatch' || reason === 'target_mismatch' || reason === 'kind_mismatch' ? 403 : 401;
}

/**
 * Consume the JWT-path fresh-auth proof on `req` against `targetFn(username)`,
 * returning a binding-aware pass/fail decision (the reason->status mapping lives
 * in `freshAuthFailureStatus`, the single source of truth). On the per-request
 * signature path (`hiveAuthMethod !== 'jwt'`) the request is already fresh, so
 * this returns `{ ok: true }` without requiring a proof.
 *
 * Returns the decision rather than sending a response so a handler that must run
 * its OWN eligibility checks BEFORE burning the single-use proof (e.g. the
 * accreditation metadata edit, which checks currently-accredited + not-sanctioned
 * first) can call it inline at the correct point. Handlers whose fresh-auth gate
 * is the first thing they do use the `requireFreshAuth` middleware wrapper.
 */
export async function consumeFreshAuthProof(
  req: Request,
  targetFn: (username: string) => FreshAuthTarget,
): Promise<{ ok: true } | { ok: false; status: 401 | 403; reason: FreshAuthVerifyFailureReason }> {
  if (req.hiveAuthMethod !== 'jwt') return { ok: true };
  const username = req.hiveUsername;
  if (!username) return { ok: false, status: 401, reason: 'missing' };
  const proofRaw = (req.body as { fresh_auth_proof?: unknown })?.fresh_auth_proof;
  const proofToken = typeof proofRaw === 'string' ? proofRaw : undefined;
  const expectedTargetHash = computeFreshAuthTargetHash(targetFn(username));
  const result = await consumeFreshAuthToken(proofToken, username, expectedTargetHash);
  if (result.valid) return { ok: true };
  return { ok: false, status: freshAuthFailureStatus(result.reason), reason: result.reason };
}

/**
 * Express-middleware form of `consumeFreshAuthProof` for handlers whose
 * fresh-auth gate is the first thing they do (no eligibility check that must
 * precede the single-use proof consume). Mirrors `requireFreshAdminAuth`.
 * `message` is the user-facing FRESH_AUTH_REQUIRED string for this action.
 * Handlers that must verify eligibility before burning the proof call
 * `consumeFreshAuthProof` inline instead.
 */
export function requireFreshAuth(targetFn: (username: string) => FreshAuthTarget, message: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const decision = await consumeFreshAuthProof(req, targetFn);
    if (decision.ok) {
      next();
      return;
    }
    sendError(res, decision.status, 'FRESH_AUTH_REQUIRED', message, { reason: decision.reason });
  };
}

async function consumeFreshAuthTokenLocked(
  token: string,
  expectedUsername: string,
  expectedTargetHash: string,
): Promise<FreshAuthVerifyResult> {
  let raw: string | null = null;
  let consumedFromMemStore = false;

  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      // GETDEL: atomic single-use semantic. Available since Redis 6.2; ioredis
      // exposes it as `getdel`. Falls through to in-memory on error so a
      // Redis flap mid-session doesn't lock out a legitimate user with a
      // pending mem-store fallback token (issuance race window).
      raw = await redis.getdel(KEY_PREFIX + token);
    } catch (err) {
      logger.warn(
        { err, event: 'fresh_auth.redis_getdel_failed' },
        'Falling back to in-memory lookup for fresh-auth verify',
      );
    }
  }

  if (raw) {
    // Redis GETDEL succeeded. Also drop the memStore backup so a sibling
    // consume can't replay the token via the fallback path.
    memStore.delete(token);
  } else {
    const cached = memStore.get(token);
    if (cached) {
      memStore.delete(token); // single-use even on the fallback path
      if (cached.expiresAt > Date.now()) {
        raw = JSON.stringify(cached.entry);
        consumedFromMemStore = true;
      }
    }
  }

  if (!raw) return { valid: false, reason: 'expired' };

  // When we consumed from the memStore fallback path (Redis was unavailable
  // or threw on getdel), issue a best-effort `redis.del` of the canonical
  // Redis entry. Without this, a transient Redis flap mid-getdel that didn't
  // actually delete the entry would leave the canonical Redis copy alive — and
  // a replay within the TTL window once Redis recovered would hit Redis getdel
  // and return valid a second time (double-consume). The redis.del here is
  // best-effort: we already consumed the memStore copy, so the user's
  // broadcast is good to proceed regardless of whether this paired delete
  // lands. Logging on error correlates the recovery attempt with the flap.
  if (consumedFromMemStore && redis) {
    try {
      await redis.del(KEY_PREFIX + token);
    } catch (err) {
      logger.warn(
        { err, event: 'fresh_auth.redis_compensating_del_failed' },
        'Compensating Redis del after memStore-fallback consume failed; replay window remains until TTL',
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Stored value parse failure — treat as malformed-but-consumed.
    return { valid: false, reason: 'malformed' };
  }

  // Structural narrowing rather than an unsafe `JSON.parse(raw) as
  // StoredEntry`. Adding a new field to StoredEntry requires extending this
  // guard; a future refactor that relaxes the schema is forced to update the
  // consume path explicitly. The `target_hash` field MUST be present and
  // well-shaped on consent-op entries — a consent-op entry without it is a
  // pre-target-binding stored shape (e.g., a token written before redeploy and
  // consumed after) and is rejected as malformed (checked below).
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { username?: unknown }).username !== 'string' ||
    !isFreshAuthMechanism((parsed as { mechanism?: unknown }).mechanism)
  ) {
    return { valid: false, reason: 'malformed' };
  }

  // Legacy entries (predating the `kind` discriminator) do not carry the
  // field — treat them as 'consent_op' so the target-bind check below still
  // fires (closed-default for the original security property). Explicit
  // mismatch on unknown kind shapes (a future variant not understood by
  // this version) → malformed.
  const rawKind = (parsed as { kind?: unknown }).kind;
  let kind: FreshAuthKind;
  if (rawKind === undefined) {
    kind = 'consent_op';
  } else if (isFreshAuthKind(rawKind)) {
    kind = rawKind;
  } else {
    return { valid: false, reason: 'malformed' };
  }

  // A consent-op entry MUST carry a well-shaped target_hash; absence is a
  // pre-target-binding stored shape. A session-kind entry MUST NOT carry one
  // (its target field is forbidden at issuance); presence on a session entry
  // is malformed because someone wrote a kind/target combo this code never
  // mints.
  const rawTargetHash = (parsed as { target_hash?: unknown }).target_hash;
  if (kind === 'consent_op') {
    if (!isValidTargetHash(rawTargetHash)) {
      return { valid: false, reason: 'malformed' };
    }
  } else if (rawTargetHash !== undefined) {
    return { valid: false, reason: 'malformed' };
  }

  const entry: {
    username: string;
    mechanism: FreshAuthMechanism;
    kind: FreshAuthKind;
    target_hash?: string;
  } = {
    username: (parsed as { username: string }).username,
    mechanism: (parsed as { mechanism: FreshAuthMechanism }).mechanism,
    kind,
    target_hash: kind === 'consent_op' ? (rawTargetHash as string) : undefined,
  };

  if (entry.username !== expectedUsername) {
    return { valid: false, reason: 'username_mismatch' };
  }

  // Consent-op consume requires a consent_op-kind entry. A session-kind
  // entry consumed here is a kind mismatch — the caller (consent-op
  // broadcast) expects the per-op binding the session proof does not
  // carry. This is the strict-isolation direction of the consume contract:
  // session proofs do NOT authorize consent ops, only the looser non-
  // consent broadcast surface. (The reverse — consent_op proof on a
  // session-consume call — IS accepted via `consumeSessionFreshAuthToken`
  // because non-consent ops don't need binding; a per-op proof for the
  // same user is strictly more proof, not less.)
  if (entry.kind !== 'consent_op') {
    return { valid: false, reason: 'kind_mismatch' };
  }

  // Closed-default — the caller MUST supply a well-formed expected hash. An
  // empty / malformed argument rejects rather than bypasses the bind, so a
  // caller that doesn't compute the hash can't accidentally re-enable the
  // 1-fold substitution attack.
  if (!isValidTargetHash(expectedTargetHash)) {
    return { valid: false, reason: 'target_mismatch' };
  }
  if (entry.target_hash !== expectedTargetHash) {
    return { valid: false, reason: 'target_mismatch' };
  }

  return { valid: true, mechanism: entry.mechanism };
}

/**
 * Session-kind consume: single-use consume of a fresh-auth token for the
 * non-consent `/api/custody/broadcast` path. Accepts EITHER:
 *
 *   - a `kind: 'session'` entry (target-less, minted by
 *     `issueSessionFreshAuthToken`), OR
 *   - a `kind: 'consent_op'` entry (target-bound, minted by
 *     `issueFreshAuthToken`).
 *
 * The cross-kind accept is intentional: a consent-op proof is strictly
 * MORE proof than a session proof for the same user (binds the target +
 * proves recent re-auth). Non-consent ops don't need the per-op binding,
 * so the binding is just informational here. Reusing a single proof for
 * both surfaces during the same session is good UX and does not weaken the
 * security model — the consent-op consume side still enforces the binding
 * on the consent-op surface itself.
 *
 * The strict direction — session proof on a consent-op surface — is NOT
 * accepted (see `consumeFreshAuthToken`'s `kind_mismatch` branch above).
 *
 * Storage + single-use + Redis-flap-recovery semantics mirror
 * `consumeFreshAuthToken` exactly; the only behavioral difference is the
 * absence of target-hash verification.
 */
export async function consumeSessionFreshAuthToken(
  token: string | undefined,
  expectedUsername: string,
): Promise<FreshAuthVerifyResult> {
  if (!token || typeof token !== 'string' || token.length === 0) {
    return { valid: false, reason: 'missing' };
  }

  // In-process lock check — mirrors the lock from `consumeFreshAuthToken`.
  // The race + mitigation are identical; only the kind-acceptance contract
  // differs (session consume accepts both kinds — see docstring). The same
  // `inFlightConsumes` set is shared across both consume helpers because a
  // single token is uniquely bound to ONE kind at issuance (either
  // `issueFreshAuthToken` => consent_op or `issueSessionFreshAuthToken` =>
  // session). Two concurrent consumes targeting the same token from
  // different helpers is the same race surface as two consumes through the
  // same helper, so the lock domain is "token", not "(token, helper)".
  if (inFlightConsumes.has(token)) {
    return { valid: false, reason: 'expired' };
  }
  inFlightConsumes.add(token);

  try {
    return await consumeSessionFreshAuthTokenLocked(token, expectedUsername);
  } finally {
    inFlightConsumes.delete(token);
  }
}

async function consumeSessionFreshAuthTokenLocked(
  token: string,
  expectedUsername: string,
): Promise<FreshAuthVerifyResult> {
  let raw: string | null = null;
  let consumedFromMemStore = false;

  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      raw = await redis.getdel(KEY_PREFIX + token);
    } catch (err) {
      logger.warn(
        { err, event: 'fresh_auth.redis_getdel_failed' },
        'Falling back to in-memory lookup for session fresh-auth verify',
      );
    }
  }

  if (raw) {
    memStore.delete(token);
  } else {
    const cached = memStore.get(token);
    if (cached) {
      memStore.delete(token);
      if (cached.expiresAt > Date.now()) {
        raw = JSON.stringify(cached.entry);
        consumedFromMemStore = true;
      }
    }
  }

  if (!raw) return { valid: false, reason: 'expired' };

  if (consumedFromMemStore && redis) {
    try {
      await redis.del(KEY_PREFIX + token);
    } catch (err) {
      logger.warn(
        { err, event: 'fresh_auth.redis_compensating_del_failed' },
        'Compensating Redis del after memStore-fallback session consume failed; replay window remains until TTL',
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { username?: unknown }).username !== 'string' ||
    !isFreshAuthMechanism((parsed as { mechanism?: unknown }).mechanism)
  ) {
    return { valid: false, reason: 'malformed' };
  }

  const rawKind = (parsed as { kind?: unknown }).kind;
  let kind: FreshAuthKind;
  if (rawKind === undefined) {
    kind = 'consent_op';
  } else if (isFreshAuthKind(rawKind)) {
    kind = rawKind;
  } else {
    return { valid: false, reason: 'malformed' };
  }

  // Schema consistency: same kind/target-hash invariants as the consent-op
  // consume. A consent-op entry must have a target_hash; a session entry
  // must not.
  const rawTargetHash = (parsed as { target_hash?: unknown }).target_hash;
  if (kind === 'consent_op') {
    if (!isValidTargetHash(rawTargetHash)) {
      return { valid: false, reason: 'malformed' };
    }
  } else if (rawTargetHash !== undefined) {
    return { valid: false, reason: 'malformed' };
  }

  const entry = {
    username: (parsed as { username: string }).username,
    mechanism: (parsed as { mechanism: FreshAuthMechanism }).mechanism,
    kind,
  };

  if (entry.username !== expectedUsername) {
    return { valid: false, reason: 'username_mismatch' };
  }

  // Session consume accepts both kinds (see docstring) — no kind check.
  return { valid: true, mechanism: entry.mechanism };
}

/** Test-only hook: clears the in-memory fallback store. Not exposed to
 *  route handlers. */
export function _resetFreshAuthMemStoreForTests(): void {
  memStore.clear();
}

/** Test-only hook: returns the current size of the in-flight consume lock
 *  set. Used by the lock-cleanup test to pin the `try/finally` discipline
 *  structurally: after a throwing consume, the set MUST be empty. Without
 *  this hook, the test can only assert wire-shape outcomes, which collapse
 *  the lock-held branch into the consumed-token branch (both return
 *  `expired`) and admit a `finally`-removal mutation. */
export function _getInFlightConsumesSizeForTests(): number {
  return inFlightConsumes.size;
}

/** Test-only hook: returns the live `inFlightConsumes` Set reference so
 *  tests can pin the shared-lock-domain invariant by identity. Both
 *  `consumeFreshAuthToken` and `consumeSessionFreshAuthToken` MUST consult
 *  the same Set instance — a mutation that splits the lock into per-helper
 *  Sets would regress the cross-kind dual-consume race protection. Wire-
 *  shape assertions can't catch that mutation because JS microtask FIFO
 *  ordering serializes the first-resolving helper's `get` -> `delete`
 *  chain before the second's `catch` runs on Redis-down, so the second
 *  helper sees an empty memStore and returns `expired` regardless of
 *  whether the lock domain is shared or split. Reference equality is the
 *  only mutation-killing anchor. Read-only by convention — tests must not
 *  mutate the returned Set. */
export function _getInFlightConsumesSetReferenceForTests(): ReadonlySet<string> {
  return inFlightConsumes;
}

/** Test-only hook: plants a memStore entry directly so tests can exercise
 *  the memStore-fallback path with controlled entry contents. Used by the
 *  lock-cleanup test to plant a circular-reference entry that throws on
 *  `JSON.stringify` inside the locked critical section, forcing the
 *  consume helper through its `finally` block.
 *
 *  The parameter type is `StoredEntry | object` rather than `StoredEntry`
 *  because callers may deliberately plant structurally invalid objects
 *  (e.g., a circular-reference object that fails `JSON.stringify`) to
 *  trigger throw-on-stringify paths inside the consume helper. The widened
 *  type signals that misuse is intentional; the internal cast to
 *  `StoredEntry` is load-bearing for the memStore Map shape but does not
 *  reflect a runtime guarantee about the planted value. */
export function _setMemStoreEntryForTests(
  token: string,
  entry: StoredEntry | object,
  expiresAt: number,
): void {
  memStore.set(token, { entry: entry as StoredEntry, expiresAt });
}

/** Test-only hooks to pause / restart the module-level cleanup interval.
 *  Without these, fake-timer tests that need to advance past the TTL boundary
 *  race the cleaner and observe non-deterministic results (the cleaner fires
 *  under fake timers and pre-deletes the entry the test was about to assert
 *  on). Pair with `_resetFreshAuthMemStoreForTests` in `beforeEach` so suites
 *  have full control over the in-memory state. */
export function _stopCleanupForTests(): void {
  if (cleanupInterval !== null) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

export function _restartCleanupForTests(): void {
  startCleanup();
}
