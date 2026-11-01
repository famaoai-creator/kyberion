import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { logger } from '@agent/core/core';
import {
  BACKUP_PASSPHRASE_INTRODUCE_COMMAND,
  backupPassphraseIdentity,
  describeBackupPassphraseAvailability,
  resolveBackupPassphrase,
  type BackupPassphraseAuditRecord,
  type BackupPassphraseSecretBackend,
} from './backup-passphrase.js';
import { resolveBackupExclusions, selectBackupFiles } from './backup-file-selection.js';

const SECRET = 'correct-horse-battery-staple-0001';
const ENV = 'KYBERION_BACKUP_PASSPHRASE';

function fakeBackend(
  options: { outside?: { value: string; backend: string } | null; inScope?: string[] } = {}
): BackupPassphraseSecretBackend & { lookups: number } {
  const backend = {
    lookups: 0,
    lookupOutsideBackupScope: () => {
      backend.lookups += 1;
      return options.outside ?? null;
    },
    inBackupScopeStores: () => options.inScope ?? [],
  };
  return backend;
}

const envOf =
  (values: Record<string, string>) =>
  (name: string): string | undefined =>
    values[name];

describe('backup passphrase resolution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the governed identity kyberion-backup / PASSPHRASE', () => {
    expect(backupPassphraseIdentity()).toMatchObject({
      envName: ENV,
      keychainService: 'kyberion-backup',
      keychainAccount: 'passphrase',
      connectionField: 'passphrase',
    });
    expect(BACKUP_PASSPHRASE_INTRODUCE_COMMAND).toBe(
      'pnpm kyberion secret introduce kyberion-backup PASSPHRASE'
    );
  });

  it('prefers an explicit --passphrase-env variable and never consults the secret store', () => {
    const backend = fakeBackend({ outside: { value: 'from-keychain', backend: 'os_keychain' } });
    const audits: BackupPassphraseAuditRecord[] = [];
    const resolved = resolveBackupPassphrase('MY_BACKUP_KEY', 'create', {
      readEnv: envOf({ MY_BACKUP_KEY: SECRET, [ENV]: 'from-default-env' }),
      backend,
      audit: (record) => audits.push(record),
    });
    expect(resolved).toEqual({ value: SECRET, source: 'env', envName: 'MY_BACKUP_KEY' });
    expect(backend.lookups).toBe(0);
    expect(audits).toEqual([
      {
        action: 'backup.passphrase_resolved',
        operation: 'create',
        source: 'env',
        envName: 'MY_BACKUP_KEY',
      },
    ]);
  });

  it('fails loudly when the explicit variable is empty instead of falling back', () => {
    const backend = fakeBackend({ outside: { value: SECRET, backend: 'os_keychain' } });
    expect(() =>
      resolveBackupPassphrase('MY_BACKUP_KEY', 'restore', {
        readEnv: envOf({}),
        backend,
        audit: () => {},
      })
    ).toThrow(/\[BACKUP_PASSPHRASE_MISSING\] Missing MY_BACKUP_KEY — --passphrase-env/);
    expect(backend.lookups).toBe(0);
  });

  it('takes the KYBERION_BACKUP_PASSPHRASE env override before the secret store', () => {
    const backend = fakeBackend({ outside: { value: 'from-keychain', backend: 'os_keychain' } });
    const resolved = resolveBackupPassphrase(ENV, 'create', {
      readEnv: envOf({ [ENV]: SECRET }),
      backend,
      audit: () => {},
    });
    expect(resolved.source).toBe('env');
    expect(resolved.value).toBe(SECRET);
    expect(backend.lookups).toBe(0);
  });

  it('falls back to the keychain / external resolver and audits the backend, not the value', () => {
    const audits: BackupPassphraseAuditRecord[] = [];
    const resolved = resolveBackupPassphrase(ENV, 'restore', {
      readEnv: envOf({}),
      backend: fakeBackend({ outside: { value: SECRET, backend: 'os_keychain' } }),
      audit: (record) => audits.push(record),
    });
    expect(resolved).toEqual({ value: SECRET, source: 'secret:os_keychain', envName: ENV });
    expect(audits).toHaveLength(1);
    expect(audits[0].source).toBe('secret:os_keychain');
    expect(JSON.stringify(audits)).not.toContain(SECRET);
  });

  it('refuses a passphrase found only in an in-repo store that backups archive', () => {
    const audits: BackupPassphraseAuditRecord[] = [];
    let message = '';
    try {
      resolveBackupPassphrase(ENV, 'create', {
        readEnv: envOf({}),
        backend: fakeBackend({ inScope: ['knowledge/personal/connections/kyberion-backup.json'] }),
        audit: (record) => audits.push(record),
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(
      /^\[BACKUP_PASSPHRASE_IN_BACKUP_SCOPE\] .* — .* \| next: .*pnpm kyberion secret introduce kyberion-backup PASSPHRASE.* \| evidence: knowledge\/personal\/connections\/kyberion-backup\.json$/
    );
    expect(audits).toEqual([]);
  });

  it('names the secret introduce command first and the env override second when missing', () => {
    let message = '';
    try {
      resolveBackupPassphrase(ENV, 'create', {
        readEnv: envOf({}),
        backend: fakeBackend(),
        audit: () => {},
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^\[BACKUP_PASSPHRASE_MISSING\] /);
    const next = message.split(' | next: ')[1] ?? '';
    const commandAt = next.indexOf('pnpm kyberion secret introduce kyberion-backup PASSPHRASE');
    const envAt = next.indexOf(`export ${ENV}=`);
    expect(commandAt).toBeGreaterThanOrEqual(0);
    expect(envAt).toBeGreaterThan(commandAt);
    expect(message).toContain('--passphrase-env');
  });

  it('never writes the value to the logger or the audit record', () => {
    const lines: string[] = [];
    for (const level of ['info', 'warn', 'error', 'debug', 'success'] as const) {
      vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    const audits: BackupPassphraseAuditRecord[] = [];
    resolveBackupPassphrase(ENV, 'create', {
      readEnv: envOf({}),
      backend: fakeBackend({ outside: { value: SECRET, backend: 'external_resolver' } }),
      audit: (record) => audits.push(record),
    });
    describeBackupPassphraseAvailability({
      readEnv: envOf({}),
      backend: fakeBackend({ outside: { value: SECRET, backend: 'external_resolver' } }),
    });
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(JSON.stringify(audits)).not.toContain(SECRET);
  });
});

describe('describeBackupPassphraseAvailability', () => {
  it('reports the source without the value', () => {
    const fromEnv = describeBackupPassphraseAvailability({
      readEnv: envOf({ [ENV]: SECRET }),
      backend: fakeBackend(),
    });
    expect(fromEnv).toEqual({ available: true, source: 'env' });
    const fromSecret = describeBackupPassphraseAvailability({
      readEnv: envOf({}),
      backend: fakeBackend({ outside: { value: SECRET, backend: 'os_keychain' } }),
    });
    expect(fromSecret).toEqual({ available: true, source: 'secret', backend: 'os_keychain' });
    expect(JSON.stringify([fromEnv, fromSecret])).not.toContain(SECRET);
  });

  it('reports missing and in-backup-scope as unavailable with the diagnostic', () => {
    const missing = describeBackupPassphraseAvailability({
      readEnv: envOf({}),
      backend: fakeBackend(),
    });
    expect(missing.available).toBe(false);
    expect(missing.source).toBeNull();
    expect(missing.reason).toContain('[BACKUP_PASSPHRASE_MISSING]');
    expect(missing.reason).toContain(BACKUP_PASSPHRASE_INTRODUCE_COMMAND);
    const inScope = describeBackupPassphraseAvailability({
      readEnv: envOf({}),
      backend: fakeBackend({ inScope: ['vault/secrets (secret-guard local store)'] }),
    });
    expect(inScope).toMatchObject({ available: false, source: null });
    expect(inScope.reason).toContain('[BACKUP_PASSPHRASE_IN_BACKUP_SCOPE]');
  });

  it('degrades a failing probe to unavailable without the error text', () => {
    const result = describeBackupPassphraseAvailability({
      readEnv: envOf({}),
      backend: {
        lookupOutsideBackupScope: () => {
          throw new Error(`boom ${SECRET}`);
        },
        inBackupScopeStores: () => [],
      },
    });
    expect(result).toEqual({
      available: false,
      source: null,
      reason: '[BACKUP_PASSPHRASE_PROBE_FAILED] Error',
    });
  });
});

describe('backup passphrase connection document', () => {
  const root = pathResolver.sharedTmp('backup-passphrase-test');
  afterEach(() => safeRmSync(root, { recursive: true, force: true }));

  it('is never selected into an archive', () => {
    const keep = 'knowledge/personal/connections/github.json';
    const drop = [
      'knowledge/personal/connections/kyberion-backup.json',
      'knowledge/personal/connections/kyberion-backup.json.bak',
    ];
    for (const rel of [keep, ...drop]) safeWriteFile(`${root}/${rel}`, '{}\n');
    const exclusions = resolveBackupExclusions({
      rootDir: root,
      entries: ['knowledge/personal'],
      retentionEntries: [],
      toolRuntimesRoot: null,
    });
    const selection = selectBackupFiles({
      rootDir: root,
      entries: ['knowledge/personal'],
      exclusions,
      missionGitRepos: [],
    });
    expect(selection.paths).toEqual([keep]);
  });
});
