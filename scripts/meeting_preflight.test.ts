import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collectDoctorReport: vi.fn(),
  loadEnvironmentManifest: vi.fn(),
  probeManifest: vi.fn(),
  safeExecResult: vi.fn(),
  safeExistsSync: vi.fn(),
  safeReaddir: vi.fn(),
  listToolRuntimeInventory: vi.fn(),
  checkSpeakConsent: vi.fn(),
  createStandardYargs: vi.fn(),
}));

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    loadEnvironmentManifest: mocks.loadEnvironmentManifest,
    probeManifest: mocks.probeManifest,
    safeExecResult: mocks.safeExecResult,
    safeExistsSync: mocks.safeExistsSync,
    safeReaddir: mocks.safeReaddir,
    listToolRuntimeInventory: mocks.listToolRuntimeInventory,
  };
});

vi.mock('@agent/core/cli-utils', () => ({
  createStandardYargs: mocks.createStandardYargs,
}));

vi.mock('./run_doctor.js', () => ({
  collectDoctorReport: mocks.collectDoctorReport,
}));

vi.mock('../libs/actuators/meeting-actuator/src/meeting-actuator-helpers.js', () => ({
  checkSpeakConsent: mocks.checkSpeakConsent,
}));

describe('meeting_preflight', () => {
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
      parseSync: vi.fn(() => ({ mission: 'MSN-MEETING-TEST', json: false })),
    };
    mocks.createStandardYargs.mockReturnValue(yargsStub);
    mocks.collectDoctorReport.mockResolvedValue({
      summaries: [
        {
          manifestId: 'meeting-participation-runtime',
          counts: { must: 0, should: 0, nice: 0 },
          lines: [],
        },
      ],
      totalMissing: 0,
      scheduleLines: [],
      maintenanceLines: [],
      governanceLines: [],
      backupLines: [],
      meshDeliveryLines: [],
    });
    mocks.loadEnvironmentManifest.mockImplementation((manifestId: string) => ({
      manifest_id: manifestId,
      version: 'test',
      capabilities: [],
    }));
    mocks.probeManifest.mockImplementation(async (manifest: any) => {
      if (manifest.manifest_id === 'kyberion-toolchain') {
        return [{ capability_id: 'playwright-chromium', satisfied: true }];
      }
      if (manifest.manifest_id === 'reasoning-backend') {
        return [{ capability_id: 'reasoning-backend.any-real', satisfied: true }];
      }
      return [];
    });
    mocks.safeExecResult.mockReturnValue({
      status: 0,
      stdout: 'Audio Devices:\n  BlackHole 2ch',
      stderr: '',
    });
    mocks.safeExistsSync.mockImplementation(
      (candidate: string) =>
        candidate.includes('/active/shared/runtime/voice-profiles') ||
        candidate.includes('/active/shared/runtime/tool-runtimes/mlx-audio/bin/python') ||
        candidate.includes('/active/shared/runtime/tool-runtimes/mlx-audio/bin/python3') ||
        candidate.includes('/active/shared/runtime/voice-profiles/alpha/metadata.json')
    );
    mocks.safeReaddir.mockReturnValue(['alpha', 'README.md']);
    mocks.listToolRuntimeInventory.mockReturnValue({
      version: 'test',
      platform: 'darwin',
      requested_mode: 'trial',
      default_tool_id: 'mlx_audio',
      items: [
        {
          tool: { tool_id: 'mlx_audio' },
          install_backend: { command: 'uv', args: ['pip', 'install', 'mlx-audio'] },
        },
      ],
    });
    mocks.checkSpeakConsent.mockReturnValue({ allowed: true });
    delete process.env.MISSION_ID;
  });

  afterEach(() => {
    exitSpy.mockReset();
    logSpy.mockReset();
    errorSpy.mockReset();
    delete process.env.MISSION_ID;
  });

  it('passes when the meeting runtime, browser cache, audio device, voice profile, consent, and reasoning backend are ready', async () => {
    const { runMeetingPreflight } = await import('./meeting_preflight.js');

    const report = await runMeetingPreflight({ missionId: 'MSN-MEETING-TEST', platform: 'darwin' });

    expect(report.ready).toBe(true);
    expect(report.items.map((item) => [item.id, item.status])).toEqual([
      ['doctor.meeting', 'pass'],
      ['playwright.browser', 'pass'],
      ['blackhole.device', 'pass'],
      ['mlx.audio.runtime', 'pass'],
      ['voice.profile', 'pass'],
      ['voice.consent', 'pass'],
      ['reasoning.backend', 'pass'],
    ]);
  });

  it('prints remediation fixes and exits non-zero when the checks fail', async () => {
    mocks.collectDoctorReport.mockResolvedValueOnce({
      summaries: [
        {
          manifestId: 'meeting-participation-runtime',
          counts: { must: 1, should: 0, nice: 0 },
          lines: [],
        },
      ],
      totalMissing: 1,
      scheduleLines: [],
      maintenanceLines: [],
      governanceLines: [],
      backupLines: [],
      meshDeliveryLines: [],
    });
    mocks.probeManifest.mockImplementation(async (manifest: any) => {
      if (manifest.manifest_id === 'kyberion-toolchain') {
        return [
          {
            capability_id: 'playwright-chromium',
            satisfied: false,
            reason: 'missing chromium cache',
          },
        ];
      }
      if (manifest.manifest_id === 'reasoning-backend') {
        return [
          {
            capability_id: 'reasoning-backend.any-real',
            satisfied: false,
            reason: 'no real backend',
          },
        ];
      }
      return [];
    });
    mocks.safeExecResult.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'BlackHole not found',
    });
    mocks.safeExistsSync.mockImplementation((candidate: string) =>
      candidate.includes('/does-not-exist/')
    );
    mocks.safeReaddir.mockReturnValue([]);
    mocks.checkSpeakConsent.mockReturnValue({ allowed: false, reason: 'voice consent missing' });
    const yargsStub = {
      option: vi.fn(() => yargsStub),
      parseSync: vi.fn(() => ({ mission: 'MSN-MEETING-TEST', json: false })),
    };
    mocks.createStandardYargs.mockReturnValue(yargsStub);

    const { main } = await import('./meeting_preflight.js');

    await main();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('[meeting-preflight] doctor.meeting: fail')
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('pnpm env:bootstrap --manifest meeting-participation-runtime --apply')
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('pnpm exec playwright install chromium')
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('brew install blackhole-2ch'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('uv pip install mlx-audio'));
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Run Task 2: pnpm pipeline --input pipelines/voice-onboarding.json')
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'pnpm meeting:consent grant --mission <MISSION_ID> --operator <handle>'
      )
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('pnpm reasoning:setup'));
  });

  it('warns instead of failing on non-darwin hosts for BlackHole', async () => {
    const { runMeetingPreflight } = await import('./meeting_preflight.js');

    const report = await runMeetingPreflight({ missionId: 'MSN-MEETING-TEST', platform: 'linux' });

    const blackhole = report.items.find((item) => item.id === 'blackhole.device');
    expect(blackhole?.status).toBe('warn');
    expect(blackhole?.detail).toContain('skipped on linux');
  });
});
