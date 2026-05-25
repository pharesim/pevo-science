---
title: Recovery-flow defenses against the seed-phrase-holder are mostly non-load-bearing
date: 2026-05-25
category: conventions
module: backend/recover
problem_type: convention
component: authentication
severity: medium
applies_when:
  - "triaging /ce-code-review findings on /recover, /custody, /settings, or any light-account key-bearing endpoint"
  - "evaluating race/TOCTOU/dispute-defense findings whose threat model assumes the attacker holds the seed phrase"
  - "deciding whether a proposed /recover hardening is load-bearing security or recoverability UX"
related_components:
  - authentication
tags: [threat-model, seed-phrase, light-accounts, recovery, triage, code-review, dismissal-rationale]
---

# Recovery-flow defenses against the seed-phrase-holder are mostly non-load-bearing

## Context

On 2026-05-25, the architect ran `/ce-code-review` on the PEvO `/recover` two-phase memo-key recovery flow (`backend/src/routes/auth.ts` and the `pending_recovery` staging table). The persona fan-out (correctness, security, adversarial, reliability) produced ~9 findings clustered around race conditions, TOCTOU windows, and dispute-defense gaps — superseding-DELETE clobbers of in-flight DISPUTED rows, phase-2 double-consume races, SELECT-then-UPDATE windows missing `AND upgraded_at IS NULL`, dispute-vs-verify TOCTOU, concurrent phase-1 supersession at READ COMMITTED, terminal-marking gaps on 409 branches, ORCID-then-seed chain interactions, phase-2 message-body distinguishability, and non-idempotent dispute audit rows.

The architect dismissed all ~9 under a single rationale: an attacker who already holds the seed phrase has full account access on-chain via client-derived keys, so platform-side defenses inside `/recover` that try to prevent the seed-phrase holder from "winning" are not load-bearing — the attacker has a strictly cheaper out-of-band path.

Without this rationale captured as a reusable convention, every future architect re-triages from scratch every time a reviewer surfaces a TOCTOU or race finding on the recovery family, the custody upgrade flow, or any account-state-defense path. The 2026-05-25 pass alone burned meaningful tokens defending the wrong threat model nine times in one sitting.

## Guidance

When a `/ce-code-review` finding lands on the recovery / custody / account-state-defense surface and proposes hardening a defense against an attacker holding the seed phrase, the **default recommendation is dismiss** if and only if ALL FOUR criteria hold:

1. The defense **gates on or follows a seed-phrase proof** — a memo-key signature, a mnemonic-derived key signature, or anything proving seed-phrase possession.
2. The defense **protects state A, B, or C** light accounts. NOT state D.
3. The defense **targets an attacker holding the seed phrase** — not a code defect, not a token-grinder, not an account-state-transition bug, not a confused-deputy.
4. The attacker can **already accomplish the equivalent action on-chain directly** by deriving keys from the seed phrase and broadcasting (transfer, key rotation, posting, etc.) without going through the PEvO backend.

If all four hold, the platform-side defense is non-load-bearing because the attacker has a strictly cheaper out-of-band path. Hardening it adds code complexity and reviewer noise without changing the threat model's outcome.

### The underlying invariant

PEvO light accounts (ARCHITECTURE.md § 6.1 states A/B/C) derive ALL keys from the seed phrase client-side. Canonical derivation lives in:

- `backend/src/seed-phrase.ts` `deriveKeysFromMnemonic`
- `frontend/src/hive-keys.js` `deriveHiveKeys`

Both call `PrivateKey.fromLogin(account, mnemonic, role)` with identical args. A backend parity test pins this invariant. The seed phrase is the master-password input — a user can paste their 12-word phrase into Hive Keychain's master-password import field and import the account directly (root `CLAUDE.md` "Account Creation"). The `/recover` endpoint rotates email + `password_hash` + JWT-issuing capability on the platform side; it is convenience UX for the legitimate owner, not a chain-level security primitive.

### Carve-outs — explicitly NOT dismissable under this rationale

