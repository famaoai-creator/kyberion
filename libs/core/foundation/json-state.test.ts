import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import { openJsonState } from './json-state.js';
import { withLockSync } from './lock-utils.js';

const root = pathResolver.rootResolve(`active/shared/tmp/json-state-${randomUUID()}`);
const file = `${root}/state.json`;
const schema = (value: unknown): value is { count: number } =>
  !!value && typeof value === 'object' && Number.isInteger((value as { count?: unknown }).count);
const store = (timeoutMs = 5000) =>
  openJsonState({
    path: file,
    schema,
    default: { count: 0 },
    lock: { timeoutMs },
  });
afterEach(() => safeRmSync(root, { recursive: true, force: true }));

describe('locked JSON state', () => {
  it('rereads persisted state across instances instead of losing a prior update', () => {
    const first = store();
    const second = store();
    expect(first.read()).toEqual({ count: 0 });
    first.update((value) => ({ count: value.count + 1 }));
    second.update((value) => ({ count: value.count + 1 }));
    expect(first.read()).toEqual({ count: 2 });
    first.replace({ count: 7 });
    expect(second.read()).toEqual({ count: 7 });
  });

  it('uses one file-derived mutex for every writer instance', () => {
    const resource = `json-state-${createHash('sha256').update(file).digest('hex')}`;
    withLockSync(resource, () => {
      expect(() => store(1).replace({ count: 3 })).toThrow('LOCK_TIMEOUT');
    });
    expect(store().read()).toEqual({ count: 0 });
  });

  it('validates defaults and writes, and leaves prior bytes intact on failure', () => {
    const state = store();
    state.replace({ count: 5 });
    const before = safeReadFile(file, { encoding: 'utf8' });
    expect(() => state.replace({ count: 'invalid' } as never)).toThrow('Invalid catalog');
    expect(() =>
      state.update(() => {
        throw new Error('abort');
      })
    ).toThrow('abort');
    expect(safeReadFile(file, { encoding: 'utf8' })).toBe(before);
    expect(() =>
      openJsonState({ path: `${root}/other.json`, schema, default: { count: NaN } }).read()
    ).toThrow('Invalid catalog');
    expect(() => openJsonState({ path: file, default: { count: 0 } } as never)).toThrow(
      'JSON_STATE_SCHEMA_REQUIRED'
    );
  });

  it('fails closed on malformed JSON and schema-invalid existing data', () => {
    safeWriteFile(file, '{');
    expect(() => store().update(() => ({ count: 4 }))).toThrow();
    expect(safeReadFile(file, { encoding: 'utf8' })).toBe('{');
    safeWriteFile(file, '{"count":"bad"}');
    expect(() => store().read()).toThrow('Invalid catalog');
  });

  it('rejects asynchronous and reentrant mutation without losing the lock fence', () => {
    const state = store();
    state.replace({ count: 1 });
    expect(() => state.update((() => Promise.resolve({ count: 3 })) as never)).toThrow(
      'JSON_STATE_ASYNC_UPDATE'
    );
    expect(() => state.update(() => store().replace({ count: 9 }))).toThrow('JSON_STATE_REENTRANT');
    expect(state.read()).toEqual({ count: 1 });
    expect(state.update((value) => ({ count: value.count + 1 }))).toEqual({ count: 2 });
  });

  it('appends array records atomically and rejects append to an object', () => {
    const array = openJsonState<number[]>({
      path: file,
      default: [],
      schema: (value: unknown): value is number[] =>
        Array.isArray(value) && value.every(Number.isInteger),
    });
    array.append(1);
    expect(array.append(2)).toEqual([1, 2]);
    safeRmSync(file, { force: true });
    expect(() => store().append(3 as never)).toThrow('JSON_STATE_APPEND_REQUIRES_ARRAY');
  });
});
