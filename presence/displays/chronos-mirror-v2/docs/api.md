# Chronos Mirror v2 — HTTP API

Base URL (default reconcile): `http://127.0.0.1:3000`

All routes accept the same access role headers honored by `lib/api-guard`. Read-only routes default to `readonly`.

| Route | Method | Purpose | Notes |
|---|---|---|---|
| `/api/identity` | GET | Sovereign / Agent identity from `knowledge/personal/{my-identity.json,agent-identity.json,my-vision.md}`. | New in 2026-05-08 cleanup. Returns `onboarded: false` until Path A or Path B onboarding runs. |
| `/api/agents` | GET | Live agent runtime snapshot. `?providers=true` lists discovered providers, `?manifests=true` lists manifested agent definitions. | Empty `agents: []` on a fresh ecosystem. |
| `/api/agents` | POST | Spawn / ask / a2a / logs / refresh / restart via `action` field. | See AgentPanel.tsx for examples. |
| `/api/agents` | DELETE | Shutdown an agent. | |
| `/api/intelligence` | GET | One-shot intelligence snapshot. | Used by the Mission Intelligence panel for initial render. |
| `/api/intelligence/stream` | GET | SSE feed of incremental intelligence updates (~2s tick). | Sends `retry: 3000` immediately, then `data: {...}` events. |
| `/api/runtime-file` | GET | Read a governed file by path. | Requires query params; 400 without. |
| `/api/knowledge-ref` | GET | Resolve a knowledge reference by token. | Requires query params; 400 without. |
| `/api/mission-asset` | GET | Fetch mission-scoped asset. | |
| `/api/agent` | * | Legacy single-agent helper. | Prefer `/api/agents`. |

## `/api/identity` response

```json
{
  "status": "ok",
  "onboarded": true,
  "sovereign": {
    "name": "もとちゃん",
    "language": "Japanese",
    "interaction_style": "Senior Partner",
    "primary_domain": "Financial Services IT Management",
    "status": "active"
  },
  "agent": {
    "agent_id": "KYBERION-PRIME",
    "role": "Ecosystem Architect / Senior Partner",
    "owner": "もとちゃん",
    "trust_tier": "sovereign"
  },
  "vision": "..."
}
```

When the personal tier has not been initialized, every nested object is `null` and `onboarded` is `false`. The IdentityBadge in the header switches to an amber "Onboarding required" pill in that state.

## `/api/intelligence/stream` event format

```
retry: 3000

data: {"ts":"...","accessRole":"readonly","recentEvents":[],...,"runtimeTopology":{...}}
```

The route only sends `data:` events when the JSON payload changes from the prior tick (debouncing). Clients should keep the connection alive; it is closed safely on client abort and never leaks `ERR_INVALID_STATE` (verified after 2026-05-08 fix).

## Health probing

`/api/agents` is the canonical healthPath for `chronos-mirror-v2` in `knowledge/public/governance/active-surfaces.json`. A 200 response (even empty `agents: []`) marks the surface as `already_healthy` during reconcile.
