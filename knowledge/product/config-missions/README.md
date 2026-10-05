# Config Mission Presets

Configuration mission presets define governed configuration changes. They are
not the authoring path for service endpoint/preset catalogs or for collecting
service credentials.

## Usage

```bash
pnpm config-mission list
pnpm config-mission status --tenant <tenant-slug>
pnpm config-mission apply --tenant <tenant-slug> --id <cfg-id>
```

For adding a service integration, follow the
[Service Integration and Connection Guide](../orchestration/service-integration-guide.md).
For an existing service connection, use `pnpm service:setup`,
`pnpm kyberion secret introduce`, and `pnpm service:preflight` as described in
that guide.

The former `new-service-integration` config mission has been removed because
it wrote to an obsolete catalog path and created a placeholder credential
document outside the current secret-introduction flow.

## Categories

| Category   | What it configures                     |
| ---------- | -------------------------------------- |
| `voice`    | Voice engines, profiles, learning data |
| `tenant`   | New tenant/customer setup              |
| `surface`  | Runtime surface registration           |
| `security` | Policy and access control updates      |

Instantiated missions are stored under the tenant's confidential namespace:

```
knowledge/confidential/{tenant}/config-missions/{instance-id}/
  brief.json
  evidence/
```

The `change` object in `brief.json` carries the canonical scope, desired
fingerprint, probe references, and approval reference. High-risk, surface,
channel, and system changes require a matching approval-store decision.
