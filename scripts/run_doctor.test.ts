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
    ...actual as any,
    listEnvironmentManifestIds: mocks.listEnvironmentManifestIds,
    loadEnvironmentManifest: mocks.loadEnvironmentManifest,
    probeManifest: mocks.probeManifest,
  };
});

vi.mock('@agent/core/cli-utils', () => ({
  createStandardYargs: mocks.createStandardYargs,
}));

describe('run_doctor', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => undefined as never) as any);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createStandardYargs.mockReturnValue({
      option: () => ({
        option: () => ({
          option: () => ({
            parseSync: () => ({}),
          }),
        }),
      }),
    });
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
    mocks.listEnvironmentManifestIds.mockReturnValue(['kyberion-runtime-baseline', 'reasoning-backend']);
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
  });
});
