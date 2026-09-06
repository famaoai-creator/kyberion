import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('mission alignment decision entrypoint', () => {
  it('keeps CLI output and strict failure handling behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/mission_alignment_decision.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain(
      'context.print(context.json ? report : formatAlignmentDecision(report))'
    );
    expect(source).toContain('new ScriptExitError(');
    expect(source).not.toContain('process.stdout.write');
    expect(source).not.toContain('process.exitCode');
  });
});
