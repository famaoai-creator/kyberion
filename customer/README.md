# Affiliation Overlay Directory (`customer/`)

**What this actually is:** an overlay on `knowledge/personal/`. When
`KYBERION_CUSTOMER` is set, `customer/{slug}/` replaces "who I am and how I
operate" — identity, connections, policy, voice, mission seeds — for the
duration. See `libs/core/customer-resolver.ts`.

So the directory does not hold _customers_. It holds **the stances you can
operate from**, one per slug. "Deploying for a customer" is one such stance,
not the definition.

## When to use this directory

Any time "which hat am I wearing" changes what Kyberion should be:

- **Engagement (FDE / SI)** — you run Kyberion on behalf of an end customer,
  with their identity, connections and policy.
- **Concurrent affiliation** — you hold roles at several independent legal
  entities (e.g. an executive serving on multiple boards) and must act as one
  at a time, with that entity's connections and approval policy.
- **Multiple deployments side by side** in one checkout.

A single individual with exactly one stance does not need this directory —
`knowledge/personal/` alone is enough. Needing it is about _how many stances_
you have, not about whether you are an individual or a firm.

## The three things called "customer"

They are different layers and are easy to confuse. The canonical containment
hierarchy is `tenant_slug → organization_id → project_id → mission_id → …`
(see `knowledge/product/architecture/entity-scope-hierarchy.md`).

| Concept                      | Question it answers                         | Where it lives                               |
| ---------------------------- | ------------------------------------------- | -------------------------------------------- |
| **Stance** (this directory)  | Which stance am I operating from right now? | `customer/{slug}/` + `KYBERION_CUSTOMER`     |
| **Tenant**                   | Which confidentiality boundary am I inside? | `knowledge/confidential/{tenant}/`           |
| **A tenant's own customers** | Who does that tenant deliver to?            | `knowledge/confidential/{tenant}/customers/` |

A stance slug and a tenant slug are often spelled the same (you operate as that
entity, and that entity is a confidentiality boundary), but they are not the
same thing: the stance is runtime configuration, the tenant is a data boundary.

**A tenant's customers do not go here.** They belong inside that tenant's own
boundary, next to its other substance (`organization/`, `security/`, …). Putting
them under `customer/{slug}/` would place one tenant's customer records outside
the boundary that is supposed to contain them.

## Layout

```
customer/
├── README.md                       # this file (committed)
├── _template/                      # template for new customers (committed, copy from this)
│   ├── README.md
│   ├── customer.json               # stance metadata
│   ├── identity.json               # sovereign identity for this stance
│   ├── vision.md                   # vision document
│   ├── connections/                # external service connections (placeholder)
│   ├── tenants/                    # tenant profiles readable from this stance
│   ├── policy/                     # policy overrides for this stance
│   ├── voice/                      # voice profile overrides
│   ├── mission-seeds/              # stance-specific mission templates
│   └── secrets.local.example.json  # secret reference template
└── {slug}/                         # per-stance dir (gitignored — never commit secrets)
    └── ...                         # same shape as _template/
```

`tenants/` is the tenant **profile** directory for this stance — it overrides
`knowledge/personal/tenants/` (see `tenantProfileDir()` in
`libs/core/tenant-registry.ts`). It declares which tenants exist and where their
knowledge roots are. It is **not** where a tenant's customer records go.

## Quickstart

```bash
# 1. Copy the template into a new customer slug (lowercase, hyphenated, no spaces)
pnpm customer:create acme-corp

# 2. Fill in customer/acme-corp/customer.json, identity.json, vision.md
$EDITOR customer/acme-corp/customer.json

# 3. Activate that customer in your shell
export KYBERION_CUSTOMER=acme-corp

# 3b. Confirm what customer overlays exist in this checkout
pnpm customer:list
# Shows active overlays and whether the required customer.json / identity.json / vision.md files are present.

# Optional: migrate your existing personal setup into this customer overlay
pnpm customer:migrate-from-personal acme-corp

# Optional: write an activation profile for this customer
pnpm customer:switch acme-corp
source active/shared/runtime/customer.env

# customer:switch requires customer.json / identity.json / vision.md to be present.

# 4. Run Kyberion as usual
pnpm onboard
pnpm doctor
```

When `KYBERION_CUSTOMER` is set, Kyberion overlays `customer/{slug}/` on top of `knowledge/personal/`. Files in the customer dir take precedence; missing files fall back to `knowledge/personal/`.

## Resolution rules

| Lookup                                                                         | Order                                              |
| ------------------------------------------------------------------------------ | -------------------------------------------------- |
| `customer/{slug}/identity.json` → `knowledge/personal/my-identity.json`        | overlay → fallback                                 |
| `customer/{slug}/connections/*.json` → `knowledge/personal/connections/*.json` | overlay → fallback                                 |
| `customer/{slug}/policy/*.json` → `knowledge/product/governance/*.json`        | overlay → fallback (public is the base policy)     |
| `customer/{slug}/mission-seeds/*.json`                                         | additive (customer-specific seeds; not a fallback) |

## Slug rules

- Lowercase ASCII alphanumeric, hyphen `-`, underscore `_`.
- Must start with a letter or digit.
- Regex: `^[a-z0-9][a-z0-9_-]*$`.
- Examples: `acme-corp`, `client_a`, `internal-demo`.

## Git policy

Per-customer directories under `customer/` are **gitignored by default**. Only `customer/README.md` and `customer/_template/` are committed.

Each customer's secrets must go through `secret-actuator` (OS keychain or environment) — **never commit secrets to `customer/{slug}/`**, even though the directory is gitignored. A future leak (e.g. someone bypassing gitignore) must not expose credentials.

## See also

- `docs/developer/CUSTOMER_AGGREGATION.md` (English design rationale)
- `docs/developer/CUSTOMER_AGGREGATION.ja.md` (日本語版)
- `libs/core/customer-resolver.ts` (resolution implementation)
