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
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { runtimeStatePath, type RuntimeStateScope } from '../foundation/runtime-state-roots.js';
import { isVitestProcess } from '../foundation/env.js';
import { storageFloorRelativePath } from '../storage-layout.js';

export const MEMORY_PROVENANCE_READER_ROLE = 'memory_provenance_reader';
type Binding = RuntimeStateScope & { tier: 'public' | 'confidential' | 'personal'; file: string };
const reads = new AsyncLocalStorage<Readonly<Binding>>();
const issued = new WeakSet<Readonly<Binding>>();

/** The live grant of this module instance, or undefined. */
function liveBinding(): Readonly<Binding> | undefined {
  const binding = reads.getStore();
  return binding && issued.has(binding) ? binding : undefined;
}

/** No caller-selected paths, including in hermetic tests. */
export function memoryProvenanceStatePath(
  scope: RuntimeStateScope & { tier: Binding['tier'] }
): string {
  const physical = runtimeStatePath('memory.promotionQueue', scope).physicalPath.replace(
    /promotion-queue\.jsonl$/,
    'provenance.json'
  );
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
