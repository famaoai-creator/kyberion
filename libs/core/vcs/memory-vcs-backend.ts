/**
 * memory vcs backend — hermetic backend for tests and dry runs.
 *
 * `createMemoryVcsBackend()` returns an isolated recording runner; injecting
 * it via a verb's `run` parameter (or registering it on the seam) exercises
 * the full typed-verb path without touching a real git binary. Importing this
 * module also registers one shared `memory` provider so
 * `resolveVcsBackend('memory')` works — it is never in the governed default
 * chain.
 *
 * Results come from per-prefix queues (`respond('log', …)` answers the next
 * `git log …`) or a fallback (default: empty success); unmatched verbs do NOT
 * fail loudly — a verb layer branches on `status`/`stdout`, so fabricated
 * stderr would hide caller bugs the real CLI surfaces.
 */

import type { SafeExecOptions } from '../secure-io.js';
import {
  registerVcsBackend,
  type VcsBackend,
  type VcsCommandResult,
  type VcsCommandRunner,
} from './vcs-backend.js';

export const MEMORY_VCS_BACKEND_ID = 'memory';

export interface MemoryVcsInvocation {
  command: string;
  args: string[];
  options?: SafeExecOptions;
}

export interface MemoryVcsBackend extends VcsBackend {
  /** Every invocation this backend has served, in order. */
  readonly invocations: readonly MemoryVcsInvocation[];
  /**
   * Queue a result for invocations whose argv starts with `argvPrefix`
   * (`'diff'` matches `['diff','--stat',…]`). Consumed one per call.
   */
  respond(argvPrefix: string, result: VcsCommandResult): void;
  /** Result returned when no queued prefix matches (default: empty success). */
  setFallback(result: VcsCommandResult): void;
}

const EMPTY_SUCCESS: VcsCommandResult = { stdout: '', stderr: '', status: 0 };

export function createMemoryVcsBackend(
  options: { id?: string; handler?: VcsCommandRunner } = {}
): MemoryVcsBackend {
  const invocations: MemoryVcsInvocation[] = [];
  const queued = new Map<string, VcsCommandResult[]>();
  let fallback = EMPTY_SUCCESS;
  const defaultHandler: VcsCommandRunner = (command, args, opts) => {
    invocations.push({ command, args: [...args], options: opts });
    const argv = args.join(' ');
    for (const [prefix, results] of queued) {
      if ((argv === prefix || argv.startsWith(`${prefix} `)) && results.length > 0) {
        return results.shift()!;
      }
    }
    return fallback;
  };
  const handler = options.handler ?? defaultHandler;
  return {
    id: options.id ?? MEMORY_VCS_BACKEND_ID,
    invocations,
    run: handler,
    respond(argvPrefix, result) {
      const results = queued.get(argvPrefix) ?? [];
      results.push(result);
      queued.set(argvPrefix, results);
    },
    setFallback(result) {
      fallback = result;
    },
  };
}

const sharedMemoryVcsBackend = createMemoryVcsBackend();
export { sharedMemoryVcsBackend };

registerVcsBackend(sharedMemoryVcsBackend, {
  provenance: 'builtin',
  source: 'libs/core/vcs/memory-vcs-backend.ts',
});
