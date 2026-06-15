# Concepts

> Shared domain vocabulary for this project: entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Platform & Identity

### Hive-native

PEvO's foundational design stance that its content objects ARE native Hive operations (papers are Hive posts, reviews and comments are Hive comments, votes are Hive votes) used as the chain was designed, rather than custom records that wrap or merely store data on chain.
*Avoid:* chain-native.

PEvO-specific structure is layered on as app-tagged metadata and platform operations on top of native operations, never as a replacement for them; this is why content stays broadcastable and readable from any Hive client and why the chain is the single source of truth.

### APP_TAG

The configurable app-identity string that stamps a Hive post or operation as belonging to PEvO, serving at once as the parent of top-level posts, the identifier on platform operations, the namespace for PEvO-specific metadata, and the primary content tag.
*Avoid:* app tag, app identity tag.

Distinct alpha, beta, and production instances run under distinct APP_TAG values, giving each a fully separate on-chain data space; the running version is recorded only in metadata, so paper identity survives version bumps. Stamping content with APP_TAG is necessary but not sufficient for it to count as a PEvO object: object identity additionally requires author vouching (see PEvO Object).

### Platform Operation (custom_json)

The Hive operation type PEvO repurposes as the carrier for platform actions that have no native Hive equivalent, each stamped with the APP_TAG identifier and labeled with the kind of action it represents.

It carries the actions that cannot ride on a native comment or vote, for example: accreditation and revocation attestations, web-of-trust vouches, anonymous-review attestations, authorship claim, approval, and revocation, reputation-weight and platform-parameter updates, and votes cast after the native Hive payout window has closed. Each action must be signed by the account authorized for that kind of action: the platform authority (the signer), the anonymous-review proxy account, or the acting user.

### HAF SQL

The PostgreSQL-based, fully indexed view of all Hive chain data (Hive Application Framework) that PEvO reads for every listing, search, and reputation query, as distinct from a Hive API node, which PEvO uses only to broadcast writes and for a small set of targeted real-time reads.
*Avoid:* HafSQL, HAF, HAF query layer.

HAF SQL is the read path; the Hive API node is the write path plus narrow real-time reads. Anything affecting reputation, ranking, or rating reads from HAF SQL only; when HAF is unavailable, dependent endpoints fail closed or return empty rather than degrading silently.

### Hive API node

A live Hive blockchain RPC endpoint PEvO uses to broadcast signed transactions and to perform a small enumerated set of real-time reads (such as fetching a public key, checking account availability, or fetching content for previews and self-review guards), as opposed to HAF SQL, which serves all aggregated and indexed reads.

Multiple nodes are configured for resilience and cycled through on failure. Its targeted reads never feed reputation or rankings; those always come from HAF SQL.

### IPFS CID

The content-addressed identifier returned when a paper PDF or supplementary file is pinned to IPFS, stored in the Hive post's metadata so the large file lives off-chain while the chain holds only its reference and content hash.
*Avoid:* CID.

Papers above the on-chain size limit upload their file to IPFS and record its CID in metadata; short papers carry their full text in the post body and have no CID. Supplementary materials such as datasets and code are pinned the same way under their own CIDs. Every CID that has appeared in an admitted chain post must be retained by community pinners for the paper's lifetime, and each paper version preserves its own CID; unpinning is permitted only on retraction.

### Pinner

A community-operated IPFS node that discovers PEvO paper CIDs by querying HAF SQL filtered on APP_TAG and pins them, keeping every referenced file retrievable for the paper's lifetime.
*Avoid:* IPFS pinner, community pinner.

Pinners discover what to retain entirely through HAF; there is no path from PEvO to a pinner, so a change to the HAF discovery query shape is a breaking change for community deployments. Unpinning a CID is permitted only once the owning paper is retracted.

### Anonymous-review proxy account

The single platform-managed Hive account that posts review comments on behalf of accredited reviewers who choose to stay anonymous, so the review carries no on-chain link to its real author.
*Avoid:* anon account, anon proxy.

The reviewer-to-review mapping is stored encrypted off-chain, is time-limited, and is used only for abuse prevention; on chain only an attestation appears, proving an accredited reviewer authored the review without naming them, and after a configured expiry the decryption key is permanently deleted. Reviews from this account are marked so they can be distinguished from directly-accredited reviews.

## Content & Evaluation

### PEvO Object

Any paper, review, comment, or bridge paper that counts as genuine PEvO content because it is author-vouched by an appropriately accredited (or platform) Hive account, as opposed to a Hive comment that merely carries PEvO-shaped metadata but was authored by a non-vouched account.
*Avoid:* PEvO content, vouched object.

Object identity is determined by author vouching, not by metadata claim; this is the read-gate that makes non-vouched, app-tagged Hive content invisible to PEvO surfaces, and it is distinct from the write-gate that restricts which accounts the platform will help author content. Reviews are vouched by accredited reviewers or the anonymous-review proxy account; bridge papers by the bridge account.

### Paper

A scientific publication on PEvO, realized as a native top-level Hive post (a post with no parent, parented to the APP_TAG) that identifies itself as a paper, as distinct from a bridge paper (an externally sourced mirror) or any non-PEvO Hive post.
*Avoid:* post, publication, article, native paper.

