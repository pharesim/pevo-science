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

### Irreversible Pair

A chain write that cannot be undone, followed by the backend reconciliation that leaves the account or object coherent afterwards, treated as one unit because completing only the first half is worse than doing neither.
*Avoid:* the irreversible gap, the broadcast-cleanup pair.

The pair exists wherever the chain is the source of truth and a server record has to catch up to it: rotating an account's key authorities and then deleting the server-held keys that no longer sign for it is the sharpest instance, since between the halves the account is rotated on chain while the platform still believes it can sign for it. Nothing may abort between the halves. A flow that reaches the second half acts on values it captured before the first, so an interruption that would ordinarily cancel it, a departed subject, an unmounted view, a navigation, is not grounds to stop; what such a flow gives up instead is the right to write shared state on its way out. A guard placed between the halves therefore has to justify itself against the state it would strand, not merely against the risk it names, and an interruption whose outcome is genuinely unknown is its own case rather than a plain failure.

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

### Composer Draft

The browser-local copy of an unsubmitted paper or paper edit that the publishing and editing forms keep while the user types, so the text survives a reload or a full-page re-authentication round-trip.
*Avoid:* autosave, saved draft.

A draft ends at **landing**: the moment the broadcast of the paper or edit returns a result. From then on the form instance that composed it is finished. It removes the draft once, writes no draft again, and accepts no second submit. A second submit would mean a second post, or a patch computed against a body the chain no longer holds. A broadcast that fails, or that is cut short by a re-authentication redirect, is not a landing, so the draft is kept even though a failed broadcast may still have reached the chain: losing typed work is the worse outcome. Because a draft is stored per paper and outlives the form that wrote it, a finished instance must not touch the stored copy after landing, or it can delete a draft a later visit to the same paper wrote.

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

### Consent Op

An authorship operation a light account broadcasts through the platform that binds or releases an accredited co-author at an identity anchor: author accept and author resign. Every consent op requires a target-bound fresh-auth proof on top of the session token, because a stolen session alone must never change who is credited.
*Avoid:* anchored-route op, consent operation.

Its proof binds the paper root the slot belongs to, so a proof minted for one paper cannot be replayed against another. The proof kind is named after this family, the consent-op proof, and covers credit ops as well; only the payload shape, and with it what the proof's target binds, differs between the two families.

### Credit Op

An authorship operation on a name-only slot that mints or strips co-author credit: claim authorship, approve authorship, and revoke authorship. Credit ops are gated exactly like consent ops, with a target-bound fresh-auth proof on top of the session token, because they are identity-binding and reputation-weighty.
*Avoid:* name-only-route op, credit operation.

Its proof binds the paper and, per operation, the slot being claimed or approved and the account being credited or stripped, so a minted proof cannot be redirected to credit or strip a different co-author.

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

Accreditation status is computed live from authority-signed attestation and revocation operations plus the live vouch graph; it is an orthogonal dimension that applies to every account and is computed live rather than persisted as a stored account attribute. The grant operation is re-broadcastable: the earliest one anchors tenure, the latest supplies current profile metadata, and a later grant can re-admit a previously revoked account. An account is accredited only if it is not sanctioned, not released, and either its latest grant is authority-pinned or its latest grant is vouch-derived and currently meets the vouch threshold.

### Accreditation Method

The provenance tag on an accreditation grant recording how trust was established, splitting grants into authority-pinned (a deliberate platform attestation such as email, ORCID, or manual verification) versus vouch-derived (granted automatically when an account that holds no current grant and is not sanctioned crosses the vouch threshold).
*Avoid:* verification method.

Authority-pinned grants hold status on their own and keep it unless the account is sanctioned or releases; the vouch-derived method makes status conditional on continuing to meet the live vouch threshold, so the method determines whether an account's standing can silently lapse. A vouch-derived account drops out of membership the instant it falls below the threshold, with no revocation operation, and re-enters automatically when support returns.

### Web of Trust

The graph of vouches among accredited researchers that lets the platform grant accreditation in a decentralized, peer-attested way rather than only through a central authority.
*Avoid:* WoT, trust graph.

It is the mechanism for peer-attested accreditation, complementing authority-pinned grants; the membership it confers is always evaluated live against the current vouch graph rather than pinned at grant time.

### Vouch

An on-chain endorsement broadcast by one accredited researcher attesting to another researcher's credentials, forming an edge in the web of trust.
*Avoid:* endorsement.

A voucher must currently be accredited and cannot vouch for themselves; a vouch counts toward the threshold while its voucher holds a current grant that is not sanctioned, including a vouch-derived voucher below the threshold, and vouches are not checked against the accreditation authority whitelist. A vouch can be retracted, and accumulating enough distinct accredited vouches triggers an automatic vouch-derived accreditation grant for an account that holds no current grant of its own and is not sanctioned.

### Retract Vouch

The on-chain operation by which a voucher withdraws a previously issued vouch, removing that edge from the web of trust.
*Avoid:* vouch retraction.

Retracting a vouch that drops a vouch-derived account below the threshold broadcasts no revocation; the account simply stops appearing in the membership set on the next read, and standing returns automatically if vouches recover.

### Vouch Threshold

The minimum number of distinct accredited vouches an account must currently hold to qualify for and retain vouch-derived accreditation.
*Avoid:* WoT threshold.

Crossing it auto-grants a vouch-derived accreditation to an account holding no current grant, and falling below it drops standing live with no revocation. The threshold is checked continuously against the live vouch graph, never frozen at grant time.

