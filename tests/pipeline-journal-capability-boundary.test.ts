import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

// G2: the tenant pipeline run journal grant is module-private and is itself the
// authority. Only the governed run journal issues it; the tier-guard
// store-grant table asks the authority predicate. authority.ts and tier-guard.ts
// no longer import it (the role is gone).
describeStoreGrantBoundary(
  'Pipeline journal grant trusted import boundary',
  {
    implementation: 'libs/core/foundation/pipeline-journal-capability.ts',
    issuers: new Map([
      ['withPipelineJournalCapability', ['libs/core/pipeline/pipeline-run-journal.ts']],
    ]),
    consumers: new Map([
      [
        'libs/core/pipeline/pipeline-run-journal.ts',
        [
          'pipelineJournalCapability',
          'PIPELINE_JOURNAL_GRANT_ISSUANCE_RIGHT',
          'withPipelineJournalCapability',
        ],
      ],
      ['libs/core/tier-guard-store-grants.ts', ['pipelineJournalGrantAllows']],
    ]),
  },
  { formerConsumers: ['libs/core/tier-guard.ts', 'libs/core/authority.ts'] }
);
