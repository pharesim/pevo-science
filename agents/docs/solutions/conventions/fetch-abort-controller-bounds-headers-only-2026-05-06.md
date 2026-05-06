---
title: "Wrapping Node fetch() with AbortController bounds the headers phase, not body-read"
date: 2026-05-06
category: conventions
module: backend
problem_type: convention
component: authentication
severity: medium
applies_when:
  - "Wrapping Node fetch() with setTimeout + AbortController for a wall-clock timeout"
  - "Reviewing any helper that abstracts fetch() behind a timeout-discipline contract"
  - "Adding new third-party HTTP integrations (OAuth providers, IPFS gateways, accreditation services, future API integrations)"
  - "Adapting an existing fetch wrapper to a new caller that needs full-call timeout protection"
related_components:
  - tooling
tags:
  - fetch
  - abortcontroller
  - timeout
  - whatwg-fetch
  - wrapper-coverage
  - body-read
  - third-party-http
  - orcid
---

# Wrapping Node fetch() with AbortController bounds the headers phase, not body-read

## Context

Round-5 of `backend-coauthor-trust-model` (commit `d820787`, archived in commit `d7a25b6` on 2026-05-06) introduced `fetchWithOrcidTimeout` at `backend/src/routes/orcid.ts:215-245`. The helper wraps Node's native `fetch()` with an `AbortController` and a `setTimeout` that aborts the controller after `ORCID_FETCH_TIMEOUT_MS` (default 10 seconds), then clears the timer in a `finally` block. On timer-fire abort, the helper throws `OrcidProviderTimeoutError`, which the route's outer catch maps to a new `ORCID_PROVIDER_TIMEOUT` 504 response.

The wrapper was the round-5 hold #4 fix for "ORCID `fetch` calls have no timeout discipline" — the failure mode was framed as "ORCID provider hangs and blocks the handler indefinitely." On its surface, the wrapper looks complete: timer + controller + finally-clear is the canonical Node fetch-timeout idiom.

The architect re-review's adversarial reviewer surfaced a coverage gap that the wrapper's surface obscures: **Node's `fetch()` resolves as soon as response headers arrive, not when the response body is fully read.** Body-read calls (`tokenRes.json()`, `tokenRes.text()`, `worksRes.json()`, etc.) execute AFTER the wrapper has resolved and the `finally` block has cleared the abort timer. The `AbortController` is no longer scheduled to fire. A provider that returns `200 OK` headers within the timeout window but then dribbles body bytes for an arbitrary duration (TCP backpressure, upstream throttling, slow-stream attack shape) hangs the route handler indefinitely. The 504 `ORCID_PROVIDER_TIMEOUT` defense never fires for this failure mode.

The architect dismissed acting on the gap for the ORCID-specific instance — ORCID's production load balancer is unlikely to dribble bytes; the headers-phase guard catches the dominant failure mode (full-call hang on the upstream's first byte). The structural insight is generalizable, though, and likely to recur in any future fetch wrapper PEvO builds (pinner IPFS gateways, third-party API integrations, anything wrapping Node fetch with timeout discipline).

This convention captures the rule that surfaces the gap, so future authors of fetch wrappers don't repeat the mistake silently.

## Guidance

**Rule.** When wrapping `fetch()` with an `AbortController` for timeout discipline, the contract is "abort if **headers** don't arrive within N ms," not "abort the whole call within N ms." Body-read calls (`Response.json()`, `.text()`, `.arrayBuffer()`, `.formData()`, `.blob()`, streaming via `Response.body`) run AFTER `fetch()` resolves and are unbounded by any timer cleared in the wrapper's `finally`.

If you need full-call timeout protection (headers AND body-read), pick one:

1. **Keep the timer armed across the body-read.** Don't clear the timeout in `finally` until after the body is consumed; pass the same `AbortController` (or its `AbortSignal`) into the body-read site so the abort propagates through stream cancellation. Caveat: if the wrapper returns the `Response` to a caller, the caller is responsible for body-read cancellation; the wrapper alone cannot enforce it.

2. **Wrap body-read separately with its own timeout.** An `awaitWithTimeout(promise, ms)` helper applied to `await tokenRes.json()` or equivalent. Each phase gets its own bound; the overall call has a max wall-clock cost of `headersTimeoutMs + bodyTimeoutMs`.