### Live-Threshold Membership

The rule that vouch-derived accreditation is recomputed against the current vouch graph on every read rather than fixed at the moment of grant, so standing tracks the present state of support.
*Avoid:* live membership evaluation.

Because membership is live, a below-threshold account is simply absent from the accredited set with no operation broadcast, and a recovered account reappears automatically; this self-healing behavior is what distinguishes vouch-derived standing from the sticky, operation-pinned nature of a sanction.

### Sanction

A deliberate authority action against a bad actor, broadcast as a revocation marked as a sanction, that suppresses accreditation regardless of any vouch support.
*Avoid:* moderation sanction.

A sanction is sticky: while un-lifted, the account is unaccredited no matter what, and only a deliberate authority grant lifts it. No self-service path (re-verifying email or ORCID) and no amount of vouching can re-admit a sanctioned account, and the account's credential bindings stay held, so the credentials it holds cannot back another account while the sanction stands. On lift, the account's full pre-sanction history counts again, so tenure is preserved across the sanction gap. It is distinct from a threshold drop, which is ordinary, non-sticky loss of standing, and from a release, which the holder chooses.

### Release

The account giving up its own accreditation, broadcast as a revocation marked as a release, which ends the account's standing and frees its mailbox bindings and the chain binding of its ORCID so the holder can accredit another account.
*Avoid:* self-revoke, unaccredit, resign accreditation.

A release is ordinary, not sticky: any accreditation path re-admits the released account, and no authority decision is needed. The holder requests it as a critical action from the account itself; an admin requests it for a holder who lost their keys. The released account keeps its chain history, and the platform keeps its released mailbox bindings on record for admins.

### Revocation

