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
 *
 * The two kinds have deliberately different lifetimes because they defend
 * different things (`agents/docs/ARCHITECTURE.md` § 6.4.1):
 *
 * - `consent_op` — target-bound, SINGLE-USE, `FRESH_AUTH_TTL_SECONDS` (5 min).
 *   Its job is to stop a proof minted for one paper/slot/co-author being
 *   redirected onto another, which is structurally incompatible with reuse.
 *   The burn is arbitrated by the storage tier (Redis `DEL` reply count, or
 *   the in-memory `Map.delete` return value), so exactly one concurrent
 *   caller can win.
 * - `session` — target-less, MULTI-USE inside a bounded window. A sliding
 *   idle deadline (`SESSION_FRESH_AUTH_IDLE_SECONDS`) moves forward on every
 *   successful consume; an absolute cap (`SESSION_FRESH_AUTH_ABSOLUTE_SECONDS`)
 *   fixed at first mint bounds the window no matter how much it is slid.
 *   Whichever deadline arrives first ends the window and reports `expired`.
 *   Consume validates and slides; it does not delete.
 *
 * Stored value: `{ username, mechanism, issued_at, kind }` JSON, plus
 * `target_hash` on consent-op entries and `idle_expires_at` /
 * `absolute_expires_at` (epoch ms) on session entries.
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

/** Consent-op token TTL in seconds. 5 minutes — bounded enough to limit replay
 *  risk if the token leaks, generous enough for a "re-auth then broadcast" UX
 *  without forcing the user to re-prompt mid-flow.
 *
 *  Applies to the `consent_op` kind ONLY. The session kind is windowed and uses
 *  the two constants below; the constants are deliberately separate so tuning
 *  one cannot silently move the other.
 *
 *  Kept exported for tests: the in-memory TTL-expiry fake-timer test in
 *  `tests/lib/fresh-auth.test.ts` advances `Date.now()` past this boundary. */
export const FRESH_AUTH_TTL_SECONDS = 300;

/** Session-kind sliding idle window in seconds. 15 minutes of inactivity ends
 *  the window; every successful consume slides the deadline forward, so an
 *  active working stretch of votes, comments, reviews, and posts is never
 *  interrupted by a re-auth prompt (`agents/docs/ARCHITECTURE.md` § 6.4.1). */
export const SESSION_FRESH_AUTH_IDLE_SECONDS = 900;

/** Session-kind absolute cap in seconds, measured from first mint. 2 hours.
 *  Enforced server-side and NOT extendable by any client action: the slide is
 *  clamped to this deadline, so a proof exfiltrated alongside a JWT is worth at
 *  most this much broadcasting rather than the full session lifetime. Reaching
 *  the cap costs one re-auth act. */
export const SESSION_FRESH_AUTH_ABSOLUTE_SECONDS = 7200;

const TOKEN_BYTES = 32;
// Kind-neutral key prefix. Both consent-op-kind (issueFreshAuthToken) and
// session-kind (issueSessionFreshAuthToken) entries share this single
// namespace; discrimination is by the `kind` JSON field inside the stored
// value, not by key namespace.
const KEY_PREFIX = `${config.appTag}:fresh_auth:token:`;
// Per-user index of outstanding session-kind tokens, so
// `invalidateSessionFreshAuthTokens` can close every open window for one
// account without scanning the keyspace. Redis SET; each member is a raw token
// (the `KEY_PREFIX` is re-applied when deleting). The index key carries its own
// expiry equal to the session absolute cap, so a crashed process cannot leave it
// growing forever.
const USER_SESSION_INDEX_PREFIX = `${config.appTag}:fresh_auth:user_sessions:`;
/** How many index members one `DEL` in the invalidation sweep may carry. Each
 *  member becomes its own argument, so an unbounded spread throws `RangeError`
 *  on a large enough index and takes the whole sweep with it. */
const INVALIDATE_DELETE_CHUNK = 500;

/** Discriminates per-op consent proofs (target-bound) from session-level
 *  broadcast proofs (target-less). State C ORCID-only accounts have no
 *  per-op target to bind a consent-op-kind proof to; session-kind closes
 *  the JWT-only takeover gap per ARCH.md § 6.5 invariant #1. */
export type FreshAuthKind = 'consent_op' | 'session';

