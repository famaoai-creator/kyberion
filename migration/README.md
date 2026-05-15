# Migration Scripts

Scripts that run **once per upgrade** to transform user state when a release introduces a breaking schema change.

## When to use

Add a migration script here when a release:

- Renames or removes a field in `mission-state.json`, `customer.json`, `tenant-profile.schema.json`, or any other on-disk data shape.
- Moves a file to a different path (e.g. reorganizing knowledge/ tiers).
- Changes the policy file format.
- Requires the user to confirm something before they can use the new version.

If the change is purely additive (new optional field, new file alongside existing), **no migration is needed** — old data continues to work as-is.

## File naming

```
migration/
├── README.md
└── 0001-rename-tenant-id.ts          # zero-padded sequence + slug
└── 0002-add-customer-overlay-hint.ts
```

The leading number defines run order. Migrations are run in ascending order, each at most once.

## Migration script contract

```typescript
// migration/0001-rename-tenant-id.ts
export const id = '0001-rename-tenant-id';
export const description = 'Rename tenant_id to tenant_slug in mission-state.json';
export const introduced_in = 'v0.2.0';

export async function migrate(opts: { dryRun: boolean }): Promise<void> {
  // Apply the transformation.
  // Throw on failure with a clear message.
}

export async function rollback(opts: { dryRun: boolean }): Promise<void> {
  // Inverse of migrate, when possible. Throw if not safe.
}
```

The runner records each completed migration in `active/shared/runtime/migrations.applied.json` so it doesn't run twice.

## Running migrations

```bash
# After upgrading to a new version:
node migration/<script>.js

# Or run all pending in order:
pnpm migration:run
```

Maintainers must call out each required migration in the release notes and `CHANGELOG.md`.
Use `Migration required: None` when no state migration applies, so operators do not have to infer silence.

## Rollback

`pnpm migration:rollback` reverses the most recent migration, when the script declares a `rollback` export.

Not all migrations are safely reversible. When a migration has no `rollback` (or `rollback` throws), users must restore from backup to downgrade.

## Current migrations

_None yet._ Pre-1.0 development. The first migration will accompany the first breaking change after `v0.1.0`.
