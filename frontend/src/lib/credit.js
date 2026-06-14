// Authorship credit display logic (decision β, SPA-side union).
//
// A paper-detail author slot is CREDITED — gets a single "credited" badge plus a
// profile link, the only display distinction (ARCHITECTURE.md § 2: no separate
// "pending" tier) — when EITHER of the two backend-authoritative signals the SPA
// already receives holds for that slot:
//
//   1. `author.consented === true` — Routes 1/2 (root broadcaster, or an anchored
//      co-author whose latest valid op is `author_accept`). This flag is
//      HIVE-KEYED: a hive-less anchored slot (ORCID-only anchor) reads
//      `consented:false` even when the reputation cycle credits it via the
//      attested-ORCID arm, so it stays uncredited HERE and renders plain text —
//      the documented ORCID-anchored edge. Do NOT synthesize a badge from
//      another field.
//   2. an accepted `authorship_claims[]` entry for this slot index — Route 3
//      (a name-only slot bound to a claimer via `approve_authorship`). The
//      backend `consented` flag does not reflect this (the slot has no hive to
//      key on), so the SPA ORs it in.
//
// A PENDING Route-3 claim is NOT credited (no badge, plain text); its state is
// carried by the claim/approve affordances. A hive-less bridge credit with
// neither signal is not credited.

// The claimer (hive handle) of the ACCEPTED Route-3 claim bound to slot `idx`,
// or null when no accepted claim exists for that slot. Used to link a credited
// name-only slot's badge to the bound co-author's profile (the slot itself
// carries no hive).
export function acceptedClaimerForSlot(authorshipClaims, idx) {
  const claims = authorshipClaims || [];
  const claim = claims.find((c) => c.author_index === idx && c.status === 'accepted');
  return claim ? claim.claimer : null;
}

// Is the author at slot `idx` credited for this paper? The union of the two
// signals above.
export function isSlotCredited(author, authorshipClaims, idx) {
  if (author && author.consented === true) return true;
  return acceptedClaimerForSlot(authorshipClaims, idx) !== null;
}

// The hive account whose profile a credited slot's badge links to: the slot's
// own `hive` for Routes 1/2, else the accepted Route-3 claimer. Null when the
// slot is not credited (no badge rendered).
export function creditProfileForSlot(author, authorshipClaims, idx) {
  if (author && author.hive) return author.hive;
  return acceptedClaimerForSlot(authorshipClaims, idx);
}
