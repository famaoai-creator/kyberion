import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { ValidateFunction } from 'ajv';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '../secure-io.js';
import { defineCatalog } from './governed-catalog.js';
import { readJson, writeJson } from './json.js';
import { withLockSync } from './lock-utils.js';
import {
  runtimeStatePath,
  type RuntimeStateKey,
  type RuntimeStateScope,
} from './runtime-state-roots.js';

export type JsonStateOptions<T> = {
  /** New state stores always validate defaults, existing records and writes. */
  schema: string | ValidateFunction<T>;
  default: T | (() => T);
  lock?: { timeoutMs?: number };
} & (
  | { path: string | (() => string); logicalPath?: never; scope?: never }
  | { path?: never; logicalPath: RuntimeStateKey; scope?: RuntimeStateScope }
);

export interface JsonStateStore<T> {
  read(): T;
  /** Synchronous transaction. Returning a Promise or reentering this file is an error. */
  update(fn: (current: T) => T): T;
  replace(value: T): T;
  /** Append to a JSON array; JSONL ledgers retain their own append contract. */
  append(record: T extends Array<infer Entry> ? Entry : never): T;
}

// Share the reentrancy fence across package copies in surfaces and CLI bundles.
const KEY = Symbol.for('kyberion.json-state.active.v1');
const globals = globalThis as typeof globalThis & { [KEY]?: Set<string> };
const active = (globals[KEY] ??= new Set<string>());

/**
 * One conservative identity for case/Unicode-normalization aliases on macOS
 * and Windows. Keep the validated path unchanged for I/O. Case-equivalent
 * files also share a mutex on case-sensitive volumes, and nested updates to
 * either spelling are intentionally rejected rather than risking lost writes.
 */
function stateIdentity(file: string): string {
  return file.normalize('NFC').toLowerCase().toUpperCase().normalize('NFC');
}

export function openJsonState<T>(options: JsonStateOptions<T>): JsonStateStore<T> {
  if (!options.schema) throw new Error('[JSON_STATE_SCHEMA_REQUIRED] Supply a state schema');
  const resolvePath = (): string => {
    const candidate =
      options.path !== undefined
        ? typeof options.path === 'function'
          ? options.path()
          : options.path
        : runtimeStatePath(options.logicalPath!, options.scope).physicalPath;
    return assertSafeRepositoryPath(
      isAbsolute(candidate) ? candidate : pathResolver.rootResolve(candidate),
      { allowMissingLeaf: true }
    );
  };
  const catalog = defineCatalog<T>({ id: 'json-state', path: resolvePath, schema: options.schema });
  const read = (file: string): T => {
    if (safeExistsSync(file)) {
      if (!safeLstat(file).isFile()) throw new Error(`[JSON_STATE_NOT_FILE] ${file}`);
      return catalog.validate(readJson<unknown>(file), file);
    }
    const fallback =
      typeof options.default === 'function'
        ? (options.default as () => T)()
        : structuredClone(options.default);
    return catalog.validate(fallback, file);
  };
  const mutate = (fn: (file: string) => T): T => {
    const file = resolvePath();
    const identity = stateIdentity(file);
    if (active.has(identity)) throw new Error(`[JSON_STATE_REENTRANT] ${file}`);
    const timeout = options.lock?.timeoutMs ?? 5000;
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new Error('[JSON_STATE_LOCK_TIMEOUT_INVALID]');
    const resource = `json-state-${createHash('sha256').update(identity).digest('hex')}`;
    active.add(identity);
    try {
      return withLockSync(
        resource,
        () => {
          const next = fn(file);
          if (next && typeof (next as { then?: unknown }).then === 'function') {
            throw new Error('[JSON_STATE_ASYNC_UPDATE] Mutators must be synchronous');
          }
          const validated = catalog.validate(next, file);
          writeJson(file, validated);
          return validated;
        },
        timeout
      );
    } finally {
      active.delete(identity);
    }
  };
  const store: JsonStateStore<T> = {
    read: () => read(resolvePath()),
    update: (fn) => mutate((file) => fn(read(file))),
    replace: (value) => mutate(() => value),
    append: (record) =>
      mutate((file) => {
        const current = read(file);
        if (!Array.isArray(current)) throw new Error('[JSON_STATE_APPEND_REQUIRES_ARRAY]');
        return [...current, record] as T;
      }),
  };
  return store;
}