interface StoredEntry {
  username: string;
  mechanism: FreshAuthMechanism;
  /** Epoch ms, fixed at mint and never rewritten. Informational on consent-op
   *  entries, where expiry is enforced by Redis EX / map cleanup. On session
   *  entries it is the revocation anchor: `consumeSessionWindow` rejects a
   *  window whose `issued_at` is at or before the account's
   *  `sessions_invalidated_at`, and the slide carries it through unchanged so
   *  the comparison cannot age out from under a revocation. */
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
  /** Session-kind only. Epoch ms sliding idle deadline: every successful
   *  consume rewrites this to `now + SESSION_FRESH_AUTH_IDLE_SECONDS`, clamped
   *  to `absolute_expires_at`. Absent on consent-op entries; a session entry
   *  missing it is malformed-on-consume (closed-default, so a stored shape
   *  written before the window existed cannot be replayed as an unbounded one).
   */
  idle_expires_at?: number;
  /** Session-kind only. Epoch ms absolute cap, fixed at first mint and never
   *  rewritten. Stored ALONGSIDE the sliding deadline rather than recomputed
   *  from `issued_at`, so the cap is carried by the entry itself and survives
   *  every slide. Absent on consent-op entries; a session entry missing it is
   *  malformed-on-consume for the same closed-default reason. */
  absolute_expires_at?: number;
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

/** Type guard for a stored epoch-ms deadline. Session-kind entries carry two
 *  of them and both are load-bearing: the sliding idle deadline and the
 *  absolute cap. A non-finite or non-positive value would compare falsely
 *  against `Date.now()` and could hand out an unbounded window, so the consume
 *  side rejects the entry as malformed rather than coercing. */
function isEpochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
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
 *  pin arbitrary content under their account, so a replayable JWT alone must not
 *  reach it. Like the other non-broadcast criticals the target is per-user (not
 *  per-paper): the proof binds to `(ipfs_upload, <username>, '')`; empty
 *  `root_permlink` keeps the target-hash domain collision-free against
 *  consent-op proofs (which require non-empty `root_permlink` at the route
 *  layer).
 *
 *  SCOPE OF THE BIND. This target constrains CONSENT-OP-kind proofs only. The
 *  distinct `action` value is what stops a consent-op proof minted for
 *  `change_email`, an admin action, or a consent op from being redirected here
 *  under a stolen JWT: it fails the target-hash compare. It does NOT stop a
 *  session-kind proof, because the route deliberately admits one inside its
 *  window (`agents/docs/ARCHITECTURE.md` § 6.4.1). That is not a weakening: a
 *  live session proof already authorizes arbitrary non-consent broadcasts for
 *  the rest of its window, so an upload is not a wider grant than the holder
 *  already has, and it is what makes inline upload reachable for a passwordless
 *  account whose only re-auth factor is a page navigation a selected file cannot
 *  survive. The per-file integrity binding lives in the returned upload token.
 *
 *  Issuance side: `POST /api/custody/fresh-auth { action: 'ipfs_upload' }`
 *  (password) and `POST /api/orcid/start { mode: 'fresh_auth', action:
 *  'ipfs_upload' }` (ORCID). */
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

/** In-process lock set for the CONSENT-OP burn only. Closes the concurrent
 *  dual-consume race across the two storage tiers.
 *
 *  The race: a consume reads the entry, then burns it. The burn is arbitrated
 *  by the storage tier it lands on — the Redis `DEL` reply count, or the
 *  in-memory `Map.delete` return value — so two callers hitting the SAME tier
 *  already resolve to exactly one winner. What the tier arbitration cannot
 *  cover is a Redis flap that splits two concurrent callers across BOTH tiers:
 *  caller A burns the canonical Redis entry while caller B's Redis command
 *  throws and B burns the in-memory backup. Both would see a successful burn.
 *
 *  Mechanism: the burn path checks `inFlightConsumes.has(token)` synchronously
 *  on entry. If the token is already in flight, the loser returns
 *  `{ valid: false, reason: 'expired' }` — the same outcome a stale-replay
 *  caller observes, no new reason code on the wire. The winner adds the token
 *  to the set BEFORE any awaits and removes it in a `finally` so a throwing
 *  burn cleans up. Because JS is single-threaded, the `has` -> `add` pair is an
 *  uninterruptible synchronous critical section. A loser that arrives after the
 *  winner released the lock still fails closed: its own burn finds the entry
 *  already gone in both tiers and reports `expired`.
 *
 *  Deliberately NOT applied to the session kind. Session proofs are multi-use
 *  inside their window, so serializing them would turn legitimate concurrency
 *  (two votes fired in the same tick, or an upload-token mint racing a
 *  broadcast) into a spurious 401 the SPA reads as "re-auth needed". Session
 *  consumes slide rather than burn, and a slide is idempotent: concurrent
 *  slides converge on the same deadline, so there is nothing to serialize.
 *
 *  Single-instance scope: this deployment is single-process, so the in-process
 *  lock is a complete guard; a multi-instance topology would re-open the
 *  split-tier race and require a Redis-side sentinel, which the in-process lock
 *  is not a substitute for. */
const inFlightConsumes = new Set<string>();

/** Consent-op proofs whose burn was won by the in-memory tier while the
 *  canonical Redis copy could NOT be confirmed removed. Token -> that proof's
 *  own expiry (epoch ms).
 *
 *  Why a ledger is needed at all: the compensating `DEL` issued after an
 *  in-memory-arbitrated burn is not guaranteed to land. ioredis rejects the
 *  entire offline queue with `MaxRetriesPerRequestError` on every reconnect
 *  attempt divisible by `maxRetriesPerRequest + 1`, so on this client's backoff
 *  curve a queued command survives roughly two seconds of downtime — well short
 *  of an ordinary Redis restart. Past that point the canonical copy stands for
 *  the remainder of its TTL, and a single-use proof that has ALREADY authorized
 *  one critical action reads back out of Redis and authorizes a second. The
 *  per-user targets bind `(action, actor, '')` and never the operation payload,
 *  so the second use is not even constrained to the same effect as the first.
 *
 *  Membership means "spent, canonical fate unknown". The burn consults it before
 *  reporting a win, so a proof in here is refused on every later presentation no
 *  matter what Redis still holds — the guarantee no longer rests on a command
 *  that may never flush. Entries leave on any of three events: the compensating
 *  delete is confirmed to have landed, a later presentation's `GETDEL` proves
 *  the canonical copy gone, or the proof's own expiry passes.
 *
 *  Process-local, like every other tier here. A restart drops the ledger, but it
 *  drops `memStore` with it, which is already the point past which Redis is the
 *  sole arbiter; the drain below is what keeps that window short. */
const spentConsentOps = new Map<string, number>();

/** Has this consent-op proof already been burned against an unconfirmed
 *  canonical copy? Prunes on read so an expired ledger entry never outlives the
 *  proof it guards. */
function isConsentOpSpent(token: string): boolean {
  const expiresAt = spentConsentOps.get(token);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    spentConsentOps.delete(token);
    return false;
  }
  return true;
}

/** Retry the compensating deletes a flap left undone, and drop ledger entries
 *  whose proof has lapsed anyway.
 *
 *  This is not what closes the replay hole — the ledger itself refuses the
 *  replay whether or not a delete ever lands. What the drain buys is that an
 *  orphaned canonical key does not outlive the process-local ledger entry
 *  guarding it: once Redis is reachable again the key goes, so a later restart
 *  finds nothing to replay. A restart BEFORE Redis returns is the residual this
 *  cannot cover.
 *
 *  Deletes are fire-and-forget: a retry that fails leaves the entry in place for
 *  the next tick, which is exactly the state it was already in. */
function drainSpentConsentOps(now: number): void {
  if (spentConsentOps.size === 0) return;
  const redis = getRedis();
  const client = redis !== null && isRedisAvailable() ? redis : null;
  for (const [token, expiresAt] of spentConsentOps) {
    if (expiresAt <= now) {
      spentConsentOps.delete(token);
      continue;
    }
    if (!client) continue;
    void client
      .del(KEY_PREFIX + token)
      .then(() => {
        // Confirmed gone from the canonical tier, and `memStore` lost it at
        // burn time, so the proof is unreachable and the ledger entry has
        // nothing left to guard.
        spentConsentOps.delete(token);
      })
      .catch(() => {
        // Still unreachable. Deliberately unlogged: the burn already warned
        // once, and this runs on a timer for as long as the outage lasts.
      });
  }
}

/** Periodic cleanup so the maps don't grow unbounded under no-Redis ops.
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
    drainSpentConsentOps(now);
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

/** Issuance shape for a session-kind mint. Carries BOTH window deadlines so the
 *  SPA can decide to re-auth ahead of a submit rather than discovering the
 *  window closed mid-flow.
 *
 *  `expires_at` keeps its meaning from {@link IssuedFreshAuth}: the deadline the
 *  client should treat as authoritative for "do I need to re-auth". For a
 *  session mint that is the sliding idle deadline, which is the earlier of the
 *  two at mint time and the only one that moves. `absolute_expires_at` is the
 *  cap the slide can never push past; a client that keeps working sees
 *  `expires_at` advance toward it and stop there. Same ISO-8601 string
 *  convention, for the same reason. */