A paper counts as a PEvO object by author vouching (an accredited author) plus being self-identified as a paper, not by metadata claim alone; an unaccredited account posting paper-shaped metadata does not produce a PEvO paper. Its body holds the abstract followed by optional full Markdown text (an abstract-only paper, whose full text lives in an uploaded PDF, has a body of just the abstract), and large PDFs live on IPFS referenced by CID. Papers are versioned and revisable either in place by the original author (reusing the original post identity) or, by a different editor, through a continuation post.

### Bridge Paper

A paper-class PEvO object that mirrors an existing external preprint (arXiv, bioRxiv, CrossRef, and similar) registered on PEvO for evaluation, distinguished from a native paper by identifying itself as a bridge paper, by a record of its external origin, and by being posted under the platform bridge account rather than by the registering researcher.
*Avoid:* bridged paper, imported paper, preprint mirror.

Bridge papers are immutable after publication (no edit, sync, or update flow) and have no continuations; they never host the PDF and instead link to the external source. The bridge account is the sole consented author, and named author credits that carry no Hive account are hive-less display credits for original-preprint authors who lack a Hive identity. Such name-only or ORCID-only credits bind a Hive identity only through an explicit, deliberate claim flow, never through fuzzy name or ORCID auto-matching.

### Bridge Account

The platform-controlled Hive identity that broadcasts every bridge paper and acts as its sole consented author and as the approver or revoker for its name-only claims.
*Avoid:* bridge writer, bridge identity.

It is the Hive author of bridge posts, not the registering researcher. It is the authorized continuator for the bridge-paper type, though that capability is inert under the immutability policy.

### Review

A structured scientific evaluation of a paper, realized as a native Hive comment on that paper and carrying a multi-dimension numeric rating, which is what distinguishes it from an ordinary discussion comment.
*Avoid:* structured review, evaluation, peer review.

Review identity is gated on accreditation, not on the APP_TAG: an accredited reviewer's structurally valid review broadcast from any Hive client is a valid PEvO review, even without PEvO app metadata. A review may be posted directly by the accredited reviewer or anonymously through the anonymous-review proxy account. The paper version a review applies to is computed at read time from timestamps, not stored on chain, which is what lets the platform flag a review as outdated relative to a newer paper revision.

### Rating

The required multi-dimension scored block (the dimensions methodology, novelty, clarity, and significance, each a bounded integer) carried by a review that turns a Hive comment into a structured review rather than a plain discussion comment.
*Avoid:* score block, rating dimensions.

Every rating dimension is mandatory and must be a well-formed integer in range; a comment that presents as a review but lacks a well-formed rating across all dimensions is not a valid review. The structural gate protects downstream reputation math from malformed values.

### Discussion Comment

An unstructured scientific discussion remark on a paper or on another comment, realized as a native Hive comment that, unlike a review, carries no rating.
*Avoid:* comment, discussion.

Distinguished from a review purely by the absence of a structured rating; it may be parented to the paper or to another comment, forming a thread.

### Vote

An accredited account's endorsement or rejection of a paper or review, cast as a standard signed Hive vote, which feeds both Hive's native rewards and PEvO's reputation computation.
*Avoid:* native vote, Hive vote.

Only votes from accredited accounts affect reputation, vote counts, and ranking; unaccredited votes still move Hive rewards but are ignored in all PEvO computations. A vote's reputation influence scales with the voter's own reputation and the vote's strength. A downvote (negative weight) from an accredited account penalizes the target's reputation rather than adding to it, and can drive a paper's contribution negative down to a floor. Native votes lock after the Hive payout window; after that, and optionally before it, voting and vote changes happen through the re-vote path.

### Re-Vote

A vote or vote change expressed as a PEvO platform operation rather than a native Hive vote, so any accredited account can vote or retract on a paper at any time, including after the native Hive payout window when native votes are locked.
*Avoid:* revote, custom_json vote, post-payout vote.

Valid before or after the payout window and requiring no prior native vote. When both a native vote and a re-vote exist from the same voter on the same paper, the later one by block order wins; a zero weight retracts the vote.

### Citation

A reference from one PEvO paper to another, recorded in the citing paper's metadata, which unless marked as not reputation-relevant contributes to the cited paper's reputation.
*Avoid:* reference, cite.

A citation may be marked as not reputation-relevant (the default is relevant), letting an author cite for context, contrast, or refutation without endorsing the cited work and excluding it from reputation math. Only citations from papers authored by accredited researchers count; self-citations count at a heavily discounted rate, and the total citation contribution is capped.

### Continuation Post

A new Hive post (new identity, carrying a reference to the paper it extends) that continues an existing paper when the editor differs from the original author, as opposed to a same-author in-place edit that reuses the original post identity.
*Avoid:* continuation, continues post.

Continuation posts are excluded from canonical paper listings (recognized by their reference back to the paper they extend) so a paper appears once; a continuation author must already be a claimed author of the continued paper. The displayed paper is the cumulative union across the continuation chain, so a continuation can add but not silently drop authors or earlier versions.

