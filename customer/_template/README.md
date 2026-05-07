# Customer Template

Copy this directory to `customer/{your-customer-slug}` and fill in the files below to create a new customer configuration.

```bash
cp -R customer/_template customer/your-customer-slug
```

## Files to fill in (required)

| File | What to put |
|---|---|
| `customer.json` | Customer metadata: slug, display name, primary contact, engagement type. |
| `identity.json` | The sovereign identity (Kyberion agent persona) for this customer. Schema mirrors `knowledge/personal/my-identity.json`. |
| `vision.md` | What this customer wants Kyberion to accomplish. Free-form markdown. |

## Directories to populate (as needed)

| Dir | What goes here |
|---|---|
| `connections/` | External service connection records (Slack, Google, internal APIs). One JSON per service. |
| `tenants/` | Tenant configs if the customer has internal multi-tenant separation. |
| `policy/` | Customer-specific policy overrides (approval rules, tier scope, etc). |
| `voice/` | Voice profile overrides if the customer wants a custom voice persona. |
| `mission-seeds/` | Customer-specific mission templates (vertical-specific workflows). |

## Secrets

**Do not put real secrets in this directory.** Use one of:
1. `secret-actuator` (OS keychain) — preferred for production deployments.
2. `secrets.local.json` (gitignored) — only for local development / testing.

The `secrets.local.example.json` file shows the expected schema. Copy it to `secrets.local.json` and fill in only when needed for local testing.

## Activation

```bash
export KYBERION_CUSTOMER=your-customer-slug
pnpm doctor
pnpm onboard
```
