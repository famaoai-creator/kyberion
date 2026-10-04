# OAuth Service Setup

This document covers connecting an OAuth integration that is already defined
in Kyberion. To add a new integration, start with the
[Service Integration and Connection Guide](../knowledge/product/orchestration/service-integration-guide.md#oauth-egress-authority-and-harness-controls).

## Before setup

The service preset must define its OAuth profile (`authorize_url`, explicit
least-privilege `scopes`, `token_operation`, and optional `refresh_operation`)
and the matching code-exchange/refresh operations. Kyberion's OAuth broker
rejects requested scopes that are not in the preset's scope list. PKCE is on
by default; disable it only when the provider cannot support it.

Create an OAuth app with the provider and register the callback URI used by
Kyberion. The default is:

```text
http://127.0.0.1:8787/oauth/callback
```

The host, port, and path can be configured with the registered
`KYBERION_OAUTH_CALLBACK_HOST`, `KYBERION_OAUTH_CALLBACK_PORT`, and
`KYBERION_OAUTH_CALLBACK_PATH` settings. The callback must remain loopback
HTTP; non-loopback redirects are rejected.

## Store client credentials and authorize

Store the OAuth app credentials through the governed secret flow. Do not edit
`vault/secrets/secrets.json`, connection documents, or `.env` directly:

```bash
pnpm kyberion secret introduce <service-id> CLIENT_ID
pnpm kyberion secret introduce <service-id> CLIENT_SECRET
```

Follow any approval/apply steps printed by the command. Then start the
interactive OAuth setup pipeline:

```bash
pnpm pipeline --input pipelines/setup-oauth.json --vars "service_name=<service-id>"
```

Open the authorization URL printed by the pipeline, approve the requested
scopes at the provider, and return to the terminal when the callback reports
completion. Kyberion exchanges the code and stores the returned tokens in the
active private connection overlay through the OAuth broker. The callback
server is stopped after setup.

## Verify

```bash
pnpm kyberion secret status <service-id>
pnpm service:setup
pnpm service:preflight -- --service <service-id>
```

These commands report registration/readiness without printing secret values.
Preflight may also check CLI, bridge, or local-runtime prerequisites for that
service. OAuth token revocation is not exposed by the current OAuth broker
action surface; do not assume a provider preset's `revoke_operation` field
means Kyberion can revoke a grant.

OAuth consent scopes are provider-side permissions. They do not replace
Kyberion's egress policy, tenant data boundaries, operation approval rules, or
mission authority grants. See the
[Service Integration and Connection Guide](../knowledge/product/orchestration/service-integration-guide.md#egress-and-authority)
for those boundaries.
