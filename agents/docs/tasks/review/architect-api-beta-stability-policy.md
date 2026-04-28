# API beta-stability policy — explicit stance on surface removal during beta

**Owner:** Architect
**Created:** 2026-04-28 (surfaced by `/ce-doc-review` of `backend-papers-filter-accreditation.md` — product-lens)
**Priority:** P3

## Problem

PEvO is in beta and AGPL-3.0 forkable. The filter-accreditation task removed the `accredited_only=false` query parameter from three endpoints. The architect's resolution argued the removal was safe because frontend has zero callers. But the parameter was published in `agents/docs/api-contracts/papers.md` — it's an external interface, not an internal helper.

This worked out fine for that task (no concrete fork or third-party integrator surfaced). But the implicit posture — "no internal caller = removable surface" — is brittle on a published contract for a forkable AGPL beta. Future similar removals will face the same critique with diminishing trust.

The right move is to document the stability commitment (or lack thereof) once and refer to it.

## Acceptance criteria

Add a "Stability" section to `agents/docs/api-contracts/common.md` near the top (before the per-endpoint sections). Recommended wording:

```
## Stability

PEvO is in beta. The API surface — endpoints, query parameters, response shapes, error codes — may change without deprecation notice during beta. Forks and third-party integrators should pin to specific commit SHAs or accept that surfaces may break.

Once PEvO declares 1.0, we'll commit to:
- Semver-style versioning for breaking changes.
- A deprecation cycle for removed surfaces (minimum 1 minor release).
- Migration notes in `agents/docs/api-contracts/CHANGELOG.md`.

For now: the contract files in this directory are the canonical surface description, but they're a snapshot of intent at HEAD, not a stability commitment.
```

Optionally, also reference this stance from `README.md` near the "AGPL-3.0, forkable" framing.

## Why now

Inoculates future similar surface-removal tasks against the same product-lens critique. Converts an implicit posture into explicit policy. One file edit, ~10-15 lines.

## Out of scope

- Designing the eventual 1.0 stability process (CHANGELOG format, semver scheme, deprecation cycle).
- Adding a `version` field to API responses.
- Backporting the policy retroactively to surfaces already removed (the policy applies prospectively from the date the file ships).
