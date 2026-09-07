import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { resolveScriptCommand } from './kyberion.js';

describe('reasoning auth check entrypoint', () => {
  it('keeps auth status output behind the shared script harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/reasoning_auth_check.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain("flags: ['json', 'quiet']");
    expect(source).toContain("context.argv.includes('--probe')");
    expect(source).toContain('context.print(');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain("context.argv, '--json'");
  });

  it('exposes the canonical auth entrypoint without duplicating auth logic', () => {
    // Verification aliases moved from package.json scripts to the governed
    // CLI command registry (main 87eb0797b "move verification aliases to
    // governed router"); `pnpm kyberion auth check` now dispatches this
    // module directly instead of a package.json `auth` script.
    expect(resolveScriptCommand('auth check')).toMatchObject({
      module: 'scripts/reasoning_auth_check.ts',
      command: 'auth check',
    });
  });
});
