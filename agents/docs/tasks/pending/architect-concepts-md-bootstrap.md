# Bootstrap a repo-wide CONCEPTS.md (shared domain vocabulary)

**Owner:** architect
**Created:** 2026-06-15

Create a root-level `CONCEPTS.md` glossary of PEvO's domain vocabulary — the terms that mean
something specific in this codebase that a new engineer (or a fresh agent session) needs defined
to follow tickets, conventions, and code. This is the explicit **repo-wide bootstrap** path of
`ce-compound-refresh`'s CONCEPTS workflow (`create a CONCEPTS.md` intent), NOT a scoped seed.

**Why:** The 2026-06-15 `/ce-compound-refresh` of the admin-auth conventions surfaced qualifying
domain terms (admin roster, admin tier, fresh-auth proof, the singular signer) but `CONCEPTS.md`
does not exist. Seeding it from that narrow admin-auth corner would have produced a lopsided file
that names a corner (admin roles) rather than PEvO's actual core nouns — the vocabulary reference
explicitly says a scoped run "cannot, and should not pretend to" produce a coherent project
glossary. So the bootstrap was deferred to this dedicated repo-wide pass. The store only compounds
value once `docs/solutions/` entries and `CLAUDE.md` can cite shared terms without redefining them.

## How to run

Invoke `/ce-compound-refresh` with the bootstrap intent (e.g. "create a CONCEPTS.md / build the
concept map"), which seeds the whole project's declared domain model rather than one area. Hold the
qualifying bar conservatively — clear core nouns in, borderline/implementation terms out.

## Scope — seed the project's core domain nouns

Derive from the declared domain model (`agents/docs/ARCHITECTURE.md`, `hive-schemas.md`,
`reputation-algorithm.md`, the core backend types, and root `CLAUDE.md`). Candidate core nouns
(the bootstrap decides final membership against the qualifying bar — this list is a starting point,
not a mandate):

- Paper / publication, Review (structured evaluation), Comment, Vote
- Accreditation, Sanction (sticky), Vouch, Web of Trust (WoT) / live-threshold membership
- Reputation (computed, cycle), authorship slot / co-author claim, bridged paper
- Account states: light account vs self-custody; the BIP39-derived key set
- Admin roster, admin tier (`admin` / `super_admin` / `root`), the singular signer
  (`config.hiveAdminAccount`)
- Fresh re-auth proof (§6.4), anonymous-review proxy, IPFS CID, `APP_TAG`

Each entry: one-sentence domain definition (what it is, what distinguishes it from neighbors), a
second paragraph only for non-obvious lifecycle/ownership rules. NO implementation specifics (file
paths, class names, table names), NO current-config values (thresholds, counts — state the
behavior, not the number), NO status/owner/date metadata. Cluster by domain relationship.

## Acceptance criteria

- [ ] `CONCEPTS.md` exists at repo root with the standard `ce-compound-refresh` preamble and the
      project's core domain nouns seeded (count driven by what genuinely qualifies, not a target).
- [ ] No entry leans on an undefined project-specific sibling term (add the sibling or rephrase).
- [ ] Entries follow the glossary rules: definition-only + optional rules paragraph; no
      file/class/threshold/date leakage.
- [ ] Discoverability: root `CLAUDE.md` surfaces `CONCEPTS.md` (one line, e.g. "shared domain
      vocabulary — read when orienting to the codebase or before discussing domain concepts"),
      mirroring how it already surfaces `agents/docs/solutions/`.
- [ ] Add `CONCEPTS.md` to the architect's "Files You Own" list and the `commit-msg`
      `allowed_for_agent()` architect zone if it should be architect-owned (decide at bootstrap).

## References

- `ce-compound-refresh` skill — `references/concepts-vocabulary.md` (the qualifying bar, seed goal,
  per-entry shape) and the "CONCEPTS.md bootstrap requests" path.
- `agents/docs/ARCHITECTURE.md`, `agents/docs/hive-schemas.md`,
  `agents/docs/reputation-algorithm.md` — the declared domain model to seed from.
