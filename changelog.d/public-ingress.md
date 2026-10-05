---
category: Added
---

- **Public ingress for surfaces (`pnpm kyberion ingress probe|status|up|down`)** — expose one opted-in loopback surface at a public HTTPS URL through a provider-independent capability (contract + `public-ingress-provider` seam + `public-ingress-providers.json` catalog + resolver). Tailscale Funnel is the first live provider; Cloudflare Tunnel (quick/named) and ngrok are declared as planned and shown as unsupported. `up` requires the surface manifest `ingress.allowed` opt-in (event-intake publishes only `/events`), a healthy surface and an approved `ingress:expose` request; exposures are audited and recorded under `active/shared/runtime/ingress/`. After `up`, the CLI prints the webhook URL per enabled event-intake source. Select a provider with `--provider` or `KYBERION_INGRESS_PROVIDER`; `pnpm kyberion doctor --manifest public-ingress` lists setup steps.
