# Customer Aggregation Directory

This directory holds **per-customer / per-deployment configuration** for FDE (Forward Deployed Engineer) and implementation-support engagements with Kyberion.

It is the **single aggregation point** for everything that varies between customers, so that 80%+ of customization is config rather than fork.

## When to use this directory

- You are deploying Kyberion for a customer or distinct organization.
- You want to keep multiple customer configurations side-by-side in one checkout.
- You are an FDE / SI engineer running Kyberion on behalf of an end customer.

If you are a single individual using Kyberion for personal/own use, you do **not** need this directory. Continue to use `knowledge/personal/` as before.

## Layout

```
customer/
├── README.md                       # this file (committed)
├── _template/                      # template for new customers (committed, copy from this)
│   ├── README.md
│   ├── customer.json               # customer metadata
│   ├── identity.json               # sovereign identity for this customer
│   ├── vision.md                   # vision document
│   ├── connections/                # external service connections (placeholder)
│   ├── tenants/                    # tenant configs (placeholder)
│   ├── policy/                     # customer-specific policy overrides
│   ├── voice/                      # voice profile overrides
│   ├── mission-seeds/              # customer-specific mission templates
│   └── secrets.local.example.json  # secret reference template
└── {customer-slug}/                # per-customer dir (gitignored — never commit secrets)
    └── ...                         # same shape as _template/
```

## Quickstart

```bash
# 1. Copy the template into a new customer slug (lowercase, hyphenated, no spaces)
cp -R customer/_template customer/acme-corp

# 2. Fill in customer/acme-corp/customer.json, identity.json, vision.md
$EDITOR customer/acme-corp/customer.json

# 3. Activate that customer in your shell
export KYBERION_CUSTOMER=acme-corp

# 4. Run Kyberion as usual
pnpm onboard
pnpm doctor
```

When `KYBERION_CUSTOMER` is set, Kyberion overlays `customer/{slug}/` on top of `knowledge/personal/`. Files in the customer dir take precedence; missing files fall back to `knowledge/personal/`.

## Resolution rules

| Lookup | Order |
|---|---|
| `customer/{slug}/identity.json` → `knowledge/personal/my-identity.json` | overlay → fallback |
| `customer/{slug}/connections/*.json` → `knowledge/personal/connections/*.json` | overlay → fallback |
| `customer/{slug}/policy/*.json` → `knowledge/public/governance/*.json` | overlay → fallback (public is the base policy) |
| `customer/{slug}/mission-seeds/*.json` | additive (customer-specific seeds; not a fallback) |

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
