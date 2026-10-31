import { afterEach, describe, it, expect, vi } from 'vitest';
const role = vi.hoisted(() => ({ value: 'worker' }));
vi.mock('../foundation/execution-scope.js', () => ({
  currentExecutionScope: () => ({ assumedRole: role.value }),
}));
import {
  ENGINE_RUNTIME_OPERATOR_ROLE,
  withEngineRuntimePreferencesAccess as run,
  engineRuntimePreferencesAccessDenial as denied,
} from './engine-runtime-preferences-access.js';
const file = 'knowledge/personal/onboarding/engine-runtime.json';
afterEach(() => {
  role.value = 'worker';
});
describe('exact operator preference ceiling', () => {
  it('requires capability even when the operator role was assumed', () => {
    role.value = ENGINE_RUNTIME_OPERATOR_ROLE;
    expect(denied(file, 'read')).not.toBeNull();
    expect(() => run(file, () => 0)).toThrow('ACCESS_DENIED');
  });
  it('allows only fixed content and ancestor mkdir/metadata, including after role changes', () =>
    run(file, () => {
      expect(denied(file, 'read')).toBeNull();
      expect(denied(file, 'write')).toBeNull();
      for (const operation of ['read', 'write'] as const)
        expect(denied('knowledge/personal/onboarding', operation)).not.toBeNull();
      expect(denied('knowledge/personal/onboarding', 'mkdir')).toBeNull();
      expect(denied('knowledge', 'metadata')).toBeNull();
      role.value = 'ecosystem_architect';
      expect(denied(file + '/child', 'write')).not.toBeNull();
      expect(denied('knowledge/personal/onboarding/voice.json', 'read')).not.toBeNull();
      expect(denied('active/shared/runtime/locks/x', 'write')).not.toBeNull();
    }));
  it('intersects nested capabilities and does not widen to another profile', () =>
    run(file, () =>
      run('customer/acme/onboarding/engine-runtime.json', () => {
        expect(denied(file, 'read')).not.toBeNull();
        expect(denied('customer/acme/onboarding/engine-runtime.json', 'read')).not.toBeNull();
      })
    ));
  it('permits only needed product schema contents and rejects arbitrary paths', () =>
    run(file, () => {
      expect(
        denied('knowledge/product/schemas/engine-runtime-preferences.schema.json', 'read')
      ).toBeNull();
      expect(denied('knowledge/product/secret.json', 'read')).not.toBeNull();
      expect(denied(file, 'mkdir')).not.toBeNull();
    }));
  it('rejects traversals and non-profile targets', () => {
    for (const target of ['../x', 'customer/acme/other.json', file + '/child'])
      expect(() => run(target, () => 0)).toThrow('ACCESS_DENIED');
  });
  it('revokes async descendants after the synchronous operation returns', async () => {
    let later: Promise<unknown> = Promise.resolve();
    run(file, () => {
      later = Promise.resolve().then(() => expect(denied(file, 'read')).not.toBeNull());
    });
    await later;
  });
});
