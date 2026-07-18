import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  listEnvironmentManifestIds: vi.fn(),
  loadEnvironmentManifest: vi.fn(),
  probeManifest: vi.fn(),
  createStandardYargs: vi.fn(),
}));

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    listEnvironmentManifestIds: mocks.listEnvironmentManifestIds,
    loadEnvironmentManifest: mocks.loadEnvironmentManifest,
    probeManifest: mocks.probeManifest,
  };
});

vi.mock('@agent/core/cli-utils', () => ({
  createStandardYargs: mocks.createStandardYargs,
}));

describe('run_doctor', () => {
  const exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation(((code?: number) => undefined as never) as any);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy.mockImplementation(((code?: number) => undefined as never) as any);
    const yargsStub = {
      option: vi.fn(() => yargsStub),
      parseSync: vi.fn(() => ({})),
    };
    mocks.createStandardYargs.mockReturnValue(yargsStub);
    mocks.loadEnvironmentManifest.mockImplementation((id: string) => {
      if (id === 'reasoning-backend') {
        return {
          manifest_id: 'reasoning-backend',
          version: '2026-04-29',
          capabilities: [
            {
              capability_id: 'reasoning-backend.preference',
              optional: true,
              required_for: ['wisdom-actuator'],
              install: { instruction: 'set backend' },
            },
          ],
        };
      }
      return {
        manifest_id: id,
        version: '2026-04-29',
        capabilities: [],
      };
    });
    mocks.probeManifest.mockImplementation(async (manifest: any) => {
      if (manifest.manifest_id === 'reasoning-backend') {
        return [
          { capability_id: 'reasoning-backend.preference', satisfied: false, reason: 'unset' },
        ];
      }
      return [];
    });
    mocks.listEnvironmentManifestIds.mockReturnValue([
      'kyberion-runtime-baseline',
      'reasoning-backend',
    ]);
  });

  afterEach(() => {
    exitSpy.mockReset();
    logSpy.mockReset();
    errorSpy.mockReset();
  });

  it('includes reasoning backend in the default doctor run without failing on nice-level preferences', async () => {
    const { runDoctor } = await import('./run_doctor.js');

    await runDoctor();

    expect(mocks.loadEnvironmentManifest).toHaveBeenCalledWith('kyberion-runtime-baseline');
    expect(mocks.loadEnvironmentManifest).toHaveBeenCalledWith('reasoning-backend');
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('reasoning-backend'));
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('pnpm setup:report --persona first-time-user')
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Maintenance: janitor'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Governance controls:'));
  });

  it('expands the meeting runtime preset to the meeting participation manifest', async () => {
    const { collectDoctorReport } = await import('./run_doctor.js');

    await collectDoctorReport({ runtime: 'meeting', mission: 'MSN-DOCTOR-RUNTIME' });

    expect(mocks.loadEnvironmentManifest).toHaveBeenCalledWith('meeting-participation-runtime');
    expect(mocks.loadEnvironmentManifest).not.toHaveBeenCalledWith('kyberion-runtime-baseline');
  });

  it('uses the same browser-capability manifest for browser runtime preflight', async () => {
    const { collectDoctorReport } = await import('./run_doctor.js');

    await collectDoctorReport({ runtime: 'browser' });

    expect(mocks.loadEnvironmentManifest).toHaveBeenCalledWith('meeting-participation-runtime');
  });

  it('reports surface outbox and dead-letter state in the doctor report', async () => {
    const { collectDoctorReport } = await import('./run_doctor.js');

    const report = await collectDoctorReport({});

    expect(report.surfaceDeliveryLines[0]).toContain('Surface delivery:');
  });

  it('includes the on-demand pull resolver for browser runtime doctor output', async () => {
    const yargsStub = {
      option: vi.fn(() => yargsStub),
      parseSync: vi.fn(() => ({ runtime: 'browser' })),
    };
    mocks.createStandardYargs.mockReturnValue(yargsStub);
    mocks.loadEnvironmentManifest.mockReturnValue({
      manifest_id: 'meeting-participation-runtime',
      version: '2026-04-29',
      capabilities: [
        {
          capability_id: 'browser-meeting-join-driver',
          optional: false,
          required_for: ['browser-meeting-join-driver'],
          install: { instruction: 'Install Playwright' },
        },
      ],
    });
    mocks.probeManifest.mockResolvedValue([
      { capability_id: 'browser-meeting-join-driver', satisfied: false, reason: 'missing' },
    ]);

    const { runDoctor } = await import('./run_doctor.js');

    await runDoctor();

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('pnpm deps:check --actuator browser')
    );
  });

  it('prints a runnable next action when required doctor capabilities are missing', async () => {
    const yargsStub = {
      option: vi.fn(() => yargsStub),
      parseSync: vi.fn(() => ({ runtime: 'meeting' })),
    };
    mocks.createStandardYargs.mockReturnValue(yargsStub);
    mocks.loadEnvironmentManifest.mockReturnValue({
      manifest_id: 'meeting-participation-runtime',
      version: '2026-04-29',
      capabilities: [
        {
          capability_id: 'browser-meeting-join-driver',
          optional: false,
          required_for: ['browser-meeting-join-driver'],
          install: { instruction: 'Install Playwright' },
        },
      ],
    });
    mocks.probeManifest.mockResolvedValue([
      { capability_id: 'browser-meeting-join-driver', satisfied: false, reason: 'missing' },
    ]);

    const { runDoctor } = await import('./run_doctor.js');

    await runDoctor();

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Next Action: Bootstrap meeting-participation-runtime')
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('pnpm env:bootstrap --manifest meeting-participation-runtime --apply')
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('pnpm setup:report --persona first-time-user')
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('routes missing reasoning backend setup to reasoning:setup instead of env bootstrap', async () => {
    mocks.loadEnvironmentManifest.mockReturnValue({
      manifest_id: 'reasoning-backend',
      version: '2026-04-29',
      capabilities: [
        {
          capability_id: 'reasoning-backend.any-real',
          optional: false,
          required_for: ['wisdom-actuator', 'intent-extractor'],
          install: { instruction: 'Configure a real backend' },
        },
      ],
    });
    mocks.probeManifest.mockResolvedValue([
      {
        capability_id: 'reasoning-backend.any-real',
        satisfied: false,
        reason: 'no real backend',
      },
    ]);

    const { runDoctor } = await import('./run_doctor.js');

    await runDoctor();

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Next step: run `pnpm reasoning:setup`')
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Next Action: Configure reasoning backend')
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('pnpm reasoning:setup'));
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('pnpm env:bootstrap --manifest reasoning-backend --apply')
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
