/**
 * Exact IO window of one live, same-tier private task workspace (G2: the window
 * is the authority; there is no store role).
 *
 * The window is module-private: its AsyncLocalStorage and issued set live in
 * this module instance only, so a second instance of @agent/core neither sees
 * nor honours it (fail closed; scripts/check_core_single_instance.ts keeps a
 * production process on one instance). Only the governed facade
 * (workforce/task-source-workspace-io.ts, import boundary test) opens one.
 *
 * While a window is current:
 *   - every I/O is narrowed to it (`taskSourceWorkspaceIoDenial`): the target
 *     file, its ancestors' metadata/reads, mkdir of its ancestors when writing,
 *     and product knowledge reads (the policy engine's own catalog reads);
 *   - the window authorizes the target inside its physical partition
 *     (`taskSourceWorkspaceGrantAllows`);
 *   - liveness (`assertCurrent`) runs with the window suspended, as the caller:
 *     its own reads (work-coordination and workspace ledgers) are neither
 *     narrowed nor authorized by the window, exactly as when they ran outside
 *     the former role.
 * The window is synchronous: it ends when the callback returns, a thenable
 * result is refused, and a captured continuation finds no window.
 */
import type { KnowledgeTier } from './knowledge-tier.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { runtimeStatePath } from './runtime-state-roots.js';
import { isValidTenantSlug } from './scope.js';
import { registerStoreGrant } from './store-grant-registry.js';

export type TaskSourceWorkspaceOperation = 'read' | 'write' | 'append' | 'mkdir' | 'metadata';

export interface TaskSourceWorkspaceWindow {
  /** Repository-relative target file. */
  readonly target: string;
  readonly writing: boolean;
  readonly tier: Exclude<KnowledgeTier, 'public'>;
  /** Tenant slug, or `shared` for the untenanted partition. */
  readonly tenant: string;
}

type IoWindow = TaskSourceWorkspaceWindow &
  Readonly<{ partition: string; assertCurrent: () => void }>;

const access = new AsyncLocalStorage<IoWindow>();
const issued = new WeakSet<IoWindow>();

/** `<workspaces root>/<personal|confidential>/<tenant|shared>/`, or null. */
function partitionOf(window: TaskSourceWorkspaceWindow): string | null {
  if (window.tier !== 'personal' && window.tier !== 'confidential') return null;
  if (window.tenant !== 'shared' && !isValidTenantSlug(window.tenant)) return null;
  return `${runtimeStatePath('task.workspacesRoot').physicalPath}/${window.tier}/${window.tenant}/`;
}

function insidePartition(partition: string, target: string): boolean {
  return (
    target.startsWith(partition) &&
    target.length > partition.length &&
    !target.includes('\\') &&
    !target.includes('\0') &&
    !target.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}

function currentWindow(): IoWindow | undefined {
  const window = access.getStore();
  return window && issued.has(window) ? window : undefined;
}

/** Liveness runs as the caller with the window suspended (never narrowed by it). */
function assertLive(window: IoWindow): void {
  access.exit(window.assertCurrent);
}

/**
 * Internal synchronous issuer, import-restricted to workforce/task-source-workspace-io.ts,
 * which validates the task scope and the live claim first.
 */
export function withTaskSourceWorkspaceCapability<T>(
  input: TaskSourceWorkspaceWindow,
  assertCurrent: () => void,
  run: () => T
): T {
  const binding = {
    target: input?.target,
    writing: input?.writing,
    tier: input?.tier,
    tenant: input?.tenant,
  } as TaskSourceWorkspaceWindow;
  const partition = partitionOf(binding);
  if (
    !partition ||
    typeof binding.writing !== 'boolean' ||
    typeof binding.target !== 'string' ||
    !insidePartition(partition, binding.target) ||
    typeof assertCurrent !== 'function'
  )
    throw new Error(
      '[TASK_SOURCE_SCOPE_DENIED] Private workspace IO needs its exact physical tier'
    );
  assertCurrent();
  const window: IoWindow = Object.freeze({ ...binding, partition, assertCurrent });
  issued.add(window);
  try {
    return access.run(window, () => {
      const result = run();
      if (
        result &&
        (typeof result === 'object' || typeof result === 'function') &&
        'then' in result
      ) {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error('[TASK_SOURCE_SCOPE_DENIED] Workspace IO window is synchronous only');
      }
      return result;
    });
  } finally {
    issued.delete(window);
  }
}

/** Is a live window of this module instance current? Re-checks liveness. */
export function taskSourceWorkspaceIoActive(): boolean {
  const current = currentWindow();
  if (!current) return false;
  assertLive(current);
  return true;
}

function windowAllows(
  current: IoWindow,
  target: string,
  operation: TaskSourceWorkspaceOperation
): boolean {
  if ((operation === 'read' || operation === 'metadata') && target.startsWith('knowledge/product/'))
    return true;
  if (operation === 'write') return current.writing && target === current.target;
  if (operation === 'append') return false;
  if (operation === 'mkdir') return current.writing && current.target.startsWith(target + '/');
  return target === current.target || current.target.startsWith(target + '/');
}

/** Deny-only narrowing of every I/O made while a window is current; null outside one. */
export function taskSourceWorkspaceIoDenial(
  target: string,
  operation: TaskSourceWorkspaceOperation
): string | null {
  const current = currentWindow();
  if (!current) return null;
  assertLive(current);
  return windowAllows(current, target, operation)
    ? null
    : '[TASK_SOURCE_SCOPE_DENIED] Exact live workspace IO capability required';
}

/** Does the current live window authorize this I/O inside its own physical partition? */
export function taskSourceWorkspaceGrantAllows(
  target: string,
  operation: TaskSourceWorkspaceOperation
): boolean {
  const current = currentWindow();
  if (!current || !insidePartition(current.partition, target)) return false;
  if (!windowAllows(current, target, operation)) return false;
  assertLive(current);
  return true;
}

// G3: tier-guard asks these rules through the store grant registry, not by importing this module.
registerStoreGrant({
  id: 'task-source-workspace',
  active: () => currentWindow() !== undefined,
  authorizes: (target, operation) => taskSourceWorkspaceGrantAllows(target, operation),
  narrowing: ({ relativePath, operation }) => taskSourceWorkspaceIoDenial(relativePath, operation),
});
