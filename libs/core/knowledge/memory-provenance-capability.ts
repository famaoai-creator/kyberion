/**
 * Memory provenance lineage read grant (G2 of the store-catalog guard design).
 *
 * The exact read of one provenance state file is a module-private, synchronous
 * grant: its AsyncLocalStorage and issued set live in this module instance only
 * (a second instance of @agent/core neither sees nor honours it), only
 * knowledge/memory-provenance.ts opens one (import boundary test
 * tests/memory-provenance-capability-boundary.test.ts), it ends when the
 * callback returns, a thenable result is refused and a captured continuation
 * finds no grant.
 *
 * G2: the live grant is itself the authority for the read it covers
 * (`memoryProvenanceGrantAllows`, asked by tier-guard's store-grant table), and
 * every I/O made while it is live is narrowed to it
 * (`memoryProvenanceReadDenial`); there is no reader role.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { runtimeStatePath, type RuntimeStateScope } from '../foundation/runtime-state-roots.js';
import { isVitestProcess } from '../foundation/env.js';
import { storageFloorRelativePath } from '../storage-layout.js';

/**
 * Issuance right of the lineage read grant (G2). The former shared core role of this name is
 * gone; the name stays only in role-assumption-policy `shared_core_roles`, which decides which
 * processes may issue the grant (authority.ts assertStoreGrantIssuanceAllowed). It is not an
 * assumable authority role.
 */
export const MEMORY_PROVENANCE_GRANT_ISSUANCE_RIGHT = 'memory_provenance_reader';
type Binding = RuntimeStateScope & { tier: 'public' | 'confidential' | 'personal'; file: string };
const reads = new AsyncLocalStorage<Readonly<Binding>>();
const issued = new WeakSet<Readonly<Binding>>();

/** The live grant of this module instance, or undefined. */
function liveBinding(): Readonly<Binding> | undefined {
  const binding = reads.getStore();
  return binding && issued.has(binding) ? binding : undefined;
}

/** The durable state file beside the scope's memory promotion queue. */
function physicalStatePath(scope: RuntimeStateScope): string {
  return runtimeStatePath('memory.promotionQueue', scope).physicalPath.replace(
    /promotion-queue\.jsonl$/,
    'provenance.json'
  );
}

/** No caller-selected paths, including in hermetic tests. */
export function memoryProvenanceStatePath(
  scope: RuntimeStateScope & { tier: Binding['tier'] }
): string {
  const physical = physicalStatePath(scope);
  return isVitestProcess()
    ? storageFloorRelativePath(
        'scratch',
        {
          kind: 'tier',
          tier: scope.tier,
          ...(scope.tenant_slug ? { tenant: scope.tenant_slug } : {}),
        },
        'memory-provenance',
        String(process.pid),
        createHash('sha256').update(physical).digest('hex'),
        'provenance.json'
      )
    : physical;
}
/**
 * Internal synchronous issuer, import-restricted to knowledge/memory-provenance.ts. The exact
 * state file is derived from the scope, never supplied by the caller.
 */
export function withMemoryProvenanceReadCapability<T>(
  scope: Omit<Binding, 'file'>,
  action: () => T
): T {
  const binding: Readonly<Binding> = Object.freeze({
    ...scope,
    file: memoryProvenanceStatePath(scope),
  });
  issued.add(binding);
  try {
    return reads.run(binding, () => {
      const result = action();
      if (
        result &&
        (typeof result === 'object' || typeof result === 'function') &&
        'then' in result
      ) {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error('[MEMORY_PROVENANCE_READ_SCOPE] Lineage read grant is synchronous only');
      }
      return result;
    });
  } finally {
    issued.delete(binding);
  }
}
/** Snapshot of the live grant's binding; mutating it changes nothing. */
export function currentMemoryProvenanceReadCapability(): Readonly<Binding> | undefined {
  const binding = liveBinding();
  return binding ? Object.freeze({ ...binding }) : undefined;
}
export function memoryProvenanceReadAllowed(
  target: string,
  operation: 'read' | 'metadata' | 'write' | 'append' | 'mkdir'
): boolean {
  const file = liveBinding()?.file;
  return (
    !!file &&
    (operation === 'read'
      ? target === file
      : operation === 'metadata' &&
        (target === file || target === '' || file.startsWith(target + '/')))
  );
}
export function isMemoryProvenanceStatePath(target: string): boolean {
  return (
    /^(?:active\/shared\/runtime\/(?:memory|tenants\/[^/]+\/memory)|active\/personal\/owners\/[a-f0-9]{64}\/memory)\/provenance\.json$/.test(
      target
    ) ||
    (isVitestProcess() &&
      /^active\/shared\/tmp\/(?:public|confidential|personal)\/[^/]+\/memory-provenance\/\d+\/[a-f0-9]{64}\/provenance\.json$/.test(
        target
      ))
  );
}

/** Deny-only narrowing of every I/O made while a lineage read grant is live; null otherwise. */
export function memoryProvenanceReadDenial(
  target: string,
  operation: 'read' | 'metadata' | 'write' | 'append' | 'mkdir'
): string | null {
  if (!liveBinding() || memoryProvenanceReadAllowed(target, operation)) return null;
  return '[MEMORY_PROVENANCE_READ_SCOPE] Read-only exact lineage capability required';
}

/**
 * Does the live grant authorize this I/O? Only its exact read (and the metadata of the file and its
 * ancestors), and only under the roots the former `memory_provenance_reader` policy grant covered
 * for the grant's tenant (the shared and tenant state files, owner state, the per-tier scratch
 * floors). Ancestors above those roots stay with the caller's own policy.
 */
export function memoryProvenanceGrantAllows(
  target: string,
  operation: 'read' | 'metadata' | 'write' | 'append' | 'mkdir'
): boolean {
  const binding = liveBinding();
  if (!binding || !memoryProvenanceReadAllowed(target, operation)) return false;
  const tenant = binding.tenant_slug;
  const roots = [
    physicalStatePath({ tier: 'public' }),
    ...(tenant ? [physicalStatePath({ tier: 'confidential', tenant_slug: tenant })] : []),
    'active/personal/owners',
    'active/shared/tmp/public',
    ...(tenant ? [`active/shared/tmp/confidential/${tenant}`] : []),
    'active/shared/tmp/personal',
  ];
  return roots.some((root) => target === root || target.startsWith(root + '/'));
}
