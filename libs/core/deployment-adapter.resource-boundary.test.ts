import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

describe('deployment adapter resource boundary', () => {
  it('revalidates the default deployment config path before loading it', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/deployment-adapter.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('return assertSafeRepositoryPath(');
    expect(source).toContain("pathResolver.knowledge(path.join('personal/deployments'");
    expect(source).toContain('{ allowMissingLeaf: true }');
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).not.toContain('process.env.SHELL');
    expect(source).toContain('getRegisteredEnvText');
  });
});
