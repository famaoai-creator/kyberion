import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
const state = vi.hoisted(() => ({
  root: '/repo/knowledge/personal',
  value: { version: '1.0.0', python_bin: '/python' } as Record<string, unknown>,
  events: [] as string[],
  failure: undefined as Error | undefined,
  lockKeys: [] as string[],
}));
vi.mock('../path-resolver.js', () => ({ pathResolver: { rootDir: () => '/repo' } }));
vi.mock('../profile-root.js', () => ({
  resolveActiveProfileRoot: () => {
    state.events.push('profile');
    return state.root;
  },
}));
vi.mock('../foundation/credential-binding.js', () => ({
  credentialBindingReadiness: () => {
    state.events.push('scope');
    if (state.failure) throw state.failure;
  },
}));
vi.mock('../foundation/lock-utils.js', () => ({
  withLockSync: (_key: string, fn: () => unknown) => {
    state.lockKeys.push(_key);
    state.events.push('lock');
    return fn();
  },
}));
vi.mock('../authority.js', () => ({
  withExecutionContext: (_role: string, fn: () => unknown) => {
    state.events.push('role');
    return fn();
  },
}));
vi.mock('../shell/sandbox-policy.js', () => ({ getPluginExecutionContext: () => undefined }));
vi.mock('./engine-runtime-preferences.js', () => ({
  getEngineRuntimePreferences: () => ({ ...state.value }),
  previewEngineRuntimePreferences: (patch: Record<string, unknown>) => {
    if (patch.python_bin === 'relative') throw new Error('python_bin must be an absolute path');
  },
  saveEngineRuntimePreferences: (patch: Record<string, unknown>) => {
    state.events.push('save');
    Object.assign(state.value, patch);
    for (const key of Object.keys(patch)) if (patch[key] === undefined) delete state.value[key];
  },
}));
import {
  getOperatorEngineRuntimePreferences as get,
  updateOperatorEngineRuntimePreferences as update,
} from './engine-runtime-preferences-operator.js';
const principal = {
  role: 'localadmin',
  source: 'loopback' as const,
  loopback: true,
  principalId: 'human:operator',
};
beforeEach(() => {
  state.root = '/repo/knowledge/personal';
  state.value = { version: '1.0.0', python_bin: '/python' };
  state.events = [];
  state.failure = undefined;
  state.lockKeys = [];
});
describe('operator profile facade', () => {
  it('validates scope before profile/lock and returns only a safe descriptor', () => {
    const result = get(principal);
    expect(state.events).toEqual(['scope', 'profile', 'lock', 'role']);
    expect(result.profile).toEqual({ kind: 'personal', id: 'personal' });
    expect(JSON.stringify(result)).not.toContain('/repo');
  });
  it('binds revision to profile identity, rejects stale updates without saving', () => {
    const first = get(principal);
    state.root = '/repo/customer/acme';
    expect(get(principal).revision).not.toBe(first.revision);
    expect(() =>
      update(principal, { patch: { python_bin: '/new' }, expected_revision: first.revision })
    ).toThrow('engine_config_conflict');
    expect(state.events).not.toContain('save');
  });
  it('preserves untouched fields and explicitly unsets selected keys', () => {
    state.value.ffmpeg_bin = '/ffmpeg';
    const first = get(principal);
    const result = update(principal, {
      patch: { streaming_stt_bridge: 'bridge' },
      unset: ['python_bin'],
      expected_revision: first.revision,
    });
    expect(result.preferences).toMatchObject({
      ffmpeg_bin: '/ffmpeg',
      streaming_stt_bridge: 'bridge',
    });
    expect(result.preferences).not.toHaveProperty('python_bin');
  });
  it('rejects unauthenticated callers before private resolution and propagates scope contradictions', () => {
    expect(() => get({ ...principal, source: 'token' })).toThrow('OPERATOR_DENIED');
    expect(state.events).toEqual([]);
    state.failure = new Error('CREDENTIAL_SCOPE_DENIED');
    expect(() => get(principal)).toThrow('CREDENTIAL_SCOPE_DENIED');
    expect(state.events).toEqual(['scope']);
  });
  it('validates request shape and core semantic validation without saving', () => {
    const revision = get(principal).revision;
    for (const body of [
      { expected_revision: revision, unset: null },
      { expected_revision: revision, patch: { version: '2' } },
      { expected_revision: revision, patch: { python_bin: '/x' }, unset: ['python_bin'] },
      { patch: { python_bin: '/x' } },
    ])
      expect(() => update(principal, body as never)).toThrow('invalid_patch');
    expect(() =>
      update(principal, { expected_revision: revision, patch: { python_bin: 'relative' } })
    ).toThrow('preference_rejected');
    expect(state.events).not.toContain('save');
  });
  it('uses the canonical core profile transaction key for API compare and update', () => {
    const first = get(principal);
    update(principal, { patch: { python_bin: '/next' }, expected_revision: first.revision });
    expect(state.lockKeys).toEqual(
      Array(2).fill(
        'engine-runtime-operator:' +
          createHash('sha256')
            .update('knowledge/personal/onboarding/engine-runtime.json')
            .digest('hex')
      )
    );
  });
});