interface IssuedSessionFreshAuth extends IssuedFreshAuth {
  absolute_expires_at: string;
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
 * `username` with the given mechanism. Opens a WINDOW rather than issuing a
 * one-shot proof: the returned token authorizes non-consent broadcasts and
 * upload-token mints repeatedly until the window closes
 * (`agents/docs/ARCHITECTURE.md` § 6.4.1).
 *
 * Two deadlines are fixed here and stored with the entry:
 *   - the sliding idle deadline, `SESSION_FRESH_AUTH_IDLE_SECONDS` out, which
 *     every successful consume moves forward;
 *   - the absolute cap, `SESSION_FRESH_AUTH_ABSOLUTE_SECONDS` out, which
 *     nothing moves.
 * The storage TTL tracks whichever is nearer, so the window cannot outlive the
 * cap even if the slide logic were to regress.
 *
 * Rationale for multi-use: the alternative that preserves single-use in form is
 * for the client to hold the user's password in memory and mint a fresh proof
 * per broadcast. That is the same posture — one authentication act authorizing
 * many broadcasts over a stretch of time — with the long-lived secret moved to
 * the worse location. A held password has no server-side expiry, cannot be
 * revoked, and unlocks the settings critical actions too; a windowed proof
 * expires on a schedule the client cannot extend, dies with the session
 * (`invalidateSessionFreshAuthTokens`), and grants only broadcasting and
 * uploads.
 *
 * Only an explicit re-auth act may call this: the password branch of
 * `POST /api/custody/session-auth` and the ORCID branch of
 * `POST /api/orcid/callback mode='session_auth'`. No login, token-refresh, or
 * signup-finalization path may mint or extend a window as a side effect of
 * establishing a session — that is § 6.5 invariant #9, and it is what keeps the
 * fresh-auth layer from collapsing into the session layer. The caller is
 * responsible for verifying the user actually proved control via `mechanism`
 * BEFORE calling, same contract as `issueFreshAuthToken`.
 */
export async function issueSessionFreshAuthToken(
  username: string,
  mechanism: FreshAuthMechanism,
): Promise<IssuedSessionFreshAuth> {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const issuedAt = Date.now();
  const idleExpiresAt = issuedAt + SESSION_FRESH_AUTH_IDLE_SECONDS * 1000;
  const absoluteExpiresAt = issuedAt + SESSION_FRESH_AUTH_ABSOLUTE_SECONDS * 1000;
  const entry: StoredEntry = {
    username,
    mechanism,
    issued_at: issuedAt,
    kind: 'session',
    idle_expires_at: idleExpiresAt,
    absolute_expires_at: absoluteExpiresAt,
  };
  // The storage tier expires the entry at whichever deadline lands first, so
  // the cap is enforced by the tier as well as by the consume-side check.
  const effectiveExpiresAtMs = Math.min(idleExpiresAt, absoluteExpiresAt);
  // ISO-8601 strings per the documented wire contract — see IssuedFreshAuth
  // doc-comment above for why epoch-seconds breaks the SPA cache.
  const expiresAt = new Date(effectiveExpiresAtMs).toISOString();
  const absoluteExpiresAtIso = new Date(absoluteExpiresAt).toISOString();

  // Write to memStore as a backup whenever Redis-issuance succeeds (same
  // recovery rationale as `issueFreshAuthToken`). Storing the token only in
  // Redis on the happy path means that if Redis flaps between issue and
  // consume, the consume side falls through to memStore.get(token) → empty →
  // spurious 'expired' 401 (the user just authenticated). With the backup
  // write, a Redis-down consume can recover the entry from memStore. This block
  // is NOT dead code in the Redis-success branch — it is the recovery path for
  // a flap between issue and consume.
  memStore.set(token, { entry, expiresAt: effectiveExpiresAtMs });

  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      await redis.set(
        KEY_PREFIX + token,
        JSON.stringify(entry),
        'PX',
        Math.max(1, effectiveExpiresAtMs - issuedAt),
      );
    } catch (err) {
      logger.warn(
        { err, username, event: 'fresh_auth.redis_set_failed' },
        'Falling back to in-memory store for session fresh-auth token',
      );
      // memStore was already populated above — the token survives the
      // Redis-write failure.
      return { token, expires_at: expiresAt, absolute_expires_at: absoluteExpiresAtIso, mechanism };
    }
    // Index the token under its owner so session invalidation can find it. Best
    // effort and deliberately AFTER the entry write: a missing index costs a
    // window that outlives a password reset by at most the cap, whereas failing
    // the mint on an index error costs the user their re-auth outright. The
    // index key's own expiry matches the cap so a crashed process cannot leave
    // it accumulating.
    try {
      // One round-trip, so the pair cannot half-apply. An `SADD` that lands
      // while a following `EXPIRE` times out would leave the index key with no
      // TTL at all, growing without bound for the life of the deployment.
      //
      // `NX` on the EXPIRE arms the TTL at creation and never pushes it
      // forward. A plain EXPIRE re-arms the full cap on every mint, so an
      // account that re-authenticates at least once per window keeps the key
      // alive forever while its members only accumulate — the TTL that was
      // supposed to bound the index would never be reached by exactly the
      // accounts whose index grows. The cost of `NX` is that a window minted
      // late in the key's life loses its index membership when the key expires,
      // so the sweep will not find it — acceptable precisely because the sweep
      // is no longer the authoritative half of invalidation (see
      // `invalidateSessionFreshAuthTokens`); the revocation epoch closes that
      // window on its next consume regardless.
      const indexKey = USER_SESSION_INDEX_PREFIX + username;
      const replies = await redis
        .multi()
        .sadd(indexKey, token)
        .expire(indexKey, SESSION_FRESH_AUTH_ABSOLUTE_SECONDS, 'NX')
        .exec();
      // `exec()` RESOLVES with a `[err, reply]` tuple per queued command; a
      // per-command failure does not reject, so the catch below never sees it.
      // Surface it here or the whole error class is silent, and a window whose
      // index write failed is unreachable by the invalidation sweep.
      for (const [cmdErr] of replies ?? []) {
        if (cmdErr) throw cmdErr;
      }
    } catch (err) {
      logger.warn(
        { err, username, event: 'fresh_auth.session_index_write_failed' },
        'Session fresh-auth token not indexed for invalidation',
      );
    }
  }

  return { token, expires_at: expiresAt, absolute_expires_at: absoluteExpiresAtIso, mechanism };
}

/**
 * Close every open session-kind window for `username`.
 *
 * `accounts.sessions_invalidated_at` (`agents/docs/ARCHITECTURE.md` § 6.7)
 * revokes bearer JWTs. On its own that leaves a live broadcast window standing:
 * a password reset or recovery that does not also close the window has not
 * actually cut off the compromised session. Every writer of
 * `sessions_invalidated_at` MUST call this.
 *
 * This sweep is the storage-reclamation half of invalidation, NOT the
 * authoritative half. The authoritative close is the revocation-epoch check in
 * `consumeSessionWindow`: the caller stamped `sessions_invalidated_at` in
 * Postgres, `verifyHiveSignature` reads it back on every later request, and any
 * window whose `issued_at` precedes it is rejected whether or not this function
 * managed to remove it. That split is deliberate, because every leg of this
 * sweep is best-effort in a way a security guarantee cannot be: the per-user
 * index can be missing a token whose index write failed, a consume already in
 * flight can re-plant an entry into the in-memory tier after the sweep has
 * passed it, and an unreachable Redis leaves the canonical tier untouched
 * entirely. What this function buys is that a dead window stops occupying
 * storage, rather than lingering to its cap.
 *
 * Both storage tiers are swept. The in-memory tier is scanned directly (the map
 * is process-local and small). The Redis tier is swept via the per-user index
 * written at mint; consent-op proofs are deliberately NOT swept — they are
 * target-bound, single-use, and outlive the reset by at most
 * `FRESH_AUTH_TTL_SECONDS`.
 *
 * Never throws. A Redis failure here must not fail the password reset that
 * triggered it: the in-memory sweep has already run, the revocation epoch
 * closes every surviving window on its next consume, the revoked JWT alone
 * makes a surviving proof inert (the consume binds the proof to the
 * authenticated username), and the absolute cap bounds what survives. The
 * failure is logged so an operator can correlate it.
 */
