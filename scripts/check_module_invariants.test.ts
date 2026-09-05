import { describe, expect, it } from 'vitest';
import { checkModuleInvariants } from './check_module_invariants.js';

describe('module invariant checker', () => {
  it('validates registered invariants and source assertions', () => {
    expect(checkModuleInvariants().registeredInvariants).toBeGreaterThan(0);
  });
});
