import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadEnvironmentManifest: vi.fn(),
  probeManifest: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warn: vi.fn() },
}));

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual as any,
    loadEnvironmentManifest: mocks.loadEnvironmentManifest,
    probeManifest: mocks.probeManifest,
    logger: mocks.logger,
  };
});

describe('reasoning_setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports reasoning backend readiness without failing on nice-level preferences', async () => {
    const { runReasoningSetup } = await import('../scripts/reasoning_setup');

    mocks.loadEnvironmentManifest.mockReturnValue({
      manifest_id: 'reasoning-backend',
      version: '2026-04-29',
      capabilities: [
        {
          capability_id: 'reasoning-backend.any-real',
          optional: false,
        },
        {
          capability_id: 'reasoning-backend.preference',
          optional: true,
        },
      ],
    });
    mocks.probeManifest.mockResolvedValue([
      { capability_id: 'reasoning-backend.any-real', satisfied: true },
      { capability_id: 'reasoning-backend.preference', satisfied: false, reason: 'unset' },
    ]);

    const counts = await runReasoningSetup();

    expect(counts).toEqual({ must: 0, should: 0, nice: 1 });
    expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining('reasoning-backend'));
  });
});
