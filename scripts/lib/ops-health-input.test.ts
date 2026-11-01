import { describe, expect, it, vi } from 'vitest';
import {
  backupDailyEnabled,
  probeBackupPassphraseCached,
  toChronosHeartbeatObservation,
} from './ops-health-input.js';
import {
  describeBackupPassphraseAvailability,
  type BackupPassphraseSecretBackend,
} from './backup-passphrase.js';

function backend(value: string | null): BackupPassphraseSecretBackend {
  return {
    lookupOutsideBackupScope: vi.fn(() => (value ? { value, backend: 'os_keychain' } : null)),
    inBackupScopeStores: vi.fn(() => []),
  };
}

const probeWith = (b: BackupPassphraseSecretBackend) => () =>
  describeBackupPassphraseAvailability({ readEnv: () => undefined, backend: b });

describe('backup passphrase probe for ops health', () => {
  it('reports the keychain source without the value and caches a reachable result', () => {
    const store = vi.fn();
    const result = probeBackupPassphraseCached({
      probe: probeWith(backend('s3cret')),
      loadCached: () => null,
      storeCached: store,
    });
    expect(result).toEqual({ available: true, source: 'secret', backend: 'os_keychain' });
    expect(JSON.stringify(result)).not.toContain('s3cret');
    expect(store).toHaveBeenCalledWith({
      available: true,
      source: 'secret',
      backend: 'os_keychain',
    });
  });

  it('never caches an unavailable result and carries the reason', () => {
    const store = vi.fn();
    const result = probeBackupPassphraseCached({
      probe: probeWith(backend(null)),
      loadCached: () => null,
      storeCached: store,
    });
    expect(result.available).toBe(false);
    expect(result.reason).toContain('BACKUP_PASSPHRASE_MISSING');
    expect(store).not.toHaveBeenCalled();
  });

  it('skips the keychain probe when a reachable result is cached', () => {
    const b = backend('s3cret');
    const result = probeBackupPassphraseCached({
      probe: probeWith(b),
      loadCached: () => ({ available: true, source: 'secret', backend: 'os_keychain' }),
      storeCached: vi.fn(),
    });
    expect(result.available).toBe(true);
    expect(b.lookupOutsideBackupScope).not.toHaveBeenCalled();
  });

  it('never caches an env result and ignores a cached env result', () => {
    const store = vi.fn();
    const envProbe = vi.fn(() =>
      describeBackupPassphraseAvailability({ readEnv: () => 'from-shell', backend: backend(null) })
    );
    const result = probeBackupPassphraseCached({
      probe: envProbe,
      loadCached: () => ({ available: true, source: 'env' }),
      storeCached: store,
    });
    expect(result).toMatchObject({ available: true, source: 'env' });
    // The cached env entry was not trusted: the probe ran, and nothing was stored.
    expect(envProbe).toHaveBeenCalledTimes(1);
    expect(store).not.toHaveBeenCalled();
  });

  it('projects the in-progress tick phase into the heartbeat observation', () => {
    const observation = toChronosHeartbeatObservation({
      daemon_id: 'chronos-daemon',
      status: 'healthy',
      heartbeat: {
        daemon_id: 'chronos-daemon',
        pid: 1,
        status: 'running',
        timestamp: '2026-11-01T03:00:00.000Z',
        details: { phase: 'tick_in_progress', tick_started_at: '2026-11-01T01:00:00.000Z' },
      },
    });
    expect(observation).toMatchObject({
      phase: 'tick_in_progress',
      tick_started_at: '2026-11-01T01:00:00.000Z',
    });
  });

  it('only probes when backup-daily is enabled', () => {
    const schedule = (enabled: boolean) =>
      ({ id: 'backup-daily', enabled, trigger: { type: 'cron' } }) as never;
    expect(backupDailyEnabled([schedule(true)])).toBe(true);
    expect(backupDailyEnabled([schedule(false)])).toBe(false);
    expect(backupDailyEnabled(null)).toBe(false);
  });
});