### Retraction

A platform operation marking a paper as retracted, after which the paper remains on chain and reachable by direct URL with a retraction banner but is excluded by default from listings and reputation computation.
*Avoid:* retract paper, retracted paper.

Either the paper author or the platform authority (the signer) may retract, the authority case being for misconduct. Listings can opt back in to including retracted papers. Retraction is also the only state in which a paper's pinned IPFS files may be unpinned.

## Authorship

### Authorship Slot

A single named credit position in a paper's author list that may carry an identity anchor (a Hive handle and/or ORCID) or be name-only, and which a real person binds to themselves to become credited.
*Avoid:* author entry.

Slots are named only at posting (the root post or a continuation post); claim, approval, and accept operations bind a person to an existing slot but never create a new one. A slot's shape, anchored versus name-only, determines which consent route its owner must use to be credited.

### Identity Anchor

The presence of a Hive handle and/or an ORCID on an authorship slot, which establishes who may consent to that slot but never confers credit on its own.
*Avoid:* anchor, slot anchor.

An anchor only routes the consent flow: a slot anchored by a Hive handle equal to the claimant, or by an ORCID matching the claimant's authority-attested ORCID (see Accreditation Method), is consented through the anchored route; a slot with no anchor uses the name-only route. There is no auto-accept from an anchor.

### Name-only Slot

An authorship slot that carries neither a Hive handle nor an ORCID: a pure name display credit whose real owner must claim and be approved (the name-only route) before earning credit.
*Avoid:* name-only display credit, hive-less slot.

Until claimed and approved it is claimed but not consented. Bridge-paper slots for original-preprint authors who lack a Hive identity are name-only (or ORCID-only) and bind a Hive identity only through an explicit, deliberate claim flow, never through fuzzy name or ORCID auto-matching.

### Claimed Author

Anyone whose Hive handle has ever appeared in any admitted chain post's author list for a paper: the append-only historical union that gates who may broadcast continuation posts, distinct from being credited.
*Avoid:* claimed authors set, claimed-pending author.

The claimed set is append-only and can never shrink: a native edit removing a name from one post does not remove them, because the name still appears on the earlier post the union also reads. Membership grants continuation-posting rights but not reputation or citation credit; only resignation or revocation removes consented status, never claimed status.

### Consented Author

A claimed author who has affirmatively registered consent for a paper through one of the consent routes and has not since been demoted: the only set that earns reputation and citation credit and shows the PEvO author badge.
*Avoid:* consented authors set, credited co-author.

Consent is conferred per author and paper and persists across all current and future versions until the author resigns or is revoked; the latest operation wins. The consent routes are root-broadcaster (the account that signed the root post is consented implicitly), anchored-slot accept, and name-only claim-plus-approval. There is no metadata auto-accept and no auto-merge from a name-only display credit.

### Co-author Credit

The rule that every consented author of a paper receives the same full paper reputation score as the posting author (shared, not divided), keyed to the on-chain post identity so a post credited to several people is not multiplied.
*Avoid:* shared co-author credit, authorship credit.

Credit flows only to consented authors and is retroactive: once consented, an author earns the paper's full vote and review history (including pre-consent votes), because scores recompute from scratch each cycle. Self-dealing (any credited author voting on or reviewing their own paper) is excluded from scoring.

### Author Accept

The platform operation a claimed author broadcasts under their own posting key to register consented status on an anchor-bearing slot (the anchored route).
*Avoid:* accept op.

The accepting account is identified by who signs the operation; it names no separate target, so it can only ever accept on the signer's own behalf. It is valid only if the signer matches the slot's Hive or attested-ORCID anchor and the operation is strictly later than the slot's first appearance (anti name-squatting); the latest valid operation per author and paper wins, so a later accept can override a prior resign. Withdrawal from this route is through author resign.

### Author Resign

The platform operation a consented author broadcasts under their own key to withdraw their own consented status, and thus credit, going forward, while remaining in the append-only claimed set.
*Avoid:* resign op.

Always a self-action: the resigning account is whoever signs it, and it names no other target. It removes consented status and the right to broadcast new admitted continuations going forward but does not erase historical contribution; re-acceptance through a later author accept is allowed.

### Claim Authorship

The platform operation an accredited user broadcasts to claim an anchor-less (name-only) slot on a paper, asserting that they are the person the named slot refers to (the first step of the name-only route).
*Avoid:* claim op.

It confers zero credit on its own and must be confirmed by an approve-authorship operation (see Approve Authorship and Consented Author for where credit is conferred). The claim must resolve to a name-only slot in the paper's cumulative author union; a claim resolving to an anchored slot or to no slot grants nothing.

### Approve Authorship

The platform operation the paper's original post author (or the bridge account for bridge papers, or the platform authority as a backstop) broadcasts to confirm a pending name-only claim, binding the claimant's Hive account to the named slot and conferring credit (the second step of the name-only route).
*Avoid:* approve op.

It binds an account to a slot named at posting; it never inserts or appends a new author. Crediting someone not named at posting requires a continuation post that names them first, then a consent route.

### Revoke Authorship

