import { describe, expect, it, vi } from 'vitest';
const effects = vi.hoisted(() => ({ run: vi.fn(), exec: vi.fn(), write: vi.fn() }));
vi.mock('./system-pr-lifecycle.js', () => ({ runStandardPrLifecycle: effects.run }));
vi.mock('@agent/core/secure-io', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  safeExecResult: effects.exec,
  safeWriteFile: effects.write,
}));
import { opCapture, opProcedure } from './system-pipeline-core-helpers.js';
import { SYSTEM_ACTUATOR_CAPTURE_OPS, SYSTEM_ACTUATOR_APPLY_OPS } from './op-catalog.js';
describe('typed procedure authority', () => {
  it('classifies procedures with configurable execution as apply and rejects capture routing', async () => {
    for (const op of ['standard_pr_lifecycle', 'provider_preflight']) {
      expect([...SYSTEM_ACTUATOR_CAPTURE_OPS]).not.toContain(op);
      expect([...SYSTEM_ACTUATOR_APPLY_OPS]).toContain(op);
      await expect(opCapture(op, {}, {}, (v) => v)).rejects.toThrow('require apply routing');
    }
    expect(effects.run).not.toHaveBeenCalled();
    expect(effects.exec).not.toHaveBeenCalled();
  });
  it('stops missing required narrated tools before returning context or writing artifacts', async () => {
    for (const missing of ['ffmpeg', 'ffprobe']) {
      effects.exec.mockImplementation((command: string) => ({
        stdout: '',
        stderr: '',
        status: command === missing ? 127 : 0,
      }));
      await expect(opCapture('narrated_report_preflight', {}, {}, (v) => v)).rejects.toThrow(
        missing + ' is unavailable'
      );
      expect(effects.write).not.toHaveBeenCalled();
    }
    effects.exec.mockClear();
  });
  it('rejects procedure execution when unsafe shell authority is absent', async () => {
    // The gate snapshots the environment at module construction; test runs without opt-in.
    expect(process.env.KYBERION_ALLOW_UNSAFE_SHELL).not.toBe('true');
    await expect(
      opProcedure(
        'standard_pr_lifecycle',
        {
          branch_name: 'feature/test',
          commit_message: 'feat: test',
          pr_title: 'feat: test',
          pr_body: 'test',
        },
        {},
        (v) => v
      )
    ).rejects.toThrow();
    await expect(
      opProcedure(
        'provider_preflight',
        { providers: [{ name: 'cli', command: 'cli' }] },
        {},
        (v) => v
      )
    ).rejects.toThrow();
    expect(effects.run).not.toHaveBeenCalled();
    expect(effects.exec).not.toHaveBeenCalled();
  });
});