3. **Use `AbortSignal.timeout(ms)` and pass it through both legs.** `AbortSignal.timeout(ms)` (Node 17.3+) returns a signal that fires after `ms`; passed as `init.signal` to `fetch()`, it bounds the headers phase. Capturing the same signal at the body-read site (via a `Promise.race` against `signalToPromise(signal)`) extends the bound to the full call. Same effective shape as (1) but using the standard library's signal primitive instead of a manual `setTimeout` + `controller.abort()`.

If the wrapper's caller does NOT need body-read protection (the upstream's deployment shape makes slow-body unlikely AND the operational impact of a single hung request is bounded), document the gap explicitly. Inline the rationale: "this wrapper bounds the headers phase only; ${UPSTREAM} returns small JSON bodies via a load balancer, so body-read is operationally fast; if a future caller needs full-call bounds, see `fetch-abort-controller-bounds-headers-only-2026-05-06.md`." The cost of an inline rationale is one comment block; the cost of silently letting the next wrapper repeat the mistake is one production incident.

**Code-review rule.** When reviewing a new fetch wrapper, ask three questions before approving:

- What does the wrapper's contract claim — full-call timeout, or headers-phase timeout?
- If full-call, where is the body-read bounded?
- If headers-phase, is the gap documented?

Single-question shortcut: grep the file for `.json(`, `.text(`, `.arrayBuffer(`, `.body` against the wrapper's `Response` return value. If any are present and not separately bounded, the wrapper does not give full-call timeout protection.

## Why This Matters

The WHATWG fetch specification resolves the `fetch()` promise when the response head (status + headers) is received, deferring body-stream consumption to the `Response` interface's separate methods. This split lets callers stream-read large bodies without blocking on header processing. The cost of the split: a wrapper that times out only the `fetch()` call timeouts only on the head phase, leaving the body-read unbounded.

The gap is invisible at the wrapper's surface. Reading `fetchWithOrcidTimeout`, a reviewer sees the canonical timeout shape — `setTimeout` schedules `controller.abort()`, `await fetch(url, {...init, signal: controller.signal})`, `finally clearTimeout(timer)` — and assumes the contract bounds the whole call. The MDN documentation for `AbortController` reinforces the assumption: examples show "cancellable fetch" without distinguishing headers from body.

Agents writing fetch wrappers default to copying the canonical shape. Without an explicit rule that names the headers/body split, every new wrapper risks the same gap. The cost is highest when the wrapper is consumed by code paths that read large bodies (works lists from a paginated API, file downloads, streaming endpoints), where the body-read can legitimately take seconds and a slow-body adversary can chain many seconds together.

The rule's positive side: stating the gap explicitly turns "wrapper coverage" into a concrete review item. New wrappers either document their contract precisely (headers-only is a valid choice for fast-body upstreams) or wire body-read protection at construction time. Either way, the gap is no longer silent.

## When to Apply

- Authoring any new fetch wrapper helper in PEvO backend code (`backend/src/lib/fetch-*.ts`, `backend/src/routes/*.ts` inline wrappers, IPFS gateway wrappers in pinner code).
- Reviewing a PR that introduces or modifies a fetch wrapper, particularly when the wrapper is presented as "a fetch with timeout."
- Extending an existing fetch wrapper (e.g., `fetchWithOrcidTimeout`) to a new caller whose body-read characteristics differ from the original consumer's. Example: extending `fetchWithOrcidTimeout` to a hypothetical "fetch ORCID works with full pagination" path that streams large JSON bodies — the original headers-only bound becomes inadequate.
- Triaging a route handler that hangs in production despite a fetch-timeout wrapper being in place. The wrapper might be doing what it was written to do (bound headers); the hang is in body-read territory.

## Examples

### Headers-only wrapper (the gap)

```ts
// backend/src/routes/orcid.ts:215-245 (sanitized)
const ORCID_FETCH_TIMEOUT_MS = Number(process.env.ORCID_FETCH_TIMEOUT_MS) || 10_000;

class OrcidProviderTimeoutError extends Error {
  constructor() { super("ORCID provider timeout"); }
}

async function fetchWithOrcidTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORCID_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new OrcidProviderTimeoutError();
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Caller (somewhere in /callback):
const tokenRes = await fetchWithOrcidTimeout(tokenUrl, { method: "POST", body: form });
const tokenJson = await tokenRes.json();   // <-- UNBOUNDED. Provider can dribble bytes here.
```

