---
category: Security
---

- **Dev IdP no longer prints the session signing key** — `scripts/dev_oidc_idp.ts` used to echo `KYBERION_SESSION_SECRET` (the environment value, or a generated one) into its output, which the `dev-idp` surface writes to `active/shared/logs/surfaces/dev-idp.log`. It now prints no key: when stored or env OIDC settings already cover the IdP it says so, otherwise it shows `export KYBERION_SESSION_SECRET="$(openssl rand -hex 32)"`. If you used the old manual path, rotate the key you pasted.
