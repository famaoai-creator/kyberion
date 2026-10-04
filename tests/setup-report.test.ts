import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setupSurfaces: vi.fn(),
  setupServices: vi.fn(),
  runReasoningSetup: vi.fn(),
  collectDoctorReport: vi.fn(),
  buildVitalReport: vi.fn(),
  probeSurfaceHealth: vi.fn(async () => ({ status: 'healthy', detail: 'http_200' })),
}));

vi.mock('@agent/core/surface/surface-runtime', () => ({
  loadSurfaceManifest: () => ({
    version: 1,
    surfaces: [
      ['concierge', 3038],
      ['chronos-mirror-v2', 3000],
      ['presence-studio', 3031],
      ['voice-hub', 3032],
      ['slack-bridge', 3033],
    ].map(([id, port]) => ({
      id,
      port,
      kind: 'ui',
      description: 'fixture',
      command: 'node',
      enabled: true,
    })),
  }),
  probeSurfaceHealth: mocks.probeSurfaceHealth,
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

vi.mock('../scripts/vital_check.js', () => ({
  buildVitalReport: mocks.buildVitalReport,
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
      summary: {
        total: 0,
        ready: 0,
        authMissing: 0,
        connectionMissing: 0,
        customerConnections: 0,
        personalConnections: 0,
      },
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

    mocks.buildVitalReport.mockReturnValue({ checks: [] });

    const { runSetupReport } = await import('../scripts/setup_report.js');
    const report = await runSetupReport();

    expect(mocks.setupSurfaces).toHaveBeenCalledTimes(1);
    expect(mocks.setupServices).toHaveBeenCalledTimes(1);
    expect(mocks.runReasoningSetup).toHaveBeenCalledWith({ quiet: false });
    expect(mocks.runReasoningSetup).toHaveBeenCalledTimes(1);
    expect(mocks.collectDoctorReport).toHaveBeenCalledTimes(1);
    expect(report.reasoning).toEqual({ must: 0, should: 1, nice: 2 });
    expect(report.doctor.totalMissing).toBe(3);
    expect(report.services.summary.authMissing).toBe(0);
    expect(report.recommendedSurfaces.map((surface) => surface.id)).toEqual([
      'concierge',
      'chronos',
      'voice-first-win',
      'messaging',
    ]);
  });

  it.each([undefined, false, true])('uses one first-use step (quiet=%s)', async (quiet) => {
    mocks.setupSurfaces.mockResolvedValue({
      status: 'ok',
      rows: [
        {
          surface: 'concierge',
          enabled: 'enabled',
          auth: 'n/a',
          strategy: 'host-managed',
          secrets: '',
          cli: '',
          hint: 'Managed UI fixture',
        },
        {
          surface: 'chronos-mirror-v2',
          enabled: 'enabled',
          auth: 'n/a',
          strategy: 'host-managed',
          secrets: '',
          cli: '',
          hint: 'Host-managed surface or no preset path.',
        },
        {
          surface: 'presence-studio',
          enabled: 'enabled',
          auth: 'n/a',
          strategy: 'host-managed',
          secrets: '',
          cli: '',
          hint: 'Host-managed surface or no preset path.',
        },
        {
          surface: 'voice-hub',
          enabled: 'enabled',
          auth: 'n/a',
          strategy: 'host-managed',
          secrets: '',
          cli: '',
          hint: 'Host-managed surface or no preset path.',
        },
        {
          surface: 'slack-bridge',
          enabled: 'enabled',
          auth: 'missing',
          strategy: 'bearer',
          secrets: 'SLACK_ACCESS_TOKEN',
          cli: '',
          hint: 'Set one of: SLACK_ACCESS_TOKEN',
        },
      ],
      summary: { total: 2, ready: 0, missing: 1, disabled: 1, hostManaged: 0 },
    });
    mocks.setupServices.mockResolvedValue({
      status: 'ok',
      rows: [],
      summary: {
        total: 2,
        ready: 0,
        authMissing: 1,
        connectionMissing: 1,
        customerConnections: 0,
        personalConnections: 0,
      },
    });
    mocks.runReasoningSetup.mockResolvedValue({ must: 1, should: 0, nice: 0 });
    mocks.collectDoctorReport.mockResolvedValue({
      totalMissing: 2,
      summaries: [
        {
          manifestId: 'kyberion-runtime-baseline',
          lines: ['baseline gap'],
          counts: { must: 1, should: 1, nice: 0 },
        },
      ],
    });

    mocks.buildVitalReport.mockReturnValue({
      checks: [
        { id: 'sovereign_identity', label: 'Sovereign identity', status: 'missing' },
        { id: 'agent_identity', label: 'Agent identity', status: 'missing' },
        { id: 'sovereign_vision', label: 'Sovereign vision', status: 'missing' },
        { id: 'onboarding_summary', label: 'Onboarding summary', status: 'missing' },
      ],
    });

    const { runSetupReportWithPersona } = await import('../scripts/setup_report.js');
    const report = await runSetupReportWithPersona({ persona: 'first-time-user', quiet });

    expect(mocks.setupSurfaces).toHaveBeenCalledWith({ quiet: true });
    expect(mocks.setupServices).toHaveBeenCalledWith({ quiet: true });
    expect(mocks.runReasoningSetup).toHaveBeenCalledWith({ quiet: true });
    expect(report.surfaces.summary.missing).toBe(1);
    expect(report.services.summary.authMissing).toBe(1);
    expect(report.doctor.totalMissing).toBe(2);
    expect(report.recommendedSurfaces.map((surface) => surface.id)).toEqual([
      'concierge',
      'chronos',
      'voice-first-win',
      'messaging',
    ]);
    expect(report.recommendedSurfaces[0]).toMatchObject({
      id: 'concierge',
      readiness: 'needs_setup',
      optional: false,
      suggestedCommand: 'pnpm onboarding',
    });
    expect(report.recommendedSurfaces[1]).toMatchObject({
      id: 'chronos',
      readiness: 'ready',
      openUrl: 'http://127.0.0.1:3000',
    });
    expect(report.recommendedSurfaces[2]).toMatchObject({
      id: 'voice-first-win',
      readiness: 'unverified',
      optional: true,
      suggestedCommand: 'pnpm kyberion doctor --runtime voice',
    });
    expect(report.recommendedSurfaces[3]).toMatchObject({
      id: 'messaging',
      readiness: 'needs_setup',
      optional: true,
      suggestedCommand: 'pnpm surfaces setup',
    });
    expect(mocks.probeSurfaceHealth).toHaveBeenCalledTimes(5);
    expect(report.surfaceHealth.concierge).toMatchObject({
      status: 'healthy',
      detail: 'http_200',
    });
    expect(report.nextActions).toEqual([
      expect.objectContaining({
        title: 'Complete identity and onboarding profile',
        suggested_command: 'pnpm onboarding',
      }),
    ]);
  });
});