The platform operation that demotes a consented co-author of a name-only, approved claim back to claimed-but-unconsented, usable either by the claimant on their own claim or by the paper author, the bridge account, or the platform authority as a backstop against a bad self-accept.
*Avoid:* revoke-authorship op, co-author revoke.

It is a remedy, never a consent gate: it strips credit going forward, but a later valid consent operation can re-confer credit. It is the only mechanism that lets a third party remove someone else's consented status; no author's continuation can remove another. The anchored-route counterpart for self-withdrawal is author resign.

### Cumulative Author Union

The display-ordered union of author slots across every admitted post in a paper's continuation chain (root plus continuations plus native edits), in first-occurrence order: the slot domain that claim and approve operations resolve against, not the root post's list alone.
*Avoid:* cumulative union, displayed authors list.

It runs on two never-merging tracks, one keyed by Hive handle and one for hive-less display credits, that are never auto-linked by fuzzy name or ORCID match. A name on any post survives in the union (drops are forbidden by construction within a single computation), but the guarantee is per-request, not durable across chain-walk truncation or HAF outages.

### Hive-less Display Credit

An informational author credit for someone with no resolvable Hive account, keyed by ORCID or name on a separate track of the cumulative author union, carrying no self-claim authority and never auto-merged into a Hive identity.
*Avoid:* display-only credit.

The only path from a hive-less display credit to a consented Hive identity is an explicit, deliberate claim flow; read-time or importer-side auto-mapping is forbidden, because a pre-broadcast accept under a colliding handle could otherwise activate retroactively.

## Accreditation & Trust

### Accreditation

The on-chain attestation that a Hive account belongs to a verified researcher, which gates the write path (publishing, reviewing, commenting, voting) while reads stay open to anyone.
*Avoid:* accredit op, accreditation attestation.

Accreditation status is computed live from authority-signed attestation and revocation operations plus the live vouch graph; it is an orthogonal dimension that applies to every account and is computed live rather than persisted as a stored account attribute. The grant operation is re-broadcastable: the earliest one anchors tenure, the latest supplies current profile metadata, and a later grant can re-admit a previously revoked account. An account is accredited only if it is not sanctioned and either its latest grant is authority-pinned or its latest grant is vouch-derived and currently meets the vouch threshold.

### Accreditation Method

The provenance tag on an accreditation grant recording how trust was established, splitting grants into authority-pinned (a deliberate platform attestation such as email, ORCID, or manual verification) versus vouch-derived (granted automatically once the vouch threshold is crossed).
*Avoid:* verification method.

Authority-pinned grants hold status on their own and keep it unless the account is deliberately sanctioned; the vouch-derived method makes status conditional on continuing to meet the live vouch threshold, so the method determines whether an account's standing can silently lapse. A vouch-derived account drops out of membership the instant it falls below the threshold, with no revocation operation, and re-enters automatically when support returns.

### Web of Trust

The graph of vouches among accredited researchers that lets the platform grant accreditation in a decentralized, peer-attested way rather than only through a central authority.
*Avoid:* WoT, trust graph.

It is the mechanism for peer-attested accreditation, complementing authority-pinned grants; the membership it confers is always evaluated live against the current vouch graph rather than pinned at grant time.

### Vouch

An on-chain endorsement broadcast by one accredited researcher attesting to another researcher's credentials, forming an edge in the web of trust.
*Avoid:* endorsement.

A voucher must currently be accredited and cannot vouch for themselves; only vouches from currently accredited researchers count, validated against the live membership view rather than against the accreditation authority whitelist. A vouch can be retracted, and accumulating enough distinct accredited vouches triggers an automatic vouch-derived accreditation grant.

### Retract Vouch

The on-chain operation by which a voucher withdraws a previously issued vouch, removing that edge from the web of trust.
*Avoid:* vouch retraction.

Retracting a vouch that drops a vouch-derived account below the threshold broadcasts no revocation; the account simply stops appearing in the membership set on the next read, and standing returns automatically if vouches recover.

### Vouch Threshold

The minimum number of distinct accredited vouches an account must currently hold to qualify for and retain vouch-derived accreditation.
*Avoid:* WoT threshold.

Crossing it auto-grants a vouch-derived accreditation, and falling below it drops standing live with no revocation. The threshold is checked continuously against the live vouch graph, never frozen at grant time.

### Live-Threshold Membership

The rule that vouch-derived accreditation is recomputed against the current vouch graph on every read rather than fixed at the moment of grant, so standing tracks the present state of support.
*Avoid:* live membership evaluation.

Because membership is live, a below-threshold account is simply absent from the accredited set with no operation broadcast, and a recovered account reappears automatically; this self-healing behavior is what distinguishes vouch-derived standing from the sticky, operation-pinned nature of a sanction.

### Sanction

A deliberate authority action against a bad actor, broadcast as a revocation marked as a sanction, that suppresses accreditation regardless of any vouch support.
*Avoid:* moderation sanction.

