---
category: Fixed
---

- **OIDC login: rate limit and logout hardening** — the Next.js surfaces' `/login` and `/auth/*` limiter no longer lets one anonymous caller lock everyone out when callers cannot be told apart (no `KYBERION_TRUST_PROXY`): such traffic is capped only by the whole-surface ceiling, and loopback is exempt. `/logout` now also ignores same-site (sibling-subdomain) requests and, when `Sec-Fetch-Site` is absent, requests whose `Origin`/`Referer` is a foreign host.
