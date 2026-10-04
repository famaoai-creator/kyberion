---
title: Expose a surface through public ingress (Tailscale Funnel)
category: system
tags: [ingress, tailscale, funnel, event-intake, webhook, adapter, security, operations]
audience: [operator, developer]
last_updated: 2026-10-05
---

# Expose a surface through public ingress

Kyberion surfaces listen on `127.0.0.1` only. When an external sender must reach
one — typically GitHub webhooks into the event-intake surface — `pnpm kyberion
ingress` publishes exactly one opted-in surface path at a public HTTPS URL
through a provider from
[`public-ingress-providers.json`](../../product/governance/public-ingress-providers.json).
Tailscale Funnel is the first live provider; Cloudflare Tunnel (quick / named)
and ngrok are declared as `planned` and show up as `unsupported` until their
modules ship.

## Guard rails

- Only a surface whose manifest has `ingress.allowed: true` can be exposed, and
  only its `ingress.path_prefix` is published (event-intake: `/events`, so
  `/health` and every other path stay local).
- The surface must answer its health probe before anything is exposed.
- `up` is the governed risky op `ingress:expose`: the first run opens an
  approval request; a human approves it, then the command is re-run. An
  approval is valid for 24 h per surface/provider pair.
- `down` and `status` need no approval. Every expose/withdraw is written to the
  audit chain (`ingress_expose` / `ingress_withdraw`) and the exposure is
  recorded in `active/shared/runtime/ingress/state.json`.
- A provider is never swapped silently: `--provider` or
  `KYBERION_INGRESS_PROVIDER` that is not ready fails with its reason; without
  one, the first ready live provider is used and the route is printed.

## One-time setup: Tailscale Funnel (macOS)

1. Install Tailscale: `brew install --cask tailscale-app` (or
   <https://tailscale.com/download>), open it and sign in to your tailnet.
2. Make the CLI reachable: Tailscale menu > Settings > **Install CLI**, or set
   `KYBERION_TAILSCALE_BIN=/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
3. In the admin console **DNS** page (<https://login.tailscale.com/admin/dns>)
   enable **MagicDNS** and **HTTPS Certificates**.
4. In **Access controls**, grant this device the `funnel` node attribute, e.g.
   `"nodeAttrs": [{ "target": ["autogroup:member"], "attr": ["funnel"] }]`
   (narrow `target` to this machine or a tag if you prefer).
5. Check readiness: `pnpm kyberion ingress probe` — `tailscale-funnel` must say
   `ready`; otherwise it prints the missing step.
   `pnpm kyberion doctor --manifest public-ingress` shows the same result.

## Expose event intake for GitHub webhooks

1. Enable the source and store its secret (see `dots/README.md`, "Operator
   steps"): set `enabled: true` for `github` in
   `knowledge/product/governance/event-intake-policy.json` and register
   `EVENT_INTAKE_GITHUB_SECRET` with `pnpm kyberion secret introduce`.
2. Start the surface: `pnpm surfaces enable -- --surface event-intake-surface`
   then `pnpm surfaces start -- --surface event-intake-surface`.
3. `pnpm kyberion ingress up --surface event-intake` — prints
   `Approve: pnpm kyberion approvals --approve <id>`. Approve it, then re-run
   the same `up` command. It prints the public URL and one webhook URL per
   enabled source, e.g. `github: https://<machine>.<tailnet>.ts.net/events/github`.
4. In the GitHub repository: Settings > Webhooks > Add webhook. Payload URL =
   the printed `github` URL, content type `application/json`, secret = the same
   value as `EVENT_INTAKE_GITHUB_SECRET`. GitHub's ping should return 202.
5. `pnpm kyberion ingress status` confirms the mapping is live;
   `pnpm kyberion ingress down --surface event-intake` withdraws it.

## Privacy and network note

Funnel makes `https://<machine>.<tailnet>.ts.net/events/*` reachable from the
whole internet; traffic is relayed by Tailscale and TLS terminates on this
machine. The machine name and tailnet name become publicly visible (and appear
in certificate transparency logs). Requests are only accepted with a valid HMAC
signature for an enabled source. Funnel applies to the whole HTTPS port, so
`up` refuses to switch it on while other tailnet-only `tailscale serve`
mappings exist on port 443 — move those to another port first. `down` removes
only the `/events` mapping and never resets other mappings.

## Troubleshooting

- `tailscale CLI not found` — step 2 above.
- `tailscale is NeedsLogin/Stopped` — sign in / connect in the Tailscale app.
- `funnel node attribute is not granted` — step 4; changes apply within a minute.
- `path /events ... already proxies to ...` — another process owns the path;
  inspect with `tailscale funnel status` and remove it deliberately.
- `INGRESS_SURFACE_UNHEALTHY` — start the surface (setup step 2).

## Adding another provider

Providers follow the
[adapter-first extension policy](../../product/governance/adapter-first-extension-policy.md):

1. Add (or flip from `planned` to `live`) an entry in
   `public-ingress-providers.json` — id, `module`
   (`@agent/core/ingress/providers/<id>`), `tool_id`, `stable_url`,
   `network_class`, `secret_refs` (secret-store key names only, never values).
2. Add `libs/core/ingress/providers/<id>.ts` exporting
   `createPublicIngressProvider()` that implements `PublicIngressProvider`
   (`probe` / `up` / `down` / `status`) with pure, unit-tested command builders
   and an injectable command runner; register its tool runtime under
   `tool-runtimes/` and the package export in `libs/core/package.json`.
3. Add hermetic tests for readiness, command construction and status parsing.

The CLI, approval gate, audit, state and doctor probe need no change.
