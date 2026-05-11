# BACKEND-MASK-EMAIL-HELPER-EXTRACT-AND-FIX — Extract `maskEmail` to a shared helper and fix the dead conditional in `accreditation.ts`

**Owner:** backend
**Created:** 2026-05-11 (architect, batch-1 review triage)
**Priority:** P2

## Context

Architect batch-1 review (maintainability findings M1 + M2) surfaced two coupled issues at `backend/src/routes/accreditation.ts:283-290`:

1. **Dead conditional (M1, conf 100):** The `maskEmail` function in `accreditation.ts:283` has a ternary at line 288:
   ```ts
   local.length <= 2 ? `${local[0]}***` : `${local[0]}***`
   ```
   Both branches produce the identical template. The length check is inert. The function always returns `<first-char>***@***<tld>` regardless of input length.
2. **Duplicated implementation (M2, conf 75):** A sibling implementation lives at `backend/src/routes/auth.ts:1273-1280`. Its long-local branch differs (correctly):
   ```ts
   local.length <= 2 ? `${local[0]}***` : `${local[0]}***${local[local.length-1]}`
   ```
   Two private (non-exported) functions named `maskEmail` with the same signature but divergent implementations. Neither is exported, so a future maintainer fixing one would not know about the other.

**Combined user-visible effect:** A user with email `joseph@mit.edu` sees `j***@***mit.edu` from `/api/accreditation/request` but `j***h@***mit.edu` from `/api/auth/signup` or related routes. Inconsistent masking across surfaces for the same user. Not a security regression (the masking is still defense-in-depth on user-facing confirmation messages), but a UX/consistency regression.

The structural fix is to extract `maskEmail` to a shared helper, use the correct (auth.ts-style) long-local branch as the canonical form, and update both call sites.

## Acceptance

1. **Choose helper location.** Options (pick one, document the choice):
   - `backend/src/lib/email-mask.ts` (new file, single function export)
   - `backend/src/lib/log-pii.ts` (existing file with related email-handling exports like `hashEmailForLogs`, `safeHashEmailForLogs`). The PEvO convention of keeping related lib helpers together suggests this.
2. **Extract the function** with the correct (auth.ts-style) implementation:
   ```ts
   export function maskEmail(email: string): string {
     const [local, domain] = email.split('@');
     if (!local || !domain) return email;  // or whatever the existing fallback is — preserve
     const tldIdx = domain.lastIndexOf('.');
     const tld = tldIdx >= 0 ? domain.slice(tldIdx) : '';
     const masked = local.length <= 2
       ? `${local[0]}***`
       : `${local[0]}***${local[local.length-1]}`;
     return `${masked}@***${tld}`;
   }
   ```
   Verify the actual fallback semantics in the two existing implementations and pick the more conservative one (probably the auth.ts version since accreditation.ts's is bugged).
3. **Update `accreditation.ts:283-290`** to import and use the new helper. Remove the local function. Same for any other tests / callers.
4. **Update `auth.ts:1273-1280`** to import and use the new helper. Remove the local function.
5. **Grep for any third copy** (`grep -n "maskEmail\\|\\*\\*\\*@\\*\\*\\*" backend/src/`) and replace if found.
6. **Visual verification with one example each:** call the new helper with three inputs (`j@x.io`, `jo@x.io`, `joseph@mit.edu`) and assert the output matches the documented form. Comment the assertions or add unit specs.

## Tests

Add a small `backend/tests/lib/email-mask.test.ts` (or extend `tests/lib/log-pii.test.ts` if the helper lands there) with specs for:
- Short local (1 char): `j@x.io` → `j***@***.io`
- Short local (2 chars): `jo@x.io` → `j***@***.io`
- Long local: `joseph@mit.edu` → `j***h@***.edu`
- Multi-dot domain: `j@mail.example.co.uk` → `j***@***.uk`
- Missing `@` or missing `.`: fallback behavior (whatever the existing impls do)
- Empty string: fallback

Also verify the existing accreditation/auth tests that exercise the user-facing confirmation messages still pass with the corrected masking (some assertions may need updating to the new `j***h@***mit.edu` form).

## Out of scope

- Broader PII-masking refactor (`hashEmailForLogs`, `safeHashEmailForLogs` are operator-log-only and have a different threat model; leave them alone).
- Changing what's masked (the user-facing-confirmation use case is specifically NON-fully-redacted by design — it gives the user enough information to recognize their own email).
- Other `mask*` helpers in the backend if any exist (separate scopes).

## References

- Architect batch-1 review findings M1 + M2 (maintainability). M1: dead conditional, conf 100. M2: duplication, conf 75. Both target the same function.
- Original code: `backend/src/routes/accreditation.ts:283-290` (bugged) and `backend/src/routes/auth.ts:1273-1280` (canonical).

## Priority rationale

P2 because the inconsistency is user-visible (the masking shape differs across routes for the same user) but not security-sensitive (both forms are partial redaction; neither leaks PII fully). The fix is small, structural, and pays for itself by eliminating the divergence permanently.
