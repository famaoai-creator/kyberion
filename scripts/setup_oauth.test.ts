import { describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { main } from './setup_oauth.js';

describe('setup_oauth', () => {
  it('routes usage output through the supplied printer', async () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/setup_oauth.ts'), { encoding: 'utf8' })
    );
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('console.error(');
    expect(source).not.toContain('process.exitCode =');
    expect(source).toContain("new ScriptExitError(130, '', true)");
    expect(source).toContain("new ScriptExitError(143, '', true)");
    expect(source).toContain('run: ({ argv, print }) => runOAuthSetupForService(argv[0], print)');

    const print = vi.fn();
    await expect(main(['--help'], print)).rejects.toMatchObject({ code: 0 });
    expect(print).toHaveBeenCalledWith(
      expect.stringContaining('KYBERION_OAUTH_SERVICE_ID=<service_name>')
    );
  });
});
