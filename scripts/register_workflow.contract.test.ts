import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('register_workflow request boundary', () => {
  it('validates registration requests through the governed catalog boundary', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/register_workflow.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('defineCatalog<RegistrationRequest>');
    expect(source).toContain("id: 'workflow-registration-request'");
    expect(source).toContain(
      'return assertSafeRepositoryPath(path.join(pathResolver.rootDir(), rel),'
    );
    expect(source).not.toContain('createAjv()');
    expect(source).not.toMatch(/function readJson\(/u);
  });
});