- **State D defenses.** Upgraded self-custody accounts have owner/active keys wiped server-side and held client-only. The seed-phrase-holder rationale does not apply at that point. The `/recover` memo-key path's refusal on `upgraded_at IS NOT NULL` is itself load-bearing for exactly this reason.
- **Attackers WITHOUT the seed phrase.** Token-grinders on `/verify`, JWT-without-proof oracle closures, cross-account enumeration via shared-state probes, timing oracles distinguishing valid vs. invalid usernames. These attackers have no on-chain bypass; platform-side defenses are the only defenses.
- **Account-state-transition bugs.** The ORCID-after-upgrade severance gate is load-bearing because it stops an ORCID-only attacker (no seed phrase) from rebinding a state-D account. Transition-correctness is its own class.
- **Forensics / audit-trail integrity.** Audit rows still matter for after-the-fact attribution and dispute resolution even when the swap was "won" on-chain. An idempotency gap that erases evidence is a real finding.
- **GDPR / CNPD posture.** Surviving plaintext PII (e.g., new_email on `pending_recovery` after account deletion) is a data-protection concern grounded in PEvO's Portugal jurisdiction and CNPD supervisory authority, independent of who holds the seed phrase.
- **Legitimate-user UX bugs.** A confusing phase-2 message or misleading error string is still worth fixing for the real token-holder even if the same message also happens to be visible to an attacker.

**Dismissable means default-recommend dismiss, not auto-dismiss.** Per root `CLAUDE.md` "Code Review Findings", the architect surfaces the finding in chat (severity + file:line + one-line rationale), names this convention by reference, and waits for user triage. The convention sets the default; the user owns the decision.

## Why This Matters

**Cost of not having this captured.** Nine findings in one review pass all dismissed under the same one-paragraph rationale. Without a named convention, the next review pass on `/recover`, `/custody/*`, or any account-state-defense path will surface the same class of findings (every TOCTOU, every race, every dispute-defense gap) and the architect will re-derive the rationale from first principles each time — reading `seed-phrase.ts`, reading `hive-keys.js`, reading the parity test, reading ARCHITECTURE.md § 6.1, reconstructing the threat model. That is a multi-thousand-token re-derivation per pass, repeated indefinitely.

**Cost of reviewer noise.** Correctness / security / adversarial / reliability personas correctly identify these race windows. They cannot know the seed-phrase threat model rules them out — that is an architectural judgment, not a code-readable one. A captured convention lets the architect dispatch the findings quickly with a named reason, rather than writing a fresh dismissal paragraph each time.

**Cost of misapplying the convention.** If applied carelessly, this rationale can mask real defects — a state-D regression, a token-grinder vuln, a transition bug, a CNPD violation. That is exactly why the four criteria are explicit and the carve-out list is enumerated. The convention's value depends on the architect actually checking the criteria, not waving them through. The carve-outs are not afterthoughts; they are the load-bearing safety net.

**Cost of defending the wrong threat model.** Code added to harden a non-load-bearing defense is code that future agents read, maintain, and reason about. It also crowds out attention from the carve-out cases (state D, transition bugs, CNPD) where defense actually matters. Naming the convention frees that attention.

## When to Apply

**Triggers** — any of the following invokes this convention:

- `/ce-code-review` on `backend/src/routes/auth.ts` `/recover*` handler family.
- `/ce-code-review` on `/custody/*` routes or any account-state-transition path.
- Findings on dispute flows, recovery staging (`pending_recovery`), or two-phase recovery patterns.
- Any review surfacing race-class / TOCTOU / oracle / dispute-defense findings on a path that follows a seed-phrase proof.
- The root `CLAUDE.md` "Account-state defense review" rule already requires checking defended `(field, field, field)` combinations against ARCHITECTURE.md § 6.1's state enumeration — this convention is the next step once the state set is confirmed to include A/B/C.

**Workflow:**

1. Reviewer (persona subagent or direct review) surfaces a finding on a recovery / custody / account-state-defense path.
2. Architect identifies the threat actor the defense protects against — reads the surrounding code, identifies what proof the route demands, identifies what the attacker would need to bypass the defense.
3. Architect matches against the four criteria. Walk each one explicitly. Do not skip "the attacker can already do this on-chain" — that is the load-bearing claim.
4. Architect checks the carve-out list. State D? Token-grinder? Transition bug? Audit-trail? CNPD? UX?
5. If all four criteria hold AND no carve-out applies, surface the finding in chat with the convention named (e.g., "seed-phrase-holder dispute-defense dismissable") and a one-line rationale. Default-recommend dismiss. Wait for user triage.
6. If any carve-out applies, do NOT dismiss. Hold the finding or escalate as appropriate. Cite the specific carve-out.
7. If the criteria are ambiguous (e.g., it is unclear whether the defense gates on a seed-phrase proof or on a JWT-only access path), default to NOT dismissing — escalate for triage. Ambiguity resolves toward defense.

