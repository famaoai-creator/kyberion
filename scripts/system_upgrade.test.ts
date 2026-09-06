import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  buildSystemUpgradeArgs,
  parseSystemUpgradeArgs,
  SYSTEM_UPGRADE_PIPELINES,
} from './system_upgrade.js';

describe('system upgrade dispatcher', () => {
  it('defaults to a read-only check pipeline and selects execute explicitly', () => {
    expect(parseSystemUpgradeArgs([])).toEqual({ mode: 'check', pipelineArgs: [] });
    expect(parseSystemUpgradeArgs(['--mode', 'execute', '--dry-run'])).toEqual({
      mode: 'execute',
      pipelineArgs: ['--dry-run'],
    });
    expect(buildSystemUpgradeArgs('check')).toEqual(['--input', SYSTEM_UPGRADE_PIPELINES.check]);
  });

  it('supports equals syntax and preserves pipeline flags', () => {
    expect(parseSystemUpgradeArgs(['--mode=execute', '--json', '--quiet'])).toEqual({
      mode: 'execute',
      pipelineArgs: ['--json', '--quiet'],
    });
    expect(buildSystemUpgradeArgs('execute', ['--dry-run'])).toEqual([
      '--input',
      SYSTEM_UPGRADE_PIPELINES.execute,
      '--dry-run',
    ]);
  });

  it('rejects missing and unknown modes', () => {
    expect(() => parseSystemUpgradeArgs(['--mode'])).toThrow('--mode requires check or execute');
    expect(() => parseSystemUpgradeArgs(['--mode', 'repair'])).toThrow(
      'unknown system upgrade mode'
    );
  });

  it('keeps nested exit status capture behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/system_upgrade.ts'), { encoding: 'utf8' })
    );
    expect(source).not.toContain('process.exitCode');
    expect(source).toContain('getProcessExitCode()');
    expect(source).toContain('clearProcessExitCode()');
  });

  it('routes the in-session delegated result through the shared printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/test-insession.ts'), { encoding: 'utf8' })
    );
    expect(source).not.toContain('console.log');
    expect(source).toContain('run({ print })');
    expect(source).toContain('test(print)');
  });
});