The on-chain operation that withdraws an accreditation, broadcast as a sanction (a deliberate moderation action) or as a release (the holder's own choice), never for routine loss of standing.
*Avoid:* accreditation revoke op.

A revocation carrying the sanction marker is sticky and suppresses membership; one carrying the release marker suppresses membership until any later grant; a revocation lacking either marker is a legacy revoke, treated as a non-sanction and ignored for stickiness. Routine loss of web-of-trust standing produces no revocation at all, so a revocation here always signals deliberate intent, the holder's choice, or a historical artifact.

### Legacy Revoke

A historical revocation that lacks a type marker (carrying a threshold-no-longer-met reason), which membership evaluation treats as a non-sanction and ignores for stickiness.
*Avoid:* threshold-drop revoke.

A legacy-revoked account reverts to ordinary evaluation: a vouch-derived account falls back to live-threshold evaluation, and an authority-pinned account falls back to its latest grant. The presence of a legacy revoke never suppresses membership on its own.

### Accreditation Authority Whitelist

The set of Hive accounts whose accreditation and revocation operations the platform trusts at read time, so that anyone broadcasting a fake attestation under the app's identifier is ignored.
*Avoid:* accreditation authorities, signer whitelist.

The whitelist gates authority operations (grants and revocations) by signer and always implicitly includes the signer account. Vouches are not filtered by this whitelist; a vouch counts while its voucher holds a current grant that is not sanctioned (see Vouch). So the whitelist governs who can attest, not who can vouch.

### Active Accreditations

The computed live-membership view of currently accredited accounts that encodes the full membership rule: sanction stickiness, release, live vouch-threshold gating, and legacy revokes reclassified as non-sanctions.
*Avoid:* live-membership view, sanction-aware membership view.

A non-member (sanctioned, released, or vouch-derived below threshold) is absent from the view entirely; this is the authoritative reference for deciding whether an account is accredited right now, including authorship and ORCID resolution.

### Tenure Anchor

The "accredited since" reference point read from an account's earliest accreditation grant, spanning all history across any sanction gaps, so that metadata edits and post-sanction re-grants never reset standing.
*Avoid:* accredited since, tenure.

Tenure derives from the earliest grant's chain block time, not the re-broadcastable payload timestamp; it is purely a display dimension and does not feed reputation scoring, which is present-tense membership only.

### Credential Binding

The rule that each verified credential, an institutional mailbox or an ORCID iD, backs at most one accredited account at a time, together with the record that enforces it.
*Avoid:* mailbox lock, identity binding, one-account rule.

The principle is one researcher, one accredited account; the binding enforces it per credential, which is what the platform can verify. A person who presents a mailbox on one account and an ORCID on another is not detected by the binding and is in breach of the terms, sanctionable when found. One account may hold several mailboxes. The ORCID binding is read from the chain, where the ORCID iD is already public; the mailbox binding is a row in the app database keyed by a keyed hash of the canonical address, not on the chain. A verification that would bind a credential held by another account is refused; a sanction keeps the bindings held; a release frees them. The record also keeps which accounts a mailbox backed before, for admins.

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

Only one instance may run a cycle at a time; the batch periodically checks for new cycles and catches up sequentially if it has fallen behind. Catch-up is forward-only: a completed cycle is finalized and never revisited, so changing the scoring logic does not retroactively re-score already-completed cycles — corrected scores appear only as new cycles are computed, unless a full recompute is deliberately forced. The batch is the single source of truth for displayed reputation: readers parse the stored value defensively and surface a zero score on failure, never recomputing at head block.

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

A user who holds all of their own Hive keys and signs on-chain operations and most critical actions through Hive Keychain, so the platform never holds broadcasting keys for them, in contrast to a light account where the platform signs on the user's behalf.
*Avoid:* Keychain account, full-custody account.

Server-side broadcasting is permanently unavailable; useful actions require the user's own Keychain. Self-custody is reached two ways: the no-row case (a user who brings an existing Hive account and never signs up) and the upgraded case (a former light account that completed the upgrade path). See No-row Case and Light-to-self Upgrade.

### No-row Case

A self-custody user who brought their own Hive account, never went through PEvO signup, and therefore has no platform account record at all.
*Avoid:* pure self-custody, bring-your-own-account user.

These users never enter the account state machine; their identity is on-chain only. Signing in with Keychain still gives them a platform session, but the session carries no factor a fresh-auth proof could match, so their critical actions, adding a first email among them, are accepted only on a per-request signature. Deleting any signup-originated account returns the user to this same no-row case (their on-chain Hive account survives through the seed phrase even though all platform data is erased).

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

Proof is a public key derived from the seed phrase: the browser derives it locally and sends only that public key, which is checked against the on-chain account's posting (or active) key. The transition is irreversible (no downgrade route exists, because the encrypted keys are destroyed); previously registered session-auth factors like password and ORCID are preserved, but server-side broadcasting is disabled afterward. Because the upgrade rotates the account's whole authentication posture, it is also a session-invalidation trigger: every session token and open session window issued before it stops authenticating, except the token the upgrade itself returns (see Session Invalidation). Attempting to upgrade an already-upgraded account is rejected.

### Auth Factor

A distinct credential a PEvO account has registered that can prove control of it (a password, a linked ORCID, or the BIP39 seed phrase), where which factors an account holds depends on its state.
*Avoid:* recovery factor, registered factor.

A re-auth or recovery proof authenticates only if it matches a factor the account has actually registered: a passwordless account cannot prove by password, an account with no linked ORCID cannot prove by ORCID, and the seed phrase proves possession only when its derived key matches the on-chain account. The seed phrase is specifically an upgrade and recovery factor, not a general session-auth factor.

### Factor Resolution

The client-side decision of which registered auth factor to offer for a re-auth act, made once per tab by a single resolver that every surface consults rather than each surface guessing on its own.
*Avoid:* factor selection, hasPassword check.

Password wins when both factors are registered, because its prompt is inline while the ORCID factor is a full-page navigation that discards page state. The answer carries a confidence: **observed** when it came from the account's status, **assumed** when that status was unavailable and the resolver fell through to the password prompt so the platform, not the client, rejects a genuinely passwordless account. Only an explicit "no password" answer ever routes to the navigating factor; an unknown one never does. The confidence matters at exactly one point: a rejected password mint. Under an observed factor the rejection is a typo and earns one re-prompt; under an assumed factor it is at least as likely "no password registered", so the action is handed to the ORCID factor instead of dead-ending at a second prompt (or refused without navigating when the caller holds work the navigation would discard). A successful password mint is stronger evidence than the status read and is remembered for the tab, so a rate-limited status does not turn a proven password back into a guess; two consecutive rejections at the verifying route outrank that memory and retire it, so a password dropped elsewhere (a recovery with no new password in another tab) is re-read on the next action instead of prompted for until a page reload. The one action that sets a password from nothing is the deliberate exception: it takes the ORCID factor without consulting the status, since its account has no password by definition.

### Fresh-auth Proof

A per-critical-action cryptographic proof that the acting user controls a currently registered auth factor, required on top of (never replaced by) the session token, so that a stolen session alone can never perform a critical action.
*Avoid:* re-auth proof, step-up auth.

The required factor is chosen by what kind of control the action transfers or uses, not by whatever factors the account happens to hold, and it must match a factor the account has actually registered. A bare bearer session token never satisfies this requirement, and establishing a session is never itself the re-auth act.

Proofs come in two kinds. A **consent-op proof** is target-bound (tied to the specific operation, paper, slot, and subject) and spent once, so a proof minted for one co-author or slot cannot be redirected onto another. A **session proof** is target-less and stays valid for a bounded window of broadcasting and uploading, so one re-auth act covers a working stretch instead of a single action. The window slides on use, expires after a period of inactivity, and dies at a hard cap regardless of activity. A window also ends the moment the account's sessions are invalidated: any window opened before that cutoff stops authorizing, whether or not the platform's cached copy of it was cleared.

### Burn

The act of spending a consent-op proof, performed before the action it authorizes rather than after, so a proof cannot outlive the operation it was minted for.

Distinct from consuming a proof, which is the broader act of presenting one and having it validated: consuming a consent-op proof burns it, while consuming a session proof slides its window instead. A burn is final the moment it happens, and that finality must not depend on the platform succeeding in erasing its stored copy of the proof. The platform holds a canonical copy plus a short-lived local backup, so that a storage outage cannot tell a user the proof they just minted expired, and either copy may be the one that arbitrates a given burn. The guarantee therefore has to be a durable record that the proof was spent, kept until removal of the stored copy is confirmed. That record is the **ledger**, and it carries no expiry of its own: an entry leaves only on a reply that proves the stored copy is unreadable, never on a command merely having been issued, because a deadline guessed on this side can only ever retire an entry earlier than a confirmation would. Treating the removal as the guarantee is the recurring mistake: any single removal is an instruction that may not execute, and a spent proof whose stored copy outlives the ledger entry authorizes a second critical action.

### Acquire-before-commit

The client-side ordering rule that a session proof must be in hand BEFORE starting work whose loss would cost the user, never acquired partway through it.
*Avoid:* pre-flight gate, acquire-first.

The rule exists because one of the auth factors acquires by full-page navigation, which destroys whatever the page was holding: a selected file, a completed upload, a half-entered submit sequence. Acquiring at the moment the work needs a proof would therefore throw that work away for exactly the accounts that have no other factor, which is what would otherwise put inline upload out of reach for a passwordless account. Acquiring first is also what spares the platform from persisting what a composer draft cannot hold, such as selected files and finished uploads. The typed text is the one thing the round-trip can still cost, so a composer draft is saved just before the gate can navigate, and the text is restored on return. A gate applying this rule asks only whether the work may start, and it must not itself reject: it sits ahead of the caller's own error handling, so an error escaping it leaves the interface stuck with nothing said. Because a window that is open but nearly closed would strand a sequence halfway, such a gate treats a window closing sooner than its own margin as already spent and re-authenticates deliberately instead.

### Acquisition Outcome

The closed vocabulary a session-proof acquisition resolves into: either a usable proof, or one of a registered set of named ways the acquisition did not produce one.
*Avoid:* acquisition result, window outcome, acquisition sentinel.

The vocabulary has a single registration point, and every consumer is pinned against it, so a member added without a matching arm at each consumer is a failing test rather than a silent fall-through found later in review. Each member also carries what it owes the user, including the members that deliberately say nothing, so the decision of which outcomes speak is made once rather than per consumer. One member is reachable from a response body and the rest cannot be, which is why the value handed back from a mint is narrowed rather than passed through: a response that happens to carry the same shape as that member would otherwise be classified as it.

A value outside the vocabulary is an **unnamed result** (avoid: unregistered result, unclassified result). It is refused everywhere, and refusing it is not enough on its own. Because the acquisition reads from and writes to a cached window, a refusal that leaves the offending value where it was is a lockout rather than a refusal, since every later reading finds the same value and refuses again. The eviction therefore belongs at the producer, where the cache leg and the mint leg both pass through one drop, so a consumer added later inherits it without knowing to. Consumers divide into those reading this raw vocabulary and those reading the outcome object a gate derives from it; the two populations are not the same, and a count of one is not a count of the other. Both populations report a value outside the vocabulary the same way, as the member for re-authentication not completing, because that is the one condition the user can act on; they differ only in which coded vocabulary carries the report out.

### Remintable Rejection

A fresh-auth rejection whose stated reason says the proof was absent, expired, or malformed, meaning the correct client response is to discard the cached proof, acquire a new one, and retry once, in contrast to a terminal rejection where retrying would only repeat the same failure.
*Avoid:* retryable rejection, re-auth retry.

The distinction is a contract between the two sides: the rejecting side names the reason, and the client decides from that name alone whether a retry can succeed. A mismatch between the proof's subject and the acting user is terminal rather than remintable. Whether a remintable rejection actually retries also depends on the factor: an account whose only factor navigates would need a second full-page round-trip to retry, close to the proof's own expiry, so that case surfaces a terminal failure rather than risking a redirect loop, and the user restarts deliberately.

Discarding the cached proof is part of the response, not an optimization. Any local check added ahead of the request that refuses the same values the rejecting side would have refused also removes this handler from the path, and with it the discard, which turns a condition that healed itself on the next attempt into one that repeats until the cached entry expires on its own.

### Critical Action

Any operation that broadcasts on-chain, mutates an auth factor, or otherwise transfers or uses account control, and therefore requires a fresh-auth proof rather than just a session token.
*Avoid:* step-up-required action.

Examples include server-side broadcasting, changing or deleting the account, setting a password where there was none, linking ORCID, recovery, the custody upgrade, and minting an upload token. Which actions count as critical is kept in sync with the canonical contract whenever new control-transferring routes are added.

### Upload Token

A single-use credential minted by an authenticated pre-flight that binds one declared file to one upload, so the upload itself cannot be replayed or redirected to different content.

The pre-flight authenticates like any critical action and records what the caller declares about the file: its hash, its type and its size. The upload leg then presents the token and is refused unless the file it carries hashes to the value that was declared. On the signature path the declared description is bound into the signed envelope too, so a captured pre-flight signature is useless for a different file. The lifetime is deliberately short, long enough only for the pre-flight and the upload it authorizes. Like a consent-op proof it is spent on presentation, and it is stored the same two-tier way; but what actually stops a replay carrying different content is the hash re-check at the upload, not the spend, which matters because the spend is the weaker of the two guarantees.

### Per-request Hive-signature Auth

The authentication path for self-custody users in which every request carries a Hive signature verified against the account's on-chain key, rather than a platform-minted session token.
*Avoid:* Hive-signature path, signed-request auth.

Because every request is independently signed by a key the user controls, this path is inherently fresh per request, so Keychain callers satisfy the fresh-auth requirement at the authentication layer and need not supply a separate proof for most critical actions. Setting a password where there was none is the exception: it demands a proof by ORCID on every path, signed or not.

A self-custody user usually also holds a session token. A request that carries a valid session token is read as a session request even when it is also signed, so a critical action meant to be proven by its signature must be sent without the session token.

### Session Invalidation

The mechanism that revokes an account's outstanding bearer session tokens and open fresh-auth session windows after a security-sensitive event (password reset, seed-phrase recovery, ORCID recovery, custody upgrade), so that nothing minted before the event still authenticates.
*Avoid:* JWT revocation, bearer-token revocation.

Each outstanding session token records when it was issued; the platform stores a cutoff time, and any token issued before the cutoff stops authenticating. The token freshly issued by the triggering event is exempted so the user is not logged out by their own action. A session token whose issue time is missing or malformed is rejected outright rather than skipping the check.

The same cutoff governs session proofs, and it is the authoritative test for them: a window opened before the cutoff is refused on its next use because the stored cutoff says so, not because the platform managed to find and delete the window. Sweeping the cached copies is a storage-reclamation step that can miss one and must never be relied on as the guarantee. Revoking bearer tokens while leaving an open broadcast window standing has not actually cut off the compromised session, which is why the two are one mechanism rather than two.

### Subject Teardown

The tab-local discarding of everything that belonged to the subject a browser tab represented, run when the tab's session ends (for example by a logout, a revocation or an expiry), when its subject changes to a different account (a login in this tab, or one that reaches it from another tab of the same browser), and when the signed-in account is recovered.
*Avoid:* subject scrub, cross-user teardown, tab teardown.

A teardown clears the departed subject's cached fresh-auth proofs, remembered auth-factor state, and per-tab flow markers, dismisses any open re-auth prompt, and abandons re-auth work still in flight. In-flight work does not stop by itself: each stretch of re-auth work snapshots a teardown marker when it starts, re-checks it after every pause during which a teardown could have landed, and unwinds as a clean cancel rather than spending a credential or running a captured action for a subject the tab no longer represents. The marker protects only the code that carries it, so a helper reached during such a stretch that pauses before an irreversible effect must receive it too. Not every pause qualifies. A pause that yields to the browser's event loop, such as a network round-trip, a timer, or a wait on the user, can host a teardown; a pause that merely resolves an already-pending promise cannot, and a re-check placed there guards a window that does not exist. Unwinding is a refusal to act, not a tidying-up: the teardown has already discarded the departed subject's markers, so whatever stands in their place belongs to a later flow in the same tab, and abandoned work that cleans on its way out strands that flow rather than itself. A teardown discards the departed subject's values along with its markers, so a stretch that will need to know which subject it acts for captures that identity when it starts; read back afterwards, it is already gone. Unwinding is also not universal. A stretch that has already begun an Irreversible Pair finishes on what it captured rather than cancelling, since a captured identity and credential mean the completion acts for the subject the work began under, not for whoever the tab now represents. What such a stretch still gives up is the right to write the tab's shared session state on its way out. Distinct from Session Invalidation, which is the platform revoking a subject's tokens; a teardown is the client refusing to let one subject's unfinished work run as another.

A teardown is narrated to the user exactly once, however many stretches of work it abandons. One teardown can abandon several at once, each carrying its own marker, so the narration is claimed against the teardown itself rather than raised by each abandoned stretch; and a teardown path that already shows a message of its own claims that narration before speaking, so the work it abandoned stays quiet instead of talking over it with vaguer copy. The bound matters because the interface keeps only the most recent few messages: past that, duplicates evict the very narration they duplicate. When subject changes arrive faster than the work they abandon unwinds, one narration covers the run of them rather than one per change: the claim is held against the tab's current subject marker, not against the individual change, so a stretch parked across two changes finds the later one already narrated and stays quiet. The earlier change gets no message of its own, deliberately, since the user has just been told the session changed and a second message about the change before it would only stack.

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

## Task Coordination

### Hold block

A reviewer's dated list of the fixes a submitted task must land before it can be accepted, appended to that task's own file beneath the work it reviews.
*Avoid:* review block, feedback block.

A hold block is append-only. The implementer does not annotate it or mark its items done; the reviewer updates it at the next pass to record what is now satisfied. Appending one also returns the task to the implementer's queue, so the block and the task's change of state travel together, and a block appended without that move is invisible to the person meant to act on it. The implementer answers it with commits rather than with prose in the block, because the diff is what the reviewer re-derives from.

### Signal block

A short dated attestation an implementer appends to a task file when handing work back, naming the commits the work landed in.
*Avoid:* completion note, implementation note.

Its value is the commit identifiers rather than the prose. They give the reviewer something to run a reachability check against, which is the one failure a diff alone cannot reveal: work done in a throwaway worktree can be committed to a branch the parent never merges, so a named commit outside the main line of history leaves the task reading as complete while part of it exists nowhere the reviewer will look. The block indexes the evidence and does not stand in for it, so a count or a coverage claim asserted only in the block is prose rather than proof, and a reviewer re-derives it from the diff. A hand-off that answers a hold block carries one by convention.

### Worker Fan-out

A parent agent parallelizing one task by spawning several subordinate agents, each working a disjoint slice in its own throwaway checkout, and reconciling their results when they finish.
*Avoid:* parallel dispatch, subagent fan-out, worker pool.

The parent holds the only view of the whole, which makes three of its duties non-optional. It commits its own in-flight work before dispatching, because the workers branch from whatever it leaves behind and a dirty tree hands them a base nobody reviewed. It reconciles afterwards rather than merely merging, since workers cannot see each other and so solve shared sub-problems independently, converging on nothing: the same helper under two names, the same snippet open-coded in several places at once. That divergence is visible only from the parent's position, and only if it looks for structural sameness rather than checking whether the workers adopted a helper it already knew about. And it confirms the work reached the main line of history, because each worker commits to a branch of its own and one left unmerged leaves a task reading as complete while part of it exists where no reviewer will look.

The isolation is narrower than the word suggests. It covers the tree each worker edits and extends to nothing else they hold in common, so any output path, scratch file, or helper name the brief hands them identically is a channel through which they can still overwrite one another, with results that read as their own.

## Internationalization

### Translation Stub

A user-facing string shipped in a non-English locale as the raw English text, standing in for a translation nobody has written yet.
*Avoid:* placeholder string, untranslated key.

A stub carries no marker: it is deliberately the plain English value rather than a bracketed or sentinel-prefixed one, so it renders normally to a reader of that locale instead of exposing scaffolding. The cost of that choice is that a stub is indistinguishable from a finished translation by reading the locale data alone, and comparing a locale's value against English does not recover the difference, because technical terms, product names and borrowed words are legitimately identical across locales. Pending translation work is therefore tracked in a separate ledger rather than derived from the data, one line per locale-and-key pair still awaiting a translator, and the guarantee that makes the ledger worth consulting is that a key appears in it exactly once per locale still pending. A translator deletes the line in the same change that lands the real value, so the ledger drains as work completes.

### Stub Sweep

The dated batch a set of stubs entered the ledger in, and the unit a translator picks work up by.
*Avoid:* stub batch, translation round.

A sweep is append-only and is never merged into an earlier one, even when two fall on the same day, because the batch boundary is what lets a translator prioritize a body of work and what lets a later audit of stale entries read as history rather than guesswork. Sweeps come in two kinds, and which kind applies turns on translation status, not on whether the key name is new: one records keys arriving as stubs for the first time, the other records keys whose English was reworded after a real translation already existed, warning translators that their translation memory for that key is now misleading. A key that has never been translated has no memory to invalidate, so rewording one leaves it in its original sweep, corrected in place. Giving it a second sweep entry instead lists it twice for every pending locale and breaks the once-per-pending-locale guarantee the ledger rests on.

## Engineering Guards

### Source-discipline canary

A standing check that enforces an "only these places may do X" invariant over the project's own source, scanning for a forbidden or required code shape and failing when it appears somewhere the invariant does not license.
*Avoid:* grep test, lint test, allowlist test.

It takes two forms here: a test that walks the source tree itself and compares what it found against a fixed list of licensed sites, and a custom lint rule that reports the shape as a diagnostic and carries its own exemption list. Both share the defining hazard, that a canary has no subject but the codebase, so it passes vacuously when its scan matches nothing and a defect in it produces silence rather than a symptom; a green bar over a violation the canary exists to catch is a silent pass, and it is the failure every check on a canary is built to turn into a red one. The tree-walking form therefore also asserts that it examined a plausible number of files and that its own matchers still fire against planted examples; the strongest instances additionally report every file the walk passed over unread, so a module in an unscanned form cannot hide in that gap. How finely a site is licensed is what separates a strong canary from a weak one: licensing a whole file lets that file absorb a second, different offender in silence, while licensing an individual occurrence, and pinning it at an exact count, forces any addition to move a number. The failure message is part of the mechanism rather than decoration, because an engineer who trips a canary whose red bar does not explain the invariant will extend the exemption list instead of consuming whatever the invariant exists to route them to. And since the canary's own self-tests are the only thing standing between a broken canary and a permanently green one, those probes need per-branch discrimination: a probe that reddens when the whole mechanism is deleted does not establish that any single branch of it is covered. A canary is also a program that has to finish. Where its detection is a regex over text rather than a parse, any two unbounded quantified runs whose character classes share a member can split a run of that character between them in every possible way, at a cost that grows faster than the input and turns a guard into something that looks hung. Bounding the run the observed input implicated closes that instance rather than the class, because the cost moves to whichever other run shares a character with it. Once all but one run is bounded the cost stops compounding, but it is not therefore small: each character of the remaining run is a point where the bounded neighbours that share its class re-split what follows, so the work per character, not the growth order, decides whether a probe of a given size can see the regression, and a probe built from a character no neighbour shares pins nothing at all. And a probe that pins that cost has a window rather than a threshold: an input too small cannot witness the regression, while one too large makes a synchronous match outrun any test timeout, which reports as a hung suite rather than a red one. A zero match count from such a probe is also not evidence that it engaged: the adversarial input has to end in something the pattern's own tail cannot accept, or the match fails early for the wrong reason and the timing measures nothing, so what separates an engaged probe from a vacuous one is the growth curve across input sizes read against a control already known to be slow.

Where the scan reads source as text rather than parsing it, its reading of that text is itself load-bearing. A comment is legal wherever whitespace is, so one left in place between two tokens a pattern needs adjacent silences every scan sharing that pattern, and a span wrongly taken for a comment removes live code from all of them at once. The second error is the dangerous one, because a red bar on code that was never live is loud and bounded while a line no scan sees is silent, so a scanner resolves an ambiguous comment or string opener toward reading rather than blanking, that is, toward keeping a doubtful span as code rather than erasing it as comment before the patterns run. The same asymmetry limits what any list of expected mutations can show: since the canary asserts something about every shape the tree does not contain, a list confirms the cases someone thought of and cannot establish that no case was missed, which is answered only by an open-ended search for a shape that passes. A guard written against the one spelling that was observed closes that spelling rather than the class, and reasoning about which other spellings exist is what fails; what does not is asking the scanner itself. Since such a reader carries its state across lines, that state is assertable: a file the scan finishes while still inside a comment, a string, or a quoted span had everything after that point read with its comment handling switched off, so requiring every scanned file to end with no span open turns every span left open into a red bar. It answers only for spans left open, not for the opposite error of reading a comment as code, which leaves the end state clean, and a state inverted mid-file can also be put back by a later misread before the file ends, so a clean end state does not show that the lines between were read right. Where the scanned language has a parser, whether a line ends inside a template or a comment is the parser's answer rather than the scanner's, because a hand-written rule for a fact only a parser can decide, such as whether a slash divides or opens a pattern, trades one misread shape for another. Comparing the scanner's carried state with the parser's at every line end (the agreement arm) then reds an inversion on the line where it happens, and leaves unseen only a misread whose damage ends on its own line. The parser's answers arrive in the parser's own line numbering, which counts breaks the scanner's split does not (a lone carriage return, the Unicode line and paragraph separators), so each per-line answer is re-indexed into the scanner's own lines before it is compared or consumed; a conversion that instead adopted the parser's numbering would shift the scanner and its oracle together, and no comparison between them can see a misread they share.

A canary's fail-closed property belongs to its assertion shape rather than to the canary, so it does not survive a change of shape. Comparing the set of occurrences found against an exact licensed set fails closed only where a misplaced match lands on a site the set does not license: there it becomes a new member and reds, but a match placed on a licensed site, including an unplaceable bucket the set licenses, is absorbed, so a set that must admit one unplaceable line skips that line and pins it separately rather than licensing the whole bucket. Requiring every occurrence of one shape to be paired with another inside the same enclosing symbol does not inherit that, because when both sides resolve to the same unplaceable bucket they satisfy each other and the omission passes green. A pairing scan therefore excludes unplaceable matches from the satisfying set and reds on any primary-side match that lands there, which turns a declaration the resolver cannot parse into a red bar naming the line.

The same exposure turns inward on the scanner's own source. Its comments have to discuss comment syntax, and a block comment that quotes a comment close as an illustration is ended by that close, while the illustration's next opener starts a second comment that runs to the terminator the author wrote; the file still parses, every check stays green, and the text after the illustration is no longer in the comment the author believes it is in, until a later close added there turns the rest into live code. A block comment describes such a shape in words, and only a line comment, which no close can end, may spell it out. What shows the difference is a real parser's count of block comments against the openers written, or the scanner's own comment reader run over its own lines.

### Mutation Probe

A deliberate reversion of one site of the code under test, run to establish that a named test reddens without it, so that a coverage claim is measured rather than asserted.
*Avoid:* revert test, mutation test, kill test.

A probe is reported by what it did to a named test: it kills when that test fails and survives when the suite stays green, and a survivor is never a passing result. What a survivor is instead takes one further question, because two unrelated faults show the same green bar: the missing coverage it usually means, or a mutation that never put the code into the state the assertion could have caught. Reverting a site is not always one edit. Where the change at that site both added a condition and removed what the addition made redundant, undoing only the added line leaves a shape that never shipped, and such a hybrid can still reach the asserted observable by another route, an unguarded read throwing into a handler that was already there. Anything standing between the mutated rule and the assertion does the same. Absorption need not be total: where the same effect is written at two sites of one sequence, each covering exits the other does not, only some inputs reach the mutated site alone, and an input that reaches the later site too leaves the probe green on the mutant and green on the fix. Naming the site to revert therefore does not finish the design, because the input has to be one on which no later site runs; reverting every such site at once and reading which existing tests stay green is what names those inputs, since a survivor's input is one a later site was answering for. So a survivor reads as missing coverage only once the mutant is confirmed to be a version that really existed and nothing downstream is absorbing its failure. Discrimination is the whole value, so the unit is the site and not the fix. A probe that reverts an entire mechanism and reddens something establishes nothing about any single branch of it, and two sites sitting in mutually exclusive branches each need their own probe, because neither can stand in for the other and a fixture's incidental posture decides which one the run actually reached. Several preconditions decide whether a probe's answer means anything at all. The baseline has to be green before the mutation, since a probe read against an already-red suite measures nothing. The mutation has to be asserted to have landed, at the intended site and the expected number of times, or a probe that changed nothing reports a kill it did not earn. The reversion is a destructive write to whichever tree it runs in, so it belongs in a throwaway copy rather than a shared checkout; and everything else the run writes, its captured output above all, belongs inside that same copy, because concurrent probes sharing any name can read each other's results with nothing visible to say so. Since the outcome is usually consumed as a count rather than re-derived, a probe that cannot say which tree it ran in is a number taken on faith, and the run's own identity read back from what it produced is what turns the count into evidence.

### Twin Surface

One of two or more surfaces the project deliberately keeps parallel, so that a rule proved at one is meant to hold at the others and an undeclared divergence between them is a defect rather than a variation.
*Avoid:* sibling surface, parity pair, mirrored surface.

Twins arise where one mechanism is bound to several targets: the same orchestration written once per target, with only the target-bound call differing. Parity is enumerated rather than assumed, so an audit names the axis each twin must match on and treats a difference on an unnamed axis as the finding. Parity holds on structure and on invariants; it never holds on explanatory prose. A sentence explaining why a case exists is a claim about the particular value that case pins, so mirroring it across twins propagates whatever it happens to say, true or false. That also makes the twins agree, and agreement is the signal cross-site consistency checks look for, so prose copied under a parity requirement removes the cheapest tell at the same moment it doubles the reach of a mistake. Each twin's explanation is re-derived against its own case; only the shape is copied.

### Mock Carve-out

The project's one exception to its rule that tests run against real infrastructure: a test may replace a dependency with a double only when its own header discharges three obligations, and that header is the compliance artifact.
*Avoid:* mock exception, mocking policy, test-double allowance.

The obligations are referred to by their clause letters. Under (a) the header names the real path the test cannot take and says why that path is impractical. Under (b) authentication verification stays real wherever verification is what the test is about, so a bypass fixture is admitted only for a test whose subject is the behaviour downstream of it. Under (c) the risk class the double hides is caught by a Real-path Companion named in the header, or a task is filed to add one. The double is for determinism, never convenience. All three are prose, and the mechanical gates check only a citation's shape and whether its path resolves, not whether what it says is true. So each clause is verified against the tree at write time and again at review: the stated impracticability is checked against what the harness already pins and against sibling tests that may do the "impossible" thing, the inventory of doubles is re-derived rather than patched, and the companion is opened to confirm it exercises the risk class. A header that satisfies every gate can still send its reader the wrong way.

### Real-path Companion

A test that exercises, against real infrastructure, the same risk class that a mocked test's double hides, and that the mocked test's header names as the discharge of its third carve-out obligation.
*Avoid:* companion test, sibling coverage, real-path sibling.

The companion does not need to assert what the mocked test asserts; it needs to run the integrated path so that a failure class the double cannot surface is caught somewhere. Equivalence of risk class, not of assertion, is the bar. The citation is two-sided when it holds: the companion's own header names the mocked test it covers, so a rename or a weakened assertion on either side is visible from both. A companion that skips itself when its environment is incomplete discharges the obligation only on the runs where it actually executes, and that condition belongs in the citing header.

## Flagged ambiguities

- **Fail-closed in two areas.** The data-availability area uses it for a read path that refuses rather than degrades when its source is unavailable; the engineering-guards area uses it for a scan whose unattributable match becomes a red bar rather than passing as benign. Settled: one principle, two subjects, and neither reading is a synonym for the other. Both say that the uncertain case takes the loud outcome, which for a read is refusing to answer and for a guard is refusing to clear.
- **Revocation vs sanction.** Earlier usage treated any "revoke" as withdrawing accreditation. Settled: a revocation is broadcast only as a sanction (sticky, lifted only by a deliberate authority grant) or as a release (ordinary, the holder's own choice); routine loss of vouch-derived standing produces no revocation at all, and a markerless revocation is a legacy revoke treated as a non-sanction.
- **Fresh-auth proof across areas.** The account-security area and the admin-authority area both reference the same per-action step-up proof. Settled: it is one concept, Fresh-auth Proof; authority operations consume it as a co-gate alongside the roster-level check.
- **Authority whitelist vs admin roster.** Both are chain-trust concepts about who is trusted, but they answer different questions. Settled: the Accreditation Authority Whitelist gates whose on-chain signatures a reader trusts (it contains the single signer); the Admin Roster gates which human may ask the platform to make the signer act. They are orthogonal and must not be conflated.
- **Burn vs consume.** Both were used for presenting a fresh-auth proof. Settled: consuming is the broader act of presenting a proof and having it validated; a burn is specifically the spend of a consent-op proof, and session proofs are consumed but never burned. Unrelated to token burning in the crypto sense, which does not arise here because PEvO issues no custom token.
- **Authority account.** Used in several places for the actor behind accreditation, revocation, retraction, and authorship approval. Settled: this is the Signer (the single on-chain authority account); the human who decides to trigger it is governed separately by the Admin Roster and Admin Tier.
- **Consent op vs credit op.** Both families require the same kind of proof, and "consent op" was used loosely for either. Settled: Consent Ops (author accept, author resign) act on an identity anchor and bind the paper root; Credit Ops (claim, approve, revoke authorship) act on a name-only slot and bind the paper plus the slot or account concerned. The proof kind is named after the first family and covers both.
- **Pinner, two unrelated senses.** The glossary entry above is the community-operated IPFS node, and that is the only current sense. A `pinner` agent role also existed, with its own commit-subject prefix and repository zone, until its code and agent were extracted to a separate repository; readers meet it in old commits, archived task files, and the zone-audit learning. Settled: the surviving concept is the IPFS node. A `pinner:` commit prefix in history refers to the retired role and is not a claim about pinning.
- **Carve-out, one named sense among several.** Bare "carve-out" in learnings, hold blocks, and test headers is ordinary English for an exception to a stated rule, and the corpus has several: the exception to the positional-anchor rule, the rate limiter's credential-verify exemption, the recovery flow's seed-phrase-holder allowance. Settled: only the Mock Carve-out is a named concept here, with its three clauses; every other use names the rule it carves out of, and "clause (a)/(b)/(c)" without qualification always means the Mock Carve-out's.
- **Anchor, two unrelated senses.** Bare "anchor" appears in hold blocks, commit messages, and review notes for two things that share no meaning. Settled: an Identity Anchor is the authorship concept above, the Hive handle or ORCID on a slot that routes consent. A comment anchor is a documentation-hygiene term, what a code comment points at, and the rule is that it must be a stable name rather than a position, a line number, a commit SHA, or a task slug. Neither is a shortening of the other; say which one is meant.