A sanction is sticky: while un-lifted, the account is unaccredited no matter what, and only a deliberate authority grant lifts it. No self-service path (re-verifying email or ORCID) and no amount of vouching can re-admit a sanctioned account. On lift, the account's full pre-sanction history counts again, so tenure is preserved across the sanction gap. It is distinct from a threshold drop, which is ordinary, non-sticky loss of standing.

### Revocation

The on-chain operation that withdraws an accreditation, broadcast only as a sanction (a deliberate moderation action) rather than for routine loss of standing.
*Avoid:* accreditation revoke op.

A revocation carrying the sanction marker is sticky and suppresses membership; a revocation lacking that marker is a legacy revoke, treated as a non-sanction and ignored for stickiness. Routine loss of web-of-trust standing produces no revocation at all, so a revocation here always signals deliberate intent or a historical artifact.

### Legacy Revoke

A historical revocation that lacks the sanction marker (carrying a threshold-no-longer-met reason), which membership evaluation treats as a non-sanction and ignores for stickiness.
*Avoid:* non-sanction revoke, threshold-drop revoke.

A legacy-revoked account reverts to ordinary evaluation: a vouch-derived account falls back to live-threshold evaluation, and an authority-pinned account falls back to its latest grant. The presence of a legacy revoke never suppresses membership on its own.

### Accreditation Authority Whitelist

The set of Hive accounts whose accreditation and revocation operations the platform trusts at read time, so that anyone broadcasting a fake attestation under the app's identifier is ignored.
*Avoid:* accreditation authorities, signer whitelist.

The whitelist gates authority operations (grants and revocations) by signer and always implicitly includes the signer account. Vouches are not filtered by this whitelist; they are validated against the live membership view instead. So the whitelist governs who can attest, not who can vouch.

### Active Accreditations

The computed live-membership view of currently accredited accounts that encodes the full membership rule: sanction stickiness, live vouch-threshold gating, and legacy revokes reclassified as non-sanctions.
*Avoid:* live-membership view, sanction-aware membership view.

A non-member (sanctioned, or vouch-derived below threshold) is absent from the view entirely; this is the authoritative reference for deciding whether an account is accredited right now, including vouch eligibility and authorship and ORCID resolution.

### Tenure Anchor

The "accredited since" reference point read from an account's earliest accreditation grant, spanning all history across any sanction gaps, so that metadata edits and post-sanction re-grants never reset standing.
*Avoid:* accredited since, tenure.

Tenure derives from the earliest grant's chain block time, not the re-broadcastable payload timestamp; it is purely a display dimension and does not feed reputation scoring, which is present-tense membership only.

## Reputation

### Reputation

A scientist's computed standing on the platform: a clamped, bounded number derived entirely from public on-chain activity (papers, reviews, citations, accreditation) rather than from any custom token or balance.
*Avoid:* score, rep.

Reputation is never minted, transferred, or held as a balance; it is a pure function recomputed from chain data each cycle, so it cannot be bought, staked, or directly spent. A sanctioned or de-accredited account's reputation collapses to zero.

### Reputation Cycle

The recurring recomputation window over which reputation is recalculated in one deterministic pass, covering a contiguous fixed-size range of Hive blocks rather than a wall-clock duration.
*Avoid:* batch cycle, block cycle, nightly cycle.

Each cycle, except the bootstrap cycle, consumes the prior cycle's scores as voter weights and runs exactly one pass with no convergence iterations; this lagged weighting is how the circular dependency between a voter's weight and their reputation is resolved. Cycles are numbered sequentially from the genesis block, and only data before a cycle's end-block is considered, so results are identical regardless of when the computation runs.

### Bootstrap Cycle

The genesis recomputation pass (and any state with no prior batch scores) in which every accredited voter weights at the maximum unconditionally, because there is no previous cycle to draw weights from.
*Avoid:* bootstrap mode.

On a fresh system with no batch scores yet, on-demand reads also fall back to this equal-weighting behavior until the first batch completes.

### Batch Computation

The process that computes reputation for all target accounts in a single pass per cycle and writes the results to a shared store, as opposed to recomputing any account's score on read.
*Avoid:* batch job, batch run.

Only one instance may run a cycle at a time; the batch periodically checks for new cycles and catches up sequentially if it has fallen behind. The batch is the single source of truth for displayed reputation: readers parse the stored value defensively and surface a zero score on failure, never recomputing at head block.

### Reputation Breakdown

The per-component decomposition of a reputation score into its on-chain inputs (currently a paper score, a review score, a citation score, and an accreditation bonus), stored and returned alongside the total so the score is explainable; the individual components are the score's signals.
*Avoid:* breakdown, components, signals.

### Vote Influence

The effective weight a single accredited vote contributes to a paper or review, equal to the voter's reputation-derived weight multiplied by the vote's strength.
*Avoid:* weighted vote.

For each accredited voter only their latest signal per post counts (one weight per voter per item); an explicit zero-weight retraction removes the vote entirely from influence.

### Voter Weight

The reputation-derived multiplier applied to a voter's votes, scaling their influence by their own standing so highly reputed scientists' evaluations carry more weight; this is the vote-quality mechanism.
*Avoid:* vote weight, voter weighting.