export async function invalidateSessionFreshAuthTokens(username: string): Promise<void> {
  // Redis first, the in-memory tier last. Both orders close the window in the
  // quiet case, but a consume already in flight can re-plant an entry in the
  // in-memory tier after this function has passed it, so the in-process delete
  // has to be the final act. That narrows the race; it does not close it, and
  // nothing in this function does. The re-planted copy is rejected on its next
  // consume by the revocation-epoch check in `consumeSessionWindow`, which is
  // the guarantee this sweep is not able to provide.
  //
  // The Redis leg carries its own catch so a failure there cannot skip the
  // in-memory sweep below. Ordering the tiers is a narrowing; letting an
  // unreachable Redis abort the one tier this process fully controls would be a
  // regression.
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      const indexKey = USER_SESSION_INDEX_PREFIX + username;
      const tokens = await redis.smembers(indexKey);
      // Chunked rather than spread in one call. `del(...members)` turns every
      // member into a separate argument, and a large enough index reaches the
      // engine's argument limit and throws `RangeError` — the sweep would BREAK
      // rather than degrade, precisely for the accounts with the most open
      // windows. The chunk size is a plain constant: any value well under the
      // limit works, and one round-trip per 500 members is negligible against a
      // password reset.
      for (let i = 0; i < tokens.length; i += INVALIDATE_DELETE_CHUNK) {
        const chunk = tokens.slice(i, i + INVALIDATE_DELETE_CHUNK);
        await redis.del(...chunk.map((t) => KEY_PREFIX + t));
      }
      await redis.del(indexKey);
    } catch (err) {
      logger.warn(
        { err, username, event: 'fresh_auth.session_invalidate_failed' },
        'Failed to invalidate outstanding session fresh-auth windows in Redis',
      );
    }
  } else {
    // Not a successful no-op. A process that restarted since the window was
    // minted holds no in-memory copy either, so nothing is swept anywhere and
    // the canonical entry keeps authorizing until its cap. The operator
    // investigating a reset that did not stick needs this line to exist.
    logger.warn(
      { username, event: 'fresh_auth.session_invalidate_skipped' },
      'Redis unavailable during session fresh-auth invalidation; only the in-process tier was swept',
    );
  }

  // Never throws. The callers are password-reset and recovery handlers whose
  // account mutation has already committed: rejecting here would tell the user
  // the reset failed when it succeeded, and they would retry with a password
  // that is no longer current. The catch spans the sweep rather than guarding
  // individual lines, so the contract is structural.
  try {
    for (const [token, stored] of memStore) {
      if (stored.entry.kind === 'session' && stored.entry.username === username) {
        memStore.delete(token);
      }
    }
  } catch (err) {
    logger.warn(
      { err, username, event: 'fresh_auth.session_invalidate_failed' },
      'Failed to sweep in-process session fresh-auth windows',
    );
  }
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

/** What one consume surface will accept. Every surface reads the same storage
 *  and runs the same structural validation; they differ only in which kinds are
 *  admissible and whether a consent-op entry's target is checked.
 *
 *  The three surfaces in use:
 *  - Consent-op broadcast and the per-user critical actions (settings, admin,
 *    accreditation metadata): `{ expectedTargetHash: <hash>, acceptSession:
 *    false }`. Strict — a target-less session proof cannot be redirected onto a
 *    consent op.
 *  - Non-consent broadcast: `{ expectedTargetHash: null, acceptSession: true }`.
 *    Session proofs are the intended factor; a consent-op proof is
 *    cross-kind-accepted because it is strictly MORE proof for the same user.
 *  - Upload-token: `{ expectedTargetHash: <ipfs_upload hash>, acceptSession:
 *    true }`. A live session proof already authorizes arbitrary broadcasts for
 *    the rest of its window, so an upload is not a wider grant than the holder
 *    already has; the per-file integrity binding lives in the returned upload
 *    token rather than in the fresh-auth proof. A consent-op proof still has to
 *    be the `ipfs_upload`-targeted one, so a proof minted for `change_email`
 *    cannot be redirected here. */
interface FreshAuthConsumeSurface {
  expectedUsername: string;
  /** A 64-char lowercase hex hash the consent-op entry's `target_hash` must
   *  equal, or `null` to accept a consent-op entry without a target check.
   *  `null` is the deliberate cross-kind accept; a malformed string is a caller
   *  bug and rejects with `target_mismatch` (closed-default) rather than
   *  skipping the bind. */
  expectedTargetHash: string | null;
  /** Whether a session-kind entry is admissible here. When false a session
   *  entry rejects with `kind_mismatch` and is left intact — burning it would
   *  let anyone holding the token close the owner's window. */
  acceptSession: boolean;
  /** Epoch-ms of the account's `sessions_invalidated_at`, or `null` when the
   *  account has never had its sessions revoked. A session window whose
   *  `issued_at` is at or before this instant is dead regardless of what the
   *  storage tiers still hold: it predates the reset or recovery that revoked
   *  the account's sessions.
   *
   *  This is the authoritative half of session invalidation.
   *  `invalidateSessionFreshAuthTokens` sweeps the tiers so a dead window stops
   *  costing storage, but the sweep is best-effort — it can miss a window whose
   *  index entry never landed, one re-planted by a consume that was already in
   *  flight, or every window at all when Redis is unreachable. The epoch comes
   *  from the same Postgres row the revoking mutation committed, so it cannot
   *  be lost the same way.
   *
   *  `undefined` means "no epoch known" and applies no cut-off. That is the
   *  no-app-pool case, where `verifyHiveSignature` skips its own JWT revocation
   *  check for the same reason: there is nothing to ask.
   *
   *  Required, not optional, even though `undefined` is an admissible value. As
   *  an optional field a surface reached the no-cut-off branch by silence, and
   *  the omission presented as nothing anywhere: the best-effort sweep still
   *  closes most windows, every test still passes, and the only thing that
   *  changed is that a window minted before a password reset keeps authorizing
   *  broadcasts until its cap. Required-and-nullable makes the no-epoch posture
   *  something each surface has to write down. The type system stops there,
   *  since it cannot say that the value passed must be the request's epoch
   *  rather than a literal `undefined`; that half is the consume-side canary
   *  under `tests/eslint/`.
   *
   *  `consumeFreshAuthToken` passes `undefined`: a consent-op entry carries no
   *  window to revoke, because those proofs are single-use, target-bound, and
   *  lapse within `FRESH_AUTH_TTL_SECONDS`, which puts them outside both the
   *  epoch cut-off and `invalidateSessionFreshAuthTokens`.
   *  `consumeFreshAuthProof` builds one surface for both of its modes and
   *  always passes the request's epoch: load-bearing when `acceptSession` is
   *  on, inert when it is off. */
  sessionsInvalidatedAtMs: number | null | undefined;
}

/** A stored entry after structural validation, with the per-kind fields
 *  narrowed to what that kind guarantees. */
