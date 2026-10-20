import { describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

const admission = vi.hoisted(() =>
  vi.fn(async () => ({ status: 'held', reason: 'fixture stops before work' }))
);
vi.mock('./mission_admission_continuation.js', () => ({
  continueHumanMissionAdmission: admission,
}));
import { main } from './mission_alignment_request.js';

describe('mission alignment request entrypoint', () => {
  it('routes only explicit --work-item into human preparation', async () => {
    const result = await main(['--work-item', 'fixture-item']);
    expect(admission).toHaveBeenCalledWith('fixture-item', { prepare: true });
    expect(result.reason).toBe('fixture stops before work');
  });
  it('keeps approval output and failure handling behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/mission_alignment_request.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain(
      'context.print(context.json ? result : formatAlignmentRequest(result))'
    );
    expect(source).toContain('new ScriptExitError(');
    expect(source).not.toContain('process.stdout.write');
    expect(source).not.toContain('process.exitCode');
  });
});
