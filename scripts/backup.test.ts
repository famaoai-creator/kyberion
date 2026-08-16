import { afterEach, describe, expect, it } from 'vitest';
import {
  pathResolver,
  safeExistsSync,
  safeExecResult,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import {
  parseBackupArgs,
  pruneBackups,
  resolveBackupPlan,
  restoreBackup,
  summarizeBackupStatus,
} from './backup.js';

const FIXTURE_DIR = pathResolver.sharedTmp('backup-test');

function registerFixtureTenant(
  slug: string,
  status: 'active' | 'suspended' | 'archived' = 'active'
) {
  safeWriteFile(
    `${FIXTURE_DIR}/knowledge/personal/tenants/${slug}.json`,
    JSON.stringify({
      tenant_slug: slug,
      display_name: slug,
      status,
      assigned_role: 'operator',
    })
  );
}

describe('backup cli', () => {
  afterEach(() => {
    safeRmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('parses create scope and encryption arguments', () => {
    expect(
      parseBackupArgs([
        'create',
        '--scope',
        'tenant',
        '--tenant',
        'acme',
        '--out',
        'active/shared/tmp/acme.tar.gz.enc',
        '--encrypt',
      ])
    ).toMatchObject({
      command: 'create',
      scope: 'tenant',
      tenant: 'acme',
      out: 'active/shared/tmp/acme.tar.gz.enc',
      encrypt: true,
    });
  });

  it('includes all protected roots for full backup planning', () => {
    const plan = resolveBackupPlan({
      scope: 'all',
      rootDir: '/repo',
      pathExists: (repoPath) =>
        ['active', 'vault', 'knowledge/personal', 'knowledge/confidential'].includes(repoPath),
    });

    expect(plan.entries).toEqual([
      'active',
      'knowledge/confidential',
      'knowledge/personal',
      'vault',
    ]);
    expect(plan.includesSensitive).toBe(true);
  });

  it('discovers active and personal mission git repositories for bundle planning', () => {
    safeMkdir(`${FIXTURE_DIR}/active/missions/confidential/MSN-A/.git`);
    safeMkdir(`${FIXTURE_DIR}/knowledge/personal/missions/MSN-B/.git`);

    const plan = resolveBackupPlan({
      scope: 'all',
      rootDir: FIXTURE_DIR,
      pathExists: (repoPath) => safeExistsSync(`${FIXTURE_DIR}/${repoPath}`),
    });

    expect(plan.missionGitRepos.map((repo) => repo.repoRelativePath)).toEqual([
      'active/missions/confidential/MSN-A',
      'knowledge/personal/missions/MSN-B',
    ]);
  });

  it('tenant scope covers the knowledge root (with the DA-05 _ledger inside) and DA-08 ingest cursors', () => {
    const existing = new Set([
      'knowledge/confidential/acme',
      'active/shared/runtime/ingest-cursors/acme',
    ]);
    const plan = resolveBackupPlan({
      scope: 'tenant',
      tenant: 'acme',
      rootDir: '/repo',
      pathExists: (repoPath) => existing.has(repoPath),
      tenantResolver: () => undefined,
    });

    expect(plan.entries).toEqual([
      'active/shared/runtime/ingest-cursors/acme',
      // The whole tenant knowledge root — knowledge/confidential/acme/_ledger/
      // rides along without a separate entry.
      'knowledge/confidential/acme',
    ]);
    expect(plan.includesSensitive).toBe(true);
  });

  it('tenant scope includes only that tenant physical runtime namespaces', () => {
    registerFixtureTenant('acme');
    const tenantRoot = `${FIXTURE_DIR}/active/shared/runtime/media-generation/schedules/tenants/acme/organizations/org-a`;
    const otherTenantRoot = `${FIXTURE_DIR}/active/shared/runtime/media-generation/schedules/tenants/other/organizations/org-b`;
    safeMkdir(`${FIXTURE_DIR}/active/shared/coordination/channels/slack/tenants/acme/outbox`);
    safeMkdir(`${FIXTURE_DIR}/active/shared/runtime/presence/tenants/acme/notifications`);
    safeMkdir(tenantRoot);
    safeMkdir(
      `${FIXTURE_DIR}/active/shared/runtime/media-generation/cost-settlements/tenants/acme`
    );
    safeMkdir(`${FIXTURE_DIR}/active/shared/runtime/media-generation/quota/acme`);
    safeMkdir(`${FIXTURE_DIR}/active/shared/runtime/peer-messaging/tenants/acme/peers/peer-a`);
    safeMkdir(
      `${FIXTURE_DIR}/active/shared/observability/peer-conversations/tenants/acme/peers/peer-a`
    );
    safeMkdir(`${FIXTURE_DIR}/active/shared/runtime/mesh-hub/mesh-a/tenants/acme`);
    safeMkdir(otherTenantRoot);

    const plan = resolveBackupPlan({
      scope: 'tenant',
      tenant: 'acme',
      rootDir: FIXTURE_DIR,
      pathExists: (repoPath) => safeExistsSync(`${FIXTURE_DIR}/${repoPath}`),
    });

    expect(plan.entries).toEqual([
      'active/shared/coordination/channels/slack/tenants/acme',
      'active/shared/observability/peer-conversations/tenants/acme',
      'active/shared/runtime/media-generation/cost-settlements/tenants/acme',
      'active/shared/runtime/media-generation/quota/acme',
      'active/shared/runtime/media-generation/schedules/tenants/acme',
      'active/shared/runtime/mesh-hub/mesh-a/tenants/acme',
      'active/shared/runtime/peer-messaging/tenants/acme',
      'active/shared/runtime/presence/tenants/acme',
    ]);
    expect(plan.entries.some((entry) => entry.includes('/other/'))).toBe(false);
    expect(plan.includesSensitive).toBe(true);
  });

  it('requires a tenant for tenant backup planning', () => {
    expect(() =>
      resolveBackupPlan({
        scope: 'tenant',
        rootDir: '/repo',
        pathExists: () => false,
      })
    ).toThrow('--tenant/--customer is required');
  });

  it('rejects tier names and path traversal as tenant backup scopes', () => {
    for (const tenant of ['public', '../other', 'Acme']) {
      expect(() =>
        resolveBackupPlan({
          scope: 'tenant',
          tenant,
          rootDir: '/repo',
          pathExists: () => false,
        })
      ).toThrow('Invalid tenant slug');
    }
  });

  it('requires an active tenant registry profile for tenant backup planning', () => {
    expect(() =>
      resolveBackupPlan({
        scope: 'tenant',
        tenant: 'acme',
        rootDir: FIXTURE_DIR,
        pathExists: () => false,
      })
    ).toThrow("tenant 'acme' has no profile");

    registerFixtureTenant('acme', 'suspended');
    expect(() =>
      resolveBackupPlan({
        scope: 'tenant',
        tenant: 'acme',
        rootDir: FIXTURE_DIR,
        pathExists: () => false,
      })
    ).toThrow("tenant 'acme' is suspended");
  });

  it('rejects a tenant restore archive containing another tenant namespace', () => {
    const manifestDir = `${FIXTURE_DIR}/active/shared/tmp/backup-fixture`;
    const archive = `${FIXTURE_DIR}/tenant.tar.gz`;
    const target = `${FIXTURE_DIR}/restore-target`;
    safeWriteFile(
      `${manifestDir}/manifest.json`,
      JSON.stringify({
        format: 'kyberion-backup-v1',
        scope: 'tenant',
        tenant: 'acme',
        entries: ['active/shared/runtime/presence/tenants/acme'],
        mission_git_repos: [],
      })
    );
    safeWriteFile(`${FIXTURE_DIR}/active/shared/runtime/presence/tenants/acme/ok.json`, '{}\n');
    safeWriteFile(`${FIXTURE_DIR}/active/shared/runtime/presence/tenants/other/leak.json`, '{}\n');
    const archiveResult = safeExecResult(
      'tar',
      [
        '-czf',
        archive,
        '-C',
        FIXTURE_DIR,
        'active/shared/tmp/backup-fixture/manifest.json',
        'active/shared/runtime/presence/tenants/acme',
        'active/shared/runtime/presence/tenants/other',
      ],
      { timeoutMs: 120000 }
    );
    expect(archiveResult.status).toBe(0);

    expect(() =>
      restoreBackup({
        command: 'restore',
        scope: 'tenant',
        tenant: 'acme',
        archive,
        target,
        passphraseEnv: 'KYBERION_BACKUP_PASSPHRASE',
        retainDaily: 7,
        retainWeekly: 4,
      })
    ).toThrow('outside the manifest scope');
    expect(safeExistsSync(target)).toBe(false);
  });

  it('rejects a tenant manifest that names a parent namespace', () => {
    const manifestDir = `${FIXTURE_DIR}/active/shared/tmp/backup-parent-fixture`;
    const archive = `${FIXTURE_DIR}/tenant-parent.tar.gz`;
    const target = `${FIXTURE_DIR}/restore-parent-target`;
    safeWriteFile(
      `${manifestDir}/manifest.json`,
      JSON.stringify({
        format: 'kyberion-backup-v1',
        scope: 'tenant',
        tenant: 'acme',
        entries: ['active/shared/runtime/presence'],
        mission_git_repos: [],
      })
    );
    safeWriteFile(`${FIXTURE_DIR}/active/shared/runtime/presence/tenants/acme/ok.json`, '{}\n');
    const archiveResult = safeExecResult(
      'tar',
      [
        '-czf',
        archive,
        '-C',
        FIXTURE_DIR,
        'active/shared/tmp/backup-parent-fixture/manifest.json',
        'active/shared/runtime/presence/tenants/acme',
      ],
      { timeoutMs: 120000 }
    );
    expect(archiveResult.status).toBe(0);

    expect(() =>
      restoreBackup({
        command: 'restore',
        scope: 'tenant',
        tenant: 'acme',
        archive,
        target,
        passphraseEnv: 'KYBERION_BACKUP_PASSPHRASE',
        retainDaily: 7,
        retainWeekly: 4,
      })
    ).toThrow('tenant export allowlist');
    expect(safeExistsSync(target)).toBe(false);
  });

  it('quarantines restored peer and Mesh runtime before tenant restore returns', () => {
    const manifestDir = `${FIXTURE_DIR}/active/shared/tmp/backup-quarantine-fixture`;
    const archive = `${FIXTURE_DIR}/tenant-quarantine.tar.gz`;
    const target = `${FIXTURE_DIR}/restore-quarantine-target`;
    safeWriteFile(
      `${manifestDir}/manifest.json`,
      JSON.stringify({
        format: 'kyberion-backup-v1',
        scope: 'tenant',
        tenant: 'acme',
        entries: [
          'active/shared/runtime/peer-messaging/tenants/acme',
          'active/shared/runtime/mesh-hub/mesh-a/tenants/acme',
        ],
        mission_git_repos: [],
      })
    );
    safeWriteFile(
      `${FIXTURE_DIR}/active/shared/runtime/peer-messaging/tenants/acme/peers/peer-a/inbox.jsonl`,
      '{"stale":true}\n'
    );
    safeWriteFile(
      `${FIXTURE_DIR}/active/shared/runtime/mesh-hub/mesh-a/tenants/acme/deliveries.jsonl`,
      '{"status":"dispatched"}\n'
    );
    const archiveResult = safeExecResult(
      'tar',
      [
        '-czf',
        archive,
        '-C',
        FIXTURE_DIR,
        'active/shared/tmp/backup-quarantine-fixture/manifest.json',
        'active/shared/runtime/peer-messaging/tenants/acme',
        'active/shared/runtime/mesh-hub/mesh-a/tenants/acme',
      ],
      { timeoutMs: 120000 }
    );
    expect(archiveResult.status).toBe(0);

    restoreBackup({
      command: 'restore',
      scope: 'tenant',
      tenant: 'acme',
      archive,
      target,
      passphraseEnv: 'KYBERION_BACKUP_PASSPHRASE',
      retainDaily: 7,
      retainWeekly: 4,
    });

    expect(safeExistsSync(`${target}/active/shared/runtime/peer-messaging/tenants/acme`)).toBe(
      false
    );
    expect(
      safeExistsSync(`${target}/active/shared/runtime/peer-recovery-quarantine/tenants/acme`)
    ).toBe(true);
  });

  it('requires explicit archive and restore target paths', () => {
    const archive = `${FIXTURE_DIR}/placeholder.tar.gz`;
    safeWriteFile(archive, 'not a tar archive\n');
    const baseOptions = {
      command: 'restore' as const,
      scope: 'all' as const,
      passphraseEnv: 'KYBERION_BACKUP_PASSPHRASE',
      retainDaily: 7,
      retainWeekly: 4,
    };

    expect(() => restoreBackup({ ...baseOptions, target: FIXTURE_DIR })).toThrow(
      'restore requires an archive path'
    );
    expect(() => restoreBackup({ ...baseOptions, archive })).toThrow(
      'restore requires --target <clean-root>'
    );
  });

  it('parses retention options for prune', () => {
    expect(
      parseBackupArgs(['prune', '--dir', 'active/shared/tmp/backups', '--retain-daily', '3'])
    ).toMatchObject({
      command: 'prune',
      backupDir: 'active/shared/tmp/backups',
      retainDaily: 3,
      retainWeekly: 4,
    });
  });

  it('parses restore drill arguments', () => {
    expect(
      parseBackupArgs([
        'drill',
        '--dir',
        'active/shared/exports/backups',
        '--target',
        'active/shared/tmp/drill',
        '--prepare-checkout',
        '--force',
      ])
    ).toMatchObject({
      command: 'drill',
      backupDir: 'active/shared/exports/backups',
      target: 'active/shared/tmp/drill',
      prepareCheckout: true,
      force: true,
    });
  });

  it('prunes backup files beyond retention', () => {
    safeMkdir(FIXTURE_DIR);
    for (let i = 0; i < 4; i += 1) {
      safeWriteFile(`${FIXTURE_DIR}/backup-${i}.tar.gz.enc`, 'x');
    }

    const result = pruneBackups(FIXTURE_DIR, { retainDaily: 1, retainWeekly: 0 });

    expect(result.kept).toHaveLength(1);
    expect(result.deleted).toHaveLength(3);
  });

  it('summarizes latest backup status', () => {
    safeMkdir(FIXTURE_DIR);
    safeWriteFile(`${FIXTURE_DIR}/latest.tar.gz.enc`, 'backup');

    const status = summarizeBackupStatus(FIXTURE_DIR, { now: new Date() });

    expect(status).toMatchObject({
      count: 1,
      latestName: 'latest.tar.gz.enc',
      status: 'fresh',
    });
    expect(status.latestSizeBytes).toBe(6);
  });
});
