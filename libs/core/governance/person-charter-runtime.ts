/**
 * Person charter store grant (G2 of the store-catalog guard design).
 *
 * Two module-private AsyncLocalStorage scopes:
 *   - the installed owner binding (owner actor, NHI) of one run, opened by the
 *     trusted embedding seam after installed profile/NHI ownership proof; it may
 *     span awaits, ends when the run settles and confers no I/O by itself;
 *   - the store grant of one synchronous registry or reservation access inside
 *     that binding: the exact person charter files read and ledgers written, or
 *     the one canonical personal reservation. It ends when the callback returns,
 *     a thenable result is refused, and a captured continuation finds no grant.
 *
 * Both live in this module instance only: a second instance of @agent/core
 * neither sees nor honours them, and there is no registry to plant. Only the
 * charter registry and the external-operation store open a store grant (import
 * boundary test tests/person-charter-store-capability-boundary.test.ts).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { parseNhiId } from '../contracts/nhi-id.js';
import { isValidMemberId } from '../foundation/scope.js';

type Binding = Readonly<{ ownerActor: string; agentId: string }>;
type StoreGrant = Readonly<{
  binding: Binding;
  read: readonly string[];
  write: readonly string[];
  mkdir: readonly string[];
}>;
const bindings = new AsyncLocalStorage<Binding>();
const resources = new AsyncLocalStorage<StoreGrant>();
const issuedBindings = new WeakSet<Binding>();
const issuedGrants = new WeakSet<StoreGrant>();

function thenable(value: unknown): boolean {
  return (
    Boolean(value) &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in (value as object)
  );
}

function liveBinding(): Binding | undefined {
  const binding = bindings.getStore();
  return binding && issuedBindings.has(binding) ? binding : undefined;
}

/** The live store grant of this instance, inside the binding that issued it; else undefined. */
function liveGrant(): StoreGrant | undefined {
  const grant = resources.getStore();
  if (!grant || !issuedGrants.has(grant)) return undefined;
  return liveBinding() === grant.binding ? grant : undefined;
}

/** Trusted embedding seam. Call only after installed profile/NHI ownership proof.
 * This binds identity; it grants no authority to the worker callback. The binding
 * ends when the run settles, so a continuation captured inside it finds none after. */
export function withInstalledPersonCharterRuntime<T>(binding: Binding, action: () => T): T {
  if (
    typeof binding?.ownerActor !== 'string' ||
    typeof binding.agentId !== 'string' ||
    !binding.ownerActor.startsWith('user:') ||
    !isValidMemberId(binding.ownerActor.slice(5)) ||
    !parseNhiId(binding.agentId)
  )
    throw new Error('[PERSON_CHARTER_IDENTITY_REQUIRED] Verified installed owner and NHI required');
  const frozen: Binding = Object.freeze({
    ownerActor: binding.ownerActor,
    agentId: binding.agentId,
  });
  issuedBindings.add(frozen);
  let settled = false;
  const end = () => {
    if (!settled) issuedBindings.delete(frozen);
    settled = true;
  };
  try {
    const result = bindings.run(frozen, action);
    if (thenable(result))
      return Promise.resolve(result as unknown as Promise<unknown>).finally(end) as unknown as T;
    end();
    return result;
  } catch (error) {
    end();
    throw error;
  }
}
export function currentInstalledPersonCharterRuntime(): Binding | undefined {
  return liveBinding();
}

function runStoreGrant<T>(
  binding: Binding,
  read: readonly string[],
  write: readonly string[],
  mkdir: readonly string[],
  action: () => T
): T {
  const grant: StoreGrant = Object.freeze({
    binding,
    read: Object.freeze([...read]),
    write: Object.freeze([...write]),
    mkdir: Object.freeze([...mkdir]),
  });
  issuedGrants.add(grant);
  try {
    return resources.run(grant, () => {
      const result = action();
      if (thenable(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error(
          '[PERSON_CHARTER_RESOURCE_DENIED] Person charter store access is synchronous only'
        );
      }
      return result;
    });
  } finally {
    issuedGrants.delete(grant);
  }
}

/**
 * Registry-only IO ceiling, import-restricted to governance/accountability-charter-registry.ts.
 * The role is never held while a worker action runs.
 */
export function withPersonCharterStoreAccess<T>(
  read: readonly string[],
  write: readonly string[],
  action: () => T
): T {
  const binding = liveBinding();
  if (!binding)
    throw new Error('[PERSON_CHARTER_IDENTITY_REQUIRED] Installed owner binding required');
  const valid = (p: string) =>
    typeof p === 'string' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    !p.split('/').includes('..') &&
    /(?:^|\/)knowledge\/personal\/charters(?:\/|$)/.test(p);
  if (
    !Array.isArray(read) ||
    !Array.isArray(write) ||
    ![...read, ...write].every(valid) ||
    !write.every((p) => p.endsWith('.ledger.jsonl'))
  )
    throw new Error('[PERSON_CHARTER_RESOURCE_DENIED] Exact charter resources required');
  const mkdir = write.map((p) => p.slice(0, p.lastIndexOf('/')));
  return runStoreGrant(binding, read, write, mkdir, action);
}
export function personCharterResourceAccessAllowed(
  target: string,
  operation: 'read' | 'write' | 'append' | 'mkdir' | 'metadata'
): boolean {
  const scope = liveGrant();
  if (!scope) return false;
  return operation === 'write' || operation === 'append'
    ? scope.write.includes(target)
    : operation === 'mkdir'
      ? scope.mkdir.includes(target)
      : scope.read.includes(target) || scope.write.includes(target);
}

/**
 * Canonical reservation writer only; no caller-supplied destinations. Import-restricted to
 * governance/external-operation-store.ts.
 */
export function withPersonExternalReservationAccess<T>(file: string, action: () => T): T {
  const binding = liveBinding();
  if (
    !binding ||
    typeof file !== 'string' ||
    !/^active\/shared\/(?:runtime\/external-operations\/personal\/shared|tmp\/personal\/shared\/vitest-external-operations\/[^/]+\/[^/]+)\/[a-f0-9]{64}\.json$/.test(
      file
    )
  )
    throw new Error('[PERSON_CHARTER_RESOURCE_DENIED] Canonical personal reservation required');
  return runStoreGrant(binding, [file], [file], [file.slice(0, file.lastIndexOf('/'))], action);
}
