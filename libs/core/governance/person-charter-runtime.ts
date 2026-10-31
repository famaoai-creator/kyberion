import { AsyncLocalStorage } from 'node:async_hooks';
import { parseNhiId } from '../nhi-id.js';
import { isValidMemberId } from '../organization/member-id-grammar.js';

type Binding = Readonly<{ ownerActor: string; agentId: string }>;
const bindings = new AsyncLocalStorage<Binding>();
const resources = new AsyncLocalStorage<
  Readonly<{ read: readonly string[]; write: readonly string[]; mkdir: readonly string[] }>
>();

/** Trusted embedding seam. Call only after installed profile/NHI ownership proof.
 * This binds identity; it grants no authority to the worker callback. */
export function withInstalledPersonCharterRuntime<T>(binding: Binding, action: () => T): T {
  if (
    !binding.ownerActor.startsWith('user:') ||
    !isValidMemberId(binding.ownerActor.slice(5)) ||
    !parseNhiId(binding.agentId)
  )
    throw new Error('[PERSON_CHARTER_IDENTITY_REQUIRED] Verified installed owner and NHI required');
  return bindings.run(Object.freeze({ ...binding }), action);
}
export function currentInstalledPersonCharterRuntime(): Binding | undefined {
  return bindings.getStore();
}

/** Registry-only IO ceiling. The role is never held while a worker action runs. */
export function withPersonCharterStoreAccess<T>(
  read: readonly string[],
  write: readonly string[],
  action: () => T
): T {
  if (!bindings.getStore())
    throw new Error('[PERSON_CHARTER_IDENTITY_REQUIRED] Installed owner binding required');
  const valid = (p: string) =>
    !p.startsWith('/') &&
    !p.includes('\\') &&
    !p.split('/').includes('..') &&
    /(?:^|\/)knowledge\/personal\/charters(?:\/|$)/.test(p);
  if (![...read, ...write].every(valid) || !write.every((p) => p.endsWith('.ledger.jsonl')))
    throw new Error('[PERSON_CHARTER_RESOURCE_DENIED] Exact charter resources required');
  const mkdir = write.map((p) => p.slice(0, p.lastIndexOf('/')));
  return resources.run(
    Object.freeze({
      read: Object.freeze([...read]),
      write: Object.freeze([...write]),
      mkdir: Object.freeze(mkdir),
    }),
    action
  );
}
export function personCharterResourceAccessAllowed(
  target: string,
  operation: 'read' | 'write' | 'append' | 'mkdir' | 'metadata'
): boolean {
  const scope = resources.getStore();
  if (!bindings.getStore() || !scope) return false;
  return operation === 'write' || operation === 'append'
    ? scope.write.includes(target)
    : operation === 'mkdir'
      ? scope.mkdir.includes(target)
      : scope.read.includes(target) || scope.write.includes(target);
}

/** Canonical reservation writer only; no caller-supplied destinations. */
export function withPersonExternalReservationAccess<T>(file: string, action: () => T): T {
  if (
    !bindings.getStore() ||
    !/^active\/shared\/(?:runtime\/external-operations\/personal\/shared|tmp\/personal\/shared\/vitest-external-operations\/[^/]+\/[^/]+)\/[a-f0-9]{64}\.json$/.test(
      file
    )
  )
    throw new Error('[PERSON_CHARTER_RESOURCE_DENIED] Canonical personal reservation required');
  return resources.run(
    Object.freeze({
      read: Object.freeze([file]),
      write: Object.freeze([file]),
      mkdir: Object.freeze([file.slice(0, file.lastIndexOf('/'))]),
    }),
    action
  );
}
