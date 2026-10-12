import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeCheckGate } from './run_checks.js';

const snapshot = [
  'process.stdout.write([',
  'process.env.CI,process.env.GITHUB_ACTIONS,process.env.RUN_CHECKS_SECRET_SENTINEL',
  '].map(value=>value??"(absent)").join("|"))',
].join('');

function childGate(id: string) {
  return {
    id,
    scope: 'full' as const,
    executable: process.execPath,
    args: ['-e', snapshot],
    owner: 'test',
    rationale: 'Inspect only controlled fixture markers through the real safeExec child boundary',
    timeout_ms: 10_000,
  };
}

describe('check runner gate-local hosted CI marker forwarding', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('forwards GITHUB_ACTIONS to the actual Operator gate child while preserving inherited CI', async () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('RUN_CHECKS_SECRET_SENTINEL', 'must-not-inherit');
    const result = await executeCheckGate(childGate('mos-no-write-api'));
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(result.stdout).toBe('true|true|(absent)');
  });

  it('does not extend marker forwarding or arbitrary environment inheritance to other gates', async () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('RUN_CHECKS_SECRET_SENTINEL', 'must-not-inherit');
    const result = await executeCheckGate(childGate('another-gate'));
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(result.stdout).toBe('true|(absent)|(absent)');
  });

  it.each([undefined, 'false', 'unexpected-marker-value'])(
    'does not invent hosted CI for noncanonical marker %s',
    async (marker) => {
      vi.stubEnv('CI', 'true');
      vi.stubEnv('GITHUB_ACTIONS', marker);
      vi.stubEnv('RUN_CHECKS_SECRET_SENTINEL', 'must-not-inherit');
      const result = await executeCheckGate(childGate('mos-no-write-api'));
      expect(result.status, result.stderr || result.error?.message).toBe(0);
      expect(result.stdout).toBe('true|(absent)|(absent)');
    }
  );
});
