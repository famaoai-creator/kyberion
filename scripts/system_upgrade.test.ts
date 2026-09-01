import { describe, expect, it } from 'vitest';
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
});