type ValidatedEntry =
  | {
      kind: 'consent_op';
      username: string;
      mechanism: FreshAuthMechanism;
      target_hash: string;
    }
  | {
      kind: 'session';
      username: string;
      mechanism: FreshAuthMechanism;
      issued_at: number;
      idle_expires_at: number;
      absolute_expires_at: number;
    };

/**
 * Consume a consent-op fresh-auth token. Returns `{ valid: true, mechanism }`
 * exactly once per issued token; subsequent calls return
 * `{ valid: false, reason: 'expired' }` because the entry was burned.
 *
 * The burn is arbitrated by the storage tier that holds the entry (Redis `DEL`
 * reply count, or the in-memory `Map.delete` return value), and serialized
 * across tiers by `inFlightConsumes` so a Redis flap cannot split two
 * concurrent callers into two winners.
 *
 * Consume requires `expectedTargetHash` (computed by the caller from the actual
 * gated op being authorized). A token minted for one (action, paper) target
 * cannot authorize a different target. Closed-default: a missing or non-hex
 * `expectedTargetHash` rejects with `target_mismatch` rather than skipping the
 * check, so a caller that doesn't supply a well-formed hash cannot accidentally
 * bypass the bind.
 *
 * A session-kind entry presented here rejects with `kind_mismatch` and is left
 * intact: session proofs do NOT authorize consent ops. The reverse direction is
 * accepted, see {@link consumeSessionFreshAuthToken}.
 *
 * The route layer rejects the broadcast on any non-valid outcome.
 */
export async function consumeFreshAuthToken(
  token: string | undefined,
  expectedUsername: string,
  expectedTargetHash: string,
): Promise<FreshAuthVerifyResult> {
  return consumeFreshAuthTokenForSurface(token, {
    expectedUsername,
    expectedTargetHash,
    acceptSession: false,
    // No window to revoke: a consent-op entry is single-use and target-bound
    // and lapses within its own TTL, so it sits outside both the revocation
    // sweep and the epoch cut-off. Written out rather than left off, so the
    // posture is a statement instead of an omission.
    sessionsInvalidatedAtMs: undefined,
  });
}

/**
 * Session-surface consume for the non-consent `/api/custody/broadcast` path.
 * Accepts EITHER:
 *
 *   - a `kind: 'session'` entry (target-less, minted by
 *     `issueSessionFreshAuthToken`) that is still inside its window — validated
 *     and SLID forward, not spent, so one re-auth act covers a working stretch;
 *     OR
 *   - a `kind: 'consent_op'` entry (target-bound, minted by
 *     `issueFreshAuthToken`), consumed single-use with no target check.
 *
 * The cross-kind accept is intentional: a consent-op proof is strictly MORE
 * proof than a session proof for the same user (it binds a target on top of
 * proving recent re-auth). Non-consent ops don't need the per-op binding, so
 * the binding is just informational here. The strict direction — session proof
 * on a consent-op surface — is NOT accepted.
 *
 * `sessionsInvalidatedAtMs` is the caller's copy of the account's revocation
 * epoch (`req.hiveSessionsInvalidatedAt`, read from Postgres by
 * `verifyHiveSignature` on the same request). A window minted at or before it
 * is reported `expired`. The parameter is required and explicitly nullable: a
 * caller with no epoch to offer passes `undefined`, which applies no cut-off,
 * but it has to say so. While it was optional, a caller that simply left it off
 * ran with only the best-effort sweep behind it and nothing said so. See
 * {@link FreshAuthConsumeSurface} for why `undefined` is a correct posture and
 * not a fail-open hole.
 */
export async function consumeSessionFreshAuthToken(
  token: string | undefined,
  expectedUsername: string,
  sessionsInvalidatedAtMs: number | null | undefined,
): Promise<FreshAuthVerifyResult> {
  return consumeFreshAuthTokenForSurface(token, {
    expectedUsername,
    expectedTargetHash: null,
    acceptSession: true,
    sessionsInvalidatedAtMs,
  });
}

/**
 * Reason -> HTTP status for a failed fresh-auth consume, in ONE place so the
 * binding-violation vs no-proof-present distinction cannot drift between
 * consumers. `username_mismatch` / `target_mismatch` / `kind_mismatch` are
 * binding violations (a proof minted for a different user or action, or a
 * target-less session proof redirected onto a consent op) -> 403;
 * `missing` / `expired` / `malformed` are "no valid proof present" -> 401. A
 * window that reached either of its deadlines reports `expired`, so a closed
 * window is a 401 the SPA can treat as "re-auth and retry".
 */
export function freshAuthFailureStatus(reason: FreshAuthVerifyFailureReason): 401 | 403 {
  return reason === 'username_mismatch' || reason === 'target_mismatch' || reason === 'kind_mismatch' ? 403 : 401;
}

/**
 * Consume the JWT-path fresh-auth proof on `req` against `targetFn(username)`,
 * returning a binding-aware pass/fail decision (the reason->status mapping lives
 * in `freshAuthFailureStatus`, the single source of truth). On the per-request
 * signature path (`hiveAuthMethod !== 'jwt'`) the request is already fresh, so
 * this returns `{ ok: true }` without requiring a proof.
 *
 * `acceptSession` widens the surface to also admit a session-kind proof inside
 * its window. Off by default: the per-user critical actions (set-password,
 * change-email, delete-account, accreditation-metadata edit, the admin
 * authority actions) each demand their own targeted proof, and a session proof
 * must not be redirected onto them. The upload-token route opts in.
 *
 * Returns the decision rather than sending a response so a handler that must run
 * its OWN eligibility checks BEFORE burning a single-use proof (e.g. the
 * accreditation metadata edit, which checks currently-accredited + not-sanctioned
 * first) can call it inline at the correct point. Handlers whose fresh-auth gate
 * is the first thing they do use the `requireFreshAuth` middleware wrapper.
 */
export async function consumeFreshAuthProof(
  req: Request,
  targetFn: (username: string) => FreshAuthTarget,
  opts: { acceptSession?: boolean } = {},
): Promise<{ ok: true } | { ok: false; status: 401 | 403; reason: FreshAuthVerifyFailureReason }> {
  if (req.hiveAuthMethod !== 'jwt') return { ok: true };
  const username = req.hiveUsername;
  if (!username) return { ok: false, status: 401, reason: 'missing' };
  const proofRaw = (req.body as { fresh_auth_proof?: unknown })?.fresh_auth_proof;
  const proofToken = typeof proofRaw === 'string' ? proofRaw : undefined;
  const expectedTargetHash = computeFreshAuthTargetHash(targetFn(username));
  const result = await consumeFreshAuthTokenForSurface(proofToken, {
    expectedUsername: username,
    expectedTargetHash,
    acceptSession: opts.acceptSession === true,
    // Only meaningful on a surface that admits session proofs; a consent-op
    // entry never carries a window to revoke.
    sessionsInvalidatedAtMs: req.hiveSessionsInvalidatedAt,
  });
  if (result.valid) return { ok: true };
  return { ok: false, status: freshAuthFailureStatus(result.reason), reason: result.reason };
}

