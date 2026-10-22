import { AsyncLocalStorage } from 'node:async_hooks';

/** Shared by high-level scope resolution and the foundation identity bridge.
 * A transported scope must not acquire absent fields from its destination. */
const key = Symbol.for('kyberion.scope-env-only.v1');
export interface TransportedScopeLineage {
  session_id?: string;
  work_shape?: string;
}
const host = globalThis as typeof globalThis & {
  [key]?: AsyncLocalStorage<TransportedScopeLineage>;
};
const storage = host[key] ?? (host[key] = new AsyncLocalStorage<TransportedScopeLineage>());

export function withScopeEnvOnly<T>(action: () => T, lineage: TransportedScopeLineage = {}): T {
  return storage.run(
    Object.freeze({
      ...(lineage.session_id ? { session_id: lineage.session_id } : {}),
      ...(lineage.work_shape ? { work_shape: lineage.work_shape } : {}),
    }),
    action
  );
}

export function isScopeEnvOnly(): boolean {
  return storage.getStore() !== undefined;
}

export function transportedScopeLineage(): TransportedScopeLineage | undefined {
  const value = storage.getStore();
  return value ? { ...value } : undefined;
}
