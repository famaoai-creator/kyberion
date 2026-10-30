import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const state = vi.hoisted(() => ({ keys: [] as string[], inside: 0 }));
vi.mock('../foundation/lock-utils.js', () => ({
  withLockSync: (key: string, action: () => unknown) => {
    state.keys.push(key);
    state.inside++;
    try {
      return action();
    } finally {
      state.inside--;
    }
  },
}));
import { withEngineRuntimePreferencesTransaction as run } from './engine-runtime-preferences-transaction.js';
const personal = 'knowledge/personal/onboarding/engine-runtime.json';
beforeEach(() => {
  state.keys = [];
  state.inside = 0;
});
describe('shared synchronous engine profile transaction', () => {
  it('preserves the existing canonical API key and reuses a same-profile core save synchronously', () => {
    run(personal, () => run(personal, () => expect(state.inside).toBe(1)));
    expect(state.keys).toEqual([
      'engine-runtime-operator:' + createHash('sha256').update(personal).digest('hex'),
    ]);
  });
  it('uses a distinct lock for another profile instead of borrowing ownership', () => {
    run(personal, () =>
      run('customer/acme/onboarding/engine-runtime.json', () => expect(state.inside).toBe(2))
    );
    expect(state.keys).toHaveLength(2);
    expect(state.keys[0]).not.toBe(state.keys[1]);
  });
  it('revokes ownership on failure and reacquires on the next call', () => {
    expect(() =>
      run(personal, () => {
        throw new Error('write failed');
      })
    ).toThrow('write failed');
    run(personal, () => expect(state.inside).toBe(1));
    expect(state.keys).toHaveLength(2);
  });
  it('revokes inherited async ownership so descendants acquire a fresh lock', async () => {
    let later: Promise<void> = Promise.resolve();
    run(personal, () => {
      later = Promise.resolve().then(() =>
        run(personal, () => {
          expect(state.inside).toBe(1);
        })
      );
    });
    await later;
    expect(state.keys).toHaveLength(2);
  });
  it('rejects thenables and does not leave an owned lease', () => {
    expect(() => run(personal, () => Promise.resolve())).toThrow('SYNC_REQUIRED');
    run(personal, () => 0);
    expect(state.keys).toHaveLength(2);
  });
  it('rejects noncanonical keys before lock I/O', () => {
    for (const path of [
      '/knowledge/personal/onboarding/engine-runtime.json',
      '../knowledge/personal/onboarding/engine-runtime.json',
      'knowledge/./personal/onboarding/engine-runtime.json',
      'knowledge//personal/onboarding/engine-runtime.json',
      'knowledge/personal/onboarding/other.json',
      'C:/onboarding/engine-runtime.json',
      'knowledge\\personal/onboarding/engine-runtime.json',
    ])
      expect(() => run(path, () => 0)).toThrow('TARGET_INVALID');
    expect(state.keys).toEqual([]);
  });
});
