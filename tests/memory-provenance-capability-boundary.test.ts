import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

// G2: the memory provenance lineage read grant is module-private. Only the
// governed provenance store opens it; tier-guard and authority.ts ask its pure
// predicates while the dedicated reader role still exists.
describeStoreGrantBoundary('Memory provenance read grant trusted import boundary', {
  implementation: 'libs/core/knowledge/memory-provenance-capability.ts',
  issuers: new Map([
    ['withMemoryProvenanceReadCapability', ['libs/core/knowledge/memory-provenance.ts']],
  ]),
  consumers: new Map([
    [
      'libs/core/knowledge/memory-provenance.ts',
      [
        'memoryProvenanceStatePath',
        'MEMORY_PROVENANCE_READER_ROLE',
        'withMemoryProvenanceReadCapability',
      ],
    ],
    [
      'libs/core/tier-guard.ts',
      [
        'MEMORY_PROVENANCE_READER_ROLE',
        'memoryProvenanceReadAllowed',
        'isMemoryProvenanceStatePath',
      ],
    ],
    [
      'libs/core/authority.ts',
      ['MEMORY_PROVENANCE_READER_ROLE', 'currentMemoryProvenanceReadCapability'],
    ],
  ]),
});
