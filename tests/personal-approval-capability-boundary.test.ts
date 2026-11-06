import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

// G2: the personal approval owner IO window is module-private and is itself the
// authority (no store role). Only the governed personal approval runtime opens it,
// and only the approval store location calls the runtime; the narrow store denial
// and the store-grant table ask the pure predicates.
describeStoreGrantBoundary(
  'Personal approval window trusted import boundary',
  {
    implementation: 'libs/core/foundation/personal-approval-io-capability.ts',
    issuers: new Map([
      ['withPersonalApprovalCapability', ['libs/core/governance/personal-approval-runtime.ts']],
    ]),
    consumers: new Map([
      [
        'libs/core/governance/personal-approval-runtime.ts',
        ['withPersonalApprovalCapability', 'PERSONAL_APPROVAL_GRANT_ISSUANCE_RIGHT'],
      ],
    ]),
  },
  {
    formerConsumers: [
      'libs/core/tier-guard-store-grants.ts',
      'libs/core/foundation/narrow-store-role-denial.ts',
    ],
  }
);

describeStoreGrantBoundary('Personal approval runtime trusted import boundary', {
  implementation: 'libs/core/governance/personal-approval-runtime.ts',
  issuers: new Map([
    ['withPersonalApprovalIo', ['libs/core/governance/approval-store-location.ts']],
  ]),
  consumers: new Map([
    [
      'libs/core/governance/approval-store-location.ts',
      ['currentPersonalApprovalOwnerHash', 'personalApprovalOwnerHash', 'withPersonalApprovalIo'],
    ],
    [
      'libs/core/governance/approval-store.ts',
      ['currentPersonalApprovalOwnerHash', 'personalApprovalOwnerHash'],
    ],
  ]),
});
