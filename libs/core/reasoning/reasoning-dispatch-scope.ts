/** Lexical per-attempt retry restraint; never changes global/provider configuration. */
import { AsyncLocalStorage } from 'node:async_hooks';
const noRedispatch = new AsyncLocalStorage<boolean>();
export function automaticReasoningRedispatchAllowed(): boolean {
  return noRedispatch.getStore() !== true;
}
export function withoutAutomaticReasoningRedispatch<T>(fn: () => T): T {
  return noRedispatch.run(true, fn);
}
