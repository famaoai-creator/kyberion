import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { main } from './app_preflight.js';

describe('app preflight entrypoint', () => {
  it('keeps report output behind the shared harness', async () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/app_preflight.ts'), { encoding: 'utf8' })
    );

    expect(source).toContain('context.print(');
    expect(source).toContain('new ScriptExitError(');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('process.env.ANDROID_HOME');
    expect(source).not.toContain('process.env.ANDROID_SDK_ROOT');
    expect(source).toContain("getRegisteredEnvText('ANDROID_HOME')");
    expect(source).toContain("getRegisteredEnvText('ANDROID_SDK_ROOT')");
  });

  it('handles help without probing platform prerequisites', async () => {
    await expect(main(['--help'])).resolves.toEqual({
      status: 0,
      help: expect.stringContaining('doctor -- --runtime app'),
    });
  });
});
