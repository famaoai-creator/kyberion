import { describe, expect, it } from 'vitest';
import { collectWorkScopePolicyViolations } from './check_work_scope_policy.js';
import { loadWorkScopePolicy } from '@agent/core';

describe('check_work_scope_policy', () => {
  it('accepts the bundled policy when every mandatory trigger is reachable', () => {
    expect(collectWorkScopePolicyViolations(loadWorkScopePolicy())).toEqual([]);
  });

  it('reports a declared mandatory trigger without an emitter', () => {
    const policy = loadWorkScopePolicy();
    expect(
      collectWorkScopePolicyViolations({
        ...policy,
        mandatory_triggers: [...policy.mandatory_triggers, 'unwired_trigger'],
      })
    ).toEqual([
      'work-scope-policy: mandatory trigger "unwired_trigger" has no reachable emitter in work-scope-decision.ts',
    ]);
  });
});
