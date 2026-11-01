import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeExecResult,
  safeLinkExclusiveSync,
  safeReaddir,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { createServer, type Server } from 'node:net';
import {
  backupArchiveTimeoutMs,
  interpretTarResult,
  resolveBackupExclusions,
  selectBackupFiles,
  selectionWarnings,
} from './lib/backup-file-selection.js';
import {
  buildBackupManifest,
  copyTree,
  createBackup,
  createMissionGitBundles,
  parseBackupArgs,
  parseRestoredBackupManifest,
  main,
  pruneBackups,
  resolveBackupPlan,
  restoreBackup,
  summarizeBackupStatus,
} from './backup.js';
import {
  computeLedgerEntryHash,
  GENESIS_HASH,
  getAuditChainKeyId,
} from '@agent/core/chain-integrity';
import { TENANT_RUNTIME_PARTITION_ROOTS } from '@agent/core/storage-layout';
import { createHash } from 'node:crypto';
import { assertExclusionsHeld } from './lib/backup-tenant-partitions.js';

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

  it('rejects malformed archive manifest roots and nested metadata', () => {
    expect(() => parseRestoredBackupManifest('[]')).toThrow('root must be a JSON object');
    expect(() =>
      parseRestoredBackupManifest(
        '{"format":"kyberion-backup-v1","scope":"all","entries":[],"__proto__":{}}'
      )
    ).toThrow('Backup manifest is not valid JSON');
    expect(() =>
      parseRestoredBackupManifest(
        JSON.stringify({
          format: 'kyberion-backup-v1',
          scope: 'tenant',
          entries: ['active'],
          mission_git_repos: [{ repo_relative_path: { invalid: true } }],
        })
      )
    ).toThrow('mission repository path is invalid');
  });

  it('emits list results through the supplied harness printer', () => {
    safeWriteFile(`${FIXTURE_DIR}/demo.tar.gz`, 'fixture');
    const print = vi.fn();

    main(['list', '--dir', FIXTURE_DIR], print);

    expect(print).toHaveBeenCalledWith({ ok: true, backups: ['demo.tar.gz'] });
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

  it('reports a bad invocation as a usage error (exit 2, no stack trace)', () => {
    for (const argv of [['status'], ['list', '--bogus'], ['create', '--scope', 'nope']]) {
      expect(() => parseBackupArgs(argv)).toThrow(
        expect.objectContaining({ name: 'ScriptExitError', code: 2 })
      );
    }
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

describe('tenant runtime partitions in backup and restore', () => {
  const TEST_CHAIN_KEY = 'backup-test-chain-key';
  const LEDGER = 'active/shared/runtime/tenant-ledger/confidential/acme/ledger.jsonl';
  const restoreOptions = (archive: string, target: string, force = false) => ({
    command: 'restore' as const,
    scope: 'tenant' as const,
    tenant: 'acme',
    archive,
    target,
    force,
    passphraseEnv: 'KYBERION_BACKUP_PASSPHRASE',
    retainDaily: 7,
    retainWeekly: 4,
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    safeRmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  /** A tenant archive of `files` (repo-relative → content) with a manifest naming `entries`. */
  function tenantArchive(
    name: string,
    entries: string[],
    files: Record<string, string>,
    extra: Record<string, unknown> = {}
  ): string {
    const source = `${FIXTURE_DIR}/${name}-source`;
    const manifestMember = `active/shared/tmp/backup-${name}/manifest.json`;
    safeWriteFile(
      `${source}/${manifestMember}`,
      JSON.stringify({
        format: 'kyberion-backup-v1',
        scope: 'tenant',
        tenant: 'acme',
        entries,
        mission_git_repos: [],
        ...extra,
      })
    );
    for (const [file, content] of Object.entries(files))
      safeWriteFile(`${source}/${file}`, content);
    const archive = `${FIXTURE_DIR}/${name}.tar.gz`;
    const result = safeExecResult(
      'tar',
      ['-czf', archive, '-C', source, manifestMember, ...entries],
      { timeoutMs: 120000 }
    );
    expect(result.status).toBe(0);
    return archive;
  }

  /** Hash-chained entries in the hybrid ledger's on-disk format (ledger.ts _writeToLedger). */
  function chainedLedger(
    key: string,
    count: number,
    alg: 'hmac-sha256' | 'sha256' = 'hmac-sha256'
  ): string {
    let parent = GENESIS_HASH;
    const lines: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const entry: Record<string, unknown> = {
        timestamp: `2026-10-26T00:00:0${i}.000Z`,
        type: `TEST_EVENT_${i}`,
        scope: { tier: 'confidential', tenant_slug: 'acme' },
        role: 'Unknown',
        mission_id: 'None',
        payload: { i },
        parent_hash: parent,
        chain_alg: alg,
        ...(alg === 'hmac-sha256' ? { chain_key_id: getAuditChainKeyId(key) } : {}),
      };
      entry.hash = computeLedgerEntryHash(entry, alg === 'hmac-sha256' ? { alg, key } : { alg });
      parent = String(entry.hash);
      lines.push(JSON.stringify(entry));
    }
    return lines.join('\n') + '\n';
  }

  it('plans every registered partition root for the tenant, never another tenant or system', () => {
    const existing = new Set<string>();
    for (const { root } of TENANT_RUNTIME_PARTITION_ROOTS) {
      for (const partition of [
        'personal/acme',
        'confidential/acme',
        'confidential/other',
        'system',
      ])
        existing.add(`${root}/${partition}`);
    }
    const plan = resolveBackupPlan({
      scope: 'tenant',
      tenant: 'acme',
      rootDir: '/repo',
      pathExists: (repoPath) => existing.has(repoPath),
      tenantResolver: () => undefined,
    });
    for (const { root } of TENANT_RUNTIME_PARTITION_ROOTS) {
      expect(plan.entries).toContain(`${root}/personal/acme`);
      expect(plan.entries).toContain(`${root}/confidential/acme`);
    }
    expect(plan.entries.filter((entry) => /\/(other|system)(\/|$)/u.test(entry))).toEqual([]);
    expect(plan.tenantRuntimePartitions).toHaveLength(TENANT_RUNTIME_PARTITION_ROOTS.length * 2);
  });

  it("accepts the tenant's own partitions and rejects another tenant's in a tenant archive", () => {
    const own = tenantArchive('own', ['active/shared/runtime/usage-ledger/confidential/acme'], {
      'active/shared/runtime/usage-ledger/confidential/acme/resource-usage.jsonl': '{"a":1}\n',
    });
    const restored = restoreBackup(restoreOptions(own, `${FIXTURE_DIR}/own-target`));
    expect(restored.ledger_verification).toBe('not_applicable');
    expect(
      safeExistsSync(
        `${FIXTURE_DIR}/own-target/active/shared/runtime/usage-ledger/confidential/acme/resource-usage.jsonl`
      )
    ).toBe(true);

    const other = tenantArchive(
      'other',
      ['active/shared/runtime/usage-ledger/confidential/other'],
      {
        'active/shared/runtime/usage-ledger/confidential/other/resource-usage.jsonl': '{"b":1}\n',
      }
    );
    expect(() => restoreBackup(restoreOptions(other, `${FIXTURE_DIR}/other-target`))).toThrow(
      'tenant export allowlist'
    );
    expect(safeExistsSync(`${FIXTURE_DIR}/other-target`)).toBe(false);
  });

  it('refuses --force over an existing tenant-ledger file and leaves it byte-identical', () => {
    const archive = tenantArchive(
      'conflict',
      ['active/shared/runtime/tenant-ledger/confidential/acme'],
      { [LEDGER]: '{"old":true}\n' }
    );
    const target = `${FIXTURE_DIR}/conflict-target`;
    const live = '{"live":1}\n{"live":2}\n';
    safeWriteFile(`${target}/${LEDGER}`, live);
    expect(() => restoreBackup(restoreOptions(archive, target, true))).toThrow(
      'BACKUP_RESTORE_APPEND_ONLY_CONFLICT'
    );
    expect(safeReadFile(`${target}/${LEDGER}`, { encoding: 'utf8' })).toBe(live);
  });

  it('trims a torn last ledger line and verifies the restored chain with the same key', () => {
    vi.stubEnv('KYBERION_AUDIT_CHAIN_KEY', TEST_CHAIN_KEY);
    const archive = tenantArchive(
      'torn',
      ['active/shared/runtime/tenant-ledger/confidential/acme'],
      { [LEDGER]: chainedLedger(TEST_CHAIN_KEY, 3) + '{"timestamp":"2026-10-26T00:00:09' },
      { chain_key_id: getAuditChainKeyId(TEST_CHAIN_KEY) }
    );
    const target = `${FIXTURE_DIR}/torn-target`;
    const result = restoreBackup(restoreOptions(archive, target));
    expect(result.trimmed_tails).toEqual([LEDGER]);
    expect(result.ledger_verification).toBe('verified');
    expect(safeReadFile(`${target}/${LEDGER}`, { encoding: 'utf8' })).toBe(
      chainedLedger(TEST_CHAIN_KEY, 3)
    );
  });

  it('defers ledger verification when the archive was chained with another key', () => {
    vi.stubEnv('KYBERION_AUDIT_CHAIN_KEY', 'some-other-host-key');
    const archive = tenantArchive(
      'deferred',
      ['active/shared/runtime/tenant-ledger/confidential/acme'],
      { [LEDGER]: chainedLedger(TEST_CHAIN_KEY, 2) },
      { chain_key_id: getAuditChainKeyId(TEST_CHAIN_KEY) }
    );
    const result = restoreBackup(restoreOptions(archive, `${FIXTURE_DIR}/deferred-target`));
    expect(result.ledger_verification).toBe('deferred_key_mismatch');
  });

  it('fails a restore whose chain is corrupt under the matching key', () => {
    vi.stubEnv('KYBERION_AUDIT_CHAIN_KEY', TEST_CHAIN_KEY);
    const tampered = chainedLedger(TEST_CHAIN_KEY, 2).replace('TEST_EVENT_0', 'TEST_EVENT_X');
    const archive = tenantArchive(
      'corrupt',
      ['active/shared/runtime/tenant-ledger/confidential/acme'],
      { [LEDGER]: tampered },
      { chain_key_id: getAuditChainKeyId(TEST_CHAIN_KEY) }
    );
    expect(() => restoreBackup(restoreOptions(archive, `${FIXTURE_DIR}/corrupt-target`))).toThrow(
      'nothing was restored'
    );
    expect(safeExistsSync(`${FIXTURE_DIR}/corrupt-target/${LEDGER}`)).toBe(false);
  });

  it('never reports a keyless (sha256) chain as verified, even with matching key ids', () => {
    vi.stubEnv('KYBERION_AUDIT_CHAIN_KEY', TEST_CHAIN_KEY);
    const archive = tenantArchive(
      'keyless',
      ['active/shared/runtime/tenant-ledger/confidential/acme'],
      { [LEDGER]: chainedLedger(TEST_CHAIN_KEY, 2, 'sha256') },
      { chain_key_id: getAuditChainKeyId(TEST_CHAIN_KEY) }
    );
    const target = `${FIXTURE_DIR}/keyless-target`;
    expect(() => restoreBackup(restoreOptions(archive, target))).toThrow(
      'BACKUP_RESTORE_LEDGER_DOWNGRADED'
    );
    expect(safeExistsSync(`${target}/${LEDGER}`)).toBe(false);
  });

  it('removes the restore temp dir (decrypted payload, staging) when a restore is refused', () => {
    vi.stubEnv('KYBERION_AUDIT_CHAIN_KEY', TEST_CHAIN_KEY);
    const archive = tenantArchive(
      'temp-cleanup',
      ['active/shared/runtime/tenant-ledger/confidential/acme'],
      { [LEDGER]: chainedLedger(TEST_CHAIN_KEY, 2, 'sha256') },
      { chain_key_id: getAuditChainKeyId(TEST_CHAIN_KEY) }
    );
    const restoreDirs = () =>
      safeReaddir(pathResolver.sharedTmp('')).filter((name) => name.startsWith('restore-'));
    const before = new Set(restoreDirs());
    expect(() => restoreBackup(restoreOptions(archive, `${FIXTURE_DIR}/temp-target`))).toThrow(
      'BACKUP_RESTORE_LEDGER_DOWNGRADED'
    );
    expect(restoreDirs().filter((name) => !before.has(name))).toEqual([]);
  });

  it('rejects an archive carrying a hard-link member before extraction', () => {
    const source = `${FIXTURE_DIR}/hardlink-source`;
    const manifestMember = 'active/shared/tmp/backup-hardlink/manifest.json';
    const partition = 'active/shared/runtime/usage-ledger/confidential/acme';
    safeWriteFile(
      `${source}/${manifestMember}`,
      JSON.stringify({
        format: 'kyberion-backup-v1',
        scope: 'tenant',
        tenant: 'acme',
        entries: [partition],
        mission_git_repos: [],
      })
    );
    safeWriteFile(`${source}/${partition}/real.jsonl`, '{}\n');
    safeLinkExclusiveSync(`${source}/${partition}/real.jsonl`, `${source}/${partition}/hard.jsonl`);
    const archive = `${FIXTURE_DIR}/hardlink.tar.gz`;
    expect(
      safeExecResult('tar', ['-czf', archive, '-C', source, manifestMember, partition], {
        timeoutMs: 120000,
      }).status
    ).toBe(0);
    const listing = safeExecResult('tar', ['-tvzf', archive], { timeoutMs: 120000 }).stdout;
    expect(listing).toMatch(/ link to /u);
    const target = `${FIXTURE_DIR}/hardlink-target`;
    expect(() => restoreBackup(restoreOptions(archive, target))).toThrow(
      'BACKUP_ARCHIVE_MEMBER_TYPE'
    );
    expect(safeExistsSync(target)).toBe(false);
  });

  it('keeps a complete final ledger record that only lacks its trailing newline', () => {
    vi.stubEnv('KYBERION_AUDIT_CHAIN_KEY', TEST_CHAIN_KEY);
    const full = chainedLedger(TEST_CHAIN_KEY, 2);
    const archive = tenantArchive(
      'no-newline',
      ['active/shared/runtime/tenant-ledger/confidential/acme'],
      { [LEDGER]: full.slice(0, -1) },
      { chain_key_id: getAuditChainKeyId(TEST_CHAIN_KEY) }
    );
    const target = `${FIXTURE_DIR}/no-newline-target`;
    const result = restoreBackup(restoreOptions(archive, target));
    expect(result.trimmed_tails).toEqual([]);
    expect(result.ledger_verification).toBe('verified');
    expect(safeReadFile(`${target}/${LEDGER}`, { encoding: 'utf8' })).toBe(full);
  });

  describe('rotated tenant-ledger segments (MSN-STORE-BOUNDS-3)', () => {
    const PARTITION = 'active/shared/runtime/tenant-ledger/confidential/acme';
    const SEGMENT_A = `${PARTITION}/ledger-20261102-101010.jsonl`;
    const SEGMENT_B = `${PARTITION}/ledger-20261102-101010-1.jsonl`;
    /** One chain of `count` entries split into consecutive files. */
    function splitChain(sizes: number[], alg: 'hmac-sha256' | 'sha256' = 'hmac-sha256') {
      const total = sizes.reduce((sum, size) => sum + size, 0);
      const lines = chainedLedger(TEST_CHAIN_KEY, total, alg).trim().split('\n');
      let offset = 0;
      return sizes.map((size) => {
        const part = lines.slice(offset, offset + size).join('\n') + '\n';
        offset += size;
        return part;
      });
    }
    const restoreChain = (name: string, files: Record<string, string>) => {
      vi.stubEnv('KYBERION_AUDIT_CHAIN_KEY', TEST_CHAIN_KEY);
      const archive = tenantArchive(name, [PARTITION], files, {
        chain_key_id: getAuditChainKeyId(TEST_CHAIN_KEY),
      });
      const target = `${FIXTURE_DIR}/${name}-target`;
      return { target, run: () => restoreBackup(restoreOptions(archive, target)) };
    };

    it('verifies a chain spanning segments and the live file, and restores every file', () => {
      const [a, b, live] = splitChain([2, 2, 1]);
      const { target, run } = restoreChain('segments-live', {
        [SEGMENT_A]: a!,
        [SEGMENT_B]: b!,
        [LEDGER]: live!,
      });
      expect(run().ledger_verification).toBe('verified');
      for (const [member, content] of [
        [SEGMENT_A, a],
        [SEGMENT_B, b],
        [LEDGER, live],
      ] as const) {
        expect(safeReadFile(`${target}/${member}`, { encoding: 'utf8' })).toBe(content);
      }
    });

    it('verifies a partition that holds segments only (live file just rotated away)', () => {
      const [a, b] = splitChain([2, 3]);
      const { target, run } = restoreChain('segments-only', { [SEGMENT_A]: a!, [SEGMENT_B]: b! });
      expect(run().ledger_verification).toBe('verified');
      expect(safeExistsSync(`${target}/${SEGMENT_B}`)).toBe(true);
      expect(safeExistsSync(`${target}/${LEDGER}`)).toBe(false);
    });

    it('refuses a keyless (sha256) segment, naming it', () => {
      const [keyless] = splitChain([2], 'sha256');
      const [, live] = splitChain([2, 1]);
      const { target, run } = restoreChain('segment-keyless', {
        [SEGMENT_A]: keyless!,
        [LEDGER]: live!,
      });
      expect(run).toThrow(/BACKUP_RESTORE_LEDGER_DOWNGRADED.*ledger-20261102-101010\.jsonl/u);
      expect(safeExistsSync(`${target}/${LEDGER}`)).toBe(false);
    });

    it('refuses a chain whose segment boundary is broken', () => {
      const [a, , live] = splitChain([2, 2, 1]);
      // The middle segment is missing: the live file no longer links to segment A.
      const { target, run } = restoreChain('segment-gap', { [SEGMENT_A]: a!, [LEDGER]: live! });
      expect(run).toThrow('BACKUP_RESTORE_LEDGER_CORRUPT');
      expect(safeExistsSync(`${target}/${SEGMENT_A}`)).toBe(false);
    });
  });

  it('rejects an archive carrying a symlink member before extraction', () => {
    const source = `${FIXTURE_DIR}/link-source`;
    const manifestMember = 'active/shared/tmp/backup-link/manifest.json';
    const partition = 'active/shared/runtime/usage-ledger/confidential/acme';
    safeWriteFile(
      `${source}/${manifestMember}`,
      JSON.stringify({
        format: 'kyberion-backup-v1',
        scope: 'tenant',
        tenant: 'acme',
        entries: [partition],
        mission_git_repos: [],
      })
    );
    safeWriteFile(`${source}/${partition}/real.jsonl`, '{}\n');
    safeSymlinkSync(
      `${source}/${partition}/real.jsonl`,
      `${source}/${partition}/link.jsonl`,
      'file'
    );
    const archive = `${FIXTURE_DIR}/link.tar.gz`;
    expect(
      safeExecResult('tar', ['-czf', archive, '-C', source, manifestMember, partition], {
        timeoutMs: 120000,
      }).status
    ).toBe(0);
    const target = `${FIXTURE_DIR}/link-target`;
    expect(() => restoreBackup(restoreOptions(archive, target))).toThrow(
      'BACKUP_ARCHIVE_MEMBER_TYPE'
    );
    expect(safeExistsSync(target)).toBe(false);
  });

  it('refuses a restore target outside this checkout before extraction', () => {
    const archive = tenantArchive(
      'outside',
      ['active/shared/runtime/usage-ledger/confidential/acme'],
      {
        'active/shared/runtime/usage-ledger/confidential/acme/resource-usage.jsonl': '{"a":1}\n',
      }
    );
    expect(() => restoreBackup(restoreOptions(archive, '/nonexistent-kyberion-restore'))).toThrow(
      'BACKUP_RESTORE_TARGET_OUTSIDE_REPOSITORY'
    );
  });

  it('skips a symlinked tenant partition directory when planning a backup', () => {
    const real = `${FIXTURE_DIR}/elsewhere`;
    safeMkdir(real);
    safeMkdir(`${FIXTURE_DIR}/active/shared/runtime/grants/confidential`);
    safeMkdir(`${FIXTURE_DIR}/active/shared/runtime/hearing/confidential/acme`);
    safeSymlinkSync(real, `${FIXTURE_DIR}/active/shared/runtime/grants/confidential/acme`, 'dir');
    const plan = resolveBackupPlan({
      scope: 'tenant',
      tenant: 'acme',
      rootDir: FIXTURE_DIR,
      pathExists: (repoPath) => safeExistsSync(`${FIXTURE_DIR}/${repoPath}`),
      tenantResolver: () => undefined,
    });
    expect(plan.entries).toContain('active/shared/runtime/hearing/confidential/acme');
    expect(plan.entries).not.toContain('active/shared/runtime/grants/confidential/acme');
    expect(plan.warnings.join('\n')).toContain('symlinked tenant runtime partition');
  });

  it('a --force restore over live state never revives a revoked grant or touches a newer one', () => {
    const grants = 'active/shared/runtime/grants/confidential/acme';
    const invites = 'active/shared/runtime/customer-decision-invites/confidential/acme';
    const archive = tenantArchive('live-revocable', [grants, invites], {
      [`${grants}/grant-a.json`]: '{"grant_id":"grant-a","status":"active"}\n',
      [`${invites}/inv-00000000000000aa.json`]:
        '{"invite_id":"inv-00000000000000aa","status":"open"}\n',
    });
    const target = `${FIXTURE_DIR}/live-revocable-target`;
    const revoked = '{"grant_id":"grant-a","status":"revoked"}\n';
    const newer = '{"grant_id":"grant-b","status":"active"}\n';
    const revokedInvite = '{"invite_id":"inv-00000000000000aa","status":"revoked"}\n';
    safeWriteFile(`${target}/${grants}/grant-a.json`, revoked);
    safeWriteFile(`${target}/${grants}/grant-b.json`, newer);
    safeWriteFile(`${target}/${invites}/inv-00000000000000aa.json`, revokedInvite);

    const result = restoreBackup(restoreOptions(archive, target, true));

    expect(safeReadFile(`${target}/${grants}/grant-a.json`, { encoding: 'utf8' })).toBe(revoked);
    expect(safeReadFile(`${target}/${grants}/grant-b.json`, { encoding: 'utf8' })).toBe(newer);
    expect(
      safeReadFile(`${target}/${invites}/inv-00000000000000aa.json`, { encoding: 'utf8' })
    ).toBe(revokedInvite);
    const grantQuarantine = result.quarantinePaths.find((p) =>
      p.startsWith(`${grants}/.restore-quarantine/`)
    );
    expect(grantQuarantine).toBeDefined();
    expect(
      safeReadFile(`${target}/${grantQuarantine}/grant-a.json`, { encoding: 'utf8' })
    ).toContain('"active"');
    expect(safeExistsSync(`${target}/${grantQuarantine}/grant-b.json`)).toBe(false);
  });

  it('on an exclusion breach moves only tar-written archive members aside, never live files', () => {
    const target = `${FIXTURE_DIR}/breach-target`;
    const partition = 'active/shared/runtime/grants/confidential/acme';
    const written = `${partition}/grant-a.json`;
    const unchanged = `${partition}/grant-b.json`;
    const liveOnly = `${partition}/grant-live.json`;
    safeWriteFile(`${target}/${written}`, '{"grant_id":"grant-a","status":"active"}\n');
    safeWriteFile(`${target}/${unchanged}`, '{"grant_id":"grant-b"}\n');
    safeWriteFile(`${target}/${liveOnly}`, '{"grant_id":"grant-live"}\n');
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    const before = new Map<string, string | undefined>([
      [written, undefined],
      [unchanged, digest('{"grant_id":"grant-b"}\n')],
    ]);
    expect(() =>
      assertExclusionsHeld(
        target,
        { appendOnly: [], revocable: [partition] },
        [written, unchanged],
        before,
        'stamp-1'
      )
    ).toThrow(/BACKUP_RESTORE_EXCLUDE_FAILED.*grant-a\.json/u);
    expect(safeExistsSync(`${target}/${written}`)).toBe(false);
    expect(
      safeExistsSync(
        `${target}/${partition}/.restore-quarantine/stamp-1/exclude-breach/grant-a.json`
      )
    ).toBe(true);
    expect(safeReadFile(`${target}/${unchanged}`, { encoding: 'utf8' })).toBe(
      '{"grant_id":"grant-b"}\n'
    );
    expect(safeReadFile(`${target}/${liveOnly}`, { encoding: 'utf8' })).toBe(
      '{"grant_id":"grant-live"}\n'
    );
  });

  it('quarantines restored customer decision invites and standing grants (D1)', () => {
    const invites = 'active/shared/runtime/customer-decision-invites/confidential/acme';
    const grants = 'active/shared/runtime/grants/confidential/acme';
    const archive = tenantArchive('revocable', [invites, grants], {
      [`${invites}/inv-00000000000000aa.json`]: '{"invite_id":"inv-00000000000000aa"}\n',
      [`${grants}/grant-a.json`]: '{"grant_id":"grant-a"}\n',
    });
    const target = `${FIXTURE_DIR}/revocable-target`;
    const result = restoreBackup(restoreOptions(archive, target));
    expect(safeExistsSync(`${target}/${invites}/inv-00000000000000aa.json`)).toBe(false);
    expect(safeExistsSync(`${target}/${grants}/grant-a.json`)).toBe(false);
    const quarantined = result.quarantinePaths.filter((p) => p.includes('/.restore-quarantine/'));
    expect(quarantined).toHaveLength(2);
    for (const quarantinePath of quarantined)
      expect(safeExistsSync(`${target}/${quarantinePath}/quarantine-manifest.json`)).toBe(true);
    expect(
      quarantined.some((p) => safeExistsSync(`${target}/${p}/inv-00000000000000aa.json`))
    ).toBe(true);
  });
});

describe('restore drill dist fallback', () => {
  const root = `${FIXTURE_DIR}-copytree`;

  afterEach(() => safeRmSync(root, { recursive: true, force: true }));

  it('copies dist/ instead of linking it (regular files and directories only)', () => {
    safeWriteFile(`${root}/src/scripts/run_pipeline.js`, 'run();');
    safeWriteFile(`${root}/src/top.js`, 'top();');
    safeSymlinkSync(`${root}/src/top.js`, `${root}/src/alias.js`, 'file');
    copyTree(`${root}/src`, `${root}/dest`);
    expect(safeReadFile(`${root}/dest/scripts/run_pipeline.js`)).toBe('run();');
    expect(safeReadFile(`${root}/dest/top.js`)).toBe('top();');
    expect(safeExistsSync(`${root}/dest/alias.js`)).toBe(false);
  });
});

describe('backup manifest', () => {
  const ledgerRoot = TENANT_RUNTIME_PARTITION_ROOTS.find((root) => root.family === 'ledger')!;
  const tenantPlan = {
    scope: 'tenant' as const,
    includesSensitive: true,
    entries: ['knowledge/confidential/acme', `${ledgerRoot.root}/confidential/acme`],
    missionGitRepos: [],
    tenantRuntimePartitions: [
      {
        ...ledgerRoot,
        tier: 'confidential' as const,
        tenant: 'acme',
        path: `${ledgerRoot.root}/confidential/acme`,
      },
    ],
    warnings: [],
  };

  it('names the tenant runtime partitions and the chain key id in a tenant archive', () => {
    const chainKeyId = getAuditChainKeyId('backup-manifest-key');
    const manifest = buildBackupManifest(
      tenantPlan,
      { tenant: 'acme', encrypt: true },
      { missionGitBundles: [], chainKeyId, warnings: [] }
    );
    expect(manifest).toMatchObject({
      scope: 'tenant',
      tenant: 'acme',
      encrypted: true,
      tenant_runtime_partitions: [
        {
          key: ledgerRoot.key,
          path: `${ledgerRoot.root}/confidential/acme`,
          append_only: ledgerRoot.appendOnly,
          hash_chained: ledgerRoot.hashChained,
        },
      ],
      chain_key_id: chainKeyId,
    });
    // D2: the key itself never rides in the archive.
    expect(JSON.stringify(manifest)).not.toContain('backup-manifest-key');
    // What createBackup writes is what a restore accepts.
    const restored = parseRestoredBackupManifest(JSON.stringify(manifest));
    expect(restored.tenant_runtime_partitions).toEqual(manifest.tenant_runtime_partitions);
    expect(restored.chain_key_id).toBe(chainKeyId);
  });

  it('omits the partitions outside tenant scope and the key id without a chain key', () => {
    const manifest = buildBackupManifest(
      {
        ...tenantPlan,
        scope: 'all',
        includesSensitive: false,
        entries: ['knowledge/public'],
        tenantRuntimePartitions: [],
      },
      {},
      { missionGitBundles: [], warnings: ['same device'] }
    );
    expect(manifest).not.toHaveProperty('tenant_runtime_partitions');
    expect(manifest).not.toHaveProperty('chain_key_id');
    expect(manifest).toMatchObject({ scope: 'all', tenant: null, warnings: ['same device'] });
    expect(parseRestoredBackupManifest(JSON.stringify(manifest))).not.toHaveProperty(
      'tenant_runtime_partitions'
    );
  });

  it('pairs each mission repository with its bundle path', () => {
    const manifest = buildBackupManifest(
      {
        ...tenantPlan,
        scope: 'mission',
        tenantRuntimePartitions: [],
        missionGitRepos: [
          { missionPath: '/x/a', repoRelativePath: 'active/missions/public/MSN-A' },
          { missionPath: '/x/b', repoRelativePath: 'active/missions/public/MSN-B' },
        ],
      },
      { mission: 'MSN-A' },
      {
        missionGitBundles: ['active/shared/tmp/backup-x/mission-git-bundles/a.bundle'],
        warnings: [],
      }
    );
    expect(manifest.mission_git_repos).toEqual([
      {
        repo_relative_path: 'active/missions/public/MSN-A',
        bundle_path: 'active/shared/tmp/backup-x/mission-git-bundles/a.bundle',
      },
      { repo_relative_path: 'active/missions/public/MSN-B', bundle_path: null },
    ]);
    expect(manifest).not.toHaveProperty('tenant_runtime_partitions');
  });
});

describe('backup file selection', () => {
  const root = `${FIXTURE_DIR}-select`;
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    safeRmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const retentionEntries = [
    { path: 'active/shared/runtime/vitest-live', artifact_class: 'tmp', backup: 'exclude' },
    { path: 'active/shared/runtime/history-search', artifact_class: 'cache', backup: 'exclude' },
    { path: 'active/shared/runtime/grants', artifact_class: 'state' },
    // Pending state classed cache/tmp without the opt-out: always archived.
    { path: 'active/shared/runtime/feedback-loop/tenants', artifact_class: 'cache' },
    { path: 'active/shared/runtime/distill-candidates', artifact_class: 'cache' },
    { path: 'active/shared/coordination/orchestration/events', artifact_class: 'cache' },
    { path: 'presence/bridge/runtime', artifact_class: 'cache' },
    { path: 'active/shared/runtime/user-tenant-cache', artifact_class: 'cache', backup: 'exclude' },
    { path: 'active/archive/.trash', artifact_class: 'tmp', backup: 'exclude' },
    { path: 'active/shared/data-vault', artifact_class: 'cache', backup: 'exclude' },
  ];
  const toolRuntimesRoot = 'active/shared/runtime/tool-runtimes';

  it('excludes the re-generable floors, opted-out catalog roots and the backup output', () => {
    const exclusions = resolveBackupExclusions({
      rootDir: root,
      entries: ['active', 'vault'],
      outPath: `${root}/active/out/kyberion-all.tar.gz.enc`,
      plainArchivePath: `${root}/active/shared/tmp/backup-x/payload.tar.gz`,
      tempDir: `${root}/active/shared/tmp/backup-x`,
      retentionEntries,
      toolRuntimesRoot,
    });
    expect(exclusions.excludedRoots).toEqual(
      expect.arrayContaining([
        'active/shared/tmp',
        'active/shared/staging',
        'active/shared/cache',
        'active/shared/exports/backups',
        'active/shared/runtime/vitest-live',
        'active/shared/runtime/history-search',
        'active/archive/.trash',
        'active/shared/data-vault',
      ])
    );
    for (const pending of [
      'active/shared/runtime/grants',
      'active/shared/runtime/feedback-loop/tenants',
      'active/shared/runtime/distill-candidates',
      'active/shared/coordination/orchestration/events',
      'presence/bridge/runtime',
    ]) {
      expect(exclusions.excludedRoots).not.toContain(pending);
    }
    expect(exclusions.excludedFiles).toEqual([
      'active/out/kyberion-all.tar.gz.enc',
      'active/shared/tmp/backup-x/payload.tar.gz',
      'knowledge/personal/connections/kyberion-backup.json',
      'knowledge/personal/connections/kyberion-backup.json.bak',
    ]);
    expect(exclusions.archiveDirs).toEqual(['active/out']);
    expect(exclusions.provenanceOnlyRoots).toEqual([toolRuntimesRoot]);
  });

  it('the governed catalog opts .trash and data-vault out but keeps pending staging stores', () => {
    const exclusions = resolveBackupExclusions({
      rootDir: pathResolver.rootDir(),
      entries: ['active'],
      toolRuntimesRoot: null,
    });
    expect(exclusions.excludedRoots).toEqual(
      expect.arrayContaining(['active/archive/.trash', 'active/shared/data-vault'])
    );
    for (const pending of [
      'active/shared/runtime/distill-candidates',
      'active/shared/runtime/feedback-loop/tenants',
      'active/shared/coordination/orchestration/events',
    ]) {
      expect(exclusions.excludedRoots).not.toContain(pending);
    }
  });

  it('reports repeated hard links as dropped paths, not as archived once', () => {
    const [warning] = selectionWarnings({
      paths: ['active/a.json'],
      unlisted: [],
      totalBytes: 1,
      skipped: { excluded: 0, nonRegular: [], symlinks: [], hardLinks: ['active/b.json'] },
    });
    expect(warning).toMatch(/^Skipped 1 repeated hard link\(s\)/);
    expect(warning).toContain('absent from the archive: active/b.json');
    expect(warning).not.toMatch(/Archived/);
  });

  it('keeps an explicitly planned entry that lies under an excluded root', () => {
    const exclusions = resolveBackupExclusions({
      rootDir: root,
      entries: ['active/shared/runtime/user-tenant-cache/acme'],
      retentionEntries,
      toolRuntimesRoot,
    });
    expect(exclusions.excludedRoots).not.toContain('active/shared/runtime/user-tenant-cache');
    expect(exclusions.excludedRoots).toContain('active/shared/runtime/history-search');
    expect(exclusions.excludedRoots).toContain('active/shared/cache');
  });

  it('archives durable state only: no sockets, links, caches, scratch or earlier archives', async () => {
    const keep = [
      'active/missions/public/MSN-A/evidence.md',
      'active/shared/runtime/grants/grant.json',
      'active/shared/runtime/distill-candidates/candidate.json',
      'active/out/notes.txt',
      `${toolRuntimesRoot}/whisper/state.json`,
      'vault/keys.enc',
    ];
    const drop = [
      'active/shared/cache/system/model.bin',
      'active/shared/tmp/job/scratch.txt',
      'active/shared/staging/inbound.pdf',
      'active/shared/exports/backups/kyberion-all-old.tar.gz.enc',
      'active/shared/runtime/vitest-live/run.json',
      'active/archive/.trash/active/old/removed.json',
      'active/shared/data-vault/entry.json',
      'active/out/kyberion-all-previous.tar.gz.enc',
      'active/out/kyberion-all.tar.gz.enc',
      `${toolRuntimesRoot}/whisper/bin/python`,
      'active/missions/public/MSN-A/.git/HEAD',
    ];
    for (const rel of [...keep, ...drop]) safeWriteFile(`${root}/${rel}`, `${rel}\n`);
    safeMkdir(`${root}/active/projects/empty`, { recursive: true });
    safeSymlinkSync(`${root}/vault/keys.enc`, `${root}/active/keys-alias`, 'file');
    // Short path: a unix socket path is limited to ~104 bytes.
    server = createServer();
    await new Promise<void>((resolve) => server!.listen(`${root}/active/s.sock`, resolve));

    const exclusions = resolveBackupExclusions({
      rootDir: root,
      entries: ['active', 'vault'],
      outPath: `${root}/active/out/kyberion-all.tar.gz.enc`,
      retentionEntries,
      toolRuntimesRoot,
    });
    const selection = selectBackupFiles({
      rootDir: root,
      entries: ['active', 'vault'],
      exclusions,
      missionGitRepos: ['active/missions/public/MSN-A'],
    });

    expect([...selection.paths].sort()).toEqual([...keep, 'active/projects/empty'].sort());
    expect(selection.skipped.nonRegular).toEqual(['active/s.sock']);
    expect(selection.skipped.symlinks).toEqual(['active/keys-alias']);
    expect(selection.unlisted).toEqual([]);
    expect(selection.totalBytes).toBeGreaterThan(0);
    expect(selectionWarnings(selection).join('\n')).toContain('active/s.sock');

    // The list is what tar receives: it archives cleanly although a socket sits in the tree.
    const listPath = `${root}-list.txt`;
    const archive = `${root}-out.tar.gz`;
    try {
      safeWriteFile(listPath, `${selection.paths.join('\n')}\n`);
      const tar = safeExecResult('tar', ['-czf', archive, '-C', root, '-T', listPath], {
        timeoutMs: 60000,
      });
      expect(tar.status, tar.stderr).toBe(0);
      const members = safeExecResult('tar', ['-tzf', archive], { timeoutMs: 60000 })
        .stdout.split('\n')
        .filter(Boolean)
        .map((member) => member.replace(/\/$/, ''));
      expect(members).toEqual(expect.arrayContaining(keep));
      expect(members.some((member) => member.endsWith('.sock'))).toBe(false);
    } finally {
      safeRmSync(listPath, { force: true });
      safeRmSync(archive, { force: true });
    }
  });

  it('scales the tar timeout with the payload and caps it', () => {
    expect(backupArchiveTimeoutMs(0)).toBe(10 * 60 * 1000);
    const elevenGiB = 11 * 1024 * 1024 * 1024;
    expect(backupArchiveTimeoutMs(elevenGiB)).toBeGreaterThan(45 * 60 * 1000);
    expect(backupArchiveTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(6 * 60 * 60 * 1000);
  });

  it('reports a tar timeout with the payload size and the limit', () => {
    const error = Object.assign(new Error('spawnSync tar ETIMEDOUT'), { code: 'ETIMEDOUT' });
    expect(() =>
      interpretTarResult(
        { status: null, stdout: '', stderr: '', error },
        { timeoutMs: 600000, fileCount: 42, totalBytes: 1024, archive: '/x/a.tar.gz.enc' }
      )
    ).toThrow(/\[BACKUP_ARCHIVE_TIMEOUT\] tar did not finish within 600s .*42 files.*\| next:/);
  });

  it('treats files that vanished during the walk as warnings, other tar failures as errors', () => {
    const context = { timeoutMs: 1000, fileCount: 1, totalBytes: 1, archive: '/x/a.tar.gz' };
    expect(
      interpretTarResult(
        {
          status: 1,
          stdout: '',
          stderr:
            'tar: active/shared/runtime/locks/a.lock: Cannot stat: No such file or directory\ntar: Error exit delayed from previous errors.\n',
        },
        context
      ).warnings
    ).toEqual([expect.stringContaining('a.lock')]);
    expect(() =>
      interpretTarResult(
        { status: 1, stdout: '', stderr: 'tar: x.sock: pax format cannot archive sockets\n' },
        context
      )
    ).toThrow('backup archive creation failed');
  });

  it('fails an encrypted backup on a missing passphrase before writing anything', () => {
    vi.stubEnv('KYBERION_BACKUP_PASSPHRASE', '');
    const out = `${root}/out/kyberion-all.tar.gz.enc`;
    expect(() =>
      createBackup(
        {
          command: 'create',
          scope: 'all',
          encrypt: true,
          out,
          passphraseEnv: 'KYBERION_BACKUP_PASSPHRASE',
          retainDaily: 7,
          retainWeekly: 4,
        },
        {
          // Hermetic: never consult the host keychain or secret stores.
          backend: { lookupOutsideBackupScope: () => null, inBackupScopeStores: () => [] },
        }
      )
    ).toThrow('[BACKUP_PASSPHRASE_MISSING]');
    expect(safeExistsSync(`${root}/out`)).toBe(false);
  });

  it('keeps going when one mission bundle fails and reports it as a warning', () => {
    safeMkdir(root, { recursive: true });
    const warnings: string[] = [];
    const bundles = createMissionGitBundles(
      root,
      [{ missionPath: `${root}/missing-repo`, repoRelativePath: 'active/missions/public/MSN-X' }],
      warnings
    );
    expect(bundles).toEqual([null]);
    expect(warnings).toEqual([
      expect.stringMatching(
        /^\[BACKUP_MISSION_BUNDLE_FAILED\] git bundle for active\/missions\/public\/MSN-X failed — .*\| next: .*\| evidence: /
      ),
    ]);
  });
});
