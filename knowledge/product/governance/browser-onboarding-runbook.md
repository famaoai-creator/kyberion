---
title: Browser onboarding runbook (Concierge web flow)
tags: [onboarding, concierge, surfaces, passkey, attestation, operations]
last_updated: 2026-10-24
---

# Browser onboarding runbook

How a human completes first-run setup and provider attestation entirely from a
browser on the Concierge surface — and the operational requirements that must
hold for each step to work.

## Prerequisites — surfaces that must be running

```bash
pnpm surfaces --action start --surface concierge        # :3050 (this surface)
pnpm surfaces --action start --surface presence-studio  # :3031 — settings page deps
pnpm surfaces --action start --surface dev-idp          # :9099 — OIDC sign-in
```

- **presence-studio down → `/settings` fails wholesale.** The settings load
  chain proxies `/api/training/catalog` and `/api/voice/selection` to it;
  503 there surfaces as "could not load settings" — not a per-section error.
- **dev-idp down → "Sign in with Dev IdP" 502s.** `/auth/start` proxies it.

## Server process environment — passkeys refuse under agent env

Start concierge **without agent markers** in its environment:
`AI_AGENT`, `KYBERION_AGENT_ID`, `KYBERION_NHI_ID`, `KYBERION_RUN_ORIGIN=agent`
make `detectAgentExecutionContext` classify the server as acting for an agent,
and human-proof routes (passkey enrollment, signed decisions) return 403
`session_required` / `agent_refused`. Launch via the surface runtime or a
clean shell (`env -u AI_AGENT …` before launching it).

Passkeys also need the public origin — set it on the concierge process
environment before starting the surface:

```bash
KYBERION_OIDC_PUBLIC_BASE_URL=http://localhost:3050 \
  pnpm surfaces --action start --surface concierge
```

Without it `/api/me/passkeys` and `/api/approvals/:id/passkey` return 503
`origin_not_configured`.

## The journey

### 1. First-run claim (unauthenticated, once)

```bash
pnpm organization first-run code   # prints a one-time code + URL
```

Open `http://localhost:3050/setup/first-run#code=<code>` in a browser. The page
asks for tenant + display name, then provisions the owner member and returns a
session token. The code dies on use; re-issuing replaces it.

### 2. Sign in — pick the right path

| Path                      | How                                     | What you get                                                                                                                        |
| ------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Dev IdP (recommended)** | `/` → "Sign in with Dev IdP" → dev-user | Member session cookie (`kyberion_session`) — reads **and** mutations (decisions, passkey)                                           |
| **Access token**          | `/signin` → paste token                 | Read-level session — most GETs work, mutations (approvals, passkey) are refused by design (`localadmin`/`surface_session` required) |

The OIDC subject must be bound to a member first, else sign-in lands on
"identity is not bound to a member":

```bash
pnpm organization member link-identity owner \
  --issuer http://localhost:9099 --subject dev-user
```

(Settings → Organization and members → SSO shows pending identities for
binding.)

### 3. Register a passkey

Settings → Passkeys → "Register a passkey". Enrollment is itself A3-gated: it
needs a member browser session (never a bearer token) and a clean agent-env
server. **A fresh passkey cools down ~24h before it can sign A3 decisions** —
plan enrollment ahead of need, or keep the CLI terminal challenge
(`terminal_attested`, A2) as the interim path for human-only requests.

### 4. Decide a pending approval

Home → Decide → the tenant → the card → Approve/Reject/Later.
A2+ requests (e.g. provider attestation) are routed to the passkey flow
(`/api/approvals/:id/passkey`); A0/A1 use the plain card decision.

### 5. Provider attestation without CLI

Settings → **Provider attestation**: pick tenant + provider + `training_use`,
fill plan/basis/attested_by, "Request approval" — the request lands in the same
approval queue (channel `tenant-provider-attestation`) and is decided by the
passkey flow above. An applied attestation opens confidential/personal egress
for that provider on that tenant only.

## Failure atlas (what the error usually means)

| Symptom                                            | Likely cause                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| "could not load settings"                          | presence-studio down (or a strict-parse shape change)                                                        |
| "connection / sign-in info" on Decide/Summary      | no session token in the tab (sessionStorage `front-desk.token`) — sign in properly                           |
| Sign-in "identity is not bound"                    | OIDC subject not linked: `member link-identity`                                                              |
| passkey enrollment/decision 403 `session_required` | token session or agent env on the server                                                                     |
| passkey route 503 `origin_not_configured`          | `KYBERION_OIDC_PUBLIC_BASE_URL` unset                                                                        |
| Approve click → 500 `invalid_request`              | request needs human proof (A2+) but was sent to the plain decision endpoint — it must take the passkey route |
| New passkey can't decide                           | enrollment cooldown (~24h) still running — wait or use the CLI approve                                       |

## Scope notes

- All routes resolve the viewer and tenant scope **server-side**; the
  `tenant` param only narrows it. A token/session for tenant A never reads or
  decides tenant B.
- `/api/onboarding-authority` is mutation-gated and refuses plain member
  sessions today — authority review there is still operator-tier work.
