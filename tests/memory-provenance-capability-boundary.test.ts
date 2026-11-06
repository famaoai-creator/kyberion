import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

// G2: the memory provenance lineage read grant is module-private and is itself
// the authority. Only the governed provenance store opens it; tier-guard narrows
// every I/O inside it and the store-grant table asks the authority predicate.
// authority.ts no longer imports it (the reader role is gone).
describeStoreGrantBoundary(
  'Memory provenance read grant trusted import boundary',
  {
    implementation: 'libs/core/knowledge/memory-provenance-capability.ts',
    issuers: new Map([
      ['withMemoryProvenanceReadCapability', ['libs/core/knowledge/memory-provenance.ts']],
    ]),
    consumers: new Map([
      [
        'libs/core/knowledge/memory-provenance.ts',
        [
          'memoryProvenanceStatePath',
          'MEMORY_PROVENANCE_GRANT_ISSUANCE_RIGHT',
          'withMemoryProvenanceReadCapability',
        ],
      ],
      ['libs/core/tier-guard.ts', ['memoryProvenanceReadDenial', 'isMemoryProvenanceStatePath']],
      ['libs/core/tier-guard-store-grants.ts', ['memoryProvenanceGrantAllows']],
    ]),
  },
  { formerConsumers: ['libs/core/authority.ts'] }
);
