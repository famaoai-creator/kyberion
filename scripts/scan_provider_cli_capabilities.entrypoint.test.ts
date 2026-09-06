import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { main } from './scan_provider_cli_capabilities.js';

describe('provider capability scan entrypoint', () => {
  it('keeps scan output and help behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/scan_provider_cli_capabilities.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('print(result)');
    expect(source).toContain('assertSafeRepositoryPath(pathResolver.resolve(outPath)');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('console.error(');
  });

  it('handles help without probing providers or writing a snapshot', () => {
    expect(main(['--help'])).toEqual({
      status: 'help',
      usage: expect.stringContaining('scan:provider-cli-capabilities'),
    });
  });
});
