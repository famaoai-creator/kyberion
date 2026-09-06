import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

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

  it('exposes the canonical pnpm auth entrypoint without duplicating auth logic', () => {
    const packageJson = JSON.parse(
      String(
        safeReadFile(pathResolver.rootResolve('package.json'), {
          encoding: 'utf8',
        })
      )
    ) as { scripts?: Record<string, unknown> };

    expect(packageJson.scripts?.auth).toBe(
      'node --import ./scripts/ts-loader.mjs scripts/reasoning_auth_check.ts'
    );
  });
});