Voters with no prior batch score (a fresh system or the bootstrap cycle) weight at the maximum unconditionally; an active author gets a floored curve above zero, while an account with no contributions gets an unfloored curve approaching zero. The floor is earned by contributing, which is a core anti-sybil property.

### Vote Strength

The continuous magnitude of a vote derived from the absolute Hive vote percentage, ranging from none to full, factored into vote influence independently of the voter's reputation.
*Avoid:* vote magnitude, strength multiplier.

The frontend offers a fixed set of labeled endorsement and concern levels, but the backend reads the raw on-chain weight and computes strength as a continuous value; the labeled tiers are a UI convention, not a backend-enforced enumeration.

### Active Author

An accredited account that has published at least one paper or written at least one non-self review, qualifying it for the higher (floored) voter-weight curve rather than the unfloored newcomer curve.
*Avoid:* contributor, has-contributed account.

This contribution gate is the load-bearing anti-sybil lever: an empty fake account stays on the low unfloored curve until it produces real, downvotable work.

### Anti-Sybil Defense

The set of weighting rules that make mass fake-account voting impractical, principally the contribution-earned voter-weight floor plus downvote penalties, negative-capable paper scores, self-citation discounting, and citation caps.
*Avoid:* sybil resistance.

The keystone is that the higher voter-weight floor is unavailable to accounts that have never published or reviewed, so each sybil would have to produce real, downvotable contributions to gain influence.

### Temporal Decay

The age-based attenuation applied to paper, review, and citation contributions so that older content gradually counts for less, down to a floor and after a grace period.
*Avoid:* decay, age decay.

Decay is computed from a reference timestamp derived from the cycle's end-block rather than wall-clock time, preserving cycle reproducibility; for citations the decay is keyed to the citing paper's age, so old work retains value exactly as long as others keep citing it.

### Quality Multiplier

A per-paper factor between a low floor and one, derived from the average of a paper's structured ratings, that scales the paper's upvote-derived contribution so poorly reviewed papers earn less even with many upvotes.
*Avoid:* quality, quality score.

A paper with no reviews takes the maximum multiplier of one (upvotes speak for themselves); the same quality figure is reused to weight citations by the citing paper's quality.

### Paper Score

The per-paper reputation contribution combining accredited weighted upvotes (capped), the review quality multiplier, and a weighted-downvote penalty, then decayed by age and clamped so a single paper can at most boost or penalize within a fixed band.
*Avoid:* paper reputation, paper contribution.

Self-votes and self-reviews by credited authors are excluded before computation (see Co-author Credit); publishing alone with zero accredited upvotes contributes nothing, and downvotes can drive a paper's contribution negative.

### Review Score

The per-review reputation contribution a reviewer earns from accredited weighted votes on their review, capped and decayed, with no quality multiplier since reviews are not themselves rated.
*Avoid:* review reputation, review contribution.

Anonymous reviews (posted through the anonymous-review proxy account) are excluded from the reviewer's own reputation, since the public poster is not the actual reviewer.

### Citation Score

The capped, quality-and-decay-weighted reputation contribution an author earns from other papers citing their work, where each citation is worth more when the citing paper is itself well received.
*Avoid:* citations contribution.

Only citations marked reputation-relevant count, letting authors cite for context or refutation without boosting the cited author; self-citations are discounted to near zero, and the total citation contribution is capped.

## Accounts & Authentication

### Account State Machine

The enumerated set of reachable steady account states and the documented routes between them, against which all account-state-defending code is reviewed, so that defenses against unenumerated attribute combinations are treated as dead code.
*Avoid:* account states, reachable states model.

Steady states are defined by a fixed set of account attributes: how far signup has progressed, whether a username is set, whether a password has been set, whether an ORCID is linked, the custody mode, and whether the account has been upgraded to self-custody. Some states are transient signup-pending and others are finalized. No code path may produce an account matching no enumerated state, and adding a new state requires updating the canonical reference before the code lands.

### Light Account

A user whose Hive account was created for them by PEvO and whose broadcasting keys are held server-side (encrypted), so the platform can sign a restricted set of operations on their behalf, in contrast to a self-custody account where the user holds all keys.
*Avoid:* managed account, server-custody account.

A light account is created on-chain by the platform using claimed-account tokens; only the posting and memo private keys are stored server-side (encrypted), while the owner and active keys never leave the user's browser. A light account can move one-way to self-custody through the upgrade path, after which its server-held keys are destroyed and it can never revert.

### Self-custody Account

A user who holds all of their own Hive keys and signs every request through Hive Keychain, so the platform never holds broadcasting keys for them, in contrast to a light account where the platform signs on the user's behalf.
*Avoid:* Keychain account, full-custody account.

Server-side broadcasting is permanently unavailable; useful actions require the user's own Keychain. Self-custody is reached two ways: the no-row case (a user who brings an existing Hive account and never signs up) and the upgraded case (a former light account that completed the upgrade path). See No-row Case and Light-to-self Upgrade.

### No-row Case

A self-custody user who brought their own Hive account, never went through PEvO signup, and therefore has no platform account record at all, authenticating purely by on-chain Hive signature on every request.
*Avoid:* pure self-custody, bring-your-own-account user.

