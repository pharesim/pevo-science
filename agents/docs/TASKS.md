# PEvO Task Board — LEGACY (being drained)

> **NEW TASKS GO IN `agents/docs/tasks/pending/<role>-<kebab-summary>.md`.**
>
> This file is the old single-bulletin-board layout. It is kept read-mostly until the tasks still listed here are drained (moved to `review/` and archived by the architect). Do NOT add new tasks here. Entries leave naturally as their work completes; do NOT migrate existing entries in bulk.
>
> See `agents/docs/tasks/README.md` for the per-task-file layout, slug format, transitions, and archive rules. See root `CLAUDE.md` § Agent Coordination Rules #5-#9 for protocol.

When a task listed below is complete, create a corresponding task file in `agents/docs/tasks/review/<role>-<slug>.md` carrying the task's content and any re-review signal, then delete the entry's block from this file. The architect then archives per the new rules: prepend to `tasks-archive.md`, trim to 250 lines, `git rm` the per-task file.

Review history: `agents/docs/tasks-archive.md`

---

## Notes for next session

- endpoint allows repeated sending of accreditation custom_json, shouldn't fire if data is identical to last, and rate limit harder
- check bridge rate limit - must be very conservative to prevent spam
- check anonymous review rate limit, that must be extremely conservative
- how to handle mass import of all papers of one orcid id (authenticated)
- gemini reply regarding orcid public works and attribution

---


## On Hold

### BLOG-1 — Write launch blog post series (Architect + User)

**Goal:** Publish blog posts for the beta launch via the `pevo.science` Hive account with `pevo-blog` parent permlink. Published via HiveComb; PEvO blog section picks them up automatically.

**Track A — Why (the problems, the vision)**
1. The Long Road to Open Science
2. Open Access Isn't Enough — Where You Store It Matters
3. Rethinking Scientific Reputation
4. Open Evaluation Under Pressure
5. Why PEvO, Why Now — **published 2026-04-15** — `@pevo.science/publish-and-evaluate-openly-pevo-science-open-beta-officially-launched` (draft: `agents/docs/blog/why-pevo-why-now.md`)

**Track B — How (deep dives into PEvO mechanics)**
6. How Publishing Works on PEvO
7. The Reputation Algorithm Explained
8. Anonymous Review Without Losing Accountability
9. Accreditation — Verifying Scientists Without a Gatekeeper
10. Light Accounts — Zero-Friction Onboarding
11. The Preprint Bridge — Bringing arXiv/bioRxiv Into the Conversation
12. Community Pinning — How Anyone Can Help Host Science
13. Why Hive? The Infrastructure Behind PEvO

**Suggested sequence for remaining posts:**
1. "How Publishing Works on PEvO" (next)
2. "The Long Road to Open Science" (week 1)

---
