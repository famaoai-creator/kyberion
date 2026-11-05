# Stance template

A **stance** is which hat Kyberion wears: the identity, connections, approval
policy, voice and mission seeds it uses while acting as one of the entities you
belong to or work for. It is your configuration (custody `person`), so it lives
in your personal space and overlays `knowledge/personal/`:

```
knowledge/personal/stances/{slug}/{file}  →  knowledge/personal/{file}
```

Create one with `pnpm stance:create <slug>` (copies this template), select it
with `pnpm stance:switch <slug>` and `source active/shared/runtime/stance.env`
(sets `KYBERION_STANCE`). `KYBERION_STANCE` is the deprecated name and is
still read with a warning.

| Entry            | What to put                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `stance.json`    | Slug, display name and kind (`engagement` or `affiliation`).                                  |
| `identity.json`  | The identity Kyberion uses under this stance (mirrors `knowledge/personal/my-identity.json`). |
| `connections/`   | Service connections used under this stance.                                                   |
| `policy/`        | Approval and risk policy overrides.                                                           |
| `voice/`         | Voice profile overrides.                                                                      |
| `mission-seeds/` | Mission seeds offered under this stance.                                                      |
| `tenants/`       | Tenant profiles this stance may act for.                                                      |

A stance holds no company assets and no customer records. The company assets of a
tenant (profile, vision, org chart, brand, channel bindings) and its customers'
records belong to the tenant under `knowledge/confidential/{tenant}/` — see
`templates/tenant-company/` and
[stance-tenant-customer-model](../../knowledge/product/architecture/stance-tenant-customer-model.md).