/**
 * Express-middleware form of `consumeFreshAuthProof` for handlers whose
 * fresh-auth gate is the first thing they do (no eligibility check that must
 * precede the proof consume). Mirrors `requireFreshAdminAuth`.
 * `message` is the user-facing FRESH_AUTH_REQUIRED string for this action.
 * Handlers that must verify eligibility before burning the proof call
 * `consumeFreshAuthProof` inline instead. `opts.acceptSession` has the same
 * meaning as on `consumeFreshAuthProof`.
 */
export function requireFreshAuth(
  targetFn: (username: string) => FreshAuthTarget,
  message: string,
  opts: { acceptSession?: boolean } = {},
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const decision = await consumeFreshAuthProof(req, targetFn, opts);
    if (decision.ok) {
      next();
      return;
    }
    sendError(res, decision.status, 'FRESH_AUTH_REQUIRED', message, { reason: decision.reason });
  };
}

/**
 * The one consume implementation. Reads the entry NON-destructively, validates
 * its stored shape, then dispatches on kind:
 *
 *   - `consent_op` -> burn (serialized by `inFlightConsumes`, arbitrated by the
 *     storage tier), then check username and target. Burn-before-check
 *     preserves the previous `GETDEL` ordering exactly: a proof presented under
 *     the wrong JWT subject or against the wrong target is spent, not retryable.
 *   - `session` -> check username, check both window deadlines, then SLIDE the
 *     idle deadline forward. Nothing is burned, so the same proof authorizes the
 *     next action.
 *
 * The non-destructive read is what makes the two kinds coexist: the kind is only
 * knowable after reading the stored value, and a `GETDEL`-first read would spend
 * a session window just to discover it was a session window.
 */
async function consumeFreshAuthTokenForSurface(
  token: string | undefined,
  surface: FreshAuthConsumeSurface,
): Promise<FreshAuthVerifyResult> {
  if (!token || typeof token !== 'string' || token.length === 0) {
    return { valid: false, reason: 'missing' };
  }

  const read = await readFreshAuthEntry(token);
  if (!read) return { valid: false, reason: 'expired' };

  const entry = validateStoredEntry(read.raw);
  if (!entry) return { valid: false, reason: 'malformed' };

  if (entry.kind === 'session') {
    // Username binding is checked before the kind verdict so the outcome
    // ordering matches the consent-op path: a proof belonging to someone else
    // is a `username_mismatch` whichever surface it lands on.
    if (entry.username !== surface.expectedUsername) {
      return { valid: false, reason: 'username_mismatch' };
    }
    if (!surface.acceptSession) return { valid: false, reason: 'kind_mismatch' };
    return consumeSessionWindow(token, entry, read.fromMemStore, surface.sessionsInvalidatedAtMs);
  }

  // Consent-op: single-use. The lock makes the read-then-burn pair
  // non-overlapping so a Redis flap cannot hand two concurrent callers a
  // successful burn each; the loser sees the same `expired` a stale replay does.
  if (inFlightConsumes.has(token)) {
    return { valid: false, reason: 'expired' };
  }
  inFlightConsumes.add(token);
  let burned: boolean;
  try {
    burned = await burnConsentOpEntry(token);
  } finally {
    inFlightConsumes.delete(token);
  }
  if (!burned) return { valid: false, reason: 'expired' };

  if (entry.username !== surface.expectedUsername) {
    return { valid: false, reason: 'username_mismatch' };
  }

  if (surface.expectedTargetHash !== null) {
    // Closed-default — a surface that binds a target MUST supply a well-formed
    // expected hash. An empty / malformed argument rejects rather than bypasses
    // the bind, so a caller that doesn't compute the hash can't accidentally
    // re-enable the substitution attack.
    if (!isValidTargetHash(surface.expectedTargetHash)) {
      return { valid: false, reason: 'target_mismatch' };
    }
    if (entry.target_hash !== surface.expectedTargetHash) {
      return { valid: false, reason: 'target_mismatch' };
    }
  }

  return { valid: true, mechanism: entry.mechanism };
}

/** Non-destructive read across both storage tiers. Redis is canonical; the
 *  in-memory map is the flap backup written at issuance, so a Redis outage
 *  between issue and consume does not produce a spurious `expired` on a proof
 *  the user just minted. Returns which tier answered, because a slide served
 *  from the backup tier must not be written back to Redis. */
async function readFreshAuthEntry(
  token: string,
): Promise<{ raw: string; fromMemStore: boolean } | null> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      const raw = await redis.get(KEY_PREFIX + token);
      if (raw) return { raw, fromMemStore: false };
    } catch (err) {
      logger.warn(
        { err, event: 'fresh_auth.redis_get_failed' },
        'Falling back to in-memory lookup for fresh-auth verify',
      );
    }
  }
  const cached = memStore.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return { raw: JSON.stringify(cached.entry), fromMemStore: true };
  }
  return null;
}

/** Burn a consent-op entry across both tiers. Returns whether THIS call was the
 *  one that removed it — the caller treats `false` as `expired`.
 *
 *  The Redis leg is `GETDEL`, not `GET`-then-`DEL`. The read that discovered the
 *  entry's kind is deliberately non-destructive, but the BURN must stay atomic:
 *  with a separate `DEL`, a command that rejects mid-flight (connection drop,
 *  command timeout, retry ceiling) leaves the canonical entry alive while the
 *  in-memory delete still reports a win, and the same proof authorizes a second
 *  critical action once the client reconnects inside the TTL. A non-nil `GETDEL`
 *  reply proves this call is the one that removed it.
 *
 *  The in-memory delete runs unconditionally so a Redis-side burn also clears
 *  the backup (otherwise a sibling consume could replay through the fallback
 *  tier), and so its own return value arbitrates when Redis is down or never
 *  held the entry.
 *
 *  When the Redis leg did not run at all — the client exists but is mid-flap, so
 *  `isRedisAvailable()` is false — the in-memory tier is what arbitrates the win,
 *  and the canonical copy is left standing. A compensating `DEL` is issued to
 *  remove it, guarded on the client's existence rather than its readiness so
 *  ioredis can queue it and flush it on reconnect.
 *
 *  That delete is best-effort, NOT the single-use guarantee. ioredis rejects its
 *  whole offline queue once the reconnect count reaches `maxRetriesPerRequest`,
 *  which on this client's backoff curve is about two seconds — shorter than an
 *  ordinary Redis restart — so a queued delete routinely never runs. The
 *  guarantee therefore comes from `spentConsentOps`: the burn records the proof
 *  as spent BEFORE attempting the delete and clears the record only once the
 *  delete is confirmed, so a proof burned during an outage stays refused however
 *  the delete resolves. `drainSpentConsentOps` retries the delete on a timer to
 *  keep an orphaned key from outliving its ledger entry. */
