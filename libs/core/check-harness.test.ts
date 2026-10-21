import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineCheck } from './check-harness.js';
import { clearProcessExitCode, getProcessExitCode } from './script-harness.js';

afterEach(() => {
  clearProcessExitCode();
  vi.restoreAllMocks();
});

describe('canonical check contract', () => {
  it('returns one structured result and fails without an opt-in --fail flag', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const check = defineCheck({
      id: 'sample',
      collect: () => [{ code: 'BROKEN', message: 'fix it', path: 'a.ts', line: 2 }],
    });
    const result = await check(['--json']);
    expect(result).toEqual({
      ok: false,
      id: 'sample',
      findings: [{ code: 'BROKEN', message: 'fix it', path: 'a.ts', line: 2 }],
    });
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual(result);
    expect(output).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(getProcessExitCode()).toBe(1);
  });

  it('prints canonical success and handles help before collecting', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const collect = vi.fn(() => []);
    const check = defineCheck({ id: 'sample', collect });
    await check(['--help']);
    expect(collect).not.toHaveBeenCalled();
    await check([]);
    expect(output).toHaveBeenLastCalledWith('[check:sample] OK');
    expect(getProcessExitCode()).toBeUndefined();
  });

  it('rejects unknown options before collection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const collect = vi.fn(() => []);
    await defineCheck({ id: 'sample', collect })(['--fail']);
    expect(collect).not.toHaveBeenCalled();
    expect(getProcessExitCode()).toBe(2);
  });

  it('normalizes declared value options through the command guard', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const collect = vi.fn(() => []);
    const check = defineCheck({
      id: 'metric',
      options: [{ flag: '--metric', value: '<name>' }],
      collect,
    });
    await check(['--metric=parser', '--json']);
    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ '--metric': 'parser' }),
        json: true,
      })
    );
    expect(getProcessExitCode()).toBeUndefined();
  });
});
