import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { main } from './dependency_resolver.js';

describe('dependency resolver entrypoint', () => {
  it('keeps dependency probe output behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/dependency_resolver.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('context.print(');
    expect(source).toContain('new ScriptExitError(');
    expect(source).not.toContain('console.log(');
  });

  it('handles help without probing dependencies', async () => {
    await expect(main(['--help'])).resolves.toEqual({
      status: 0,
      help: expect.stringContaining('deps:check'),
    });
  });
});
