import { describe, expect, it } from 'vitest';
import { ScriptExitError } from './harness.js';
import {
  guardCliArgs,
  guardCliArgsNormalized,
  hasHelpFlag,
  normalizeInlineValueFlags,
  type CliGuardSpec,
} from './cli-guard.js';

const spec: CliGuardSpec = {
  command: 'pnpm kyberion demo run',
  options: [{ flag: '--title', value: '<title>' }, { flag: '--force' }],
  subcommands: ['inspect'],
};

function rejection(argv: string[]): ScriptExitError {
  try {
    guardCliArgs(argv, spec, () => undefined);
  } catch (error) {
    return error as ScriptExitError;
  }
  throw new Error('expected guardCliArgs to reject');
}

describe('CU-01 shared CLI guard', () => {
  it('prints usage and reports help for --help / -h anywhere before `--`', () => {
    for (const argv of [['--help'], ['-h'], ['--title', 'x', '--help'], ['--title', '--help']]) {
      const output: unknown[] = [];
      expect(guardCliArgs(argv, spec, (value) => output.push(value))).toBe(true);
      expect(String(output[0])).toContain('pnpm kyberion demo run');
      expect(String(output[0])).toContain('--title <title>');
    }
    expect(hasHelpFlag(['--', '--help'])).toBe(false);
  });

  it('accepts declared flags, inline values, and the separator', () => {
    expect(guardCliArgs(['--title', 'x', '--force', '--'], spec, () => undefined)).toBe(false);
    expect(guardCliArgs(['--title=x'], spec, () => undefined)).toBe(false);
  });

  it('rejects unknown flags, missing values, and stray positionals with exit 2', () => {
    for (const argv of [['--titel', 'x'], ['--title'], ['--title', '--force'], ['stray']]) {
      const error = rejection(argv);
      expect(error).toBeInstanceOf(ScriptExitError);
      expect(error.code).toBe(2);
      expect(error.message).toContain('pnpm kyberion demo run --help');
    }
  });

  it('leaves declared subcommands to their own parser', () => {
    expect(guardCliArgs(['inspect', '--anything'], spec, () => undefined)).toBe(false);
  });
});

describe('inline --flag=value normalization', () => {
  it('rewrites valued flags to the two-token form legacy parsers read', () => {
    expect(normalizeInlineValueFlags(['--title=a=b', '--force', 'x'], spec)).toEqual([
      '--title',
      'a=b',
      '--force',
      'x',
    ]);
  });

  it('leaves boolean flags, unknown flags and tokens after `--` alone', () => {
    expect(normalizeInlineValueFlags(['--force=1', '--', '--title=z'], spec)).toEqual([
      '--force=1',
      '--',
      '--title=z',
    ]);
  });

  it('guardCliArgsNormalized validates then returns the normalized argv', () => {
    expect(guardCliArgsNormalized(['--title=hi'], spec, () => undefined)).toEqual({
      handled: false,
      argv: ['--title', 'hi'],
    });
    expect(guardCliArgsNormalized(['--help'], spec, () => undefined).handled).toBe(true);
    expect(() => guardCliArgsNormalized(['--nope=1'], spec, () => undefined)).toThrow();
  });
});