These users never enter the account state machine; their identity is on-chain only and there is no platform-side session. Deleting any signup-originated account returns the user to this same no-row case (their on-chain Hive account survives through the seed phrase even though all platform data is erased).

### Custody Mode

The account attribute recording whether broadcasting keys are server-held (light) or fully user-held (self), which gates whether server-side broadcasting is available.
*Avoid:* custody field, custody flag.

It is undetermined during transient signup-pending states, becomes server-held at finalization, and switches to user-held on upgrade; once user-held it never reverts. The authentication layer also treats no-row (Keychain) users as user-held even though they have no platform account record.

### Signup-pending State

A transient pre-finalization account state that exists after signup begins but before the user has confirmed and finalized, in contrast to the finalized steady states a usable account settles into.
*Avoid:* pre-finalize state.

These states have no username and no custody mode yet, and progress through email verification (or directly for ORCID signups) to a finalize step that produces a finalized light or self account. They are not usable for normal action and exist only to carry signup progress.

### BIP39 Seed Phrase

The mnemonic generated client-side at light-account signup, from which all of a Hive account's key pairs are derived and which serves as the account's master-password input and recovery and upgrade factor.
*Avoid:* seed phrase, mnemonic, master password.

It is generated in the browser and never sent to the platform; every light signup produces one. All key pairs are derived from it deterministically client-side, so a user can import the same phrase into Hive Keychain to control the PEvO-derived account directly. It is the factor used to recover a lost account and to prove control during the light-to-self upgrade, but is never accepted as a general session-auth factor.

### Hive Key Roles

The four key pairs (owner, active, posting, memo) derived from the seed phrase, of which only the posting and memo private keys are entrusted to the platform for a light account while owner and active never leave the browser.
*Avoid:* four key pairs, owner/active/posting/memo keys.

The split is the basis of light-account custody: the platform holds the encrypted posting and memo keys and can sign only a restricted set of operations with them, while owner and active stay client-side so the platform cannot perform high-authority operations. The server-held keys are encrypted at rest and destroyed when an account upgrades to self-custody.

### Light-to-self Upgrade

The one-way transition in which a light account becomes self-custody by proving control of the on-chain account with a seed-phrase-derived key, after which the platform destroys its encrypted broadcasting keys.
*Avoid:* custody upgrade, key rotation to self-custody.

Proof is a public key derived from the seed phrase: the browser derives it locally and sends only that public key, which is checked against the on-chain account's posting (or active) key. The transition is irreversible (no downgrade route exists, because the encrypted keys are destroyed); previously registered session-auth factors like password and ORCID are preserved, but server-side broadcasting is disabled afterward. Attempting to upgrade an already-upgraded account is rejected.

### Auth Factor

A distinct credential a PEvO account has registered that can prove control of it (a password, a linked ORCID, or the BIP39 seed phrase), where which factors an account holds depends on its state.
*Avoid:* recovery factor, registered factor.

A re-auth or recovery proof authenticates only if it matches a factor the account has actually registered: a passwordless account cannot prove by password, an account with no linked ORCID cannot prove by ORCID, and the seed phrase proves possession only when its derived key matches the on-chain account. The seed phrase is specifically an upgrade and recovery factor, not a general session-auth factor.

### Fresh-auth Proof

A per-critical-action cryptographic proof that the acting user controls a currently registered auth factor, required on top of (never replaced by) the session token, so that a stolen session alone can never perform a critical action.
*Avoid:* re-auth proof, step-up auth.

The required factor is chosen by what kind of control the action transfers or uses, not by whatever factors the account happens to hold, and it must match a factor the account has actually registered. For credit, consent, and upload actions the proof is target-bound (tied to the specific operation and subject) so a proof minted for one action cannot be redirected to another. A bare bearer session token never satisfies this requirement.

### Critical Action

Any operation that broadcasts on-chain, mutates an auth factor, or otherwise transfers or uses account control, and therefore requires a fresh-auth proof rather than just a session token.
*Avoid:* step-up-required action.

Examples include server-side broadcasting, changing or deleting the account, setting a password where there was none, linking ORCID, recovery, the custody upgrade, and minting an upload token. Which actions count as critical is kept in sync with the canonical contract whenever new control-transferring routes are added.

### Per-request Hive-signature Auth

The authentication path for self-custody users in which every request carries a Hive signature verified against the account's on-chain key, rather than a platform-minted session token.
*Avoid:* Hive-signature path, signed-request auth.

Because every request is independently signed by a key the user controls, this path is inherently fresh per request, so Keychain callers satisfy the fresh-auth requirement at the authentication layer and need not supply a separate proof for critical actions. It is the only auth path for no-row users.

### Session Invalidation

The mechanism that revokes a light account's outstanding bearer session tokens after a security-sensitive event (password reset, seed-phrase recovery, ORCID recovery), so that pre-event tokens stop authenticating.
*Avoid:* JWT revocation, bearer-token revocation.

Each outstanding session token records when it was issued; the platform stores a cutoff time, and any token issued before the cutoff stops authenticating. The token freshly issued by the triggering event is exempted so the user is not logged out by their own action. A session token whose issue time is missing or malformed is rejected outright rather than skipping the check.

