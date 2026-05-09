import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setupSurfaces: vi.fn(),
  setupServices: vi.fn(),
  runReasoningSetup: vi.fn(),
  collectDoctorReport: vi.fn(),
}));

vi.mock('../scripts/surface_runtime.js', () => ({
  setupSurfaces: mocks.setupSurfaces,
}));

vi.mock('../scripts/services_setup.js', () => ({
  setupServices: mocks.setupServices,
}));

vi.mock('../scripts/reasoning_setup.js', () => ({
  runReasoningSetup: mocks.runReasoningSetup,
}));

vi.mock('../scripts/run_doctor.js', () => ({
  collectDoctorReport: mocks.collectDoctorReport,
}));

describe('setup report', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('combines surface, service, reasoning, and doctor readiness into one report', async () => {
    mocks.setupSurfaces.mockResolvedValue({
      status: 'ok',
      rows: [],
      summary: { total: 0, ready: 0, missing: 0, disabled: 0, hostManaged: 0 },
    });
    mocks.setupServices.mockResolvedValue({
      status: 'ok',
      rows: [],
      summary: { total: 0, ready: 0, authMissing: 0, connectionMissing: 0, customerConnections: 0, personalConnections: 0 },
    });
    mocks.runReasoningSetup.mockResolvedValue({ must: 0, should: 1, nice: 2 });
    mocks.collectDoctorReport.mockResolvedValue({
      totalMissing: 3,
      summaries: [
        {
          manifestId: 'kyberion-runtime-baseline',
          lines: ['baseline line'],
          counts: { must: 1, should: 1, nice: 0 },
        },
      ],
    });

    const { runSetupReport } = await import('../scripts/setup_report.js');
    const report = await runSetupReport();

    expect(mocks.setupSurfaces).toHaveBeenCalledTimes(1);
    expect(mocks.setupServices).toHaveBeenCalledTimes(1);
    expect(mocks.runReasoningSetup).toHaveBeenCalledTimes(1);
    expect(mocks.collectDoctorReport).toHaveBeenCalledTimes(1);
    expect(report.reasoning).toEqual({ must: 0, should: 1, nice: 2 });
    expect(report.doctor.totalMissing).toBe(3);
    expect(report.services.summary.authMissing).toBe(0);
  });
});
