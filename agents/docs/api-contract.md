# PEvO API Contract — Index

The API contract is split by domain. Read only the file(s) relevant to your current task.

| File | Endpoints |
|------|-----------|
| [common.md](api-contracts/common.md) | Response envelope, error codes, authentication notes, CORS, rate limits, versioning |
| [auth.md](api-contracts/auth.md) | `/api/auth/*` -- session, signup, login, password reset, recovery |
| [orcid.md](api-contracts/orcid.md) | `/api/orcid/*` -- unified ORCID OAuth (signup, login, accredit, link) |
| [papers.md](api-contracts/papers.md) | `/api/papers/*`, `/api/search` — list, detail, enrichment, comments, cite, retract, invalidate, search |
| [reviews.md](api-contracts/reviews.md) | `/api/reviews/*` — single review, anonymous review |
| [profiles.md](api-contracts/profiles.md) | `/api/profile/*`, `/api/accounts/search` — profiles, notification prefs |
| [settings.md](api-contracts/settings.md) | `/api/settings/*` — email management, `set-password` (opt-in to password login) |
| [accreditation.md](api-contracts/accreditation.md) | `/api/accreditations/*`, `/api/accreditation/*`, `/api/wot/*` -- accreditation, web of trust |
| [custody.md](api-contracts/custody.md) | `/api/custody/*` — light account broadcast, upgrade to self-custody |
| [ipfs.md](api-contracts/ipfs.md) | `/api/ipfs/*` — file upload, IPFS gateway proxy |
| [bridge.md](api-contracts/bridge.md) | `/api/bridge/*` — preprint lookup, check, register, update |
| [notifications.md](api-contracts/notifications.md) | `/api/notifications` — polling notification events |
| [misc.md](api-contracts/misc.md) | `/api/blog/*`, `/api/contact`, `/api/disciplines`, `/api/stats`, `/api/health` |