## Admin Authority

### Signer

The single Hive account whose key cryptographically signs every PEvO authority operation on-chain, making it the sole chain-level authority that readers trust, as distinct from the roster of humans permitted to trigger those operations.
*Avoid:* admin signer, signing key.

There is exactly one signer by design, and this singularity is a preserved invariant: the platform never signs an authority operation with any other key, and widening the human roster never widens the signer. The signer is also referred to as the authority account, since it is the account whose attestations (accreditation, revocation, retraction, authorship approval) carry platform authority, and it is the account that appears in the read-time accreditation authority whitelist.

### Admin Roster

The chain-derived set of Hive accounts that human operators have empowered to trigger authority operations, sitting as a human-authorization layer in front of the single signer; a roster entry confers permission to ask the platform to act, never a signing key.
*Avoid:* admins, admin list, admin whitelist.

The roster is read live from the chain rather than stored in a platform database: membership and level are derived from on-chain grant and revoke operations (the latest non-revoked grant per account wins), with a short-lived cache that refreshes immediately after the platform's own roster changes and otherwise within the cache lifetime. The roster answers which human may ask the platform to make the signer sign, orthogonal to the whitelist's question of whose on-chain signature a reader trusts. If neither the chain read nor the cache can resolve a caller's level, authorization fails closed.

### Admin Tier

The strictly ordered authority level of a roster member or the operator (admin, super-admin, or root), where each higher tier subsumes the powers of the lower and adds tier-specific capabilities.
*Avoid:* admin role, admin level, authority level.

Admin holds operational moderation authority (such as accredit, sanction, retract, and authorship grant and revoke). Super-admin adds management of the admin tier (promoting and demoting admins) but must not manage other super-admins. Root adds management of the super-admin tier plus reputation-governance authority, and is the only tier that manages super-admins. No roster operation can strip the operator of authority (a super-admin may never manage another super-admin, and root is un-demotable because it is bootstrap configuration rather than a roster entry); this is the lockout guard.

### Root

The top authority tier, held by the operator who controls the signer key, defined as bootstrap configuration rather than a roster entry; it seeds the initial roster and holds powers no other tier has, including reputation governance and super-admin management.
*Avoid:* root admin.

Root is resolved from configuration before any chain read, which makes it un-demotable and unremovable: because it is not a roster entry, no roster operation can empty the roster of its bootstrap authority or lock the operator out.

### Authority Operation

An on-chain operation that exercises governance over PEvO's trust layer (accrediting, sanctioning, retracting, granting or revoking authorship or roster membership, or updating reputation weights), always signed by the single signer and gated by a roster-level check before it is broadcast.
*Avoid:* authority op, admin action.

Every authority operation is a critical action requiring both a passing roster-level check and an independent fresh-auth proof before the signer broadcasts it; a session token alone is never sufficient. Each operation's payload also records an attribution naming the triggering human (or a system marker for graph-derived grants).

### Roster Grant and Revoke

The pair of authority operations that record a roster member's promotion or demotion on-chain, signed by the single signer and triggered by a super-admin or root, from which the live admin roster and each member's tier are derived.
*Avoid:* roster-management op, grant/revoke op.

The current roster is computed from these operations by taking the latest non-revoked grant per account as that account's live level, the direct analogue of how accreditation membership is derived from accredit and revoke operations; root is never expressed as one of these operations.

### Operation Attribution

A record carried inside every authority operation naming the human roster member who triggered it (or a system marker when none did), kept for on-chain transparency and audit rather than as a cryptographic authorization proof.
*Avoid:* issuer field, attribution field.

It is a platform-attributed claim, not an independent proof: the operation is still signed by the single signer, and the actual authorization happened at the platform's roster-and-re-auth gate, so its trustworthiness reduces to trusting the operator's platform. Auto-grants from the web-of-trust path carry a fixed system marker instead of a person, letting readers distinguish operator-driven attestations from graph-derived ones.

## Flagged ambiguities

- **Revocation vs sanction.** Earlier usage treated any "revoke" as withdrawing accreditation. Settled: a revocation is broadcast only as a sanction (sticky, lifted only by a deliberate authority grant); routine loss of vouch-derived standing produces no revocation at all, and a markerless revocation is a legacy revoke treated as a non-sanction.
- **Fresh-auth proof across areas.** The account-security area and the admin-authority area both reference the same per-action step-up proof. Settled: it is one concept, Fresh-auth Proof; authority operations consume it as a co-gate alongside the roster-level check.
- **Authority whitelist vs admin roster.** Both are chain-trust concepts about who is trusted, but they answer different questions. Settled: the Accreditation Authority Whitelist gates whose on-chain signatures a reader trusts (it contains the single signer); the Admin Roster gates which human may ask the platform to make the signer act. They are orthogonal and must not be conflated.
- **Authority account.** Used in several places for the actor behind accreditation, revocation, retraction, and authorship approval. Settled: this is the Signer (the single on-chain authority account); the human who decides to trigger it is governed separately by the Admin Roster and Admin Tier.
