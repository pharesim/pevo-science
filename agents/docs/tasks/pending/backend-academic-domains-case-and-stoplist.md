# 31 academic domains can never match, and swot's stoplist is not applied

**Owner:** backend
**Created:** 2026-10-06
**Priority:** low

Found while grounding `architect-accreditation-mailbox-binding-design`. Triage: user, "as
recommended".

## Why

`isInstitutionalEmail` (`backend/src/email-validator.ts`) lowercases the address but builds its
domain `Set` from `backend/data/academic-domains.json` without lowercasing; 31 entries carry
uppercase letters (for example `Nicholls.edu`, `Roberts.edu`, `Ioffe.ru`) and are refused unless
another arm covers them. `backend/scripts/update-academic-domains.sh` skips swot's `abused.txt`
and `tlds.txt` by name but not its `stoplist.txt`; the shipped file contains a literal `stoplist`
entry.

## Scope

1. Lowercase entries when building the `Set` (or at generation time, and regenerate the file).
2. Apply swot's stoplist at generation time and drop the literal `stoplist` entry; record the swot
   revision used in the generator's header comment.
3. A unit test for `isInstitutionalEmail` covering a mixed-case list entry, a subdomain, a TLD
   suffix, an env exact address and a stoplisted domain.

## Acceptance criteria

1. `isInstitutionalEmail('x@nicholls.edu')` is true; a stoplisted domain is false.
2. The route specs that pin `test@gmail.com` and `test@yahoo.com` to 422 stay green.
