import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import {
  GENERATION_SCHEDULE_DIR,
  GENERATION_SCHEDULER_AUTHORITY,
  claimGenerationScheduleRun,
  completeGenerationScheduleRun,
  generationSchedulePath,
  isGenerationScheduleDue,
  readGenerationSchedule,
  runGenerationScheduleAction,
  writeGenerationSchedule,
} from './generation-scheduler.js';
import { createTriggerRunner } from './trigger-runner.js';

/**
 * EV-01: the tick logic existed twice — here and in
 * `scripts/run_generation_schedule.ts` — and the script's copy was the one the
 * daemon ran. These cover the single surviving implementation: the trigger gate
 * (no double submission), the run lock, and cron catch-up.
 *
 * The actuator is injected because the production path resolves it through a
 * dynamic file URL into dist/, which a test cannot intercept.
 */
describe('generation schedule tick (EV-01)', () => {
  const scheduleId = 'ev01-test-schedule';
  const triggerStore = `active/shared/tmp/generation-tick-test/${randomUUID().slice(0, 8)}.jsonl`;
  let previousRole: string | undefined;

  const baseSchedule = () => ({
    schedule_id: scheduleId,
    enabled: true,
    trigger: { type: 'interval' as const, interval_ms: 1000 },
    job_template: { action: 'generate_music', params: { seed: 1 } },
    execution_policy: { concurrency: 'skip_if_running' as const },
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  });

  beforeEach(() => {
    previousRole = process.env.MISSION_ROLE;
    // The trigger gate binds the authority snapshot to the active role.
    process.env.MISSION_ROLE = GENERATION_SCHEDULER_AUTHORITY.authority_role;
    safeMkdir(GENERATION_SCHEDULE_DIR, { recursive: true });
    writeGenerationSchedule(baseSchedule() as any);
  });

  afterEach(() => {
    if (previousRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = previousRole;
    const file = generationSchedulePath(scheduleId);
    if (safeExistsSync(file)) safeRmSync(pathResolver.rootResolve(file), { force: true });
    safeRmSync(pathResolver.sharedTmp('generation-tick-test'), { recursive: true, force: true });
  });

  // A lease name unique to this test run: the production lease is global and
  // deliberately non-blocking, so sharing it with parallel test files (or a
  // stale lock) would make every assertion that needs to win it flaky.
  const leaderId = `generation-tick-test-${randomUUID().slice(0, 8)}`;

  const tick = (handleAction: any, now = new Date('2026-08-10T03:00:00.000Z')) =>
    runGenerationScheduleAction({
      action: 'tick',
      schedule: scheduleId,
      deps: {
        handleAction,
        now,
        leaderId,
        runner: createTriggerRunner({ storePath: triggerStore }),
      },
    });

  it('due な schedule を submit し、trigger delivery id を返す', async () => {
    const handleAction = vi.fn().mockResolvedValue({
      job_id: 'genjob-1',
      provider: { prompt_id: 'prompt-1' },
    });

    const result = (await tick(handleAction)) as { results: Record<string, unknown>[] };

    expect(handleAction).toHaveBeenCalledWith({
      action: 'submit_generation',
      params: { action: 'generate_music', params: { seed: 1 }, retry_policy: undefined },
    });
    expect(result.results[0]).toMatchObject({
      schedule_id: scheduleId,
      status: 'submitted',
      job_id: 'genjob-1',
      provider_prompt_id: 'prompt-1',
    });
    expect(result.results[0].trigger_delivery_id).toBeTruthy();
  });

  it('同一分の二度目の tick は submit を繰り返さない（冪等キー）', async () => {
    const handleAction = vi.fn().mockResolvedValue({ job_id: 'genjob-1' });
    const now = new Date('2026-08-10T03:00:00.000Z');

    await tick(handleAction, now);
    const second = (await tick(handleAction, now)) as { results: Record<string, unknown>[] };

    // One submission total: the second firing is a duplicate delivery.
    expect(handleAction.mock.calls.filter((c) => c[0].action === 'submit_generation')).toHaveLength(
      1
    );
    expect(second.results[0]).toMatchObject({ status: 'skipped' });
  });

  it('同一冪等キーの再配信は delivery を再実行しない', async () => {
    // The leader-lease-independent half of the guarantee, asserted directly on
    // the gate: this is what makes two daemons safe, not the tick's bookkeeping.
    const runner = createTriggerRunner({ storePath: triggerStore });
    const deliver = vi.fn().mockResolvedValue('done');
    const request = {
      idempotencyKey: 'gen:ev01-test-schedule:2026-08-10T03:00',
      source: 'cron' as const,
      createdBy: { ...GENERATION_SCHEDULER_AUTHORITY },
    };

    const first = await runner.run(request, deliver);
    const second = await runner.run(request, deliver);

    expect(first.status).toBe('delivered');
    expect(second.status).toBe('duplicate');
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('submit 失敗時は run lock を解放し failed を報告する', async () => {
    const handleAction = vi.fn().mockResolvedValue({/* no job_id */});

    const result = (await tick(handleAction)) as { results: Record<string, unknown>[] };

    expect(result.results[0]).toMatchObject({ schedule_id: scheduleId, status: 'failed' });
    // A lock left behind would block the schedule for the whole lease window.
    expect(
      (readGenerationSchedule(generationSchedulePath(scheduleId)) as any).run_lock
    ).toBeFalsy();
  });

  describe('run lock', () => {
    it('claim 中の schedule は due と判定されない', () => {
      const now = new Date('2026-08-10T03:00:00.000Z');
      const claimed = claimGenerationScheduleRun(scheduleId, now);
      expect(claimed?.run_lock?.token).toBeTruthy();

      const reloaded = readGenerationSchedule(generationSchedulePath(scheduleId));
      expect(isGenerationScheduleDue(reloaded, now)).toBe(false);
    });

    it('二重 claim はできない', () => {
      const now = new Date('2026-08-10T03:00:00.000Z');
      expect(claimGenerationScheduleRun(scheduleId, now)).not.toBeNull();
      expect(claimGenerationScheduleRun(scheduleId, now)).toBeNull();
    });

    it('別トークンでは解放できない', () => {
      const now = new Date('2026-08-10T03:00:00.000Z');
      claimGenerationScheduleRun(scheduleId, now);
      expect(completeGenerationScheduleRun(scheduleId, 'wrong-token', 'submitted', now)).toBeNull();
    });

    it('期限切れリースは再取得できる', () => {
      const acquired = new Date('2026-08-10T03:00:00.000Z');
      claimGenerationScheduleRun(scheduleId, acquired);
      // Past the 15-minute lease: a crashed run must not block forever.
      const later = new Date('2026-08-10T03:30:00.000Z');
      expect(claimGenerationScheduleRun(scheduleId, later)).not.toBeNull();
    });
  });

  describe('cron catch-up', () => {
    it('停止中に過ぎた cron 発火を回収する', () => {
      writeGenerationSchedule({
        ...(baseSchedule() as any),
        trigger: { type: 'cron', cron: '0 3 * * *' },
        last_submitted_at: '2026-08-09T03:00:00.000Z',
      });
      const schedule = readGenerationSchedule(generationSchedulePath(scheduleId));

      // 09:00, so the minute does not match — the previous implementation
      // returned false here and the 03:00 firing was lost for good.
      expect(isGenerationScheduleDue(schedule, new Date('2026-08-10T09:00:00.000Z'))).toBe(true);
    });

    it('同一分の再発火は抑止される', () => {
      writeGenerationSchedule({
        ...(baseSchedule() as any),
        trigger: { type: 'cron', cron: '0 3 * * *' },
        last_submitted_at: '2026-08-10T03:00:00.000Z',
      });
      const schedule = readGenerationSchedule(generationSchedulePath(scheduleId));
      expect(isGenerationScheduleDue(schedule, new Date('2026-08-10T03:00:30.000Z'))).toBe(false);
    });

    it('disabled な schedule は due にならない', () => {
      writeGenerationSchedule({ ...(baseSchedule() as any), enabled: false });
      const schedule = readGenerationSchedule(generationSchedulePath(scheduleId));
      expect(isGenerationScheduleDue(schedule, new Date('2026-08-10T03:00:00.000Z'))).toBe(false);
    });
  });

  it('依存が未達なら submit せず skipped を返す', async () => {
    const dependencyId = 'ev01-dependency';
    safeWriteFile(
      generationSchedulePath(dependencyId),
      JSON.stringify({ schedule_id: dependencyId, last_job_status: 'running' }, null, 2)
    );
    writeGenerationSchedule({
      ...(baseSchedule() as any),
      execution_policy: { depends_on: [dependencyId] },
    });
    const handleAction = vi.fn();

    try {
      const result = (await tick(handleAction)) as { results: Record<string, unknown>[] };
      expect(result.results[0]).toMatchObject({
        status: 'skipped',
        reason: 'dependencies are not yet satisfied',
      });
      expect(handleAction).not.toHaveBeenCalled();
    } finally {
      safeRmSync(pathResolver.rootResolve(generationSchedulePath(dependencyId)), { force: true });
    }
  });

  it('前ジョブが running なら skip_if_running で submit しない', async () => {
    writeGenerationSchedule({
      ...(baseSchedule() as any),
      last_job_id: 'genjob-prev',
      last_job_status: 'running',
    });
    const handleAction = vi.fn().mockResolvedValue({ status: 'running' });

    const result = (await tick(handleAction)) as { results: Record<string, unknown>[] };

    expect(result.results[0]).toMatchObject({
      status: 'skipped',
      reason: 'previous job is still running',
    });
    expect(handleAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'submit_generation' })
    );
  });

  it('成功ジョブを reconcile して latest alias を更新する', async () => {
    const exportDir = pathResolver.sharedTmp('generation-tick-test/exports');
    safeMkdir(exportDir, { recursive: true });
    const produced = path.join(exportDir, 'song.mp3');
    const alias = 'active/shared/tmp/generation-tick-test/exports/latest.mp3';
    safeWriteFile(produced, 'audio');

    writeGenerationSchedule({
      ...(baseSchedule() as any),
      trigger: { type: 'cron', cron: '0 3 * * *' },
      last_submitted_at: '2026-08-10T03:00:00.000Z',
      delivery_policy: { latest_alias_path: alias },
      last_job_id: 'genjob-prev',
      last_job_status: 'submitted',
    });

    const handleAction = vi.fn().mockResolvedValue({
      status: 'succeeded',
      completed_at: '2026-08-10T03:10:00.000Z',
      request: { target_path: produced },
    });

    const result = (await tick(handleAction, new Date('2026-08-10T03:00:30.000Z'))) as {
      results: Record<string, unknown>[];
    };

    expect(result.results[0]).toMatchObject({
      status: 'skipped',
      reason: 'schedule is not due',
      reconciliation: expect.objectContaining({ alias_updated: true }),
    });
    expect(safeExistsSync(pathResolver.rootResolve(alias))).toBe(true);
  });
});
