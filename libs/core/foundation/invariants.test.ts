import { afterEach, describe, expect, it } from 'vitest';
import {
  assertModuleInvariant,
  getModuleInvariant,
  listModuleInvariants,
  registerModuleInvariant,
  resetModuleInvariantsForTests,
} from './invariants.js';

afterEach(() => resetModuleInvariantsForTests());

describe('module invariants', () => {
  it('ships core invariants with module ownership', () => {
    expect(getModuleInvariant('op-preflight', 'decision-domain')).toMatchObject({
      module: 'op-preflight',
      enforcement: 'runtime',
    });
    expect(
      getModuleInvariant('reasoning-provider-registry', 'prompt-reconstruction')
    ).toMatchObject({
      enforcement: 'documented',
      reason: expect.stringContaining('No runtime invariant:'),
    });
  });

  it('asserts runtime facts and attributes failures to the module', () => {
    assertModuleInvariant('op-preflight', 'decision-domain', { decision: 'allow' });
    expect(() =>
      assertModuleInvariant('op-preflight', 'decision-domain', { decision: 'permit' })
    ).toThrow('[INVARIANT_VIOLATION] invariant "decision-domain" violated by "op-preflight"');
  });

  it('rejects duplicate entries and disposes extension entries reversibly', () => {
    const invariant = {
      module: 'test-module',
      id: 'test-invariant',
      description: 'test fact is true',
      enforcement: 'runtime' as const,
      check: (facts: unknown) => facts === true,
    };
    const dispose = registerModuleInvariant(invariant);
    expect(() => registerModuleInvariant(invariant)).toThrow('duplicate invariant');
    expect(listModuleInvariants().some((entry) => entry.module === 'test-module')).toBe(true);
    dispose();
    expect(getModuleInvariant('test-module', 'test-invariant')).toBeUndefined();
  });

  it('requires an explicit reason for documented-only gaps', () => {
    expect(() =>
      registerModuleInvariant({
        module: 'test-module',
        id: 'gap',
        description: 'not wired',
        enforcement: 'documented',
      })
    ).toThrow('requires a reason');
  });
});
