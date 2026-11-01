import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listBackups: vi.fn(),
  runRestoreDrill: vi.fn(),
  writeBackupDrillReceipt: vi.fn(),
}));

vi.mock('./backup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./backup.js')>()),
  listBackups: mocks.listBackups,
  runRestoreDrill: mocks.runRestoreDrill,
}));

vi.mock('@agent/core/ops-health-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/ops-health-state')>()),
  writeBackupDrillReceipt: mocks.writeBackupDrillReceipt,
}));

const { runInlineBackupRestoreDrill } = await import('./pipeline-domain-ops.js');

const step = { id: 'drill', op: 'core:run_backup_restore_drill' } as never;

describe('core:run_backup_restore_drill receipt', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes an ok receipt naming the archive on success', () => {
    mocks.listBackups.mockReturnValue(['a.tar.gz.enc']);
    mocks.runRestoreDrill.mockReturnValue({
      archive: '/backups/a.tar.gz.enc',
      target: '/tmp/drill',
      checkoutPrepared: true,
      baselineVerified: false,
      restoredManifestCount: 3,
      quarantinePaths: [],
    });

    const result = runInlineBackupRestoreDrill(step, { export_as: 'drill' }, {});

    expect(result.drill).toMatchObject({ ok: true, archive: '/backups/a.tar.gz.enc' });
    expect(mocks.writeBackupDrillReceipt).toHaveBeenCalledTimes(1);
    expect(mocks.writeBackupDrillReceipt.mock.calls[0]![0]).toMatchObject({
      ok: true,
      archive: '/backups/a.tar.gz.enc',
    });
    expect(
      Number.isFinite(Date.parse(mocks.writeBackupDrillReceipt.mock.calls[0]![0].completed_at))
    ).toBe(true);
  });

  it('writes a failed receipt and rethrows when the drill fails', () => {
    mocks.listBackups.mockReturnValue(['a.tar.gz.enc']);
    mocks.runRestoreDrill.mockImplementation(() => {
      throw new Error('decrypt failed');
    });

    expect(() => runInlineBackupRestoreDrill(step, { export_as: 'drill' }, {})).toThrow(
      'decrypt failed'
    );
    expect(mocks.writeBackupDrillReceipt.mock.calls[0]![0]).toMatchObject({
      ok: false,
      reason: 'failed',
      error: 'decrypt failed',
      archive: null,
    });
  });

  it('reports a distinct no_archive skip instead of a generic failure', () => {
    mocks.listBackups.mockReturnValue([]);

    const result = runInlineBackupRestoreDrill(step, { export_as: 'drill' }, {});

    expect(result.drill).toMatchObject({ ok: false, skipped: true, reason: 'no_archive' });
    expect(mocks.runRestoreDrill).not.toHaveBeenCalled();
    expect(mocks.writeBackupDrillReceipt.mock.calls[0]![0]).toMatchObject({
      ok: false,
      reason: 'no_archive',
      archive: null,
    });
  });

  it('a receipt write failure never masks the drill outcome', () => {
    mocks.listBackups.mockReturnValue(['a.tar.gz.enc']);
    mocks.runRestoreDrill.mockImplementation(() => {
      throw new Error('extract failed');
    });
    mocks.writeBackupDrillReceipt.mockImplementation(() => {
      throw new Error('EACCES');
    });

    expect(() => runInlineBackupRestoreDrill(step, { export_as: 'drill' }, {})).toThrow(
      'extract failed'
    );
  });
});