The wrapper bounds the time-to-headers. Once `tokenRes` is in hand, the timer is cleared. `tokenRes.json()` reads the body stream with no timeout. A provider that sends `200 OK\nContent-Type: application/json\n\n{` and then pauses indefinitely on the next byte hangs the handler.

### Full-call coverage via shared signal

```ts
async function fetchWithFullTimeout(url: string, init: RequestInit = {}, ms = 10_000): Promise<{ res: Response; readBody: <T>(reader: (r: Response) => Promise<T>) => Promise<T> }> {
  const signal = AbortSignal.timeout(ms);
  const res = await fetch(url, { ...init, signal });
  return {
    res,
    async readBody<T>(reader: (r: Response) => Promise<T>): Promise<T> {
      // The same signal that bounded headers continues to fire; body-read aborts on timer expiry.
      // Caller is responsible for invoking readBody before the signal expires.
      const bodyPromise = reader(res);
      const abortPromise = new Promise<never>((_, rej) => {
        if (signal.aborted) rej(new Error("body-read timeout"));
        else signal.addEventListener("abort", () => rej(new Error("body-read timeout")), { once: true });
      });
      return Promise.race([bodyPromise, abortPromise]);
    },
  };
}

// Caller:
const { res, readBody } = await fetchWithFullTimeout(tokenUrl, { method: "POST", body: form }, 10_000);
const tokenJson = await readBody(r => r.json());   // <-- BOUNDED by the same 10s timer.
```

The signal from `AbortSignal.timeout(ms)` survives across both phases. Headers-phase abort cancels the `fetch()` promise; body-phase abort rejects via the `Promise.race`.

### Headers-only with documented gap (acceptable when body-read is operationally fast)

```ts
/**
 * Bounds the HEADERS phase of an ORCID provider fetch via AbortController + setTimeout.
 *
 * IMPORTANT: this wrapper does NOT bound body-read. Once fetch() resolves, the timer is
 * cleared in finally; tokenRes.json() / tokenRes.text() runs unbounded. ORCID's load
 * balancer returns small JSON bodies fast in the deployments we run against, so the
 * headers-phase bound catches the dominant failure mode (provider hangs on first byte).
 *
 * If a future caller reads large or paginated bodies, see
 * docs/solutions/conventions/fetch-abort-controller-bounds-headers-only-2026-05-06.md
 * and switch to a full-call coverage shape (AbortSignal.timeout passed through to the
 * body-read site, or a Promise.race against the abort signal at the body-read).
 */
async function fetchWithOrcidTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  // ...same body as above...
}
```

The gap is no longer silent. Future maintainers extending the wrapper see the rationale and the upgrade path.

## Related

- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — sibling rule for the OUTCOME of a timer fire on a chain-write path. Distinct concern: that doc says "a timer fire says nothing about whether the broadcast landed"; this doc says "a timer fire on `fetch()` says nothing about whether the body was read in full." Both share the meta-pattern that timer semantics are easy to misread; concrete shapes differ.
- `agents/docs/solutions/conventions/verify-library-claims-before-load-bearing-security-margins-2026-04-22.md` — the canonical PEvO learning that third-party-library timeout claims must be verified, not assumed. Direct precedent: dhive's documented broadcast timeout did not exist; the team only discovered the gap by reading source. The fetch-headers-vs-body split is the same shape applied to a standard-library primitive (WHATWG fetch) rather than a third-party library.
- WHATWG fetch standard, [Body section](https://fetch.spec.whatwg.org/#body-mixin): the spec text that defines the headers/body split. Body consumption is a separate `consume body` algorithm invoked by `Response.json()` etc., distinct from the network fetch step.
- `backend/src/routes/orcid.ts:215-245` (`fetchWithOrcidTimeout`): the existing PEvO instance of this pattern. Documented gap, accepted as residual risk for ORCID's deployment shape per the architect triage on 2026-05-06.
- `tasks-archive.md` "BACKEND-COAUTHOR-TRUST-MODEL (archived 2026-05-06)" — full review-and-dismissal context that motivated this learning.
