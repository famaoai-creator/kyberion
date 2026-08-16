import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * EV-01: this script used to carry a second copy of the whole tick pipeline
 * (reconcile → dependencies → due → submit), and because the daemon runs
 * `dist/scripts/run_generation_schedule.js --action tick`, that copy was the
 * code that actually fired — ungoverned, while the library gained the trigger
 * gate. The duplicate is gone.
 *
 * So the tick behaviour is no longer this file's to test; it lives in
 * `libs/core/generation-scheduler.tick.test.ts`. What remains here is the CLI's
 * own contract: `register` stays under surface_runtime, and `list`/`tick`
 * delegate to the governed implementation under the generation_scheduler role.
 */
const mocks = vi.hoisted(() => ({
  safeExistsSync: vi.fn(),
  buildExecutionEnv: vi.fn((env: NodeJS.ProcessEnv, role?: string) => ({
    ...env,
    MISSION_ROLE: role,
  })),
  withExecutionContext: vi.fn((_role: string, fn: () => unknown) => fn()),
  registerGenerationSchedule: vi.fn(),
  runGovernedGenerationScheduleAction: vi.fn(),
}));

vi.mock('@agent/core', async () => {
  const actual = (await vi.importActual('@agent/core')) as any;
  return {
    ...actual,
    safeExistsSync: mocks.safeExistsSync,
    registerGenerationSchedule: mocks.registerGenerationSchedule,
    runGenerationScheduleAction: mocks.runGovernedGenerationScheduleAction,
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('@agent/core/governance', async () => {
  const actual = (await vi.importActual('@agent/core/governance')) as any;
  return {
    ...actual,
    buildExecutionEnv: mocks.buildExecutionEnv,
    withExecutionContext: mocks.withExecutionContext,
  };
});

describe('run_generation_schedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.safeExistsSync.mockReturnValue(true);
  });

  it('registers a schedule from an input path under surface_runtime', async () => {
    mocks.registerGenerationSchedule.mockReturnValue({ schedule_id: 'demo' });

    const { runGenerationScheduleAction } = await import('./run_generation_schedule.js');
    const result = await runGenerationScheduleAction({
      action: 'register',
      input:
        'libs/actuators/media-generation-actuator/examples/music-generation-schedule-anniversary.json',
    });

    expect(mocks.registerGenerationSchedule).toHaveBeenCalled();
    expect(mocks.withExecutionContext).toHaveBeenCalledWith(
      'surface_runtime',
      expect.any(Function)
    );
    expect(result).toEqual({ schedule_id: 'demo' });
  });

  it('rejects register without an input path', async () => {
    const { runGenerationScheduleAction } = await import('./run_generation_schedule.js');
    await expect(runGenerationScheduleAction({ action: 'register' })).rejects.toThrow(
      /requires --input/
    );
  });

  it('delegates tick to the governed library implementation', async () => {
    mocks.runGovernedGenerationScheduleAction.mockResolvedValue({
      status: 'completed',
      results: [],
    });

    const { runGenerationScheduleAction } = await import('./run_generation_schedule.js');
    const result = await runGenerationScheduleAction({ action: 'tick', schedule: 'music-monthly' });

    expect(mocks.runGovernedGenerationScheduleAction).toHaveBeenCalledWith({
      action: 'tick',
      schedule: 'music-monthly',
    });
    expect(result).toEqual({ status: 'completed', results: [] });
  });

  it('seeds the generation_scheduler role before delegating', async () => {
    mocks.runGovernedGenerationScheduleAction.mockResolvedValue({
      status: 'completed',
      results: [],
    });

    const { runGenerationScheduleAction } = await import('./run_generation_schedule.js');
    await runGenerationScheduleAction({ action: 'tick' });

    // A child process spawned mid-tick must inherit the same authority.
    expect(mocks.buildExecutionEnv).toHaveBeenCalledWith(process.env, 'generation_scheduler');
  });

  it('delegates list as well', async () => {
    mocks.runGovernedGenerationScheduleAction.mockResolvedValue([]);

    const { runGenerationScheduleAction } = await import('./run_generation_schedule.js');
    await runGenerationScheduleAction({ action: 'list' });

    expect(mocks.runGovernedGenerationScheduleAction).toHaveBeenCalledWith({ action: 'list' });
  });

  it('forwards an explicit tenant scope for duplicate schedule IDs', async () => {
    mocks.runGovernedGenerationScheduleAction.mockResolvedValue([]);

    const { runGenerationScheduleAction } = await import('./run_generation_schedule.js');
    const scope = {
      scope_kind: 'tenant' as const,
      tier: 'confidential' as const,
      tenant_slug: 'tenant-a',
    };
    await runGenerationScheduleAction({ action: 'list', scope });

    expect(mocks.runGovernedGenerationScheduleAction).toHaveBeenCalledWith({
      action: 'list',
      scope,
    });
  });

  it('rejects an unsupported action', async () => {
    const { runGenerationScheduleAction } = await import('./run_generation_schedule.js');
    await expect(runGenerationScheduleAction({ action: 'nope' })).rejects.toThrow(
      /Unsupported action/
    );
  });
});
