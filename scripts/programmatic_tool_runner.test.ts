import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';

describe('programmatic tool runner entrypoint', () => {
  it('uses the shared harness and keeps the RPC framing contract', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/programmatic_tool_runner.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('import { defineScript, isDirectScript, ScriptExitError }');
    expect(source).not.toContain('main()\n  .catch');
    expect(source.match(/method: 'call_op'/gu)).toHaveLength(1);
  });
});
