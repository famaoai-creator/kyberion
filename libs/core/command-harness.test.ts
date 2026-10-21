import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineCommand } from './command-harness.js';
import { clearProcessExitCode, getProcessExitCode } from './script-harness.js';

afterEach(() => {
  clearProcessExitCode();
  vi.restoreAllMocks();
});

describe('command harness', () => {
  it('uses shared value normalization and serializes once', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const command = defineCommand({
      name: 'sample',
      positionals: '<file>',
      options: [{ flag: '--target', value: '<id>', required: true }],
      run(context) {
        const value = { target: context.options['--target'], files: context.positionals };
        context.print(value);
        return value;
      },
    });
    expect(await command(['--json', '--target=alpha', 'a.txt'])).toEqual({
      target: 'alpha',
      files: ['a.txt'],
    });
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
      target: 'alpha',
      files: ['a.txt'],
    });
  });

  it('handles missing required values, unknown options and help before effects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = vi.fn();
    const command = defineCommand({
      name: 'sample',
      options: [{ flag: '--target', value: '<id>', required: true }],
      run,
    });
    await command(['--help']);
    expect(run).not.toHaveBeenCalled();
    await command([]);
    expect(getProcessExitCode()).toBe(2);
    await command(['--unknown']);
    expect(run).not.toHaveBeenCalled();
  });
});
