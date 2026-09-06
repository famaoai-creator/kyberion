import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { resolveShellAdapter } from './platform-command-adapters.js';
import { safeReadFile } from './secure-io.js';

describe('platform command adapters', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves the POSIX shell from the current governed environment', () => {
    vi.stubEnv('SHELL', '/custom/test-shell');
    expect(resolveShellAdapter('linux')).toEqual({
      shell: '/custom/test-shell',
      args: ['-lc'],
    });
  });

  it('keeps the shell environment read behind the accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/platform-command-adapters.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('process.env.SHELL');
    expect(source).toContain("getRegisteredEnvText('SHELL')");
  });
});
