---
title: Customer Aggregation Point
category: Developer
tags: [fde, customer, configuration, aggregation]
importance: 9
last_updated: 2026-11-06
---

# Customer Aggregation Point

How Kyberion isolates **per-stance configuration** from the rest of the codebase, so that one checkout can be operated as several distinct entities without forking the repo.

## Current v2 contract (draft)

Stance (the operating entity), tenant (the confidentiality boundary), and a tenant's customer are separate concepts. `customer/` is now a legacy migration source only. The current stance template is `templates/stance/`; the directory and API descriptions below the historical heading do not describe current behavior.

| Purpose                                 | Current home / API                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| Stance configuration                    | `knowledge/personal/stances/{stance}/`, `stance.json`; activation: `KYBERION_STANCE` |
| Tenant company assets                   | `knowledge/confidential/{tenant}/`, `company.json`                                   |
| Tenant deals, documents and escalations | `knowledge/confidential/{tenant}/deals/`                                             |
| Stance traces                           | `active/shared/logs/stances/{stance}/traces/`                                        |
| Tenant audit mirror                     | `active/shared/runtime/audit-mirror/confidential/{tenant}/`                          |

Use published APIs, keeping selection separate from authorization:

```ts
import {
  activeStance,
  stanceRoot,
  resolveOverlay,
  overlayCandidates,
} from '@agent/core/stance-resolver';
import { tenantHomePath } from '@agent/core/organization/tenant-registry';

const stance = activeStance();
const connection = stanceRoot('connections/slack.json');
const company = tenantHomePath('acme-corp', 'company.json');
```

`activeCustomer` / `customerRoot` are historical v1 names; use `activeStance` / `stanceRoot`. A resolved path or active stance is not an access grant. Tenant reads/writes still pass through tenant-bound facades and secure I/O. Generic helpers use published foundation subpaths such as `@agent/core/foundation/text`; domain APIs use their published domain subpaths, not internal files.

### Migration order and compatibility status

Run `pnpm migration --dry-run` and review the plan before applying migrations, in this order:

| Migration          | Legacy source → current destination                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001-stance-home` | Stance configuration from `customer/{slug}/` → `knowledge/personal/stances/{slug}/`; constructs `stance.json` from legacy `customer.json`; traces → `active/shared/logs/stances/{slug}/traces/` |
| `0002-tenant-home` | Tenant company assets from `customer/{tenant}/` → `knowledge/confidential/{tenant}/`; `customer.json` → `company.json`; audit logs → confidential audit mirror                                  |
| `0003-deal-home`   | `customer/{tenant}/deals/` → `knowledge/confidential/{tenant}/deals/`; JSON/JSONL references follow the move                                                                                    |

The old v1 layout and resolver were stable. This is a breaking v2 proposal, requiring root/core major versions. The minimum 90-day deprecation period in [Extension Points §6](./EXTENSION_POINTS.md#6-deprecation) has **not been met**. Publication is **draft**; a maintainer exception decision is **pending**, not approved. No migration of user data is implied by this documentation.

## Archived v1 design — historical only

The remainder preserves the earlier design and API examples as historical evidence. Old commands, paths, resolver names and completion checklists below are not current instructions. For current usage, see [the stance template](../../templates/stance/README.md) and [the stance / tenant / customer model](../../knowledge/product/architecture/stance-tenant-customer-model.md).

### 1. Problem

Kyberion's previous configuration model assumed a legacy personal fallback:

- `knowledge/personal/` — legacy identity, vision, connections, tenants.
- `knowledge/confidential/{tenant-slug}/` — tenant-scoped governance (one confidentiality boundary).
- `knowledge/public/` — reusable knowledge.

For FDE / SI engagements, we need to:

1. Run the same Kyberion installation against multiple customers (sequentially or by clone).
2. Keep customer A's identity / connections / policy isolated from customer B's.
3. Keep the customization surface small enough that 80%+ of customer setup is config, not code.
4. Avoid forks of the main repo per customer.

A single `knowledge/personal/` cannot satisfy these.

### 2. Design

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

#### 2.1 Activation

The active customer is selected via the `KYBERION_STANCE` environment variable:

```bash
export KYBERION_STANCE=acme-corp
```

When unset, Kyberion falls back to the legacy `knowledge/personal/` behavior.

#### 2.2 Resolution Order

For a given config sub-path (e.g. `connections/slack.json`):

1. **Customer overlay**: `knowledge/personal/stances/{slug}/connections/slack.json` if it exists.
2. **Legacy personal fallback**: `knowledge/personal/connections/slack.json` if it exists.
3. **Public default**: for policy files, `knowledge/product/governance/slack.json` etc.

The resolver returns the first existing path. For writes, when a customer is active, writes go to the customer overlay path.

#### 2.3 Slug Validation

```
^[a-z0-9][a-z0-9_-]*$
```

- Lowercase ASCII alphanumeric, hyphen, underscore.
- Must start with letter or digit.
- Path traversal patterns (`..`, `/`, `\`) are rejected.

The validator is in `libs/core/customer-resolver.ts`. Any caller that uses `KYBERION_STANCE` must go through this resolver — direct path joins are forbidden.

#### 2.4 Secrets

Secrets must **never** live in the customer overlay, even though `knowledge/personal/stances/{slug}/` is gitignored. Use one of:

1. `secret-actuator` (OS keychain) — production / FDE deployments.
2. Environment variables for short-lived credentials.
3. `knowledge/personal/stances/{slug}/secrets.json` for local dev only — gitignored, not loaded by default. Loading requires explicit opt-in via secret-actuator.

### 3. What Goes Where

| File            | Customer overlay (`knowledge/personal/stances/{slug}/`) | Legacy personal fallback (`knowledge/personal/`) | Public default (`knowledge/public/`) |
| --------------- | ------------------------------------------------------- | ------------------------------------------------ | ------------------------------------ |
| Identity        | `identity.json`                                         | `my-identity.json`                               | —                                    |
| Vision          | `vision.md`                                             | `my-vision.md`                                   | —                                    |
| Connections     | `connections/*.json`                                    | `connections/*.json`                             | —                                    |
| Tenant facet    | `tenants/*.json` (optional reference facet)             | `tenants/*.json` (canonical registry)            | —                                    |
| Voice profile   | `voice/profile.json`                                    | `voice/profile-registry.json`                    | `voice/*`                            |
| Approval policy | `policy/approval-policy.json`                           | —                                                | `governance/approval-policy.json`    |
| Path scope      | `policy/path-scope-policy.json`                         | —                                                | `governance/path-scope-policy.json`  |
| Mission seeds   | `mission-seeds/*.json`                                  | —                                                | (additive only)                      |

### 4. Migration from Existing Single-User Setup

For users who already have a `knowledge/personal/` filled in:

1. **Do nothing** — the existing setup keeps working when `KYBERION_STANCE` is unset.
2. To convert to a customer-overlay structure:

   ```bash
   pnpm stance:create my-org
   # Copies knowledge/personal/* into customer/my-org/* with appropriate renames.
   export KYBERION_STANCE=my-org
   ```

   The conversion is a one-time copy; after it, edits to `customer/my-org/*` take precedence over `knowledge/personal/*`.

### 5. Resolver API

```typescript
import { customerResolver } from '@agent/core';

// Returns slug or null.
const slug = customerResolver.activeCustomer();

// Returns absolute path under knowledge/personal/stances/{slug}, or null if no customer active.
const path = customerResolver.customerRoot('connections/slack.json');

// Returns the resolved path with overlay precedence.
// Falls back to knowledge/personal/ when no overlay exists.
const resolved = customerResolver.resolveOverlay('connections/slack.json');

// Returns both candidates for callers that want to deep-merge (e.g. policy).
const { overlay, base } = customerResolver.overlayCandidates('policy/approval-policy.json');
```

### 6. Out of Scope (Future Work)

- **Live customer switching within a session** — currently requires restarting the process. A `pnpm stance:switch` command is a Phase D'-1 follow-up.
- **Concurrent multi-customer execution** — the current model assumes one active customer per process. Concurrent runs require separate processes with different env vars.
- **Customer-scoped trace storage** — trace files currently land under `active/shared/logs/`. Phase B-1 will extend this to `knowledge/personal/stances/{slug}/logs/` when a customer is active.
- **Stance-scoped `confidential/` tier** — this document covers the overlay only. Confidential data is separated by **tenant**, not by stance: that is the existing `knowledge/confidential/{tenant-slug}/` mechanism, and it is unchanged. A stance selects which tenants you can see; it never becomes a confidentiality boundary of its own.

### 7. Relationship to Existing Tier System

The customer overlay is an **additional resolution layer** on top of the existing 3-tier system, not a replacement.

```
Read order for config:
  knowledge/personal/stances/{slug}/{path}        ← new, per-customer
  knowledge/personal/{path}     ← existing, legacy fallback
  knowledge/confidential/...    ← existing, project-scoped
  knowledge/public/{path}       ← existing, reusable
```

The 3-tier system continues to govern **tier hygiene** (no leaks from confidential to public). Customer overlay sits at the same trust level as `personal` and inherits its tier rules; `knowledge/personal/` remains the legacy personal fallback when no customer is active.

### 8. Implementation Status

- [x] Directory structure (`customer/`, `templates/stance/`, `.gitignore` rules)
- [x] Resolver API (`libs/core/customer-resolver.ts`)
- [x] Resolver tests (`libs/core/customer-resolver.test.ts`)
- [x] CLI: `pnpm stance:create <slug>` (copies from `_template/`)
- [x] CLI: `pnpm stance:list`
- [x] CLI: `pnpm stance:switch <slug>` (validates + writes `active/shared/runtime/stance.env`)
- [x] Onboarding wizard integration (offer to create customer at start when `KYBERION_STANCE` is unset and the user is FDE-mode)
- [x] Migration helper: `pnpm stance:migrate-from-personal`
- [ ] Integration in `path-resolver.ts` consumers
  - [x] Connections consumer (`libs/core/service/service-engine.ts`)
  - [x] Policy consumer (`libs/core/governance/approval-policy.ts`)
  - [x] Mission seeds consumer (`libs/core/mission/mission-seed-registry.ts`)
  - [x] Voice profile registry consumer (`libs/core/voice/voice-profile-registry.ts`)
  - [x] Vital check consumer (`scripts/vital_check.ts`)
  - [x] Baseline check consumer (`scripts/run_baseline_check.ts`)
- [x] Onboarding apply consumer (`scripts/onboarding_apply.ts`)
- [x] Slack onboarding consumer (`libs/core/integrations/slack-onboarding.ts`)
  - [x] Mission prerequisites / creation consumer (`libs/core/mission/mission-state.ts`, `libs/core/mission/mission-creation.ts`, `libs/core/mission/mission-llm.ts`)

# Marketing Policy And Brand Overlay

With `KYBERION_STANCE=<slug>`, marketing risk policy resolves from `knowledge/personal/stances/<slug>/policy/marketing-risk-policy.json`; otherwise the product governance policy is used. Brand assets resolve under `knowledge/personal/stances/<slug>/brand/`, and customer Mission seeds under `knowledge/personal/stances/<slug>/mission-seeds/marketing/`. Never merge confidential artifacts between customer roots, and never copy customer content into `knowledge/public/`.

The marketing overlay contract is covered by an A/B filesystem test: two governed customer roots receive different allowed channels and CTA domains, resolve independently through `KYBERION_STANCE`, and do not affect the no-customer product fallback.
