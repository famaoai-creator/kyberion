import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { main } from './vital_check.js';

describe('vital check entrypoint', () => {
  it('keeps the report and failure exit behind the shared harness', async () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/vital_check.ts'));

    expect(source).toContain('context.print(');
    expect(source).toContain('new ScriptExitError(');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('process.stdout.write(');
    expect(source).toContain("nowIso, readTextFile } from '@agent/core/foundation'");
  });

  it('handles help without building the runtime report', async () => {
    await expect(main(['--help'])).resolves.toEqual({
      status: 0,
      help: expect.stringContaining('kyberion vital'),
    });
  });
});
