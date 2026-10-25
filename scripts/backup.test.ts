import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeExecResult,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import {
  copyTree,
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
