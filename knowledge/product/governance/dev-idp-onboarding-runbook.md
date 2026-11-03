---
title: 'Dev-IdP onboarding runbook — signing in to Concierge locally'
tags: [runbook, onboarding, oidc, dev-idp, concierge, approval]
last_updated: 2026-11-04
---

# Dev-IdP onboarding runbook

How a person signs in to local Concierge via the disposable dev OIDC provider
and ends up able to make A2 (`human_only`) approvals from the browser. Verified
end to end on 2026-11-03 (MSN-CONCIERGE-AUTH-UX / MSN-DEV-IDP-RUNBOOK-20261103).

## Components

| Piece             | What it is                                                                                                                                                                                             | Port   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `dev-idp` surface | Loopback-only disposable OIDC IdP (`scripts/dev_oidc_idp.ts`). Signs in **any** visitor as one fixed subject (`dev-user`). Refuses `NODE_ENV=production`; only redirects to loopback `/auth/callback`. | `9099` |
| Concierge         | The app you sign in to.                                                                                                                                                                                | `3050` |

dev-idp defaults: issuer `http://localhost:9099` (**localhost, byte-for-byte —
not `127.0.0.1`**), client_id `kyberion-dev`, subject `dev-user`,
no client_secret needed (`token_endpoint_auth_methods_supported: ["none", "client_secret_post"]`).

## Procedure

### 1. Start dev-idp

Manifest ships `enabled: false`. Start it explicitly:

```sh
pnpm surfaces reconcile            # brings declared surfaces up
# or just the IdP:
node --import ./scripts/ts-loader.mjs scripts/dev_oidc_idp.ts &
curl -sf http://localhost:9099/.well-known/openid-configuration | head
```

### 2. Configure SSO in Concierge (instance owner only)

`http://localhost:3050/settings` → セットアップ → SSO settings
(`sso-settings-form.tsx`, persisted by `PUT /api/setup/oidc`):

| Field           | Value                                               |
| --------------- | --------------------------------------------------- |
| issuer          | `http://localhost:9099`                             |
| client_id       | `kyberion-dev`                                      |
| client_secret   | (leave empty or any value — dev-idp accepts `none`) |
| public_base_url | `http://localhost:3050`                             |

Settings are stored in secret-guard and apply **without a restart**.

### 3. Link the IdP subject to a member

Sign-in alone grants nothing: the fixed subject must be bound to an active
member. `POST /api/setup/link-identity` (instance-owner route) links the
OIDC subject `dev-user` to the owner member. After this, signing in resolves
that member's `ViewerContext`.

### 4. Sign in

`http://localhost:3050/login` → concierge bounces to
`http://localhost:9099/authorize?...` → dev-idp shows a one-click "Sign in as
dev-user?" page → redirects back to `http://localhost:3050/auth/callback`
with a code → concierge exchanges it and sets a member session.

You are now a signed-in member at A2. `human_only` approval requests in the
services → 権限と承認 / approvals panels can be decided in the browser —
this is the only path that satisfies `decidedByType: human` without a TTY.

Signed in as the owner member, you can also use the installation-scope
settings: operator services, your profile and avatar, and personal onboarding
authority. From another device, a change first needs a passkey confirmation.
After the owner is bound, an unauthenticated loopback browser is sent to
`/login`. See [installation-owner-authorization](./installation-owner-authorization.md),
which also covers the `KYBERION_CONCIERGE_ALLOW_ANONYMOUS_LOOPBACK` escape hatch.

## Guardrails / gotchas

- **Issuer spelling**: `localhost` ≠ `127.0.0.1`. The issuer saved in SSO
  settings must match dev-idp's issuer byte-for-byte or discovery fails.
- **`about:blank` popup bug (fixed)**: service-connect used
  `window.open('', '_blank', 'noopener')` which returns `null` and loses the
  popup handle. Fixed via `src/lib/oauth-popup.ts`; if you see a stuck blank
  tab, you are on a build before that fix.
- **Checkout-local stores**: charters/approval requests live under
  `knowledge/personal/charters` and `active/shared/coordination/channels/*/approvals`
  **per checkout** (gitignored). A request created from a linked worktree is
  invisible to the main checkout's concierge until the canonical-store
  unification (MSN-PRESENCE-E2E-20261103 E2E-3) lands — approve it with
  `pnpm kyberion approvals --approve <id>` **from the same checkout** that
  created it, or in the UI of the surface bound to that checkout.
- **Never enable dev-idp outside local verification**: it authenticates
  nobody; it exists so the OIDC code path can be exercised without a real IdP.

## Failure triage

| Symptom                                        | Cause                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `/login` 500s / no redirect                    | SSO settings missing or issuer mismatch — re-do step 2                                                                    |
| Sign-in succeeds but viewer is still anonymous | subject not linked — step 3                                                                                               |
| Approval cards absent / 403 on settings panels | not instance owner — `viewerIsInstanceOwner` gate                                                                         |
| `installation_step_up_required` on a change    | remote owner write — confirm with passkey (see [installation-owner-authorization](./installation-owner-authorization.md)) |
| Loopback browser now lands on `/login`         | owner bound — anonymous loopback retired; sign in                                                                         |
| dev-idp refuses to start                       | `NODE_ENV=production` or non-loopback bind — by design                                                                    |
