import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('workflow catalog reference checker boundary', () => {
  it('uses the canonical mission workflow catalog loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_workflow_catalog_refs.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('loadMissionWorkflowCatalog()');
    expect(source).not.toContain('readJson');
  });
});
