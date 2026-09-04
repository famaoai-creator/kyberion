import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('claude_code_hook entrypoint', () => {
  it('keeps the protocol writer and delegates exit status to natural success', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/claude_code_hook.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('process.exitCode =');
    expect(source).toContain('process.stdout.write(');
    expect(source).toContain("permissionDecision: 'allow'");
    expect(source).toContain('run: async ({ argv }) =>');
  });
});
