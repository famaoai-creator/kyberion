---
category: Added
---

- **Local dev OIDC IdP for surface login** — `node --import ./scripts/ts-loader.mjs scripts/dev_oidc_idp.ts` starts a throw-away OpenID Connect provider on `127.0.0.1:9099` (discovery, authorize with PKCE S256, token, JWKS, RS256 id_token) and prints the `KYBERION_OIDC_*` / `KYBERION_SESSION_SECRET` exports plus the `pnpm organization member link-identity` command, so the surface `/login` flow can be tried locally without a Google or Entra client. It signs in any visitor as one fixed subject, so it is loopback-only, redirects only to `http://localhost:<port>/auth/callback`, refuses `NODE_ENV=production`, and sessions still require the subject to be bound to an active member. See [SURFACE_OIDC_LOGIN_OPERATIONS](docs/developer/SURFACE_OIDC_LOGIN_OPERATIONS.ja.md).
