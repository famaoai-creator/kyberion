import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setHudExecForTesting, resetHudExec, distScript } from './exec.js';
import { runPaletteCommand, PALETTE_USAGE } from './palette.js';

const incidentAck = vi.hoisted(() => vi.fn());
vi.mock('@agent/core/scheduler-incidents', async (original) => ({
  ...(await original<typeof import('@agent/core/scheduler-incidents')>()),
  acknowledgeSchedulerIncident: incidentAck,
}));

beforeAll(() => {
  process.env.KYBERION_TUI_DISABLE_AUDIT = '1';
});

afterEach(() => {
  resetHudExec();
});

describe('runPaletteCommand', () => {
  it('switches panels via :panel', async () => {
    const outcome = await runPaletteCommand(':panel tasks');
    expect(outcome.switchPanel).toBe('tasks');
    expect(outcome.result.ok).toBe(true);
  });

  it('hands connection management off to settings without running authentication', async () => {
    const exec = vi.fn();
    setHudExecForTesting(exec);
    expect((await runPaletteCommand(':connections')).switchPanel).toBe('settings');
    expect((await runPaletteCommand(':connections install')).result.ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('requires an observed episode and passes it to the governed acknowledgement facade', async () => {
    incidentAck.mockReset().mockReturnValue(true);
    const old = await runPaletteCommand(':incident ack job signature');
    expect(old.result.ok).toBe(false);
    expect(old.result.message).toContain('SCHEDULER_INCIDENT_EPISODE_REQUIRED');
    expect(incidentAck).not.toHaveBeenCalled();
    const episode = 'a'.repeat(32);
    const current = await runPaletteCommand(`:incident ack job signature ${episode}`);
    expect(incidentAck).toHaveBeenCalledWith('job', 'signature', episode);
    expect(current.result.ok).toBe(true);
    expect(current.switchPanel).toBe('schedules');
  });

  it('routes :mission verbs through the mission controller argv', async () => {
    let seen: string[] | undefined;
    setHudExecForTesting((_command, args) => {
      seen = args;
      return { ok: true, output: 'ok' };
    });
    const outcome = await runPaletteCommand(':mission pause MSN-1');
    expect(outcome.result.ok).toBe(true);
    expect(seen).toEqual([distScript('mission_controller.js'), 'pause', 'MSN-1']);
  });

  it('rejects unknown commands with the raw input as message', async () => {
    const outcome = await runPaletteCommand(':frobnicate everything');
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.message).toBe(':frobnicate everything');
  });

  it('rejects schedule registrations outside pipelines/', async () => {
    const outcome = await runPaletteCommand(':schedule add x scripts/evil.json 0 6 * * *');
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.message).toContain('pipelines/');
  });

  it('documents every command group in usage', () => {
    for (const group of ['panel', 'mission', 'task', 'schedule', 'surface']) {
      expect(PALETTE_USAGE.some((line) => line.startsWith(`:${group}`))).toBe(true);
    }
  });
});