## Examples

### Good dismissals (from the 2026-05-25 triage)

All four criteria held, no carve-out applied:

- **Phase-1 supersession DELETE clobbers in-flight DISPUTED rows.** Defense gates on memo-key signature (criterion 1). Protects states A/B/C (2). Attacker holds seed phrase (3). Attacker can rotate keys on-chain directly with the derived owner key (4). Dismissed.
- **Phase-2 double-consume race (concurrent same-token verify).** Phase-2 follows successful phase-1 proof, which gated on seed-phrase-derived signature. Same chain of reasoning. Dismissed.
- **Phase-2 upgrade TOCTOU** (SELECT-then-UPDATE without `AND upgraded_at IS NULL`). The SELECT already gated on the row being in the recovery-eligible state; the window only matters if the seed-phrase holder is racing themselves. Dismissed after confirming criterion 2 holds (states A/B/C path).
- **Dispute-vs-verify TOCTOU.** Dispute defense exists to give the legitimate user a window to contest. Against a seed-phrase holder, the contest is moot — the attacker has on-chain control regardless. Dismissed.
- **Concurrent phase-1 supersession not race-safe at READ COMMITTED.** Same reasoning as the supersession DELETE. Dismissed.
- **Phase-2 409 / upgraded / deleted branches do not mark token terminal.** Terminal-marking would prevent token reuse by the seed-phrase holder. Non-load-bearing. Dismissed.
- **Phase-2 message-body distinguishability.** Distinguishability would give an attacker an oracle, but the attacker with the seed phrase needs no oracle. Dismissed.

### Counter-example — NOT dismissed despite landing on `/recover`

- **`pending_recovery` rows survive account deletion with plaintext new_email + argon2 hash.** Surfaced in the same 2026-05-25 triage. The seed-phrase rationale does not apply — this is a data-protection violation regardless of who holds the seed phrase, grounded in PEvO's Portugal jurisdiction and CNPD supervisory authority. Fell under the GDPR/CNPD carve-out. Held pending fixes, not dismissed.

### Hypothetical counter-examples illustrating the other carve-outs

- A finding that `/recover` accepts a JWT-only proof on the upgrade-revoke branch with no signature requirement — fails criterion 1 (no seed-phrase proof gates the action). Do NOT dismiss; this is a security defect per ARCHITECTURE.md § 6.5 invariant #1.
- A finding that `/recover` would allow a state-D account's email to be rotated via memo-key signature — fails criterion 2 (state D, keys are client-only). Do NOT dismiss; the upgrade severance gate is load-bearing.
- A finding that `/recover` fails to record a dispute audit row when the dispute happens during phase-1 supersession — fails the audit-trail carve-out. Even if the swap is moot against a seed-phrase holder, the audit row matters for attribution. Do NOT dismiss.
- A finding that an ORCID-only attacker (no seed phrase, no memo key) can trigger a `/recover` state transition on a non-upgraded account — fails criterion 3 (wrong threat actor). Do NOT dismiss.

## Related

- `agents/docs/solutions/conventions/admin-account-locked-by-hive-create-claimed-account-semantics-2026-05-19.md` — structural sibling: same "Hive-primitive-makes-this-class-of-defenses-non-load-bearing" shape, different invariant (admin authority lock vs light-account key derivation).
- `agents/docs/solutions/conventions/accredited-orcid-is-optional-not-edge-case-2026-05-16.md` — adjacent state-machine lens; ORCID optionality framing.
- `agents/docs/solutions/conventions/auth-gate-revives-pre-existing-read-side-oracle-2026-05-17.md` — adjacent auth-composition lens; oracle closures on auth-gated paths.
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` — meta-triage sibling; self-audit on convention-enforcing fixes.
- `agents/docs/solutions/conventions/architect-hold-block-risk-class-separation-2026-05-07.md` — sibling architect-review process convention.
- `agents/docs/solutions/conventions/real-path-companion-dismissal-criteria-2026-05-11.md` — same template shape (reasoned dismissal with criteria + carve-outs).
- Root `CLAUDE.md` "Account-state defense review" — the upstream rule this convention extends.
- ARCHITECTURE.md § 6.1 (light-account state machine + key derivation invariant), § 6.4 (mechanism matrix Recover row), § 6.5 (invariants).
