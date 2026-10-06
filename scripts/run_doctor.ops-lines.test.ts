import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readJanitorLastRunMs: vi.fn(),
  readJanitorLastSubmissionMs: vi.fn(),
  inspectMeshHub: vi.fn(),
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
