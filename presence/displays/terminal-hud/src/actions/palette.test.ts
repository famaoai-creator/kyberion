import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setHudExecForTesting, resetHudExec, distScript } from './exec.js';
import { runPaletteCommand, PALETTE_USAGE } from './palette.js';

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
