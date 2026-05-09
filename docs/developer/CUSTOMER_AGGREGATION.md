---
title: Customer Aggregation Point
category: Developer
tags: [fde, customer, configuration, aggregation]
importance: 9
last_updated: 2026-05-07
---

# Customer Aggregation Point

How Kyberion isolates **per-customer / per-deployment configuration** from the rest of the codebase, so that an FDE engineer can run a customer engagement without forking the repo.

This document defines the contract. For day-to-day usage, see [`customer/README.md`](../../customer/README.md).

## 1. Problem

Kyberion's previous configuration model assumed a single sovereign:

- `knowledge/personal/` — single-user identity, vision, connections, tenants.
- `knowledge/confidential/{project}/` — project-scoped governance.
- `knowledge/public/` — reusable knowledge.

For FDE / SI engagements, we need to:

1. Run the same Kyberion installation against multiple customers (sequentially or by clone).
2. Keep customer A's identity / connections / policy isolated from customer B's.
3. Keep the customization surface small enough that 80%+ of customer setup is config, not code.
4. Avoid forks of the main repo per customer.

A single `knowledge/personal/` cannot satisfy these.

## 2. Design

A new top-level directory `customer/` aggregates everything that varies per customer.

```
customer/
├── README.md                       (committed)
├── _template/                      (committed) — copy this to start a new customer
└── {customer-slug}/                (gitignored) — per-customer config
    ├── customer.json
    ├── identity.json
    ├── vision.md
    ├── connections/
    ├── tenants/
    ├── policy/
    ├── voice/
    ├── mission-seeds/
    └── secrets.json          (optional, gitignored regardless)
```

### 2.1 Activation

The active customer is selected via the `KYBERION_CUSTOMER` environment variable:

```bash
export KYBERION_CUSTOMER=acme-corp
```

When unset, Kyberion falls back to the existing single-user behavior (`knowledge/personal/` only).

### 2.2 Resolution Order

For a given config sub-path (e.g. `connections/slack.json`):

1. **Customer overlay**: `customer/{slug}/connections/slack.json` if it exists.
2. **Personal fallback**: `knowledge/personal/connections/slack.json` if it exists.
3. **Public default**: for policy files, `knowledge/public/governance/slack.json` etc.

The resolver returns the first existing path. For writes, when a customer is active, writes go to the customer overlay path.

### 2.3 Slug Validation

```
^[a-z0-9][a-z0-9_-]*$
```

- Lowercase ASCII alphanumeric, hyphen, underscore.
- Must start with letter or digit.
- Path traversal patterns (`..`, `/`, `\`) are rejected.

The validator is in `libs/core/customer-resolver.ts`. Any caller that uses `KYBERION_CUSTOMER` must go through this resolver — direct path joins are forbidden.

### 2.4 Secrets

Secrets must **never** live in the customer overlay, even though `customer/{slug}/` is gitignored. Use one of:

1. `secret-actuator` (OS keychain) — production / FDE deployments.
2. Environment variables for short-lived credentials.
3. `customer/{slug}/secrets.json` for local dev only — gitignored, not loaded by default. Loading requires explicit opt-in via secret-actuator.

## 3. What Goes Where

| File | Customer overlay (`customer/{slug}/`) | Personal fallback (`knowledge/personal/`) | Public default (`knowledge/public/`) |
|---|---|---|---|
| Identity | `identity.json` | `my-identity.json` | — |
| Vision | `vision.md` | `my-vision.md` | — |
| Connections | `connections/*.json` | `connections/*.json` | — |
| Tenants | `tenants/*.json` | `tenants/*.json` | — |
| Voice profile | `voice/profile.json` | `voice/profile-registry.json` | `voice/*` |
| Approval policy | `policy/approval-policy.json` | — | `governance/approval-policy.json` |
| Path scope | `policy/path-scope-policy.json` | — | `governance/path-scope-policy.json` |
| Mission seeds | `mission-seeds/*.json` | — | (additive only) |

## 4. Migration from Existing Single-User Setup

For users who already have a `knowledge/personal/` filled in:

1. **Do nothing** — the existing setup keeps working when `KYBERION_CUSTOMER` is unset.
2. To convert to a customer-overlay structure:
   ```bash
   pnpm customer:create my-org
   # Copies knowledge/personal/* into customer/my-org/* with appropriate renames.
   export KYBERION_CUSTOMER=my-org
   ```

   The conversion is a one-time copy; after it, edits to `customer/my-org/*` take precedence over `knowledge/personal/*`.

## 5. Resolver API

```typescript
import { customerResolver } from '@agent/core';

// Returns slug or null.
const slug = customerResolver.activeCustomer();

// Returns absolute path under customer/{slug}, or null if no customer active.
const path = customerResolver.customerRoot('connections/slack.json');

// Returns the resolved path with overlay precedence.
// Falls back to knowledge/personal/ when no overlay exists.
const resolved = customerResolver.resolveOverlay('connections/slack.json');

// Returns both candidates for callers that want to deep-merge (e.g. policy).
const { overlay, base } = customerResolver.overlayCandidates('policy/approval-policy.json');
```

## 6. Out of Scope (Future Work)

- **Live customer switching within a session** — currently requires restarting the process. A `pnpm customer:switch` command is a Phase D'-1 follow-up.
- **Concurrent multi-customer execution** — the current model assumes one active customer per process. Concurrent runs require separate processes with different env vars.
- **Customer-scoped trace storage** — trace files currently land under `active/shared/logs/`. Phase B-1 will extend this to `customer/{slug}/logs/` when a customer is active.
- **Customer-scoped `confidential/` tier** — this document covers the single-sovereign overlay; per-customer confidential tier separation is the existing `knowledge/confidential/{project}/` mechanism and is unchanged.

## 7. Relationship to Existing Tier System

The customer overlay is an **additional resolution layer** on top of the existing 3-tier system, not a replacement.

```
Read order for config:
  customer/{slug}/{path}        ← new, per-customer
  knowledge/personal/{path}     ← existing, single-sovereign
  knowledge/confidential/...    ← existing, project-scoped
  knowledge/public/{path}       ← existing, reusable
```

The 3-tier system continues to govern **tier hygiene** (no leaks from confidential to public). Customer overlay sits at the same trust level as `personal` and inherits its tier rules.

## 8. Implementation Status

- [x] Directory structure (`customer/`, `customer/_template/`, `.gitignore` rules)
- [x] Resolver API (`libs/core/customer-resolver.ts`)
- [x] Resolver tests (`libs/core/customer-resolver.test.ts`)
- [x] CLI: `pnpm customer:create <slug>` (copies from `_template/`)
- [x] CLI: `pnpm customer:list`
- [x] CLI: `pnpm customer:switch <slug>` (validates + writes `active/shared/runtime/customer.env`)
- [x] Onboarding wizard integration (offer to create customer at start when `KYBERION_CUSTOMER` is unset and the user is FDE-mode)
- [x] Migration helper: `pnpm customer:migrate-from-personal`
- [ ] Integration in `path-resolver.ts` consumers
  - [x] Connections consumer (`libs/core/service-engine.ts`)
  - [x] Policy consumer (`libs/core/approval-policy.ts`)
  - [x] Mission seeds consumer (`libs/core/mission-seed-registry.ts`)
