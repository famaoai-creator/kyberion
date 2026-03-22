import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExistsSync: vi.fn(),
  safeCopyFileSync: vi.fn(),
  safeMkdir: vi.fn(),
  buildExecutionEnv: vi.fn(() => ({})),
  withExecutionContext: vi.fn(async (_role: string, fn: () => Promise<unknown>) => fn()),
  listGenerationSchedules: vi.fn(),
  registerGenerationSchedule: vi.fn(),
  readGenerationSchedule: vi.fn(),
  markGenerationScheduleSubmitted: vi.fn((schedule: any, jobId: string) => ({ ...schedule, last_job_id: jobId })),
  markGenerationScheduleReconciled: vi.fn((schedule: any, updates: Record<string, unknown>) => ({ ...schedule, ...updates })),
  isGenerationScheduleDue: vi.fn(),
  handleMediaGenerationAction: vi.fn(),
}));

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual('@agent/core') as any;
  return {
    ...actual,
    safeExistsSync: mocks.safeExistsSync,
    safeCopyFileSync: mocks.safeCopyFileSync,
    safeMkdir: mocks.safeMkdir,
    buildExecutionEnv: mocks.buildExecutionEnv,
    withExecutionContext: mocks.withExecutionContext,
    listGenerationSchedules: mocks.listGenerationSchedules,
    registerGenerationSchedule: mocks.registerGenerationSchedule,
    readGenerationSchedule: mocks.readGenerationSchedule,
    markGenerationScheduleSubmitted: mocks.markGenerationScheduleSubmitted,
    markGenerationScheduleReconciled: mocks.markGenerationScheduleReconciled,
    isGenerationScheduleDue: mocks.isGenerationScheduleDue,
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('../libs/actuators/media-generation-actuator/src/index.js', () => ({
  handleAction: mocks.handleMediaGenerationAction,
}));

describe('run_generation_schedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.safeExistsSync.mockReturnValue(true);
  });

  it('registers a schedule from an input path', async () => {
    mocks.registerGenerationSchedule.mockReturnValue({ schedule_id: 'demo' });

    const { runGenerationScheduleAction } = await import('./run_generation_schedule.js');
    const result = await runGenerationScheduleAction({
      action: 'register',
      input: 'libs/actuators/media-generation-actuator/examples/music-generation-schedule-anniversary.json',
    });

    expect(mocks.registerGenerationSchedule).toHaveBeenCalled();
    expect(result).toEqual({ schedule_id: 'demo' });
  });

  it('skips a due schedule until dependencies have succeeded', async () => {
    const schedule = {
      schedule_id: 'video-after-music',
      enabled: true,
      trigger: { type: 'interval', interval_ms: 1000 },
      job_template: { action: 'generate_video', params: {} },
      execution_policy: { depends_on: ['music-seed'] },
      last_job_id: null,
    };
    mocks.listGenerationSchedules.mockReturnValue([schedule]);
    mocks.readGenerationSchedule.mockReturnValue({ schedule_id: 'music-seed', last_job_status: 'running' });
    mocks.isGenerationScheduleDue.mockReturnValue(true);

    const { runGenerationScheduleAction } = await import('./run_generation_schedule.js');
    const result = await runGenerationScheduleAction({ action: 'tick' });

    expect(result).toEqual({
      status: 'completed',
      results: [
        expect.objectContaining({
          schedule_id: 'video-after-music',
          status: 'skipped',
          reason: 'dependencies are not yet satisfied',
        }),
      ],
    });
    expect(mocks.handleMediaGenerationAction).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'submit_generation',
    }));
  });

  it('reconciles a succeeded job and updates the latest alias before skipping as not due', async () => {
    const schedule = {
      schedule_id: 'music-monthly',
      enabled: true,
      trigger: { type: 'cron', cron: '0 7 1 * *', timezone: 'Asia/Tokyo' },
      job_template: { action: 'generate_music', params: {} },
      execution_policy: { concurrency: 'skip_if_running' },
      delivery_policy: { latest_alias_path: 'active/shared/exports/latest.mp3' },
      last_job_id: 'genjob-1',
      last_job_status: 'submitted',
    };
    mocks.listGenerationSchedules.mockReturnValue([schedule]);
    mocks.handleMediaGenerationAction.mockResolvedValueOnce({
      status: 'succeeded',
      completed_at: '2026-03-22T00:10:00.000Z',
      request: { target_path: 'active/shared/exports/song.mp3' },
    });
    mocks.isGenerationScheduleDue.mockReturnValue(false);

    const { runGenerationScheduleAction } = await import('./run_generation_schedule.js');
    const result = await runGenerationScheduleAction({ action: 'tick' });

    expect(mocks.safeCopyFileSync).toHaveBeenCalledWith(
      'active/shared/exports/song.mp3',
      'active/shared/exports/latest.mp3',
    );
    expect(result).toEqual({
      status: 'completed',
      results: [
        expect.objectContaining({
          schedule_id: 'music-monthly',
          status: 'skipped',
          reason: 'schedule is not due',
          reconciliation: expect.objectContaining({
            alias_updated: true,
            latest_alias_path: 'active/shared/exports/latest.mp3',
          }),
        }),
      ],
    });
  });

  it('submits a due schedule as a generation job', async () => {
    const schedule = {
      schedule_id: 'music-monthly',
      enabled: true,
      trigger: { type: 'interval', interval_ms: 1000 },
      job_template: {
        action: 'generate_music',
        params: { music_adf: { kind: 'music-generation-adf', version: '1.0.0' } },
      },
      execution_policy: { concurrency: 'skip_if_running', retry_policy: { max_attempts: 2, backoff_seconds: 30 } },
    };
    mocks.listGenerationSchedules.mockReturnValue([schedule]);
    mocks.isGenerationScheduleDue.mockReturnValue(true);
    mocks.handleMediaGenerationAction.mockResolvedValue({
      job_id: 'genjob-2',
      provider: { prompt_id: 'prompt-2' },
    });

    const { runGenerationScheduleAction } = await import('./run_generation_schedule.js');
    const result = await runGenerationScheduleAction({ action: 'tick' });

    expect(mocks.handleMediaGenerationAction).toHaveBeenCalledWith({
      action: 'submit_generation',
      params: {
        action: 'generate_music',
        params: { music_adf: { kind: 'music-generation-adf', version: '1.0.0' } },
        retry_policy: { max_attempts: 2, backoff_seconds: 30 },
      },
    });
    expect(mocks.markGenerationScheduleSubmitted).toHaveBeenCalledWith(schedule, 'genjob-2');
    expect(result).toEqual({
      status: 'completed',
      results: [
        expect.objectContaining({
          schedule_id: 'music-monthly',
          status: 'submitted',
          job_id: 'genjob-2',
          provider_prompt_id: 'prompt-2',
        }),
      ],
    });
  });
});
