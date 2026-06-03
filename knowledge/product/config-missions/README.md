# Config Mission Presets

Configuration mission presets define **what Kyberion can be configured to do**.

Each `.json` file in this directory is a self-describing template:
- **`description`** — what this preset configures
- **`inputs`** — required parameters (serves as documentation)
- **`write_targets`** — exactly which paths will be written (for audit / permission verification)
- **`pipeline`** — the pipeline that executes the configuration

## Usage

```bash
# List available presets
pnpm config-mission list

# Instantiate a preset for a tenant
pnpm config-mission create --preset new-service-integration --tenant acme --input service_id=notion --input auth_type=oauth2

# Check status of a config mission
pnpm config-mission status --tenant acme

# Apply (execute) a drafted config mission
pnpm config-mission apply --tenant acme --id cfg-001
```

## Categories

| Category | What it configures |
|---|---|
| `service_integration` | External API connections, auth credentials |
| `voice` | Voice engines, profiles, learning data |
| `tenant` | New tenant/customer setup |
| `surface` | Runtime surface registration |
| `security` | Policy and access control updates |

## Instance storage

Instantiated missions are stored under the tenant's confidential namespace:

```
knowledge/confidential/{tenant}/config-missions/{instance-id}/
  brief.json    ← parameters + status
  evidence/     ← what was actually written
```

This keeps configuration history alongside the tenant's knowledge — not in `active/` (which is cleaned up).
