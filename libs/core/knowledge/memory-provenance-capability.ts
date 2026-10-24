import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { runtimeStatePath, type RuntimeStateScope } from '../foundation/runtime-state-roots.js';
import { isVitestProcess } from '../foundation/env.js';
import { storageFloorRelativePath } from '../storage-layout.js';

export const MEMORY_PROVENANCE_READER_ROLE = 'memory_provenance_reader';
type Binding = RuntimeStateScope & { tier: 'public' | 'confidential' | 'personal'; file: string };
const reads = new AsyncLocalStorage<Readonly<Binding>>();

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
export function withMemoryProvenanceReadCapability<T>(
  scope: Omit<Binding, 'file'>,
  action: () => T
): T {
  return reads.run(Object.freeze({ ...scope, file: memoryProvenanceStatePath(scope) }), action);
}
export function currentMemoryProvenanceReadCapability(): Readonly<Binding> | undefined {
  return reads.getStore();
}
export function memoryProvenanceReadAllowed(
  target: string,
  operation: 'read' | 'metadata' | 'write' | 'mkdir'
): boolean {
  const file = reads.getStore()?.file;
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
