import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

// G2: the tenant pipeline run journal grant is module-private. Only the governed
// run journal issues it; tier-guard and authority.ts ask the pure predicate
// while the dedicated role still exists.
describeStoreGrantBoundary('Pipeline journal grant trusted import boundary', {
  implementation: 'libs/core/foundation/pipeline-journal-capability.ts',
  issuers: new Map([
    ['withPipelineJournalCapability', ['libs/core/pipeline/pipeline-run-journal.ts']],
  ]),
  consumers: new Map([
    [
      'libs/core/pipeline/pipeline-run-journal.ts',
      ['pipelineJournalCapability', 'PIPELINE_JOURNAL_STORE_ROLE', 'withPipelineJournalCapability'],
    ],
    ['libs/core/tier-guard.ts', ['isPipelineJournalCapability', 'PIPELINE_JOURNAL_STORE_ROLE']],
    ['libs/core/authority.ts', ['isPipelineJournalCapability', 'PIPELINE_JOURNAL_STORE_ROLE']],
  ]),
});
