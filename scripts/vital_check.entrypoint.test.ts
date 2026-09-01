import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { main } from './vital_check.js';

describe('vital check entrypoint', () => {
  it('keeps the report and failure exit behind the shared harness', async () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/vital_check.ts'), { encoding: 'utf8' })
    );

    expect(source).toContain('context.print(');
    expect(source).toContain('new ScriptExitError(');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('process.stdout.write(');
  });

  it('handles help without building the runtime report', async () => {
    await expect(main(['--help'])).resolves.toEqual({
      status: 0,
      help: expect.stringContaining('kyberion vital'),
    });
  });
});