async function burnConsentOpEntry(token: string): Promise<boolean> {
  // Both reads happen before the first await: `Map.delete` does not hand back
  // the record it removed, and the spent check must observe the state as it was
  // when this caller entered the (already serialized) critical section.
  const memRecord = memStore.get(token);
  const alreadySpent = isConsentOpSpent(token);

  let burnedInRedis = false;
  let redisLegRan = false;
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      burnedInRedis = (await redis.getdel(KEY_PREFIX + token)) !== null;
      redisLegRan = true;
    } catch (err) {
      logger.warn(
        { err, event: 'fresh_auth.redis_getdel_failed' },
        'Redis burn of a consent-op fresh-auth proof failed; the in-memory tier arbitrates and a compensating delete follows',
      );
    }
  }
  const burnedInMemStore = memStore.delete(token);

  if (alreadySpent) {
    // Burned once already, during a flap that left the canonical copy's fate
    // unknown. Whichever tier just answered, this presentation is a replay of a
    // spent proof and must not authorize anything. A `GETDEL` that actually ran
    // is proof the canonical copy is now gone, which retires the ledger entry;
    // otherwise it stays for the drain to finish.
    if (redisLegRan) spentConsentOps.delete(token);
    return false;
  }

  if (!redisLegRan && burnedInMemStore && redis) {
    // Record the burn first. Ordering is the point: if the delete below is the
    // thing that establishes single-use, an outage that outlives the offline
    // queue reopens the replay, whereas a ledger entry written first survives
    // the delete failing, timing out, or being flushed unsent.
    // `burnedInMemStore` implies `memRecord` was present; the fallback is a
    // type-level floor, and a fresh full TTL is the conservative direction
    // (it can only over-guard, never under-guard).
    spentConsentOps.set(token, memRecord?.expiresAt ?? Date.now() + FRESH_AUTH_TTL_SECONDS * 1000);
    try {
      await redis.del(KEY_PREFIX + token);
      spentConsentOps.delete(token);
    } catch (err) {
      logger.warn(
        { err, event: 'fresh_auth.redis_compensating_del_failed' },
        'Compensating Redis delete after an in-memory-arbitrated burn failed; the proof is held spent in-process until the delete lands or it expires',
      );
    }
  }

  return burnedInRedis || burnedInMemStore;
}

/** Validate one stored session window and slide its idle deadline forward.
 *
 *  Three ways a window fails here, all reported as `expired` — the same 401 a
 *  client sees for a proof it never had, which is what lets the SPA treat
 *  "window closed" as "re-auth and retry":
 *
 *   1. The revocation epoch. `sessionsInvalidatedAtMs` is the account's
 *      `accounts.sessions_invalidated_at` as read from Postgres on this same
 *      request; a window whose `issued_at` is at or before it predates the
 *      reset or recovery that revoked the account's sessions. This check is
 *      what makes invalidation authoritative rather than best-effort: it holds
 *      for a window the Redis sweep never reached, one re-planted by a consume
 *      that was in flight while the sweep ran, and one whose per-user index
 *      entry was never written. `issued_at` is carried through every slide
 *      unchanged, so it is a stable anchor for the comparison — the sliding
 *      deadline is not.
 *   2. The sliding idle deadline.
 *   3. The absolute cap.
 *
 *  Both deadlines are checked explicitly even though the storage TTL already
 *  tracks whichever is nearer. The TTL is a second-granular derived value; the
 *  cap is the security-relevant half of the design and the easiest thing to
 *  implement in a way that silently never fires, so it gets its own check
 *  against the stored value.
 *
 *  The slide is clamped to the cap, so no amount of activity moves the window
 *  past it. */
async function consumeSessionWindow(
  token: string,
  entry: Extract<ValidatedEntry, { kind: 'session' }>,
  fromMemStore: boolean,
  sessionsInvalidatedAtMs: number | null | undefined,
): Promise<FreshAuthVerifyResult> {
  const now = Date.now();
  if (typeof sessionsInvalidatedAtMs === 'number' && entry.issued_at <= sessionsInvalidatedAtMs) {
    // Known dead, and the tiers still hold it — drop it so a window the sweep
    // missed stops occupying storage and index membership until its cap.
    dropSessionWindow(token, entry.username);
    return { valid: false, reason: 'expired' };
  }
  if (now >= entry.absolute_expires_at || now >= entry.idle_expires_at) {
    dropSessionWindow(token, entry.username);
    return { valid: false, reason: 'expired' };
  }

  const slidIdle = Math.min(
    now + SESSION_FRESH_AUTH_IDLE_SECONDS * 1000,
    entry.absolute_expires_at,
  );
  const slid: StoredEntry = {
    username: entry.username,
    mechanism: entry.mechanism,
    // Carried through unchanged. The cap lives in `absolute_expires_at`, which
    // the slide never rewrites, and the revocation-epoch comparison above reads
    // this field, so a slide that rewrote it would hand a revoked window a way
    // to age out of its own revocation.
    issued_at: entry.issued_at,
    kind: 'session',
    idle_expires_at: slidIdle,
    absolute_expires_at: entry.absolute_expires_at,
  };
  // Deliberately NOT awaited. The authorization decision is already final and
  // the persist's failure path is already fail-closed (a lost slide leaves the
  // previous, EARLIER idle deadline standing), so awaiting it only adds the
  // Redis round-trip — up to `commandTimeout` against a connected-but-stalled
  // server — to the latency of every vote, comment, post, and review. The
  // in-memory write inside `persistSessionSlide` runs synchronously before its
  // first await, so a concurrent read still observes the slid deadline; only
  // the Redis leg is detached, and Redis staleness can shorten the effective
  // window, never lengthen it.
  void persistSessionSlide(token, slid, now, fromMemStore);
  return { valid: true, mechanism: entry.mechanism };
}

/** Remove one session window that is already known dead — revoked by the
 *  account's invalidation epoch, or past one of its deadlines — from both
 *  storage tiers and from its owner's index.
 *
 *  Fire-and-forget: the caller has already decided to reject, so nothing about
 *  the response depends on this landing, and the entry lapses at its TTL
 *  anyway. What this buys is the index membership: without an `SREM` the
 *  per-user index only ever grows for an account that re-authenticates
 *  regularly, and a sweep over a large index is the failure mode
 *  `invalidateSessionFreshAuthTokens` chunks its deletes to survive. */
function dropSessionWindow(token: string, username: string): void {
  memStore.delete(token);
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return;
  void redis
    .multi()
    .del(KEY_PREFIX + token)
    .srem(USER_SESSION_INDEX_PREFIX + username, token)
    .exec()
    .catch(() => {
      // Nothing to do: the entry lapses at its TTL and the index key at the
      // cap. Deliberately unlogged — this runs on every consume of a closed
      // window, which is an ordinary client-side condition, not an incident.
    });
}

/** Persist a slid window.
 *
 *  The in-memory backup is always refreshed, so a slide served from Redis is not
 *  lost if Redis flaps before the next consume.
 *
 *  The Redis write is skipped entirely when the read came from the in-memory
 *  tier: that tier answers precisely when Redis did not, and writing there would
 *  recreate a key Redis has already expired. For the same reason the write uses
 *  `XX` (set only if the key still exists) rather than a plain `SET` — the key
 *  can lapse between this consume's read and its write, and a plain `SET` would
 *  resurrect it for another full window.
 *
 *  Scope of the `XX`-declined branch, stated precisely because it is easy to
 *  over-claim: it removes the in-memory copy when the canonical Redis entry
 *  turned out to be gone, and it is reachable ONLY on the Redis-served leg. A
 *  consume served by the in-memory tier returns above without ever issuing the
 *  write, so the declined reply cannot arbitrate that case and the unconditional
 *  `memStore.set` above re-plants an entry a concurrent sweep may have just
 *  removed. That re-plant is not what closes the sweep-versus-in-flight-consume
 *  race; the revocation-epoch check in `consumeSessionWindow` is. A re-planted
 *  window predates the invalidation that swept it, so the next consume rejects
 *  it from Postgres regardless of which tier answered.
 *
 *  A failed persist is logged and swallowed: the caller already authorized this
 *  action, and the worst case is that the window does not slide and closes at
 *  its previous idle deadline, which fails closed. Callers do not await this —
 *  see `consumeSessionWindow`. */
