---
category: Changed
---

- **OIDC login follow-ups** — the Next.js surfaces (concierge, chronos-mirror-v2, operator-surface) now rate-limit `/login` and `/auth/*` (per client and per surface, `429` + `Retry-After`); a wrong method on the login routes answers `405` with `Allow` and an accurate message instead of "expired"; "try again" and "different account" keep `next` and `lang`; a cross-site `GET /logout` no longer signs the user out; concierge `/signin` links back to the SSO sign-in; chronos prefers a live `kyberion_session` over a stale legacy `kyberion_token` cookie.
