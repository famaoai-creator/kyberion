import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readJanitorLastRunMs: vi.fn(),
  readJanitorLastSubmissionMs: vi.fn(),
  inspectMeshHub: vi.fn(),
  readJanitorFailureMarker: vi.fn(() => null),
}));

vi.mock('@agent/core/ops-health-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/ops-health-state')>()),
  readJanitorFailureMarker: mocks.readJanitorFailureMarker,
}));

vi.mock('@agent/core/storage-janitor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/storage-janitor')>()),
  readJanitorLastRunMs: mocks.readJanitorLastRunMs,
  readJanitorLastSubmissionMs: mocks.readJanitorLastSubmissionMs,
}));

vi.mock('@agent/core/mesh/mesh-hub-inspection', () => ({
  inspectMeshHub: mocks.inspectMeshHub,
}));

const HOUR = 60 * 60 * 1000;

describe('run_doctor maintenance line', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports fresh when a run completed after the last submission', async () => {
    const now = Date.now();
    mocks.readJanitorLastSubmissionMs.mockReturnValue(now - 2 * HOUR);
    mocks.readJanitorLastRunMs.mockReturnValue(now - HOUR);
    const { collectMaintenanceDoctorLines } = await import('./run_doctor.js');

    expect(collectMaintenanceDoctorLines()[0]).toContain('Maintenance: janitor fresh;');
  });

  it('reports pending while a recent submission has not completed yet', async () => {
    const now = Date.now();
    mocks.readJanitorLastSubmissionMs.mockReturnValue(now - HOUR);
    mocks.readJanitorLastRunMs.mockReturnValue(now - 30 * HOUR);
    const { collectMaintenanceDoctorLines } = await import('./run_doctor.js');

    expect(collectMaintenanceDoctorLines()[0]).toContain('Maintenance: janitor pending;');
  });

  it('reports submitted when an old submission never completed', async () => {
    const now = Date.now();
    mocks.readJanitorLastSubmissionMs.mockReturnValue(now - 30 * HOUR);
    mocks.readJanitorLastRunMs.mockReturnValue(null);
    const { collectMaintenanceDoctorLines } = await import('./run_doctor.js');

    expect(collectMaintenanceDoctorLines()[0]).toContain('Maintenance: janitor submitted;');
  });
});

describe('run_doctor mesh delivery line', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it('skips inspection without a tenant instead of surfacing a validation error', async () => {
    vi.stubEnv('KYBERION_TENANT', '');
    vi.stubEnv('KYBERION_TENANT_ID', '');
    const { collectMeshDeliveryDoctorLines } = await import('./run_doctor.js');

    const lines = await collectMeshDeliveryDoctorLines();

    expect(lines[0]).toBe(
      'Mesh delivery: not inspected; no tenant scope (set KYBERION_TENANT to inspect)'
    );
    expect(mocks.inspectMeshHub).not.toHaveBeenCalled();
  });

  it('inspects the configured tenant', async () => {
    vi.stubEnv('KYBERION_TENANT', 'acme');
    mocks.inspectMeshHub.mockResolvedValue({ delivery_count: 0, dead_letter_count: 0, routes: [] });
    const { collectMeshDeliveryDoctorLines } = await import('./run_doctor.js');

    const lines = await collectMeshDeliveryDoctorLines();

    expect(mocks.inspectMeshHub).toHaveBeenCalledWith({ tenantId: 'acme' });
    expect(lines[0]).toContain('Mesh delivery: idle');
  });
});

describe('run_doctor resident ops verdict lines', () => {
  it('prints one verdict line per finding with its next command', async () => {
    const { collectOpsHealthDoctorLines } = await import('./run_doctor.js');
    const lines = collectOpsHealthDoctorLines(
      {
        findings: [
          {
            id: 'scheduler-crash-loop',
            severity: 'error',
            reason: 'chronos restarted 9 time(s) in the last hour',
            next: 'pnpm kyberion scheduler status',
          },
          {
            id: 'backup-drill-missing',
            severity: 'warn',
            reason: 'no restore drill receipt',
            next: 'pnpm pipeline --input pipelines/backup-restore-drill.json',
          },
        ],
      },
      25
    );
    expect(lines[0]).toBe(
      'Resident ops: 2 finding(s) (1 error, 1 warn); 25 schedule(s) registered'
    );
    expect(lines[1]).toBe(
      '  - ERROR scheduler-crash-loop: chronos restarted 9 time(s) in the last hour | next: pnpm kyberion scheduler status'
    );
    expect(lines[2]).toContain('WARN backup-drill-missing');
  });

  it('reports healthy when there are no findings', async () => {
    const { collectOpsHealthDoctorLines } = await import('./run_doctor.js');
    expect(collectOpsHealthDoctorLines({ findings: [] }, 3)).toEqual([
      'Resident ops: healthy; 3 schedule(s) registered',
    ]);
    expect(collectOpsHealthDoctorLines({ findings: [] }, null)[0]).toContain(
      'schedule registry unreadable'
    );
  });

  it('describes the restore drill receipt states', async () => {
    const { formatBackupDrillLine } = await import('./run_doctor.js');
    expect(formatBackupDrillLine(null)).toBe('restore drill: never run');
    expect(
      formatBackupDrillLine({ completed_at: '2026-11-01T00:00:00.000Z', archive: 'a', ok: true })
    ).toBe('restore drill: ok at 2026-11-01T00:00:00.000Z');
    expect(
      formatBackupDrillLine({
        completed_at: '2026-11-01T00:00:00.000Z',
        archive: null,
        ok: false,
        reason: 'no_archive',
      })
    ).toContain('backup-daily must succeed first');
  });

  it('appends a janitor failure newer than the last completed run to the maintenance line', async () => {
    const now = Date.now();
    mocks.readJanitorLastSubmissionMs.mockReturnValue(now - 30 * HOUR);
    mocks.readJanitorLastRunMs.mockReturnValue(now - 50 * HOUR);
    mocks.readJanitorFailureMarker.mockReturnValue({
      failed_at: new Date(now - 29 * HOUR).toISOString(),
      exit_code: 1,
      log_path: 'active/shared/logs/process/baseline-janitor-maintenance.log',
    } as never);
    const { collectMaintenanceDoctorLines } = await import('./run_doctor.js');
    expect(collectMaintenanceDoctorLines()[0]).toContain('last_failure=');
    expect(collectMaintenanceDoctorLines()[0]).toContain('baseline-janitor-maintenance.log');
  });
});

describe('run_doctor backup passphrase note', () => {
  it('shows the source/backend when reachable and the introduce command when not', async () => {
    const { formatBackupPassphraseNote } = await import('./run_doctor.js');
    expect(
      formatBackupPassphraseNote({ available: true, source: 'secret', backend: 'os_keychain' })
    ).toBe('passphrase=secret(os_keychain)');
    expect(formatBackupPassphraseNote({ available: true, source: 'env' })).toBe('passphrase=env');
    expect(formatBackupPassphraseNote({ available: false, source: null })).toContain(
      'pnpm kyberion secret introduce kyberion-backup PASSPHRASE'
    );
    expect(formatBackupPassphraseNote(null)).toBe('passphrase=not probed');
  });
});
