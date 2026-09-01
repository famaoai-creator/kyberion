import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { findMissionProcessBindingViolations } from './check_mission_process_bindings.js';

describe('mission process bindings checker', () => {
  it('passes the repository governance bindings', () => {
    expect(findMissionProcessBindingViolations()).toEqual([]);
  });

  it('uses governed loaders for mission process governance data', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_mission_process_bindings.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('loadMissionWorkflowCatalog()');
    expect(source).toContain('loadMissionClassificationPolicy()');
    expect(source).toContain('loadMissionReviewGateRegistry()');
    expect(source).toContain('loadMissionProcessRegistry()');
    expect(source).not.toContain('readFoundationJson');
    expect(source).not.toContain('function readJson(');
  });
});