async function persistSessionSlide(
  token: string,
  entry: StoredEntry,
  now: number,
  fromMemStore: boolean,
): Promise<void> {
  const effectiveExpiresAtMs = Math.min(
    entry.idle_expires_at as number,
    entry.absolute_expires_at as number,
  );
  memStore.set(token, { entry, expiresAt: effectiveExpiresAtMs });
  if (fromMemStore) return;

  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return;
  try {
    const reply = await redis.set(
      KEY_PREFIX + token,
      JSON.stringify(entry),
      'PX',
      Math.max(1, effectiveExpiresAtMs - now),
      'XX',
    );
    if (reply === null) {
      // `XX` declined: the canonical entry is gone. It lapsed, was evicted, or
      // an invalidation swept it between this consume's read and its write. The
      // in-memory copy this function just refreshed would otherwise outlive it
      // and keep re-authorizing, self-renewing on every consume, so drop it and
      // let the tiers converge on "closed". This converges the tiers on the
      // Redis-served leg only; the authoritative close for a swept window is
      // the revocation-epoch check in `consumeSessionWindow`.
      memStore.delete(token);
    }
  } catch (err) {
    logger.warn(
      { err, event: 'fresh_auth.session_slide_failed' },
      'Failed to persist a session fresh-auth window slide; the window keeps its previous idle deadline',
    );
  }
}

/** Structural narrowing of a stored value, rather than an unsafe
 *  `JSON.parse(raw) as StoredEntry`. Returns `null` for anything this version
 *  does not recognize, which the caller reports as `malformed`. Adding a field
 *  to `StoredEntry` requires extending this guard, so a future refactor that
 *  relaxes the schema is forced to update the consume path explicitly.
 *
 *  Per-kind requirements, all closed-default so a stored shape written by an
 *  older deploy cannot be replayed with a weaker contract:
 *   - `consent_op` MUST carry a well-shaped `target_hash` and MUST NOT carry
 *     window deadlines.
 *   - `session` MUST carry both window deadlines AND a well-shaped `issued_at`,
 *     and MUST NOT carry a `target_hash`. A session entry predating the window
 *     (no deadlines) is rejected rather than treated as unbounded; it costs the
 *     user one re-auth during a deploy and cannot hand out an uncapped window.
 *     A session entry with no usable `issued_at` is likewise rejected rather
 *     than having its revocation anchor reconstructed from the cap. That arm is
 *     unreachable for anything this module mints, since `issued_at` is a
 *     required stored field written at every issue and carried through every
 *     slide, so it costs no re-auth; it exists so a value written by something
 *     other than the mint cannot supply the input to the revocation
 *     comparison.
 *   - An entry with no `kind` at all predates the discriminator and is read as
 *     `consent_op`, so the target-bind check still fires. */
function validateStoredEntry(raw: string): ValidatedEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { username?: unknown }).username !== 'string' ||
    !isFreshAuthMechanism((parsed as { mechanism?: unknown }).mechanism)
  ) {
    return null;
  }
  const username = (parsed as { username: string }).username;
  const mechanism = (parsed as { mechanism: FreshAuthMechanism }).mechanism;

  const rawKind = (parsed as { kind?: unknown }).kind;
  let kind: FreshAuthKind;
  if (rawKind === undefined) {
    kind = 'consent_op';
  } else if (isFreshAuthKind(rawKind)) {
    kind = rawKind;
  } else {
    return null;
  }

  const rawTargetHash = (parsed as { target_hash?: unknown }).target_hash;
  const rawIdle = (parsed as { idle_expires_at?: unknown }).idle_expires_at;
  const rawAbsolute = (parsed as { absolute_expires_at?: unknown }).absolute_expires_at;

  if (kind === 'consent_op') {
    if (!isValidTargetHash(rawTargetHash)) return null;
    if (rawIdle !== undefined || rawAbsolute !== undefined) return null;
    return { kind, username, mechanism, target_hash: rawTargetHash };
  }

  if (rawTargetHash !== undefined) return null;
  if (!isEpochMs(rawIdle) || !isEpochMs(rawAbsolute)) return null;
  const rawIssuedAt = (parsed as { issued_at?: unknown }).issued_at;
  // Closed-default, the same posture as the two deadline guards above.
  // `issued_at` is the revocation ANCHOR, not metadata: `consumeSessionWindow`
  // compares it against the account's `sessions_invalidated_at` epoch, and the
  // slide carries it through unchanged, which is what keeps that comparison
  // stable while the idle deadline moves. Reconstructing a missing or non-epoch
  // value from `absolute_expires_at` minus the cap would let this module invent
  // the input to its own revocation decision, and the reconstruction is unsound
  // in both directions: `isEpochMs` admits any finite positive deadline, so a
  // planted far-future cap yields a mint instant no revocation epoch can reach,
  // and shrinking `SESSION_FRESH_AUTH_ABSOLUTE_SECONDS` would reconstruct an
  // entry as minted LATER than it was, ageing it out of a revocation that
  // already covered it. Rejecting costs nothing: every writer sets the field,
  // and the reject surfaces as the same re-auth 401 a closed window produces.
  if (!isEpochMs(rawIssuedAt)) return null;
  return {
    kind,
    username,
    mechanism,
    issued_at: rawIssuedAt,
    idle_expires_at: rawIdle,
    absolute_expires_at: rawAbsolute,
  };
}

/** Test-only hook: clears the in-memory fallback store and the spent-consent-op
 *  ledger. Not exposed to route handlers. The ledger is cleared alongside the
 *  store because both are keyed by token and both outlive a single consume: a
 *  suite that reuses a token across cases would otherwise inherit a previous
 *  case's burn. */
export function _resetFreshAuthMemStoreForTests(): void {
  memStore.clear();
  spentConsentOps.clear();
}

/** Test-only hook: returns the current size of the in-flight consume lock set.
 *  Used by the consent-op concurrency test to pin the `try/finally` discipline
 *  structurally: after the burn resolves — including when it throws — the set
 *  MUST be empty. Without this hook the test can only assert wire-shape
 *  outcomes, which collapse the lock-held branch into the already-burned branch
 *  (both return `expired`) and admit a `finally`-removal mutation.
 *
 *  The lock is consent-op-only by design, so this hook is also how the session
 *  path proves it does NOT serialize: concurrent session consumes leave the set
 *  untouched and both succeed. */
export function _getInFlightConsumesSizeForTests(): number {
  return inFlightConsumes.size;
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
