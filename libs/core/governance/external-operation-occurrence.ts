import { AsyncLocalStorage } from 'node:async_hooks';

const occurrences = new AsyncLocalStorage<readonly string[]>();
const empty: readonly string[] = Object.freeze([]);

/** Execution-owned nesting identity; never hydrate this from action JSON. */
export function withExternalOperationOccurrence<T>(segment: string, body: () => T): T {
  return occurrences.run(Object.freeze([...currentExternalOperationOccurrence(), segment]), body);
}

export function currentExternalOperationOccurrence(): readonly string[] {
  return occurrences.getStore() ?? empty;
}
