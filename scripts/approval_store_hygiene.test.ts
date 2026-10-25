import { describe, expect, it, vi } from 'vitest';
import {
  formatApprovalStoreHygieneReport,
  formatTenantPartitionMigrationReport,
  runApprovalStoreHygiene,
  type ApprovalStoreHygieneReport,
  type TenantPartitionMigrationReport,
} from './approval_store_hygiene.js';

function report(dryRun: boolean): ApprovalStoreHygieneReport {
  return {
    dryRun,
    staleAfterDays: 14,
    pendingExpiry: {
      candidates: [
        {
          storageChannel: 'terminal',
          channel: 'terminal',
          requestId: 'a',
          requestedAt: '2026-09-01T00:00:00Z',
          reason: 'stale_pending',
        },
      ],
      applied: dryRun ? [] : ['a'],
      errors: [],
      dryRun,
    },
    fixturePurge: {
      candidates: [
        {
          storageChannel: 'plugin-install',
          requestId: 'b',
          partition: { kind: 'system' },
          logicalPath: 'x',
          title: 'probe-12345',
          requestedBy: 'plugin-installer',
          status: 'pending',
          rule: 'plugin_title',
        },
        {
          storageChannel: 'plugin-install',
          requestId: 'c',
          partition: { kind: 'system' },
          logicalPath: 'y',
          title: 'fixture-plugin',
          requestedBy: 'plugin-installer',
          status: 'approved',
          rule: 'plugin_title',
        },
      ],
      applied: [],
      errors: dryRun ? [] : ['plugin-install/b: denied'],
      dryRun,
    },
    tenantPartitionMigration: {
      candidates: [legacyCandidate],
      applied: [],
      errors: [],
      dryRun: true,
      outcomes: {},
    },
  };
}

const legacyCandidate = {
  storageChannel: 'terminal',
  requestId: 'd',
  status: 'pending' as const,
  from: 'active/shared/coordination/channels/terminal/approvals/requests/d.json',
  to: 'active/shared/runtime/tenant-approvals/confidential/acme/terminal/requests/d.json',
  partition: { kind: 'tenant' as const, tier: 'confidential' as const, tenant_slug: 'acme' },
};

function migrationReport(dryRun: boolean): TenantPartitionMigrationReport {
  return {
    mode: 'migrate-tenant-partitions',
    dryRun,
    migration: {
      candidates: [legacyCandidate, { ...legacyCandidate, requestId: 'e' }],
      applied: dryRun ? [] : ['d'],
      errors: dryRun ? [] : ['terminal/e: [APPROVAL_MIGRATION_CONFLICT] differs'],
      dryRun,
      outcomes: dryRun ? {} : { d: 'moved' },
    },
  };
}

describe('approval_store_hygiene', () => {
  it('summarizes a dry run by reason and channel without applied counts', () => {
    const text = formatApprovalStoreHygieneReport(report(true));
    expect(text).toContain('dry-run (pass --apply to act)');
    expect(text).toContain('Pending to expire: 1');
    expect(text).toContain('by reason: stale_pending=1');
    expect(text).toContain('Fixture records to trash: 2');
    expect(text).toContain('by channel: plugin-install=2');
    expect(text).toContain('by rule: plugin_title=2');
    expect(text).not.toContain('expired:');
  });

  it('flags tenant-scoped records left in the system tree and names the migration command', () => {
    const text = formatApprovalStoreHygieneReport(report(true));
    expect(text).toContain('Tenant-scoped records still in the system tree: 1');
    expect(text).toContain('--migrate-tenant-partitions (dry run), then add --apply');
  });

  it('summarizes the tenant-partition migration as a dry run and after --apply', () => {
    const dry = formatTenantPartitionMigrationReport(migrationReport(true));
    expect(dry).toContain('dry-run (pass --apply to move)');
    expect(dry).toContain('Tenant-scoped records in the system tree: 2');
    expect(dry).not.toContain('moved:');
    const applied = formatTenantPartitionMigrationReport(migrationReport(false));
    expect(applied).toContain('moved: 1');
    expect(applied).toContain('[APPROVAL_MIGRATION_CONFLICT]');
  });

  it('runs --migrate-tenant-partitions as a dry run without the sovereign persona', async () => {
    vi.stubEnv('KYBERION_PERSONA', 'analyst');
    try {
      const result = (await runApprovalStoreHygiene([
        '--migrate-tenant-partitions',
        '--json',
      ])) as TenantPartitionMigrationReport;
      expect(result.mode).toBe('migrate-tenant-partitions');
      expect(result.dryRun).toBe(true);
      expect(result.migration.applied).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reports applied counts and errors after --apply', () => {
    const text = formatApprovalStoreHygieneReport(report(false));
    expect(text).toContain('expired: 1');
    expect(text).toContain('trashed: 0');
    expect(text).toContain('plugin-install/b: denied');
  });

  it('rejects a non-positive --stale-days before touching the store', async () => {
    process.exitCode = undefined;
    try {
      expect(await runApprovalStoreHygiene(['--stale-days', '0'])).toBeUndefined();
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = undefined;
    }
  });

  it('refuses --apply without the sovereign persona and names the fix', async () => {
    vi.stubEnv('KYBERION_PERSONA', 'analyst');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
    try {
      expect(await runApprovalStoreHygiene(['--apply'])).toBeUndefined();
      expect(process.exitCode).toBe(2);
      expect(errors.mock.calls.flat().join('\n')).toContain(
        'KYBERION_PERSONA=sovereign node dist/scripts/approval_store_hygiene.js --apply'
      );
    } finally {
      process.exitCode = undefined;
      errors.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
