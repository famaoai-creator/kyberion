/** Per-operation Keychain memoization, including refusal; never a process-wide secret cache. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentExecutionScope } from './execution-scope.js';
const KEY = Symbol.for('kyberion.secret-resolution-session.v1');
const host = globalThis as typeof globalThis & {
  [KEY]?: AsyncLocalStorage<Map<string, string | null>>;
};
const sessions = host[KEY] ?? (host[KEY] = new AsyncLocalStorage<Map<string, string | null>>());
export function withSecretResolutionSession<T>(run: () => T): T {
  return sessions.getStore() ? run() : sessions.run(new Map(), run);
}
export function memoizedKeychainRead(
  service: string,
  account: string,
  read: () => string | null
): string | null {
  const cache = sessions.getStore();
  if (!cache) return read();
  const scope = currentExecutionScope();
  const key = JSON.stringify([
    service,
    account,
    scope?.assumedRole,
    scope?.tenantSlug,
    scope?.executionIdentity,
  ]);
  if (cache.has(key)) return cache.get(key) ?? null;
  const value = read();
  cache.set(key, value);
  return value;
}
export function invalidateKeychainRead(service: string, account: string): void {
  const cache = sessions.getStore();
  if (!cache) return;
  for (const key of cache.keys()) {
    const [s, a] = JSON.parse(key) as string[];
    if (s === service && a === account) cache.delete(key);
  }
}
